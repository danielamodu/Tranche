import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Loader2,
  ShieldAlert,
  X,
} from "lucide-react";
import { erc20Abi, parseUnits } from "viem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
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
  fetchAllOffers,
  tranchePublicClient,
  type OnChainOffer,
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
      const list = await fetchAllOffers();
      setOffers(list);
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
    if (!selected) return;
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
          setQuote({
            grossPremium: res[0],
            protocolFee: res[1],
            lpNetPremium: res[2],
          });
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
      <div className="flex flex-col gap-6">
        {/* Contextual 3-step Trader Onboarding Strip (dismissible, first-time only) */}
        {showOnboarding && (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-[16px] border border-border bg-card px-5 py-3.5 text-xs">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-muted-foreground">
              <span className="font-medium text-foreground">Quick start:</span>
              <span>
                <strong className="tabular-nums-mono text-foreground">1.</strong> Pick an offer
              </span>
              <span>
                <strong className="tabular-nums-mono text-foreground">2.</strong> Reserve &amp;
                mint ticket
              </span>
              <span>
                <strong className="tabular-nums-mono text-foreground">3.</strong> Exercise in
                Tickets before expiry
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
                    "h-9 rounded-full px-4 text-xs font-medium transition-colors duration-150 cursor-pointer",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "border border-border bg-card text-muted-foreground hover:border-foreground/25 hover:text-foreground",
                  )}
                >
                  {pair === "ALL" ? "All Pairs" : pair}
                </button>
              );
            })}
          </div>

          <span className="tabular-nums-mono text-xs text-muted-foreground">
            {loading ? "Syncing…" : `${filteredOffers.length} active offer${filteredOffers.length === 1 ? "" : "s"}`}
          </span>
        </div>

        {/* Main Offers Ledger */}
        <div className="overflow-hidden rounded-[20px] border border-border bg-card">
          {/* Column Header */}
          <div className="hidden grid-cols-12 items-center border-b border-border px-6 py-3.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground sm:grid">
            <span className="col-span-3">Pair &amp; Mode</span>
            <span className="col-span-2 text-right">Available</span>
            <span className="col-span-3 text-right">Price</span>
            <span className="col-span-2 text-right">Premium</span>
            <span className="col-span-2 text-right">Action</span>
          </div>

          {loading ? (
            <div className="flex flex-col divide-y divide-border">
              {[1, 2, 3].map((i) => (
                <div key={i} className="grid grid-cols-12 items-center gap-4 px-6 py-5">
                  <Skeleton className="col-span-3 h-5 w-32" />
                  <Skeleton className="col-span-2 ml-auto h-5 w-20" />
                  <Skeleton className="col-span-3 ml-auto h-5 w-24" />
                  <Skeleton className="col-span-2 ml-auto h-5 w-14" />
                  <Skeleton className="col-span-2 ml-auto h-9 w-24 rounded-full" />
                </div>
              ))}
            </div>
          ) : filteredOffers.length === 0 ? (
            <div className="flex flex-col items-center gap-4 px-6 py-20 text-center">
              <div className="flex flex-col gap-1.5">
                <h2 className="font-display text-xl font-semibold text-foreground">
                  No open offers right now
                </h2>
                <p className="max-w-sm text-sm text-muted-foreground">
                  All previous testnet offers on Chain {ACTIVE_NETWORK.chainId} have been filled or
                  cancelled. Create a fresh LP offer in Vault to test the full reservation flow.
                </p>
              </div>
              <Button
                type="button"
                onClick={() => onNavigate("/vault")}
                className="h-10 rounded-full px-6 text-xs font-medium cursor-pointer"
              >
                Open Vault to Create Offer
                <ArrowUpRight data-icon="inline-end" />
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-border">
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
                    className="grid grid-cols-1 items-center gap-3 px-6 py-4 transition-colors duration-150 hover:bg-accent/45 sm:grid-cols-12 sm:gap-2 cursor-pointer"
                  >
                    <div className="col-span-3 flex items-center gap-2.5">
                      <div className="flex flex-col">
                        <span className="text-sm font-semibold text-foreground">
                          {inv.symbol} / {pay.symbol}
                        </span>
                        <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                          #{offer.offerId.toString()} · {isFixed ? "FIXED" : "FLOATING"} · max{" "}
                          {formatDuration(offer.maxDuration)}
                        </span>
                      </div>
                    </div>

                    <div className="col-span-2 flex items-center justify-between sm:justify-end">
                      <span className="text-xs text-muted-foreground sm:hidden">Available</span>
                      <span className="tabular-nums-mono text-sm font-medium text-foreground">
                        {formatTokenAmount(offer.availableBalance, inv.decimals)} {inv.symbol}
                      </span>
                    </div>

                    <div className="col-span-3 flex items-center justify-between sm:justify-end">
                      <span className="text-xs text-muted-foreground sm:hidden">Price</span>
                      <span className="tabular-nums-mono text-sm text-foreground">{priceLabel}</span>
                    </div>

                    <div className="col-span-2 flex items-center justify-between sm:justify-end">
                      <span className="text-xs text-muted-foreground sm:hidden">Premium</span>
                      <span className="tabular-nums-mono text-sm text-muted-foreground">
                        {(offer.basePremiumBps / 100).toFixed(2)}%
                      </span>
                    </div>

                    <div className="col-span-2 flex justify-end">
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
                    {/* Size Input */}
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between text-xs">
                        <label htmlFor="reserve-amount" className="text-muted-foreground">
                          Amount ({selectedInv.symbol})
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
                              className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground cursor-pointer"
                            >
                              {q.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <Input
                        id="reserve-amount"
                        type="text"
                        inputMode="decimal"
                        value={amountInput}
                        onChange={(e) => setAmountInput(e.target.value)}
                        placeholder="0.01"
                        className="tabular-nums-mono h-12 rounded-[12px] bg-background text-base"
                      />
                    </div>

                    {/* Lock Duration Pills */}
                    <div className="flex flex-col gap-2">
                      <span className="text-xs text-muted-foreground">
                        Lock duration ({formatDuration(selected.minDuration)} –{" "}
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
                                "h-9 rounded-full px-4 text-xs font-medium transition-colors cursor-pointer",
                                active
                                  ? "bg-primary text-primary-foreground"
                                  : "border border-border bg-background text-muted-foreground hover:text-foreground",
                              )}
                            >
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Live On-Chain Quote Summary */}
                    <div className="flex flex-col gap-3 rounded-[16px] border border-border bg-background p-4 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Upfront Premium</span>
                        <span className="tabular-nums-mono font-semibold text-foreground">
                          {quoteLoading
                            ? "Quoting…"
                            : quote
                              ? `${formatTokenAmount(quote.grossPremium, selectedPay.decimals, 6)} ${selectedPay.symbol}`
                              : "—"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Your {selectedPay.symbol} Balance</span>
                        <span className="tabular-nums-mono text-muted-foreground">
                          {payBalance !== null
                            ? `${formatTokenAmount(payBalance, selectedPay.decimals, 4)} ${selectedPay.symbol}`
                            : "—"}
                        </span>
                      </div>
                      <Separator />
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        Upfront reservation premium is non-refundable if the ticket expires
                        unexercised.
                      </p>
                    </div>

                    {txError && (
                      <div className="flex items-start gap-2 rounded-[12px] border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive">
                        <ShieldAlert className="mt-0.5 size-4 shrink-0" />
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
