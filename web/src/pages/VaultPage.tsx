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
  createTrancheWalletClient,
  fetchAllOffers,
  tranchePublicClient,
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

const INVENTORY_TOKENS = TOKEN_LIST.filter(
  (t) => t.address.toLowerCase() !== ACTIVE_NETWORK.contracts.tUSDT.toLowerCase(),
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

  const loadVaultData = useCallback(
    async (isManual = false) => {
      if (!address) {
        setVaultRows([]);
        setMyOffers([]);
        setLoading(false);
        return;
      }
      if (isManual) setRefreshing(true);
      try {
        const { liquidityVault } = ACTIVE_NETWORK.contracts;
        const [rows, allOffers] = await Promise.all([
          Promise.all(
            TOKEN_LIST.map(async (token) => {
              const [walletBal, freeBal, pendingProceeds] = await Promise.all([
                tranchePublicClient.readContract({
                  address: token.address,
                  abi: erc20Abi,
                  functionName: "balanceOf",
                  args: [address],
                }),
                tranchePublicClient.readContract({
                  address: liquidityVault,
                  abi: LIQUIDITY_VAULT_ABI,
                  functionName: "lpFreeBalance",
                  args: [address, token.address],
                }),
                tranchePublicClient.readContract({
                  address: liquidityVault,
                  abi: LIQUIDITY_VAULT_ABI,
                  functionName: "lpPendingProceeds",
                  args: [address, token.address],
                }),
              ]);
              return { token, walletBal, freeBal, pendingProceeds };
            }),
          ),
          fetchAllOffers(),
        ]);
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
    if (!address || !activeProvider) return;
    setClaimingToken(token.address);
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
    } catch {
      // user rejected
    } finally {
      setClaimingToken(null);
    }
  }

  async function handleCreateOffer() {
    if (!address || !activeProvider) return;
    const payMeta = getTokenMeta(ACTIVE_NETWORK.contracts.tUSDT);

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
    if (!cancelTarget || !address || !activeProvider) return;
    setCancelling(true);
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
    } catch {
      // rejected
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
        isConnected && (
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
        <div className="flex flex-col items-center gap-4 rounded-[20px] border border-border bg-card px-6 py-20 text-center">
          <h2 className="font-display text-xl font-semibold">Connect wallet to manage vault</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            Deposit ERC-20 inventory, publish fixed or oracle-bounded offers, and claim earned
            proceeds.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {/* Contextual 3-step LP Onboarding Strip (auto-ticks live) */}
          {showOnboarding && (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-[16px] border border-border bg-card px-5 py-3.5 text-xs">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-muted-foreground">
                <span className="font-medium text-foreground">LP flow:</span>
                <span className={cn(hasDeposited && "text-foreground")}>
                  <strong className="tabular-nums-mono">1.</strong> Deposit inventory{" "}
                  {hasDeposited && <Check className="inline size-3 text-status-live" />}
                </span>
                <span className={cn(hasActiveOffer && "text-foreground")}>
                  <strong className="tabular-nums-mono">2.</strong> Create an offer{" "}
                  {hasActiveOffer && <Check className="inline size-3 text-status-live" />}
                </span>
                <span>
                  <strong className="tabular-nums-mono">3.</strong> Claim premiums &amp; proceeds
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

          {/* Section 1: Token Balances Ledger */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-base font-semibold text-foreground">
                Vault Balances
              </h2>
              <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                INV-1 segregated accounting
              </span>
            </div>

            <div className="overflow-hidden rounded-[20px] border border-border bg-card">
              <div className="hidden grid-cols-12 items-center border-b border-border px-6 py-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground sm:grid">
                <span className="col-span-3">Asset</span>
                <span className="col-span-2 text-right">Wallet</span>
                <span className="col-span-2 text-right">Vault Free</span>
                <span className="col-span-2 text-right">Proceeds</span>
                <span className="col-span-3 text-right">Actions</span>
              </div>

              {loading ? (
                <div className="flex flex-col divide-y divide-border">
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="grid grid-cols-12 items-center gap-4 px-6 py-4">
                      <Skeleton className="col-span-3 h-5 w-24" />
                      <Skeleton className="col-span-2 ml-auto h-5 w-16" />
                      <Skeleton className="col-span-2 ml-auto h-5 w-16" />
                      <Skeleton className="col-span-2 ml-auto h-5 w-16" />
                      <Skeleton className="col-span-3 ml-auto h-8 w-36 rounded-full" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {vaultRows.map((row) => (
                    <div
                      key={row.token.address}
                      className="grid grid-cols-1 items-center gap-3 px-6 py-4 sm:grid-cols-12 sm:gap-2"
                    >
                      <div className="col-span-3 flex flex-col">
                        <span className="text-sm font-semibold text-foreground">
                          {row.token.symbol}
                        </span>
                        <span className="text-[11px] text-muted-foreground">{row.token.name}</span>
                      </div>

                      <div className="col-span-2 flex items-center justify-between sm:justify-end">
                        <span className="text-xs text-muted-foreground sm:hidden">Wallet</span>
                        <span className="tabular-nums-mono text-sm text-muted-foreground">
                          {formatTokenAmount(row.walletBal, row.token.decimals)}
                        </span>
                      </div>

                      <div className="col-span-2 flex items-center justify-between sm:justify-end">
                        <span className="text-xs text-muted-foreground sm:hidden">Vault Free</span>
                        <span className="tabular-nums-mono text-sm font-medium text-foreground">
                          {formatTokenAmount(row.freeBal, row.token.decimals)}
                        </span>
                      </div>

                      <div className="col-span-2 flex items-center justify-between sm:justify-end">
                        <span className="text-xs text-muted-foreground sm:hidden">Proceeds</span>
                        <span className="tabular-nums-mono text-sm font-medium text-status-live">
                          {formatTokenAmount(row.pendingProceeds, row.token.decimals)}
                        </span>
                      </div>

                      <div className="col-span-3 flex flex-wrap items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => openTransfer("deposit", row.token)}
                          className="inline-flex h-8 items-center gap-1 rounded-full border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:border-foreground/30 cursor-pointer"
                        >
                          <ArrowDownToLine className="size-3" />
                          Deposit
                        </button>
                        {row.freeBal > 0n && (
                          <button
                            type="button"
                            onClick={() => openTransfer("withdraw", row.token)}
                            className="inline-flex h-8 items-center gap-1 rounded-full border border-border bg-background px-3 text-xs text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
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
            </div>
          </section>

          {/* Section 2: Your LP Offers */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-base font-semibold text-foreground">Your Offers</h2>
              <span className="tabular-nums-mono text-xs text-muted-foreground">
                {myOffers.length} total
              </span>
            </div>

            <div className="overflow-hidden rounded-[20px] border border-border bg-card">
              {myOffers.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
                  <p className="text-sm font-medium text-foreground">No LP offers created yet</p>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    Deposit inventory above, then click Create Offer to publish live liquidity on
                    the Trade Desk.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {myOffers.map((o) => {
                    const inv = getTokenMeta(o.inventoryToken);
                    const pay = getTokenMeta(o.paymentToken);
                    const isActive = o.status === 0 && o.availableBalance > 0n;
                    return (
                      <div
                        key={o.offerId.toString()}
                        className="flex flex-col justify-between gap-3 px-6 py-4 sm:flex-row sm:items-center"
                      >
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-foreground">
                              Offer #{o.offerId.toString()} · {inv.symbol} / {pay.symbol}
                            </span>
                            <span className="tabular-nums-mono rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                              {o.status === 2 ? "CANCELLED" : isActive ? "ACTIVE" : "EMPTY"}
                            </span>
                          </div>
                          <span className="tabular-nums-mono text-xs text-muted-foreground">
                            Available: {formatTokenAmount(o.availableBalance, inv.decimals)}{" "}
                            {inv.symbol} ·{" "}
                            {o.priceMode === 0
                              ? `${formatPriceX36(o.fixedPriceX36, inv.decimals, pay.decimals)} ${pay.symbol}`
                              : `Oracle +${o.spreadBps} bps`}{" "}
                            · {(o.basePremiumBps / 100).toFixed(2)}% prem · max{" "}
                            {formatDuration(o.maxDuration)}
                          </span>
                        </div>

                        {isActive && (
                          <button
                            type="button"
                            onClick={() => setCancelTarget(o)}
                            className="h-8 w-fit rounded-full border border-destructive/30 px-3.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 cursor-pointer"
                          >
                            Cancel Offer
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
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
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between text-xs">
                        <label htmlFor="vault-amt" className="text-muted-foreground">
                          Amount ({transferSheet.token.symbol})
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
                            className="tabular-nums-mono text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
                          >
                            Max:{" "}
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
                      <Input
                        id="vault-amt"
                        type="text"
                        inputMode="decimal"
                        value={transferInput}
                        onChange={(e) => setTransferInput(e.target.value)}
                        placeholder="0.02"
                        className="tabular-nums-mono h-12 rounded-[12px] bg-background text-base"
                      />
                    </div>

                    {transferError && (
                      <div className="flex items-start gap-2 rounded-[12px] border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive">
                        <ShieldAlert className="mt-0.5 size-4 shrink-0" />
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
                Allocates from your Vault Free balance onto the live Trade Desk (quoted in tUSDT).
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

                {/* Amount & Min Fill */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs text-muted-foreground">
                      Offer Size ({invToken.symbol})
                    </label>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={offerAmtInput}
                      onChange={(e) => setOfferAmtInput(e.target.value)}
                      className="tabular-nums-mono h-11 rounded-[12px] bg-background"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs text-muted-foreground">Min Fill</label>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={minFillInput}
                      onChange={(e) => setMinFillInput(e.target.value)}
                      className="tabular-nums-mono h-11 rounded-[12px] bg-background"
                    />
                  </div>
                </div>

                {/* Price Mode Segmented Pill (Progressive Disclosure) */}
                <div className="flex flex-col gap-2">
                  <span className="text-xs text-muted-foreground">Pricing Mode</span>
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
                        {m === "FIXED" ? "Fixed Price" : "Floating Oracle"}
                      </button>
                    ))}
                  </div>
                </div>

                {priceMode === "FIXED" ? (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs text-muted-foreground">
                      Fixed Strike (tUSDT per 1 {invToken.symbol})
                    </label>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={fixedPriceInput}
                      onChange={(e) => setFixedPriceInput(e.target.value)}
                      className="tabular-nums-mono h-11 rounded-[12px] bg-background"
                    />
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-2.5">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] text-muted-foreground">Spread (bps)</label>
                      <Input
                        type="text"
                        inputMode="numeric"
                        value={spreadBpsInput}
                        onChange={(e) => setSpreadBpsInput(e.target.value)}
                        className="tabular-nums-mono h-10 rounded-[12px] bg-background text-xs"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] text-muted-foreground">Min Price</label>
                      <Input
                        type="text"
                        inputMode="decimal"
                        value={minPriceInput}
                        onChange={(e) => setMinPriceInput(e.target.value)}
                        className="tabular-nums-mono h-10 rounded-[12px] bg-background text-xs"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] text-muted-foreground">Max Price</label>
                      <Input
                        type="text"
                        inputMode="decimal"
                        value={maxPriceInput}
                        onChange={(e) => setMaxPriceInput(e.target.value)}
                        className="tabular-nums-mono h-10 rounded-[12px] bg-background text-xs"
                      />
                    </div>
                  </div>
                )}

                <Separator />

                {/* Upfront Premium & Max Lock */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs text-muted-foreground">Upfront Premium (bps)</label>
                    <Input
                      type="text"
                      inputMode="numeric"
                      value={premiumBpsInput}
                      onChange={(e) => setPremiumBpsInput(e.target.value)}
                      className="tabular-nums-mono h-11 rounded-[12px] bg-background"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground">Max Lock Window</span>
                    <div className="flex h-11 items-center gap-1">
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
                            "h-9 flex-1 rounded-full text-xs font-medium transition-colors cursor-pointer",
                            maxLockSec === d.sec
                              ? "bg-primary text-primary-foreground"
                              : "border border-border bg-background text-muted-foreground",
                          )}
                        >
                          {d.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {offerError && (
                  <div className="flex items-start gap-2 rounded-[12px] border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive">
                    <ShieldAlert className="mt-0.5 size-4 shrink-0" />
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
                  `Publish ${invToken.symbol} / tUSDT Offer`
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
