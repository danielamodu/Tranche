import { useEffect, useRef, useState } from "react";
import { TicketSpecimen, type SpecimenMode, type SpecimenStage } from "@/components/TicketSpecimen";
import { cn } from "@/lib/utils";

const STAGES: {
  stage: SpecimenStage;
  num: string;
  label: string;
  headlineLead: string;
  headlineMuted: string;
  body: string;
}[] = [
  {
    stage: 0,
    num: "01",
    label: "Reserve",
    headlineLead: "Lock the exact size",
    headlineMuted: "before you move.",
    body: "Pick an LP offer and pay a small upfront reservation premium. LiquidityVault physically segregates your tokens immediately — no AMM curve, no front-running.",
  },
  {
    stage: 1,
    num: "02",
    label: "Hold Ticket",
    headlineLead: "Your commitment is",
    headlineMuted: "a bearer ERC-721.",
    body: "ExecutionTicket mints straight to your wallet. Hold it while you arrange capital, split it into smaller lots, or transfer the execution right before expiry.",
  },
  {
    stage: 2,
    num: "03",
    label: "Exercise",
    headlineLead: "Settle at your price,",
    headlineMuted: "partially or in full.",
    body: "Pay the locked strike or oracle-bounded quote anytime before the countdown ends. Unused inventory returns cleanly to the LP once a ticket expires.",
  },
];

export function StickyLifecycleStage() {
  const sectionRef = useRef<HTMLElement>(null);
  const [activeStage, setActiveStage] = useState<SpecimenStage>(0);
  const [mode, setMode] = useState<SpecimenMode>("FIXED");

  useEffect(() => {
    let rafId = 0;

    const updateStage = () => {
      const el = sectionRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const scrollable = el.offsetHeight - window.innerHeight;
      if (scrollable <= 0) return;

      const progress = Math.min(1, Math.max(0, -rect.top / scrollable));
      const next: SpecimenStage = progress < 0.34 ? 0 : progress < 0.68 ? 1 : 2;
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

  function jumpToStage(target: SpecimenStage) {
    setActiveStage(target);
    const el = sectionRef.current;
    if (!el) return;
    const scrollable = el.offsetHeight - window.innerHeight;
    if (scrollable <= 0) return;
    const ratios = [0.05, 0.5, 0.92];
    const targetTop = el.offsetTop + scrollable * ratios[target];
    window.scrollTo({ top: targetTop, behavior: "smooth" });
  }

  return (
    <section
      id="mechanism"
      ref={sectionRef}
      className="relative mt-24 lg:h-[285vh] scroll-mt-24"
    >
      <div className="lg:sticky lg:top-0 lg:flex lg:min-h-screen lg:items-center">
        <div className="mx-auto grid w-full max-w-[1080px] grid-cols-1 items-center gap-16 px-6 py-28 lg:grid-cols-12 lg:gap-16">
          {/* Left: Jeton-style Expanding Numbered Pill Stepper + Cross-Fading Two-Tone Headline */}
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

            {/* Layered cross-fade stack (zero DOM unmount pop, silky opacity + translateY) */}
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

            {/* Subtle scroll progress bar */}
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

          {/* Right: Pinned Serrated Ticket Transforming Across Stages & Physical Stocks */}
          <div className="flex justify-center lg:col-span-6 lg:justify-end">
            <TicketSpecimen
              stage={activeStage}
              mode={mode}
              onModeChange={setMode}
              showModeToggle
            />
          </div>
        </div>
      </div>
    </section>
  );
}
