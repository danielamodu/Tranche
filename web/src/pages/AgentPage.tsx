import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  History,
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
  const [connError, setConnError] = useState<string | null>(null);
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
        if (seq !== requestSeqRef.current) return; // Discard out-of-order stale response
        setSnapshot(data);
        setDisconnected(false);
        setRateLimited(false);
        setConnError(null);
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
          setConnError("Rate limit exceeded (HTTP 429). Polling backed off automatically.");
        } else {
          setDisconnected(true);
          setRateLimited(false);
          setConnError(
            err instanceof Error
              ? err.message
              : `Agent API unreachable at ${client.getBaseUrl()}`,
          );
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

  // Polling with tab-visibility pause and 429 backoff
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
      subtitle={`Source: ${status?.dataSource ?? "—"} · Chain ${status?.chainId ?? "—"} · ${status?.quotesAreReal ? "Real Quotes" : "Simulated Fixture"} · ${isDryRun ? "DRY-RUN" : "LIVE"}`}
      onNavigate={onNavigate}
      onRefresh={() => void loadSnapshot(true)}
      refreshing={refreshing}
      headerActions={
        <div className="flex flex-wrap items-center gap-2">
          {!disconnected && ready && (
            <span
              className={cn(
                "tabular-nums-mono inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
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
        {/* Hosted HTTPS -> Localhost Guidance Banner */}
        {hostedLocalMismatch && disconnected && (
          <div className="flex flex-col gap-2 rounded-[16px] border border-amber-500/40 bg-amber-500/10 px-5 py-4 text-xs text-amber-200">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="size-4 shrink-0" />
              <span>Hosted HTTPS page cannot automatically call a localhost Agent API</span>
            </div>
            <p className="leading-relaxed text-amber-100/85">
              Browsers block mixed-content requests from <code className="font-mono">https://</code>{" "}
              to <code className="font-mono">{normalizedApiUrl}</code>, and the local Agent API
              restricts CORS to <code className="font-mono">localhost:5173</code> /{" "}
              <code className="font-mono">127.0.0.1:5173</code> by default. To operate Tranche
              Agent:
            </p>
            <ul className="list-disc space-y-1 pl-5 text-[11px] text-amber-100/85">
              <li>
                <strong>Local operator mode (recommended):</strong> run{" "}
                <code className="rounded bg-background/60 px-1.5 py-0.5 font-mono">
                  cd agent && npm run api
                </code>{" "}
                and{" "}
                <code className="rounded bg-background/60 px-1.5 py-0.5 font-mono">
                  cd web && npm run dev
                </code>
                , then open <code className="font-mono">http://localhost:5173/agent</code>.
              </li>
              <li>
                <strong>Remote API mode:</strong> enter a reachable HTTPS Agent API URL below whose{" "}
                <code className="font-mono">AGENT_API_ALLOWED_ORIGINS</code> includes this origin.
              </li>
            </ul>
          </div>
        )}

        {/* Generic Disconnection Banner */}
        {disconnected && !hostedLocalMismatch && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] border border-destructive/40 bg-destructive/10 px-5 py-3.5 text-xs text-destructive">
            <div className="flex items-center gap-2.5">
              <WifiOff className="size-4 shrink-0" />
              <span>
                Agent API unreachable at{" "}
                <code className="rounded bg-background/60 px-1.5 py-0.5 font-mono">
                  {client.getBaseUrl()}
                </code>{" "}
                ({connError ?? "Unavailable"}). Start the local server with{" "}
                <code className="rounded bg-background/60 px-1.5 py-0.5 font-mono">
                  cd agent && npm run api
                </code>{" "}
                or update the API URL in Risk Controls &amp; Policy.
              </span>
            </div>
          </div>
        )}

        {/* HTTP 429 Rate Limit Banner (distinct from disconnected) */}
        {rateLimited && !disconnected && (
          <div className="flex items-center gap-2.5 rounded-[16px] border border-amber-500/40 bg-amber-500/10 px-5 py-3 text-xs text-amber-200">
            <AlertTriangle className="size-4 shrink-0" />
            <span>
              Agent API rate limit reached (HTTP 429). Polling automatically backed off to 35s;
              close extra Agent Console tabs if open.
            </span>
          </div>
        )}

        {/* Stale Telemetry Banner */}
        {!disconnected && isStale && (
          <div className="flex items-center gap-2.5 rounded-[16px] border border-amber-500/40 bg-amber-500/10 px-5 py-3 text-xs text-amber-300">
            <AlertTriangle className="size-4 shrink-0" />
            <span>Agent telemetry is stale (&gt;40s since last successful poll).</span>
          </div>
        )}

        {/* Corrupted Persisted State Banner */}
        {status?.stateCorrupted && (
          <div className="flex items-start gap-2.5 rounded-[16px] border border-destructive/50 bg-destructive/15 px-5 py-3.5 text-xs text-destructive">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong>Persisted State Corrupted:</strong> Fail-closed safety lock active. Runtime
              Start and Resume are disabled until persisted state is repaired on disk.
            </span>
          </div>
        )}

        {/* Authoritative Kill Switch Banner */}
        {status?.killSwitch && (
          <div className="flex items-start gap-2.5 rounded-[16px] border border-destructive/50 bg-destructive/15 px-5 py-3.5 text-xs text-destructive">
            <OctagonAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong>Kill Switch Active (Authoritative Halt):</strong> All entries, exercises, and
              exits are blocked. Unlike ordinary Pause, the kill switch cannot be cleared via
              Resume.
            </span>
          </div>
        )}

        {/* Pending Transactions Blocking Banner */}
        {status && status.pendingTxs.length > 0 && (
          <div className="flex flex-col gap-3 rounded-[16px] border border-amber-500/40 bg-amber-500/10 p-4 text-xs">
            <div className="flex items-center gap-2 font-medium text-amber-200">
              <AlertTriangle className="size-4" />
              <span>
                {status.pendingTxs.length} Uncertain Pending Transaction(s) Blocking New Entries &amp;
                Resume
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

        {/* 1. Agent Overview Grid */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-[18px] border border-border bg-card p-4">
            <span className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
              Runtime &amp; Readiness
            </span>
            <div className="mt-2 flex items-center justify-between">
              <span className="font-display text-lg font-semibold">
                {loading
                  ? "Connecting…"
                  : status?.killSwitch
                    ? "KILLED"
                    : status?.stateCorrupted
                      ? "CORRUPTED"
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
              RPC:{" "}
              <span
                className={cn(
                  "font-medium",
                  health?.rpcHealthy === false ? "text-destructive" : "text-foreground",
                )}
              >
                {health ? (health.rpcHealthy ? "Healthy" : "Unhealthy") : "Unavailable"}
              </span>{" "}
              · Recovery: <span className="text-foreground">{health?.recoveryState ?? "—"}</span>
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
              Strategy:{" "}
              <span className="text-foreground">{status?.activeStrategy ?? "Unavailable"}</span> ·
              Last: <span className="text-foreground">{status?.lastDecisionAction ?? "—"}</span>
            </p>
          </div>

          <div className="rounded-[18px] border border-border bg-card p-4">
            <span className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
              Realized / Unrealized P&amp;L
            </span>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="tabular-nums-mono font-display text-lg font-semibold">
                {fmtPayment6(metrics?.totalRealizedPnlPayment, paymentSymbol)}
              </span>
              <span className="tabular-nums-mono text-xs text-muted-foreground">
                / {fmtPayment6(metrics?.totalUnrealizedPnlPayment, paymentSymbol)}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Exposure: {fmtPayment6(metrics?.currentTotalExposurePayment, paymentSymbol)} · Cycles:{" "}
              {metrics?.totalCycles ?? "—"}
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
                OK {fmtTime(health?.lastSuccessfulCycleAt ?? status?.lastCycleTimestamp)}
              </span>
            </div>
            <p className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>W/L: {metrics ? `${metrics.wins}W / ${metrics.losses}L` : "Unavailable"}</span>
              {status?.lastTxHash && (
                <a
                  href={explorerTxUrl(status.lastTxHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="tabular-nums-mono inline-flex items-center gap-0.5 text-foreground underline underline-offset-4"
                >
                  {shortHash(status.lastTxHash)}
                  <ArrowUpRight className="size-3" />
                </a>
              )}
            </p>
          </div>
        </div>

        {/* 2. Market Intelligence + Risk Controls & Strategy Config */}
        <div className="grid gap-5 lg:grid-cols-2">
          {/* Market Intelligence */}
          <section className="flex flex-col gap-4 rounded-[20px] border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-base font-semibold">Market Intelligence</h2>
                <p className="text-xs text-muted-foreground">
                  Live Tranche vs. HSKSwap venue economics, regime &amp; oracle health
                </p>
              </div>
              <div className="flex items-center gap-2">
                {markets?.marketRegime && (
                  <span className="tabular-nums-mono rounded-full border border-border bg-background px-2.5 py-0.5 text-[10px] font-medium text-foreground">
                    {markets.marketRegime}
                  </span>
                )}
                <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                  {markets?.available ? `Updated ${fmtTime(markets.timestamp)}` : "Unavailable"}
                </span>
              </div>
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
                      {fmtPayment6(
                        markets.venueComparison.tranche.acquisitionCostPayment,
                        paymentSymbol,
                      )}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Prem{" "}
                      {fmtPayment6(
                        markets.venueComparison.tranche.reservationPremiumPayment,
                        paymentSymbol,
                      )}{" "}
                      + Ex{" "}
                      {fmtPayment6(markets.venueComparison.tranche.exercisePayment, paymentSymbol)}
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
                      {fmtPayment6(
                        markets.venueComparison.hskswap.acquisitionCostPayment,
                        paymentSymbol,
                      )}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Impact: {markets.venueComparison.hskswap.priceImpactBps ?? "—"} bps
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Exit quote:{" "}
                      {fmtPayment6(markets.dexSellQuote?.paymentAmountOut, paymentSymbol)}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 rounded-[12px] border border-border bg-background px-3.5 py-2.5 text-[11px] sm:grid-cols-5">
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
                      {markets.oracleDeviationBps !== null &&
                      markets.oracleDeviationBps !== undefined
                        ? `${markets.oracleDeviationBps} bps`
                        : "Unavailable"}
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Volatility</span>
                    <div className="tabular-nums-mono font-medium text-foreground">
                      {markets.realizedVolatilityBps !== undefined
                        ? `${markets.realizedVolatilityBps} bps`
                        : "Unavailable"}
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Momentum</span>
                    <div className="tabular-nums-mono font-medium text-foreground">
                      {markets.momentumReturnBps !== undefined
                        ? `${markets.momentumReturnBps >= 0 ? "+" : ""}${markets.momentumReturnBps} bps`
                        : "Unavailable"}
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">TWAP Disloc.</span>
                    <div className="tabular-nums-mono font-medium text-foreground">
                      {markets.dislocationVsTwapBps !== undefined
                        ? `${markets.dislocationVsTwapBps >= 0 ? "+" : ""}${markets.dislocationVsTwapBps} bps`
                        : "Unavailable"}
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
                Market snapshot unavailable. Connect to a running Agent API to observe live quotes
                and venue comparisons.
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

            {/* Agent API URL + Bearer Token Configuration */}
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>Agent API URL</span>
                  <span className="tabular-nums-mono">
                    {isLocalApi ? "Localhost" : "Remote API"}
                  </span>
                </div>
                <Input
                  type="url"
                  placeholder={DEFAULT_AGENT_API_URL}
                  value={apiUrlInput}
                  onChange={(e) => handleSaveApiUrl(e.target.value)}
                  className="tabular-nums-mono h-9 rounded-[10px] bg-background text-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground">
                  Bearer Token (sessionStorage only)
                </span>
                <Input
                  type="password"
                  placeholder="Required for Start / Pause / Policy"
                  value={tokenInput}
                  onChange={(e) => handleSaveToken(e.target.value)}
                  className="tabular-nums-mono h-9 rounded-[10px] bg-background text-xs"
                />
              </div>
            </div>

            {/* Runtime Controls */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!canStart}
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
                disabled={!canResume}
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
                      {fmtPayment6(metrics.currentTotalExposurePayment, paymentSymbol)} /{" "}
                      {fmtPayment6(config.riskLimits.maxTotalExposurePayment, paymentSymbol)}
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
                      {fmtPayment6(metrics.dailyRealizedLossPayment, paymentSymbol)} /{" "}
                      {fmtPayment6(config.riskLimits.maxDailyRealizedLossPayment, paymentSymbol)}
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

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-muted-foreground">Take Profit (bps)</label>
                  <Input
                    type="number"
                    value={tpInput}
                    onChange={(e) => setTpInput(e.target.value)}
                    className="tabular-nums-mono h-9 rounded-[10px] bg-background text-xs"
                  />
                  {config && (
                    <span className="tabular-nums-mono text-[10px] text-muted-foreground">
                      {config.policyBounds.minTakeProfitBps}–{config.policyBounds.maxTakeProfitBps}
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-muted-foreground">Stop Loss (bps)</label>
                  <Input
                    type="number"
                    value={slInput}
                    onChange={(e) => setSlInput(e.target.value)}
                    className="tabular-nums-mono h-9 rounded-[10px] bg-background text-xs"
                  />
                  {config && (
                    <span className="tabular-nums-mono text-[10px] text-muted-foreground">
                      {config.policyBounds.minStopLossBps}–{config.policyBounds.maxStopLossBps}
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-muted-foreground">Max Slippage (bps)</label>
                  <Input
                    type="number"
                    value={slipInput}
                    onChange={(e) => setSlipInput(e.target.value)}
                    className="tabular-nums-mono h-9 rounded-[10px] bg-background text-xs"
                  />
                  {config && (
                    <span className="tabular-nums-mono text-[10px] text-muted-foreground">
                      ≤ {config.policyBounds.hardMaxSlippageBps}
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-muted-foreground">Max Position (raw)</label>
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={maxPosInput}
                    onChange={(e) => setMaxPosInput(e.target.value)}
                    className="tabular-nums-mono h-9 rounded-[10px] bg-background text-xs"
                  />
                  {config && (
                    <span className="tabular-nums-mono truncate text-[10px] text-muted-foreground">
                      ≤ {config.policyBounds.hardMaxPositionSizeInventory}
                    </span>
                  )}
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

            <Separator />

            {/* Bounded NL Policy Translator (Propose -> Apply -> Rollback) */}
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-medium text-foreground">
                  Natural-Language Policy Translator (v{policyVersion})
                </span>
                <span className="tabular-nums-mono text-muted-foreground">
                  {policyHistory.length} persisted version{policyHistory.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="flex gap-2">
                <Input
                  type="text"
                  placeholder='e.g. "momentum, take profit 4%, stop loss 2%"'
                  value={nlInstruction}
                  onChange={(e) => setNlInstruction(e.target.value)}
                  className="h-9 rounded-[10px] bg-background text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
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
                  className="h-9 shrink-0 rounded-full px-3.5 text-xs cursor-pointer"
                >
                  Propose
                </Button>
              </div>
              {nlProposal && (
                <div className="flex flex-col gap-2 rounded-[12px] border border-border bg-background p-3 text-[11px]">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-foreground">
                      Proposed Patch ({nlProposal.valid ? "Valid" : "Rejected"})
                    </span>
                    {nlProposal.valid && (
                      <Button
                        type="button"
                        size="sm"
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
                        className="h-7 rounded-full px-3 text-[11px] cursor-pointer"
                      >
                        Authorize &amp; Apply
                      </Button>
                    )}
                  </div>
                  <pre className="overflow-x-auto font-mono text-[10px] text-muted-foreground">
                    {JSON.stringify(nlProposal.proposedPatch, null, 2)}
                  </pre>
                  {nlProposal.rejectedFields.length > 0 && (
                    <span className="text-destructive">
                      Blocked by hard bounds: {nlProposal.rejectedFields.join(", ")}
                    </span>
                  )}
                </div>
              )}

              {/* Persisted Policy History & Safe Rollback */}
              {policyHistory.length > 0 && (
                <div className="mt-1 flex flex-col gap-1.5 rounded-[12px] border border-border bg-background p-3 text-[11px]">
                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                    <History className="size-3.5 text-muted-foreground" />
                    <span>Policy History</span>
                  </div>
                  <div className="flex max-h-36 flex-col gap-1.5 overflow-y-auto pr-1">
                    {policyHistory
                      .slice()
                      .reverse()
                      .map((entry) => (
                        <div
                          key={`${entry.version}-${entry.timestamp}`}
                          className="flex items-center justify-between gap-2 rounded-[8px] border border-border/60 px-2.5 py-1.5"
                        >
                          <div className="flex min-w-0 flex-col">
                            <span className="tabular-nums-mono font-medium text-foreground">
                              v{entry.version} · {entry.source} · {fmtTime(entry.timestamp)}
                            </span>
                            {entry.instruction && (
                              <span className="truncate text-[10px] text-muted-foreground">
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
                              className="shrink-0 rounded-full border border-border px-2.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground cursor-pointer disabled:opacity-50"
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
                Structured engine traces with venue comparison, risk checks, and confirmed tx links
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
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="tabular-nums-mono">
                      Tranche: {fmtPayment6(d.tranche.acquisitionCostPayment, paymentSymbol)} (
                      {d.tranche.eligible ? "OK" : d.tranche.rejectionReasons.join(", ")})
                    </span>
                    <span className="tabular-nums-mono">
                      HSKSwap: {fmtPayment6(d.hskswap.acquisitionCostPayment, paymentSymbol)} (
                      {d.hskswap.eligible ? "OK" : d.hskswap.rejectionReasons.join(", ")})
                    </span>
                    <span>
                      Risk:{" "}
                      {d.riskAllowed
                        ? "PASSED"
                        : `BLOCKED (${d.failedRiskChecks.map((c) => c.name).join(", ")})`}
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
                    className="flex flex-col gap-1.5 rounded-[12px] border border-border bg-background px-3.5 py-2.5 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground">
                        {p.positionId} · {p.venue} ({p.status})
                      </span>
                      <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                        Unrealized: {fmtPayment6(p.unrealizedPnlPayment, paymentSymbol)}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      <span className="tabular-nums-mono">
                        Cost: {fmtPayment6(p.entryCostPayment, paymentSymbol)} · Realized:{" "}
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
              <p className="text-xs text-muted-foreground">
                No positions opened (
                {isDryRun ? "dry-run mode does not broadcast trades" : "none"}).
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
                    className="flex flex-col gap-1.5 rounded-[12px] border border-border bg-background px-3.5 py-2.5 text-xs"
                  >
                    <span className="font-medium text-foreground">
                      Ticket #{t.ticketId} · Offer #{t.offerId} ({t.status})
                    </span>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      <span className="tabular-nums-mono">
                        Premium: {fmtPayment6(t.premiumPaidPayment, paymentSymbol)} · Expires{" "}
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
