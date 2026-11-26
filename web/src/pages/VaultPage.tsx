import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  Check,
  Loader2,
  Plus,
  ShieldAlert,
  X,
} from "lucide-react";
import { erc20Abi, parseUnits, zeroAddress } from "viem";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  TOKEN_LIST,
  formatDuration,
  formatPriceX36,
  formatTokenAmount,
  getTokenMeta,
  parseHumanPriceToX36,
  type TokenMeta,
} from "@/config/tokens";
import { useWallet } from "@/context/WalletContext";
import {
  COMMITMENT_MANAGER_ABI,
  LIQUIDITY_VAULT_ABI,
  chunkedMulticall,
  createTrancheWalletClient,
  fetchAllOffers,
  tranchePublicClient,
  type MulticallEntry,
  type OnChainOffer,
} from "@/lib/protocol";
import { cn } from "@/lib/utils";
import type { AppRoute } from "@/App";

interface VaultPageProps {
  onNavigate: (path: AppRoute) => void;
}

interface TokenVaultState {
  token: TokenMeta;
  walletBal: bigint;
  freeBal: bigint;
  pendingProceeds: bigint;
}

const PAYMENT_TOKEN = getTokenMeta(ACTIVE_NETWORK.contracts.USDT);

const INVENTORY_TOKENS = TOKEN_LIST.filter(
  (t) => t.address.toLowerCase() !== ACTIVE_NETWORK.contracts.USDT.toLowerCase(),
);

export function VaultPage({ onNavigate }: VaultPageProps) {
  const { address, activeProvider, isConnected, isWrongNetwork } = useWallet();
  const [vaultRows, setVaultRows] = useState<TokenVaultState[]>([]);
  const [myOffers, setMyOffers] = useState<OnChainOffer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState<boolean>(
    () => localStorage.getItem("tranche-lp-tip-dismissed") !== "1",
  );

  // Deposit / Withdraw Sheet
  const [transferSheet, setTransferSheet] = useState<{
    mode: "deposit" | "withdraw";
    token: TokenMeta;
  } | null>(null);
  const [transferInput, setTransferInput] = useState("");
  const [transferStep, setTransferStep] = useState<"idle" | "approving" | "sending" | "done">(
    "idle",
  );
  const [transferTxHash, setTransferTxHash] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);

  // Create Offer Sheet (Progressive Disclosure: FIXED default -> FLOATING reveal)
  const [createOpen, setCreateOpen] = useState(false);
  const [invToken, setInvToken] = useState<TokenMeta>(INVENTORY_TOKENS[0] ?? TOKEN_LIST[0]);
  const [priceMode, setPriceMode] = useState<"FIXED" | "FLOATING">("FIXED");
  const [offerAmtInput, setOfferAmtInput] = useState("0.02");
  const [minFillInput, setMinFillInput] = useState("0.001");
  const [fixedPriceInput, setFixedPriceInput] = useState("3000");
  const [spreadBpsInput, setSpreadBpsInput] = useState("50");
  const [minPriceInput, setMinPriceInput] = useState("2500");
  const [maxPriceInput, setMaxPriceInput] = useState("3500");
  const [premiumBpsInput, setPremiumBpsInput] = useState("50");
  const [maxLockSec, setMaxLockSec] = useState(1800);
  const [offerBusy, setOfferBusy] = useState(false);
  const [offerTxHash, setOfferTxHash] = useState<string | null>(null);
  const [offerError, setOfferError] = useState<string | null>(null);

  // Claim / Cancel state
  const [claimingToken, setClaimingToken] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<OnChainOffer | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [vaultActionError, setVaultActionError] = useState<string | null>(null);

  const loadVaultData = useCallback(
    async (isManual = false) => {
      if (!address || !ACTIVE_NETWORK.isLive) {
        setVaultRows([]);
        setMyOffers([]);
        setLoading(false);
        return;
      }
      if (isManual) setRefreshing(true);
      try {
        const { liquidityVault } = ACTIVE_NETWORK.contracts;
        const calls: MulticallEntry[] = [];
        for (const token of TOKEN_LIST) {
          calls.push(
            {
              address: token.address,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [address],
            },
            {
              address: liquidityVault,
              abi: LIQUIDITY_VAULT_ABI,
              functionName: "lpFreeBalance",
              args: [address, token.address],
            },
            {
              address: liquidityVault,
              abi: LIQUIDITY_VAULT_ABI,
              functionName: "lpPendingProceeds",
              args: [address, token.address],
            },
          );
        }

        const [outcomes, allOffers] = await Promise.all([
          chunkedMulticall(tranchePublicClient, calls, ACTIVE_NETWORK.multicall3),
          fetchAllOffers(),
        ]);

        const rows: TokenVaultState[] = TOKEN_LIST.map((token, idx) => {
          const wOut = outcomes[idx * 3];
          const fOut = outcomes[idx * 3 + 1];
          const pOut = outcomes[idx * 3 + 2];
          return {
            token,
            walletBal: wOut?.status === "success" && typeof wOut.result === "bigint" ? wOut.result : 0n,
            freeBal: fOut?.status === "success" && typeof fOut.result === "bigint" ? fOut.result : 0n,
            pendingProceeds: pOut?.status === "success" && typeof pOut.result === "bigint" ? pOut.result : 0n,
          };
        });
        setVaultRows(rows);
        setMyOffers(allOffers.filter((o) => o.lp.toLowerCase() === address.toLowerCase()));
      } catch {
        // retain previous state on transient RPC error
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [address],
  );

  useEffect(() => {
    loadVaultData();
  }, [loadVaultData]);

  const hasDeposited = useMemo(
    () => vaultRows.some((r) => r.freeBal > 0n) || myOffers.length > 0,
    [vaultRows, myOffers],
  );
  const hasActiveOffer = useMemo(
    () => myOffers.some((o) => o.status === 0 && o.availableBalance > 0n),
    [myOffers],
  );

  const selectedInvVaultRow = useMemo(
    () => vaultRows.find((r) => r.token.address.toLowerCase() === invToken.address.toLowerCase()),
    [vaultRows, invToken],
  );

  function openTransfer(mode: "deposit" | "withdraw", token: TokenMeta) {
    setTransferSheet({ mode, token });
    setTransferInput("");
    setTransferStep("idle");
    setTransferTxHash(null);
    setTransferError(null);
  }

  async function handleTransferSubmit() {
    if (!transferSheet || !address || !activeProvider) return;
    let parsedAmt = 0n;
    try {
      parsedAmt = parseUnits(transferInput, transferSheet.token.decimals);
    } catch {
      setTransferError("Enter a valid token amount.");
      return;
    }
    if (parsedAmt <= 0n) {
      setTransferError("Amount must be greater than zero.");
      return;
    }

    setTransferError(null);
    const walletClient = createTrancheWalletClient(activeProvider, address);
    const { liquidityVault } = ACTIVE_NETWORK.contracts;

    try {
      if (transferSheet.mode === "deposit") {
        const allowance = await tranchePublicClient.readContract({
          address: transferSheet.token.address,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, liquidityVault],
        });
        if (allowance < parsedAmt) {
          setTransferStep("approving");
          const approveHash = await walletClient.writeContract({
            address: transferSheet.token.address,
            abi: erc20Abi,
            functionName: "approve",
            args: [liquidityVault, parsedAmt],
          });
          await tranchePublicClient.waitForTransactionReceipt({ hash: approveHash });
        }

        setTransferStep("sending");
        const hash = await walletClient.writeContract({
          address: liquidityVault,
          abi: LIQUIDITY_VAULT_ABI,
          functionName: "deposit",
          args: [transferSheet.token.address, parsedAmt],
        });
        await tranchePublicClient.waitForTransactionReceipt({ hash });
        setTransferTxHash(hash);
      } else {
        setTransferStep("sending");
        const hash = await walletClient.writeContract({
          address: liquidityVault,
          abi: LIQUIDITY_VAULT_ABI,
          functionName: "withdrawFree",
          args: [transferSheet.token.address, parsedAmt, address],
        });
        await tranchePublicClient.waitForTransactionReceipt({ hash });
        setTransferTxHash(hash);
      }

      setTransferStep("done");
      loadVaultData(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Transaction failed or rejected.";
      setTransferError(msg.length > 140 ? `${msg.slice(0, 140)}…` : msg);
      setTransferStep("idle");
    }
  }

  async function handleClaimProceeds(token: TokenMeta) {
    if (!address || !activeProvider || !ACTIVE_NETWORK.isLive) return;
    setClaimingToken(token.address);
    setVaultActionError(null);
    try {
      const walletClient = createTrancheWalletClient(activeProvider, address);
      const hash = await walletClient.writeContract({
        address: ACTIVE_NETWORK.contracts.liquidityVault,
        abi: LIQUIDITY_VAULT_ABI,
        functionName: "claimProceeds",
        args: [token.address, 0n, address],
      });
      await tranchePublicClient.waitForTransactionReceipt({ hash });
      loadVaultData(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Claim proceeds failed or rejected.";
      setVaultActionError(`Claim ${token.symbol} failed: ${msg.length > 150 ? `${msg.slice(0, 150)}…` : msg}`);
    } finally {
      setClaimingToken(null);
    }
  }

  async function handleCreateOffer() {
    if (!address || !activeProvider) return;
    const payMeta = getTokenMeta(ACTIVE_NETWORK.contracts.USDT);

    let initialAmount = 0n;
    let minFillAmount = 0n;
    let fixedPriceX36 = 0n;
    let minPriceX36 = 0n;
    let maxPriceX36 = 0n;

    try {
      initialAmount = parseUnits(offerAmtInput, invToken.decimals);
      minFillAmount = parseUnits(minFillInput, invToken.decimals);
      if (priceMode === "FIXED") {
        fixedPriceX36 = parseHumanPriceToX36(fixedPriceInput, invToken.decimals, payMeta.decimals);
      } else {
        minPriceX36 = parseHumanPriceToX36(minPriceInput, invToken.decimals, payMeta.decimals);
        maxPriceX36 = parseHumanPriceToX36(maxPriceInput, invToken.decimals, payMeta.decimals);
      }
    } catch {
      setOfferError("Check numeric inputs — invalid amount or price.");
      return;
    }

    if (initialAmount <= 0n || minFillAmount <= 0n || minFillAmount > initialAmount) {
      setOfferError("Min fill must be greater than 0 and ≤ offer amount.");
      return;
    }

    setOfferError(null);
    setOfferBusy(true);
    try {
      const walletClient = createTrancheWalletClient(activeProvider, address);
      const expiry = Math.floor(Date.now() / 1000) + 86_400; // 24h offer validity
      const hash = await walletClient.writeContract({
        address: ACTIVE_NETWORK.contracts.commitmentManager,
        abi: COMMITMENT_MANAGER_ABI,
        functionName: "createOffer",
        args: [
          {
            inventoryToken: invToken.address,
            paymentToken: payMeta.address,
            initialAmount,
            minFillAmount,
            expiry,
            minDuration: 60,
            maxDuration: maxLockSec,
            basePremiumBps: Number(premiumBpsInput) || 50,
            dailyPremiumBps: 0,
            priceMode: priceMode === "FIXED" ? 0 : 1,
            spreadBps: priceMode === "FLOATING" ? Number(spreadBpsInput) || 0 : 0,
            oracle:
              priceMode === "FLOATING"
                ? ACTIVE_NETWORK.contracts.oraclePriceAdapter
                : zeroAddress,
            complianceHook: zeroAddress,
            fixedPriceX36,
            minPriceX36,
            maxPriceX36,
          },
        ],
      });
      await tranchePublicClient.waitForTransactionReceipt({ hash });
      setOfferTxHash(hash);
      loadVaultData(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Create offer failed or rejected.";
      setOfferError(msg.length > 140 ? `${msg.slice(0, 140)}…` : msg);
    } finally {
      setOfferBusy(false);
    }
  }

  async function handleCancelOffer() {
    if (!cancelTarget || !address || !activeProvider || !ACTIVE_NETWORK.isLive) return;
    setCancelling(true);
    setVaultActionError(null);
    try {
      const walletClient = createTrancheWalletClient(activeProvider, address);
      const hash = await walletClient.writeContract({
        address: ACTIVE_NETWORK.contracts.commitmentManager,
        abi: COMMITMENT_MANAGER_ABI,
        functionName: "cancelOffer",
        args: [cancelTarget.offerId],
      });
      await tranchePublicClient.waitForTransactionReceipt({ hash });
      setCancelTarget(null);
      loadVaultData(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Cancel offer failed or rejected.";
      setVaultActionError(`Cancel Offer #${cancelTarget.offerId.toString()} failed: ${msg.length > 150 ? `${msg.slice(0, 150)}…` : msg}`);
      setCancelTarget(null);
    } finally {
      setCancelling(false);
    }
  }

  const activeTransferRow = transferSheet
    ? vaultRows.find(
        (r) => r.token.address.toLowerCase() === transferSheet.token.address.toLowerCase(),
      )
    : null;

  return (
    <AppShell
      activeRoute="/vault"
      title="Liquidity Vault"
      subtitle="Segregated ERC-20 deposits, LP offers & proceeds"
      onNavigate={onNavigate}
      onRefresh={() => loadVaultData(true)}
      refreshing={refreshing}
      headerActions={
        isConnected && ACTIVE_NETWORK.isLive && (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setOfferError(null);
              setOfferTxHash(null);
              setCreateOpen(true);
            }}
            className="h-9 rounded-full px-4 text-xs font-medium cursor-pointer"
          >
            <Plus data-icon="inline-start" />
            Create Offer
          </Button>
        )
      }
    >
      {!isConnected ? (
        <div className="mx-auto flex max-w-[540px] flex-col gap-6 py-12 text-center">
          <div className="rounded-[24px] border border-dashed border-border/90 bg-card/40 px-8 py-12">
            <span className="tabular-nums-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              INV-1 Segregated Vault · Wallet Required
            </span>
            <h2 className="mt-2 font-display text-2xl font-semibold tracking-[-0.03em]">
              Connect wallet to manage liquidity
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Deposit ERC-20 inventory into isolated buckets, publish fixed or oracle-bounded
              offers, and claim upfront hold fees.
            </p>
            <div className="mt-6 grid grid-cols-3 gap-2 border-t border-dashed border-border/80 pt-5 text-left text-[11px]">
              <div>
                <span className="tabular-nums-mono text-[10px] text-muted-foreground">01</span>
                <p className="font-medium text-foreground">Deposit Free</p>
              </div>
              <div>
                <span className="tabular-nums-mono text-[10px] text-muted-foreground">02</span>
                <p className="font-medium text-foreground">Quote Offers</p>
              </div>
              <div>
                <span className="tabular-nums-mono text-[10px] text-muted-foreground">03</span>
                <p className="font-medium text-foreground">Claim Proceeds</p>
              </div>
            </div>
            <Button
              type="button"
              onClick={() => onNavigate("/connect")}
              className="mt-7 h-10 rounded-full px-6 text-xs font-medium cursor-pointer"
            >
              Connect Wallet
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {vaultActionError && (
            <div className="flex items-start justify-between gap-3 rounded-[14px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive">
              <div className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                <span>{vaultActionError}</span>
              </div>
              <button
                type="button"
                onClick={() => setVaultActionError(null)}
                className="shrink-0 underline underline-offset-4 cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Contextual 3-step LP Onboarding Strip (auto-ticks live) */}
          {showOnboarding && (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-full border border-border/80 bg-card/60 px-5 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-muted-foreground">
                <span className="font-medium text-foreground">LP flow:</span>
                <span className={cn(hasDeposited && "text-foreground")}>
                  <strong className="tabular-nums-mono">01</strong> Deposit inventory{" "}
                  {hasDeposited && <Check className="inline size-3 text-status-live" />}
                </span>
                <span className={cn(hasActiveOffer && "text-foreground")}>
                  <strong className="tabular-nums-mono">02</strong> Create an offer{" "}
                  {hasActiveOffer && <Check className="inline size-3 text-status-live" />}
                </span>
                <span>
                  <strong className="tabular-nums-mono">03</strong> Claim premiums &amp; proceeds
                </span>
              </div>
              <button
                type="button"
                aria-label="Dismiss LP flow"
                onClick={() => {
                  localStorage.setItem("tranche-lp-tip-dismissed", "1");
                  setShowOnboarding(false);
                }}
                className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}

          {/* Editorial INV-1 Segregated Vault Hairline Strip */}
          <section className="grid grid-cols-2 gap-y-5 border-b border-border/80 pb-7 lg:grid-cols-4 lg:divide-x lg:divide-border/80">
            <div className="flex flex-col gap-1 pr-5">
              <span className="tabular-nums-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                01 · Solvency Invariant
              </span>
              <span className="font-display text-2xl font-bold tracking-[-0.03em] text-foreground">
                INV-1 Segregated
              </span>
              <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                5 isolated token buckets
              </span>
            </div>
            <div className="flex flex-col gap-1 lg:px-6">
              <span className="tabular-nums-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                02 · Vault Free Assets
              </span>
              <span className="tabular-nums-mono font-display text-3xl font-bold tracking-[-0.04em] text-foreground">
                {vaultRows.filter((r) => r.freeBal > 0n).length}
              </span>
              <span className="text-[11px] text-muted-foreground">Withdrawable anytime</span>
            </div>
            <div className="flex flex-col gap-1 pr-5 lg:px-6">
              <span className="tabular-nums-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                03 · Claimable Proceeds
              </span>
              <span className="tabular-nums-mono font-display text-3xl font-bold tracking-[-0.04em] text-status-live">
                {vaultRows.filter((r) => r.pendingProceeds > 0n).length}
              </span>
              <span className="text-[11px] text-muted-foreground">Upfront premiums + fills</span>
            </div>
            <div className="flex flex-col gap-1 lg:pl-6">
              <span className="tabular-nums-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                04 · Active LP Offers
              </span>
              <span className="tabular-nums-mono font-display text-3xl font-bold tracking-[-0.04em] text-foreground">
                {myOffers.filter((o) => o.status === 0 && o.availableBalance > 0n).length}
              </span>
              <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                {myOffers.length} total created
              </span>
            </div>
          </section>

          {/* Asymmetric 7/5 Split: Hairline Asset Ledger (Left) + Serrated LP Offer Stubs (Right) */}
          <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-12">
            {/* Section 1: Clean Hairline Asset Ledger */}
            <section className="flex flex-col gap-4 lg:col-span-7">
              <div className="flex items-baseline justify-between border-b border-border pb-3">
                <h2 className="font-display text-xl font-semibold tracking-[-0.03em] text-foreground">
                  Vault Balances
                </h2>
                <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                  Multicall3 live state
                </span>
              </div>

              {loading ? (
                <div className="flex flex-col divide-y divide-border">
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="flex items-center justify-between py-4">
                      <Skeleton className="h-5 w-28" />
                      <Skeleton className="h-8 w-40 rounded-full" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="divide-y divide-border/80">
                  {vaultRows.map((row) => (
                    <div
                      key={row.token.address}
                      className="flex flex-col justify-between gap-4 py-4 sm:flex-row sm:items-center"
                    >
                      <div className="flex flex-col">
                        <span className="font-display text-base font-semibold text-foreground">
                          {row.token.symbol}
                        </span>
                        <span className="text-[11px] text-muted-foreground">{row.token.name}</span>
                      </div>

                      <div className="grid grid-cols-3 gap-5 text-xs sm:text-right">
                        <div className="flex flex-col">
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Wallet
                          </span>
                          <span className="tabular-nums-mono font-medium text-muted-foreground">
                            {formatTokenAmount(row.walletBal, row.token.decimals)}
                          </span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Vault Free
                          </span>
                          <span className="tabular-nums-mono font-semibold text-foreground">
                            {formatTokenAmount(row.freeBal, row.token.decimals)}
                          </span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Proceeds
                          </span>
                          <span className="tabular-nums-mono font-semibold text-status-live">
                            {formatTokenAmount(row.pendingProceeds, row.token.decimals)}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                        <button
                          type="button"
                          onClick={() => openTransfer("deposit", row.token)}
                          className="inline-flex h-8 items-center gap-1 rounded-full border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:border-foreground/30 cursor-pointer"
                        >
                          <ArrowDownToLine className="size-3" />
                          Deposit
                        </button>
                        {row.freeBal > 0n && (
                          <button
                            type="button"
                            onClick={() => openTransfer("withdraw", row.token)}
                            className="inline-flex h-8 items-center gap-1 rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
                          >
                            <ArrowUpFromLine className="size-3" />
                            Withdraw
                          </button>
                        )}
                        {row.pendingProceeds > 0n && (
                          <Button
                            type="button"
                            size="sm"
                            disabled={isWrongNetwork || claimingToken === row.token.address}
                            onClick={() => handleClaimProceeds(row.token)}
                            className="h-8 rounded-full px-3 text-xs font-medium cursor-pointer"
                          >
                            {claimingToken === row.token.address ? "Claiming…" : "Claim"}
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Section 2: Mini Serrated LP Offer Stubs */}
            <aside className="flex flex-col gap-4 lg:sticky lg:top-24 lg:col-span-5">
              <div className="flex items-baseline justify-between border-b border-border pb-3">
                <h2 className="font-display text-xl font-semibold tracking-[-0.03em] text-foreground">
                  Your LP Offers
                </h2>
                <span className="tabular-nums-mono text-xs text-muted-foreground">
                  {myOffers.length} total
                </span>
              </div>

              {myOffers.length === 0 ? (
                <div className="flex flex-col items-center gap-3 rounded-[20px] border border-dashed border-border px-6 py-14 text-center">
                  <p className="text-sm font-medium text-foreground">No LP offers created yet</p>
                  <p className="max-w-xs text-xs text-muted-foreground">
                    Deposit inventory on the left, then click Create Offer to publish live
                    liquidity on the Trade Desk.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {myOffers.map((o) => {
                    const inv = getTokenMeta(o.inventoryToken);
                    const pay = getTokenMeta(o.paymentToken);
                    const isFixed = o.priceMode === 0;
                    const isActive = o.status === 0 && o.availableBalance > 0n;
                    const bg = isFixed ? "#f8f7ee" : "#121210";
                    const fg = isFixed ? "#050505" : "#f8f7ee";
                    const muted = isFixed ? "rgba(5,5,5,0.58)" : "rgba(248,247,238,0.56)";
                    const hairline = isFixed ? "rgba(5,5,5,0.14)" : "rgba(248,247,238,0.14)";

                    return (
                      <div
                        key={o.offerId.toString()}
                        className="flex flex-col drop-shadow-[0_18px_40px_rgba(0,0,0,0.55)]"
                      >
                        <div
                          className="relative flex flex-col gap-3 rounded-t-[18px] px-5 pt-5 pb-4"
                          style={{
                            backgroundColor: bg,
                            color: fg,
                            borderTop: isFixed ? "none" : "1px solid rgba(248,247,238,0.12)",
                            borderLeft: isFixed ? "none" : "1px solid rgba(248,247,238,0.08)",
                            borderRight: isFixed ? "none" : "1px solid rgba(248,247,238,0.08)",
                          }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-display text-base font-bold tracking-[-0.02em]">
                              Offer #{o.offerId.toString()} · {inv.symbol} / {pay.symbol}
                            </span>
                            <span
                              className="tabular-nums-mono rounded-full px-2.5 py-0.5 text-[10px] font-semibold"
                              style={{ border: `1px solid ${hairline}`, color: fg }}
                            >
                              {o.status === 2 ? "CANCELLED" : isActive ? "ACTIVE" : "EMPTY"}
                            </span>
                          </div>

                          <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                            <span className="tabular-nums-mono font-semibold">
                              {formatTokenAmount(o.availableBalance, inv.decimals)} {inv.symbol}
                            </span>
                            <span className="tabular-nums-mono" style={{ color: muted }}>
                              {isFixed
                                ? `${formatPriceX36(o.fixedPriceX36, inv.decimals, pay.decimals)} ${pay.symbol}`
                                : `Oracle ${o.spreadBps >= 0 ? "+" : ""}${o.spreadBps} bps`}{" "}
                              · {(o.basePremiumBps / 100).toFixed(2)}% · max{" "}
                              {formatDuration(o.maxDuration)}
                            </span>
                          </div>

                          {isActive && (
                            <div
                              className="mt-1 flex justify-end border-t border-dashed pt-3"
                              style={{ borderColor: hairline }}
                            >
                              <button
                                type="button"
                                onClick={() => setCancelTarget(o)}
                                className="h-7 rounded-full border border-red-500/40 px-3 text-[11px] font-medium text-red-500 transition-colors hover:bg-red-500/10 cursor-pointer"
                              >
                                Cancel Offer
                              </button>
                            </div>
                          )}
                        </div>
                        <svg
                          viewBox="0 0 440 24"
                          preserveAspectRatio="none"
                          aria-hidden="true"
                          className="block h-3.5 w-full -mt-[2px]"
                        >
                          <polygon
                            points="0,0 440,0 440,24 330,4 220,24 110,4 0,24"
                            style={{ fill: bg }}
                          />
                        </svg>
                      </div>
                    );
                  })}
                </div>
              )}
            </aside>
          </div>
        </div>
      )}

      {/* Slide-Over Deposit / Withdraw Sheet */}
      <Sheet open={transferSheet !== null} onOpenChange={(open) => !open && setTransferSheet(null)}>
        <SheetContent className="flex w-full flex-col justify-between border-l border-border bg-card px-6 py-6 sm:max-w-[420px]">
          {transferSheet && (
            <>
              <div className="flex flex-col gap-6">
                <SheetHeader className="p-0 text-left">
                  <span className="tabular-nums-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    LiquidityVault · {transferSheet.token.symbol}
                  </span>
                  <SheetTitle className="font-display text-2xl font-semibold">
                    {transferSheet.mode === "deposit" ? "Deposit" : "Withdraw"}{" "}
                    {transferSheet.token.symbol}
                  </SheetTitle>
                  <SheetDescription className="text-xs text-muted-foreground">
                    {transferSheet.mode === "deposit"
                      ? "Credits your segregated LP free balance (withdrawable anytime)."
                      : "Withdraws uncommitted free inventory straight to your wallet."}
                  </SheetDescription>
                </SheetHeader>

                {transferStep === "done" && transferTxHash ? (
                  <div className="animate-rise flex flex-col items-center gap-4 rounded-[20px] border border-border bg-background p-7 text-center">
                    <span className="flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="size-5" />
                    </span>
                    <h3 className="font-display text-xl font-semibold">
                      {transferSheet.mode === "deposit"
                        ? "Deposit Confirmed"
                        : "Withdrawal Confirmed"}
                    </h3>
                    <a
                      href={explorerTxUrl(transferTxHash)}
                      target="_blank"
                      rel="noreferrer"
                      className="tabular-nums-mono inline-flex items-center gap-1 text-xs text-foreground underline underline-offset-4"
                    >
                      View on Blockscout
                      <ArrowUpRight className="size-3.5" />
                    </a>
                    <Button
                      type="button"
                      onClick={() => setTransferSheet(null)}
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
                          htmlFor="vault-amt"
                          className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
                        >
                          {transferSheet.mode === "deposit" ? "Deposit Size" : "Withdraw Size"}
                        </label>
                        {activeTransferRow && (
                          <button
                            type="button"
                            onClick={() => {
                              const maxRaw =
                                transferSheet.mode === "deposit"
                                  ? activeTransferRow.walletBal
                                  : activeTransferRow.freeBal;
                              setTransferInput(
                                formatTokenAmount(
                                  maxRaw,
                                  transferSheet.token.decimals,
                                  6,
                                ).replace(/,/g, ""),
                              );
                            }}
                            className="tabular-nums-mono rounded-full border border-border px-2.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground cursor-pointer"
                          >
                            Max{" "}
                            {formatTokenAmount(
                              transferSheet.mode === "deposit"
                                ? activeTransferRow.walletBal
                                : activeTransferRow.freeBal,
                              transferSheet.token.decimals,
                              4,
                            )}
                          </button>
                        )}
                      </div>
                      <div className="flex items-baseline justify-between gap-2 border-b border-border/90 pb-2 transition-colors focus-within:border-foreground">
                        <input
                          id="vault-amt"
                          type="text"
                          inputMode="decimal"
                          value={transferInput}
                          onChange={(e) => setTransferInput(e.target.value)}
                          placeholder="0.02"
                          className="tabular-nums-mono w-full bg-transparent font-display text-3xl font-bold tracking-[-0.04em] text-foreground placeholder:text-muted-foreground/35 focus:outline-none"
                        />
                        <span className="tabular-nums-mono shrink-0 text-sm font-medium text-muted-foreground">
                          {transferSheet.token.symbol}
                        </span>
                      </div>
                    </div>

                    {transferError && (
                      <div className="relative overflow-hidden rounded-[12px] border border-destructive/35 bg-[#190a0a] py-2.5 pl-4 pr-3.5 text-xs text-destructive">
                        <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-destructive" />
                        <span>{transferError}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {transferStep !== "done" && (
                <div className="pt-4">
                  <Button
                    type="button"
                    size="lg"
                    disabled={
                      isWrongNetwork ||
                      transferStep === "approving" ||
                      transferStep === "sending"
                    }
                    onClick={handleTransferSubmit}
                    className="h-12 w-full rounded-full text-sm font-medium cursor-pointer"
                  >
                    {transferStep === "approving" ? (
                      <>
                        <Loader2 className="animate-spin" data-icon="inline-start" />
                        1/2 · Approving {transferSheet.token.symbol}…
                      </>
                    ) : transferStep === "sending" ? (
                      <>
                        <Loader2 className="animate-spin" data-icon="inline-start" />
                        Confirming…
                      </>
                    ) : transferSheet.mode === "deposit" ? (
                      `Approve & Deposit ${transferSheet.token.symbol}`
                    ) : (
                      `Withdraw ${transferSheet.token.symbol}`
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Slide-Over Create Offer Sheet (Progressive Disclosure: FIXED default -> FLOATING) */}
      <Sheet open={createOpen} onOpenChange={setCreateOpen}>
        <SheetContent className="flex w-full flex-col justify-between overflow-y-auto border-l border-border bg-card px-6 py-6 sm:max-w-[460px]">
          <div className="flex flex-col gap-6">
            <SheetHeader className="p-0 text-left">
              <span className="tabular-nums-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                CommitmentManager · New LP Offer
              </span>
              <SheetTitle className="font-display text-2xl font-semibold">Create Offer</SheetTitle>
              <SheetDescription className="text-xs text-muted-foreground">
                Allocates from your Vault Free balance onto the live Trade Desk (quoted in {PAYMENT_TOKEN.symbol}).
              </SheetDescription>
            </SheetHeader>

            {offerTxHash ? (
              <div className="animate-rise flex flex-col items-center gap-4 rounded-[20px] border border-border bg-background p-7 text-center">
                <span className="flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check className="size-5" />
                </span>
                <h3 className="font-display text-xl font-semibold">Offer Live on Trade Desk</h3>
                <a
                  href={explorerTxUrl(offerTxHash)}
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
                    setCreateOpen(false);
                    onNavigate("/trade");
                  }}
                  className="mt-2 h-10 w-full rounded-full text-xs cursor-pointer"
                >
                  View on Trade Desk
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {/* Inventory Token Pills */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Inventory Asset</span>
                    <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                      Free:{" "}
                      {selectedInvVaultRow
                        ? formatTokenAmount(selectedInvVaultRow.freeBal, invToken.decimals, 4)
                        : "0"}{" "}
                      {invToken.symbol}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    {INVENTORY_TOKENS.map((t) => (
                      <button
                        key={t.address}
                        type="button"
                        onClick={() => setInvToken(t)}
                        className={cn(
                          "h-9 flex-1 rounded-full text-xs font-medium transition-colors cursor-pointer",
                          invToken.address === t.address
                            ? "bg-primary text-primary-foreground"
                            : "border border-border bg-background text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {t.symbol}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Amount & Min Fill (Hairline Instrument Fields) */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1">
                    <label className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                      Offer Size ({invToken.symbol})
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={offerAmtInput}
                      onChange={(e) => setOfferAmtInput(e.target.value)}
                      className="tabular-nums-mono h-10 w-full border-b border-border/90 bg-transparent px-0.5 text-lg font-semibold text-foreground transition-colors focus:border-foreground focus:outline-none"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                      Min Fill
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={minFillInput}
                      onChange={(e) => setMinFillInput(e.target.value)}
                      className="tabular-nums-mono h-10 w-full border-b border-border/90 bg-transparent px-0.5 text-lg font-semibold text-foreground transition-colors focus:border-foreground focus:outline-none"
                    />
                  </div>
                </div>

                {/* Price Mode Segmented Pill (Polarity Preview) */}
                <div className="flex flex-col gap-2">
                  <span className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                    Pricing Stock
                  </span>
                  <div className="grid grid-cols-2 gap-1 rounded-full border border-border bg-background p-1">
                    {(["FIXED", "FLOATING"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setPriceMode(m)}
                        className={cn(
                          "h-9 rounded-full text-xs font-medium transition-colors cursor-pointer",
                          priceMode === m
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {m === "FIXED" ? "Fixed Paper" : "Floating Vellum"}
                      </button>
                    ))}
                  </div>
                </div>

                {priceMode === "FIXED" ? (
                  <div className="flex flex-col gap-1">
                    <label className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                      Fixed Strike ({PAYMENT_TOKEN.symbol} per 1 {invToken.symbol})
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={fixedPriceInput}
                      onChange={(e) => setFixedPriceInput(e.target.value)}
                      className="tabular-nums-mono h-10 w-full border-b border-border/90 bg-transparent px-0.5 text-lg font-semibold text-foreground transition-colors focus:border-foreground focus:outline-none"
                    />
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-3">
                    <div className="flex flex-col gap-1">
                      <label className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                        Spread (bps)
                      </label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={spreadBpsInput}
                        onChange={(e) => setSpreadBpsInput(e.target.value)}
                        className="tabular-nums-mono h-9 w-full border-b border-border/90 bg-transparent px-0.5 text-sm font-semibold text-foreground transition-colors focus:border-foreground focus:outline-none"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                        Min Price
                      </label>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={minPriceInput}
                        onChange={(e) => setMinPriceInput(e.target.value)}
                        className="tabular-nums-mono h-9 w-full border-b border-border/90 bg-transparent px-0.5 text-sm font-semibold text-foreground transition-colors focus:border-foreground focus:outline-none"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                        Max Price
                      </label>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={maxPriceInput}
                        onChange={(e) => setMaxPriceInput(e.target.value)}
                        className="tabular-nums-mono h-9 w-full border-b border-border/90 bg-transparent px-0.5 text-sm font-semibold text-foreground transition-colors focus:border-foreground focus:outline-none"
                      />
                    </div>
                  </div>
                )}

                <div className="border-t border-dashed border-border/90" />

                {/* Upfront Premium & Max Lock */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1">
                    <label className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                      Upfront Premium (bps)
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={premiumBpsInput}
                      onChange={(e) => setPremiumBpsInput(e.target.value)}
                      className="tabular-nums-mono h-10 w-full border-b border-border/90 bg-transparent px-0.5 text-lg font-semibold text-foreground transition-colors focus:border-foreground focus:outline-none"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                      Max Lock Window
                    </span>
                    <div className="flex h-10 items-center gap-1">
                      {[
                        { label: "30m", sec: 1800 },
                        { label: "1h", sec: 3600 },
                        { label: "24h", sec: 86400 },
                      ].map((d) => (
                        <button
                          key={d.label}
                          type="button"
                          onClick={() => setMaxLockSec(d.sec)}
                          className={cn(
                            "tabular-nums-mono h-8 flex-1 rounded-full text-xs font-medium transition-colors cursor-pointer",
                            maxLockSec === d.sec
                              ? "bg-primary text-primary-foreground"
                              : "border border-border bg-background/60 text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {d.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {offerError && (
                  <div className="relative overflow-hidden rounded-[12px] border border-destructive/35 bg-[#190a0a] py-2.5 pl-4 pr-3.5 text-xs text-destructive">
                    <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-destructive" />
                    <span>{offerError}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {!offerTxHash && (
            <div className="pt-6">
              <Button
                type="button"
                size="lg"
                disabled={isWrongNetwork || offerBusy}
                onClick={handleCreateOffer}
                className="h-12 w-full rounded-full text-sm font-medium cursor-pointer"
              >
                {offerBusy ? (
                  <>
                    <Loader2 className="animate-spin" data-icon="inline-start" />
                    Publishing Offer…
                  </>
                ) : (
                  `Publish ${invToken.symbol} / ${PAYMENT_TOKEN.symbol} Offer`
                )}
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Destructive Confirmation Dialog for Cancel Offer */}
      <Dialog open={cancelTarget !== null} onOpenChange={(open) => !open && setCancelTarget(null)}>
        <DialogContent className="rounded-[22px] border-border bg-card sm:max-w-[400px]">
          {cancelTarget && (
            <>
              <DialogHeader>
                <DialogTitle className="font-display text-xl">
                  Cancel Offer #{cancelTarget.offerId.toString()}?
                </DialogTitle>
                <DialogDescription className="text-xs leading-relaxed text-muted-foreground">
                  Uncommitted inventory returns immediately to your Vault Free balance. Existing
                  active tickets remain unaffected until exercised or expired.
                </DialogDescription>
              </DialogHeader>
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setCancelTarget(null)}
                  className="h-10 rounded-full px-5 text-xs cursor-pointer"
                >
                  Keep Open
                </Button>
                <Button
                  type="button"
                  disabled={cancelling}
                  onClick={handleCancelOffer}
                  className="h-10 rounded-full bg-destructive px-5 text-xs text-destructive-foreground hover:bg-destructive/90 cursor-pointer"
                >
                  {cancelling ? "Cancelling…" : "Confirm Cancel"}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
