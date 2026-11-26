import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Lock, ShieldCheck, Sparkles, Waves } from "lucide-react";
import { ACTIVE_NETWORK, explorerTxUrl } from "@/config/networks";
import { getTokenMeta } from "@/config/tokens";
import { cn } from "@/lib/utils";

type StageIndex = 0 | 1 | 2;

const INV_SYMBOL = getTokenMeta(ACTIVE_NETWORK.contracts.WETH).symbol;
const PAY_SYMBOL = getTokenMeta(ACTIVE_NETWORK.contracts.USDT).symbol;

const STAGES: {
  stage: StageIndex;
  num: string;
  label: string;
  headlineLead: string;
  headlineMuted: string;
  body: string;
}[] = [
  {
    stage: 0,
    num: "01",
    label: "Compare & Reserve",
    headlineLead: "Compare HSKSwap vs.",
    headlineMuted: "reserved inventory.",
    body: "On every cycle, Tranche Agent reads live HSKSwap V3 quotes, 30-minute TWAP, and LiquidityVault offers. When reserved inventory beats AMM price impact, it locks capacity with a bounded hold fee.",
  },
  {
    stage: 1,
    num: "02",
    label: "Enforce & Hold",
    headlineLead: "Code-enforced risk,",
    headlineMuted: "transferable rights.",
    body: "An independent RiskManager, authoritative kill switch, and ERC-721 Execution Ticket guard every trade — no LLM or stale quote can breach exposure caps, slippage ceilings, or daily loss limits.",
  },
  {
    stage: 2,
    num: "03",
    label: "Exercise or Unwind",
    headlineLead: "Settle at your price,",
    headlineMuted: "or unwind on HSKSwap.",
    body: "When execution economics confirm, the agent exercises at the locked price with zero AMM slippage — or lets the ticket expire for a bounded hold fee. Open positions unwind automatically via HSKSwap Router02.",
  },
];

function SerratedEdge({ fill }: { fill: string }) {
  return (
    <svg
      viewBox="0 0 440 32"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="block h-6 w-full -mt-[2px]"
    >
      <polygon points="0,0 440,0 440,32 330,4 220,32 110,4 0,32" style={{ fill }} />
    </svg>
  );
}

/** Card 01: Dual-Venue Quote Comparison Slip (Warm Archival Cream) */
function CompareQuoteCard() {
  return (
    <div className="flex w-full flex-col drop-shadow-[0_36px_80px_rgba(0,0,0,0.8)]">
      <div
        className="relative overflow-hidden rounded-t-[20px] px-7 pt-7 pb-6"
        style={{ backgroundColor: "#f8f7ee", color: "#050505" }}
      >
        {/* Top Row */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="font-display text-base font-extrabold tracking-[-0.04em]">
              tranche
            </span>
            <span className="tabular-nums-mono text-[10px] uppercase tracking-[0.1em] opacity-55">
              VENUE ROUTER · 01
            </span>
          </div>
          <span className="tabular-nums-mono inline-flex items-center gap-1 rounded-full bg-black px-2.5 py-0.5 text-[10px] font-semibold text-[#f8f7ee]">
            <Sparkles className="size-2.5" />
            TRANCHE WINS
          </span>
        </div>

        {/* Head-to-Head Venue Rows */}
        <div className="mt-6 flex flex-col gap-2.5">
          {/* Winning Tranche Route */}
          <div className="flex items-center justify-between rounded-[14px] border border-black/15 bg-black/[0.04] px-4 py-3.5">
            <div className="flex items-center gap-2.5">
              <span className="flex size-7 items-center justify-center rounded-full bg-black text-[#f8f7ee]">
                <Lock className="size-3.5" />
              </span>
              <div className="flex flex-col">
                <span className="text-xs font-bold">Tranche Reserved</span>
                <span className="tabular-nums-mono text-[10px] opacity-60">
                  0.01 {INV_SYMBOL} · 0.00% slippage
                </span>
              </div>
            </div>
            <div className="text-right">
              <div className="tabular-nums-mono text-sm font-bold">30.15 {PAY_SYMBOL}</div>
              <div className="tabular-nums-mono text-[10px] font-semibold text-emerald-700">
                Best all-in
              </div>
            </div>
          </div>

          {/* Compared HSKSwap Route */}
          <div className="flex items-center justify-between rounded-[14px] border border-dashed border-black/15 px-4 py-3 opacity-60">
            <div className="flex items-center gap-2.5">
              <span className="flex size-7 items-center justify-center rounded-full border border-black/20">
                <Waves className="size-3.5" />
              </span>
              <div className="flex flex-col">
                <span className="text-xs font-semibold">HSKSwap V3 AMM</span>
                <span className="tabular-nums-mono text-[10px]">+1.4% pool price impact</span>
              </div>
            </div>
            <div className="text-right">
              <div className="tabular-nums-mono text-sm font-semibold line-through">
                30.42 {PAY_SYMBOL}
              </div>
              <div className="tabular-nums-mono text-[10px] font-semibold text-red-700">
                +0.27 higher
              </div>
            </div>
          </div>
        </div>

        {/* Perforated Tear Line */}
        <div className="relative my-5 flex items-center">
          <span aria-hidden="true" className="absolute -left-9 size-4 rounded-full bg-background" />
          <div className="w-full border-t border-dashed border-black/15" />
          <span aria-hidden="true" className="absolute -right-9 size-4 rounded-full bg-background" />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between text-[11px] opacity-70">
          <span className="tabular-nums-mono">Hold fee: 0.15 {PAY_SYMBOL} (50 bps)</span>
          <span className="tabular-nums-mono font-semibold opacity-100">TWAP Verified</span>
        </div>
      </div>
      <SerratedEdge fill="#f8f7ee" />
    </div>
  );
}

/** Card 02: Code-Enforced RiskManager & ERC-721 Guard Stub (Brushed Obsidian Carbon) */
function RiskGuardCard() {
  const checks = [
    { label: "Exposure Ceiling", value: "12% / 100%", ok: true },
    { label: "Oracle Freshness", value: "4s · 12 bps dev", ok: true },
    { label: "Slippage Guard", value: "0 bps ≤ 100 bps", ok: true },
    { label: "Kill Switch", value: "ARMED · STANDBY", ok: true },
  ];

  return (
    <div className="flex w-full flex-col drop-shadow-[0_36px_80px_rgba(0,0,0,0.85)]">
      <div
        className="relative overflow-hidden rounded-t-[20px] px-7 pt-7 pb-6"
        style={{
          backgroundColor: "#121210",
          color: "#f8f7ee",
          borderTop: "1px solid rgba(248, 247, 238, 0.15)",
          borderLeft: "1px solid rgba(248, 247, 238, 0.1)",
          borderRight: "1px solid rgba(248, 247, 238, 0.1)",
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="font-display text-base font-extrabold tracking-[-0.04em]">
              tranche
            </span>
            <span className="tabular-nums-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              RISKMANAGER · 02
            </span>
          </div>
          <span className="tabular-nums-mono inline-flex items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-400">
            <ShieldCheck className="size-3" />
            4/4 PASSED
          </span>
        </div>

        {/* Code-Enforced Risk Checklist */}
        <div className="mt-6 flex flex-col divide-y divide-white/10">
          {checks.map((c) => (
            <div key={c.label} className="flex items-center justify-between py-2.5 text-xs">
              <span className="inline-flex items-center gap-2 font-medium text-foreground">
                <span className="flex size-4 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                  <Check className="size-2.5" />
                </span>
                {c.label}
              </span>
              <span className="tabular-nums-mono text-[11px] text-muted-foreground">{c.value}</span>
            </div>
          ))}
        </div>

        {/* Perforated Tear Line */}
        <div className="relative my-5 flex items-center">
          <span aria-hidden="true" className="absolute -left-9 size-4 rounded-full bg-background" />
          <div className="w-full border-t border-dashed border-white/15" />
          <span aria-hidden="true" className="absolute -right-9 size-4 rounded-full bg-background" />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="tabular-nums-mono">ERC-721 #001 · Transferable</span>
          <span className="tabular-nums-mono font-medium text-foreground">No LLM Override</span>
        </div>
      </div>
      <SerratedEdge fill="#121210" />
    </div>
  );
}

/** Card 03: Final Settlement & Auto-Unwind Receipt (Warm Archival Cream) */
function SettlementReceiptCard() {
  return (
    <div className="flex w-full flex-col drop-shadow-[0_36px_80px_rgba(0,0,0,0.8)]">
      <div
        className="relative overflow-hidden rounded-t-[20px] px-7 pt-7 pb-6"
        style={{ backgroundColor: "#f8f7ee", color: "#050505" }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="font-display text-base font-extrabold tracking-[-0.04em]">
              tranche
            </span>
            <span className="tabular-nums-mono text-[10px] uppercase tracking-[0.1em] opacity-55">
              SETTLEMENT · 03
            </span>
          </div>
          <span className="tabular-nums-mono inline-flex items-center gap-1 rounded-full bg-emerald-700 px-2.5 py-0.5 text-[10px] font-semibold text-white">
            <Check className="size-2.5" />
            EXERCISED
          </span>
        </div>

        {/* Giant Settlement Figures */}
        <div className="mt-6 flex items-baseline justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.1em] opacity-55">
              Delivered
            </span>
            <span className="tabular-nums-mono font-display text-3xl font-bold tracking-tight">
              0.01 <span className="text-base font-medium opacity-70">{INV_SYMBOL}</span>
            </span>
          </div>
          <div className="flex flex-col items-end gap-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.1em] opacity-55">
              Paid at Strike
            </span>
            <span className="tabular-nums-mono font-display text-xl font-bold">
              30.00 <span className="text-xs font-medium opacity-65">{PAY_SYMBOL}</span>
            </span>
          </div>
        </div>

        {/* Two-Path Unwind Pill */}
        <div className="mt-5 grid grid-cols-2 gap-2 text-[11px]">
          <div className="rounded-[12px] border border-black/15 bg-black/[0.04] px-3 py-2.5">
            <span className="block text-[10px] uppercase tracking-wider opacity-55">
              Take-Profit / SL
            </span>
            <span className="tabular-nums-mono font-semibold">HSKSwap Router02</span>
          </div>
          <div className="rounded-[12px] border border-black/15 bg-black/[0.04] px-3 py-2.5">
            <span className="block text-[10px] uppercase tracking-wider opacity-55">
              If Unexercised
            </span>
            <span className="tabular-nums-mono font-semibold">Max loss = 0.15</span>
          </div>
        </div>

        {/* Perforated Tear Line */}
        <div className="relative my-5 flex items-center">
          <span aria-hidden="true" className="absolute -left-9 size-4 rounded-full bg-background" />
          <div className="w-full border-t border-dashed border-black/15" />
          <span aria-hidden="true" className="absolute -right-9 size-4 rounded-full bg-background" />
        </div>

        {/* Live Proof Row */}
        <div className="flex items-center justify-between text-[11px]">
          <span className="tabular-nums-mono opacity-60">
            Chain {ACTIVE_NETWORK.chainId} · Ticket Burned
          </span>
          {ACTIVE_NETWORK.liveExerciseProofTx ? (
            <a
              href={explorerTxUrl(ACTIVE_NETWORK.liveExerciseProofTx)}
              target="_blank"
              rel="noreferrer"
              className="tabular-nums-mono inline-flex items-center gap-1 font-semibold underline-offset-4 hover:underline"
            >
              Verify Proof
              <ArrowUpRight className="size-3" />
            </a>
          ) : (
            <span className="tabular-nums-mono opacity-60">Pending Mainnet</span>
          )}
        </div>
      </div>
      <SerratedEdge fill="#f8f7ee" />
    </div>
  );
}

export function StickyLifecycleStage() {
  const sectionRef = useRef<HTMLElement>(null);
  const [activeStage, setActiveStage] = useState<StageIndex>(0);

  useEffect(() => {
    let rafId = 0;

    const updateStage = () => {
      const el = sectionRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const scrollable = el.offsetHeight - window.innerHeight;
      if (scrollable <= 0) return;

      const progress = Math.min(1, Math.max(0, -rect.top / scrollable));
      const next: StageIndex = progress < 0.34 ? 0 : progress < 0.68 ? 1 : 2;
      setActiveStage((prev) => (prev === next ? prev : next));
    };

    const onScroll = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(updateStage);
    };

    updateStage();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  function jumpToStage(target: StageIndex) {
    setActiveStage(target);
    const el = sectionRef.current;
    if (!el) return;
    const scrollable = el.offsetHeight - window.innerHeight;
    if (scrollable <= 0) return;
    const ratios = [0.05, 0.5, 0.92];
    const targetTop = el.offsetTop + scrollable * ratios[target];
    window.scrollTo({ top: targetTop, behavior: "smooth" });
  }

  const cards: { stage: StageIndex; node: React.ReactNode }[] = [
    { stage: 0, node: <CompareQuoteCard /> },
    { stage: 1, node: <RiskGuardCard /> },
    { stage: 2, node: <SettlementReceiptCard /> },
  ];

  return (
    <section
      id="mechanism"
      ref={sectionRef}
      className="relative mt-24 lg:h-[285vh] scroll-mt-24"
    >
      <div className="lg:sticky lg:top-0 lg:flex lg:min-h-screen lg:items-center">
        <div className="mx-auto grid w-full max-w-[1080px] grid-cols-1 items-center gap-16 px-6 py-28 lg:grid-cols-12 lg:gap-16">
          {/* Left: Expanding Numbered Pill Stepper + Cross-Fading Two-Tone Headline */}
          <div className="flex flex-col items-start gap-10 lg:col-span-6">
            <div className="flex items-center gap-3" role="tablist" aria-label="Lifecycle steps">
              {STAGES.map((item) => {
                const isActive = item.stage === activeStage;
                return (
                  <button
                    key={item.num}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => jumpToStage(item.stage)}
                    className={cn(
                      "inline-flex h-11 items-center justify-center rounded-full border text-xs font-medium will-change-[background-color,color,border-color,padding] transition-all duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] cursor-pointer",
                      isActive
                        ? "border-primary bg-primary px-5 text-primary-foreground"
                        : "glass-pill glass-pill-interactive w-11 px-0 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <span className="tabular-nums-mono">{item.num}</span>
                    {isActive && <span className="ml-2 whitespace-nowrap">{item.label}</span>}
                  </button>
                );
              })}
            </div>

            {/* Layered cross-fade stack */}
            <div className="relative min-h-[210px] w-full sm:min-h-[230px]">
              {STAGES.map((item) => {
                const isActive = item.stage === activeStage;
                return (
                  <div
                    key={item.stage}
                    aria-hidden={!isActive}
                    className={cn(
                      "absolute inset-0 flex flex-col gap-5 will-change-[transform,opacity] transition-[transform,opacity] duration-600 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
                      isActive
                        ? "translate-y-0 opacity-100 pointer-events-auto"
                        : item.stage < activeStage
                          ? "-translate-y-4 opacity-0 pointer-events-none"
                          : "translate-y-4 opacity-0 pointer-events-none",
                    )}
                  >
                    <h2 className="font-display text-4xl font-semibold leading-[1.03] tracking-[-0.04em] text-foreground sm:text-5xl">
                      {item.headlineLead}
                      <br />
                      <span className="text-muted-foreground">{item.headlineMuted}</span>
                    </h2>
                    <p className="max-w-md text-base leading-relaxed text-muted-foreground">
                      {item.body}
                    </p>
                  </div>
                );
              })}
            </div>

            {/* Scroll progress bar */}
            <div className="flex items-center gap-2.5 pt-2">
              {STAGES.map((s) => (
                <span
                  key={s.num}
                  className={cn(
                    "h-1 rounded-full transition-all duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
                    s.stage === activeStage ? "w-12 bg-primary" : "w-3 bg-border",
                  )}
                />
              ))}
            </div>
          </div>

          {/* Right: 3D Morphing Stacked Deck of 3 Distinct Serrated Instrument Cards */}
          <div className="flex justify-center lg:col-span-6 lg:justify-end">
            <div className="relative h-[400px] w-full max-w-[430px] [perspective:1200px]">
              {cards.map((c) => {
                const isActive = c.stage === activeStage;
                const isPast = c.stage < activeStage;
                return (
                  <div
                    key={c.stage}
                    aria-hidden={!isActive}
                    className={cn(
                      "absolute inset-0 flex items-center will-change-[transform,opacity] transition-all duration-700 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
                      isActive
                        ? "z-20 translate-y-0 scale-100 opacity-100 pointer-events-auto"
                        : isPast
                          ? "z-10 -translate-y-12 scale-[0.92] opacity-0 pointer-events-none"
                          : "z-10 translate-y-12 scale-[0.94] opacity-0 pointer-events-none",
                    )}
                  >
                    {c.node}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
