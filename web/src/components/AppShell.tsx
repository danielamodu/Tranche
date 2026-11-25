import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  Droplets,
  Loader2,
  LogOut,
  Menu,
  RefreshCw,
  ShieldAlert,
  Ticket,
  Vault,
  Wallet,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { TrancheLogo } from "@/components/TrancheLogo";
import { ACTIVE_NETWORK, explorerAddressUrl } from "@/config/networks";
import { useWallet } from "@/context/WalletContext";
import { EXECUTION_TICKET_ABI, tranchePublicClient } from "@/lib/protocol";
import { cn } from "@/lib/utils";
import type { AppRoute } from "@/App";

interface AppShellProps {
  activeRoute: "/trade" | "/tickets" | "/vault" | "/agent";
  title: string;
  subtitle?: string;
  onNavigate: (path: AppRoute) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  headerActions?: ReactNode;
  children: ReactNode;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function AppShell({
  activeRoute,
  title,
  subtitle,
  onNavigate,
  onRefresh,
  refreshing = false,
  headerActions,
  children,
}: AppShellProps) {
  const {
    wallets,
    hasInjectedFallback,
    address,
    hskBalance,
    isConnected,
    isWrongNetwork,
    connecting,
    switching,
    error,
    connect,
    switchToActiveChain,
    disconnect,
    clearError,
  } = useWallet();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [walletDialogOpen, setWalletDialogOpen] = useState(false);
  const [ticketCount, setTicketCount] = useState<number>(0);
  const [faucetState, setFaucetState] = useState<"idle" | "minting" | "done" | "error">("idle");
  const [faucetMsg, setFaucetMsg] = useState<string | null>(null);

  async function handleTestnetFaucet() {
    if (!address || ACTIVE_NETWORK.key !== "testnet") return;
    setFaucetState("minting");
    setFaucetMsg(null);
    try {
      const resp = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const data = (await resp.json()) as { ok?: boolean; error?: string };
      if (!resp.ok || !data.ok) {
        setFaucetState("error");
        setFaucetMsg(data.error ?? "Faucet unavailable");
        return;
      }
      setFaucetState("done");
      setFaucetMsg("+1,000 tUSDT & +0.5 tWETH minted");
      onRefresh?.();
    } catch {
      setFaucetState("error");
      setFaucetMsg("Faucet available on live deployment");
    }
  }

  useEffect(() => {
    if (!address) {
      setTicketCount(0);
      return;
    }
    let cancelled = false;
    tranchePublicClient
      .readContract({
        address: ACTIVE_NETWORK.contracts.executionTicket,
        abi: EXECUTION_TICKET_ABI,
        functionName: "balanceOf",
        args: [address],
      })
      .then((bal) => {
        if (!cancelled) setTicketCount(Number(bal));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [address, activeRoute, refreshing]);

  const navItems: {
    path: "/trade" | "/tickets" | "/vault" | "/agent";
    label: string;
    icon: typeof ArrowLeftRight;
    badge?: number;
  }[] = [
    { path: "/trade", label: "Trade", icon: ArrowLeftRight },
    { path: "/tickets", label: "Tickets", icon: Ticket, badge: ticketCount },
    { path: "/vault", label: "Vault", icon: Vault },
    { path: "/agent", label: "Agent", icon: Bot },
  ];

  const sidebarBody = (
    <div className="flex h-full flex-col justify-between bg-[#090908] px-3.5 py-5">
      {/* Top: Brand + Primary Desk Nav */}
      <div className="flex flex-col gap-7">
        <div className="flex items-center justify-between px-2">
          <button
            type="button"
            onClick={() => onNavigate("/")}
            aria-label="Tranche home"
            className="inline-flex items-center transition-opacity hover:opacity-80 cursor-pointer"
          >
            <TrancheLogo imgClassName="h-6" />
          </button>
          <span className="tabular-nums-mono rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
            {ACTIVE_NETWORK.chainId}
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <span className="px-2.5 pb-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Desk
          </span>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeRoute === item.path;
            return (
              <button
                key={item.path}
                type="button"
                onClick={() => {
                  setMobileOpen(false);
                  onNavigate(item.path);
                }}
                className={cn(
                  "flex h-10 w-full items-center justify-between rounded-[11px] px-3 text-sm font-medium transition-colors duration-150 cursor-pointer",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <span className="inline-flex items-center gap-2.5">
                  <Icon className="size-4" />
                  {item.label}
                </span>
                {item.badge !== undefined && item.badge > 0 && (
                  <span
                    className={cn(
                      "tabular-nums-mono rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none",
                      active
                        ? "bg-primary-foreground/15 text-primary-foreground"
                        : "bg-accent text-foreground",
                    )}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-1">
          <span className="px-2.5 pb-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Explorer
          </span>
          <a
            href={explorerAddressUrl(ACTIVE_NETWORK.contracts.liquidityVault)}
            target="_blank"
            rel="noreferrer"
            className="flex h-9 w-full items-center justify-between rounded-[10px] px-3 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <span>Blockscout Vault</span>
            <ArrowUpRight className="size-3.5" />
          </a>

          {/* Testnet-only Faucet button (automatically hidden on Mainnet 177) */}
          {ACTIVE_NETWORK.key === "testnet" && isConnected && (
            <div className="mt-2 flex flex-col gap-1.5">
              <button
                type="button"
                disabled={faucetState === "minting"}
                onClick={handleTestnetFaucet}
                className="flex h-9 w-full items-center justify-between rounded-[10px] border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:border-foreground/25 disabled:opacity-60 cursor-pointer"
              >
                <span className="inline-flex items-center gap-2">
                  {faucetState === "minting" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : faucetState === "done" ? (
                    <Check className="size-3.5 text-status-live" />
                  ) : (
                    <Droplets className="size-3.5 text-muted-foreground" />
                  )}
                  {faucetState === "minting" ? "Minting…" : "Get Test Tokens"}
                </span>
              </button>
              {faucetMsg && (
                <span
                  className={cn(
                    "px-2 text-[10px] leading-snug",
                    faucetState === "error" ? "text-destructive" : "text-status-live",
                  )}
                >
                  {faucetMsg}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Bottom: Pinned Wallet Dock (reconnects in-dashboard without leaving) */}
      <div className="flex flex-col gap-3">
        <Separator />
        {isConnected && address ? (
          <div className="flex items-center justify-between gap-2 rounded-[14px] border border-border bg-card px-3 py-2.5">
            <div className="flex min-w-0 flex-col">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
                <span className="size-1.5 shrink-0 rounded-full bg-status-live" />
                <span className="tabular-nums-mono truncate">{shortAddr(address)}</span>
              </span>
              <span className="tabular-nums-mono mt-0.5 text-[11px] text-muted-foreground">
                {hskBalance ? `${hskBalance} HSK` : `Chain ${ACTIVE_NETWORK.chainId}`}
              </span>
            </div>
            <button
              type="button"
              aria-label="Disconnect wallet"
              onClick={() => disconnect()}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
            >
              <LogOut className="size-3.5" />
            </button>
          </div>
        ) : (
          <Button
            type="button"
            onClick={() => {
              clearError();
              setWalletDialogOpen(true);
            }}
            className="h-10 w-full rounded-full text-xs font-medium cursor-pointer"
          >
            Connect Wallet
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex min-h-[100svh] bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
      {/* Desktop Fixed Sidebar */}
      <aside className="hidden w-[232px] shrink-0 border-r border-border md:fixed md:inset-y-0 md:left-0 md:block">
        {sidebarBody}
      </aside>

      {/* Mobile Drawer Overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative z-10 flex w-[256px] max-w-[82vw] flex-col border-r border-border">
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setMobileOpen(false)}
              className="absolute top-4 right-3 z-20 inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
            {sidebarBody}
          </div>
        </div>
      )}

      {/* Main Workspace Area */}
      <div className="flex min-w-0 flex-1 flex-col md:pl-[232px]">
        {/* Slim Utility Top Bar */}
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-border bg-background/85 px-5 backdrop-blur-md sm:px-8">
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
              className="inline-flex size-9 items-center justify-center rounded-lg border border-border text-foreground md:hidden"
            >
              <Menu className="size-4" />
            </button>
            <div className="flex flex-col">
              <h1 className="font-display text-lg font-semibold leading-tight tracking-[-0.03em]">
                {title}
              </h1>
              {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            {headerActions}
            {onRefresh && (
              <button
                type="button"
                aria-label="Refresh on-chain data"
                onClick={onRefresh}
                className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground cursor-pointer"
              >
                <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
              </button>
            )}
          </div>
        </header>

        {/* Wrong Network Banner */}
        {isWrongNetwork && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-6 py-3 text-xs">
            <span className="text-destructive">
              Wrong network connected. Switch to {ACTIVE_NETWORK.name} (Chain{" "}
              {ACTIVE_NETWORK.chainId}) to transact.
            </span>
            <Button
              type="button"
              size="sm"
              disabled={switching}
              onClick={switchToActiveChain}
              className="h-8 rounded-full px-4 text-xs cursor-pointer"
            >
              {switching ? "Switching…" : `Switch to Chain ${ACTIVE_NETWORK.chainId}`}
            </Button>
          </div>
        )}

        {/* Page Content */}
        <main className="mx-auto w-full max-w-[1040px] flex-1 px-5 py-8 sm:px-8">{children}</main>
      </div>

      {/* In-Dashboard Wallet Reconnect Dialog (never kicks user out of the workspace) */}
      <Dialog open={walletDialogOpen} onOpenChange={setWalletDialogOpen}>
        <DialogContent className="rounded-[24px] border-border bg-card sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Connect your wallet</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Sign in right here without leaving your workspace.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-2 flex flex-col gap-2.5">
            {wallets.length > 0 ? (
              wallets.map((w) => (
                <button
                  key={w.uuid}
                  type="button"
                  disabled={connecting}
                  onClick={async () => {
                    const ok = await connect(w.provider);
                    if (ok) setWalletDialogOpen(false);
                  }}
                  className="glass-pill glass-pill-interactive group flex min-h-[54px] w-full items-center justify-between rounded-[14px] px-4 py-2.5 text-left disabled:opacity-50 cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    {w.icon ? (
                      <img src={w.icon} alt={w.name} className="size-7 rounded-lg object-contain" />
                    ) : (
                      <span className="flex size-7 items-center justify-center rounded-lg bg-accent text-foreground">
                        <Wallet className="size-4" />
                      </span>
                    )}
                    <span className="text-sm font-medium text-foreground">{w.name}</span>
                  </div>
                  {connecting ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  ) : (
                    <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                  )}
                </button>
              ))
            ) : hasInjectedFallback ? (
              <Button
                type="button"
                disabled={connecting}
                onClick={async () => {
                  const ok = await connect();
                  if (ok) setWalletDialogOpen(false);
                }}
                className="h-11 w-full rounded-full text-xs font-medium cursor-pointer"
              >
                {connecting ? "Connecting…" : "Connect Browser Wallet"}
              </Button>
            ) : (
              <p className="rounded-[14px] border border-border bg-background/60 p-4 text-center text-xs text-muted-foreground">
                No browser wallet detected. Install MetaMask, Zerion, or Rabby.
              </p>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-[12px] border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
