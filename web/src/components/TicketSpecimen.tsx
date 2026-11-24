import { useRef, useState } from "react";
import { ArrowUpRight, Check, Lock, Repeat2 } from "lucide-react";
import { LIVE_EXERCISE_PROOF_TX, explorerTxUrl } from "@/config/networks";
import { cn } from "@/lib/utils";

export type SpecimenMode = "FIXED" | "FLOATING";
export type SpecimenStage = 0 | 1 | 2;

interface TicketSpecimenProps {
  mode?: SpecimenMode;
  onModeChange?: (mode: SpecimenMode) => void;
  stage?: SpecimenStage;
  showModeToggle?: boolean;
  className?: string;
}

const STAGE_META: Record<
  SpecimenStage,
  {
    badge: string;
    overhangTitle: string;
    overhangSub: string;
    windowLabel: string;
    icon: "lock" | "ticket" | "check";
  }
> = {
  0: {
    badge: "RESERVED",
    overhangTitle: "0.01 tWETH segregated",
    overhangSub: "0.00% AMM slippage · Exclusive lock",
    windowLabel: "10:00 remaining",
    icon: "lock",
  },
  1: {
    badge: "ACTIVE · ERC-721",
    overhangTitle: "Ticket #001 minted",
    overhangSub: "Split, transfer, or hold until expiry",
    windowLabel: "06:42 remaining",
    icon: "ticket",
  },
  2: {
    badge: "EXERCISED",
    overhangTitle: "30.00 tUSDT settled",
    overhangSub: "0.01 tWETH delivered · Ticket burned",
    windowLabel: "Settled on Chain 133",
    icon: "check",
  },
};

export function TicketSpecimen({
  mode: controlledMode,
  onModeChange,
  stage = 2,
  showModeToggle = false,
  className,
}: TicketSpecimenProps) {
  const [internalMode, setInternalMode] = useState<SpecimenMode>("FIXED");
  const mode = controlledMode ?? internalMode;
  const setMode = onModeChange ?? setInternalMode;

  const cardRef = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ rx: 0, ry: 0, gx: 50, gy: 20, active: false });

  const isFixed = mode === "FIXED";
  const meta = STAGE_META[stage];

  // Physical stock shift: Warm archival cream paper (FIXED) vs brushed carbon obsidian vellum (FLOATING)
  const stockBg = isFixed ? "#f8f7ee" : "#121210";
  const stockFg = isFixed ? "#050505" : "#f8f7ee";
  const stockMuted = isFixed ? "rgba(5, 5, 5, 0.56)" : "rgba(248, 247, 238, 0.54)";
  const stockHairline = isFixed ? "rgba(5, 5, 5, 0.14)" : "rgba(248, 247, 238, 0.14)";
  const sheenColor = isFixed ? "rgba(255, 255, 255, 0.55)" : "rgba(248, 247, 238, 0.14)";

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    setTilt({
      rx: (0.5 - py) * 9,
      ry: (px - 0.5) * 11,
      gx: px * 100,
      gy: py * 100,
      active: true,
    });
  }

  function handlePointerLeave() {
    setTilt({ rx: 0, ry: 0, gx: 50, gy: 20, active: false });
  }

  return (
    <div className={cn("flex w-full max-w-[430px] flex-col items-center gap-5", className)}>
      {showModeToggle && (
        <div
          role="tablist"
          aria-label="Execution price mode"
          className="glass-pill relative grid w-[276px] grid-cols-2 items-center rounded-full p-1"
        >
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full bg-primary shadow-sm will-change-transform transition-transform duration-350 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)]",
              isFixed ? "translate-x-0" : "translate-x-full",
            )}
          />
          {(["FIXED", "FLOATING"] as const).map((item) => {
            const active = mode === item;
            return (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setMode(item)}
                className={cn(
                  "relative z-10 min-h-9 rounded-full px-3 text-xs font-medium tracking-wide transition-colors duration-200 cursor-pointer",
                  active
                    ? "text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item === "FIXED" ? "Fixed Paper" : "Floating Vellum"}
              </button>
            );
          })}
        </div>
      )}

      {/* Physical 3D-Tilt Serrated Tranche Execution Ticket Stub */}
      <div
        ref={cardRef}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        className="relative w-full pt-3 [perspective:1100px]"
      >
        <div
          style={{
            transform: `rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg) translateZ(0)`,
            transition: tilt.active
              ? "transform 110ms cubic-bezier(0.2, 0, 0, 1)"
              : "transform 520ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
          className="relative w-full will-change-transform drop-shadow-[0_36px_80px_rgba(0,0,0,0.82)]"
        >
          {/* Silhouette-breaking Apple Liquid Glass Overhang Pill (Ethena Pay inspired) */}
          <div
            key={`overhang-${stage}`}
            className="animate-rise glass-pill absolute -top-5 -right-2 z-20 flex items-center gap-2.5 rounded-full px-3.5 py-2 sm:-right-5"
          >
            <span className="flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
              {meta.icon === "lock" && <Lock className="size-3" />}
              {meta.icon === "ticket" && <Repeat2 className="size-3" />}
              {meta.icon === "check" && <Check className="size-3" />}
            </span>
            <div className="flex flex-col leading-tight">
              <span className="tabular-nums-mono text-[11px] font-medium text-foreground">
                {meta.overhangTitle}
              </span>
              <span className="text-[10px] text-muted-foreground">{meta.overhangSub}</span>
            </div>
          </div>

          <div
            className="relative overflow-hidden rounded-t-[20px] px-7 pt-8 pb-6 transition-colors duration-400 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]"
            style={{
              backgroundColor: stockBg,
              color: stockFg,
              borderTop: isFixed ? "none" : "1px solid rgba(248, 247, 238, 0.14)",
              borderLeft: isFixed ? "none" : "1px solid rgba(248, 247, 238, 0.1)",
              borderRight: isFixed ? "none" : "1px solid rgba(248, 247, 238, 0.1)",
            }}
          >
            {/* Dynamic specular light sheen following cursor */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 transition-opacity duration-300"
              style={{
                opacity: tilt.active ? 1 : 0,
                background: `radial-gradient(280px circle at ${tilt.gx}% ${tilt.gy}%, ${sheenColor}, transparent 65%)`,
              }}
            />

            {/* Top metadata row */}
            <div className="relative flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span
                  className="font-display text-lg font-extrabold tracking-[-0.04em]"
                  style={{ color: stockFg }}
                >
                  tranche
                </span>
                <span
                  className="tabular-nums-mono text-[11px] font-medium uppercase tracking-[0.08em]"
                  style={{ color: stockMuted }}
                >
                  ERC-721 · #001
                </span>
              </div>
              <span
                key={`badge-${stage}`}
                className="tabular-nums-mono inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium tracking-wider"
                style={{
                  border: `1px solid ${stockHairline}`,
                  color: stockFg,
                }}
              >
                {meta.badge}
              </span>
            </div>

            {/* Primary monetary readout (Ethena integer/decimal scale contrast) */}
            <div className="relative mt-7 flex items-baseline justify-between gap-4">
              <div className="flex flex-col gap-1">
                <span
                  className="text-[11px] font-medium uppercase tracking-[0.1em]"
                  style={{ color: stockMuted }}
                >
                  Reserved Inventory
                </span>
                <span className="tabular-nums-mono text-3xl font-semibold tracking-tight">
                  0.01 <span className="text-lg font-medium opacity-75">tWETH</span>
                </span>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span
                  className="text-[11px] font-medium uppercase tracking-[0.1em]"
                  style={{ color: stockMuted }}
                >
                  {isFixed ? "Locked Strike" : "Bounded Oracle"}
                </span>
                <span
                  key={mode}
                  className="animate-rise tabular-nums-mono text-xl font-semibold tracking-tight"
                >
                  {isFixed ? (
                    <>
                      $3,000<span className="text-sm opacity-60">.00</span>
                    </>
                  ) : (
                    "Spot + 50 bps"
                  )}
                </span>
              </div>
            </div>

            {/* Perforated tear line with semicircular ticket notches */}
            <div className="relative my-6 flex items-center">
              <span
                aria-hidden="true"
                className="absolute -left-9 size-4 rounded-full bg-background"
              />
              <div
                className="w-full border-t border-dashed"
                style={{ borderColor: stockHairline }}
              />
              <span
                aria-hidden="true"
                className="absolute -right-9 size-4 rounded-full bg-background"
              />
            </div>

            {/* Ledger details */}
            <dl className="relative grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
              <div className="flex flex-col gap-0.5">
                <dt style={{ color: stockMuted }}>Settlement Cost</dt>
                <dd key={`cost-${mode}`} className="animate-rise tabular-nums-mono font-medium">
                  {isFixed ? "30.00 tUSDT" : "29.40 – 30.90 tUSDT"}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5 text-right">
                <dt style={{ color: stockMuted }}>Upfront Premium</dt>
                <dd className="tabular-nums-mono font-medium">0.15 tUSDT (50 bps)</dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt style={{ color: stockMuted }}>Status Window</dt>
                <dd key={`win-${stage}`} className="animate-rise tabular-nums-mono font-medium">
                  {meta.windowLabel}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5 text-right">
                <dt style={{ color: stockMuted }}>Protocol Fee</dt>
                <dd className="tabular-nums-mono font-medium">0.05% (5 bps)</dd>
              </div>
            </dl>

            {/* Bottom live proof row */}
            <div
              className="relative mt-6 flex items-center justify-between pt-4 text-[11px]"
              style={{ borderTop: `1px solid ${stockHairline}` }}
            >
              <span className="tabular-nums-mono" style={{ color: stockMuted }}>
                Chain 133 · Segregated Vault
              </span>
              <a
                href={explorerTxUrl(LIVE_EXERCISE_PROOF_TX)}
                target="_blank"
                rel="noreferrer"
                className="tabular-nums-mono inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
                style={{ color: stockFg }}
              >
                Verify Proof
                <ArrowUpRight className="size-3" />
              </a>
            </div>
          </div>

          {/* Exact double-chevron serrated bottom edge matching the official Tranche logo */}
          <svg
            viewBox="0 0 440 32"
            preserveAspectRatio="none"
            aria-hidden="true"
            className="block h-7 w-full -mt-[2px] transition-colors duration-400"
          >
            <polygon
              points="0,0 440,0 440,32 330,4 220,32 110,4 0,32"
              style={{ fill: stockBg }}
            />
          </svg>
        </div>
      </div>
    </div>
  );
}
