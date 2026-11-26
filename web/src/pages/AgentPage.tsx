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
import { useWallet } from "@/context/WalletContext";
import {
  AgentApiClient,
  AgentApiError,
  DEFAULT_AGENT_API_URL,
  buildProfileSignMessage,
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

interface PersonalAgentState {
  paused: boolean;
  strategyType: StrategyType;
  takeProfitBps: number;
  stopLossBps: number;
  maxSlippageBps: number;
  version: number;
}

const DEFAULT_PERSONAL_AGENT: PersonalAgentState = {
  paused: false,
  strategyType: "price_threshold",
  takeProfitBps: 500,
  stopLossBps: 300,
  maxSlippageBps: 100,
  version: 1,
};

function parsePersonalRule(instruction: string): {
  patch: Record<string, unknown>;
  summary: string;
  valid: boolean;
  rejectedFields: string[];
} {
  const lower = instruction.toLowerCase();
  const patch: Record<string, unknown> = {};
  const parts: string[] = [];
  const rejectedFields: string[] = [];

  if (lower.includes("momentum") || lower.includes("trend")) {
    patch.strategyType = "momentum";
    parts.push("Trend Following");
  } else if (lower.includes("volatil") || lower.includes("shield") || lower.includes("crash")) {
    patch.strategyType = "volatility_aware";
    parts.push("Volatility-Protected");
  } else if (lower.includes("target") || lower.includes("threshold") || lower.includes("conservative")) {
    patch.strategyType = "price_threshold";
    parts.push("Buy Below Target Price");
  }

  const tpMatch = lower.match(/(?:take\s*profit|profit)\s*(?:at|to|=)?\s*(\d+(?:\.\d+)?)\s*%/);
  if (tpMatch) {
    const bps = Math.round(Number(tpMatch[1]) * 100);
    if (bps < 50 || bps > 2000) rejectedFields.push("takeProfit (must be 0.5%–20%)");
    else {
      patch.takeProfitBps = bps;
      parts.push(`Take profit ${tpMatch[1]}%`);
    }
  }

  const slMatch = lower.match(/(?:stop\s*loss|stop)\s*(?:at|to|=)?\s*(\d+(?:\.\d+)?)\s*%/);
  if (slMatch) {
    const bps = Math.round(Number(slMatch[1]) * 100);
    if (bps < 50 || bps > 1500) rejectedFields.push("stopLoss (must be 0.5%–15%)");
    else {
      patch.stopLossBps = bps;
      parts.push(`Stop loss ${slMatch[1]}%`);
    }
  }

  const slipMatch = lower.match(/(?:slippage|shift)\s*(?:at|to|=|max)?\s*(\d+(?:\.\d+)?)\s*%/);
  if (slipMatch) {
    const bps = Math.round(Number(slipMatch[1]) * 100);
    if (bps < 10 || bps > 300) rejectedFields.push("maxSlippage (must be 0.1%–3%)");
    else {
      patch.maxSlippageBps = bps;
      parts.push(`Max shift ${slipMatch[1]}%`);
    }
  }

  if (Object.keys(patch).length === 0 && rejectedFields.length === 0) {
    rejectedFields.push("No recognized rule — try mentioning a strategy, take profit %, stop loss %, or slippage %");
  }

  return {
    patch,
    summary: parts.join(" · ") || "No changes",
    valid: rejectedFields.length === 0 && Object.keys(patch).length > 0,
    rejectedFields,
  };
}

export function AgentPage({ view = "overview", onNavigate }: AgentPageProps) {
  const { address, activeProvider } = useWallet();
  const personalKey = `tranche-personal-agent-${(address ?? "guest").toLowerCase()}`;
  const [personalAgent, setPersonalAgent] = useState<PersonalAgentState>(() => {
    try {
      const saved = localStorage.getItem(`tranche-personal-agent-${(address ?? "guest").toLowerCase()}`);
      return saved ? { ...DEFAULT_PERSONAL_AGENT, ...(JSON.parse(saved) as Partial<PersonalAgentState>) } : DEFAULT_PERSONAL_AGENT;
    } catch {
      return DEFAULT_PERSONAL_AGENT;
    }
  });
  const [feedbackFading, setFeedbackFading] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(personalKey);
      if (saved) {
        const parsed = { ...DEFAULT_PERSONAL_AGENT, ...(JSON.parse(saved) as Partial<PersonalAgentState>) };
        setPersonalAgent(parsed);
        setStrategyType(parsed.strategyType);
        setTpInput(String(parsed.takeProfitBps));
        setSlInput(String(parsed.stopLossBps));
        setSlipInput(String(parsed.maxSlippageBps));
      }
    } catch {
      // ignore storage errors
    }
  }, [personalKey]);

  const savePersonalAgent = useCallback(
    (updater: (prev: PersonalAgentState) => PersonalAgentState): PersonalAgentState => {
      let computed = DEFAULT_PERSONAL_AGENT;
      setPersonalAgent((prev) => {
        const next = updater(prev);
        computed = next;
        try {
          localStorage.setItem(personalKey, JSON.stringify(next));
        } catch {
          // ignore storage errors
        }
        return next;
      });
      return computed;
    },
    [personalKey],
  );

  const [apiUrlInput, setApiUrlInput] = useState<string>(() => {
    const saved = sessionStorage.getItem(API_URL_STORAGE_KEY);
    return saved ? normalizeAgentApiUrl(saved) : normalizeAgentApiUrl(DEFAULT_AGENT_API_URL);
  });
  const [tokenInput, setTokenInput] = useState<string>(
    () => sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "",
  );
  const [controlsOpen, setControlsOpen] = useState(false);
  const [killDialogOpen, setKillDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"decisions" | "positions" | "tickets" | "insights">("decisions");

  const normalizedApiUrl = useMemo(() => normalizeAgentApiUrl(apiUrlInput), [apiUrlInput]);
  const client = useMemo(
    () => new AgentApiClient({ baseUrl: normalizedApiUrl, token: tokenInput }),
    [normalizedApiUrl, tokenInput],
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

  const isOperator = tokenInput.trim().length > 0;

  // Auto-fade success & error banners smoothly after 3.8s
  useEffect(() => {
    if (!actionFeedback) {
      setFeedbackFading(false);
      return;
    }
    setFeedbackFading(false);
    const fadeTimer = setTimeout(() => setFeedbackFading(true), 3500);
    const clearTimer = setTimeout(() => {
      setActionFeedback(null);
      setFeedbackFading(false);
    }, 4100);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(clearTimer);
    };
  }, [actionFeedback]);

  // Load saved server-side profile for this wallet across devices/browsers
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    void client
      .getUserProfile(address)
      .then(({ profile }) => {
        if (cancelled || !profile) return;
        const remote: PersonalAgentState = {
          paused: profile.paused,
          strategyType: profile.strategyType,
          takeProfitBps: profile.takeProfitBps,
          stopLossBps: profile.stopLossBps,
          maxSlippageBps: profile.maxSlippageBps,
          version: profile.version,
        };
        setPersonalAgent(remote);
        setStrategyType(remote.strategyType);
        setTpInput(String(remote.takeProfitBps));
        setSlInput(String(remote.stopLossBps));
        setSlipInput(String(remote.maxSlippageBps));
        try {
          localStorage.setItem(personalKey, JSON.stringify(remote));
        } catch {
          // ignore
        }
      })
      .catch(() => {
        // Fallback silently to localStorage if server doesn't have /profiles yet
      });
    return () => {
      cancelled = true;
    };
  }, [address, client, personalKey]);

  async function syncProfileToServer(next: PersonalAgentState, successPrefix: string) {
    if (!address || !activeProvider) {
      setActionFeedback({ kind: "ok", text: `${successPrefix} (saved on this device).` });
      return;
    }
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const message = buildProfileSignMessage({
        address,
        paused: next.paused,
        strategyType: next.strategyType,
        takeProfitBps: next.takeProfitBps,
        stopLossBps: next.stopLossBps,
        maxSlippageBps: next.maxSlippageBps,
        timestamp,
      });
      const signature = (await activeProvider.request({
        method: "personal_sign",
        params: [message, address],
      })) as string;
      const saved = await client.saveUserProfile(address, {
        paused: next.paused,
        strategyType: next.strategyType,
        takeProfitBps: next.takeProfitBps,
        stopLossBps: next.stopLossBps,
        maxSlippageBps: next.maxSlippageBps,
        timestamp,
        signature,
      });
      savePersonalAgent((prev) => ({ ...prev, version: saved.profile.version }));
      setActionFeedback({ kind: "ok", text: `${successPrefix} — synced to your wallet.` });
    } catch {
      setActionFeedback({
        kind: "ok",
        text: `${successPrefix} (saved on this device).`,
      });
    }
  }

  async function handlePauseToggle() {
    if (!isOperator) {
      const nextState: PersonalAgentState = {
        ...personalAgent,
        paused: !personalAgent.paused,
      };
      savePersonalAgent(() => nextState);
      await syncProfileToServer(
        nextState,
        nextState.paused ? "Your agent is paused" : "Your agent is active",
      );
      return;
    }
    await runControl(
      status?.paused ? "Resume agent" : "Pause agent",
      () => (status?.paused ? client.resume() : client.pause()),
    );
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
    if (!isOperator) {
      const nextState: PersonalAgentState = {
        ...personalAgent,
        strategyType,
        takeProfitBps,
        stopLossBps,
        maxSlippageBps,
        version: personalAgent.version + 1,
      };
      savePersonalAgent(() => nextState);
      await syncProfileToServer(nextState, `Saved ${humanStrategy(strategyType)}`);
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
    if (!isOperator) {
      const parsed = parsePersonalRule(nlInstruction.trim());
      setNlProposal({
        instruction: nlInstruction.trim(),
        proposedPatch: parsed.patch,
        valid: parsed.valid,
        rejectedFields: parsed.rejectedFields,
      });
      setActionFeedback({
        kind: parsed.valid ? "ok" : "err",
        text: parsed.valid
          ? `Preview ready: ${parsed.summary}. Click Apply Rule to save to your agent.`
          : parsed.rejectedFields.join(", "),
      });
      return;
    }
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
    if (!isOperator) {
      const parsed = parsePersonalRule(nlInstruction.trim());
      if (!parsed.valid) {
        setActionFeedback({ kind: "err", text: parsed.rejectedFields.join(", ") });
        return;
      }
      const nextState: PersonalAgentState = {
        ...personalAgent,
        strategyType: (parsed.patch.strategyType as StrategyType) ?? personalAgent.strategyType,
        takeProfitBps: (parsed.patch.takeProfitBps as number) ?? personalAgent.takeProfitBps,
        stopLossBps: (parsed.patch.stopLossBps as number) ?? personalAgent.stopLossBps,
        maxSlippageBps: (parsed.patch.maxSlippageBps as number) ?? personalAgent.maxSlippageBps,
        version: personalAgent.version + 1,
      };
      savePersonalAgent(() => nextState);
      setStrategyType(nextState.strategyType);
      setTpInput(String(nextState.takeProfitBps));
      setSlInput(String(nextState.stopLossBps));
      setSlipInput(String(nextState.maxSlippageBps));
      setNlProposal(null);
      setNlInstruction("");
      await syncProfileToServer(nextState, `Applied: ${parsed.summary}`);
      return;
    }
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

  const effectivePaused = isOperator ? Boolean(status?.paused) : personalAgent.paused;
  const effectiveStrategy = isOperator ? status?.activeStrategy : personalAgent.strategyType;
  const effectivePolicyVersion = isOperator ? policyVersion : personalAgent.version;

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
      {/* VIEW 1: INTERACTIVE AGENT HOME — Command your agent, zero scroll, tons of breathing room */}
      {view === "overview" && (
        <div className="flex w-full flex-col justify-between gap-6 py-2 lg:h-[calc(100svh-120px)] lg:overflow-hidden">
          {/* 1. Personal Hero + Direct Pause/Resume Control */}
          <section className="flex flex-col justify-between gap-4 pt-1 sm:flex-row sm:items-end">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    disconnected
                      ? "bg-amber-500"
                      : effectivePaused || status?.killSwitch
                        ? "bg-amber-500"
                        : "bg-emerald-500",
                  )}
                />
                <span>
                  {disconnected
                    ? "Connecting to your agent…"
                    : status?.killSwitch
                      ? "Agent stopped"
                      : effectivePaused
                        ? "Your agent is paused"
                        : `Active · Watching ${status?.market ?? "WHSK/USDT"}`}
                </span>
              </div>
              <h1 className="font-display text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl">
                Tell your agent how to trade.
              </h1>
              <p className="max-w-xl text-sm text-muted-foreground">
                Set a rule in plain English. Changes apply only to your personal wallet session and
                never affect other users.
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={actionBusy || (isOperator && (disconnected || status?.killSwitch))}
                onClick={() => void handlePauseToggle()}
                className="h-10 rounded-full px-4 text-xs font-medium cursor-pointer"
              >
                {effectivePaused ? (
                  <>
                    <Play className="mr-1.5 size-3.5" />
                    Resume Agent
                  </>
                ) : (
                  <>
                    <Pause className="mr-1.5 size-3.5" />
                    Pause Agent
                  </>
                )}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => onNavigate("/agent/policy")}
                className="h-10 rounded-full px-5 text-xs font-medium cursor-pointer"
              >
                Full Controls
                <ArrowRight className="ml-1.5 size-3.5" />
              </Button>
            </div>
          </section>

          {/* 2. THE CENTERPIECE: Interactive Plain-English Command Box */}
          <section
            className="flex flex-col gap-4 rounded-[24px] border border-border p-6 sm:p-7"
            style={{ backgroundColor: "#f8f7ee", color: "#050505" }}
          >
            <div className="flex flex-col gap-1">
              <span className="text-sm font-semibold">Give your agent a rule</span>
              <span className="text-xs opacity-65">
                Pick a preset below or type your own instruction — preview before applying.
              </span>
            </div>

            <div className="flex flex-col gap-2.5 sm:flex-row">
              <input
                type="text"
                value={nlInstruction}
                onChange={(e) => setNlInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && nlInstruction.trim() && !disconnected && !actionBusy) {
                    void handleProposePolicy();
                  }
                }}
                placeholder='e.g. "Switch to momentum, take profit 4%, stop loss 2%, max slippage 0.8%"'
                className="h-12 flex-1 rounded-full border border-black/15 bg-white px-5 text-sm text-black placeholder:text-black/40 focus:border-black focus:outline-none"
              />
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={disconnected || actionBusy || !nlInstruction.trim()}
                  onClick={() => void handleProposePolicy()}
                  className="h-12 rounded-full border-black/20 bg-white px-5 text-xs font-medium text-black hover:bg-black/5 cursor-pointer"
                >
                  Preview
                </Button>
                <Button
                  type="button"
                  disabled={disconnected || actionBusy || !nlInstruction.trim()}
                  onClick={() => void handleApplyPolicy()}
                  className="h-12 rounded-full bg-black px-6 text-xs font-medium text-[#f8f7ee] hover:bg-black/85 cursor-pointer"
                >
                  Apply Rule
                </Button>
              </div>
            </div>

            {/* One-tap consumer presets */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium opacity-55">Try a preset:</span>
              {[
                {
                  label: "Conservative · 2% profit",
                  prompt: "Use buy below target price, take profit 2%, stop loss 1%, max slippage 0.5%",
                },
                {
                  label: "Trend Follower · 4% profit",
                  prompt: "Switch to momentum, take profit 4%, stop loss 2%, max slippage 0.8%",
                },
                {
                  label: "Volatility Shield",
                  prompt: "Switch to volatility aware, take profit 3%, stop loss 1.5%, max slippage 0.5%",
                },
              ].map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setNlInstruction(preset.prompt)}
                  className="rounded-full border border-black/15 bg-white/80 px-3.5 py-1.5 text-xs font-medium text-black transition-colors hover:bg-white cursor-pointer"
                >
                  {preset.label}
                </button>
              ))}
            </div>

            {/* Inline Preview / Feedback (auto-fades smoothly) */}
            {actionFeedback && (
              <div
                role="status"
                onClick={() => setActionFeedback(null)}
                className={cn(
                  "flex items-center gap-2 rounded-[12px] border px-3.5 py-2 text-xs transition-opacity duration-500 cursor-pointer",
                  feedbackFading ? "opacity-0" : "opacity-100",
                  actionFeedback.kind === "ok"
                    ? "border-emerald-600/30 bg-emerald-500/10 text-emerald-800"
                    : "border-red-600/30 bg-red-500/10 text-red-700",
                )}
              >
                {actionFeedback.kind === "ok" ? (
                  <CheckCircle2 className="size-3.5 shrink-0" />
                ) : (
                  <ShieldAlert className="size-3.5 shrink-0" />
                )}
                <span>{actionFeedback.text}</span>
              </div>
            )}
            {nlProposal && (
              <div className="flex items-center justify-between gap-3 rounded-[12px] border border-black/10 bg-white/80 px-4 py-2.5 text-xs">
                <span className="truncate font-medium">
                  Ready to apply:{" "}
                  <code className="tabular-nums-mono opacity-75">
                    {JSON.stringify(nlProposal.proposedPatch)}
                  </code>
                </span>
                <button
                  type="button"
                  onClick={() => void handleApplyPolicy()}
                  className="shrink-0 rounded-full bg-black px-3.5 py-1 text-[11px] font-medium text-[#f8f7ee] cursor-pointer"
                >
                  Confirm
                </button>
              </div>
            )}
          </section>

          {/* 3. Two Clean Summary Cards: Your Current Plan + Latest Market Check */}
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* Left: Your Current Plan */}
            <div className="flex flex-col justify-between gap-4 rounded-[20px] border border-border bg-card p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Your Current Plan
                  </span>
                  <h2 className="mt-0.5 text-base font-semibold text-foreground">
                    {humanStrategy(effectiveStrategy)}
                  </h2>
                  {!isOperator && (
                    <span className="text-[11px] text-muted-foreground">
                      Profit {(personalAgent.takeProfitBps / 100).toFixed(1)}% · Stop{" "}
                      {(personalAgent.stopLossBps / 100).toFixed(1)}% · Max shift{" "}
                      {(personalAgent.maxSlippageBps / 100).toFixed(1)}%
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate("/agent/policy")}
                  className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  Edit limits
                  <ArrowRight className="size-3.5" />
                </button>
              </div>

              <div className="flex flex-col gap-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Spending limit used</span>
                  <span className="tabular-nums-mono font-semibold text-foreground">
                    {metrics ? fmtPayment6(metrics.currentTotalExposurePayment, "USDT") : "$0.00"} /{" "}
                    {config ? fmtPayment6(config.riskLimits.maxTotalExposurePayment, "USDT") : "$50.00"}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-foreground"
                    style={{ width: `${exposurePct}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Right: Latest Market Check */}
            <div className="flex flex-col justify-between gap-4 rounded-[20px] border border-border bg-card p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Latest Market Check · {fmtTime(health?.lastSuccessfulCycleAt)}
                  </span>
                  <h2 className="mt-0.5 text-base font-semibold text-foreground">
                    {winningVenue === "TRANCHE"
                      ? "Tranche is cheaper right now"
                      : winningVenue === "HSKSWAP"
                        ? `HSKSwap is best right now (${markets?.venueComparison ? fmtPayment6(markets.venueComparison.hskswap.acquisitionCostPayment, paymentSymbol) : "—"})`
                        : "Waiting for a better price"}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate("/agent/activity")}
                  className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  Activity ({snapshot?.decisions.length ?? 0})
                  <ArrowRight className="size-3.5" />
                </button>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {humanRegime(markets?.marketRegime)} · {metrics?.totalCycles ?? 0} checks ·{" "}
                  {metrics?.liveExecutionsCount ?? 0} trades made
                </span>
                <button
                  type="button"
                  onClick={() => onNavigate("/trade")}
                  className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4 cursor-pointer"
                >
                  Lock a price manually
                  <ArrowRight className="size-3" />
                </button>
              </div>
            </div>
          </section>
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
                  { id: "insights", label: "Performance" },
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

            {activeTab === "insights" && (
              <div className="p-6">
                {intelligence ? (
                  <AgentIntelligencePanel intelligence={intelligence} />
                ) : (
                  <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                    <p className="text-sm font-medium text-foreground">No performance stats yet</p>
                    <p className="max-w-sm text-xs text-muted-foreground">
                      Performance analytics populate once the agent completes live cycles with
                      intelligence tracking enabled.
                    </p>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {/* VIEW 3: DEDICATED RULES & CONTROLS PAGE — Clean 2-column spacious layout */}
      {view === "policy" && (
        <div className="flex w-full flex-col gap-6 lg:h-[calc(100svh-120px)] lg:overflow-hidden">
          {actionFeedback && (
            <div
              role="status"
              onClick={() => setActionFeedback(null)}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-[14px] border px-4 py-2.5 text-xs transition-opacity duration-500 cursor-pointer",
                feedbackFading ? "opacity-0" : "opacity-100",
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
                    <p className="text-xs opacity-65">Automatic caps · Rule v{effectivePolicyVersion}</p>
                  </div>
                  <span className="rounded-full bg-black/10 px-2.5 py-1 text-[11px] font-medium">
                    {disconnected && isOperator
                      ? "Offline"
                      : status?.killSwitch
                        ? "Stopped"
                        : effectivePaused
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
                    disabled={actionBusy || (isOperator && (disconnected || status?.killSwitch))}
                    onClick={() => {
                      if (!isOperator) {
                        savePersonalAgent((prev) => ({ ...prev, paused: false }));
                        setActionFeedback({ kind: "ok", text: "Your personal agent is active." });
                      } else {
                        void runControl("Start", () => client.start());
                      }
                    }}
                    className="h-9 flex-1 rounded-full bg-black text-xs text-[#f8f7ee] hover:bg-black/85 cursor-pointer"
                  >
                    <Play className="mr-1.5 size-3.5" /> Start
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={actionBusy || (isOperator && disconnected)}
                    onClick={() => void handlePauseToggle()}
                    className="h-9 flex-1 rounded-full border-black/20 bg-white/80 text-xs text-black hover:bg-white cursor-pointer"
                  >
                    <Pause className="mr-1.5 size-3.5" /> {effectivePaused ? "Resume" : "Pause"}
                  </Button>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={actionBusy || (isOperator && disconnected)}
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
                    {humanStrategy(effectiveStrategy)}
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
                if (!isOperator) {
                  savePersonalAgent((prev) => ({ ...prev, paused: true }));
                  setActionFeedback({
                    kind: "ok",
                    text: "Your personal agent has been stopped. Other users are unaffected.",
                  });
                } else {
                  void runControl("Activate kill switch", () => client.kill());
                }
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
