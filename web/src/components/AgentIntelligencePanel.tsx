import type { AgentIntelligenceSnapshot, DataProvenance } from "@/lib/agentApi";
import { cn } from "@/lib/utils";

interface AgentIntelligencePanelProps {
  intelligence: AgentIntelligenceSnapshot | null;
}

function fmtUsdt(raw: string | undefined | null): string {
  if (!raw) return "—";
  try {
    const val = Number(BigInt(raw)) / 1e6;
    if (!Number.isFinite(val)) return "—";
    return `$${val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } catch {
    return "—";
  }
}

function provenanceClass(p: DataProvenance): string {
  if (p === "LIVE") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-500";
  if (p === "FORK") return "border-blue-500/30 bg-blue-500/10 text-blue-500";
  if (p === "REPLAY") return "border-purple-500/30 bg-purple-500/10 text-purple-500";
  return "border-amber-500/30 bg-amber-500/10 text-amber-500";
}

function shortToken(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function AgentIntelligencePanel({ intelligence }: AgentIntelligencePanelProps) {
  if (!intelligence) return null;

  const { portfolio, adaptiveStrategy, latestVenueEvidence, positionIntegrity, evaluation } =
    intelligence;

  return (
    <section className="flex flex-col gap-4 rounded-[18px] border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            Portfolio &amp; Execution Intelligence
          </h3>
          <p className="text-xs text-muted-foreground">
            Real-time capital allocation, regime adaptation, venue evidence, and performance audit.
          </p>
        </div>
        <span
          className={cn(
            "tabular-nums-mono rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
            provenanceClass(intelligence.dataProvenance),
          )}
        >
          {intelligence.dataProvenance} DATA
        </span>
      </div>

      {/* Portfolio & Asset Exposure */}
      {portfolio && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-[12px] border border-border bg-background/60 p-3">
            <span className="text-[11px] text-muted-foreground">Available Balance</span>
            <div className="tabular-nums-mono mt-1 text-sm font-semibold text-foreground">
              {fmtUsdt(portfolio.availableBalancePayment)}
            </div>
          </div>
          <div className="rounded-[12px] border border-border bg-background/60 p-3">
            <span className="text-[11px] text-muted-foreground">Committed Capital</span>
            <div className="tabular-nums-mono mt-1 text-sm font-semibold text-foreground">
              {fmtUsdt(portfolio.totalCommittedCapitalPayment)}
            </div>
          </div>
          <div className="rounded-[12px] border border-border bg-background/60 p-3">
            <span className="text-[11px] text-muted-foreground">Available to Allocate</span>
            <div className="tabular-nums-mono mt-1 text-sm font-semibold text-foreground">
              {fmtUsdt(portfolio.availableCapitalForAllocationPayment)}
            </div>
          </div>
          <div className="rounded-[12px] border border-border bg-background/60 p-3">
            <span className="text-[11px] text-muted-foreground">Position State</span>
            <div className="mt-1 text-sm font-semibold text-foreground">
              {positionIntegrity
                ? positionIntegrity.healthy
                  ? "Healthy"
                  : `${positionIntegrity.issues.length} Issue(s)`
                : "Synced"}
            </div>
          </div>
        </div>
      )}

      {/* Asset Exposure Breakdown */}
      {portfolio && portfolio.assetExposures.length > 0 && (
        <div className="flex flex-col gap-2 rounded-[12px] border border-border bg-background/50 p-3.5 text-xs">
          <span className="font-medium text-foreground">Asset Exposure</span>
          <div className="flex flex-col gap-2">
            {portfolio.assetExposures.map((a) => (
              <div key={a.inventoryToken} className="flex items-center justify-between gap-3">
                <span className="tabular-nums-mono text-muted-foreground">
                  {shortToken(a.inventoryToken)} ({a.openPositionsCount} pos · {a.activeTicketsCount}{" "}
                  tix)
                </span>
                <span className="tabular-nums-mono font-medium text-foreground">
                  {fmtUsdt(a.totalCommittedPayment)} ({(a.allocationBps / 100).toFixed(1)}%)
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Adaptive Strategy & Cross-Venue Evidence */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="flex flex-col gap-1.5 rounded-[12px] border border-border bg-background/50 p-3.5 text-xs">
          <span className="font-medium text-foreground">Adaptive Strategy &amp; Regime</span>
          {adaptiveStrategy ? (
            <>
              <div className="flex justify-between text-muted-foreground">
                <span>Regime / Strategy</span>
                <span className="font-medium text-foreground">
                  {adaptiveStrategy.regime} → {adaptiveStrategy.selectedStrategyType}
                </span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Market Suitability</span>
                <span
                  className={cn(
                    "font-medium",
                    adaptiveStrategy.suitableForTrading ? "text-emerald-500" : "text-amber-500",
                  )}
                >
                  {adaptiveStrategy.suitableForTrading ? "Suitable" : "Unsuitable (WAIT)"}
                </span>
              </div>
              {adaptiveStrategy.unsuitableReasons.length > 0 && (
                <p className="mt-1 text-[11px] text-amber-500">
                  {adaptiveStrategy.unsuitableReasons.join("; ")}
                </p>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">
              Regime: {intelligence.marketRegime ?? "Awaiting cycle"}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1.5 rounded-[12px] border border-border bg-background/50 p-3.5 text-xs">
          <span className="font-medium text-foreground">Venue Decision Evidence</span>
          {latestVenueEvidence ? (
            <>
              <div className="flex justify-between text-muted-foreground">
                <span>Complete Cost (Tranche / AMM)</span>
                <span className="tabular-nums-mono font-medium text-foreground">
                  {fmtUsdt(latestVenueEvidence.trancheCompleteCostPayment)} /{" "}
                  {fmtUsdt(latestVenueEvidence.hskswapCompleteCostPayment)}
                </span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Advantage · Quote Age</span>
                <span className="tabular-nums-mono font-medium text-foreground">
                  {fmtUsdt(latestVenueEvidence.costAdvantagePayment)} (
                  {latestVenueEvidence.costAdvantageBps} bps) · {latestVenueEvidence.quoteAgeSec}s
                </span>
              </div>
            </>
          ) : (
            <span className="text-muted-foreground">Awaiting venue evaluation cycle</span>
          )}
        </div>
      </div>

      {/* Evaluation Metrics (strictly measured, never simulated) */}
      <div className="grid grid-cols-2 gap-3 border-t border-border pt-3 text-xs sm:grid-cols-3 lg:grid-cols-5">
        <div>
          <span className="text-[11px] text-muted-foreground">Net P&amp;L (After Fees)</span>
          <div className="tabular-nums-mono mt-0.5 font-semibold text-foreground">
            {fmtUsdt(evaluation.netPnlAfterFeesPayment)}
          </div>
        </div>
        <div>
          <span className="text-[11px] text-muted-foreground">Max Drawdown</span>
          <div className="tabular-nums-mono mt-0.5 font-semibold text-foreground">
            {(evaluation.maxDrawdownBps / 100).toFixed(2)}%
          </div>
        </div>
        <div>
          <span className="text-[11px] text-muted-foreground">Win / Loss</span>
          <div className="tabular-nums-mono mt-0.5 font-semibold text-foreground">
            {evaluation.wins}W / {evaluation.losses}L
          </div>
        </div>
        <div>
          <span className="text-[11px] text-muted-foreground">Venue Accuracy</span>
          <div className="tabular-nums-mono mt-0.5 font-semibold text-foreground">
            {evaluation.venueSelectionAccuracyBps !== null
              ? `${(evaluation.venueSelectionAccuracyBps / 100).toFixed(1)}%`
              : "Insufficient sample"}
          </div>
        </div>
        <div>
          <span className="text-[11px] text-muted-foreground">Sharpe Ratio</span>
          <div className="tabular-nums-mono mt-0.5 font-semibold text-foreground">
            {evaluation.sharpeRatio !== null ? evaluation.sharpeRatio : "n < 5"}
          </div>
        </div>
      </div>
    </section>
  );
}
