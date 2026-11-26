import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Clock,
  Loader2,
  RotateCcw,
  Scissors,
  Send,
  ShieldAlert,
} from "lucide-react";
import { erc20Abi, isAddress, parseUnits, type Address } from "viem";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
import { formatPriceX36, formatTokenAmount, getTokenMeta } from "@/config/tokens";
import { useWallet } from "@/context/WalletContext";
import {
  COMMITMENT_MANAGER_ABI,
  EXECUTION_TICKET_ABI,
  createTrancheWalletClient,
  decodeQuoteExerciseResult,
  fetchUserTickets,
  tranchePublicClient,
  type ExerciseQuote,
  type OnChainTicket,
} from "@/lib/protocol";
import type { AppRoute } from "@/App";

interface TicketsPageProps {
  onNavigate: (path: AppRoute) => void;
}

function formatCountdown(expiresAt: number, nowSec: number): string {
  const diff = expiresAt - nowSec;
  if (diff <= 0) return "Expired";
  const hrs = Math.floor(diff / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  const secs = diff % 60;
  if (hrs > 0) {
    return `${hrs}h ${String(mins).padStart(2, "0")}m ${String(secs).padStart(2, "0")}s`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function TicketsPage({ onNavigate }: TicketsPageProps) {
  const { address, activeProvider, isConnected, isWrongNetwork } = useWallet();
  const [tickets, setTickets] = useState<OnChainTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  // Exercise Sheet state
  const [exerciseTicket, setExerciseTicket] = useState<OnChainTicket | null>(null);
  const [fillInput, setFillInput] = useState("");
  const [exQuote, setExQuote] = useState<ExerciseQuote | null>(null);
  const [exQuoteLoading, setExQuoteLoading] = useState(false);
  const [payBalance, setPayBalance] = useState<bigint | null>(null);
  const [exStep, setExStep] = useState<"idle" | "approving" | "exercising" | "done">("idle");
  const [exTxHash, setExTxHash] = useState<string | null>(null);
  const [exError, setExError] = useState<string | null>(null);

  // Split / Transfer Dialog state
  const [actionMode, setActionMode] = useState<{
    kind: "split" | "transfer";
    ticket: OnChainTicket;
  } | null>(null);
  const [splitAmountInput, setSplitAmountInput] = useState("");
  const [recipientInput, setRecipientInput] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reclaimingId, setReclaimingId] = useState<string | null>(null);
  const [reclaimError, setReclaimError] = useState<string | null>(null);

  // Live 1-second countdown ticker
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const loadTickets = useCallback(
    async (isManual = false) => {
      if (!address) {
        setTickets([]);
        setLoading(false);
        return;
      }
      if (isManual) setRefreshing(true);
      try {
        const list = await fetchUserTickets(address);
        setTickets(list);
      } catch {
        // retain current tickets on transient RPC failure
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [address],
  );

  useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  function openExerciseSheet(t: OnChainTicket) {
    const inv = getTokenMeta(t.inventoryToken);
    setExerciseTicket(t);
    setFillInput(formatTokenAmount(t.remainingAmount, inv.decimals, 6).replace(/,/g, ""));
    setExQuote(null);
    setExStep("idle");
    setExTxHash(null);
    setExError(null);
  }

  // Payment token balance for Exercise Sheet
  useEffect(() => {
    if (!exerciseTicket || !address) {
      setPayBalance(null);
      return;
    }
    let cancelled = false;
    tranchePublicClient
      .readContract({
        address: exerciseTicket.paymentToken,
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
  }, [exerciseTicket, address, exStep]);

  // Live on-chain quoteExercise
  useEffect(() => {
    if (!exerciseTicket || !ACTIVE_NETWORK.isLive) return;
    const inv = getTokenMeta(exerciseTicket.inventoryToken);
    let parsed = 0n;
    try {
      parsed = fillInput ? parseUnits(fillInput, inv.decimals) : 0n;
    } catch {
      setExQuote(null);
      return;
    }
    if (parsed <= 0n || parsed > exerciseTicket.remainingAmount) {
      setExQuote(null);
      return;
    }

    let cancelled = false;
    setExQuoteLoading(true);
    tranchePublicClient
      .readContract({
        address: ACTIVE_NETWORK.contracts.commitmentManager,
        abi: COMMITMENT_MANAGER_ABI,
        functionName: "quoteExercise",
        args: [exerciseTicket.ticketId, parsed],
      })
      .then((res) => {
        if (!cancelled) {
          setExQuote(decodeQuoteExerciseResult(res));
        }
      })
      .catch(() => {
        if (!cancelled) setExQuote(null);
      })
      .finally(() => {
        if (!cancelled) setExQuoteLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [exerciseTicket, fillInput]);

  async function handleExercise() {
    if (!exerciseTicket || !address || !activeProvider || !exQuote) return;
    const inv = getTokenMeta(exerciseTicket.inventoryToken);
    const fillAmt = parseUnits(fillInput, inv.decimals);
    const walletClient = createTrancheWalletClient(activeProvider, address);
    const { liquidityVault, commitmentManager } = ACTIVE_NETWORK.contracts;

    setExError(null);
    try {
      const allowance = await tranchePublicClient.readContract({
        address: exerciseTicket.paymentToken,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, liquidityVault],
      });

      if (allowance < exQuote.grossPayment) {
        setExStep("approving");
        const approveHash = await walletClient.writeContract({
          address: exerciseTicket.paymentToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [liquidityVault, exQuote.grossPayment],
        });
        await tranchePublicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      setExStep("exercising");
      const maxPayment = exQuote.grossPayment + exQuote.grossPayment / 100n + 1n;
      const hash = await walletClient.writeContract({
        address: commitmentManager,
        abi: COMMITMENT_MANAGER_ABI,
        functionName: "exercise",
        args: [exerciseTicket.ticketId, fillAmt, maxPayment, address],
      });
      await tranchePublicClient.waitForTransactionReceipt({ hash });

      setExTxHash(hash);
      setExStep("done");
      loadTickets(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Exercise failed or rejected.";
      setExError(msg.length > 140 ? `${msg.slice(0, 140)}…` : msg);
      setExStep("idle");
    }
  }

  async function handleReclaim(t: OnChainTicket) {
    if (!address || !activeProvider || !ACTIVE_NETWORK.isLive) return;
    setReclaimingId(t.ticketId.toString());
    setReclaimError(null);
    try {
      const walletClient = createTrancheWalletClient(activeProvider, address);
      const hash = await walletClient.writeContract({
        address: ACTIVE_NETWORK.contracts.commitmentManager,
        abi: COMMITMENT_MANAGER_ABI,
        functionName: "reclaimExpired",
        args: [t.ticketId],
      });
      await tranchePublicClient.waitForTransactionReceipt({ hash });
      loadTickets(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Reclaim transaction failed or rejected.";
      setReclaimError(msg.length > 160 ? `${msg.slice(0, 160)}…` : msg);
    } finally {
      setReclaimingId(null);
    }
  }

  async function handleSplitOrTransfer() {
    if (!actionMode || !address || !activeProvider) return;
    if (!isAddress(recipientInput)) {
      setActionError("Enter a valid 0x recipient address.");
      return;
    }

    setActionError(null);
    setActionBusy(true);
    const walletClient = createTrancheWalletClient(activeProvider, address);

    try {
      if (actionMode.kind === "split") {
        const inv = getTokenMeta(actionMode.ticket.inventoryToken);
        const splitAmt = parseUnits(splitAmountInput, inv.decimals);
        const hash = await walletClient.writeContract({
          address: ACTIVE_NETWORK.contracts.commitmentManager,
          abi: COMMITMENT_MANAGER_ABI,
          functionName: "splitTicket",
          args: [actionMode.ticket.ticketId, splitAmt, recipientInput as Address],
        });
        await tranchePublicClient.waitForTransactionReceipt({ hash });
      } else {
        const hash = await walletClient.writeContract({
          address: ACTIVE_NETWORK.contracts.executionTicket,
          abi: EXECUTION_TICKET_ABI,
          functionName: "transferFrom",
          args: [address, recipientInput as Address, actionMode.ticket.ticketId],
        });
        await tranchePublicClient.waitForTransactionReceipt({ hash });
      }

      setActionMode(null);
      loadTickets(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Transaction failed.";
      setActionError(msg.length > 140 ? `${msg.slice(0, 140)}…` : msg);
    } finally {
      setActionBusy(false);
    }
  }

  const exInv = exerciseTicket ? getTokenMeta(exerciseTicket.inventoryToken) : null;
  const exPay = exerciseTicket ? getTokenMeta(exerciseTicket.paymentToken) : null;

  return (
    <AppShell
      activeRoute="/tickets"
      title="My Tickets"
      subtitle="ERC-721 execution tickets owned by your wallet"
      onNavigate={onNavigate}
      onRefresh={() => loadTickets(true)}
      refreshing={refreshing}
    >
      {!isConnected ? (
        <div className="mx-auto flex max-w-[460px] flex-col items-center py-12 text-center">
          <div className="w-full rounded-t-[22px] border border-dashed border-border/90 bg-card/40 px-8 py-12">
            <span className="tabular-nums-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              ERC-721 Vault · Wallet Required
            </span>
            <h2 className="mt-2 font-display text-2xl font-semibold tracking-[-0.03em]">
              Connect wallet to inspect tickets
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Your active Execution Tickets appear here automatically as physical stubs once
              connected.
            </p>
            <Button
              type="button"
              onClick={() => onNavigate("/connect")}
              className="mt-6 h-10 rounded-full px-6 text-xs font-medium cursor-pointer"
            >
              Connect Wallet
              <ArrowRight data-icon="inline-end" />
            </Button>
          </div>
          <svg
            viewBox="0 0 440 24"
            preserveAspectRatio="none"
            aria-hidden="true"
            className="block h-4 w-full opacity-20"
          >
            <polygon
              points="0,0 440,0 440,24 330,4 220,24 110,4 0,24"
              style={{ fill: "#f8f7ee" }}
            />
          </svg>
        </div>
      ) : loading ? (
        <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[310px] w-full rounded-[22px]" />
          ))}
        </div>
      ) : tickets.length === 0 ? (
        <div className="mx-auto flex max-w-[460px] flex-col items-center py-12 text-center">
          <div className="w-full rounded-t-[22px] border border-dashed border-border/90 bg-card/40 px-8 py-12">
            <span className="tabular-nums-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              0 Active Stubs
            </span>
            <h2 className="mt-2 font-display text-2xl font-semibold tracking-[-0.03em] text-foreground">
              No active execution tickets
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Reserve inventory from an open offer strip on the Trade Desk to mint your first
              ERC-721 Execution Ticket.
            </p>
            <Button
              type="button"
              onClick={() => onNavigate("/trade")}
              className="mt-6 h-10 rounded-full px-6 text-xs font-medium cursor-pointer"
            >
              Browse Open Offers
              <ArrowRight data-icon="inline-end" />
            </Button>
          </div>
          <svg
            viewBox="0 0 440 24"
            preserveAspectRatio="none"
            aria-hidden="true"
            className="block h-4 w-full opacity-20"
          >
            <polygon
              points="0,0 440,0 440,24 330,4 220,24 110,4 0,24"
              style={{ fill: "#f8f7ee" }}
            />
          </svg>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {/* Editorial Hairline Ticket Summary Strip */}
          <section className="grid grid-cols-3 gap-y-4 border-b border-border/80 pb-6 sm:divide-x sm:divide-border/80">
            <div className="flex flex-col gap-1 pr-4">
              <span className="tabular-nums-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                01 · Owned Tickets
              </span>
              <span className="tabular-nums-mono font-display text-3xl font-bold tracking-[-0.04em] text-foreground">
                {tickets.length}
              </span>
            </div>
            <div className="flex flex-col gap-1 sm:px-6">
              <span className="tabular-nums-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                02 · Active
              </span>
              <span className="tabular-nums-mono font-display text-3xl font-bold tracking-[-0.04em] text-foreground">
                {tickets.filter((t) => t.expiresAt > nowSec).length}
              </span>
            </div>
            <div className="flex flex-col gap-1 sm:pl-6">
              <span className="tabular-nums-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                03 · Expired
              </span>
              <span className="tabular-nums-mono font-display text-3xl font-bold tracking-[-0.04em] text-muted-foreground">
                {tickets.filter((t) => t.expiresAt <= nowSec).length}
              </span>
            </div>
          </section>

          {reclaimError && (
            <div className="flex items-start justify-between gap-3 rounded-[14px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive">
              <div className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                <span>Reclaim failed: {reclaimError}</span>
              </div>
              <button
                type="button"
                onClick={() => setReclaimError(null)}
                className="shrink-0 underline underline-offset-4 cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          )}
        <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-3">
          {tickets.map((t) => {
            const inv = getTokenMeta(t.inventoryToken);
            const pay = getTokenMeta(t.paymentToken);
            const isFixed = t.priceMode === 0;
            const expired = t.expiresAt <= nowSec;

            // Signature Tranche dual paper stock: cream for FIXED, carbon vellum for FLOATING
            const bg = isFixed ? "#f8f7ee" : "#121210";
            const fg = isFixed ? "#050505" : "#f8f7ee";
            const muted = isFixed ? "rgba(5, 5, 5, 0.56)" : "rgba(248, 247, 238, 0.56)";
            const hairline = isFixed ? "rgba(5, 5, 5, 0.14)" : "rgba(248, 247, 238, 0.14)";

            return (
              <div
                key={t.ticketId.toString()}
                className="flex flex-col drop-shadow-[0_24px_56px_rgba(0,0,0,0.65)]"
              >
                <div
                  className="relative flex flex-1 flex-col overflow-hidden rounded-t-[20px] px-6 pt-6 pb-5"
                  style={{
                    backgroundColor: bg,
                    color: fg,
                    borderTop: isFixed ? "none" : "1px solid rgba(248, 247, 238, 0.14)",
                    borderLeft: isFixed ? "none" : "1px solid rgba(248, 247, 238, 0.1)",
                    borderRight: isFixed ? "none" : "1px solid rgba(248, 247, 238, 0.1)",
                  }}
                >
                  {/* Top row */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-display text-base font-extrabold tracking-[-0.04em]">
                        tranche
                      </span>
                      <span
                        className="tabular-nums-mono text-[11px] uppercase tracking-[0.08em]"
                        style={{ color: muted }}
                      >
                        #{t.ticketId.toString()} · Offer #{t.offerId.toString()}
                      </span>
                    </div>
                    <span
                      className="tabular-nums-mono inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium"
                      style={{ border: `1px solid ${hairline}`, color: fg }}
                    >
                      <Clock className="size-3" />
                      {formatCountdown(t.expiresAt, nowSec)}
                    </span>
                  </div>

                  {/* Primary figures */}
                  <div className="mt-6 flex items-baseline justify-between gap-4">
                    <div className="flex flex-col gap-0.5">
                      <span
                        className="text-[10px] font-medium uppercase tracking-[0.1em]"
                        style={{ color: muted }}
                      >
                        Remaining
                      </span>
                      <span className="tabular-nums-mono text-2xl font-semibold tracking-tight">
                        {formatTokenAmount(t.remainingAmount, inv.decimals)}{" "}
                        <span className="text-sm font-medium opacity-70">{inv.symbol}</span>
                      </span>
                    </div>
                    <div className="flex flex-col items-end gap-0.5">
                      <span
                        className="text-[10px] font-medium uppercase tracking-[0.1em]"
                        style={{ color: muted }}
                      >
                        {isFixed ? "Locked Strike" : "Floating Spread"}
                      </span>
                      <span className="tabular-nums-mono text-base font-semibold">
                        {isFixed
                          ? `${formatPriceX36(t.fixedOrMinPriceX36, inv.decimals, pay.decimals)} ${pay.symbol}`
                          : `Oracle ${t.spreadBps >= 0 ? "+" : ""}${t.spreadBps} bps`}
                      </span>
                    </div>
                  </div>

                  {/* Perforated tear line */}
                  <div className="relative my-5 flex items-center">
                    <span
                      aria-hidden="true"
                      className="absolute -left-8 size-3.5 rounded-full bg-background"
                    />
                    <div
                      className="w-full border-t border-dashed"
                      style={{ borderColor: hairline }}
                    />
                    <span
                      aria-hidden="true"
                      className="absolute -right-8 size-3.5 rounded-full bg-background"
                    />
                  </div>

                  {/* Action Buttons */}
                  <div className="flex items-center gap-2">
                    {expired ? (
                      <button
                        type="button"
                        disabled={isWrongNetwork || reclaimingId === t.ticketId.toString()}
                        onClick={() => handleReclaim(t)}
                        className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-full text-xs font-medium transition-opacity disabled:opacity-50 cursor-pointer"
                        style={{ backgroundColor: fg, color: bg }}
                      >
                        <RotateCcw className="size-3.5" />
                        {reclaimingId === t.ticketId.toString()
                          ? "Reclaiming…"
                          : "Reclaim Expired"}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => openExerciseSheet(t)}
                          className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full text-xs font-medium transition-transform active:scale-[0.985] cursor-pointer"
                          style={{ backgroundColor: fg, color: bg }}
                        >
                          Exercise
                          <ArrowRight className="size-3.5" />
                        </button>

                        <button
                          type="button"
                          title="Split ticket"
                          onClick={() => {
                            setActionError(null);
                            setSplitAmountInput("");
                            setRecipientInput(address ?? "");
                            setActionMode({ kind: "split", ticket: t });
                          }}
                          className="inline-flex size-10 items-center justify-center rounded-full transition-opacity hover:opacity-80 cursor-pointer"
                          style={{ border: `1px solid ${hairline}`, color: fg }}
                        >
                          <Scissors className="size-3.5" />
                        </button>

                        <button
                          type="button"
                          title="Transfer ticket"
                          onClick={() => {
                            setActionError(null);
                            setRecipientInput("");
                            setActionMode({ kind: "transfer", ticket: t });
                          }}
                          className="inline-flex size-10 items-center justify-center rounded-full transition-opacity hover:opacity-80 cursor-pointer"
                          style={{ border: `1px solid ${hairline}`, color: fg }}
                        >
                          <Send className="size-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Serrated bottom edge */}
                <svg
                  viewBox="0 0 440 32"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                  className="block h-5 w-full -mt-[2px]"
                >
                  <polygon
                    points="0,0 440,0 440,32 330,4 220,32 110,4 0,32"
                    style={{ fill: bg }}
                  />
                </svg>
              </div>
            );
          })}
        </div>
        </div>
      )}

      {/* Apple Slide-Over Exercise Sheet */}
      <Sheet open={exerciseTicket !== null} onOpenChange={(open) => !open && setExerciseTicket(null)}>
        <SheetContent className="flex w-full flex-col justify-between border-l border-border bg-card px-6 py-6 sm:max-w-[440px]">
          {exerciseTicket && exInv && exPay && (
            <>
              <div className="flex flex-col gap-6">
                <SheetHeader className="p-0 text-left">
                  <span className="tabular-nums-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    Execution Ticket #{exerciseTicket.ticketId.toString()}
                  </span>
                  <SheetTitle className="font-display text-2xl font-semibold">
                    Exercise {exInv.symbol}
                  </SheetTitle>
                  <SheetDescription className="text-xs text-muted-foreground">
                    Remaining: {formatTokenAmount(exerciseTicket.remainingAmount, exInv.decimals)}{" "}
                    {exInv.symbol} · {formatCountdown(exerciseTicket.expiresAt, nowSec)}
                  </SheetDescription>
                </SheetHeader>

                {exStep === "done" && exTxHash ? (
                  <div className="animate-rise flex flex-col items-center gap-4 rounded-[20px] border border-border bg-background p-7 text-center">
                    <span className="flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="size-5" />
                    </span>
                    <div className="flex flex-col gap-1">
                      <h3 className="font-display text-xl font-semibold">Settlement Complete</h3>
                      <p className="text-xs text-muted-foreground">
                        {exInv.symbol} has been delivered directly to your wallet.
                      </p>
                    </div>
                    <a
                      href={explorerTxUrl(exTxHash)}
                      target="_blank"
                      rel="noreferrer"
                      className="tabular-nums-mono inline-flex items-center gap-1 text-xs text-foreground underline underline-offset-4"
                    >
                      View on Blockscout
                      <ArrowUpRight className="size-3.5" />
                    </a>
                    <Button
                      type="button"
                      onClick={() => setExerciseTicket(null)}
                      className="mt-2 h-10 w-full rounded-full text-xs cursor-pointer"
                    >
                      Done
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-5">
                    <div className="flex flex-col gap-2.5">
                      <div className="flex items-center justify-between text-xs">
                        <label
                          htmlFor="fill-amount"
                          className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
                        >
                          Fill Amount ({exInv.symbol})
                        </label>
                        <div className="flex items-center gap-1">
                          {[
                            { label: "50%", val: exerciseTicket.remainingAmount / 2n },
                            { label: "Full", val: exerciseTicket.remainingAmount },
                          ].map((q) => (
                            <button
                              key={q.label}
                              type="button"
                              onClick={() =>
                                setFillInput(
                                  formatTokenAmount(q.val, exInv.decimals, 6).replace(/,/g, ""),
                                )
                              }
                              className="tabular-nums-mono rounded-full border border-border px-2.5 py-0.5 text-[10px] text-muted-foreground hover:border-foreground/40 hover:text-foreground cursor-pointer"
                            >
                              {q.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-baseline justify-between gap-2 border-b border-border/90 pb-2 transition-colors focus-within:border-foreground">
                        <input
                          id="fill-amount"
                          type="text"
                          inputMode="decimal"
                          value={fillInput}
                          onChange={(e) => setFillInput(e.target.value)}
                          className="tabular-nums-mono w-full bg-transparent font-display text-3xl font-bold tracking-[-0.04em] text-foreground focus:outline-none"
                        />
                        <span className="tabular-nums-mono shrink-0 text-sm font-medium text-muted-foreground">
                          {exInv.symbol}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2.5 border-t border-dashed border-border/90 pt-4 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Total Settlement Cost</span>
                        <span className="tabular-nums-mono text-sm font-semibold text-foreground">
                          {exQuoteLoading
                            ? "Quoting…"
                            : exQuote
                              ? `${formatTokenAmount(exQuote.grossPayment, exPay.decimals, 6)} ${exPay.symbol}`
                              : "—"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Your {exPay.symbol} Balance</span>
                        <span className="tabular-nums-mono text-muted-foreground">
                          {payBalance !== null
                            ? `${formatTokenAmount(payBalance, exPay.decimals, 4)} ${exPay.symbol}`
                            : "—"}
                        </span>
                      </div>
                    </div>

                    {exError && (
                      <div className="relative overflow-hidden rounded-[12px] border border-destructive/35 bg-destructive/10 py-2.5 pl-4 pr-3.5 text-xs text-destructive">
                        <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-destructive" />
                        <span>{exError}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {exStep !== "done" && (
                <div className="pt-4">
                  <Button
                    type="button"
                    size="lg"
                    disabled={
                      isWrongNetwork ||
                      !exQuote ||
                      exStep === "approving" ||
                      exStep === "exercising"
                    }
                    onClick={handleExercise}
                    className="h-12 w-full rounded-full text-sm font-medium cursor-pointer"
                  >
                    {exStep === "approving" ? (
                      <>
                        <Loader2 className="animate-spin" data-icon="inline-start" />
                        1/2 · Approving {exPay.symbol}…
                      </>
                    ) : exStep === "exercising" ? (
                      <>
                        <Loader2 className="animate-spin" data-icon="inline-start" />
                        2/2 · Settling Exercise…
                      </>
                    ) : (
                      `Approve & Exercise ${exInv.symbol}`
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Split / Transfer Dialog */}
      <Dialog open={actionMode !== null} onOpenChange={(open) => !open && setActionMode(null)}>
        <DialogContent className="rounded-[22px] border-border bg-card sm:max-w-[420px]">
          {actionMode && (
            <>
              <DialogHeader>
                <DialogTitle className="font-display text-xl">
                  {actionMode.kind === "split"
                    ? `Split Ticket #${actionMode.ticket.ticketId.toString()}`
                    : `Transfer Ticket #${actionMode.ticket.ticketId.toString()}`}
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground">
                  {actionMode.kind === "split"
                    ? "Carve out a child ERC-721 ticket to send or exercise separately."
                    : "Transfer full ownership of this ERC-721 execution right to another address."}
                </DialogDescription>
              </DialogHeader>

              <div className="mt-2 flex flex-col gap-4">
                {actionMode.kind === "split" && (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs text-muted-foreground">
                      Split Amount ({getTokenMeta(actionMode.ticket.inventoryToken).symbol})
                    </label>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={splitAmountInput}
                      onChange={(e) => setSplitAmountInput(e.target.value)}
                      placeholder="0.005"
                      className="tabular-nums-mono h-11 rounded-[12px] bg-background"
                    />
                  </div>
                )}

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-muted-foreground">Recipient Address</label>
                  <Input
                    type="text"
                    value={recipientInput}
                    onChange={(e) => setRecipientInput(e.target.value)}
                    placeholder="0x…"
                    className="tabular-nums-mono h-11 rounded-[12px] bg-background text-xs"
                  />
                </div>

                {actionError && (
                  <p className="text-xs text-destructive">{actionError}</p>
                )}

                <Button
                  type="button"
                  disabled={isWrongNetwork || actionBusy}
                  onClick={handleSplitOrTransfer}
                  className="h-11 w-full rounded-full text-xs font-medium cursor-pointer"
                >
                  {actionBusy
                    ? "Confirming…"
                    : actionMode.kind === "split"
                      ? "Confirm Split"
                      : "Confirm Transfer"}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
