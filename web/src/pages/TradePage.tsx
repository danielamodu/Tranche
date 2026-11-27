import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Check, Loader2 } from "lucide-react";
import { erc20Abi, parseUnits } from "viem";
import { Button } from "@/components/ui/button";
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
  fetchTotalTickets,
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

function tokenBadgeColor(symbol: string): string {
  const s = symbol.toUpperCase();
  if (s.includes("BTC")) return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
  if (s.includes("ETH")) return "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400";
  if (s.includes("HSK")) return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
  return "bg-muted text-foreground";
}

export function TradePage({ onNavigate }: TradePageProps) {
  const { address, activeProvider, isConnected, isWrongNetwork } = useWallet();
  const [offers, setOffers] = useState<OnChainOffer[]>([]);
  const [activity, setActivity] = useState<ProtocolActivityItem[]>([]);
  const [totalTickets, setTotalTickets] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pairFilter, setPairFilter] = useState<string>("ALL");

  // Live Selected Offer & Inline Quote Ticket State
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

  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  const loadOffers = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const [list, ticketsCount] = await Promise.all([fetchAllOffers(), fetchTotalTickets()]);
      setOffers(list);
      setTotalTickets(ticketsCount);
      setNowSec(Math.floor(Date.now() / 1000));
    } catch {
      // keep previous list on transient RPC hiccup
    } finally {
      setLoading(false);
      setRefreshing(false);
    }

    // Defer secondary 5,000-block log scan so it never blocks primary offers render
    fetchRecentActivity()
      .then((act) => {
        setActivity(act.items);
        setTotalTickets(act.totalTickets);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadOffers();
  }, [loadOffers]);

  const activeOffers = useMemo(
    () =>
      offers.filter((o) => o.status === 0 && o.availableBalance > 0n && o.expiry > nowSec),
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

  const selectOffer = useCallback((offer: OnChainOffer) => {
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
  }, []);

  // Auto-select first offer so the live quote card is immediately interactive
  useEffect(() => {
    if (filteredOffers.length === 0) {
      setSelected(null);
      return;
    }
    if (!selected || !filteredOffers.some((o) => o.offerId === selected.offerId)) {
      selectOffer(filteredOffers[0]);
    }
  }, [filteredOffers, selected, selectOffer]);

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
    const timer = setTimeout(() => {
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
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
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
      subtitle="Lock a fixed token price before you buy"
      onNavigate={onNavigate}
      onRefresh={() => loadOffers(true)}
      refreshing={refreshing}
    >
      <div className="flex flex-col gap-5 lg:h-[calc(100svh-120px)] lg:overflow-hidden">
        {/* Clean Plain-English Header Strip (no heavy KPI box clutter) */}
        <section className="flex shrink-0 flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
          <div className="flex flex-col gap-1">
            <h2 className="font-display text-xl font-semibold tracking-[-0.02em] text-foreground">
              Reserve tokens at a guaranteed price
            </h2>
            <p className="text-xs text-muted-foreground">
              1. Pick an offer below &rarr; 2. Pay a small hold fee to lock the price &rarr; 3. Buy
              anytime before expiry in{" "}
              <button
                type="button"
                onClick={() => onNavigate("/tickets")}
                className="font-medium text-foreground underline underline-offset-4 cursor-pointer"
              >
                Tickets
              </button>
              .
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            <span className="whitespace-nowrap">
              Available:{" "}
              <strong className="tabular-nums-mono font-semibold text-foreground">
                {loading
                  ? "—"
                  : `$${totalNotionalUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
              </strong>
            </span>
            <span className="whitespace-nowrap">
              Open offers:{" "}
              <strong className="tabular-nums-mono font-semibold text-foreground">
                {loading ? "—" : activeOffers.length}
              </strong>
            </span>
            <span className="whitespace-nowrap">
              Tickets minted:{" "}
              <strong className="tabular-nums-mono font-semibold text-foreground">
                {loading ? "—" : totalTickets}
              </strong>
            </span>
          </div>
        </section>

        {/* Main Split Desk: Offer List (Left 7 cols, internal scroll) + Reserve Card (Right 5 cols) */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-12">
          {/* LEFT 7 COLS: Clean Offer Book */}
          <div className="flex min-h-0 flex-col gap-3 lg:col-span-7">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {pairOptions.map((pair) => {
                  const active = pairFilter === pair;
                  return (
                    <button
                      key={pair}
                      type="button"
                      onClick={() => setPairFilter(pair)}
                      className={cn(
                        "h-8 rounded-full px-3.5 text-xs font-medium transition-colors cursor-pointer",
                        active
                          ? "bg-primary text-primary-foreground"
                          : "border border-border bg-card text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {pair === "ALL" ? "All pairs" : pair}
                    </button>
                  );
                })}
              </div>
              <span className="text-xs text-muted-foreground">
                {loading
                  ? "Loading…"
                  : `${filteredOffers.length} offer${filteredOffers.length === 1 ? "" : "s"}`}
              </span>
            </div>

            {/* Clean Bordered Table Card with internal scroll */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-border bg-card">
              <div className="hidden shrink-0 grid-cols-12 items-center border-b border-border px-5 py-3 text-xs font-medium text-muted-foreground sm:grid">
                <span className="col-span-5">Token Pair</span>
                <span className="col-span-3 text-right">Available</span>
                <span className="col-span-2 text-right">Locked Price</span>
                <span className="col-span-2 text-right">Hold Fee</span>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                {loading ? (
                  <div className="flex flex-col gap-2 p-4">
                    {[1, 2, 3, 4].map((i) => (
                      <Skeleton key={i} className="h-14 w-full rounded-[12px]" />
                    ))}
                  </div>
                ) : filteredOffers.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center">
                    <h2 className="text-base font-semibold text-foreground">
                      {ACTIVE_NETWORK.isLive ? "No open offers yet" : "Mainnet contracts pending"}
                    </h2>
                    <p className="max-w-xs text-xs text-muted-foreground">
                      {ACTIVE_NETWORK.isLive
                        ? "Deposit tokens and post an offer in Liquidity Vault to make inventory available here."
                        : `Contracts are not yet live on ${ACTIVE_NETWORK.name}.`}
                    </p>
                    {ACTIVE_NETWORK.isLive && (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => onNavigate("/vault")}
                        className="mt-1 h-9 rounded-full px-5 text-xs cursor-pointer"
                      >
                        Open Liquidity Vault
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-1 p-2">
                    {filteredOffers.map((offer) => {
                      const inv = getTokenMeta(offer.inventoryToken);
                      const pay = getTokenMeta(offer.paymentToken);
                      const isFixed = offer.priceMode === 0;
                      const isSelected = selected?.offerId === offer.offerId;
                      const priceLabel = isFixed
                        ? `${formatPriceX36(offer.fixedPriceX36, inv.decimals, pay.decimals)} ${pay.symbol}`
                        : `Oracle ${offer.spreadBps >= 0 ? "+" : ""}${offer.spreadBps} bps`;

                      return (
                        <button
                          key={offer.offerId.toString()}
                          type="button"
                          onClick={() => selectOffer(offer)}
                          className={cn(
                            "grid w-full grid-cols-2 items-center gap-2 rounded-[14px] px-3.5 py-3.5 text-left transition-all sm:grid-cols-12 cursor-pointer",
                            isSelected
                              ? "bg-accent text-foreground ring-1 ring-foreground/15"
                              : "hover:bg-accent/55",
                          )}
                        >
                          <div className="col-span-2 flex items-center gap-3 sm:col-span-5">
                            <span
                              className={cn(
                                "flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                                tokenBadgeColor(inv.symbol),
                              )}
                            >
                              {inv.symbol.replace(/^t/, "").slice(0, 3)}
                            </span>
                            <div className="flex min-w-0 flex-col">
                              <span className="whitespace-nowrap text-sm font-semibold text-foreground">
                                {inv.symbol} / {pay.symbol}
                              </span>
                              <span className="text-[11px] text-muted-foreground">
                                {isFixed ? "Fixed price" : "Market-linked"} · up to{" "}
                                {formatDuration(offer.maxDuration)}
                              </span>
                            </div>
                          </div>

                          <div className="flex flex-col sm:col-span-3 sm:items-end">
                            <span className="text-[10px] text-muted-foreground sm:hidden">
                              Available
                            </span>
                            <span className="tabular-nums-mono whitespace-nowrap text-sm font-medium text-foreground">
                              {formatTokenAmount(offer.availableBalance, inv.decimals)} {inv.symbol}
                            </span>
                          </div>

                          <div className="flex flex-col sm:col-span-2 sm:items-end">
                            <span className="text-[10px] text-muted-foreground sm:hidden">
                              Locked Price
                            </span>
                            <span className="tabular-nums-mono whitespace-nowrap text-sm font-medium text-foreground">
                              {priceLabel}
                            </span>
                          </div>

                          <div className="hidden sm:col-span-2 sm:flex sm:justify-end">
                            <span className="tabular-nums-mono rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                              {(offer.basePremiumBps / 100).toFixed(2)}%
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {activity.length > 0 && (
              <div className="hidden shrink-0 items-center justify-between gap-3 rounded-[14px] border border-border bg-card px-4 py-2.5 text-xs sm:flex">
                <span className="font-medium text-muted-foreground">Latest on-chain event</span>
                <a
                  href={explorerTxUrl(activity[0]!.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground hover:underline underline-offset-4"
                >
                  <span className="truncate">{activity[0]!.label}</span>
                  <span className="tabular-nums-mono shrink-0 text-[11px] text-muted-foreground">
                    #{activity[0]!.blockNumber.toLocaleString()}
                  </span>
                  <ArrowUpRight className="size-3 shrink-0" />
                </a>
              </div>
            )}
          </div>

          {/* RIGHT 5 COLS: Live Quote & Reserve Card */}
          <aside className="flex min-h-0 flex-col lg:col-span-5">
            <div className="flex min-h-0 flex-1 flex-col justify-between overflow-y-auto rounded-[20px] border border-border bg-card p-6">
              {selected && selectedInv && selectedPay ? (
                txStep === "done" && txHash ? (
                  <div className="animate-rise flex flex-col items-center gap-4 py-6 text-center">
                    <span className="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="size-5" />
                    </span>
                    <div className="flex flex-col gap-1">
                      <h3 className="text-lg font-semibold text-foreground">Ticket Minted</h3>
                      <p className="text-xs text-muted-foreground">
                        Your {selectedInv.symbol} inventory is locked and ready to exercise.
                      </p>
                    </div>
                    <a
                      href={explorerTxUrl(txHash)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline underline-offset-4"
                    >
                      View transaction
                      <ArrowUpRight className="size-3.5" />
                    </a>
                    <div className="mt-2 flex w-full gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setTxStep("idle");
                          setTxHash(null);
                        }}
                        className="h-10 flex-1 rounded-full text-xs cursor-pointer"
                      >
                        New Quote
                      </Button>
                      <Button
                        type="button"
                        onClick={() => onNavigate("/tickets")}
                        className="h-10 flex-1 rounded-full text-xs cursor-pointer"
                      >
                        View Ticket
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-5">
                    {/* Card Header */}
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-base font-semibold text-foreground">
                          Reserve {selectedInv.symbol}
                        </h2>
                        <p className="text-xs text-muted-foreground">
                          Offer #{selected.offerId.toString()} ·{" "}
                          {selected.priceMode === 0 ? "Fixed strike" : "Floating oracle"}
                        </p>
                      </div>
                      <span className="tabular-nums-mono rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
                        {selected.priceMode === 0
                          ? `${formatPriceX36(selected.fixedPriceX36, selectedInv.decimals, selectedPay.decimals)} ${selectedPay.symbol}`
                          : `Oracle ${selected.spreadBps >= 0 ? "+" : ""}${selected.spreadBps} bps`}
                      </span>
                    </div>

                    {/* Amount Input */}
                    <div className="rounded-[14px] border border-border bg-background p-4">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <label htmlFor="reserve-amount">Amount</label>
                        <div className="flex items-center gap-1">
                          {[
                            { label: "Min", val: selected.minFillAmount },
                            { label: "50%", val: selected.availableBalance / 2n },
                            { label: "Max", val: selected.availableBalance },
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
                              className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground cursor-pointer"
                            >
                              {q.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="mt-2 flex items-baseline justify-between gap-2">
                        <input
                          id="reserve-amount"
                          type="text"
                          inputMode="decimal"
                          value={amountInput}
                          onChange={(e) => setAmountInput(e.target.value)}
                          placeholder="0.01"
                          className="tabular-nums-mono w-full bg-transparent text-2xl font-semibold tracking-tight text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
                        />
                        <span className="shrink-0 text-sm font-medium text-muted-foreground">
                          {selectedInv.symbol}
                        </span>
                      </div>
                    </div>

                    {/* Lock Duration */}
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-muted-foreground">Lock window</span>
                      <div className="flex items-center gap-1.5">
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
                                "h-8 rounded-full px-3 text-xs font-medium transition-colors cursor-pointer",
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

                    {/* Live Quote Summary */}
                    <div className="flex flex-col gap-2 border-t border-border pt-4 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Hold fee</span>
                        <span className="tabular-nums-mono font-semibold text-foreground">
                          {quoteLoading
                            ? "Quoting…"
                            : quote
                              ? `${formatTokenAmount(quote.grossPremium, selectedPay.decimals, 6)} ${selectedPay.symbol}`
                              : "—"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Your balance</span>
                        <span className="tabular-nums-mono text-muted-foreground">
                          {payBalance !== null
                            ? `${formatTokenAmount(payBalance, selectedPay.decimals, 4)} ${selectedPay.symbol}`
                            : "—"}
                        </span>
                      </div>
                    </div>

                    {txError && (
                      <div className="rounded-[12px] border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive">
                        {txError}
                      </div>
                    )}

                    {/* Primary CTA */}
                    {!isConnected ? (
                      <Button
                        type="button"
                        size="lg"
                        onClick={() => onNavigate("/connect")}
                        className="h-11 w-full rounded-full text-sm font-medium cursor-pointer"
                      >
                        Connect Wallet
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
                        className="h-11 w-full rounded-full text-sm font-medium active:scale-[0.985] transition-transform cursor-pointer"
                      >
                        {txStep === "approving" ? (
                          <>
                            <Loader2 className="animate-spin" data-icon="inline-start" />
                            Approving {selectedPay.symbol}…
                          </>
                        ) : txStep === "reserving" ? (
                          <>
                            <Loader2 className="animate-spin" data-icon="inline-start" />
                            Minting Ticket…
                          </>
                        ) : (
                          `Reserve ${selectedInv.symbol}`
                        )}
                      </Button>
                    )}
                  </div>
                )
              ) : (
                <div className="py-12 text-center text-xs text-muted-foreground">
                  Select an offer to see a live quote.
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </AppShell>
  );
}
