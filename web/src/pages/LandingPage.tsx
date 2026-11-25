import { useEffect, useState } from "react";
import { ArrowUpRight, CheckCircle2, Plus, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Reveal } from "@/components/Reveal";
import { StickyLifecycleStage } from "@/components/StickyLifecycleStage";
import { TicketSpecimen } from "@/components/TicketSpecimen";
import { TrancheLogo } from "@/components/TrancheLogo";
import { ACTIVE_NETWORK, explorerAddressUrl } from "@/config/networks";
import { useWallet } from "@/context/WalletContext";
import { useProtocolTelemetry } from "@/hooks/useProtocolTelemetry";
import { cn } from "@/lib/utils";
import type { AppRoute } from "@/App";

const AGENT_POINTS = [
  {
    label: "Dual-venue cost routing",
    detail: "Compares gas-adjusted Tranche all-in cost against live HSKSwap V3 QuoterV2 quotes and slippage — choosing TRANCHE, HSKSWAP, or WAIT.",
  },
  {
    label: "Code-enforced RiskManager",
    detail: "Exposure caps, daily loss circuit breakers, oracle freshness guards, and an authoritative kill switch enforced in code — never by prompts.",
  },
  {
    label: "Auditable decision traces",
    detail: "Every cycle records live quotes, venue math, risk-check outcomes, policy versions, and confirmed on-chain receipts.",
  },
] as const;

const LP_POINTS = [
  {
    label: "Non-refundable upfront premiums",
    detail: "LPs earn reservation hold fees immediately — even when the agent lets a ticket expire unused.",
  },
  {
    label: "Strict pricing guardrails",
    detail: "Define minimum fill sizes, lock duration bounds, fixed strikes, or TWAP-bounded floating spreads with min/max caps.",
  },
  {
    label: "Uncommitted funds stay free",
    detail: "Cancel open offer balance and withdraw free inventory at any time with zero lockups under INV-1 solvency.",
  },
] as const;

const VAULT_BUCKETS = [
  {
    code: "01",
    term: "free",
    name: "LP Free Balance",
    role: "Deposited inventory ready to allocate into offers or withdraw immediately.",
  },
  {
    code: "02",
    term: "offer",
    name: "Offer Available",
    role: "Active inventory quoted on the book, cancellable by the LP until reserved.",
  },
  {
    code: "03",
    term: "reserved",
    name: "Ticket Reserved",
    role: "Exclusively locked to an ERC-721 Execution Ticket until exercise or expiry.",
  },
  {
    code: "04",
    term: "proceeds",
    name: "Pending Proceeds",
    role: "Earned reservation premiums and exercise payments ready for LP claim.",
  },
  {
    code: "05",
    term: "fees",
    name: "Protocol Fees",
    role: "0.05% fee bucket segregated for the 2-of-3 Treasury Safe — never mixed with LP funds.",
  },
] as const;

const CORE_CONTRACTS = [
  {
    name: "LiquidityVault",
    note: "Segregated ERC-20 accounting · Verified",
    address: ACTIVE_NETWORK.contracts.liquidityVault,
  },
  {
    name: "CommitmentManager",
    note: "Offers, reservations, exercise & reclaim",
    address: ACTIVE_NETWORK.contracts.commitmentManager,
  },
  {
    name: "ExecutionTicket",
    note: "ERC-721 bearer ticket with EIP-712 permit",
    address: ACTIVE_NETWORK.contracts.executionTicket,
  },
  {
    name: "ExecutionRouter",
    note: "Batch multi-ticket exercise & WHSK unwrap",
    address: ACTIVE_NETWORK.contracts.executionRouter,
  },
  {
    name: "TimelockController",
    note: "Sole protocol owner · 3-of-5 Gov Safe",
    address: ACTIVE_NETWORK.contracts.timelock,
  },
] as const;

const FAQS = [
  {
    q: "How is Tranche Agent different from a standard HSKSwap trading bot?",
    a: "Standard HSKSwap agents can only market-swap directly into thin AMM pools, taking immediate price impact and irreversible spot exposure. Tranche Agent routes across two venues — live HSKSwap V3 pools and on-chain reserved inventory (ERC-721 Execution Tickets) — choosing whichever has better gas-adjusted economics, or waiting.",
  },
  {
    q: "Can an LLM bypass risk limits or execute arbitrary transactions?",
    a: "No. Trading signals, venue routing, and risk checks are 100% deterministic. The optional LLM layer only translates natural-language instructions into bounded policy proposals validated against hard ceilings, with versioned persistence and instant rollback. It can never clear the kill switch or sign transactions.",
  },
  {
    q: "What happens if the agent lets a reserved ticket expire?",
    a: "The reserved inventory returns cleanly to the LP's offer or free balance, and the reservation loss is capped at the non-refundable upfront hold fee. Once exercised, the resulting spot position is actively managed with take-profit and stop-loss unwinds via HSKSwap Router02.",
  },
  {
    q: "How does Tranche transition from Testnet (133) to HashKey Chain Mainnet (177)?",
    a: "DeployMainnet.s.sol, canonical Chain 177 tokens (WHSK, USDT, WETH, WBTC), live HSKSwap V3 pools, Safe v1.4.1 multisigs, and the 48-hour Timelock handover are already verified on a Chain 177 fork. Switching the app to Mainnet is a single manifest update after deployment.",
  },
] as const;

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

interface LandingPageProps {
  onNavigate: (path: AppRoute) => void;
}

export function LandingPage({ onNavigate }: LandingPageProps) {
  const telemetry = useProtocolTelemetry();
  const { isConnected, isWrongNetwork, selectedRole } = useWallet();
  const [activeBucket, setActiveBucket] = useState<string>("reserved");
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  function handleLaunchApp() {
    // Returning users go straight into their saved workspace
    if (selectedRole) {
      onNavigate(selectedRole === "agent" ? "/agent" : selectedRole === "lp" ? "/vault" : "/trade");
      return;
    }
    onNavigate(isConnected && !isWrongNetwork ? "/start" : "/connect");
  }
  const [scrollState, setScrollState] = useState({
    compact: false,
    showCta: false,
    nearFooter: false,
  });

  useEffect(() => {
    let rafId = 0;
    const update = () => {
      const y = window.scrollY;
      const docHeight = document.documentElement.scrollHeight;
      const winHeight = window.innerHeight;
      const distFromBottom = docHeight - (y + winHeight);

      setScrollState({
        compact: y > 36,
        showCta: y > 420,
        nearFooter: distFromBottom < 220 && y > 600,
      });
    };

    const onScroll = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <div className="relative min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
      {/* GPU-composited Titan-inspired scroll header → Apple Liquid Glass pill */}
      <header
        className={cn(
          "fixed inset-x-0 top-5 z-40 px-4 will-change-transform transition-[transform,opacity] duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
          scrollState.nearFooter
            ? "-translate-y-24 opacity-0 pointer-events-none"
            : scrollState.compact
              ? "translate-y-0 opacity-100"
              : "translate-y-2 opacity-100",
        )}
      >
        <div className="relative mx-auto max-w-[1080px]">
          <div
            aria-hidden="true"
            className={cn(
              "glass-pill pointer-events-none absolute inset-y-0 left-1/2 w-full max-w-[960px] -translate-x-1/2 rounded-full will-change-[transform,opacity] transition-[transform,opacity] duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
              scrollState.compact ? "scale-x-100 opacity-100" : "scale-x-[1.12] opacity-0",
            )}
          />

          <nav
            aria-label="Primary"
            className="relative mx-auto grid h-14 max-w-[960px] grid-cols-[1fr_auto_1fr] items-center px-5"
          >
            {/* Left: Brand mark */}
            <div className="flex items-center justify-start">
              <a
                href="#"
                aria-label="Tranche home"
                className={cn(
                  "inline-flex origin-left items-center rounded-full py-1 will-change-transform transition-[transform,opacity] duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  scrollState.compact
                    ? "translate-x-0 scale-100"
                    : "lg:-translate-x-12 scale-[1.3] sm:scale-[1.4]",
                )}
              >
                <TrancheLogo />
              </a>
            </div>

            {/* Center: Section links */}
            <div className="hidden items-center justify-center gap-1 md:flex">
              <a
                href="#mechanism"
                className="rounded-full px-3.5 py-2 text-sm text-muted-foreground transition-colors duration-200 hover:bg-accent/60 hover:text-foreground"
              >
                Agent Loop
              </a>
              <a
                href="#sides"
                className="rounded-full px-3.5 py-2 text-sm text-muted-foreground transition-colors duration-200 hover:bg-accent/60 hover:text-foreground"
              >
                Dual Venues
              </a>
              <a
                href="#vault"
                className="rounded-full px-3.5 py-2 text-sm text-muted-foreground transition-colors duration-200 hover:bg-accent/60 hover:text-foreground"
              >
                Vault
              </a>
              <a
                href="#contracts"
                className="rounded-full px-3.5 py-2 text-sm text-muted-foreground transition-colors duration-200 hover:bg-accent/60 hover:text-foreground"
              >
                Contracts
              </a>
            </div>

            {/* Right: Docs & Privacy (always balanced) + Launch App pill on scroll */}
            <div className="flex items-center justify-end gap-1.5">
              <div
                className={cn(
                  "flex items-center gap-1 will-change-transform transition-transform duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
                  scrollState.compact ? "translate-x-0" : "lg:translate-x-12",
                )}
              >
                <button
                  type="button"
                  onClick={() => onNavigate("/docs")}
                  className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-200 hover:bg-accent/60 hover:text-foreground cursor-pointer"
                >
                  Docs
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate("/privacy")}
                  className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-200 hover:bg-accent/60 hover:text-foreground cursor-pointer"
                >
                  Privacy
                </button>
              </div>

              <div
                className={cn(
                  "overflow-hidden will-change-[transform,opacity] transition-[max-width,transform,opacity] duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
                  scrollState.showCta
                    ? "ml-1 max-w-[160px] translate-y-0 opacity-100"
                    : "ml-0 max-w-0 -translate-y-1 opacity-0 pointer-events-none",
                )}
              >
                <Button
                  type="button"
                  onClick={handleLaunchApp}
                  tabIndex={scrollState.showCta ? 0 : -1}
                  className="h-9 whitespace-nowrap rounded-full px-4 text-xs font-medium active:scale-[0.985] transition-transform cursor-pointer"
                >
                  Launch App
                  <ArrowUpRight data-icon="inline-end" />
                </Button>
              </div>
            </div>
          </nav>
        </div>
      </header>

      {/* 1. Full-Bleed 100vh Poster Hero (Jeton asymmetric anchoring + Ethena centered centerpiece) */}
      <section className="relative flex min-h-[100svh] flex-col justify-between gap-12 overflow-hidden px-6 pt-32 pb-16 sm:pt-36 sm:pb-20">
        {/* Subtle monochrome studio rim glow behind centerpiece */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[75vh]"
          style={{
            background:
              "radial-gradient(48% 42% at 50% 34%, rgba(248, 247, 238, 0.09) 0%, rgba(248, 247, 238, 0) 100%)",
          }}
        />

        {/* Upper-center sculptural focal artifact */}
        <div className="relative z-10 mx-auto my-auto flex w-full max-w-[1080px] items-center justify-center py-10 sm:py-14">
          <div className="animate-rise w-full max-w-[420px]">
            <TicketSpecimen stage={0} mode="FIXED" />
          </div>
        </div>

        {/* Bottom-anchored asymmetric poster typography + single crisp CTA */}
        <div className="relative z-10 mx-auto grid w-full max-w-[1080px] grid-cols-1 items-end gap-10 lg:grid-cols-12">
          <h1 className="font-display text-[2.85rem] font-bold leading-[0.98] tracking-[-0.045em] text-foreground sm:text-[4.4rem] lg:col-span-7">
            <span className="block overflow-hidden pb-1">
              <span className="block animate-mask-up">Trade autonomously.</span>
            </span>
            <span className="block overflow-hidden pb-1">
              <span className="block animate-mask-up-delay text-muted-foreground">
                Route across two venues.
              </span>
            </span>
          </h1>

          <div className="animate-rise-delay-2 flex flex-col items-start gap-6 lg:col-span-5 lg:items-end lg:text-right">
            <p className="max-w-[400px] text-base leading-relaxed text-muted-foreground">
              The autonomous trading agent on HashKey Chain that compares HSKSwap V3 pools against
              on-chain reserved inventory — routing every trade to the better venue, or walking away.
            </p>
            <div className="flex flex-wrap items-center gap-2.5 lg:justify-end">
              <Button
                type="button"
                size="lg"
                onClick={() => onNavigate("/agent")}
                className="h-12 rounded-full px-7 text-sm font-medium active:scale-[0.985] transition-transform cursor-pointer"
              >
                Open Agent Console
                <ArrowUpRight data-icon="inline-end" />
              </Button>
              <Button
                type="button"
                size="lg"
                variant="outline"
                onClick={handleLaunchApp}
                className="h-12 rounded-full px-6 text-sm font-medium active:scale-[0.985] transition-transform cursor-pointer"
              >
                Protocol Desk
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* 2. Live On-Chain Telemetry Strip */}
      <section id="protocol" className="mx-auto max-w-[1080px] px-6 py-28 sm:py-36">
        <Reveal>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[22px] border border-border bg-border sm:grid-cols-4">
            <div className="flex flex-col gap-1.5 bg-card p-6 sm:p-7">
              <span className="text-xs text-muted-foreground">Active Network</span>
              <span className="tabular-nums-mono text-lg font-semibold text-foreground">
                Chain {ACTIVE_NETWORK.chainId}
              </span>
              <span className="tabular-nums-mono text-xs text-muted-foreground">
                {telemetry.blockNumber
                  ? `Block #${telemetry.blockNumber.toLocaleString()}`
                  : ACTIVE_NETWORK.shortName}
              </span>
            </div>

            <div className="flex flex-col gap-1.5 bg-card p-6 sm:p-7">
              <span className="text-xs text-muted-foreground">Protocol Fee</span>
              <span className="tabular-nums-mono text-lg font-semibold text-foreground">
                {!ACTIVE_NETWORK.isLive
                  ? "Pending"
                  : telemetry.protocolFeeBps !== null
                    ? `${(telemetry.protocolFeeBps / 100).toFixed(2)}%`
                    : telemetry.loading
                      ? "Syncing…"
                      : "Unavailable"}
              </span>
              <span className="text-xs text-muted-foreground">Hard-capped at 1.00%</span>
            </div>

            <div className="flex flex-col gap-1.5 bg-card p-6 sm:p-7">
              <span className="text-xs text-muted-foreground">Vault Solvency (INV-1)</span>
              <span className="inline-flex items-center gap-1.5 text-lg font-semibold text-foreground">
                {ACTIVE_NETWORK.isLive && telemetry.vaultSolvent === true && (
                  <CheckCircle2 className="size-4 text-status-live" />
                )}
                {!ACTIVE_NETWORK.isLive
                  ? "Pending"
                  : telemetry.vaultSolvent === true
                    ? "Verified"
                    : telemetry.vaultSolvent === false
                      ? "Check"
                      : telemetry.loading
                        ? "Syncing…"
                        : "Unavailable"}
              </span>
              <span className="text-xs text-muted-foreground">balanceOf ≥ all buckets</span>
            </div>

            <div className="flex flex-col gap-1.5 bg-card p-6 sm:p-7">
              <span className="text-xs text-muted-foreground">Ownership</span>
              <span className="inline-flex items-center gap-1.5 text-lg font-semibold text-foreground">
                {ACTIVE_NETWORK.isLive && telemetry.timelockOwned === true && (
                  <ShieldCheck className="size-4 text-status-live" />
                )}
                {!ACTIVE_NETWORK.isLive
                  ? "Pending"
                  : telemetry.timelockOwned === true
                    ? "Timelock"
                    : telemetry.timelockOwned === false
                      ? "Pending"
                      : telemetry.loading
                        ? "Syncing…"
                        : "Unavailable"}
              </span>
              <span className="text-xs text-muted-foreground">3-of-5 Gov · Zero EOA</span>
            </div>
          </div>
        </Reveal>
      </section>

      {/* 3. Scroll-Scrubbed Sticky Lifecycle Stage (Jeton Pill Stepper × Ethena Pinned Stage) */}
      <StickyLifecycleStage />

      {/* 4. Full-Bleed Archival Cream Polarity Cut (Ethena / Jeton Chapter Contrast) */}
      <section
        id="sides"
        className="mt-32 scroll-mt-20 bg-[#f8f7ee] text-[#050505] py-36 sm:py-48"
      >
        <div className="mx-auto max-w-[1080px] px-6">
          <Reveal className="flex flex-col gap-4">
            <span className="tabular-nums-mono text-xs uppercase tracking-[0.14em] text-[#050505]/55">
              Dual-Venue Autonomous Execution
            </span>
            <h2 className="font-display max-w-2xl text-4xl font-semibold leading-[1.0] tracking-[-0.04em] sm:text-6xl">
              Two execution venues.
              <br />
              <span className="text-[#050505]/45">One risk-enforced agent.</span>
            </h2>
          </Reveal>

          <div className="mt-16 grid grid-cols-1 gap-12 border-t border-[#050505]/15 pt-14 lg:grid-cols-2 lg:gap-16">
            {/* Tranche Agent */}
            <Reveal delayMs={40} className="flex flex-col gap-8">
              <div className="flex flex-col gap-2">
                <span className="tabular-nums-mono text-xs uppercase tracking-[0.12em] text-[#050505]/55">
                  Tranche Agent
                </span>
                <h3 className="font-display text-2xl font-bold tracking-[-0.03em] sm:text-3xl">
                  Deterministic routing, zero blind swaps.
                </h3>
              </div>

              <div className="flex flex-col">
                {AGENT_POINTS.map((point, idx) => (
                  <div
                    key={point.label}
                    className={cn(
                      "flex flex-col gap-1.5 py-5",
                      idx > 0 && "border-t border-[#050505]/12",
                    )}
                  >
                    <span className="text-base font-semibold text-[#050505]">{point.label}</span>
                    <p className="text-sm leading-relaxed text-[#050505]/65">{point.detail}</p>
                  </div>
                ))}
              </div>
            </Reveal>

            {/* For LPs */}
            <Reveal delayMs={120} className="flex flex-col gap-8">
              <div className="flex flex-col gap-2">
                <span className="tabular-nums-mono text-xs uppercase tracking-[0.12em] text-[#050505]/55">
                  For Liquidity Providers
                </span>
                <h3 className="font-display text-2xl font-bold tracking-[-0.03em] sm:text-3xl">
                  Get paid upfront to stand ready.
                </h3>
              </div>

              <div className="flex flex-col">
                {LP_POINTS.map((point, idx) => (
                  <div
                    key={point.label}
                    className={cn(
                      "flex flex-col gap-1.5 py-5",
                      idx > 0 && "border-t border-[#050505]/12",
                    )}
                  >
                    <span className="text-base font-semibold text-[#050505]">{point.label}</span>
                    <p className="text-sm leading-relaxed text-[#050505]/65">{point.detail}</p>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* Back to Pure Obsidian */}
      <main className="mx-auto flex max-w-[1080px] flex-col px-6 pt-44 pb-36 sm:pt-56 sm:pb-44">
        {/* 5. Segregated Vault Architecture (Interactive INV-1 Highlighter) */}
        <section id="vault" className="scroll-mt-32">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-12 lg:items-start">
            <Reveal className="flex flex-col gap-5 lg:col-span-5 lg:sticky lg:top-32">
              <span className="tabular-nums-mono text-xs uppercase tracking-[0.12em] text-muted-foreground">
                Segregated Accounting
              </span>
              <h2 className="font-display text-3xl font-semibold leading-[1.04] tracking-[-0.035em] sm:text-4xl">
                Every token has one bucket.{" "}
                <span className="text-muted-foreground">Never commingled.</span>
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">
                LiquidityVault tracks every wei across five isolated accounting states. Hover any
                bucket to inspect how it maps to physical solvency.
              </p>
              <div className="mt-2 rounded-[18px] border border-border bg-card px-5 py-4">
                <span className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                  Invariant INV-1
                </span>
                <p className="tabular-nums-mono mt-2.5 flex flex-wrap items-center gap-1.5 text-xs leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">balanceOf(token) ≥</span>
                  {VAULT_BUCKETS.map((b, idx) => (
                    <span key={b.term} className="inline-flex items-center gap-1.5">
                      {idx > 0 && <span>+</span>}
                      <button
                        type="button"
                        onClick={() => setActiveBucket(b.term)}
                        className={cn(
                          "rounded-md px-1.5 py-0.5 transition-colors duration-200 cursor-pointer",
                          activeBucket === b.term
                            ? "bg-primary text-primary-foreground font-medium"
                            : "bg-accent/60 text-foreground/80 hover:text-foreground",
                        )}
                      >
                        {b.term}
                      </button>
                    </span>
                  ))}
                </p>
              </div>
            </Reveal>

            <Reveal delayMs={80} className="lg:col-span-7">
              <div className="overflow-hidden rounded-[22px] border border-border bg-card">
                {VAULT_BUCKETS.map((bucket, idx) => {
                  const isActive = activeBucket === bucket.term;
                  return (
                    <div key={bucket.code}>
                      {idx > 0 && <Separator />}
                      <div
                        onMouseEnter={() => setActiveBucket(bucket.term)}
                        onClick={() => setActiveBucket(bucket.term)}
                        className={cn(
                          "flex items-start gap-5 px-7 py-6 transition-colors duration-200 cursor-pointer",
                          isActive ? "bg-accent/70" : "hover:bg-accent/35",
                        )}
                      >
                        <span
                          className={cn(
                            "tabular-nums-mono pt-0.5 text-xs transition-colors duration-200",
                            isActive ? "font-medium text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {bucket.code}
                        </span>
                        <div className="flex flex-col gap-1">
                          <span className="text-sm font-medium text-foreground">
                            {bucket.name}
                          </span>
                          <p className="text-sm leading-relaxed text-muted-foreground">
                            {bucket.role}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Reveal>
          </div>
        </section>

        {/* 6. Live Deployed Contracts */}
        <section id="contracts" className="mt-48 scroll-mt-32 sm:mt-56">
          <Reveal>
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div className="flex flex-col gap-2">
                <span className="tabular-nums-mono text-xs uppercase tracking-[0.12em] text-muted-foreground">
                  On-Chain Deployment
                </span>
                <h2 className="font-display text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
                  {ACTIVE_NETWORK.isLive
                    ? `Live on ${ACTIVE_NETWORK.name}.`
                    : `${ACTIVE_NETWORK.name} deployment pending.`}
                </h2>
              </div>
              <span className="glass-pill inline-flex w-fit items-center gap-2 rounded-full px-4 py-2 text-xs text-muted-foreground">
                Manifest-driven · 1-file mainnet swap
              </span>
            </div>

            <div className="mt-10 overflow-hidden rounded-[22px] border border-border bg-card">
              {CORE_CONTRACTS.map((item, idx) => (
                <div key={item.name}>
                  {idx > 0 && <Separator />}
                  {ACTIVE_NETWORK.isLive ? (
                    <a
                      href={explorerAddressUrl(item.address)}
                      target="_blank"
                      rel="noreferrer"
                      className="group flex flex-col justify-between gap-2 px-7 py-5 transition-colors hover:bg-accent/50 sm:flex-row sm:items-center"
                    >
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium text-foreground">{item.name}</span>
                        <span className="text-xs text-muted-foreground">{item.note}</span>
                      </div>
                      <div className="inline-flex items-center gap-2">
                        <span className="tabular-nums-mono text-xs text-muted-foreground group-hover:text-foreground">
                          {shortAddr(item.address)}
                        </span>
                        <ArrowUpRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground" />
                      </div>
                    </a>
                  ) : (
                    <div className="flex flex-col justify-between gap-2 px-7 py-5 sm:flex-row sm:items-center">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium text-foreground">{item.name}</span>
                        <span className="text-xs text-muted-foreground">{item.note}</span>
                      </div>
                      <span className="tabular-nums-mono text-xs text-muted-foreground">
                        Pending deployment
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        {/* 7. Questions, answered. (Ethena-style Single-Column Accordion) */}
        <section className="mt-48 sm:mt-56">
          <Reveal className="mx-auto max-w-3xl">
            <h2 className="font-display text-center text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">
              Questions, <span className="text-muted-foreground">answered.</span>
            </h2>

            <div className="mt-12 flex flex-col gap-3">
              {FAQS.map((item, idx) => {
                const isOpen = openFaq === idx;
                return (
                  <div
                    key={item.q}
                    className="overflow-hidden rounded-[18px] border border-border bg-card transition-colors duration-200 hover:border-foreground/20"
                  >
                    <button
                      type="button"
                      onClick={() => setOpenFaq(isOpen ? null : idx)}
                      aria-expanded={isOpen}
                      className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left cursor-pointer"
                    >
                      <span className="text-sm font-medium text-foreground sm:text-base">
                        {item.q}
                      </span>
                      <Plus
                        className={cn(
                          "size-4 shrink-0 text-muted-foreground transition-transform duration-300 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
                          isOpen && "rotate-45 text-foreground",
                        )}
                      />
                    </button>
                    <div
                      className={cn(
                        "grid transition-[grid-template-rows,opacity] duration-300 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
                        isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                      )}
                    >
                      <div className="overflow-hidden">
                        <p className="px-6 pb-6 text-sm leading-relaxed text-muted-foreground">
                          {item.a}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Reveal>
        </section>

        {/* 8. Closing Editorial CTA */}
        <section className="mt-48 sm:mt-56">
          <Reveal>
            <div className="flex flex-col items-center gap-6 rounded-[28px] border border-border bg-card px-8 py-20 text-center sm:px-16">
              <TrancheLogo className="scale-110" />
              <h2 className="font-display max-w-lg text-3xl font-semibold tracking-[-0.04em] text-foreground sm:text-5xl">
                Programmable execution for autonomous trading.
              </h2>
              <p className="max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
                Launch Tranche Agent to inspect dual-venue routing and risk controls, or open the
                Protocol Desk to reserve tickets and supply inventory on HashKey Chain.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                <Button
                  type="button"
                  size="lg"
                  onClick={() => onNavigate("/agent")}
                  className="h-12 rounded-full px-8 text-sm font-medium active:scale-[0.985] transition-transform cursor-pointer"
                >
                  Open Agent Console
                  <ArrowUpRight data-icon="inline-end" />
                </Button>
                <Button
                  type="button"
                  size="lg"
                  variant="outline"
                  onClick={handleLaunchApp}
                  className="h-12 rounded-full px-6 text-sm font-medium active:scale-[0.985] transition-transform cursor-pointer"
                >
                  Protocol Desk
                </Button>
              </div>
            </div>
          </Reveal>
        </section>
      </main>

      {/* Proper Architectural Footer */}
      <footer className="border-t border-border bg-card/40">
        <div className="mx-auto max-w-[1080px] px-6 pt-16 pb-12">
          <div className="grid grid-cols-2 gap-10 sm:grid-cols-12">
            <div className="col-span-2 flex flex-col items-start gap-4 sm:col-span-5">
              <TrancheLogo />
              <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
                Programmable execution infrastructure for autonomous trading on HashKey Chain —
                powering Tranche Agent and inventory-backed settlement.
              </p>
              <a
                href={ACTIVE_NETWORK.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="glass-pill glass-pill-interactive inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    ACTIVE_NETWORK.isLive ? "bg-status-live" : "bg-amber-400",
                  )}
                />
                <span className="tabular-nums-mono">
                  {ACTIVE_NETWORK.shortName} · Chain {ACTIVE_NETWORK.chainId}
                  {!ACTIVE_NETWORK.isLive ? " (Pending)" : ""}
                </span>
              </a>
            </div>

            <div className="flex flex-col gap-3 sm:col-span-2">
              <span className="text-xs font-medium text-foreground">Protocol</span>
              <ul className="flex flex-col gap-2.5 text-sm text-muted-foreground">
                <li>
                  <a href="#mechanism" className="transition-colors hover:text-foreground">
                    Mechanism
                  </a>
                </li>
                <li>
                  <a href="#sides" className="transition-colors hover:text-foreground">
                    Overview
                  </a>
                </li>
                <li>
                  <a href="#vault" className="transition-colors hover:text-foreground">
                    Segregated Vault
                  </a>
                </li>
                <li>
                  <a href="#contracts" className="transition-colors hover:text-foreground">
                    Contracts
                  </a>
                </li>
              </ul>
            </div>

            <div className="flex flex-col gap-3 sm:col-span-3">
              <span className="text-xs font-medium text-foreground">On-Chain</span>
              <ul className="flex flex-col gap-2.5 text-sm text-muted-foreground">
                {(
                  [
                    ["LiquidityVault", ACTIVE_NETWORK.contracts.liquidityVault],
                    ["CommitmentManager", ACTIVE_NETWORK.contracts.commitmentManager],
                    ["ExecutionTicket", ACTIVE_NETWORK.contracts.executionTicket],
                    ["TimelockController", ACTIVE_NETWORK.contracts.timelock],
                  ] as const
                ).map(([label, addr]) => (
                  <li key={label}>
                    {ACTIVE_NETWORK.isLive ? (
                      <a
                        href={explorerAddressUrl(addr)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
                      >
                        {label}
                        <ArrowUpRight className="size-3.5" />
                      </a>
                    ) : (
                      <span className="text-muted-foreground/70">{label} (Pending)</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex flex-col gap-3 sm:col-span-2">
              <span className="text-xs font-medium text-foreground">Resources</span>
              <ul className="flex flex-col gap-2.5 text-sm text-muted-foreground">
                <li>
                  <button
                    type="button"
                    onClick={() => onNavigate("/docs")}
                    className="transition-colors hover:text-foreground cursor-pointer"
                  >
                    Documentation
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => onNavigate("/privacy")}
                    className="transition-colors hover:text-foreground cursor-pointer"
                  >
                    Privacy Policy
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => onNavigate("/terms")}
                    className="transition-colors hover:text-foreground cursor-pointer"
                  >
                    Terms of Use
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => onNavigate("/agent")}
                    className="transition-colors hover:text-foreground cursor-pointer"
                  >
                    Agent Console
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={handleLaunchApp}
                    className="transition-colors hover:text-foreground cursor-pointer"
                  >
                    Protocol Desk
                  </button>
                </li>
                <li>
                  <a
                    href={ACTIVE_NETWORK.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
                  >
                    Blockscout
                    <ArrowUpRight className="size-3.5" />
                  </a>
                </li>
              </ul>
            </div>
          </div>

          <Separator className="my-10" />

          <div className="flex flex-col items-start justify-between gap-3 text-xs text-muted-foreground sm:flex-row sm:items-center">
            <span>© {new Date().getFullYear()} Tranche Protocol. All rights reserved.</span>
            <span className="tabular-nums-mono">
              {telemetry.blockNumber
                ? `Synced · Block #${telemetry.blockNumber.toLocaleString()}`
                : `HashKey Chain · ID ${ACTIVE_NETWORK.chainId}`}
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
