export type AgentExecutionMode = "dry_run" | "live";
export type AgentDataSourceMode = "fixture" | "dry_run" | "fork";
export type StrategyType = "momentum" | "price_threshold" | "volatility_aware";

export interface AgentHealth {
  ok: boolean;
  uptimeSec: number;
  runtimeRunning: boolean;
  mode: AgentExecutionMode;
  dataSource: AgentDataSourceMode;
  chainId: number;
  quotesAreReal: boolean;
  stateCorrupted: boolean;
  pendingTxCount: number;
}

export interface PendingTxItem {
  id: string;
  decisionKey: string;
  action: string;
  createdAt: number;
  status: "IN_FLIGHT" | "UNCERTAIN_TIMEOUT";
  note?: string;
}

export interface AgentStatus {
  running: boolean;
  mode: AgentExecutionMode;
  dataSource: AgentDataSourceMode;
  chainId: number;
  quotesAreReal: boolean;
  market: string;
  activeStrategy: StrategyType;
  paused: boolean;
  killSwitch: boolean;
  stateCorrupted: boolean;
  pendingTxs: PendingTxItem[];
  lastCycleId: number | null;
  lastCycleTimestamp: number | null;
  lastDecisionAction: string | null;
  lastSelectedVenue: "TRANCHE" | "HSKSWAP" | "NONE" | null;
  lastTxHash: string | null;
}

export interface AgentMetrics {
  mode: AgentExecutionMode;
  totalRealizedPnlPayment: string;
  totalUnrealizedPnlPayment: string;
  currentTotalExposurePayment: string;
  dailyPremiumSpentPayment: string;
  dailyRealizedLossPayment: string;
  openPositionsCount: number;
  activeTicketsCount: number;
  pendingTxCount: number;
  closedPositionsCount: number;
  wins: number;
  losses: number;
  totalCycles: number;
  liveExecutionsCount: number;
  dryRunEvaluationsCount: number;
}

export interface RiskCheckItem {
  name: string;
  passed: boolean;
  detail: string;
}

export interface AgentDecisionItem {
  cycleId: number;
  decisionKey: string;
  timestamp: number;
  strategyType: StrategyType;
  signalAction: "ENTER_LONG" | "WAIT";
  signalValid: boolean;
  signalConfidence: number;
  signalReason: string;
  selectedVenue: "TRANCHE" | "HSKSWAP" | "NONE";
  venueRationale: string;
  tranche: {
    eligible: boolean;
    offerId: string | null;
    acquisitionCostPayment: string;
    reservationPremiumPayment: string;
    exercisePayment: string;
    expectedNetProfitAtTargetPayment: string;
    rejectionReasons: string[];
  };
  hskswap: {
    eligible: boolean;
    acquisitionCostPayment: string;
    priceImpactBps: number | null;
    expectedNetProfitAtTargetPayment: string;
    rejectionReasons: string[];
  };
  riskAllowed: boolean;
  riskChecks: RiskCheckItem[];
  failedRiskChecks: RiskCheckItem[];
  selectedAction: string;
  rationale: string;
  txHashes: string[];
  error: string | null;
}

export interface AgentPositionItem {
  positionId: string;
  venue: "TRANCHE" | "HSKSWAP";
  inventoryToken: string;
  paymentToken: string;
  initialQuantity: string;
  remainingQuantity: string;
  entryCostPayment: string;
  remainingCostBasisPayment: string;
  reservationPremiumPaid: string;
  entryUnitPriceX36: string;
  realizedPnlPayment: string;
  unrealizedPnlPayment: string;
  status: "OPEN" | "PARTIALLY_CLOSED" | "CLOSED";
  openedAt: number;
  closedAt: number | null;
  entryTxHashes: string[];
  exitTxHashes: string[];
}

export interface AgentTicketItem {
  ticketId: string;
  offerId: string;
  inventoryToken: string;
  paymentToken: string;
  inventoryAmount: string;
  remainingAmount: string;
  premiumPaidPayment: string;
  expiresAt: number;
  reservedAt: number;
  status: "ACTIVE" | "EXERCISED" | "EXPIRED_ABANDONED" | "RECLAIMED";
  reserveTxHash: string;
  exerciseTxHashes: string[];
  reclaimTxHash?: string;
}

export interface AgentMarketsResponse {
  available: boolean;
  market: string;
  timestamp?: number;
  pool?: {
    venue: string;
    poolAddress: string;
    fee: number;
    liquidity: string;
    spotPriceX36: string;
    twapPriceX36: string | null;
    observationCardinality: number;
  };
  oracle?: {
    priceX36: string;
    updatedAt: number;
    isValid: boolean;
  } | null;
  oracleAgeSec?: number | null;
  oracleDeviationBps?: number | null;
  dexBuyQuote?: {
    paymentAmountIn: string;
    priceImpactBps: number;
  } | null;
  dexSellQuote?: {
    paymentAmountOut: string;
    priceImpactBps: number;
  } | null;
  trancheOffersCount?: number;
  trancheSelectedOffer?: {
    offerId: string;
    quotedGrossPremium: string;
    quotedExerciseCost: string;
    effectiveAllInUnitCostX36: string;
  } | null;
  realizedVolatilityBps?: number;
  momentumReturnBps?: number;
  dislocationVsTwapBps?: number;
  anomalies?: string[];
  venueComparison?: {
    selectedVenue: "TRANCHE" | "HSKSWAP" | "NONE";
    rationale: string;
    tranche: {
      eligible: boolean;
      acquisitionCostPayment: string;
      reservationPremiumPayment: string;
      exercisePayment: string;
      rejectionReasons: string[];
    };
    hskswap: {
      eligible: boolean;
      acquisitionCostPayment: string;
      priceImpactBps?: number;
      rejectionReasons: string[];
    };
  } | null;
}

export interface AgentConfigResponse {
  mode: AgentExecutionMode;
  strategy: {
    type: StrategyType;
    momentumThresholdBps: number;
    maxEntryPriceX36: string;
    takeProfitBps: number;
    stopLossBps: number;
    takeProfitExitBps: number;
    ticketExerciseWindowSec: number;
  };
  riskLimits: {
    maxPositionSizeInventory: string;
    maxTotalExposurePayment: string;
    maxDailyPremiumBudgetPayment: string;
    maxDailyRealizedLossPayment: string;
    maxConcurrentPositions: number;
    maxConcurrentTickets: number;
    maxSlippageBps: number;
    minPoolLiquidity: string;
    maxOracleAgeSec: number;
    maxOracleDeviationBps: number;
    paused: boolean;
    killSwitch: boolean;
  };
  policyBounds: {
    hardMaxPositionSizeInventory: string;
    hardMaxSlippageBps: number;
    minStopLossBps: number;
    maxStopLossBps: number;
    minTakeProfitBps: number;
    maxTakeProfitBps: number;
  };
}

export interface AgentDashboardSnapshot {
  health: AgentHealth;
  status: AgentStatus;
  metrics: AgentMetrics;
  decisions: AgentDecisionItem[];
  positions: { open: AgentPositionItem[]; all: AgentPositionItem[] };
  tickets: { active: AgentTicketItem[]; all: AgentTicketItem[] };
  markets: AgentMarketsResponse;
  config: AgentConfigResponse;
  fetchedAt: number;
}

export interface StrategyUpdateRequest {
  strategyType?: StrategyType;
  takeProfitBps?: number;
  stopLossBps?: number;
  maxSlippageBps?: number;
}

export class AgentApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly rejectedFields?: string[];

  constructor(status: number, code: string, message: string, rejectedFields?: string[]) {
    super(message);
    this.name = "AgentApiError";
    this.status = status;
    this.code = code;
    this.rejectedFields = rejectedFields;
  }
}

const DEFAULT_AGENT_API_URL =
  (typeof import.meta !== "undefined" &&
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env
      ?.VITE_AGENT_API_URL) ||
  "http://127.0.0.1:8787";

export class AgentApiClient {
  private readonly baseUrl: string;
  private token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options?: { baseUrl?: string; token?: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = (options?.baseUrl ?? DEFAULT_AGENT_API_URL).replace(/\/+$/, "");
    this.token = options?.token ?? "";
    this.fetchImpl = options?.fetchImpl ?? fetch;
  }

  setToken(token: string): void {
    this.token = token.trim();
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      if (this.token) {
        headers.Authorization = `Bearer ${this.token}`;
      }
    }

    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new AgentApiError(
        0,
        "API_UNREACHABLE",
        err instanceof Error ? err.message : "Local Agent API unreachable",
      );
    }

    const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    if (!resp.ok) {
      throw new AgentApiError(
        resp.status,
        typeof data.error === "string" ? data.error : `HTTP_${resp.status}`,
        typeof data.message === "string" ? data.message : `Request failed (${resp.status})`,
        Array.isArray(data.rejectedFields) ? (data.rejectedFields as string[]) : undefined,
      );
    }
    return data as T;
  }

  async fetchSnapshot(): Promise<AgentDashboardSnapshot> {
    const [health, status, metrics, decisionsRes, positions, tickets, markets, config] =
      await Promise.all([
        this.request<AgentHealth>("GET", "/health"),
        this.request<AgentStatus>("GET", "/agent/status"),
        this.request<AgentMetrics>("GET", "/agent/metrics"),
        this.request<{ total: number; items: AgentDecisionItem[] }>("GET", "/agent/decisions?limit=20"),
        this.request<{ open: AgentPositionItem[]; all: AgentPositionItem[] }>("GET", "/agent/positions"),
        this.request<{ active: AgentTicketItem[]; all: AgentTicketItem[] }>("GET", "/agent/tickets"),
        this.request<AgentMarketsResponse>("GET", "/agent/markets"),
        this.request<AgentConfigResponse>("GET", "/agent/config"),
      ]);

    return {
      health,
      status,
      metrics,
      decisions: decisionsRes.items,
      positions,
      tickets,
      markets,
      config,
      fetchedAt: Date.now(),
    };
  }

  start() {
    return this.request<{ ok: boolean; running: boolean; mode: AgentExecutionMode }>(
      "POST",
      "/agent/start",
    );
  }

  pause() {
    return this.request<{ ok: boolean; paused: boolean; killSwitch: boolean }>(
      "POST",
      "/agent/pause",
    );
  }

  resume() {
    return this.request<{ ok: boolean; paused: boolean }>("POST", "/agent/resume");
  }

  kill() {
    return this.request<{ ok: boolean; running: boolean; paused: boolean; killSwitch: boolean }>(
      "POST",
      "/agent/kill",
    );
  }

  updateStrategy(patch: StrategyUpdateRequest) {
    return this.request<{
      ok: boolean;
      strategy: AgentConfigResponse["strategy"];
      riskLimits: AgentConfigResponse["riskLimits"];
    }>("POST", "/agent/strategy", patch);
  }

  reconcile(pendingTxId: string, resolution: "CONFIRMED_FAILED" | "CONFIRMED_MANUAL") {
    return this.request<{
      ok: boolean;
      pendingTxId: string;
      resolution: string;
      remainingPendingTxs: number;
    }>("POST", "/agent/reconcile", { pendingTxId, resolution });
  }
}
