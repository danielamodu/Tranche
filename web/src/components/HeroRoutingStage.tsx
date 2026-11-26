import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUpRight, Bot, Waves } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TicketSpecimen } from "@/components/TicketSpecimen";
import { cn } from "@/lib/utils";

interface HeroRoutingStageProps {
  onLaunchApp: () => void;
}

type CyclePhase = 0 | 1 | 2; // 0 = SCANNING, 1 = COMPARING, 2 = ROUTED_TRANCHE

export function HeroRoutingStage({ onLaunchApp }: HeroRoutingStageProps) {
  const containerRef = useRef<HTMLElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const layerARef = useRef<HTMLDivElement>(null);
  const leftNodeRef = useRef<HTMLDivElement>(null);
  const rightNodeRef = useRef<HTMLDivElement>(null);
  const exploreRef = useRef<HTMLButtonElement>(null);
  const layerBRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<CyclePhase>(0);

  // Live 3-phase routing choreography (every 2.3s), paused when offscreen or tab hidden
  useEffect(() => {
    const el = containerRef.current;
    let inView = true;

    const io =
      el && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            (entries) => {
              inView = entries[0]?.isIntersecting ?? true;
            },
            { threshold: 0.01 },
          )
        : null;
    if (el && io) io.observe(el);

    const id = setInterval(() => {
      if (!inView || (typeof document !== "undefined" && document.hidden)) return;
      setPhase((prev) => ((prev + 1) % 3) as CyclePhase);
    }, 2300);

    return () => {
      clearInterval(id);
      io?.disconnect();
    };
  }, []);

  // Zero-re-render GPU-composited scroll-scrubbed transition from Illustration -> Trade Statement
  useEffect(() => {
    let rafId = 0;
    const update = () => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const scrollable = el.offsetHeight - window.innerHeight;
      const p = scrollable <= 0 ? 0 : Math.min(1, Math.max(0, -rect.top / scrollable));

      const heroOut = Math.min(1, p / 0.55);
      const textIn = Math.min(1, Math.max(0, (p - 0.35) / 0.48));

      if (glowRef.current) {
        glowRef.current.style.opacity = String(1 - heroOut * 0.35);
      }
      if (layerARef.current) {
        layerARef.current.style.opacity = String(1 - heroOut);
        layerARef.current.style.transform = `translate3d(0, ${-heroOut * 48}px, 0) scale(${1 - heroOut * 0.08})`;
        layerARef.current.style.pointerEvents = heroOut > 0.7 ? "none" : "auto";
      }
      if (leftNodeRef.current) {
        leftNodeRef.current.style.transform = `translate3d(${-heroOut * 56}px, 0, 0)`;
      }
      if (rightNodeRef.current) {
        rightNodeRef.current.style.transform = `translate3d(${heroOut * 56}px, 0, 0)`;
      }
      if (exploreRef.current) {
        exploreRef.current.style.opacity = String(Math.max(0, 1 - heroOut * 2.2));
        exploreRef.current.style.transform = `translate3d(0, ${heroOut * 16}px, 0)`;
        exploreRef.current.style.pointerEvents = heroOut > 0.4 ? "none" : "auto";
      }
      if (layerBRef.current) {
        layerBRef.current.style.opacity = String(textIn);
        layerBRef.current.style.transform = `translate3d(0, ${(1 - textIn) * 56}px, 0) scale(${0.96 + textIn * 0.04})`;
        layerBRef.current.style.pointerEvents = textIn < 0.5 ? "none" : "auto";
      }
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

  function scrollToTradeStatement() {
    const el = containerRef.current;
    if (!el) return;
    const scrollable = el.offsetHeight - window.innerHeight;
    window.scrollTo({
      top: el.offsetTop + Math.max(0, scrollable * 0.92),
      behavior: "smooth",
    });
  }

  const isScanning = phase === 0;
  const isComparing = phase === 1;
  const isRouted = phase === 2;

  return (
    <section
      ref={containerRef}
      className="relative h-[195svh]"
    >
      <div className="sticky top-0 flex h-[100svh] w-full flex-col items-center justify-center overflow-hidden px-6">
        {/* Dynamic Studio Rim Glow */}
        <div
          ref={glowRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[85vh] transition-opacity duration-500"
          style={{
            opacity: 1,
            background:
              "radial-gradient(50% 45% at 50% 44%, rgba(248, 247, 238, 0.11) 0%, rgba(248, 247, 238, 0) 100%)",
          }}
        />

        {/* LAYER A: Live Choreographed Dual-Venue Routing Illustration (parts & fades on scroll) */}
        <div
          ref={layerARef}
          className="relative z-10 flex w-full max-w-[1080px] flex-col items-center justify-center gap-6 will-change-transform lg:flex-row lg:gap-0"
          style={{
            opacity: 1,
            transform: "translate3d(0, 0, 0) scale(1)",
            pointerEvents: "auto",
          }}
        >
          {/* Left Node: Tranche Agent */}
          <div
            ref={leftNodeRef}
            className={cn(
              "flex w-full max-w-[244px] flex-col gap-2.5 rounded-[18px] border bg-card/90 p-4 backdrop-blur-md transition-all duration-500 lg:w-[238px] lg:shrink-0",
              isScanning
                ? "border-foreground/45 shadow-[0_0_32px_rgba(248,247,238,0.12)]"
                : isRouted
                  ? "border-emerald-500/45 shadow-[0_0_32px_rgba(74,222,128,0.14)]"
                  : "border-border/90",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="inline-flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Bot className="size-3.5" />
              </span>
              <span
                className={cn(
                  "tabular-nums-mono inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors duration-300",
                  isRouted
                    ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
                    : isComparing
                      ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
                      : "border-foreground/25 bg-accent text-foreground",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 animate-pulse rounded-full",
                    isRouted ? "bg-emerald-400" : isComparing ? "bg-amber-400" : "bg-foreground",
                  )}
                />
                {isScanning ? "SCANNING" : isComparing ? "COMPARING" : "ROUTED"}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-display text-sm font-semibold text-foreground">
                Tranche Agent
              </span>
              <span className="text-[11px] leading-snug text-muted-foreground">
                {isScanning
                  ? "Quoting Tranche & HSKSwap…"
                  : isComparing
                    ? "Checking gas, slippage & risk…"
                    : "Locked best all-in route"}
              </span>
            </div>
            <div className="flex items-center justify-between border-t border-border/80 pt-2 text-[10px] text-muted-foreground">
              <span className="tabular-nums-mono">Decision</span>
              <span
                className={cn(
                  "tabular-nums-mono font-semibold transition-colors duration-300",
                  isRouted ? "text-emerald-400" : "text-foreground",
                )}
              >
                {isScanning ? "EVALUATING…" : isComparing ? "TRANCHE −0.27" : "TRANCHE ✓"}
              </span>
            </div>
          </div>

          {/* Animated Active Beam with Traveling Light Orb (Agent -> Ticket) */}
          <div aria-hidden="true" className="relative hidden w-16 shrink-0 items-center lg:flex">
            <svg viewBox="0 0 72 24" className="h-6 w-full overflow-visible">
              <line
                x1="0"
                y1="12"
                x2="66"
                y2="12"
                stroke="currentColor"
                strokeWidth={isRouted ? "2" : "1.5"}
                strokeDasharray="5 5"
                className={cn(
                  "animate-dash-flow transition-colors duration-300",
                  isRouted ? "text-emerald-400" : "text-foreground/75",
                )}
              />
              <circle
                cx="68"
                cy="12"
                r={isRouted ? "4.5" : "3"}
                className={cn(
                  "transition-all duration-300",
                  isRouted ? "fill-emerald-400" : "fill-primary",
                )}
              />
            </svg>
            {/* Glowing traveling packet */}
            <span
              className={cn(
                "animate-packet-right absolute left-0 top-1/2 -mt-1.5 size-3 rounded-full blur-[1px]",
                isRouted
                  ? "bg-emerald-400 shadow-[0_0_12px_#4ade80]"
                  : "bg-primary shadow-[0_0_10px_#f8f7ee]",
              )}
            />
          </div>

          {/* Center Focal Artifact: Serrated Cream Execution Ticket */}
          <div
            className={cn(
              "w-full max-w-[388px] shrink-0 transition-transform duration-700 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
              isRouted ? "-translate-y-2 scale-[1.03]" : "translate-y-0 scale-100",
            )}
          >
            <TicketSpecimen stage={isRouted ? 2 : isComparing ? 1 : 0} mode="FIXED" />
          </div>

          {/* Right Comparison Beam (Ticket <- HSKSwap AMM) */}
          <div aria-hidden="true" className="relative hidden w-16 shrink-0 items-center lg:flex">
            <svg viewBox="0 0 72 24" className="h-6 w-full overflow-visible">
              <line
                x1="6"
                y1="12"
                x2="72"
                y2="12"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeDasharray="3 5"
                className={cn(
                  "transition-colors duration-300",
                  isScanning ? "animate-dash-flow text-foreground/55" : "text-muted-foreground/30",
                )}
              />
              <circle
                cx="4"
                cy="12"
                r="2.5"
                className={cn(
                  "transition-colors duration-300",
                  isScanning ? "fill-foreground/70" : "fill-muted-foreground/40",
                )}
              />
            </svg>
          </div>

          {/* Right Node: HSKSwap V3 AMM (Quotes -> Rejected/Skipped) */}
          <div
            ref={rightNodeRef}
            className={cn(
              "flex w-full max-w-[244px] flex-col gap-2.5 rounded-[18px] border p-4 backdrop-blur-md transition-all duration-500 lg:w-[238px] lg:shrink-0",
              isScanning
                ? "border-foreground/30 bg-card/80 opacity-95"
                : "border-border/60 bg-card/45 opacity-55",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="inline-flex size-7 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
                <Waves className="size-3.5" />
              </span>
              <span
                className={cn(
                  "tabular-nums-mono rounded-full border px-2 py-0.5 text-[10px] transition-colors duration-300",
                  isScanning
                    ? "border-foreground/25 text-foreground"
                    : "border-destructive/30 bg-destructive/10 text-destructive",
                )}
              >
                {isScanning ? "QUOTING" : "SKIPPED"}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-display text-sm font-semibold text-foreground">
                HSKSwap V3 Pool
              </span>
              <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                30.42 tUSDT · +1.4% slippage
              </span>
            </div>
            <div className="flex items-center justify-between border-t border-border/70 pt-2 text-[10px] text-muted-foreground">
              <span>All-in delta</span>
              <span className="tabular-nums-mono text-destructive">+0.27 tUSDT</span>
            </div>
          </div>
        </div>

        {/* Scroll Transition Trigger Button */}
        <button
          ref={exploreRef}
          type="button"
          onClick={scrollToTradeStatement}
          className="absolute bottom-8 z-20 inline-flex items-center gap-2 rounded-full border border-border/70 bg-card/70 px-4 py-2 text-[11px] font-medium text-muted-foreground backdrop-blur-md transition-all duration-300 hover:border-foreground/35 hover:text-foreground cursor-pointer"
          style={{
            opacity: 1,
            transform: "translate3d(0, 0, 0)",
            pointerEvents: "auto",
          }}
        >
          <span className="tabular-nums-mono uppercase tracking-[0.12em]">Explore</span>
          <ArrowDown className="size-3 animate-bounce" />
        </button>

        {/* LAYER B: Dedicated Trade Statement Section (morphs smoothly into center focus on scroll) */}
        <div
          ref={layerBRef}
          id="trade-statement"
          className="absolute inset-x-0 z-20 mx-auto w-full max-w-[1080px] px-6 will-change-transform"
          style={{
            opacity: 0,
            transform: "translate3d(0, 56px, 0) scale(0.96)",
            pointerEvents: "none",
          }}
        >
          <div className="grid grid-cols-1 items-end gap-10 lg:grid-cols-12">
            <h1 className="font-display text-[2.85rem] font-bold leading-[0.98] tracking-[-0.045em] text-foreground sm:text-[4.6rem] lg:col-span-7">
              <span className="block">Trade autonomously.</span>
              <span className="block text-muted-foreground">Route across two venues.</span>
            </h1>

            <div className="flex flex-col items-start gap-6 lg:col-span-5 lg:items-end lg:text-right">
              <p className="max-w-[400px] text-base leading-relaxed text-muted-foreground">
                The autonomous trading agent on HashKey Chain that compares HSKSwap V3 pools against
                on-chain reserved inventory — routing every trade to the better venue, or walking
                away.
              </p>
              <Button
                type="button"
                size="lg"
                onClick={onLaunchApp}
                className="h-12 rounded-full px-7 text-sm font-medium active:scale-[0.985] transition-transform cursor-pointer"
              >
                Launch App
                <ArrowUpRight data-icon="inline-end" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
