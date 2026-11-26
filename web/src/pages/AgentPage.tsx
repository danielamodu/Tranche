import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Eye,
  OctagonAlert,
  Pause,
  Play,
  Settings2,
  ShieldAlert,
  WifiOff,
} from "lucide-react";
import { AgentIntelligencePanel } from "@/components/AgentIntelligencePanel";
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
  normalizeAgentApiUrl,
  type AgentDashboardSnapshot,
  type AgentIntelligenceSnapshot,
  type StrategyType,
} from "@/lib/agentApi";
import { cn } from "@/lib/utils";
import type { AppRoute } from "@/App";

export type AgentView = "overview" | "activity" | "policy";

interface AgentPageProps {
  view?: AgentView;
  onNavigate: (path: AppRoute) => void;
}

const TOKEN_STORAGE_KEY = "tranche-agent-token";
const API_URL_STORAGE_KEY = "tranche-agent-api-url";
const BASE_POLL_MS = 15_000;
const RATE_LIMITED_POLL_MS = 35_000;

function fmtPayment6(raw: string | undefined | null, symbol = "USDT"): string {
  if (raw === undefined || raw === null || raw === "") return "—";
  try {
    const val = Number(BigInt(raw)) / 1e6;
    if (!Number.isFinite(val)) return "—";
    return `$${val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${symbol}`;
  } catch {
    return "—";
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

function humanStrategy(type: string | undefined): string {
  if (type === "price_threshold") return "Buy Below Target Price";
  if (type === "momentum") return "Trend Following";
  if (type === "volatility_aware") return "Volatility-Protected";
  return "Default Strategy";
}

function humanRegime(regime: string | undefined): string {
  if (regime === "CALM") return "Calm Market";
  if (regime === "TRENDING") return "Trending";
  if (regime === "VOLATILE") return "High Volatility";
  if (regime === "DISLOCATED") return "Price Gap";
  return "Checking…";
}

function humanAction(action: string): { label: string; tone: "neutral" | "good" | "warn" } {
  switch (action) {
    case "READ_ONLY_SWAP_HSKSWAP":
      return { label: "Best price on HSKSwap", tone: "good" };
    case "READ_ONLY_RESERVE_TRANCHE":
      return { label: "Best price on Tranche", tone: "good" };
    case "DRY_RUN_SWAP_HSKSWAP":
      return { label: "Simulated HSKSwap buy", tone: "good" };
    case "DRY_RUN_RESERVE_TRANCHE":
      return { label: "Simulated Tranche lock", tone: "good" };
    case "SWAP_HSKSWAP":
      return { label: "Bought on HSKSwap", tone: "good" };
    case "RESERVE_TRANCHE":
      return { label: "Locked price on Tranche", tone: "good" };
    case "SKIPPED_DUPLICATE":
      return { label: "Skipped (checked recently)", tone: "neutral" };
    case "WAIT":
      return { label: "Waiting for a better price", tone: "neutral" };
    case "BLOCKED_RISK":
      return { label: "Stopped by spending limit", tone: "warn" };
    case "EXECUTION_FAILED":
      return { label: "Trade did not go through", tone: "warn" };
    default:
      return { label: action.replace(/_/g, " ").toLowerCase(), tone: "neutral" };
  }
}

function humanDecisionSummary(d: AgentDashboardSnapshot["decisions"][number]): string {
  if (d.selectedAction === "SKIPPED_DUPLICATE") {
    return "Checked this price a moment ago — skipped to avoid placing a repeat order.";
  }
  if (d.selectedAction === "READ_ONLY_SWAP_HSKSWAP") {
    return `Price hit your target. HSKSwap (${fmtPayment6(d.hskswap.acquisitionCostPayment)}) is the best option right now because no Tranche offers are posted for this pair yet. Preview mode is on, so no trade was sent.`;
  }
  if (d.selectedAction === "READ_ONLY_RESERVE_TRANCHE") {
    return `Price hit your target. Tranche (${fmtPayment6(d.tranche.acquisitionCostPayment)}) is the cheaper option right now. Preview mode is on, so no trade was sent.`;
  }
  if (d.selectedAction === "BLOCKED_RISK") {
    const failed = d.failedRiskChecks.map((c) => c.name.replace(/_/g, " ")).join(", ");
    return `Your spending limits stopped this trade (${failed || "limit reached"}).`;
  }
  return d.rationale;
}

export function AgentPage({ view = "overview", onNavigate }: AgentPageProps) {
  const [apiUrlInput, setApiUrlInput] = useState<string>(() => {
    const saved = sessionStorage.getItem(API_URL_STORAGE_KEY);
    return saved ? normalizeAgentApiUrl(saved) : normalizeAgentApiUrl(DEFAULT_AGENT_API_URL);
  });
  const [tokenInput, setTokenInput] = useState<string>(
    () => sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "",
  );
  const [controlsOpen, setControlsOpen] = useState(false);
  const [killDialogOpen, setKillDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"decisions" | "positions" | "tickets">("decisions");

  const normalizedApiUrl = useMemo(() => normalizeAgentApiUrl(apiUrlInput), [apiUrlInput]);
  const client = useMemo(
    () => new AgentApiClient({ baseUrl: normalizedApiUrl, token: tokenInput }),
    [normalizedApiUrl, tokenInput],
  );
  const hostedLocalMismatch = useMemo(
    () => isHostedHttpsToLocalApi(normalizedApiUrl),
    [normalizedApiUrl],
  );

  const [snapshot, setSnapshot] = useState<AgentDashboardSnapshot | null>(null);
  const [intelligence, setIntelligence] = useState<AgentIntelligenceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  // Strategy & NL Policy form state (inside Controls modal)
  const [strategyType, setStrategyType] = useState<StrategyType>("price_threshold");
  const [tpInput, setTpInput] = useState("500");
  const [slInput, setSlInput] = useState("300");
  const [slipInput, setSlipInput] = useState("100");
  const [maxPosInput, setMaxPosInput] = useState("200000000000000000000");
  const [nlInstruction, setNlInstruction] = useState("");
  const [nlProposal, setNlProposal] = useState<{
    instruction: string;
    proposedPatch: Record<string, unknown>;
    valid: boolean;
    rejectedFields: string[];
  } | null>(null);

  const requestSeqRef = useRef(0);
  const lastSyncedVersionRef = useRef<number | null>(null);

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
        const [data, intel] = await Promise.all([
          client.fetchSnapshot(),
          client.getIntelligence().catch(() => null),
        ]);
        if (seq !== requestSeqRef.current) return;
        setSnapshot(data);
        setIntelligence(intel);
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
      if (typeof document !== "undefined" && !document.hidden) void loadSnapshot(false);
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
    if (!Number.isFinite(takeProfitBps) || !Number.isFinite(stopLossBps) || !Number.isFinite(maxSlippageBps)) {
      setActionFeedback({ kind: "err", text: "Take-profit, stop-loss, and slippage must be numbers." });
      return;
    }
    if (!/^\d+$/.test(trimmedMaxPos)) {
      setActionFeedback({ kind: "err", text: "Max position size must be a whole integer." });
      return;
    }
    await runControl(
      "Update strategy",
      () =>
        client.updateStrategy({
          strategyType,
          takeProfitBps,
          stopLossBps,
          maxSlippageBps,
          maxPositionSizeInventory: trimmedMaxPos,
        }),
      { forceFormSync: true },
    );
  }

  async function handleProposePolicy() {
    if (!nlInstruction.trim()) return;
    setActionBusy(true);
    setActionFeedback(null);
    try {
      const res = await client.proposePolicy(nlInstruction.trim());
      setNlProposal({
        instruction: res.instruction,
        proposedPatch: res.proposedPatch,
        valid: res.validation.valid,
        rejectedFields: res.validation.rejectedFields,
      });
      setActionFeedback({
        kind: res.validation.valid ? "ok" : "err",
        text: res.validation.valid
          ? "Proposal passed safety bounds. Click Apply to save."
          : `Rejected out-of-bounds: ${res.validation.rejectedFields.join(", ")}`,
      });
    } catch (err) {
      setActionFeedback({
        kind: "err",
        text: err instanceof AgentApiError ? `${err.code}: ${err.message}` : "Proposal failed",
      });
    } finally {
      setActionBusy(false);
    }
  }

  async function handleApplyPolicy() {
    if (!nlInstruction.trim()) return;
    await runControl("Apply policy", () => client.applyPolicy(nlInstruction.trim()), {
      forceFormSync: true,
    });
    setNlProposal(null);
  }

  const health = snapshot?.health ?? null;
  const status = snapshot?.status ?? null;
  const metrics = snapshot?.metrics ?? null;
  const markets = snapshot?.markets ?? null;
  const config = snapshot?.config ?? null;
  const policyHistory = snapshot?.policyHistory ?? null;

  const mode = (status?.mode ?? health?.mode ?? "read_only") as string;
  const isReadOnly = mode === "read_only";
  const isDryRun = mode === "dry_run";
  const isSafeObservation = isReadOnly || isDryRun;
  const winningVenue = markets?.venueComparison?.selectedVenue ?? "NONE";
  const paymentSymbol = "USDT";
  const policyVersion = policyHistory?.currentVersion ?? 0;

  const exposurePct =
    metrics && config
      ? pctBar(metrics.currentTotalExposurePayment, config.riskLimits.maxTotalExposurePayment)
      : 0;
  const lossPct =
    metrics && config
      ? pctBar(metrics.dailyRealizedLossPayment, config.riskLimits.maxDailyRealizedLossPayment)
      : 0;

  const routeForView =
    view === "activity" ? "/agent/activity" : view === "policy" ? "/agent/policy" : "/agent";
  const pageTitle =
    view === "activity"
      ? "Agent Activity"
      : view === "policy"
        ? "Rules & Controls"
        : "Tranche Agent";
  const pageSubtitle =
    view === "activity"
      ? "Recent price checks, positions & tickets"
      : view === "policy"
        ? "Strategy, spending limits & rules"
        : disconnected
          ? "Connecting…"
          : isReadOnly
            ? "Watching live prices"
            : "Active";

  return (
    <AppShell
      activeRoute={routeForView}
      onNavigate={onNavigate}
      title={pageTitle}
      subtitle={pageSubtitle}
      refreshing={refreshing}
      onRefresh={() => void loadSnapshot(true)}
      headerActions={
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
              disconnected
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : isSafeObservation
                  ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-emerald-500/40 bg-emerald-500/10 text-emerald-500",
            )}
          >
            {disconnected ? (
              <>
                <WifiOff className="size-3" />
                Offline
              </>
            ) : isReadOnly ? (
              <>
                <Eye className="size-3" />
                Preview
              </>
            ) : isDryRun ? (
              <>
                <Bot className="size-3" />
                Practice
              </>
            ) : (
              <>
                <Activity className="size-3" />
                Live
              </>
            )}
          </span>
          {view === "policy" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setControlsOpen(true)}
              className="h-8 rounded-full px-3 text-xs cursor-pointer"
            >
              <Settings2 className="mr-1.5 size-3.5" />
              Connection
            </Button>
          )}
        </div>
      }
    >
      {/* VIEW 1: AIRY OVERVIEW — One focal point, generous breathing room, zero scroll */}
      {view === "overview" && (
        <div className="flex w-full flex-col justify-between gap-8 py-2 lg:h-[calc(100svh-120px)] lg:overflow-hidden">
          {/* Calm Editorial Hero */}
          <section className="flex flex-col justify-between gap-5 pt-2 sm:flex-row sm:items-end">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    disconnected ? "bg-amber-500" : "bg-emerald-500",
                  )}
                />
                <span>
                  {disconnected
                    ? "Reconnecting to live prices…"
                    : isReadOnly
                      ? "HashKey Chain · Watching live prices"
                      : "HashKey Chain · Auto-trading active"}
                </span>
              </div>
              <h1 className="font-display text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl">
                {disconnected
                  ? "Connecting to live prices."
                  : `Watching ${status?.market ?? "WHSK/USDT"} live.`}
              </h1>
              <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
                {disconnected
                  ? hostedLocalMismatch
                    ? "Your connection URL is pointed at your local computer. Open Rules & Controls to update it."
                    : "Retrying automatically. No funds are at risk."
                  : isReadOnly
                    ? "Checking whether Tranche or HSKSwap gives you a better deal every 15 seconds. No money is spent in preview mode."
                    : "Automatically picking the better deal between Tranche and HSKSwap within your spending limits."}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2.5">
              <Button
                type="button"
                size="lg"
                onClick={() => onNavigate("/trade")}
                className="h-11 rounded-full px-6 text-sm font-medium cursor-pointer"
              >
                Make a Trade
                <ArrowRight className="ml-1.5 size-4" />
              </Button>
            </div>
          </section>

          {/* The ONE Centerpiece: Clean, Spacious Venue Comparison */}
          <section className="overflow-hidden rounded-[24px] border border-border">
            <div className="grid grid-cols-1 lg:grid-cols-12">
              {/* Left: Tranche */}
              <div
                className="flex flex-col justify-between gap-8 p-7 lg:col-span-5"
                style={{ backgroundColor: "#f8f7ee", color: "#050505" }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <span className="block text-sm font-semibold">Tranche</span>
                    <span className="text-xs opacity-60">Lock your price first</span>
                  </div>
                  <span
                    className="rounded-full px-3 py-1 text-[11px] font-medium"
                    style={{
                      backgroundColor: winningVenue === "TRANCHE" ? "#050505" : "rgba(5,5,5,0.08)",
                      color: winningVenue === "TRANCHE" ? "#f8f7ee" : "#050505",
                    }}
                  >
                    {winningVenue === "TRANCHE"
                      ? "Best Option"
                      : (markets?.trancheOffersCount ?? 0) > 0
                        ? "Available"
                        : "No Offers Yet"}
                  </span>
                </div>

                {(markets?.trancheOffersCount ?? 0) > 0 && markets?.venueComparison ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="tabular-nums-mono text-3xl font-semibold tracking-tight">
                      {fmtPayment6(markets.venueComparison.tranche.acquisitionCostPayment, paymentSymbol)}
                    </span>
                    <span className="tabular-nums-mono text-xs opacity-65">
                      Hold fee{" "}
                      {fmtPayment6(
                        markets.venueComparison.tranche.reservationPremiumPayment,
                        paymentSymbol,
                      )}{" "}
                      · Buy price{" "}
                      {fmtPayment6(markets.venueComparison.tranche.exercisePayment, paymentSymbol)}
                    </span>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <span className="text-xl font-semibold tracking-tight">
                      No offers on this pair yet
                    </span>
                    <p className="text-xs leading-relaxed opacity-70">
                      No sellers have posted a locked price for WHSK yet. You can try locking a
                      price on other pairs in the Trade Desk.
                    </p>
                  </div>
                )}

                <div className="flex items-center justify-between border-t border-black/10 pt-4 text-xs opacity-75">
                  <span>Fixed price · no surprises</span>
                  <button
                    type="button"
                    onClick={() => onNavigate("/trade")}
                    className="inline-flex items-center gap-1 font-medium underline underline-offset-4 hover:opacity-100 cursor-pointer"
                  >
                    Trade Desk
                    <ArrowRight className="size-3" />
                  </button>
                </div>
              </div>

              {/* Center: Quiet Verdict */}
              <div className="flex flex-row items-center justify-between gap-4 border-y border-border bg-muted/40 px-6 py-5 lg:col-span-2 lg:flex-col lg:justify-center lg:border-x lg:border-y-0 lg:text-center">
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Best Now
                  </span>
                  <span className="text-xl font-semibold text-foreground">
                    {winningVenue === "NONE"
                      ? "Wait"
                      : winningVenue === "TRANCHE"
                        ? "Tranche"
                        : "HSKSwap"}
                  </span>
                </div>
                <span className="rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-foreground">
                  {humanRegime(markets?.marketRegime)}
                </span>
              </div>

              {/* Right: HSKSwap */}
              <div className="flex flex-col justify-between gap-8 bg-card p-7 text-card-foreground lg:col-span-5">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <span className="block text-sm font-semibold">HSKSwap</span>
                    <span className="text-xs text-muted-foreground">Buy right away</span>
                  </div>
                  <span
                    className={cn(
                      "rounded-full px-3 py-1 text-[11px] font-medium",
                      winningVenue === "HSKSWAP"
                        ? "bg-primary text-primary-foreground"
                        : "border border-border text-muted-foreground",
                    )}
                  >
                    {winningVenue === "HSKSWAP" ? "Best Option" : "Available"}
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="tabular-nums-mono text-3xl font-semibold tracking-tight">
                    {markets?.venueComparison
                      ? fmtPayment6(
                          markets.venueComparison.hskswap.acquisitionCostPayment,
                          paymentSymbol,
                        )
                      : "—"}
                  </span>
                  <span className="tabular-nums-mono text-xs text-muted-foreground">
                    {markets?.venueComparison
                      ? `For 100 WHSK · ${((markets.venueComparison.hskswap.priceImpactBps ?? 0) / 100).toFixed(2)}% fee`
                      : "Loading live price…"}
                  </span>
                </div>

                <div className="flex items-center justify-between border-t border-border pt-4 text-xs text-muted-foreground">
                  <span className="tabular-nums-mono">
                    Sell price:{" "}
                    {markets?.dexSellQuote
                      ? fmtPayment6(markets.dexSellQuote.paymentAmountOut, paymentSymbol)
                      : "—"}
                  </span>
                  <span>Updated {fmtTime(health?.lastSuccessfulCycleAt)}</span>
                </div>
              </div>
            </div>
          </section>

          <AgentIntelligencePanel intelligence={intelligence} />

          {/* Quiet Bottom Strip — Clean inline stats & clear next-page links */}
          <footer className="flex flex-col justify-between gap-4 border-t border-border pt-5 sm:flex-row sm:items-center">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
              <span>
                Status:{" "}
                <strong className="font-semibold text-foreground">
                  {disconnected
                    ? "Offline"
                    : status?.killSwitch
                      ? "Stopped"
                      : status?.paused
                        ? "Paused"
                        : "Active"}
                </strong>
              </span>
              <span>
                Price checks:{" "}
                <strong className="tabular-nums-mono font-semibold text-foreground">
                  {metrics?.totalCycles ?? 0}
                </strong>
              </span>
              <span>
                Spent:{" "}
                <strong className="tabular-nums-mono font-semibold text-foreground">
                  {metrics ? fmtPayment6(metrics.currentTotalExposurePayment, "USDT") : "$0.00"} /{" "}
                  {config ? fmtPayment6(config.riskLimits.maxTotalExposurePayment, "USDT") : "$50.00"}
                </strong>
              </span>
              <span>
                Trades made:{" "}
                <strong className="tabular-nums-mono font-semibold text-foreground">
                  {metrics?.liveExecutionsCount ?? 0}
                </strong>
              </span>
            </div>

            <div className="flex items-center gap-5 text-xs font-medium">
              <button
                type="button"
                onClick={() => onNavigate("/agent/activity")}
                className="inline-flex items-center gap-1 text-foreground transition-opacity hover:opacity-70 cursor-pointer"
              >
                View Activity ({snapshot?.decisions.length ?? 0})
                <ArrowRight className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onNavigate("/agent/policy")}
                className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
              >
                Rules &amp; Controls
                <ArrowRight className="size-3.5" />
              </button>
            </div>
          </footer>
        </div>
      )}

      {/* VIEW 2: DEDICATED ACTIVITY PAGE — Full breathing room for decisions, positions & tickets */}
      {view === "activity" && (
        <div className="flex w-full flex-col gap-5 lg:h-[calc(100svh-120px)] lg:overflow-hidden">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 rounded-full border border-border bg-card p-1 text-xs">
              {(
                [
                  { id: "decisions", label: `Decisions (${snapshot?.decisions.length ?? 0})` },
                  { id: "positions", label: `Positions (${snapshot?.positions.open.length ?? 0})` },
                  { id: "tickets", label: `Tickets (${snapshot?.tickets.active.length ?? 0})` },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTab(t.id)}
                  className={cn(
                    "rounded-full px-4 py-1.5 text-xs font-medium transition-colors cursor-pointer",
                    activeTab === t.id
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="tabular-nums-mono">
                Last check {fmtTime(health?.lastSuccessfulCycleAt)}
              </span>
              <a
                href={`${normalizedApiUrl}/agent/soak`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4 hover:opacity-75"
              >
                Raw Log
                <ArrowUpRight className="size-3.5" />
              </a>
            </div>
          </div>

          <section className="min-h-0 flex-1 overflow-y-auto rounded-[20px] border border-border bg-card">
            {activeTab === "decisions" &&
              (snapshot && snapshot.decisions.length > 0 ? (
                <div className="divide-y divide-border/70">
                  {snapshot.decisions.map((d) => {
                    const act = humanAction(d.selectedAction);
                    return (
                      <article
                        key={`${d.cycleId}-${d.decisionKey}`}
                        className="flex flex-col gap-1.5 px-6 py-4"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex flex-wrap items-center gap-2.5">
                            <span className="tabular-nums-mono text-xs font-semibold text-muted-foreground">
                              #{d.cycleId}
                            </span>
                            <span
                              className={cn(
                                "rounded-full px-2.5 py-0.5 text-xs font-medium",
                                act.tone === "good"
                                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                                  : act.tone === "warn"
                                    ? "bg-destructive/15 text-destructive"
                                    : "bg-accent text-foreground",
                              )}
                            >
                              {act.label}
                            </span>
                            <span
                              className={cn(
                                "text-xs font-medium",
                                d.riskAllowed
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : "text-destructive",
                              )}
                            >
                              {d.riskAllowed ? "Within limits" : "Stopped by limit"}
                            </span>
                          </div>
                          <span className="tabular-nums-mono shrink-0 text-xs text-muted-foreground">
                            {fmtTime(d.timestamp)}
                          </span>
                        </div>
                        <p className="text-sm leading-relaxed text-muted-foreground">
                          {humanDecisionSummary(d)}
                        </p>
                        {d.txHashes.length > 0 && (
                          <div className="flex gap-3 pt-1">
                            {d.txHashes.map((hash) => (
                              <a
                                key={hash}
                                href={explorerTxUrl(hash)}
                                target="_blank"
                                rel="noreferrer"
                                className="tabular-nums-mono inline-flex items-center gap-1 text-xs text-foreground underline underline-offset-4"
                              >
                                Tx {shortHash(hash)}
                                <ArrowUpRight className="size-3.5" />
                              </a>
                            ))}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center">
                  <p className="text-sm font-medium text-foreground">
                    {loading ? "Loading live decisions…" : "No decisions recorded yet"}
                  </p>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    The agent checks prices every 15 seconds and logs each decision here in plain
                    English.
                  </p>
                </div>
              ))}

            {activeTab === "positions" &&
              (snapshot && snapshot.positions.all.length > 0 ? (
                <div className="divide-y divide-border/70">
                  {snapshot.positions.all.map((p) => (
                    <div
                      key={p.positionId}
                      className="flex items-center justify-between px-6 py-4 text-sm"
                    >
                      <div>
                        <span className="font-medium text-foreground">{p.venue}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{p.status}</span>
                      </div>
                      <span className="tabular-nums-mono text-muted-foreground">
                        Cost {fmtPayment6(p.entryCostPayment, paymentSymbol)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center">
                  <p className="text-sm font-medium text-foreground">No open positions</p>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    Preview mode is on — the agent watches prices without spending your money.
                  </p>
                </div>
              ))}

            {activeTab === "tickets" &&
              (snapshot && snapshot.tickets.all.length > 0 ? (
                <div className="divide-y divide-border/70">
                  {snapshot.tickets.all.map((t) => (
                    <div
                      key={t.ticketId}
                      className="flex items-center justify-between px-6 py-4 text-sm"
                    >
                      <span className="font-medium text-foreground">
                        Ticket #{t.ticketId} · {t.status}
                      </span>
                      <span className="tabular-nums-mono text-muted-foreground">
                        Hold fee {fmtPayment6(t.premiumPaidPayment, paymentSymbol)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
                  <p className="text-sm font-medium text-foreground">No agent tickets yet</p>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    Want to mint a real price-locked reservation ticket yourself on Chain 133
                    testnet?
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => onNavigate("/trade")}
                    className="mt-1 h-9 rounded-full px-5 text-xs cursor-pointer"
                  >
                    Open Trade Desk
                    <ArrowRight className="ml-1.5 size-3.5" />
                  </Button>
                </div>
              ))}
          </section>
        </div>
      )}

      {/* VIEW 3: DEDICATED RULES & CONTROLS PAGE — Clean 2-column spacious layout */}
      {view === "policy" && (
        <div className="flex w-full flex-col gap-6 lg:h-[calc(100svh-120px)] lg:overflow-hidden">
          {actionFeedback && (
            <div
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-[14px] border px-4 py-2.5 text-xs",
                actionFeedback.kind === "ok"
                  ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-destructive/35 bg-destructive/10 text-destructive",
              )}
            >
              {actionFeedback.kind === "ok" ? (
                <CheckCircle2 className="size-4 shrink-0" />
              ) : (
                <ShieldAlert className="size-4 shrink-0" />
              )}
              <span>{actionFeedback.text}</span>
            </div>
          )}

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-12">
            {/* Left 5 cols: Runtime Controls & Safety Caps */}
            <section
              className="flex flex-col justify-between gap-6 rounded-[22px] border border-border p-6 lg:col-span-5"
              style={{ backgroundColor: "#f8f7ee", color: "#050505" }}
            >
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-semibold">Spending Limits</h2>
                    <p className="text-xs opacity-65">Automatic caps · Rule v{policyVersion}</p>
                  </div>
                  <span className="rounded-full bg-black/10 px-2.5 py-1 text-[11px] font-medium">
                    {disconnected
                      ? "Offline"
                      : status?.killSwitch
                        ? "Stopped"
                        : status?.paused
                          ? "Paused"
                          : "Active"}
                  </span>
                </div>

                {/* Progress Bars */}
                <div className="flex flex-col gap-3 rounded-[16px] border border-black/10 bg-white/70 p-4 text-xs">
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <span className="opacity-70">Spending Limit</span>
                      <span className="tabular-nums-mono font-semibold">
                        {metrics ? fmtPayment6(metrics.currentTotalExposurePayment, "USDT") : "$0.00"}{" "}
                        /{" "}
                        {config
                          ? fmtPayment6(config.riskLimits.maxTotalExposurePayment, "USDT")
                          : "$50.00"}
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-black/10">
                      <div className="h-full rounded-full bg-black" style={{ width: `${exposurePct}%` }} />
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5 pt-1">
                    <div className="flex items-center justify-between">
                      <span className="opacity-70">Daily Loss Limit</span>
                      <span className="tabular-nums-mono font-semibold">
                        {metrics ? fmtPayment6(metrics.dailyRealizedLossPayment, "USDT") : "$0.00"} /{" "}
                        {config
                          ? fmtPayment6(config.riskLimits.maxDailyRealizedLossPayment, "USDT")
                          : "$5.00"}
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-black/10">
                      <div className="h-full rounded-full bg-black" style={{ width: `${lossPct}%` }} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2.5 border-t border-black/10 pt-4">
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={disconnected || actionBusy || status?.killSwitch}
                    onClick={() => void runControl("Start", () => client.start())}
                    className="h-9 flex-1 rounded-full bg-black text-xs text-[#f8f7ee] hover:bg-black/85 cursor-pointer"
                  >
                    <Play className="mr-1.5 size-3.5" /> Start
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disconnected || actionBusy}
                    onClick={() =>
                      void runControl(
                        status?.paused ? "Resume" : "Pause",
                        () => (status?.paused ? client.resume() : client.pause()),
                      )
                    }
                    className="h-9 flex-1 rounded-full border-black/20 bg-white/80 text-xs text-black hover:bg-white cursor-pointer"
                  >
                    <Pause className="mr-1.5 size-3.5" /> {status?.paused ? "Resume" : "Pause"}
                  </Button>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={disconnected || actionBusy}
                  onClick={() => setKillDialogOpen(true)}
                  className="h-9 w-full rounded-full text-xs cursor-pointer"
                >
                  <OctagonAlert className="mr-1.5 size-3.5" /> Emergency Stop
                </Button>
              </div>
            </section>

            {/* Right 7 cols: Strategy & Plain-English Rule Editor */}
            <section className="flex min-h-0 flex-col justify-between gap-5 overflow-y-auto rounded-[22px] border border-border bg-card p-6 lg:col-span-7">
              {/* Plain-English Rule Input */}
              <div className="flex flex-col gap-2.5">
                <div>
                  <h2 className="text-base font-semibold text-foreground">
                    Update Rules in Plain English
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Describe what you want to change. Rules are bounded by hard safety limits.
                  </p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    value={nlInstruction}
                    onChange={(e) => setNlInstruction(e.target.value)}
                    placeholder='e.g. "Switch to momentum, take profit 4%, max slippage 0.8%"'
                    className="h-10 flex-1 rounded-full border border-border bg-background px-4 text-xs focus:outline-none focus:ring-1 focus:ring-foreground/30"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={disconnected || actionBusy || !nlInstruction.trim()}
                      onClick={() => void handleProposePolicy()}
                      className="h-10 rounded-full px-4 text-xs cursor-pointer"
                    >
                      Preview
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={disconnected || actionBusy || !nlInstruction.trim()}
                      onClick={() => void handleApplyPolicy()}
                      className="h-10 rounded-full px-4 text-xs cursor-pointer"
                    >
                      Apply
                    </Button>
                  </div>
                </div>
                {nlProposal && (
                  <pre className="overflow-x-auto rounded-[12px] border border-border bg-muted/40 p-3 text-[11px]">
                    {JSON.stringify(nlProposal.proposedPatch, null, 2)}
                  </pre>
                )}
              </div>

              {/* Strategy Presets & Numbers */}
              <div className="flex flex-col gap-3 border-t border-border pt-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-foreground">Strategy Parameters</span>
                  <span className="text-xs text-muted-foreground">
                    {humanStrategy(status?.activeStrategy)}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <label className="col-span-2 flex flex-col gap-1">
                    <span className="text-muted-foreground">Strategy Mode</span>
                    <select
                      value={strategyType}
                      onChange={(e) => setStrategyType(e.target.value as StrategyType)}
                      className="h-10 rounded-[12px] border border-border bg-background px-3 text-xs"
                    >
                      <option value="price_threshold">Buy Below Target Price</option>
                      <option value="momentum">Trend Following</option>
                      <option value="volatility_aware">Volatility-Protected</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Take Profit</span>
                    <input
                      type="number"
                      value={tpInput}
                      onChange={(e) => setTpInput(e.target.value)}
                      className="h-9 rounded-[12px] border border-border bg-background px-3 text-xs"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Stop Loss</span>
                    <input
                      type="number"
                      value={slInput}
                      onChange={(e) => setSlInput(e.target.value)}
                      className="h-9 rounded-[12px] border border-border bg-background px-3 text-xs"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Max Price Shift</span>
                    <input
                      type="number"
                      value={slipInput}
                      onChange={(e) => setSlipInput(e.target.value)}
                      className="h-9 rounded-[12px] border border-border bg-background px-3 text-xs"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Max Trade Size</span>
                    <input
                      type="text"
                      value={maxPosInput}
                      onChange={(e) => setMaxPosInput(e.target.value)}
                      className="h-9 rounded-[12px] border border-border bg-background px-3 text-xs"
                    />
                  </label>
                </div>

                <div className="flex justify-end pt-1">
                  <Button
                    type="button"
                    size="sm"
                    disabled={disconnected || actionBusy}
                    onClick={() => void handleStrategySave()}
                    className="h-9 rounded-full px-5 text-xs cursor-pointer"
                  >
                    Save Parameters
                  </Button>
                </div>
              </div>
            </section>
          </div>
        </div>
      )}

      {/* Clean Small API Connection Dialog */}
      <Dialog open={controlsOpen} onOpenChange={setControlsOpen}>
        <DialogContent className="rounded-[20px] border-border bg-card sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Agent API Connection</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Read-only viewing works without a token. Add your operator Bearer token to apply
              policy or runtime changes.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 pt-2 text-xs">
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Agent API URL</span>
              <input
                type="url"
                value={apiUrlInput}
                onChange={(e) => handleSaveApiUrl(e.target.value)}
                placeholder="https://api.tranche.space"
                className="h-10 rounded-[12px] border border-border bg-background px-3 text-xs"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Operator Bearer Token</span>
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => handleSaveToken(e.target.value)}
                placeholder="Paste token (session only)"
                className="h-10 rounded-[12px] border border-border bg-background px-3 text-xs"
              />
            </label>
            <div className="flex justify-end pt-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setControlsOpen(false);
                  void loadSnapshot(true);
                }}
                className="h-9 rounded-full px-5 text-xs cursor-pointer"
              >
                Save &amp; Refresh
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Kill Switch Confirmation Dialog */}
      <Dialog open={killDialogOpen} onOpenChange={setKillDialogOpen}>
        <DialogContent className="rounded-[20px] border-border bg-card sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold text-destructive">
              Activate Emergency Stop?
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              This immediately halts the agent and blocks all new trades and exercises. It cannot be
              cleared via Resume.
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
              Confirm Stop
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
