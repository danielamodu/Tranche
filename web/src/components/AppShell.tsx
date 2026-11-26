import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  CreditCard,
  Droplets,
  Loader2,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
  Sun,
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
import { TrancheLogo } from "@/components/TrancheLogo";
import { ACTIVE_NETWORK, explorerAddressUrl } from "@/config/networks";
import { useWallet } from "@/context/WalletContext";
import { EXECUTION_TICKET_ABI, tranchePublicClient } from "@/lib/protocol";
import { cn } from "@/lib/utils";
import type { AppRoute } from "@/App";

interface AppShellProps {
  activeRoute:
    | "/trade"
    | "/tickets"
    | "/vault"
    | "/agent"
    | "/agent/activity"
    | "/agent/policy"
    | "/payments";
  title: string;
  subtitle?: string;
  onNavigate: (path: AppRoute) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  headerActions?: ReactNode;
  children: ReactNode;
}

const THEME_STORAGE_KEY = "tranche-theme";

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
  const [collapsed, setCollapsed] = useState(false);
  const [walletDialogOpen, setWalletDialogOpen] = useState(false);
  const [ticketCount, setTicketCount] = useState<number>(0);
  const [faucetState, setFaucetState] = useState<"idle" | "minting" | "done" | "error">("idle");
  const [faucetMsg, setFaucetMsg] = useState<string | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  });

  // Apply Dark / Light class to <html> and persist preference
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

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
    if (!address || !ACTIVE_NETWORK.isLive) {
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

  const agentNav = [
    { path: "/agent" as const, label: "Overview", icon: Bot },
    { path: "/agent/activity" as const, label: "Activity", icon: Activity },
    { path: "/agent/policy" as const, label: "Rules & Controls", icon: SlidersHorizontal },
  ];
  const protocolNav = [
    { path: "/trade" as const, label: "Trade Desk", icon: ArrowLeftRight },
    { path: "/tickets" as const, label: "Tickets", icon: Ticket, badge: ticketCount },
    { path: "/vault" as const, label: "Liquidity Vault", icon: Vault },
  ];
  const paymentsNav = [{ path: "/payments" as const, label: "HSP Payments", icon: CreditCard }];

  const sidebarWidth = collapsed ? "w-[72px]" : "w-[236px]";
  const mainPadding = collapsed ? "md:pl-[72px]" : "md:pl-[236px]";

  const sidebarBody = (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Top Brand Header + Collapse Toggle (always pinned) */}
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-sidebar-border px-4">
        <button
          type="button"
          onClick={() => onNavigate("/")}
          aria-label="Tranche home"
          className="inline-flex min-w-0 items-center gap-2 transition-opacity hover:opacity-80 cursor-pointer"
        >
          <TrancheLogo imgClassName={collapsed ? "h-5" : "h-6"} />
        </button>
        {!collapsed && (
          <button
            type="button"
            aria-label="Collapse sidebar"
            onClick={() => setCollapsed(true)}
            className="hidden size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground md:inline-flex cursor-pointer"
          >
            <PanelLeftClose className="size-4" />
          </button>
        )}
      </div>

      {/* Grouped Navigation (scrollable internally if ever needed) */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
          {/* Group 1: Autonomous Agent */}
          <div className="flex flex-col gap-1">
            {!collapsed && (
              <span className="px-2.5 pb-1 text-[11px] font-medium text-muted-foreground">
                Autonomous
              </span>
            )}
            {agentNav.map((item) => {
              const Icon = item.icon;
              const active = activeRoute === item.path;
              return (
                <button
                  key={item.path}
                  type="button"
                  title={collapsed ? item.label : undefined}
                  onClick={() => {
                    setMobileOpen(false);
                    onNavigate(item.path);
                  }}
                  className={cn(
                    "flex h-9 w-full items-center rounded-[10px] text-[13px] font-medium transition-colors duration-150 cursor-pointer",
                    collapsed ? "justify-center px-0" : "justify-between px-2.5",
                    active
                      ? "bg-sidebar-accent text-foreground shadow-[inset_0_0_0_1px_var(--border)]"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                  )}
                >
                  <span className="inline-flex items-center gap-2.5">
                    <Icon className="size-4 shrink-0" />
                    {!collapsed && <span>{item.label}</span>}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Group 2: Protocol */}
          <div className="flex flex-col gap-1">
            {!collapsed && (
              <span className="px-2.5 pb-1 text-[11px] font-medium text-muted-foreground">
                Protocol
              </span>
            )}
            {protocolNav.map((item) => {
              const Icon = item.icon;
              const active = activeRoute === item.path;
              return (
                <button
                  key={item.path}
                  type="button"
                  title={collapsed ? item.label : undefined}
                  onClick={() => {
                    setMobileOpen(false);
                    onNavigate(item.path);
                  }}
                  className={cn(
                    "flex h-9 w-full items-center rounded-[10px] text-[13px] font-medium transition-colors duration-150 cursor-pointer",
                    collapsed ? "justify-center px-0" : "justify-between px-2.5",
                    active
                      ? "bg-sidebar-accent text-foreground shadow-[inset_0_0_0_1px_var(--border)]"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                  )}
                >
                  <span className="inline-flex items-center gap-2.5">
                    <Icon className="size-4 shrink-0" />
                    {!collapsed && <span>{item.label}</span>}
                  </span>
                  {!collapsed && item.badge !== undefined && item.badge > 0 && (
                    <span className="tabular-nums-mono rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Group 3: Independent HSP Payments */}
          <div className="flex flex-col gap-1">
            {!collapsed && (
              <span className="px-2.5 pb-1 text-[11px] font-medium text-muted-foreground">
                Payments
              </span>
            )}
            {paymentsNav.map((item) => {
              const Icon = item.icon;
              const active = activeRoute === item.path;
              return (
                <button
                  key={item.path}
                  type="button"
                  title={collapsed ? item.label : undefined}
                  onClick={() => {
                    setMobileOpen(false);
                    onNavigate(item.path);
                  }}
                  className={cn(
                    "flex h-9 w-full items-center rounded-[10px] text-[13px] font-medium transition-colors duration-150 cursor-pointer",
                    collapsed ? "justify-center px-0" : "justify-between px-2.5",
                    active
                      ? "bg-sidebar-accent text-foreground shadow-[inset_0_0_0_1px_var(--border)]"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                  )}
                >
                  <span className="inline-flex items-center gap-2.5">
                    <Icon className="size-4 shrink-0" />
                    {!collapsed && <span>{item.label}</span>}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Group 3: System / Resources */}
          <div className="flex flex-col gap-1">
            {!collapsed && (
              <span className="px-2.5 pb-1 text-[11px] font-medium text-muted-foreground">
                Resources
              </span>
            )}
            <button
              type="button"
              title={collapsed ? "Documentation" : undefined}
              onClick={() => {
                setMobileOpen(false);
                onNavigate("/docs");
              }}
              className={cn(
                "flex h-9 w-full items-center rounded-[10px] text-[13px] font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground cursor-pointer",
                collapsed ? "justify-center px-0" : "justify-between px-2.5",
              )}
            >
              <span className="inline-flex items-center gap-2.5">
                <BookOpen className="size-4 shrink-0" />
                {!collapsed && <span>Documentation</span>}
              </span>
            </button>
            <a
              href={
                ACTIVE_NETWORK.isLive
                  ? explorerAddressUrl(ACTIVE_NETWORK.contracts.liquidityVault)
                  : ACTIVE_NETWORK.explorerUrl
              }
              target="_blank"
              rel="noreferrer"
              title={collapsed ? "Blockscout Explorer" : undefined}
              className={cn(
                "flex h-9 w-full items-center rounded-[10px] text-[13px] font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground",
                collapsed ? "justify-center px-0" : "justify-between px-2.5",
              )}
            >
              <span className="inline-flex items-center gap-2.5">
                <ArrowUpRight className="size-4 shrink-0" />
                {!collapsed && (
                  <span>{ACTIVE_NETWORK.isLive ? "Blockscout Vault" : "Blockscout"}</span>
                )}
              </span>
            </a>

            {ACTIVE_NETWORK.key === "testnet" && isConnected && !collapsed && (
              <div className="mt-2 flex flex-col gap-1.5 px-1">
                <button
                  type="button"
                  disabled={faucetState === "minting"}
                  onClick={handleTestnetFaucet}
                  className="flex h-8 w-full items-center justify-center gap-2 rounded-[10px] border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60 cursor-pointer"
                >
                  {faucetState === "minting" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : faucetState === "done" ? (
                    <Check className="size-3.5 text-status-live" />
                  ) : (
                    <Droplets className="size-3.5 text-muted-foreground" />
                  )}
                  <span>{faucetState === "minting" ? "Minting…" : "Get Test Tokens"}</span>
                </button>
                {faucetMsg && (
                  <span
                    className={cn(
                      "px-1 text-[10px] leading-snug",
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

      {/* Bottom: Expand button only when collapsed */}
      {collapsed && (
        <div className="shrink-0 border-t border-sidebar-border p-3">
          <button
            type="button"
            aria-label="Expand sidebar"
            onClick={() => setCollapsed(false)}
            className="mx-auto flex size-9 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground cursor-pointer"
          >
            <PanelLeftOpen className="size-4" />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex min-h-[100svh] bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
      {/* Desktop Fixed Left Sidebar */}
      <aside
        className={cn(
          "hidden shrink-0 border-r border-sidebar-border transition-[width] duration-200 md:fixed md:inset-y-0 md:left-0 md:z-40 md:block",
          sidebarWidth,
        )}
      >
        {sidebarBody}
      </aside>

      {/* Mobile Drawer Overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-xs"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative z-10 flex w-[256px] max-w-[82vw] flex-col border-r border-sidebar-border">
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
      <div className={cn("flex min-w-0 flex-1 flex-col transition-[padding] duration-200", mainPadding)}>
        {/* Vestra-Grade Breadcrumb Top Bar + Dark/Light Toggle */}
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-border bg-card/90 px-5 backdrop-blur-md sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-border bg-background text-foreground md:hidden"
            >
              <Menu className="size-4" />
            </button>

            {/* Breadcrumb Trail */}
            <div className="flex min-w-0 flex-col">
              <div className="flex items-center gap-1.5 text-sm">
                <span className="hidden text-muted-foreground sm:inline">Dashboard</span>
                <ChevronRight className="hidden size-3.5 text-muted-foreground/70 sm:inline" />
                <h1 className="truncate font-display text-sm font-semibold tracking-[-0.02em] text-foreground sm:text-[15px]">
                  {title}
                </h1>
              </div>
              {subtitle && (
                <span className="tabular-nums-mono truncate text-[11px] text-muted-foreground">
                  {subtitle}
                </span>
              )}
            </div>
          </div>

          {/* Right Utility Cluster: Actions + Network Chip + Dark/Light Toggle + Refresh */}
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}

            <span className="tabular-nums-mono hidden items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] text-muted-foreground lg:inline-flex">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  ACTIVE_NETWORK.isLive ? "bg-status-live" : "bg-amber-400",
                )}
              />
              {ACTIVE_NETWORK.chainId === 133
                ? "Chain 133 — Testnet"
                : ACTIVE_NETWORK.chainId === 177
                  ? "Chain 177 — Mainnet (Read-Only)"
                  : `Chain ${ACTIVE_NETWORK.chainId}`}
            </span>

            {isConnected && address ? (
              <div className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-background pl-3 pr-1.5 text-xs">
                <span className="size-1.5 shrink-0 rounded-full bg-status-live" />
                <span className="tabular-nums-mono font-medium text-foreground">
                  {shortAddr(address)}
                </span>
                {hskBalance && (
                  <span className="tabular-nums-mono hidden text-[11px] text-muted-foreground xl:inline">
                    · {hskBalance} HSK
                  </span>
                )}
                <button
                  type="button"
                  aria-label="Disconnect wallet"
                  title="Disconnect wallet"
                  onClick={() => disconnect()}
                  className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
                >
                  <LogOut className="size-3" />
                </button>
              </div>
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  clearError();
                  setWalletDialogOpen(true);
                }}
                className="h-9 rounded-full px-3.5 text-xs font-medium cursor-pointer"
              >
                <Wallet className="mr-1.5 size-3.5" />
                Connect
              </Button>
            )}

            <button
              type="button"
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              title={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
              onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
              className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground cursor-pointer"
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>

            {onRefresh && (
              <button
                type="button"
                aria-label="Refresh data"
                onClick={onRefresh}
                className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground cursor-pointer"
              >
                <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
              </button>
            )}
          </div>
        </header>

        {/* Mainnet Deployment Pending Banner */}
        {!ACTIVE_NETWORK.isLive && !activeRoute.startsWith("/agent") && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-6 py-2.5 text-xs text-amber-700 dark:text-amber-200">
            <span>
              {ACTIVE_NETWORK.name} (Chain {ACTIVE_NETWORK.chainId}) protocol contracts are not yet
              deployed. On-chain reads and transactions are disabled to prevent zero-address calls.
            </span>
          </div>
        )}

        {/* Wrong Network Banner */}
        {isWrongNetwork && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-6 py-2.5 text-xs">
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

        {/* Page Content — Full-width flush with header & sidebar */}
        <main className="w-full flex-1 px-6 py-6 lg:px-8">{children}</main>
      </div>

      {/* In-Dashboard Wallet Reconnect Dialog */}
      <Dialog open={walletDialogOpen} onOpenChange={setWalletDialogOpen}>
        <DialogContent className="rounded-[20px] border-border bg-card sm:max-w-[420px]">
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
                  className="group flex min-h-[54px] w-full items-center justify-between rounded-[14px] border border-border bg-background px-4 py-2.5 text-left transition-colors hover:bg-accent disabled:opacity-50 cursor-pointer"
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
              <p className="rounded-[14px] border border-border bg-background p-4 text-center text-xs text-muted-foreground">
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
