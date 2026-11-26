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
  ShieldCheck,
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
      return { label: "Would buy on HSKSwap (no tx sent)", tone: "good" };
    case "READ_ONLY_RESERVE_TRANCHE":
      return { label: "Would reserve on Tranche (no tx sent)", tone: "good" };
    case "DRY_RUN_SWAP_HSKSWAP":
      return { label: "Simulated HSKSwap buy", tone: "good" };
    case "DRY_RUN_RESERVE_TRANCHE":
      return { label: "Simulated Tranche reservation", tone: "good" };
    case "SWAP_HSKSWAP":
      return { label: "Bought on HSKSwap", tone: "good" };
    case "RESERVE_TRANCHE":
      return { label: "Reserved on Tranche", tone: "good" };
    case "SKIPPED_DUPLICATE":
      return { label: "Cooldown active (skipped repeat)", tone: "neutral" };
    case "WAIT":
      return { label: "Waiting for better conditions", tone: "neutral" };
    case "BLOCKED_RISK":
      return { label: "Blocked by safety limit", tone: "warn" };
    case "EXECUTION_FAILED":
      return { label: "Execution failed safely", tone: "warn" };
    default:
      return { label: action.replace(/_/g, " ").toLowerCase(), tone: "neutral" };
  }
}

function humanDecisionSummary(d: AgentDashboardSnapshot["decisions"][number]): string {
  if (d.selectedAction === "SKIPPED_DUPLICATE") {
    return "Already evaluated this 60-second window — deduplication prevented a repeat order.";
  }
  if (d.selectedAction === "READ_ONLY_SWAP_HSKSWAP") {
    return `Price met target. Selected HSKSwap (${fmtPayment6(d.hskswap.acquisitionCostPayment)}) because no mainnet Tranche offers are posted yet. Read-Only Mode blocked transaction broadcast.`;
  }
  if (d.selectedAction === "READ_ONLY_RESERVE_TRANCHE") {
    return `Price met target. Selected Tranche (${fmtPayment6(d.tranche.acquisitionCostPayment)}) as the cheaper venue. Read-Only Mode blocked transaction broadcast.`;
  }
  if (d.selectedAction === "BLOCKED_RISK") {
    const failed = d.failedRiskChecks.map((c) => c.name.replace(/_/g, " ")).join(", ");
    return `Safety guardrails blocked this trade (${failed || "risk limit reached"}).`;
  }
  return d.rationale;
}

export function AgentPage({ onNavigate }: AgentPageProps) {
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

  return (
    <AppShell
      activeRoute="/agent"
      onNavigate={onNavigate}
      title="Tranche Agent"
      subtitle={
        disconnected
          ? "Connecting to Agent API…"
          : isReadOnly
            ? `Safe Read-Only Mode · Watching Chain ${status?.chainId ?? 177} live`
            : isDryRun
              ? `Dry-Run Mode · Chain ${status?.chainId ?? 177}`
              : `Live Execution · Chain ${status?.chainId ?? 177}`
      }
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
                Read-Only · Live Feed
              </>
            ) : isDryRun ? (
              <>
                <Bot className="size-3" />
                Dry-Run
              </>
            ) : (
              <>
                <Activity className="size-3" />
                Live
              </>
            )}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setControlsOpen(true)}
            className="h-8 rounded-full px-3 text-xs cursor-pointer"
          >
            <Settings2 className="mr-1.5 size-3.5" />
            Controls
          </Button>
        </div>
      }
    >
      {/* Fixed single-viewport cockpit on desktop (zero outer page scroll) */}
      <div className="flex flex-col gap-4 lg:h-[calc(100svh-120px)] lg:overflow-hidden">
        {/* 1. Plain-English Live Story Banner */}
        <section
          className={cn(
            "flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-[16px] border px-4 py-3",
            disconnected
              ? "border-amber-500/35 bg-amber-500/[0.08]"
              : "border-border bg-card",
          )}
        >
          <div className="flex min-w-0 items-center gap-3">
            <div
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full",
                disconnected
                  ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                  : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
              )}
            >
              {disconnected ? <WifiOff className="size-4" /> : <ShieldCheck className="size-4" />}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground">
                {disconnected
                  ? hostedLocalMismatch
                    ? "Agent API is pointed at localhost — open Controls to set a hosted API URL."
                    : "Agent API is currently unreachable. Retrying automatically…"
                  : isReadOnly
                    ? `Watching live ${status?.market ?? "WHSK/USDT"} on HashKey Chain (Chain ${status?.chainId ?? 177}) — Safe Observation Mode`
                    : `Autonomous Agent Active on ${status?.market ?? "WHSK/USDT"} (Chain ${status?.chainId ?? 177})`}
              </p>
              <p className="truncate text-[11px] text-muted-foreground">
                {disconnected
                  ? "No live quotes loaded yet. Verify your Agent URL in Controls."
                  : isReadOnly
                    ? `Comparing Tranche vs. HSKSwap every 15s using real mainnet prices. 0 funds spent · ${metrics?.totalCycles ?? 0} live checks completed · last check ${fmtTime(health?.lastSuccessfulCycleAt)}.`
                    : `Comparing Tranche vs. HSKSwap under code-enforced risk limits. Last check ${fmtTime(health?.lastSuccessfulCycleAt)}.`}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setControlsOpen(true)}
              className="h-8 rounded-full px-3 text-xs cursor-pointer"
            >
              Configure Policy
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => onNavigate("/trade")}
              className="h-8 rounded-full px-3.5 text-xs cursor-pointer"
            >
              Try Testnet Trade
              <ArrowRight className="ml-1 size-3.5" />
            </Button>
          </div>
        </section>

        {/* 2. Compact Dual-Venue Comparison (Tranche vs HSKSwap) */}
        <section className="shrink-0 overflow-hidden rounded-[18px] border border-border">
          <div className="grid grid-cols-1 lg:grid-cols-12">
            {/* Left: Tranche */}
            <div
              className="flex flex-col justify-between gap-2.5 p-4 lg:col-span-5"
              style={{ backgroundColor: "#f8f7ee", color: "#050505" }}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold">Tranche Protocol</span>
                  <span className="text-[11px] opacity-60">Price-locked reservation</span>
                </div>
                <span
                  className="rounded-full px-2.5 py-0.5 text-[10px] font-medium"
                  style={{
                    backgroundColor: winningVenue === "TRANCHE" ? "#050505" : "rgba(5,5,5,0.08)",
                    color: winningVenue === "TRANCHE" ? "#f8f7ee" : "#050505",
                  }}
                >
                  {winningVenue === "TRANCHE"
                    ? "Best Route"
                    : (markets?.trancheOffersCount ?? 0) > 0
                      ? "Available"
                      : "No Mainnet Offers Yet"}
                </span>
              </div>

              {(markets?.trancheOffersCount ?? 0) > 0 && markets?.venueComparison ? (
                <div>
                  <span className="tabular-nums-mono text-xl font-semibold tracking-tight">
                    {fmtPayment6(markets.venueComparison.tranche.acquisitionCostPayment, paymentSymbol)}
                  </span>
                  <p className="tabular-nums-mono text-[11px] opacity-65">
                    Hold fee {fmtPayment6(markets.venueComparison.tranche.reservationPremiumPayment, paymentSymbol)} · Exercise{" "}
                    {fmtPayment6(markets.venueComparison.tranche.exercisePayment, paymentSymbol)}
                  </p>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs leading-snug opacity-75">
                    Mainnet contracts aren&apos;t deployed yet, so the agent sees 0 offers on Chain 177.
                    Try live reservations on Chain 133 testnet.
                  </p>
                  <button
                    type="button"
                    onClick={() => onNavigate("/trade")}
                    className="shrink-0 rounded-full bg-black px-2.5 py-1 text-[11px] font-medium text-[#f8f7ee] hover:opacity-85 cursor-pointer"
                  >
                    Open Trade Desk
                  </button>
                </div>
              )}

              <div className="flex items-center justify-between border-t border-black/10 pt-2 text-[11px] opacity-70">
                <span className="tabular-nums-mono">{markets?.trancheOffersCount ?? 0} active offers</span>
                <span>Zero slippage · Capped downside</span>
              </div>
            </div>

            {/* Center: Plain-English Verdict */}
            <div className="flex flex-row items-center justify-between gap-3 border-y border-border bg-muted/50 px-4 py-3 lg:col-span-2 lg:flex-col lg:justify-center lg:border-x lg:border-y-0 lg:text-center">
              <div>
                <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
                  Agent Pick
                </span>
                <span className="text-base font-semibold text-foreground">
                  {winningVenue === "NONE" ? "Wait" : winningVenue === "TRANCHE" ? "Tranche" : "HSKSwap"}
                </span>
              </div>
              <div className="flex items-center gap-3 text-[11px] lg:flex-col lg:gap-1">
                <span className="rounded-full border border-border bg-background px-2 py-0.5 font-medium text-foreground">
                  {humanRegime(markets?.marketRegime)}
                </span>
                <span className="tabular-nums-mono text-muted-foreground">
                  Oracle {markets?.oracleAgeSec ?? "—"}s · Vol{" "}
                  {markets?.realizedVolatilityBps !== undefined
                    ? `${(markets.realizedVolatilityBps / 100).toFixed(2)}%`
                    : "—"}
                </span>
              </div>
            </div>

            {/* Right: HSKSwap */}
            <div className="flex flex-col justify-between gap-2.5 bg-card p-4 text-card-foreground lg:col-span-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold">HSKSwap V3</span>
                  <span className="text-[11px] text-muted-foreground">Instant AMM swap</span>
                </div>
                <span
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-[10px] font-medium",
                    winningVenue === "HSKSWAP"
                      ? "bg-primary text-primary-foreground"
                      : "border border-border text-muted-foreground",
                  )}
                >
                  {winningVenue === "HSKSWAP"
                    ? isReadOnly
                      ? "Best Route (Simulated)"
                      : "Best Route"
                    : "Available"}
                </span>
              </div>

              <div>
                <span className="tabular-nums-mono text-xl font-semibold tracking-tight">
                  {markets?.venueComparison
                    ? fmtPayment6(markets.venueComparison.hskswap.acquisitionCostPayment, paymentSymbol)
                    : "—"}
                </span>
                <p className="tabular-nums-mono text-[11px] text-muted-foreground">
                  {markets?.venueComparison
                    ? `For 100 WHSK · Pool fee & impact: ${((markets.venueComparison.hskswap.priceImpactBps ?? 0) / 100).toFixed(2)}%`
                    : "Waiting for live Chain 177 quote…"}
                </p>
              </div>

              <div className="flex items-center justify-between border-t border-border pt-2 text-[11px] text-muted-foreground">
                <span className="tabular-nums-mono">
                  Instant sell value:{" "}
                  {markets?.dexSellQuote
                    ? fmtPayment6(markets.dexSellQuote.paymentAmountOut, paymentSymbol)
                    : "—"}
                </span>
                <span>Live Chain 177 quote</span>
              </div>
            </div>
          </div>
        </section>

        {/* 3. Main Split Cockpit — Fills remaining viewport height cleanly */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-12">
          {/* LEFT 7 COLS: Internal-scroll Live Feed / Positions / Tickets */}
          <section className="flex min-h-0 flex-col overflow-hidden rounded-[18px] border border-border bg-card lg:col-span-7">
            <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
              <div className="flex items-center gap-1 rounded-full border border-border bg-background p-0.5 text-xs">
                {(
                  [
                    { id: "decisions", label: `Live Activity (${snapshot?.decisions.length ?? 0})` },
                    { id: "positions", label: `Positions (${snapshot?.positions.open.length ?? 0})` },
                    { id: "tickets", label: `Tickets (${snapshot?.tickets.active.length ?? 0})` },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActiveTab(t.id)}
                    className={cn(
                      "rounded-full px-3 py-1 text-xs font-medium transition-colors cursor-pointer",
                      activeTab === t.id
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                Updated {fmtTime(health?.lastSuccessfulCycleAt)}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
              {activeTab === "decisions" &&
                (snapshot && snapshot.decisions.length > 0 ? (
                  <div className="divide-y divide-border/70">
                    {snapshot.decisions.map((d) => {
                      const act = humanAction(d.selectedAction);
                      return (
                        <article
                          key={`${d.cycleId}-${d.decisionKey}`}
                          className="flex flex-col gap-1 py-2.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="tabular-nums-mono text-[11px] font-semibold text-muted-foreground">
                                #{d.cycleId}
                              </span>
                              <span
                                className={cn(
                                  "rounded-full px-2 py-0.5 text-[11px] font-medium",
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
                                  "text-[11px] font-medium",
                                  d.riskAllowed
                                    ? "text-emerald-600 dark:text-emerald-400"
                                    : "text-destructive",
                                )}
                              >
                                {d.riskAllowed ? "Safety OK" : "Blocked"}
                              </span>
                            </div>
                            <span className="tabular-nums-mono shrink-0 text-[11px] text-muted-foreground">
                              {fmtTime(d.timestamp)}
                            </span>
                          </div>
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            {humanDecisionSummary(d)}
                          </p>
                          {d.txHashes.length > 0 && (
                            <div className="flex gap-3">
                              {d.txHashes.map((hash) => (
                                <a
                                  key={hash}
                                  href={explorerTxUrl(hash)}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="tabular-nums-mono inline-flex items-center gap-0.5 text-[11px] text-foreground underline underline-offset-4"
                                >
                                  Tx {shortHash(hash)}
                                  <ArrowUpRight className="size-3" />
                                </a>
                              ))}
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center py-8 text-center text-xs text-muted-foreground">
                    {loading
                      ? "Loading live Chain 177 decisions…"
                      : "No agent checks recorded yet."}
                  </div>
                ))}

              {activeTab === "positions" &&
                (snapshot && snapshot.positions.all.length > 0 ? (
                  <div className="divide-y divide-border/70">
                    {snapshot.positions.all.map((p) => (
                      <div key={p.positionId} className="flex items-center justify-between py-2.5 text-xs">
                        <div>
                          <span className="font-medium text-foreground">{p.venue}</span>
                          <span className="ml-2 text-muted-foreground">{p.status}</span>
                        </div>
                        <span className="tabular-nums-mono text-muted-foreground">
                          Cost {fmtPayment6(p.entryCostPayment, paymentSymbol)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-1 py-8 text-center text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">No open positions</span>
                    <span>In Read-Only Mode, the agent evaluates trades without spending funds.</span>
                  </div>
                ))}

              {activeTab === "tickets" &&
                (snapshot && snapshot.tickets.all.length > 0 ? (
                  <div className="divide-y divide-border/70">
                    {snapshot.tickets.all.map((t) => (
                      <div key={t.ticketId} className="flex items-center justify-between py-2.5 text-xs">
                        <span className="font-medium text-foreground">
                          Ticket #{t.ticketId} ({t.status})
                        </span>
                        <span className="tabular-nums-mono text-muted-foreground">
                          Premium {fmtPayment6(t.premiumPaidPayment, paymentSymbol)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 py-8 text-center text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">No reserved tickets yet</span>
                    <span>Want to mint a real Tranche reservation ticket on Chain 133 testnet?</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onNavigate("/trade")}
                      className="mt-1 h-7 rounded-full px-3 text-xs cursor-pointer"
                    >
                      Go to Trade Desk
                    </Button>
                  </div>
                ))}
            </div>
          </section>

          {/* RIGHT 5 COLS: Plain-English Overview, Safety Guardrails & Next Steps */}
          <aside
            className="flex min-h-0 flex-col justify-between gap-3 overflow-hidden rounded-[18px] border border-border p-4 lg:col-span-5"
            style={{ backgroundColor: "#f8f7ee", color: "#050505" }}
          >
            {/* Compact Live Metrics */}
            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-[12px] bg-black/[0.04] px-3 py-2">
                <span className="block text-[10px] uppercase tracking-wider opacity-60">Status</span>
                <span className="text-sm font-semibold">
                  {disconnected
                    ? "Offline"
                    : status?.killSwitch
                      ? "Emergency Stop"
                      : status?.paused
                        ? "Paused"
                        : "Running Safely"}
                </span>
              </div>
              <div className="rounded-[12px] bg-black/[0.04] px-3 py-2">
                <span className="block text-[10px] uppercase tracking-wider opacity-60">Strategy</span>
                <span className="truncate block text-sm font-semibold">
                  {humanStrategy(status?.activeStrategy)}
                </span>
              </div>
              <div className="rounded-[12px] bg-black/[0.04] px-3 py-2">
                <span className="block text-[10px] uppercase tracking-wider opacity-60">
                  Live Checks
                </span>
                <span className="tabular-nums-mono text-sm font-semibold">
                  {metrics?.totalCycles ?? 0} cycles
                </span>
              </div>
              <div className="rounded-[12px] bg-black/[0.04] px-3 py-2">
                <span className="block text-[10px] uppercase tracking-wider opacity-60">
                  Broadcast Txs
                </span>
                <span className="tabular-nums-mono text-sm font-semibold">
                  {metrics?.liveExecutionsCount ?? 0} sent
                </span>
              </div>
            </div>

            {/* Compact Safety Guardrails */}
            <div className="flex flex-col gap-2 rounded-[12px] border border-black/10 bg-white/60 p-3">
              <div className="flex items-center justify-between text-[11px] font-semibold">
                <span>Safety Guardrails (Code-Enforced)</span>
                <span className="tabular-nums-mono opacity-65">Policy v{policyVersion}</span>
              </div>
              <div className="flex flex-col gap-1.5 text-[11px]">
                <div className="flex items-center justify-between">
                  <span className="opacity-70">Exposure Cap</span>
                  <span className="tabular-nums-mono font-medium">
                    {metrics ? fmtPayment6(metrics.currentTotalExposurePayment, "USDT") : "$0.00"} /{" "}
                    {config ? fmtPayment6(config.riskLimits.maxTotalExposurePayment, "USDT") : "$50.00"}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10">
                  <div className="h-full rounded-full bg-black" style={{ width: `${exposurePct}%` }} />
                </div>
                <div className="flex items-center justify-between pt-0.5">
                  <span className="opacity-70">Daily Loss Limit</span>
                  <span className="tabular-nums-mono font-medium">
                    {metrics ? fmtPayment6(metrics.dailyRealizedLossPayment, "USDT") : "$0.00"} /{" "}
                    {config ? fmtPayment6(config.riskLimits.maxDailyRealizedLossPayment, "USDT") : "$5.00"}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10">
                  <div className="h-full rounded-full bg-black" style={{ width: `${lossPct}%` }} />
                </div>
              </div>
            </div>

            {/* Clear "What You Can Do Next" Actions */}
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider opacity-60">
                What You Can Do Next
              </span>
              <div className="grid grid-cols-1 gap-1.5">
                <button
                  type="button"
                  onClick={() => onNavigate("/trade")}
                  className="flex items-center justify-between rounded-[11px] bg-black px-3.5 py-2 text-left text-xs font-medium text-[#f8f7ee] transition-opacity hover:opacity-90 cursor-pointer"
                >
                  <span>1. Reserve a real Tranche ticket on Chain 133 testnet</span>
                  <ArrowRight className="size-3.5 shrink-0" />
                </button>
                <button
                  type="button"
                  onClick={() => setControlsOpen(true)}
                  className="flex items-center justify-between rounded-[11px] border border-black/15 bg-white/80 px-3.5 py-2 text-left text-xs font-medium text-black transition-colors hover:bg-white cursor-pointer"
                >
                  <span>2. Edit strategy rules or give plain-English instructions</span>
                  <Settings2 className="size-3.5 shrink-0 opacity-70" />
                </button>
                <a
                  href={`${normalizedApiUrl}/agent/soak`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between rounded-[11px] border border-black/15 bg-white/80 px-3.5 py-2 text-left text-xs font-medium text-black transition-colors hover:bg-white"
                >
                  <span>3. Inspect live 24-hour Chain 177 soak proof (JSON)</span>
                  <ArrowUpRight className="size-3.5 shrink-0 opacity-70" />
                </a>
              </div>
            </div>
          </aside>
        </div>
      </div>

      {/* Operator Controls & Policy Modal (keeps main page uncluttered & non-scrollable) */}
      <Dialog open={controlsOpen} onOpenChange={setControlsOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto rounded-[20px] border-border bg-card sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Agent Controls &amp; Policy</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Read-only telemetry works without a token. Paste your Bearer token to pause, tune
              strategy limits, or apply natural-language policy rules.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 pt-2 text-xs">
            {/* Connection */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">Agent API URL</span>
                <input
                  type="url"
                  value={apiUrlInput}
                  onChange={(e) => handleSaveApiUrl(e.target.value)}
                  placeholder="https://api.tranche.space"
                  className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">
                  Operator Token (for POST controls)
                </span>
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => handleSaveToken(e.target.value)}
                  placeholder="Bearer token"
                  className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs"
                />
              </label>
            </div>

            {/* Runtime Controls */}
            <div className="flex flex-wrap items-center gap-2 border-y border-border py-3">
              <Button
                type="button"
                size="sm"
                disabled={disconnected || actionBusy || status?.killSwitch}
                onClick={() => void runControl("Start", () => client.start())}
                className="h-8 rounded-full text-xs cursor-pointer"
              >
                <Play className="mr-1 size-3" /> Start
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
                className="h-8 rounded-full text-xs cursor-pointer"
              >
                <Pause className="mr-1 size-3" /> {status?.paused ? "Resume" : "Pause"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={disconnected || actionBusy}
                onClick={() => setKillDialogOpen(true)}
                className="ml-auto h-8 rounded-full text-xs cursor-pointer"
              >
                <OctagonAlert className="mr-1 size-3" /> Emergency Kill
              </Button>
            </div>

            {/* Natural-Language Policy */}
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-semibold text-foreground">
                Plain-English Policy Update (Bounded)
              </span>
              <input
                type="text"
                value={nlInstruction}
                onChange={(e) => setNlInstruction(e.target.value)}
                placeholder='e.g. "Switch to momentum, take profit 4%, max slippage 0.8%"'
                className="rounded-lg border border-border bg-background px-3 py-2 text-xs"
              />
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disconnected || actionBusy || !nlInstruction.trim()}
                  onClick={() => void handleProposePolicy()}
                  className="h-8 rounded-full text-xs cursor-pointer"
                >
                  Preview Changes
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={disconnected || actionBusy || !nlInstruction.trim()}
                  onClick={() => void handleApplyPolicy()}
                  className="h-8 rounded-full text-xs cursor-pointer"
                >
                  Apply Policy
                </Button>
              </div>
              {nlProposal && (
                <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 p-2.5 text-[11px]">
                  {JSON.stringify(nlProposal.proposedPatch, null, 2)}
                </pre>
              )}
            </div>

            {/* Strategy Parameters */}
            <div className="grid grid-cols-2 gap-2.5 border-t border-border pt-3">
              <label className="col-span-2 flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">Strategy Mode</span>
                <select
                  value={strategyType}
                  onChange={(e) => setStrategyType(e.target.value as StrategyType)}
                  className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs"
                >
                  <option value="price_threshold">Buy Below Target Price (price_threshold)</option>
                  <option value="momentum">Trend Following (momentum)</option>
                  <option value="volatility_aware">Volatility-Protected (volatility_aware)</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">Take-Profit (bps)</span>
                <input
                  type="number"
                  value={tpInput}
                  onChange={(e) => setTpInput(e.target.value)}
                  className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">Stop-Loss (bps)</span>
                <input
                  type="number"
                  value={slInput}
                  onChange={(e) => setSlInput(e.target.value)}
                  className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">Max Slippage (bps)</span>
                <input
                  type="number"
                  value={slipInput}
                  onChange={(e) => setSlipInput(e.target.value)}
                  className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">Max Size (raw wei)</span>
                <input
                  type="text"
                  value={maxPosInput}
                  onChange={(e) => setMaxPosInput(e.target.value)}
                  className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs"
                />
              </label>
              <div className="col-span-2 flex justify-end pt-1">
                <Button
                  type="button"
                  size="sm"
                  disabled={disconnected || actionBusy}
                  onClick={() => void handleStrategySave()}
                  className="h-8 rounded-full px-4 text-xs cursor-pointer"
                >
                  Save Strategy Limits
                </Button>
              </div>
            </div>

            {actionFeedback && (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
                  actionFeedback.kind === "ok"
                    ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-destructive/35 bg-destructive/10 text-destructive",
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
        </DialogContent>
      </Dialog>

      {/* Kill Switch Confirmation Dialog */}
      <Dialog open={killDialogOpen} onOpenChange={setKillDialogOpen}>
        <DialogContent className="rounded-[20px] border-border bg-card sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold text-destructive">
              Activate Emergency Kill Switch?
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              This immediately halts the agent runtime and blocks all entries, exercises, and exits.
              It cannot be cleared via Resume.
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
