import { useRef, useState } from "react";
import { ArrowUpRight, LogOut } from "lucide-react";
import { TrancheLogo } from "@/components/TrancheLogo";
import { ACTIVE_NETWORK } from "@/config/networks";
import { useWallet, type UserRole } from "@/context/WalletContext";
import type { AppRoute } from "@/App";

interface RolePickerPageProps {
  onNavigate: (path: AppRoute) => void;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

interface RoleStubProps {
  variant: "cream" | "carbon";
  eyebrow: string;
  headline: string;
  subline: string;
  facts: readonly [string, string, string];
  cta: string;
  onSelect: () => void;
}

function RoleTicketStub({
  variant,
  eyebrow,
  headline,
  subline,
  facts,
  cta,
  onSelect,
}: RoleStubProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ rx: 0, ry: 0, gx: 50, gy: 20, active: false });

  const isCream = variant === "cream";
  const bg = isCream ? "#f8f7ee" : "#121210";
  const fg = isCream ? "#050505" : "#f8f7ee";
  const muted = isCream ? "rgba(5, 5, 5, 0.58)" : "rgba(248, 247, 238, 0.56)";
  const hairline = isCream ? "rgba(5, 5, 5, 0.14)" : "rgba(248, 247, 238, 0.14)";
  const sheen = isCream ? "rgba(255, 255, 255, 0.52)" : "rgba(248, 247, 238, 0.12)";

  function handleMove(e: React.PointerEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    setTilt({
      rx: (0.5 - py) * 7,
      ry: (px - 0.5) * 9,
      gx: px * 100,
      gy: py * 100,
      active: true,
    });
  }

  return (
    <div
      ref={ref}
      onPointerMove={handleMove}
      onPointerLeave={() => setTilt({ rx: 0, ry: 0, gx: 50, gy: 20, active: false })}
      className="h-full w-full [perspective:1100px]"
    >
      <div
        onClick={onSelect}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        style={{
          transform: `rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg) translateZ(0)`,
          transition: tilt.active
            ? "transform 110ms cubic-bezier(0.2, 0, 0, 1)"
            : "transform 520ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
        className="group flex h-full w-full flex-col will-change-transform cursor-pointer drop-shadow-[0_32px_72px_rgba(0,0,0,0.75)] focus-visible:outline-none"
      >
        <div
          className="relative flex flex-1 flex-col overflow-hidden rounded-t-[20px] px-6 pt-6 pb-5"
          style={{
            backgroundColor: bg,
            color: fg,
            borderTop: isCream ? "none" : "1px solid rgba(248, 247, 238, 0.14)",
            borderLeft: isCream ? "none" : "1px solid rgba(248, 247, 238, 0.1)",
            borderRight: isCream ? "none" : "1px solid rgba(248, 247, 238, 0.1)",
          }}
        >
          {/* Cursor specular sheen */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 transition-opacity duration-300"
            style={{
              opacity: tilt.active ? 1 : 0,
              background: `radial-gradient(280px circle at ${tilt.gx}% ${tilt.gy}%, ${sheen}, transparent 65%)`,
            }}
          />

          <div className="relative flex flex-1 flex-col gap-2.5">
            <span
              className="tabular-nums-mono text-[10px] font-medium uppercase tracking-[0.12em]"
              style={{ color: muted }}
            >
              {eyebrow}
            </span>

            <h2 className="font-display text-2xl font-semibold leading-[1.05] tracking-[-0.035em]">
              {headline}
            </h2>

            <p className="text-[13px] leading-relaxed" style={{ color: muted }}>
              {subline}
            </p>
          </div>

          {/* Perforated tear line with semicircular ticket notches */}
          <div className="relative my-5 flex items-center">
            <span
              aria-hidden="true"
              className="absolute -left-8 size-3.5 rounded-full bg-background"
            />
            <div className="w-full border-t border-dashed" style={{ borderColor: hairline }} />
            <span
              aria-hidden="true"
              className="absolute -right-8 size-3.5 rounded-full bg-background"
            />
          </div>

          {/* 3 crisp mono facts */}
          <div className="relative flex flex-wrap items-center gap-1.5">
            {facts.map((fact) => (
              <span
                key={fact}
                className="tabular-nums-mono rounded-full px-2.5 py-0.5 text-[10px] font-medium"
                style={{ border: `1px solid ${hairline}`, color: fg }}
              >
                {fact}
              </span>
            ))}
          </div>

          {/* Action pill */}
          <div className="relative mt-5">
            <span
              className="inline-flex h-10 w-full items-center justify-between rounded-full px-5 text-xs font-medium transition-transform duration-200 group-active:scale-[0.985]"
              style={{
                backgroundColor: fg,
                color: bg,
              }}
            >
              <span>{cta}</span>
              <ArrowUpRight className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </span>
          </div>
        </div>

        {/* Exact Tranche double-chevron serrated bottom edge */}
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
    </div>
  );
}

export function RolePickerPage({ onNavigate }: RolePickerPageProps) {
  const { address, hskBalance, isConnected, disconnect, setSelectedRole } = useWallet();

  function handleSelect(role: UserRole) {
    setSelectedRole(role);
    onNavigate(role === "agent" ? "/agent" : role === "trader" ? "/trade" : "/vault");
  }

  return (
    <div className="relative flex min-h-[100svh] flex-col bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
      {/* Subtle studio rim glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 h-[65vh]"
        style={{
          background:
            "radial-gradient(50% 42% at 50% 18%, rgba(248, 247, 238, 0.08) 0%, rgba(248, 247, 238, 0) 100%)",
        }}
      />

      {/* Floating Glass Topbar */}
      <header className="fixed inset-x-0 top-4 z-40 px-4">
        <nav className="mx-auto grid h-12 max-w-[1080px] grid-cols-[1fr_auto_1fr] items-center px-2">
          <div className="flex items-center justify-start">
            <button
              type="button"
              onClick={() => onNavigate("/")}
              aria-label="Tranche home"
              className="inline-flex items-center rounded-full py-1 transition-opacity hover:opacity-80 cursor-pointer"
            >
              <TrancheLogo />
            </button>
          </div>

          {/* Center step pill (01 -> 02 Choose Role) */}
          <div className="hidden items-center gap-2 sm:flex" aria-label="Onboarding step">
            <button
              type="button"
              onClick={() => onNavigate("/connect")}
              className="glass-pill glass-pill-interactive inline-flex size-9 items-center justify-center rounded-full text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <span className="tabular-nums-mono">01</span>
            </button>
            <span className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-xs font-medium text-primary-foreground">
              <span className="tabular-nums-mono">02</span>
              <span className="ml-2">Choose Role</span>
            </span>
          </div>

          {/* Right: Connected Wallet Glass Pill */}
          <div className="flex items-center justify-end gap-2">
            {isConnected && address ? (
              <div className="glass-pill inline-flex h-10 items-center gap-2.5 rounded-full pl-3.5 pr-2 text-xs">
                <span className="size-1.5 rounded-full bg-status-live" />
                <span className="tabular-nums-mono font-medium text-foreground">
                  {shortAddr(address)}
                </span>
                {hskBalance && (
                  <span className="tabular-nums-mono hidden text-muted-foreground sm:inline">
                    {hskBalance} HSK
                  </span>
                )}
                <button
                  type="button"
                  aria-label="Disconnect wallet"
                  onClick={() => {
                    disconnect();
                    onNavigate("/connect");
                  }}
                  className="inline-flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
                >
                  <LogOut className="size-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate("/connect")}
                className="glass-pill glass-pill-interactive inline-flex h-10 items-center rounded-full px-4 text-xs font-medium text-foreground cursor-pointer"
              >
                Connect Wallet
              </button>
            )}
          </div>
        </nav>
      </header>

      {/* Main Role Selection Canvas */}
      <main className="relative z-10 mx-auto flex w-full max-w-[1040px] flex-1 flex-col items-center justify-center px-6 pt-24 pb-12">
        <div className="animate-rise mb-7 flex flex-col items-center gap-2 text-center">
          <h1 className="font-display text-3xl font-semibold tracking-[-0.04em] text-foreground sm:text-4xl">
            How do you want to use Tranche?
          </h1>
          <p className="max-w-md text-xs leading-relaxed text-muted-foreground sm:text-sm">
            Pick your starting workspace. Switch between Agent, Trade, Tickets, and Vault anytime.
          </p>
        </div>

        {/* Three Physical Serrated Ticket Stubs: Agent, Trader, Liquidity Provider */}
        <div className="animate-rise-delay-1 grid w-full grid-cols-1 gap-6 md:grid-cols-3">
          <RoleTicketStub
            variant="cream"
            eyebrow="01 · Autonomous Agent"
            headline="Tranche Agent"
            subline="Monitor dual-venue routing across Tranche and HSKSwap with code-enforced risk limits and bounded policy proposals."
            facts={["TRANCHE vs HSKSWAP", "RiskManager", "Dry-run default"]}
            cta="Open Agent Console"
            onSelect={() => handleSelect("agent")}
          />

          <RoleTicketStub
            variant="carbon"
            eyebrow="02 · Trader Desk"
            headline="Trade & Reserve"
            subline="Lock exact token inventory at a fixed or bounded price and exercise before expiry."
            facts={["0% AMM slippage", "ERC-721 ticket", "Partial fills"]}
            cta="Start Trading"
            onSelect={() => handleSelect("trader")}
          />

          <RoleTicketStub
            variant="carbon"
            eyebrow="03 · Liquidity Provider"
            headline="Provide Liquidity"
            subline="Deposit ERC-20 inventory into segregated vault buckets, quote offers, and earn upfront premiums."
            facts={["Segregated vault", "Upfront bps", "Withdraw anytime"]}
            cta="Open Vault"
            onSelect={() => handleSelect("lp")}
          />
        </div>

        <p className="animate-rise-delay-2 mt-7 text-center text-[11px] text-muted-foreground">
          {ACTIVE_NETWORK.name} · Chain {ACTIVE_NETWORK.chainId}
          {!ACTIVE_NETWORK.isLive ? " · Deployment Pending" : ""}
        </p>
      </main>
    </div>
  );
}
