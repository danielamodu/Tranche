import { useRef, useState } from "react";
import { ArrowUpRight, Check } from "lucide-react";
import { LIVE_EXERCISE_PROOF_TX, explorerTxUrl } from "@/config/networks";
import { cn } from "@/lib/utils";

type SpecimenMode = "FIXED" | "FLOATING";

export function TicketSpecimen() {
  const [mode, setMode] = useState<SpecimenMode>("FIXED");
  const cardRef = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ rx: 0, ry: 0, gx: 50, gy: 20, active: false });

  const isFixed = mode === "FIXED";

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
    <div className="flex flex-col items-center gap-5 w-full max-w-[440px] mx-auto">
      {/* True Apple iOS-style Sliding Liquid Glass Segmented Pill */}
      <div
        role="tablist"
        aria-label="Execution price mode"
        className="glass-pill relative grid grid-cols-2 items-center rounded-full p-1 w-[276px]"
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
                active ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item === "FIXED" ? "Fixed Price" : "Floating Oracle"}
            </button>
          );
        })}
      </div>

      {/* Physical 3D-Tilt Serrated Tranche Execution Ticket Stub */}
      <div
        ref={cardRef}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        className="w-full [perspective:1100px]"
      >
        <div
          style={{
            transform: `rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg) translateZ(0)`,
            transition: tilt.active
              ? "transform 110ms cubic-bezier(0.2, 0, 0, 1)"
              : "transform 520ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
          className="w-full will-change-transform drop-shadow-[0_30px_70px_rgba(0,0,0,0.78)]"
        >
          <div
            className="relative overflow-hidden rounded-t-[20px] px-7 pt-7 pb-6"
            style={{
              backgroundColor: "var(--ticket-bg)",
              color: "var(--ticket-fg)",
            }}
          >
            {/* Dynamic specular paper sheen following cursor */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 transition-opacity duration-300"
              style={{
                opacity: tilt.active ? 1 : 0,
                background: `radial-gradient(280px circle at ${tilt.gx}% ${tilt.gy}%, rgba(255, 255, 255, 0.55), transparent 65%)`,
              }}
            />

            {/* Top metadata row */}
            <div className="relative flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span
                  className="font-display text-lg font-extrabold tracking-[-0.04em]"
                  style={{ color: "var(--ticket-fg)" }}
                >
                  tranche
                </span>
                <span
                  className="tabular-nums-mono text-[11px] font-medium uppercase tracking-[0.08em]"
                  style={{ color: "var(--ticket-muted)" }}
                >
                  ERC-721 · #001
                </span>
              </div>
              <span
                className="tabular-nums-mono inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
                style={{
                  border: "1px solid var(--ticket-hairline)",
                  color: "var(--ticket-fg)",
                }}
              >
                <Check className="size-3" />
                EXERCISED
              </span>
            </div>

            {/* Primary monetary readout */}
            <div className="relative mt-7 flex items-baseline justify-between gap-4">
              <div className="flex flex-col gap-1">
                <span
                  className="text-[11px] font-medium uppercase tracking-[0.1em]"
                  style={{ color: "var(--ticket-muted)" }}
                >
                  Reserved Inventory
                </span>
                <span className="tabular-nums-mono text-3xl font-semibold tracking-tight">
                  0.01 tWETH
                </span>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span
                  className="text-[11px] font-medium uppercase tracking-[0.1em]"
                  style={{ color: "var(--ticket-muted)" }}
                >
                  {isFixed ? "Locked Strike" : "Bounded Oracle"}
                </span>
                <span
                  key={mode}
                  className="animate-rise tabular-nums-mono text-xl font-semibold tracking-tight"
                >
                  {isFixed ? "$3,000.00" : "Spot + 50 bps"}
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
                style={{ borderColor: "var(--ticket-hairline)" }}
              />
              <span
                aria-hidden="true"
                className="absolute -right-9 size-4 rounded-full bg-background"
              />
            </div>

            {/* Ledger details */}
            <dl className="relative grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
              <div className="flex flex-col gap-0.5">
                <dt style={{ color: "var(--ticket-muted)" }}>Settlement Cost</dt>
                <dd key={`cost-${mode}`} className="animate-rise tabular-nums-mono font-medium">
                  {isFixed ? "30.00 tUSDT" : "29.40 – 30.90 tUSDT"}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5 text-right">
                <dt style={{ color: "var(--ticket-muted)" }}>Upfront Premium</dt>
                <dd className="tabular-nums-mono font-medium">0.15 tUSDT (50 bps)</dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt style={{ color: "var(--ticket-muted)" }}>Lock Window</dt>
                <dd className="tabular-nums-mono font-medium">10 min · Partial OK</dd>
              </div>
              <div className="flex flex-col gap-0.5 text-right">
                <dt style={{ color: "var(--ticket-muted)" }}>Protocol Fee</dt>
                <dd className="tabular-nums-mono font-medium">0.05% (5 bps)</dd>
              </div>
            </dl>

            {/* Bottom live proof row */}
            <div
              className="relative mt-6 flex items-center justify-between pt-4 text-[11px]"
              style={{ borderTop: "1px solid var(--ticket-hairline)" }}
            >
              <span className="tabular-nums-mono" style={{ color: "var(--ticket-muted)" }}>
                Chain 133 · Segregated Vault
              </span>
              <a
                href={explorerTxUrl(LIVE_EXERCISE_PROOF_TX)}
                target="_blank"
                rel="noreferrer"
                className="tabular-nums-mono inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
                style={{ color: "var(--ticket-fg)" }}
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
            className="block h-7 w-full -mt-[2px]"
          >
            <polygon
              points="0,0 440,0 440,32 330,4 220,32 110,4 0,32"
              style={{ fill: "var(--ticket-bg)" }}
            />
          </svg>
        </div>
      </div>
    </div>
  );
}
