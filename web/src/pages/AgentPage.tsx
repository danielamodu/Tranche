import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  History,
  OctagonAlert,
  Pause,
  Play,
  Settings2,
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
import { explorerTxUrl } from "@/config/networks";
import {
  AgentApiClient,
  AgentApiError,
  DEFAULT_AGENT_API_URL,
  isHostedHttpsToLocalApi,
  isLocalAgentApiUrl,
  normalizeAgentApiUrl,
  type AgentDashboardSnapshot,
  type StrategyType,
} from "@/lib/agentApi";
import { cn } from "@/lib/utils";
import type { AppRoute } from "@/App";

interface AgentPageProps {
  onNavigate: (path: AppRoute) => void;
}

const TOKEN_STORAGE_KEY = "tranche-agent-token";
const API_URL_STORAGE_KEY = "tranche-agent-api-url";
const BASE_POLL_MS = 15_000;
const RATE_LIMITED_POLL_MS = 35_000;

function fmtPayment6(raw: string | undefined | null, symbol = "USDT"): string {
  if (raw === undefined || raw === null || raw === "") return "Unavailable";
  try {
    const val = Number(BigInt(raw)) / 1e6;
    if (!Number.isFinite(val)) return "Unavailable";
    return `${val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${symbol}`;
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

function shortHash(hash: string): string {
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
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
  const [apiUrlInput, setApiUrlInput] = useState<string>(() => {
    const saved = sessionStorage.getItem(API_URL_STORAGE_KEY);
    return saved ? normalizeAgentApiUrl(saved) : normalizeAgentApiUrl(DEFAULT_AGENT_API_URL);
  });
  const [tokenInput, setTokenInput] = useState<string>(
    () => sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "",
  );
  const [connOpen, setConnOpen] = useState(false);
  const [ledgerTab, setLedgerTab] = useState<"positions" | "tickets">("positions");

  const normalizedApiUrl = useMemo(() => normalizeAgentApiUrl(apiUrlInput), [apiUrlInput]);
  const client = useMemo(
    () => new AgentApiClient({ baseUrl: normalizedApiUrl, token: tokenInput }),
    [normalizedApiUrl, tokenInput],
  );
  const isLocalApi = useMemo(() => isLocalAgentApiUrl(normalizedApiUrl), [normalizedApiUrl]);
  const hostedLocalMismatch = useMemo(
    () => isHostedHttpsToLocalApi(normalizedApiUrl),
    [normalizedApiUrl],
  );

  const [snapshot, setSnapshot] = useState<AgentDashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const [killDialogOpen, setKillDialogOpen] = useState(false);

  // Strategy form state (re-synced whenever backend policyVersion changes)
  const [strategyType, setStrategyType] = useState<StrategyType>("price_threshold");
  const [tpInput, setTpInput] = useState("500");
  const [slInput, setSlInput] = useState("300");
  const [slipInput, setSlipInput] = useState("100");
  const [maxPosInput, setMaxPosInput] = useState("");
  const lastSyncedVersionRef = useRef<number | null>(null);
  const requestSeqRef = useRef(0);

  // Bounded NL Policy Proposal state
  const [nlInstruction, setNlInstruction] = useState("");
  const [nlProposal, setNlProposal] = useState<{
    instruction: string;
    proposedPatch: Record<string, unknown>;
    valid: boolean;
    rejectedFields: string[];
  } | null>(null);

  const syncFormFromSnapshot = useCallback((data: AgentDashboardSnapshot) => {
    setStrategyType(data.config.strategy.type);
    setTpInput(String(data.config.strategy.takeProfitBps));
    setSlInput(String(data.config.strategy.stopLossBps));
    setSlipInput(String(data.config.riskLimits.maxSlippageBps));
    setMaxPosInput(data.config.riskLimits.maxPositionSizeInventory);
    lastSyncedVersionRef.current = data.policyHistory.currentVersion;
  }, []);

  const loadSnapshot = useCallback(
    async (isManual = false, forceFormSync = false) => {
      const seq = ++requestSeqRef.current;
      if (isManual) setRefreshing(true);
      try {
        const data = await client.fetchSnapshot();
        if (seq !== requestSeqRef.current) return;
        setSnapshot(data);
        setDisconnected(false);
        setRateLimited(false);
        if (
          forceFormSync ||
          lastSyncedVersionRef.current === null ||
          lastSyncedVersionRef.current !== data.policyHistory.currentVersion
        ) {
          syncFormFromSnapshot(data);
        }
      } catch (err) {
        if (seq !== requestSeqRef.current) return;
        if (err instanceof AgentApiError && err.status === 429) {
          setRateLimited(true);
        } else {
          setDisconnected(true);
          setRateLimited(false);
        }
      } finally {
        if (seq === requestSeqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client, syncFormFromSnapshot],
  );

  useEffect(() => {
    void loadSnapshot(false);
    const intervalMs = rateLimited ? RATE_LIMITED_POLL_MS : BASE_POLL_MS;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void loadSnapshot(false);
    }, intervalMs);

    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        void loadSnapshot(false);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadSnapshot, rateLimited]);

  function handleSaveApiUrl(val: string) {
    setApiUrlInput(val);
    const cleaned = val.trim();
    if (cleaned) sessionStorage.setItem(API_URL_STORAGE_KEY, cleaned);
    else sessionStorage.removeItem(API_URL_STORAGE_KEY);
    lastSyncedVersionRef.current = null;
  }

  function handleSaveToken(val: string) {
    setTokenInput(val);
    if (val.trim()) sessionStorage.setItem(TOKEN_STORAGE_KEY, val.trim());
    else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  }

  async function runControl(
    label: string,
    fn: () => Promise<unknown>,
    opts?: { forceFormSync?: boolean },
  ) {
    setActionBusy(true);
    setActionFeedback(null);
    try {
      await fn();
      setActionFeedback({ kind: "ok", text: `${label} succeeded.` });
      await loadSnapshot(true, opts?.forceFormSync ?? false);
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
    const trimmedMaxPos = maxPosInput.trim();
    await runControl(
      "Strategy update",
      () =>
        client.updateStrategy({
          strategyType,
          takeProfitBps,
          stopLossBps,
          maxSlippageBps,
          ...(trimmedMaxPos ? { maxPositionSizeInventory: trimmedMaxPos } : {}),
        }),
      { forceFormSync: true },
    );
  }

  const isStale = snapshot ? Date.now() - snapshot.fetchedAt > 40_000 : false;
  const isDryRun = (snapshot?.status.mode ?? "dry_run") === "dry_run";
  const health = snapshot?.health;
  const ready = snapshot?.ready;
  const status = snapshot?.status;
  const metrics = snapshot?.metrics;
  const markets = snapshot?.markets;
  const config = snapshot?.config;
  const policyVersion = snapshot?.policyHistory.currentVersion ?? 0;
  const policyHistory = snapshot?.policyHistory.history ?? [];
  const paymentSymbol = status?.market?.split("/")[1] || "USDT";
  const winningVenue = markets?.venueComparison?.selectedVenue ?? status?.lastSelectedVenue ?? "NONE";

  const canStart =
    !disconnected &&
    !actionBusy &&
    !status?.running &&
    !status?.killSwitch &&
    !status?.stateCorrupted;

  const canResume =
    !disconnected &&
    !actionBusy &&
    Boolean(status?.paused) &&
    !status?.killSwitch &&
    !status?.stateCorrupted &&
    (status?.pendingTxs.length ?? 0) === 0;

  return (
    <AppShell
      activeRoute="/agent"
      title="Tranche Agent"
      subtitle={isDryRun ? "Paper trading mode" : "Live autonomous trading"}
      onNavigate={onNavigate}
      onRefresh={() => void loadSnapshot(true)}
      refreshing={refreshing}
      headerActions={
        <div className="flex flex-wrap items-center gap-2">
          {!disconnected && ready && (
            <span
              className={cn(
                "tabular-nums-mono inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium",
                ready.ready
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-300",
              )}
            >
              {ready.ready ? "READY" : `NOT READY (${ready.httpStatus})`}
            </span>
          )}
          <span
            className={cn(
              "tabular-nums-mono inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium",
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
      <div className="flex flex-col gap-8">
        {/* Clean Consumer Connection Notice */}
        {disconnected && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-border bg-card px-5 py-3.5 text-xs">
            <div className="flex items-center gap-2.5 text-muted-foreground">
              <WifiOff className="size-4 shrink-0 text-amber-500" />
              <span>
                {hostedLocalMismatch
                  ? "Agent is offline. Connect a hosted Agent URL to stream live quotes and decisions."
                  : "Agent is currently offline. Check your connection settings or start your agent."}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setConnOpen((p) => !p)}
              className="rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent cursor-pointer"
            >
              {connOpen ? "Hide Connection" : "Connect Agent"}
            </button>
          </div>
        )}

        {rateLimited && !disconnected && (
          <div className="relative overflow-hidden rounded-[14px] border border-amber-500/30 bg-amber-500/[0.08] py-3 pl-5 pr-5 text-xs text-amber-950 dark:text-amber-100">
            <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-amber-500" />
            <span className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-400">
              THROTTLED · HTTP_429
            </span>
            <p className="mt-0.5 opacity-85">
              Agent API rate limit reached. Polling automatically backed off to 35s; close extra
              Agent Console tabs if open.
            </p>
          </div>
        )}

        {!disconnected && isStale && (
          <div className="relative overflow-hidden rounded-[14px] border border-amber-500/30 bg-amber-500/[0.08] py-3 pl-5 pr-5 text-xs text-amber-950 dark:text-amber-100">
            <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-amber-500" />
            <span className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-400">
              STALE · TELEMETRY_LAG
            </span>
            <p className="mt-0.5 opacity-85">Last successful snapshot is over 40 seconds old.</p>
          </div>
        )}

        {status?.stateCorrupted && (
          <div className="relative overflow-hidden rounded-[14px] border border-destructive/40 bg-destructive/[0.08] py-3.5 pl-5 pr-5 text-xs">
            <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-destructive" />
            <span className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-destructive">
              FAIL-CLOSED · STATE_CORRUPTED
            </span>
            <p className="mt-0.5 text-foreground/90">
              Persisted state failed integrity verification. Runtime Start and Resume are locked
              until state is repaired on disk.
            </p>
          </div>
        )}

        {status?.killSwitch && (
          <div className="relative overflow-hidden rounded-[14px] border border-destructive/40 bg-destructive/[0.08] py-3.5 pl-5 pr-5 text-xs">
            <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-destructive" />
            <span className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-destructive">
              HALT · AUTHORITATIVE_KILL_SWITCH
            </span>
            <p className="mt-0.5 text-foreground/90">
              All entries, exercises, and exits are blocked. Unlike ordinary Pause, the kill switch
              cannot be cleared via Resume.
            </p>
          </div>
        )}

        {status && status.pendingTxs.length > 0 && (
          <div className="relative flex flex-col gap-3 overflow-hidden rounded-[14px] border border-amber-500/35 bg-amber-500/[0.08] py-4 pl-5 pr-5 text-xs">
            <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-amber-500" />
            <span className="tabular-nums-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-400">
              PENDING · {status.pendingTxs.length} UNCERTAIN TX(S) BLOCKING RESUME
            </span>
            {status.pendingTxs.map((ptx) => (
              <div
                key={ptx.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-border bg-card px-3.5 py-2.5"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="tabular-nums-mono font-medium text-foreground">
                    {ptx.id} · {ptx.action} ({ptx.status})
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {ptx.note ?? "Awaiting reconciliation"}
                  </span>
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

        {/* 1. Clean Telemetry Strip */}
        <section className="grid grid-cols-2 gap-y-6 border-b border-border/80 pb-7 lg:grid-cols-4 lg:divide-x lg:divide-border/80">
          <div className="flex flex-col gap-1 pr-5">
            <span className="text-xs font-medium text-muted-foreground">Status</span>
            <span className="text-2xl font-semibold tracking-tight text-foreground">
              {loading
                ? "Connecting…"
                : status?.killSwitch
                  ? "Stopped"
                  : status?.stateCorrupted
                    ? "Locked"
                    : status?.paused
                      ? "Paused"
                      : status?.running
                        ? "Running"
                        : "Idle"}
            </span>
            <span className="text-xs text-muted-foreground">
              {health ? (health.rpcHealthy ? "Connected" : "Reconnecting") : "Offline"}
            </span>
          </div>

          <div className="flex flex-col gap-1 lg:px-6">
            <span className="text-xs font-medium text-muted-foreground">Market</span>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-semibold tracking-tight text-foreground">
                {status?.market ?? "—"}
              </span>
              {markets?.marketRegime && (
                <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {markets.marketRegime}
                </span>
              )}
            </div>
            <span className="text-xs text-muted-foreground">
              {status?.activeStrategy ? status.activeStrategy.replace("_", " ") : "No strategy"}
            </span>
          </div>

          <div className="flex flex-col gap-1 pr-5 lg:px-6">
            <span className="text-xs font-medium text-muted-foreground">Realized P&amp;L</span>
            <span className="tabular-nums-mono text-2xl font-semibold tracking-tight text-foreground">
              {metrics ? fmtPayment6(metrics.totalRealizedPnlPayment, paymentSymbol) : "—"}
            </span>
            <span className="tabular-nums-mono text-xs text-muted-foreground">
              {metrics
                ? `Unrealized ${fmtPayment6(metrics.totalUnrealizedPnlPayment, paymentSymbol)}`
                : "No open P&L"}
            </span>
          </div>

          <div className="flex flex-col gap-1 lg:pl-6">
            <span className="text-xs font-medium text-muted-foreground">Executions</span>
            <div className="flex items-baseline justify-between gap-2">
              <span className="tabular-nums-mono text-2xl font-semibold tracking-tight text-foreground">
                {metrics
                  ? isDryRun
                    ? `${metrics.dryRunEvaluationsCount} simulated`
                    : `${metrics.liveExecutionsCount} live`
                  : "—"}
              </span>
              <span className="tabular-nums-mono text-xs text-muted-foreground">
                {fmtTime(health?.lastSuccessfulCycleAt ?? status?.lastCycleTimestamp)}
              </span>
            </div>
            <span className="tabular-nums-mono flex items-center justify-between text-xs text-muted-foreground">
              <span>{metrics ? `${metrics.wins}W / ${metrics.losses}L` : "—"}</span>
              {status?.lastTxHash && (
                <a
                  href={explorerTxUrl(status.lastTxHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-foreground underline underline-offset-4"
                >
                  {shortHash(status.lastTxHash)}
                  <ArrowUpRight className="size-3" />
                </a>
              )}
            </span>
          </div>
        </section>

        {/* 2. Dual-Venue Comparison */}
        <section className="overflow-hidden rounded-[20px] border border-border">
          <div className="grid grid-cols-1 lg:grid-cols-12">
            {/* Left Wing: Tranche */}
            <div
              className={cn(
                "relative flex flex-col justify-between gap-4 p-6 lg:col-span-5 transition-opacity",
                winningVenue === "TRANCHE" ? "opacity-100" : "opacity-90",
              )}
              style={{ backgroundColor: "#f8f7ee", color: "#050505" }}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold opacity-65">Tranche</span>
                <span
                  className="rounded-full px-2.5 py-0.5 text-[11px] font-medium"
                  style={{
                    backgroundColor: winningVenue === "TRANCHE" ? "#050505" : "rgba(5,5,5,0.08)",
                    color: winningVenue === "TRANCHE" ? "#f8f7ee" : "#050505",
                  }}
                >
                  {winningVenue === "TRANCHE"
                    ? "Selected"
                    : markets?.venueComparison?.tranche.eligible
                      ? "Available"
                      : "Waiting"}
                </span>
              </div>

              <div className="flex flex-col gap-1">
                <span className="tabular-nums-mono text-2xl font-semibold tracking-tight">
                  {markets?.venueComparison
                    ? fmtPayment6(
                        markets.venueComparison.tranche.acquisitionCostPayment,
                        paymentSymbol,
                      )
                    : "—"}
                </span>
                <span className="tabular-nums-mono text-xs opacity-65">
                  {markets?.venueComparison
                    ? `Hold fee ${fmtPayment6(markets.venueComparison.tranche.reservationPremiumPayment, paymentSymbol)} · Strike ${fmtPayment6(markets.venueComparison.tranche.exercisePayment, paymentSymbol)}`
                    : "No quote yet"}
                </span>
              </div>

              <div className="flex items-center justify-between border-t border-black/10 pt-3 text-xs opacity-70">
                <span className="tabular-nums-mono">
                  {markets?.trancheOffersCount ?? 0} offers
                </span>
                <span>Zero slippage</span>
              </div>
            </div>

            {/* Center Verdict */}
            <div className="flex flex-col justify-between gap-4 border-y border-border bg-muted/50 px-5 py-6 lg:col-span-2 lg:border-x lg:border-y-0">
              <div className="flex flex-col items-center gap-1 text-center">
                <span className="text-xs text-muted-foreground">Route</span>
                <span className="text-lg font-semibold text-foreground">
                  {winningVenue === "NONE" ? "Wait" : winningVenue === "TRANCHE" ? "Tranche" : "HSKSwap"}
                </span>
              </div>

              <dl className="grid grid-cols-3 gap-2 text-center text-xs lg:grid-cols-1 lg:gap-2">
                <div className="flex flex-col">
                  <dt className="text-[11px] text-muted-foreground">Oracle</dt>
                  <dd className="tabular-nums-mono font-medium text-foreground">
                    {markets?.oracleAgeSec !== null && markets?.oracleAgeSec !== undefined
                      ? `${markets.oracleAgeSec}s`
                      : "—"}
                  </dd>
                </div>
                <div className="flex flex-col">
                  <dt className="text-[11px] text-muted-foreground">Volatility</dt>
                  <dd className="tabular-nums-mono font-medium text-foreground">
                    {markets?.realizedVolatilityBps !== undefined
                      ? `${(markets.realizedVolatilityBps / 100).toFixed(2)}%`
                      : "—"}
                  </dd>
                </div>
                <div className="flex flex-col">
                  <dt className="text-[11px] text-muted-foreground">Momentum</dt>
                  <dd className="tabular-nums-mono font-medium text-foreground">
                    {markets?.momentumReturnBps !== undefined
                      ? `${markets.momentumReturnBps >= 0 ? "+" : ""}${(markets.momentumReturnBps / 100).toFixed(2)}%`
                      : "—"}
                  </dd>
                </div>
              </dl>

              <span className="tabular-nums-mono text-center text-[11px] text-muted-foreground">
                {markets?.available ? fmtTime(markets.timestamp) : "—"}
              </span>
            </div>

            {/* Right Wing: HSKSwap */}
            <div className="relative flex flex-col justify-between gap-4 bg-card p-6 text-card-foreground lg:col-span-5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-muted-foreground">HSKSwap</span>
                <span
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-[11px] font-medium",
                    winningVenue === "HSKSWAP"
                      ? "bg-primary text-primary-foreground"
                      : "border border-border text-muted-foreground",
                  )}
                >
                  {winningVenue === "HSKSWAP"
                    ? "Selected"
                    : markets?.venueComparison?.hskswap.eligible
                      ? "Available"
                      : "Waiting"}
                </span>
              </div>

              <div className="flex flex-col gap-1">
                <span className="tabular-nums-mono text-2xl font-semibold tracking-tight">
                  {markets?.venueComparison
                    ? fmtPayment6(
                        markets.venueComparison.hskswap.acquisitionCostPayment,
                        paymentSymbol,
                      )
                    : "—"}
                </span>
                <span className="tabular-nums-mono text-xs text-muted-foreground">
                  {markets?.venueComparison
                    ? `Price impact: ${markets.venueComparison.hskswap.priceImpactBps ?? "—"} bps`
                    : "No quote yet"}
                </span>
              </div>

              <div className="flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
                <span className="tabular-nums-mono">
                  Exit: {markets?.dexSellQuote ? fmtPayment6(markets.dexSellQuote.paymentAmountOut, paymentSymbol) : "—"}
                </span>
                <span>Instant swap</span>
              </div>
            </div>
          </div>

          {/* Venue Rationale Footer Strip */}
          {markets?.available && markets.venueComparison && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-card/70 px-6 py-3 text-[11px] text-muted-foreground">
              <span>
                <strong className="font-medium text-foreground">Rationale:</strong>{" "}
                {markets.venueComparison.rationale}
              </span>
              {markets.anomalies && markets.anomalies.length > 0 && (
                <span className="tabular-nums-mono rounded-full border border-destructive/40 bg-destructive/10 px-2.5 py-0.5 text-destructive">
                  Anomalies: {markets.anomalies.join(", ")}
                </span>
              )}
            </div>
          )}
        </section>

        {/* 3. Asymmetric 7/5 Stage: Execution Tape (Left) + Signed Cream Mandate Slip (Right) */}
        <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-12">
          {/* LEFT 7 COLS: Chronological Execution Decision Tape + Tabbed Portfolio Ledger */}
          <div className="flex flex-col gap-10 lg:col-span-7">
            {/* Decision Tape */}
            <section className="flex flex-col gap-4">
              <div className="flex items-baseline justify-between border-b border-border pb-3">
                <h2 className="text-lg font-semibold tracking-tight">Recent Decisions</h2>
                <span className="tabular-nums-mono text-xs text-muted-foreground">
                  {snapshot?.decisions.length ?? 0}
                </span>
              </div>

              {snapshot && snapshot.decisions.length > 0 ? (
                <div className="divide-y divide-border/70">
                  {snapshot.decisions.map((d) => (
                    <article
                      key={`${d.cycleId}-${d.decisionKey}`}
                      className="flex flex-col gap-2 py-4 transition-colors hover:bg-card/40"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="tabular-nums-mono text-xs font-semibold text-foreground">
                            #{d.cycleId}
                          </span>
                          <span className="rounded-full bg-accent px-2.5 py-0.5 text-[10px] font-medium text-foreground">
                            {d.selectedAction}
                          </span>
                          <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                            {d.selectedVenue} · {d.signalAction}
                          </span>
                        </div>
                        <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                          {fmtTime(d.timestamp)}
                        </span>
                      </div>

                      <p className="text-xs leading-relaxed text-muted-foreground">{d.rationale}</p>

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                        <span className="tabular-nums-mono">
                          Tranche {fmtPayment6(d.tranche.acquisitionCostPayment, paymentSymbol)} (
                          {d.tranche.eligible ? "OK" : d.tranche.rejectionReasons.join(", ")})
                        </span>
                        <span className="tabular-nums-mono">
                          HSKSwap {fmtPayment6(d.hskswap.acquisitionCostPayment, paymentSymbol)} (
                          {d.hskswap.eligible ? "OK" : d.hskswap.rejectionReasons.join(", ")})
                        </span>
                        <span
                          className={cn(
                            "tabular-nums-mono font-medium",
                            d.riskAllowed ? "text-emerald-400" : "text-destructive",
                          )}
                        >
                          Risk: {d.riskAllowed ? "PASSED" : `BLOCKED (${d.failedRiskChecks.map((c) => c.name).join(", ")})`}
                        </span>
                        {d.txHashes.map((hash) => (
                          <a
                            key={hash}
                            href={explorerTxUrl(hash)}
                            target="_blank"
                            rel="noreferrer"
                            className="tabular-nums-mono inline-flex items-center gap-0.5 text-foreground underline underline-offset-4"
                          >
                            Tx {shortHash(hash)}
                            <ArrowUpRight className="size-3" />
                          </a>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="rounded-[18px] border border-dashed border-border px-6 py-12 text-center text-xs text-muted-foreground">
                  No decision traces recorded yet. Start the agent runtime to stream execution
                  traces.
                </div>
              )}
            </section>

            {/* Tabbed Portfolio Ledger (Positions / Tranche Tickets) */}
            <section className="flex flex-col gap-4">
              <div className="flex items-center justify-between border-b border-border pb-3">
                <div className="flex items-center gap-1 rounded-full border border-border bg-card p-1">
                  <button
                    type="button"
                    onClick={() => setLedgerTab("positions")}
                    className={cn(
                      "h-7 rounded-full px-3.5 text-xs font-medium transition-colors cursor-pointer",
                      ledgerTab === "positions"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Positions ({snapshot?.positions.all.length ?? 0})
                  </button>
                  <button
                    type="button"
                    onClick={() => setLedgerTab("tickets")}
                    className={cn(
                      "h-7 rounded-full px-3.5 text-xs font-medium transition-colors cursor-pointer",
                      ledgerTab === "tickets"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Tranche Tickets ({snapshot?.tickets.all.length ?? 0})
                  </button>
                </div>
                <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                  {isDryRun ? "Dry-run paper ledger" : "Live on-chain ledger"}
                </span>
              </div>

              {ledgerTab === "positions" ? (
                snapshot && snapshot.positions.all.length > 0 ? (
                  <div className="divide-y divide-border/70">
                    {snapshot.positions.all.map((p) => (
                      <div key={p.positionId} className="flex flex-col gap-1.5 py-3.5 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-foreground">
                            {p.positionId} · {p.venue} ({p.status})
                          </span>
                          <span className="tabular-nums-mono text-muted-foreground">
                            Unrealized {fmtPayment6(p.unrealizedPnlPayment, paymentSymbol)}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                          <span className="tabular-nums-mono">
                            Cost {fmtPayment6(p.entryCostPayment, paymentSymbol)} · Realized{" "}
                            {fmtPayment6(p.realizedPnlPayment, paymentSymbol)}
                          </span>
                          {p.entryTxHashes.map((hash) => (
                            <a
                              key={`in-${hash}`}
                              href={explorerTxUrl(hash)}
                              target="_blank"
                              rel="noreferrer"
                              className="tabular-nums-mono inline-flex items-center gap-0.5 text-foreground underline underline-offset-4"
                            >
                              Entry {shortHash(hash)}
                              <ArrowUpRight className="size-3" />
                            </a>
                          ))}
                          {p.exitTxHashes.map((hash) => (
                            <a
                              key={`out-${hash}`}
                              href={explorerTxUrl(hash)}
                              target="_blank"
                              rel="noreferrer"
                              className="tabular-nums-mono inline-flex items-center gap-0.5 text-foreground underline underline-offset-4"
                            >
                              Exit {shortHash(hash)}
                              <ArrowUpRight className="size-3" />
                            </a>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="py-6 text-xs text-muted-foreground">
                    No positions opened ({isDryRun ? "dry-run mode does not broadcast trades" : "none"}).
                  </p>
                )
              ) : snapshot && snapshot.tickets.all.length > 0 ? (
                <div className="divide-y divide-border/70">
                  {snapshot.tickets.all.map((t) => (
                    <div key={t.ticketId} className="flex flex-col gap-1.5 py-3.5 text-xs">
                      <span className="font-medium text-foreground">
                        Ticket #{t.ticketId} · Offer #{t.offerId} ({t.status})
                      </span>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                        <span className="tabular-nums-mono">
                          Premium {fmtPayment6(t.premiumPaidPayment, paymentSymbol)} · Expires{" "}
                          {fmtTime(t.expiresAt)}
                        </span>
                        {t.reserveTxHash && (
                          <a
                            href={explorerTxUrl(t.reserveTxHash)}
                            target="_blank"
                            rel="noreferrer"
                            className="tabular-nums-mono inline-flex items-center gap-0.5 text-foreground underline underline-offset-4"
                          >
                            Reserve {shortHash(t.reserveTxHash)}
                            <ArrowUpRight className="size-3" />
                          </a>
                        )}
                        {t.exerciseTxHashes.map((hash) => (
                          <a
                            key={`ex-${hash}`}
                            href={explorerTxUrl(hash)}
                            target="_blank"
                            rel="noreferrer"
                            className="tabular-nums-mono inline-flex items-center gap-0.5 text-foreground underline underline-offset-4"
                          >
                            Exercise {shortHash(hash)}
                            <ArrowUpRight className="size-3" />
                          </a>
                        ))}
                        {t.reclaimTxHash && (
                          <a
                            href={explorerTxUrl(t.reclaimTxHash)}
                            target="_blank"
                            rel="noreferrer"
                            className="tabular-nums-mono inline-flex items-center gap-0.5 text-foreground underline underline-offset-4"
                          >
                            Reclaim {shortHash(t.reclaimTxHash)}
                            <ArrowUpRight className="size-3" />
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="py-6 text-xs text-muted-foreground">
                  No active Tranche tickets ({isDryRun ? "dry-run mode" : "none"}).
                </p>
              )}
            </section>
          </div>

          {/* RIGHT 5 COLS (STICKY): Signed Archival Cream Policy & Risk Mandate Slip */}
          <aside className="lg:sticky lg:top-24 lg:col-span-5">
            <div className="flex flex-col drop-shadow-[0_12px_28px_rgba(12,13,16,0.08)] dark:drop-shadow-[0_32px_72px_rgba(0,0,0,0.75)]">
              <div
                className="relative flex flex-col gap-5 overflow-hidden rounded-t-[22px] border border-b-0 border-black/10 px-6 pt-6 pb-5 dark:border-0"
                style={{ backgroundColor: "#f8f7ee", color: "#050505" }}
              >
                {/* Slip Header */}
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <span className="text-xs font-medium opacity-60">
                      Policy v{policyVersion}
                    </span>
                    <h2 className="text-lg font-semibold tracking-tight">
                      Controls &amp; Policy
                    </h2>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setConnOpen((p) => !p)}
                      title="Connection settings"
                      className="inline-flex h-8 items-center gap-1 rounded-full border border-black/15 px-2.5 text-xs font-medium transition-colors hover:bg-black/5 cursor-pointer"
                    >
                      <Settings2 className="size-3" />
                      <span>Connect</span>
                    </button>
                    <button
                      type="button"
                      disabled={disconnected || actionBusy || status?.killSwitch}
                      onClick={() => setKillDialogOpen(true)}
                      className="inline-flex h-8 items-center gap-1 rounded-full bg-red-600 px-3 text-xs font-semibold text-white transition-opacity hover:bg-red-700 disabled:opacity-45 cursor-pointer"
                    >
                      <OctagonAlert className="size-3" />
                      <span>{status?.killSwitch ? "Stopped" : "Kill"}</span>
                    </button>
                  </div>
                </div>

                {/* Collapsible API URL & Bearer Token Config (Hidden until clicked) */}
                {connOpen && (
                  <div className="flex flex-col gap-3 rounded-[12px] border border-black/12 bg-black/[0.03] p-3.5">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between text-[11px] font-medium opacity-65">
                        <span>Agent URL</span>
                        <span>{isLocalApi ? "Local" : "Remote"}</span>
                      </div>
                      <input
                        type="url"
                        placeholder={DEFAULT_AGENT_API_URL}
                        value={apiUrlInput}
                        onChange={(e) => handleSaveApiUrl(e.target.value)}
                        className="h-8 w-full border-b border-black/25 bg-transparent px-0.5 text-xs font-medium text-black placeholder:text-black/35 transition-colors focus:border-black focus:outline-none"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[11px] font-medium opacity-65">Access Token</span>
                      <input
                        type="password"
                        placeholder="Paste token"
                        value={tokenInput}
                        onChange={(e) => handleSaveToken(e.target.value)}
                        className="h-8 w-full border-b border-black/25 bg-transparent px-0.5 text-xs font-medium text-black placeholder:text-black/35 transition-colors focus:border-black focus:outline-none"
                      />
                    </div>
                  </div>
                )}

                {/* Runtime Action Bar */}
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    disabled={!canStart}
                    onClick={() => void runControl("Start runtime", () => client.start())}
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-black text-xs font-medium text-[#f8f7ee] transition-transform active:scale-[0.98] disabled:opacity-35 cursor-pointer"
                  >
                    <Play className="size-3" />
                    Start
                  </button>
                  <button
                    type="button"
                    disabled={disconnected || actionBusy || status?.paused}
                    onClick={() => void runControl("Pause entries", () => client.pause())}
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-black/20 text-xs font-medium text-black transition-colors hover:bg-black/5 disabled:opacity-35 cursor-pointer"
                  >
                    <Pause className="size-3" />
                    Pause
                  </button>
                  <button
                    type="button"
                    disabled={!canResume}
                    onClick={() => void runControl("Resume entries", () => client.resume())}
                    className="inline-flex h-9 items-center justify-center rounded-full border border-black/20 text-xs font-medium text-black transition-colors hover:bg-black/5 disabled:opacity-35 cursor-pointer"
                  >
                    Resume
                  </button>
                </div>

                {/* Risk Utilization Bars */}
                {config && metrics && (
                  <div className="grid grid-cols-2 gap-3 text-[11px]">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex justify-between">
                        <span className="opacity-65">Exposure</span>
                        <span className="tabular-nums-mono font-medium">
                          {pctBar(
                            metrics.currentTotalExposurePayment,
                            config.riskLimits.maxTotalExposurePayment,
                          )}
                          %
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10">
                        <div
                          className="h-full bg-black transition-all"
                          style={{
                            width: `${pctBar(metrics.currentTotalExposurePayment, config.riskLimits.maxTotalExposurePayment)}%`,
                          }}
                        />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <div className="flex justify-between">
                        <span className="opacity-65">Daily Loss</span>
                        <span className="tabular-nums-mono font-medium">
                          {pctBar(
                            metrics.dailyRealizedLossPayment,
                            config.riskLimits.maxDailyRealizedLossPayment,
                          )}
                          %
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10">
                        <div
                          className="h-full bg-red-600 transition-all"
                          style={{
                            width: `${pctBar(metrics.dailyRealizedLossPayment, config.riskLimits.maxDailyRealizedLossPayment)}%`,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Perforated Tear-Line with Semicircular Notches */}
                <div className="relative flex items-center">
                  <span
                    aria-hidden="true"
                    className="absolute -left-8 size-4 rounded-full bg-background"
                  />
                  <div className="w-full border-t border-dashed border-black/20" />
                  <span
                    aria-hidden="true"
                    className="absolute -right-8 size-4 rounded-full bg-background"
                  />
                </div>

                {/* Deterministic Strategy Parameters */}
                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-3 gap-1 rounded-full border border-black/15 bg-black/[0.04] p-1">
                    {(["price_threshold", "momentum", "volatility_aware"] as const).map((st) => (
                      <button
                        key={st}
                        type="button"
                        onClick={() => setStrategyType(st)}
                        className={cn(
                          "h-7 rounded-full text-[11px] font-medium transition-colors cursor-pointer",
                          strategyType === st
                            ? "bg-black text-[#f8f7ee]"
                            : "text-black/60 hover:text-black",
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

                  <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                    <div className="flex flex-col gap-0.5">
                      <label className="text-[10px] font-semibold uppercase tracking-[0.08em] opacity-60">
                        Take Profit (bps)
                      </label>
                      <input
                        type="number"
                        value={tpInput}
                        onChange={(e) => setTpInput(e.target.value)}
                        className="tabular-nums-mono h-9 w-full border-b border-black/25 bg-transparent px-0.5 text-sm font-semibold text-black transition-colors focus:border-black focus:outline-none"
                      />
                      {config && (
                        <span className="tabular-nums-mono text-[10px] opacity-50">
                          Bounds {config.policyBounds.minTakeProfitBps}–{config.policyBounds.maxTakeProfitBps}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <label className="text-[10px] font-semibold uppercase tracking-[0.08em] opacity-60">
                        Stop Loss (bps)
                      </label>
                      <input
                        type="number"
                        value={slInput}
                        onChange={(e) => setSlInput(e.target.value)}
                        className="tabular-nums-mono h-9 w-full border-b border-black/25 bg-transparent px-0.5 text-sm font-semibold text-black transition-colors focus:border-black focus:outline-none"
                      />
                      {config && (
                        <span className="tabular-nums-mono text-[10px] opacity-50">
                          Bounds {config.policyBounds.minStopLossBps}–{config.policyBounds.maxStopLossBps}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <label className="text-[10px] font-semibold uppercase tracking-[0.08em] opacity-60">
                        Max Slippage (bps)
                      </label>
                      <input
                        type="number"
                        value={slipInput}
                        onChange={(e) => setSlipInput(e.target.value)}
                        className="tabular-nums-mono h-9 w-full border-b border-black/25 bg-transparent px-0.5 text-sm font-semibold text-black transition-colors focus:border-black focus:outline-none"
                      />
                      {config && (
                        <span className="tabular-nums-mono text-[10px] opacity-50">
                          Cap ≤ {config.policyBounds.hardMaxSlippageBps}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <label className="text-[10px] font-semibold uppercase tracking-[0.08em] opacity-60">
                        Max Position (raw)
                      </label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={maxPosInput}
                        onChange={(e) => setMaxPosInput(e.target.value)}
                        className="tabular-nums-mono h-9 w-full border-b border-black/25 bg-transparent px-0.5 text-sm font-semibold text-black transition-colors focus:border-black focus:outline-none"
                      />
                      {config && (
                        <span className="tabular-nums-mono truncate text-[10px] opacity-50">
                          Cap ≤ {config.policyBounds.hardMaxPositionSizeInventory}
                        </span>
                      )}
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={disconnected || actionBusy}
                    onClick={() => void handleStrategySave()}
                    className="h-9 w-full rounded-full bg-black text-xs font-medium text-[#f8f7ee] transition-transform active:scale-[0.985] disabled:opacity-40 cursor-pointer"
                  >
                    Apply Validated Policy
                  </button>
                </div>

                {/* Perforated Tear-Line 2 */}
                <div className="relative flex items-center">
                  <span
                    aria-hidden="true"
                    className="absolute -left-8 size-4 rounded-full bg-background"
                  />
                  <div className="w-full border-t border-dashed border-black/20" />
                  <span
                    aria-hidden="true"
                    className="absolute -right-8 size-4 rounded-full bg-background"
                  />
                </div>

                {/* Natural-Language Policy Translator */}
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-semibold">NL Policy Translator</span>
                    <span className="tabular-nums-mono opacity-60">
                      {policyHistory.length} saved
                    </span>
                  </div>
                  <div className="flex items-end gap-2">
                    <input
                      type="text"
                      placeholder='e.g. "momentum, take profit 4%, stop loss 2%"'
                      value={nlInstruction}
                      onChange={(e) => setNlInstruction(e.target.value)}
                      className="h-9 flex-1 border-b border-black/25 bg-transparent px-0.5 text-xs font-medium text-black placeholder:text-black/40 transition-colors focus:border-black focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={disconnected || actionBusy || !nlInstruction.trim()}
                      onClick={async () => {
                        setActionBusy(true);
                        setActionFeedback(null);
                        try {
                          const prop = await client.proposePolicy(nlInstruction.trim());
                          setNlProposal({
                            instruction: prop.instruction,
                            proposedPatch: prop.proposedPatch,
                            valid: prop.validation.valid,
                            rejectedFields: prop.validation.rejectedFields,
                          });
                        } catch (err) {
                          setActionFeedback({
                            kind: "err",
                            text: err instanceof Error ? err.message : "Proposal failed",
                          });
                        } finally {
                          setActionBusy(false);
                        }
                      }}
                      className="h-8 shrink-0 rounded-full border border-black/25 px-3 text-[11px] font-semibold transition-colors hover:bg-black hover:text-[#f8f7ee] disabled:opacity-40 cursor-pointer"
                    >
                      Propose
                    </button>
                  </div>

                  {nlProposal && (
                    <div className="flex flex-col gap-2 rounded-[10px] border border-black/15 bg-white/80 p-3 text-[11px]">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold">
                          Patch ({nlProposal.valid ? "Valid" : "Rejected"})
                        </span>
                        {nlProposal.valid && (
                          <button
                            type="button"
                            disabled={actionBusy}
                            onClick={async () => {
                              await runControl(
                                "Apply NL policy",
                                () => client.applyPolicy(nlProposal.instruction),
                                { forceFormSync: true },
                              );
                              setNlProposal(null);
                              setNlInstruction("");
                            }}
                            className="h-6 rounded-full bg-black px-2.5 text-[10px] font-medium text-[#f8f7ee] cursor-pointer"
                          >
                            Authorize &amp; Apply
                          </button>
                        )}
                      </div>
                      <pre className="overflow-x-auto font-mono text-[10px] opacity-75">
                        {JSON.stringify(nlProposal.proposedPatch, null, 2)}
                      </pre>
                      {nlProposal.rejectedFields.length > 0 && (
                        <span className="font-medium text-red-700">
                          Blocked: {nlProposal.rejectedFields.join(", ")}
                        </span>
                      )}
                    </div>
                  )}

                  {policyHistory.length > 0 && (
                    <div className="flex flex-col gap-1.5 pt-1 text-[11px]">
                      <div className="flex items-center gap-1.5 font-semibold opacity-75">
                        <History className="size-3" />
                        <span>Policy History</span>
                      </div>
                      <div className="flex max-h-32 flex-col gap-1 overflow-y-auto">
                        {policyHistory
                          .slice()
                          .reverse()
                          .map((entry) => (
                            <div
                              key={`${entry.version}-${entry.timestamp}`}
                              className="flex items-center justify-between gap-2 rounded-[8px] border border-black/10 bg-black/[0.03] px-2.5 py-1.5"
                            >
                              <div className="flex min-w-0 flex-col">
                                <span className="tabular-nums-mono font-medium">
                                  v{entry.version} · {entry.source} · {fmtTime(entry.timestamp)}
                                </span>
                                {entry.instruction && (
                                  <span className="truncate text-[10px] opacity-65">
                                    &ldquo;{entry.instruction}&rdquo;
                                  </span>
                                )}
                              </div>
                              {entry.version !== policyVersion && (
                                <button
                                  type="button"
                                  disabled={disconnected || actionBusy}
                                  onClick={() =>
                                    void runControl(
                                      `Rollback to v${entry.version}`,
                                      () => client.rollbackPolicy(entry.version),
                                      { forceFormSync: true },
                                    )
                                  }
                                  className="shrink-0 rounded-full border border-black/20 px-2 py-0.5 text-[10px] font-medium hover:bg-black hover:text-[#f8f7ee] cursor-pointer disabled:opacity-40"
                                >
                                  Rollback
                                </button>
                              )}
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                </div>

                {actionFeedback && (
                  <div
                    className={cn(
                      "flex items-start gap-2 rounded-[10px] border px-3 py-2 text-xs",
                      actionFeedback.kind === "ok"
                        ? "border-emerald-700/30 bg-emerald-700/10 text-emerald-900"
                        : "border-red-700/30 bg-red-700/10 text-red-900",
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
              </div>

              {/* Exact Tranche Double-Chevron Serrated Bottom Edge */}
              <svg
                viewBox="0 0 440 32"
                preserveAspectRatio="none"
                aria-hidden="true"
                className="block h-6 w-full -mt-[2px]"
              >
                <polygon
                  points="0,0 440,0 440,32 330,4 220,32 110,4 0,32"
                  style={{ fill: "#f8f7ee" }}
                />
              </svg>
            </div>
          </aside>
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
