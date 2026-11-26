import { useEffect } from "react";
import { ArrowLeft, ArrowRight, Check, Loader2, ShieldAlert, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { TrancheLogo } from "@/components/TrancheLogo";
import { ACTIVE_NETWORK } from "@/config/networks";
import { useWallet } from "@/context/WalletContext";
import type { AppRoute } from "@/App";

interface ConnectWalletPageProps {
  onNavigate: (path: AppRoute) => void;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function ConnectWalletPage({ onNavigate }: ConnectWalletPageProps) {
  const {
    wallets,
    hasInjectedFallback,
    address,
    chainId,
    isConnected,
    isWrongNetwork,
    connecting,
    switching,
    error,
    selectedRole,
    connect,
    switchToActiveChain,
    disconnect,
    clearError,
  } = useWallet();

  // Once connected on the right HashKey Chain, glide straight to saved desk (or /start for first-time users)
  useEffect(() => {
    if (isConnected && !isWrongNetwork) {
      const target = selectedRole
        ? selectedRole === "agent"
          ? "/agent"
          : selectedRole === "lp"
            ? "/vault"
            : "/trade"
        : "/start";
      const timer = setTimeout(() => onNavigate(target), 400);
      return () => clearTimeout(timer);
    }
  }, [isConnected, isWrongNetwork, selectedRole, onNavigate]);

  return (
    <div className="relative flex h-[100svh] flex-col overflow-hidden bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
      {/* Subtle monochrome studio rim light */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 h-[65vh]"
        style={{
          background:
            "radial-gradient(45% 42% at 50% 20%, rgba(248, 247, 238, 0.08) 0%, rgba(248, 247, 238, 0) 100%)",
        }}
      />

      {/* Minimal Floating Glass Top Bar */}
      <header className="fixed inset-x-0 top-5 z-40 px-4">
        <nav className="mx-auto flex h-14 max-w-[1080px] items-center justify-between px-2">
          <button
            type="button"
            onClick={() => onNavigate("/")}
            aria-label="Tranche home"
            className="inline-flex items-center rounded-full py-1 transition-opacity hover:opacity-80 cursor-pointer"
          >
            <TrancheLogo priority />
          </button>

          <button
            type="button"
            onClick={() => onNavigate("/")}
            className="glass-pill glass-pill-interactive inline-flex h-10 items-center gap-2 rounded-full px-4 text-xs font-medium text-foreground cursor-pointer"
          >
            <ArrowLeft className="size-3.5" />
            Back
          </button>
        </nav>
      </header>

      {/* Centered Entry Gate (locked single-viewport, non-scrollable) */}
      <main className="relative z-10 mx-auto flex w-full max-w-[450px] flex-1 flex-col items-center justify-center px-6 pt-16 pb-6">
        {/* Expanding Numbered Step Pill (01 Connect -> 02) */}
        <div className="animate-rise mb-5 flex items-center gap-2.5" aria-label="Onboarding step">
          <span className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-xs font-medium text-primary-foreground">
            <span className="tabular-nums-mono">01</span>
            <span className="ml-2">Connect</span>
          </span>
          <span className="glass-pill inline-flex size-9 items-center justify-center rounded-full text-xs text-muted-foreground">
            <span className="tabular-nums-mono">02</span>
          </span>
        </div>

        {/* Main Apple Glass / Matte Entry Card */}
        <div className="animate-rise-delay-1 w-full overflow-hidden rounded-[24px] border border-border bg-card p-6 shadow-[0_32px_80px_rgba(0,0,0,0.65)]">
          {!isConnected ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <h1 className="font-display text-2xl font-semibold tracking-[-0.035em] text-foreground">
                  Connect your wallet
                </h1>
                <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
                  Sign in with a wallet to use Tranche.
                </p>
              </div>

              {/* Discovered EIP-6963 Wallets */}
              <div className="flex flex-col gap-2">
                {wallets.length > 0 ? (
                  wallets.map((w) => (
                    <button
                      key={w.uuid}
                      type="button"
                      disabled={connecting}
                      onClick={() => connect(w.provider)}
                      className="glass-pill glass-pill-interactive group flex min-h-[48px] w-full items-center justify-between rounded-[14px] px-3.5 py-2 text-left disabled:opacity-50 cursor-pointer"
                    >
                      <div className="flex items-center gap-3.5">
                        {w.icon ? (
                          <img
                            src={w.icon}
                            alt={w.name}
                            className="size-8 rounded-lg object-contain"
                          />
                        ) : (
                          <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-foreground">
                            <Wallet className="size-4" />
                          </span>
                        )}
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-foreground">{w.name}</span>
                          <span className="text-[11px] text-muted-foreground">Detected</span>
                        </div>
                      </div>
                      {connecting ? (
                        <Loader2 className="size-4 animate-spin text-muted-foreground" />
                      ) : (
                        <ArrowRight className="size-4 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground" />
                      )}
                    </button>
                  ))
                ) : hasInjectedFallback ? (
                  <button
                    type="button"
                    disabled={connecting}
                    onClick={() => connect()}
                    className="glass-pill glass-pill-interactive group flex min-h-[58px] w-full items-center justify-between rounded-[16px] px-4 py-3 text-left disabled:opacity-50 cursor-pointer"
                  >
                    <div className="flex items-center gap-3.5">
                      <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-foreground">
                        <Wallet className="size-4" />
                      </span>
                      <div className="flex flex-col">
                        <span className="text-sm font-medium text-foreground">Browser Wallet</span>
                        <span className="text-[11px] text-muted-foreground">
                          MetaMask, Rabby, OKX, or injected
                        </span>
                      </div>
                    </div>
                    {connecting ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : (
                      <ArrowRight className="size-4 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground" />
                    )}
                  </button>
                ) : (
                  <div className="rounded-[16px] border border-border bg-background/60 p-5 text-center">
                    <p className="text-sm font-medium text-foreground">No browser wallet found</p>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                      Install MetaMask, Rabby, or OKX Wallet in this browser, then refresh to
                      connect.
                    </p>
                  </div>
                )}
              </div>

              {error && (
                <div className="flex items-start gap-2.5 rounded-[14px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                  <span className="leading-relaxed">{error}</span>
                </div>
              )}

              <Separator />

              <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
                Non-custodial interface. By connecting, you agree to the{" "}
                <button
                  type="button"
                  onClick={() => onNavigate("/terms")}
                  className="underline underline-offset-4 hover:text-foreground cursor-pointer"
                >
                  Terms
                </button>{" "}
                and{" "}
                <button
                  type="button"
                  onClick={() => onNavigate("/privacy")}
                  className="underline underline-offset-4 hover:text-foreground cursor-pointer"
                >
                  Privacy Policy
                </button>
                .
              </p>
            </div>
          ) : isWrongNetwork ? (
            /* In-Place Network Gate */
            <div className="animate-rise flex flex-col gap-6">
              <div className="flex items-center justify-between">
                <span className="tabular-nums-mono rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
                  {address ? shortAddr(address) : ""}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    clearError();
                    disconnect();
                  }}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
                >
                  Disconnect
                </button>
              </div>

              <div className="flex flex-col gap-2">
                <h1 className="font-display text-2xl font-semibold tracking-[-0.035em] text-foreground sm:text-3xl">
                  Switch to {ACTIVE_NETWORK.shortName}
                </h1>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Your wallet is currently on Chain {chainId}. Tranche is{" "}
                  {ACTIVE_NETWORK.isLive ? "live" : "configured"} on {ACTIVE_NETWORK.name} (Chain{" "}
                  {ACTIVE_NETWORK.chainId}).
                </p>
              </div>

              {error && (
                <div className="flex items-start gap-2.5 rounded-[14px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                  <span className="leading-relaxed">{error}</span>
                </div>
              )}

              <Button
                type="button"
                size="lg"
                disabled={switching}
                onClick={switchToActiveChain}
                className="h-12 w-full rounded-full text-sm font-medium active:scale-[0.985] transition-transform cursor-pointer"
              >
                {switching ? (
                  <>
                    <Loader2 className="animate-spin" data-icon="inline-start" />
                    Switching Network…
                  </>
                ) : (
                  `Switch to Chain ${ACTIVE_NETWORK.chainId}`
                )}
              </Button>
            </div>
          ) : (
            /* Ready confirmation state before auto-advancing to /start */
            <div className="animate-rise flex flex-col items-center gap-4 py-6 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Check className="size-5" />
              </span>
              <div className="flex flex-col gap-1">
                <h1 className="font-display text-2xl font-semibold">Wallet connected</h1>
                <p className="tabular-nums-mono text-xs text-muted-foreground">
                  {address ? shortAddr(address) : ""} · Chain {ACTIVE_NETWORK.chainId}
                </p>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
