import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  OctagonAlert,
  Pause,
  Play,
  ShieldAlert,
  WifiOff,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  AgentApiClient,
  AgentApiError,
  type AgentDashboardSnapshot,
  type StrategyType,
} from "@/lib/agentApi";
import { cn } from "@/lib/utils";
import type { AppRoute } from "@/App";

interface AgentPageProps {
  onNavigate: (path: AppRoute) => void;
}

function fmtUsd6(raw: string | undefined | null): string {
  if (!raw) return "Unavailable";
  try {
    const val = Number(BigInt(raw)) / 1e6;
    if (!Number.isFinite(val)) return "Unavailable";
    return `$${val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  } catch {
    return "Unavailable";
  }
}

function fmtTime(sec: number | null | undefined): string {
  if (!sec) return "—";
  return new Date(sec * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function pctBar(numRaw: string, denRaw: string): number {
  try {
    const n = Number(BigInt(numRaw));
    const d = Number(BigInt(denRaw));
    if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((n / d) * 100)));
  } catch {
    return 0;
  }
}

export function AgentPage({ onNavigate }: AgentPageProps) {
  const [tokenInput, setTokenInput] = useState<string>(
    () => sessionStorage.getItem("tranche-agent-token") ?? "",
  );
  const client = useMemo(() => new AgentApiClient({ token: tokenInput }), [tokenInput]);

  const [snapshot, setSnapshot] = useState<AgentDashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const [killDialogOpen, setKillDialogOpen] = useState(false);

  // Strategy form state (synced from engine config on first load)
  const [strategyType, setStrategyType] = useState<StrategyType>("price_threshold");
  const [tpInput, setTpInput] = useState("500");
  const [slInput, setSlInput] = useState("300");
  const [slipInput, setSlipInput] = useState("100");
  const [formSynced, setFormSynced] = useState(false);

  const loadSnapshot = useCallback(
    async (isManual = false) => {
      if (isManual) setRefreshing(true);
      try {
        const data = await client.fetchSnapshot();
        setSnapshot(data);
        setDisconnected(false);
        setConnError(null);
        if (!formSynced) {
          setStrategyType(data.config.strategy.type);
          setTpInput(String(data.config.strategy.takeProfitBps));
          setSlInput(String(data.config.strategy.stopLossBps));
          setSlipInput(String(data.config.riskLimits.maxSlippageBps));
          setFormSynced(true);
        }
      } catch (err) {
        setDisconnected(true);
        setConnError(
          err instanceof Error
            ? err.message
            : `Local Agent API unreachable at ${client.getBaseUrl()}`,
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [client, formSynced],
  );

  useEffect(() => {
    void loadSnapshot(false);
    const id = setInterval(() => void loadSnapshot(false), 10_000);
    return () => clearInterval(id);
  }, [loadSnapshot]);

  function handleSaveToken(val: string) {
    setTokenInput(val);
    if (val.trim()) sessionStorage.setItem("tranche-agent-token", val.trim());
    else sessionStorage.removeItem("tranche-agent-token");
  }

  async function runControl(label: string, fn: () => Promise<unknown>) {
    setActionBusy(true);
    setActionFeedback(null);
    try {
      await fn();
      setActionFeedback({ kind: "ok", text: `${label} succeeded.` });
      await loadSnapshot(true);
    } catch (err) {
      const msg =
        err instanceof AgentApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "Control request failed";
      setActionFeedback({ kind: "err", text: msg });
    } finally {
      setActionBusy(false);
    }
  }

  async function handleStrategySave() {
    const takeProfitBps = Number(tpInput);
    const stopLossBps = Number(slInput);
    const maxSlippageBps = Number(slipInput);
    await runControl("Strategy update", () =>
      client.updateStrategy({
        strategyType,
        takeProfitBps,
        stopLossBps,
        maxSlippageBps,
      }),
    );
  }

  const isStale = snapshot ? Date.now() - snapshot.fetchedAt > 25_000 : false;
  const isDryRun = (snapshot?.status.mode ?? "dry_run") === "dry_run";
  const status = snapshot?.status;
  const metrics = snapshot?.metrics;
  const markets = snapshot?.markets;
  const config = snapshot?.config;

  return (
    <AppShell
      activeRoute="/agent"
      title="Tranche Agent"
      subtitle={`Source: ${status?.dataSource ?? "—"} · Chain ${status?.chainId ?? "—"} · ${status?.quotesAreReal ? "Real Quotes" : "Simulated Fixture"} · ${isDryRun ? "DRY-RUN" : "LIVE"}`}
      onNavigate={onNavigate}
      onRefresh={() => void loadSnapshot(true)}
      refreshing={refreshing}
      headerActions={
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "tabular-nums-mono inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
              disconnected
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : isDryRun
                  ? "border-border bg-card text-foreground"
                  : "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
            )}
          >
            {disconnected ? (
              <>
                <WifiOff className="size-3" />
                API Offline
              </>
            ) : isDryRun ? (
              <>
                <Bot className="size-3" />
                DRY-RUN
              </>
            ) : (
              <>
                <Activity className="size-3" />
                LIVE
              </>
            )}
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        {/* Disconnection / Stale / Corrupted Banners */}
        {disconnected && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] border border-destructive/40 bg-destructive/10 px-5 py-3.5 text-xs text-destructive">
            <div className="flex items-center gap-2.5">
              <WifiOff className="size-4 shrink-0" />
              <span>
                Local Agent API disconnected ({client.getBaseUrl()}): {connError ?? "Unavailable"}. Start it with{" "}
                <code className="rounded bg-background/60 px-1.5 py-0.5 font-mono">cd agent && npm run api</code>.
              </span>
            </div>
          </div>
        )}

        {!disconnected && isStale && (
          <div className="flex items-center gap-2.5 rounded-[16px] border border-amber-500/40 bg-amber-500/10 px-5 py-3 text-xs text-amber-300">
            <AlertTriangle className="size-4 shrink-0" />
            <span>Agent telemetry is stale (&gt;25s since last successful poll).</span>
          </div>
        )}

        {status && status.pendingTxs.length > 0 && (
          <div className="flex flex-col gap-3 rounded-[16px] border border-amber-500/40 bg-amber-500/10 p-4 text-xs">
            <div className="flex items-center gap-2 font-medium text-amber-200">
              <AlertTriangle className="size-4" />
              <span>
                {status.pendingTxs.length} Uncertain Pending Transaction(s) Blocking New Entries
              </span>
            </div>
            {status.pendingTxs.map((ptx) => (
              <div
                key={ptx.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-border bg-card/80 px-3.5 py-2.5"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="tabular-nums-mono font-medium text-foreground">
                    {ptx.id} · {ptx.action} ({ptx.status})
                  </span>
                  <span className="text-[11px] text-muted-foreground">{ptx.note ?? "Awaiting reconciliation"}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={actionBusy}
                    onClick={() =>
                      void runControl("Reconcile (failed)", () =>
                        client.reconcile(ptx.id, "CONFIRMED_FAILED"),
                      )
                    }
                    className="h-8 rounded-full text-[11px] cursor-pointer"
                  >
                    Mark Failed
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={actionBusy}
                    onClick={() =>
                      void runControl("Reconcile (manual)", () =>
                        client.reconcile(ptx.id, "CONFIRMED_MANUAL"),
                      )
                    }
                    className="h-8 rounded-full text-[11px] cursor-pointer"
                  >
                    Mark Reconciled
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 1. Agent Overview Grid */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-[18px] border border-border bg-card p-4">
            <span className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
              Runtime &amp; Mode
            </span>
            <div className="mt-2 flex items-center justify-between">
              <span className="font-display text-lg font-semibold">
                {loading
                  ? "Connecting…"
                  : status?.killSwitch
                    ? "KILLED"
                    : status?.paused
                      ? "PAUSED"
                      : status?.running
                        ? "RUNNING"
                        : "IDLE"}
              </span>
              <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                {status?.mode ?? "—"}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Strategy: <span className="text-foreground">{status?.activeStrategy ?? "Unavailable"}</span>
            </p>
          </div>

          <div className="rounded-[18px] border border-border bg-card p-4">
            <span className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
              Market &amp; Venue
            </span>
            <div className="mt-2 flex items-center justify-between">
              <span className="font-display text-lg font-semibold">
                {status?.market ?? "Unavailable"}
              </span>
              <span className="tabular-nums-mono rounded-full border border-border px-2 py-0.5 text-[10px]">
                {status?.lastSelectedVenue ?? "NONE"}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Last action: <span className="text-foreground">{status?.lastDecisionAction ?? "—"}</span>
            </p>
          </div>

          <div className="rounded-[18px] border border-border bg-card p-4">
            <span className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
              Realized / Unrealized P&amp;L
            </span>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="tabular-nums-mono font-display text-lg font-semibold">
                {fmtUsd6(metrics?.totalRealizedPnlPayment)}
              </span>
              <span className="tabular-nums-mono text-xs text-muted-foreground">
                / {fmtUsd6(metrics?.totalUnrealizedPnlPayment)}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Exposure: {fmtUsd6(metrics?.currentTotalExposurePayment)} · Cycles: {metrics?.totalCycles ?? "—"}
            </p>
          </div>

          <div className="rounded-[18px] border border-border bg-card p-4">
            <span className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
              Executions &amp; Last Cycle
            </span>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="tabular-nums-mono font-display text-lg font-semibold">
                {metrics
                  ? isDryRun
                    ? `${metrics.dryRunEvaluationsCount} sim`
                    : `${metrics.liveExecutionsCount} live`
                  : "—"}
              </span>
              <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                {fmtTime(status?.lastCycleTimestamp)}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              W/L: {metrics ? `${metrics.wins}W / ${metrics.losses}L` : "Unavailable"}
            </p>
          </div>
        </div>

        {/* 2. Market Intelligence + Risk Controls & Strategy Config */}
        <div className="grid gap-5 lg:grid-cols-2">
          {/* Market Intelligence */}
          <section className="flex flex-col gap-4 rounded-[20px] border border-border bg-card p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-display text-base font-semibold">Market Intelligence</h2>
                <p className="text-xs text-muted-foreground">
                  Live Tranche vs. HSKSwap venue economics &amp; oracle health
                </p>
              </div>
              <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                {markets?.available ? `Updated ${fmtTime(markets.timestamp)}` : "Unavailable"}
              </span>
            </div>

            {markets?.available && markets.venueComparison ? (
              <div className="flex flex-col gap-3 text-xs">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-[14px] border border-border bg-background p-3.5">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-foreground">Tranche Route</span>
                      <span className="tabular-nums-mono text-[10px] text-muted-foreground">
                        {markets.venueComparison.tranche.eligible ? "ELIGIBLE" : "INELIGIBLE"}
                      </span>
                    </div>
                    <p className="mt-2 tabular-nums-mono text-base font-semibold">
                      {fmtUsd6(markets.venueComparison.tranche.acquisitionCostPayment)}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Prem {fmtUsd6(markets.venueComparison.tranche.reservationPremiumPayment)} + Ex{" "}
                      {fmtUsd6(markets.venueComparison.tranche.exercisePayment)}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Offers discovered: {markets.trancheOffersCount ?? 0}
                    </p>
                  </div>

                  <div className="rounded-[14px] border border-border bg-background p-3.5">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-foreground">HSKSwap Route</span>
                      <span className="tabular-nums-mono text-[10px] text-muted-foreground">
                        {markets.venueComparison.hskswap.eligible ? "ELIGIBLE" : "INELIGIBLE"}
                      </span>
                    </div>
                    <p className="mt-2 tabular-nums-mono text-base font-semibold">
                      {fmtUsd6(markets.venueComparison.hskswap.acquisitionCostPayment)}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Impact: {markets.venueComparison.hskswap.priceImpactBps ?? "—"} bps
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Exit quote: {fmtUsd6(markets.dexSellQuote?.paymentAmountOut)}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 rounded-[12px] border border-border bg-background px-3.5 py-2.5 text-[11px]">
                  <div>
                    <span className="text-muted-foreground">Oracle Age</span>
                    <div className="tabular-nums-mono font-medium text-foreground">
                      {markets.oracleAgeSec !== null && markets.oracleAgeSec !== undefined
                        ? `${markets.oracleAgeSec}s`
                        : "Unavailable"}
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Oracle Dev</span>
                    <div className="tabular-nums-mono font-medium text-foreground">
                      {markets.oracleDeviationBps !== null && markets.oracleDeviationBps !== undefined
                        ? `${markets.oracleDeviationBps} bps`
                        : "Unavailable"}
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Volatility</span>
                    <div className="tabular-nums-mono font-medium text-foreground">
                      {markets.realizedVolatilityBps ?? 0} bps
                    </div>
                  </div>
                </div>

                <p className="text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">Venue Rationale:</span>{" "}
                  {markets.venueComparison.rationale}
                </p>

                {markets.anomalies && markets.anomalies.length > 0 && (
                  <div className="rounded-[10px] border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
                    Anomalies: {markets.anomalies.join(", ")}
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-[14px] border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                Market snapshot unavailable. Start the local Agent API to observe live quotes.
              </div>
            )}
          </section>

          {/* Risk Controls & Strategy Configuration */}
          <section className="flex flex-col gap-4 rounded-[20px] border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-semibold">Risk Controls &amp; Policy</h2>
                <p className="text-xs text-muted-foreground">
                  Code-enforced RiskManager limits &amp; authoritative kill switch
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={disconnected || actionBusy || status?.killSwitch}
                onClick={() => setKillDialogOpen(true)}
                className="h-8 rounded-full px-3 text-xs font-medium cursor-pointer"
              >
                <OctagonAlert className="mr-1.5 size-3.5" />
                {status?.killSwitch ? "Kill Switch Active" : "Kill Switch"}
              </Button>
            </div>

            {/* Local API Token input for state-changing POST endpoints */}
            <div className="flex items-center gap-2">
              <Input
                type="password"
                placeholder="Local API Bearer Token (for Start / Pause / Strategy)"
                value={tokenInput}
                onChange={(e) => handleSaveToken(e.target.value)}
                className="tabular-nums-mono h-9 rounded-[10px] bg-background text-xs"
              />
            </div>

            {/* Runtime Controls */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={disconnected || actionBusy || status?.running || status?.killSwitch}
                onClick={() => void runControl("Start runtime", () => client.start())}
                className="h-9 rounded-full px-4 text-xs cursor-pointer"
              >
                <Play className="mr-1.5 size-3.5" />
                Start
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disconnected || actionBusy || status?.paused}
                onClick={() => void runControl("Pause entries", () => client.pause())}
                className="h-9 rounded-full px-4 text-xs cursor-pointer"
              >
                <Pause className="mr-1.5 size-3.5" />
                Pause
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disconnected || actionBusy || !status?.paused || status?.killSwitch}
                onClick={() => void runControl("Resume entries", () => client.resume())}
                className="h-9 rounded-full px-4 text-xs cursor-pointer"
              >
                Resume
              </Button>
            </div>

            {/* Risk Limit Utilization */}
            {config && metrics && (
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-[12px] border border-border bg-background p-3">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-muted-foreground">Exposure Cap</span>
                    <span className="tabular-nums-mono">
                      {fmtUsd6(metrics.currentTotalExposurePayment)} /{" "}
                      {fmtUsd6(config.riskLimits.maxTotalExposurePayment)}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-foreground transition-all"
                      style={{
                        width: `${pctBar(metrics.currentTotalExposurePayment, config.riskLimits.maxTotalExposurePayment)}%`,
                      }}
                    />
                  </div>
                </div>
                <div className="rounded-[12px] border border-border bg-background p-3">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-muted-foreground">Daily Loss Cap</span>
                    <span className="tabular-nums-mono">
                      {fmtUsd6(metrics.dailyRealizedLossPayment)} /{" "}
                      {fmtUsd6(config.riskLimits.maxDailyRealizedLossPayment)}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-destructive transition-all"
                      style={{
                        width: `${pctBar(metrics.dailyRealizedLossPayment, config.riskLimits.maxDailyRealizedLossPayment)}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            <Separator />

            {/* Strategy Parameters Form */}
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-1.5 rounded-full border border-border bg-background p-1">
                {(["price_threshold", "momentum", "volatility_aware"] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setStrategyType(st)}
                    className={cn(
                      "h-8 rounded-full text-[11px] font-medium transition-colors cursor-pointer",
                      strategyType === st
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {st === "price_threshold"
                      ? "Threshold"
                      : st === "momentum"
                        ? "Momentum"
                        : "Volatility"}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-muted-foreground">Take Profit (bps)</label>
                  <Input
                    type="number"
                    value={tpInput}
                    onChange={(e) => setTpInput(e.target.value)}
                    className="tabular-nums-mono h-9 rounded-[10px] bg-background text-xs"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-muted-foreground">Stop Loss (bps)</label>
                  <Input
                    type="number"
                    value={slInput}
                    onChange={(e) => setSlInput(e.target.value)}
                    className="tabular-nums-mono h-9 rounded-[10px] bg-background text-xs"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-muted-foreground">Max Slippage (bps)</label>
                  <Input
                    type="number"
                    value={slipInput}
                    onChange={(e) => setSlipInput(e.target.value)}
                    className="tabular-nums-mono h-9 rounded-[10px] bg-background text-xs"
                  />
                </div>
              </div>

              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disconnected || actionBusy}
                onClick={() => void handleStrategySave()}
                className="h-9 rounded-full text-xs cursor-pointer"
              >
                Apply Validated Policy
              </Button>
            </div>

            {actionFeedback && (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-[12px] border px-3 py-2 text-xs",
                  actionFeedback.kind === "ok"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-destructive/30 bg-destructive/10 text-destructive",
                )}
              >
                {actionFeedback.kind === "ok" ? (
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
                ) : (
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                )}
                <span>{actionFeedback.text}</span>
              </div>
            )}
          </section>
        </div>

        {/* 3. Decision Feed */}
        <section className="flex flex-col gap-3 rounded-[20px] border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-base font-semibold">Decision Feed</h2>
              <p className="text-xs text-muted-foreground">
                Structured engine traces with venue comparison, risk checks, and rejection reasons
              </p>
            </div>
            <span className="tabular-nums-mono text-[11px] text-muted-foreground">
              {snapshot?.decisions.length ?? 0} recent
            </span>
          </div>

          {snapshot && snapshot.decisions.length > 0 ? (
            <div className="flex flex-col gap-2.5">
              {snapshot.decisions.map((d) => (
                <div
                  key={`${d.cycleId}-${d.decisionKey}`}
                  className="flex flex-col gap-1.5 rounded-[14px] border border-border bg-background px-4 py-3 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="tabular-nums-mono font-semibold text-foreground">
                        #{d.cycleId}
                      </span>
                      <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium">
                        {d.selectedAction}
                      </span>
                      <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                        Venue: {d.selectedVenue} · Signal: {d.signalAction}
                      </span>
                    </div>
                    <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                      {fmtTime(d.timestamp)}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{d.rationale}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="tabular-nums-mono">
                      Tranche: {fmtUsd6(d.tranche.acquisitionCostPayment)} (
                      {d.tranche.eligible ? "OK" : d.tranche.rejectionReasons.join(", ")})
                    </span>
                    <span className="tabular-nums-mono">
                      HSKSwap: {fmtUsd6(d.hskswap.acquisitionCostPayment)} (
                      {d.hskswap.eligible ? "OK" : d.hskswap.rejectionReasons.join(", ")})
                    </span>
                    <span>
                      Risk: {d.riskAllowed ? "PASSED" : `BLOCKED (${d.failedRiskChecks.map((c) => c.name).join(", ")})`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-[14px] border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
              No decision traces recorded yet.
            </div>
          )}
        </section>

        {/* 4. Positions & Active Tickets */}
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="flex flex-col gap-3 rounded-[20px] border border-border bg-card p-5">
            <h2 className="font-display text-base font-semibold">Positions</h2>
            {snapshot && snapshot.positions.all.length > 0 ? (
              <div className="flex flex-col gap-2">
                {snapshot.positions.all.map((p) => (
                  <div
                    key={p.positionId}
                    className="flex items-center justify-between rounded-[12px] border border-border bg-background px-3.5 py-2.5 text-xs"
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-foreground">
                        {p.positionId} · {p.venue} ({p.status})
                      </span>
                      <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                        Cost: {fmtUsd6(p.entryCostPayment)} · Realized: {fmtUsd6(p.realizedPnlPayment)}
                      </span>
                    </div>
                    <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                      Unrealized: {fmtUsd6(p.unrealizedPnlPayment)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No positions opened ({isDryRun ? "dry-run mode does not broadcast trades" : "none"}).
              </p>
            )}
          </section>

          <section className="flex flex-col gap-3 rounded-[20px] border border-border bg-card p-5">
            <h2 className="font-display text-base font-semibold">Tranche Tickets</h2>
            {snapshot && snapshot.tickets.all.length > 0 ? (
              <div className="flex flex-col gap-2">
                {snapshot.tickets.all.map((t) => (
                  <div
                    key={t.ticketId}
                    className="flex items-center justify-between rounded-[12px] border border-border bg-background px-3.5 py-2.5 text-xs"
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-foreground">
                        Ticket #{t.ticketId} · Offer #{t.offerId} ({t.status})
                      </span>
                      <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                        Premium: {fmtUsd6(t.premiumPaidPayment)} · Expires {fmtTime(t.expiresAt)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No active Tranche tickets ({isDryRun ? "dry-run mode" : "none"}).
              </p>
            )}
          </section>
        </div>
      </div>

      {/* Kill Switch Confirmation Dialog */}
      <Dialog open={killDialogOpen} onOpenChange={setKillDialogOpen}>
        <DialogContent className="rounded-[22px] border-border bg-card sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="font-display text-xl text-destructive">
              Activate Kill Switch?
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              This immediately stops the runtime and blocks all entries, exercises, and exits. The
              kill switch is authoritative and cannot be cleared via Resume.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setKillDialogOpen(false)}
              className="rounded-full text-xs cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={actionBusy}
              onClick={() => {
                setKillDialogOpen(false);
                void runControl("Activate kill switch", () => client.kill());
              }}
              className="rounded-full text-xs cursor-pointer"
            >
              Confirm Kill Switch
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
