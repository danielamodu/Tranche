import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Loader2,
  X,
} from "lucide-react";
import { erc20Abi, parseUnits } from "viem";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { AppShell } from "@/components/AppShell";
import { ACTIVE_NETWORK, explorerTxUrl } from "@/config/networks";
import {
  formatDuration,
  formatPriceX36,
  formatTokenAmount,
  getTokenMeta,
} from "@/config/tokens";
import { useWallet } from "@/context/WalletContext";
import {
  COMMITMENT_MANAGER_ABI,
  createTrancheWalletClient,
  decodeQuoteReservationResult,
  fetchAllOffers,
  fetchRecentActivity,
  tranchePublicClient,
  type OnChainOffer,
  type ProtocolActivityItem,
} from "@/lib/protocol";
import { cn } from "@/lib/utils";
import type { AppRoute } from "@/App";

interface TradePageProps {
  onNavigate: (path: AppRoute) => void;
}

const DURATION_PRESETS = [
  { label: "10m", seconds: 600 },
  { label: "30m", seconds: 1800 },
  { label: "1h", seconds: 3600 },
] as const;

export function TradePage({ onNavigate }: TradePageProps) {
  const { address, activeProvider, isConnected, isWrongNetwork } = useWallet();
  const [offers, setOffers] = useState<OnChainOffer[]>([]);
  const [activity, setActivity] = useState<ProtocolActivityItem[]>([]);
  const [totalTickets, setTotalTickets] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pairFilter, setPairFilter] = useState<string>("ALL");
  const [showOnboarding, setShowOnboarding] = useState<boolean>(
    () => localStorage.getItem("tranche-trader-tip-dismissed") !== "1",
  );

  // Selected offer & Reserve Sheet state
  const [selected, setSelected] = useState<OnChainOffer | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [durationSec, setDurationSec] = useState(600);
  const [quote, setQuote] = useState<{
    grossPremium: bigint;
    protocolFee: bigint;
    lpNetPremium: bigint;
  } | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [payBalance, setPayBalance] = useState<bigint | null>(null);
  const [txStep, setTxStep] = useState<"idle" | "approving" | "reserving" | "done">("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  const loadOffers = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const [list, act] = await Promise.all([fetchAllOffers(), fetchRecentActivity()]);
      setOffers(list);
      setActivity(act.items);
      setTotalTickets(act.totalTickets);
    } catch {
      // keep previous list on transient RPC hiccup
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadOffers();
  }, [loadOffers]);

  // Filter strictly ACTIVE & non-expired offers with remaining inventory > 0
  const nowSec = Math.floor(Date.now() / 1000);
  const activeOffers = useMemo(
    () =>
      offers.filter(
        (o) => o.status === 0 && o.availableBalance > 0n && o.expiry > nowSec,
      ),
    [offers, nowSec],
  );

  const pairOptions = useMemo(() => {
    const pairs = new Set<string>();
    for (const o of activeOffers) {
      const inv = getTokenMeta(o.inventoryToken).symbol;
      const pay = getTokenMeta(o.paymentToken).symbol;
      pairs.add(`${inv} / ${pay}`);
    }
    return ["ALL", ...Array.from(pairs)];
  }, [activeOffers]);

  const filteredOffers = useMemo(() => {
    if (pairFilter === "ALL") return activeOffers;
    return activeOffers.filter((o) => {
      const label = `${getTokenMeta(o.inventoryToken).symbol} / ${getTokenMeta(o.paymentToken).symbol}`;
      return label === pairFilter;
    });
  }, [activeOffers, pairFilter]);

  const totalNotionalUsd = useMemo(() => {
    let total = 0;
    for (const o of activeOffers) {
      const inv = getTokenMeta(o.inventoryToken);
      const pay = getTokenMeta(o.paymentToken);
      if (o.priceMode === 0 && o.fixedPriceX36 > 0n) {
        const units = Number(o.availableBalance) / 10 ** inv.decimals;
        const px = (Number(o.fixedPriceX36) / 1e36) * 10 ** (inv.decimals - pay.decimals);
        if (Number.isFinite(units * px)) total += units * px;
      }
    }
    return total;
  }, [activeOffers]);

  // Open Reserve Sheet with clean defaults
  function openReserveSheet(offer: OnChainOffer) {
    const inv = getTokenMeta(offer.inventoryToken);
    setSelected(offer);
    const defaultAmt =
      offer.minFillAmount > 0n && offer.minFillAmount <= offer.availableBalance
        ? formatTokenAmount(offer.minFillAmount, inv.decimals, 6).replace(/,/g, "")
        : formatTokenAmount(offer.availableBalance, inv.decimals, 6).replace(/,/g, "");
    setAmountInput(defaultAmt);
    setDurationSec(Math.min(Math.max(600, offer.minDuration), offer.maxDuration));
    setQuote(null);
    setTxStep("idle");
    setTxHash(null);
    setTxError(null);
  }

  // Live payment token balance for selected offer
  useEffect(() => {
    if (!selected || !address) {
      setPayBalance(null);
      return;
    }
    let cancelled = false;
    tranchePublicClient
      .readContract({
        address: selected.paymentToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      })
      .then((bal) => {
        if (!cancelled) setPayBalance(bal);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selected, address, txStep]);

  // Live on-chain quoteReservation whenever amount or duration changes
  useEffect(() => {
    if (!selected || !ACTIVE_NETWORK.isLive) return;
    const inv = getTokenMeta(selected.inventoryToken);
    let parsedAmt = 0n;
    try {
      parsedAmt = amountInput ? parseUnits(amountInput, inv.decimals) : 0n;
    } catch {
      setQuote(null);
      return;
    }
    if (parsedAmt <= 0n || parsedAmt > selected.availableBalance) {
      setQuote(null);
      return;
    }

    let cancelled = false;
    setQuoteLoading(true);
    tranchePublicClient
      .readContract({
        address: ACTIVE_NETWORK.contracts.commitmentManager,
        abi: COMMITMENT_MANAGER_ABI,
        functionName: "quoteReservation",
        args: [selected.offerId, parsedAmt, durationSec],
      })
      .then((res) => {
        if (!cancelled) {
          setQuote(decodeQuoteReservationResult(res));
        }
      })
      .catch(() => {
        if (!cancelled) setQuote(null);
      })
      .finally(() => {
        if (!cancelled) setQuoteLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selected, amountInput, durationSec]);

  async function handleReserve() {
    if (!selected || !address || !activeProvider || !quote) return;
    const inv = getTokenMeta(selected.inventoryToken);
    let parsedAmt = 0n;
    try {
      parsedAmt = parseUnits(amountInput, inv.decimals);
    } catch {
      setTxError("Enter a valid token amount.");
      return;
    }

    setTxError(null);
    const walletClient = createTrancheWalletClient(activeProvider, address);
    const { liquidityVault, commitmentManager } = ACTIVE_NETWORK.contracts;

    try {
      // 1. Check & approve payment token allowance to LiquidityVault
      const allowance = await tranchePublicClient.readContract({
        address: selected.paymentToken,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, liquidityVault],
      });

      if (allowance < quote.grossPremium) {
        setTxStep("approving");
        const approveHash = await walletClient.writeContract({
          address: selected.paymentToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [liquidityVault, quote.grossPremium],
        });
        await tranchePublicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      // 2. Reserve inventory & mint ERC-721 ExecutionTicket
      setTxStep("reserving");
      const maxPremium = quote.grossPremium + (quote.grossPremium / 100n) + 1n; // 1% slippage buffer
      const hash = await walletClient.writeContract({
        address: commitmentManager,
        abi: COMMITMENT_MANAGER_ABI,
        functionName: "reserve",
        args: [selected.offerId, parsedAmt, durationSec, maxPremium, address],
      });
      await tranchePublicClient.waitForTransactionReceipt({ hash });

      setTxHash(hash);
      setTxStep("done");
      loadOffers(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Transaction failed or rejected.";
      setTxError(msg.length > 140 ? `${msg.slice(0, 140)}…` : msg);
      setTxStep("idle");
    }
  }

  const selectedInv = selected ? getTokenMeta(selected.inventoryToken) : null;
  const selectedPay = selected ? getTokenMeta(selected.paymentToken) : null;

  return (
    <AppShell
      activeRoute="/trade"
      title="Trade Desk"
      subtitle={`Live on-chain offers · ${ACTIVE_NETWORK.shortName}`}
      onNavigate={onNavigate}
      onRefresh={() => loadOffers(true)}
      refreshing={refreshing}
    >
      <div className="flex flex-col gap-8">
        {/* Contextual 3-step Trader Onboarding Strip (dismissible, first-time only) */}
        {showOnboarding && (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-full border border-border/80 bg-card/60 px-5 py-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-muted-foreground">
              <span className="font-medium text-foreground">Quick start:</span>
              <span>
                <strong className="tabular-nums-mono text-foreground">01</strong> Pick an offer strip
              </span>
              <span>
                <strong className="tabular-nums-mono text-foreground">02</strong> Reserve &amp; mint
                ERC-721 ticket
              </span>
              <span>
                <strong className="tabular-nums-mono text-foreground">03</strong> Exercise in Tickets
                before expiry
              </span>
            </div>
            <button
              type="button"
              aria-label="Dismiss quick start"
              onClick={() => {
                localStorage.setItem("tranche-trader-tip-dismissed", "1");
                setShowOnboarding(false);
              }}
              className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {/* Borderless Editorial Hairline Depth Strip */}
        <section className="grid grid-cols-1 gap-y-5 border-b border-border/80 pb-7 sm:grid-cols-3 sm:divide-x sm:divide-border/80">
          <div className="flex flex-col gap-1 sm:pr-6">
            <span className="tabular-nums-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              01 · Fixed Offer Notional
            </span>
            <span className="tabular-nums-mono font-display text-3xl font-bold tracking-[-0.04em] text-foreground">
              {loading
                ? "—"
                : `$${totalNotionalUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
            </span>
            {!loading && activeOffers.some((o) => o.priceMode === 1) && (
              <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                + {activeOffers.filter((o) => o.priceMode === 1).length} floating oracle offer(s)
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1 sm:px-6">
            <span className="tabular-nums-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              02 · Open Offers
            </span>
            <span className="tabular-nums-mono font-display text-3xl font-bold tracking-[-0.04em] text-foreground">
              {loading ? "—" : activeOffers.length}
            </span>
            <span className="text-[11px] text-muted-foreground">Live segregated vault capacity</span>
          </div>
          <div className="flex flex-col gap-1 sm:pl-6">
            <span className="tabular-nums-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              03 · Tickets Minted
            </span>
            <span className="tabular-nums-mono font-display text-3xl font-bold tracking-[-0.04em] text-foreground">
              {loading ? "—" : totalTickets}
            </span>
            <span className="tabular-nums-mono text-[11px] text-muted-foreground">
              Chain {ACTIVE_NETWORK.chainId} on-chain total
            </span>
          </div>
        </section>

        {/* Asymmetric 8/4 Split: Perforated Offer Strips (Left) + Live Activity Tape (Right) */}
        <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-12">
          <div className="flex flex-col gap-4 lg:col-span-8">
            {/* Pair Filter Pills + Live Count */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {pairOptions.map((pair) => {
                  const active = pairFilter === pair;
                  return (
                    <button
                      key={pair}
                      type="button"
                      onClick={() => setPairFilter(pair)}
                      className={cn(
                        "h-8 rounded-full px-3.5 text-xs font-medium transition-colors duration-150 cursor-pointer",
                        active
                          ? "bg-primary text-primary-foreground"
                          : "border border-border bg-card/60 text-muted-foreground hover:border-foreground/25 hover:text-foreground",
                      )}
                    >
                      {pair === "ALL" ? "All Pairs" : pair}
                    </button>
                  );
                })}
              </div>

              <span className="tabular-nums-mono text-xs text-muted-foreground">
                {loading
                  ? "Syncing…"
                  : `${filteredOffers.length} active offer${filteredOffers.length === 1 ? "" : "s"}`}
              </span>
            </div>

            {/* Perforated Horizontal Offer Ticket Strips */}
            {loading ? (
              <div className="flex flex-col gap-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-[88px] w-full rounded-[18px]" />
                ))}
              </div>
            ) : filteredOffers.length === 0 ? (
              <div className="flex flex-col items-center gap-4 rounded-[22px] border border-dashed border-border px-6 py-20 text-center">
                <div className="flex flex-col gap-1.5">
                  <h2 className="font-display text-xl font-semibold text-foreground">
                    {ACTIVE_NETWORK.isLive ? "No open offers right now" : "Mainnet deployment pending"}
                  </h2>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {ACTIVE_NETWORK.isLive
                      ? `All previous offers on ${ACTIVE_NETWORK.shortName} (Chain ${ACTIVE_NETWORK.chainId}) have been filled or cancelled. Create a fresh LP offer in Vault to test the full reservation flow.`
                      : `Protocol contracts are not yet deployed on ${ACTIVE_NETWORK.name} (Chain ${ACTIVE_NETWORK.chainId}).`}
                  </p>
                </div>
                {ACTIVE_NETWORK.isLive && (
                  <Button
                    type="button"
                    onClick={() => onNavigate("/vault")}
                    className="h-10 rounded-full px-6 text-xs font-medium cursor-pointer"
                  >
                    Open Vault to Create Offer
                    <ArrowUpRight data-icon="inline-end" />
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {filteredOffers.map((offer) => {
                  const inv = getTokenMeta(offer.inventoryToken);
                  const pay = getTokenMeta(offer.paymentToken);
                  const isFixed = offer.priceMode === 0;
                  const priceLabel = isFixed
                    ? `${formatPriceX36(offer.fixedPriceX36, inv.decimals, pay.decimals)} ${pay.symbol}`
                    : `Oracle ${offer.spreadBps >= 0 ? "+" : ""}${offer.spreadBps} bps`;

                  return (
                    <div
                      key={offer.offerId.toString()}
                      onClick={() => openReserveSheet(offer)}
                      className={cn(
                        "group relative flex flex-col justify-between gap-4 overflow-hidden rounded-[18px] border transition-all duration-200 hover:-translate-y-0.5 sm:flex-row sm:items-center cursor-pointer",
                        isFixed
                          ? "border-[#f8f7ee]/20 bg-[#11110f] hover:border-[#f8f7ee]/40"
                          : "border-border bg-card/80 hover:border-foreground/30",
                      )}
                    >
                      {/* Tactile Left Stock Accent Bar (Cream for FIXED, Carbon Slate for FLOATING) */}
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-0 left-0 w-1"
                        style={{ backgroundColor: isFixed ? "#f8f7ee" : "rgba(248,247,238,0.22)" }}
                      />

                      <div className="grid flex-1 grid-cols-2 items-center gap-4 py-4 pl-6 pr-4 sm:grid-cols-12">
                        <div className="col-span-2 flex flex-col sm:col-span-4">
                          <span className="font-display text-base font-semibold tracking-[-0.02em] text-foreground">
                            {inv.symbol} / {pay.symbol}
                          </span>
                          <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                            #{offer.offerId.toString()} · {isFixed ? "FIXED" : "FLOATING"} · max{" "}
                            {formatDuration(offer.maxDuration)}
                          </span>
                        </div>

                        <div className="flex flex-col sm:col-span-3 sm:items-end">
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Available
                          </span>
                          <span className="tabular-nums-mono text-sm font-semibold text-foreground">
                            {formatTokenAmount(offer.availableBalance, inv.decimals)} {inv.symbol}
                          </span>
                        </div>

                        <div className="flex flex-col sm:col-span-3 sm:items-end">
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            {isFixed ? "Locked Strike" : "Spread"}
                          </span>
                          <span className="tabular-nums-mono text-sm font-medium text-foreground">
                            {priceLabel}
                          </span>
                        </div>

                        <div className="flex flex-col sm:col-span-2 sm:items-end">
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Hold Fee
                          </span>
                          <span className="tabular-nums-mono text-sm text-muted-foreground">
                            {(offer.basePremiumBps / 100).toFixed(2)}%
                          </span>
                        </div>
                      </div>

                      {/* Perforated Vertical Tear-Line + Reserve Stub */}
                      <div className="flex items-center justify-end border-t border-dashed border-border/80 px-5 py-3 sm:border-t-0 sm:border-l sm:py-5">
                        <Button
                          type="button"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            openReserveSheet(offer);
                          }}
                          className="h-9 rounded-full px-4 text-xs font-medium cursor-pointer"
                        >
                          Reserve
                          <ArrowRight data-icon="inline-end" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* RIGHT 4 COLS (STICKY): Live On-Chain Activity Tape */}
          <aside className="flex flex-col gap-4 lg:sticky lg:top-24 lg:col-span-4">
            <div className="flex items-baseline justify-between border-b border-border pb-3">
              <h2 className="font-display text-base font-semibold text-foreground">
                On-Chain Activity Tape
              </h2>
              <span className="tabular-nums-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                Chain {ACTIVE_NETWORK.chainId}
              </span>
            </div>

            {activity.length > 0 ? (
              <div className="divide-y divide-border/70">
                {activity.map((item) => (
                  <a
                    key={item.id}
                    href={explorerTxUrl(item.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex flex-col gap-1 py-3.5 text-xs transition-colors hover:bg-card/40"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-2 font-medium text-foreground">
                        <span className="size-1.5 rounded-full bg-status-live" />
                        {item.label}
                      </span>
                      <span className="tabular-nums-mono inline-flex items-center gap-1 text-[10px] text-muted-foreground group-hover:text-foreground">
                        #{item.blockNumber.toLocaleString()}
                        <ArrowUpRight className="size-3" />
                      </span>
                    </div>
                    <span className="tabular-nums-mono pl-3.5 text-[11px] text-muted-foreground">
                      {item.detail}
                    </span>
                  </a>
                ))}
              </div>
            ) : (
              <p className="rounded-[16px] border border-dashed border-border p-5 text-center text-xs text-muted-foreground">
                No recent events in the last 5,000 blocks.
              </p>
            )}
          </aside>
        </div>
      </div>

      {/* Apple Slide-Over Reserve Sheet (parent ledger remains visible behind scrim) */}
      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="flex w-full flex-col justify-between border-l border-border bg-card px-6 py-6 sm:max-w-[440px]">
          {selected && selectedInv && selectedPay && (
            <>
              <div className="flex flex-col gap-6">
                <SheetHeader className="p-0 text-left">
                  <span className="tabular-nums-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    Offer #{selected.offerId.toString()} ·{" "}
                    {selected.priceMode === 0 ? "FIXED STRIKE" : "FLOATING ORACLE"}
                  </span>
                  <SheetTitle className="font-display text-2xl font-semibold">
                    Reserve {selectedInv.symbol}
                  </SheetTitle>
                  <SheetDescription className="text-xs text-muted-foreground">
                    Available: {formatTokenAmount(selected.availableBalance, selectedInv.decimals)}{" "}
                    {selectedInv.symbol} · Min fill:{" "}
                    {formatTokenAmount(selected.minFillAmount, selectedInv.decimals)}{" "}
                    {selectedInv.symbol}
                  </SheetDescription>
                </SheetHeader>

                {txStep === "done" && txHash ? (
                  <div className="animate-rise flex flex-col items-center gap-4 rounded-[20px] border border-border bg-background p-7 text-center">
                    <span className="flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="size-5" />
                    </span>
                    <div className="flex flex-col gap-1">
                      <h3 className="font-display text-xl font-semibold">Execution Ticket Minted</h3>
                      <p className="text-xs text-muted-foreground">
                        Your {selectedInv.symbol} inventory is segregated and locked to your wallet.
                      </p>
                    </div>
                    <a
                      href={explorerTxUrl(txHash)}
                      target="_blank"
                      rel="noreferrer"
                      className="tabular-nums-mono inline-flex items-center gap-1 text-xs text-foreground underline underline-offset-4"
                    >
                      View on Blockscout
                      <ArrowUpRight className="size-3.5" />
                    </a>
                    <Button
                      type="button"
                      onClick={() => {
                        setSelected(null);
                        onNavigate("/tickets");
                      }}
                      className="mt-2 h-11 w-full rounded-full text-xs font-medium cursor-pointer"
                    >
                      Go to My Tickets
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-5">
                    {/* Giant Terminal-Style Amount Entry */}
                    <div className="flex flex-col gap-2.5">
                      <div className="flex items-center justify-between text-xs">
                        <label
                          htmlFor="reserve-amount"
                          className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
                        >
                          Reservation Size ({selectedInv.symbol})
                        </label>
                        <div className="flex items-center gap-1">
                          {[
                            {
                              label: "Min",
                              val: selected.minFillAmount,
                            },
                            {
                              label: "50%",
                              val: selected.availableBalance / 2n,
                            },
                            {
                              label: "Max",
                              val: selected.availableBalance,
                            },
                          ].map((q) => (
                            <button
                              key={q.label}
                              type="button"
                              onClick={() =>
                                setAmountInput(
                                  formatTokenAmount(q.val, selectedInv.decimals, 6).replace(
                                    /,/g,
                                    "",
                                  ),
                                )
                              }
                              className="tabular-nums-mono rounded-full border border-border px-2.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground cursor-pointer"
                            >
                              {q.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-baseline justify-between gap-2 border-b border-border/90 pb-2 transition-colors focus-within:border-foreground">
                        <input
                          id="reserve-amount"
                          type="text"
                          inputMode="decimal"
                          value={amountInput}
                          onChange={(e) => setAmountInput(e.target.value)}
                          placeholder="0.01"
                          className="tabular-nums-mono w-full bg-transparent font-display text-3xl font-bold tracking-[-0.04em] text-foreground placeholder:text-muted-foreground/35 focus:outline-none"
                        />
                        <span className="tabular-nums-mono shrink-0 text-sm font-medium text-muted-foreground">
                          {selectedInv.symbol}
                        </span>
                      </div>
                    </div>

                    {/* Lock Duration Pills */}
                    <div className="flex flex-col gap-2">
                      <span className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        Lock Window ({formatDuration(selected.minDuration)} –{" "}
                        {formatDuration(selected.maxDuration)})
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {DURATION_PRESETS.filter(
                          (d) =>
                            d.seconds >= selected.minDuration && d.seconds <= selected.maxDuration,
                        ).map((preset) => {
                          const active = durationSec === preset.seconds;
                          return (
                            <button
                              key={preset.label}
                              type="button"
                              onClick={() => setDurationSec(preset.seconds)}
                              className={cn(
                                "tabular-nums-mono h-9 rounded-full px-4 text-xs font-medium transition-all cursor-pointer",
                                active
                                  ? "bg-primary text-primary-foreground"
                                  : "border border-border bg-background/60 text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                              )}
                            >
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Perforated Tear-Line into Live Quote Receipt */}
                    <div className="border-t border-dashed border-border/90 pt-4">
                      <div className="flex flex-col gap-2.5 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">Upfront Hold Fee</span>
                          <span className="tabular-nums-mono text-sm font-semibold text-foreground">
                            {quoteLoading
                              ? "Quoting…"
                              : quote
                                ? `${formatTokenAmount(quote.grossPremium, selectedPay.decimals, 6)} ${selectedPay.symbol}`
                                : "—"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">
                            Your {selectedPay.symbol} Balance
                          </span>
                          <span className="tabular-nums-mono text-muted-foreground">
                            {payBalance !== null
                              ? `${formatTokenAmount(payBalance, selectedPay.decimals, 4)} ${selectedPay.symbol}`
                              : "—"}
                          </span>
                        </div>
                        {quote && selected.priceMode === 0 && (
                          <div className="mt-1 flex flex-col gap-1.5 rounded-[14px] border border-border/80 bg-background/70 p-3.5 text-[11px] leading-relaxed">
                            <span className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-foreground">
                              Outcome · {formatDuration(durationSec)} window
                            </span>
                            <span className="text-muted-foreground">
                              • Price rises above{" "}
                              <strong className="tabular-nums-mono text-foreground">
                                {formatPriceX36(selected.fixedPriceX36, selectedInv.decimals, selectedPay.decimals)}{" "}
                                {selectedPay.symbol}
                              </strong>{" "}
                              → settle at locked strike, 0% slippage.
                            </span>
                            <span className="text-muted-foreground">
                              • Price drops → walk away. Max cost is{" "}
                              <strong className="tabular-nums-mono text-foreground">
                                {formatTokenAmount(quote.grossPremium, selectedPay.decimals, 4)}{" "}
                                {selectedPay.symbol}
                              </strong>
                              .
                            </span>
                          </div>
                        )}
                        <p className="text-[11px] leading-relaxed text-muted-foreground">
                          Upfront hold fee is non-refundable if the ticket expires unexercised.
                        </p>
                      </div>
                    </div>

                    {txError && (
                      <div className="relative overflow-hidden rounded-[12px] border border-destructive/35 bg-[#190a0a] py-2.5 pl-4 pr-3.5 text-xs text-destructive">
                        <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-destructive" />
                        <span>{txError}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Bottom CTA */}
              {txStep !== "done" && (
                <div className="pt-4">
                  {!isConnected ? (
                    <Button
                      type="button"
                      size="lg"
                      onClick={() => onNavigate("/connect")}
                      className="h-12 w-full rounded-full text-sm font-medium cursor-pointer"
                    >
                      Connect Wallet to Reserve
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="lg"
                      disabled={
                        isWrongNetwork ||
                        !quote ||
                        txStep === "approving" ||
                        txStep === "reserving"
                      }
                      onClick={handleReserve}
                      className="h-12 w-full rounded-full text-sm font-medium active:scale-[0.985] transition-transform cursor-pointer"
                    >
                      {txStep === "approving" ? (
                        <>
                          <Loader2 className="animate-spin" data-icon="inline-start" />
                          1/2 · Approving {selectedPay.symbol}…
                        </>
                      ) : txStep === "reserving" ? (
                        <>
                          <Loader2 className="animate-spin" data-icon="inline-start" />
                          2/2 · Minting Ticket…
                        </>
                      ) : (
                        `Approve & Reserve ${selectedInv.symbol}`
                      )}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>
    </AppShell>
  );
}
