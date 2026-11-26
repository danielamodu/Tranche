export type AgentExecutionMode = "dry_run" | "live";
export type AgentDataSourceMode = "fixture" | "dry_run" | "fork";
export type StrategyType = "momentum" | "price_threshold" | "volatility_aware";
export type MarketRegime = "CALM" | "TRENDING" | "VOLATILE" | "DISLOCATED";

export interface AgentHealth {
  ok: boolean;
  uptimeSec: number;
  runtimeRunning: boolean;
  rpcHealthy: boolean;
  lastSuccessfulCycleAt: number | null;
  recoveryState: string;
  mode: AgentExecutionMode;
  dataSource: AgentDataSourceMode;
  chainId: number;
  quotesAreReal: boolean;
  stateCorrupted: boolean;
  pendingTxCount: number;
}

export interface AgentReady {
  ready: boolean;
  recoveryState: string;
  rpcHealthy: boolean;
  killSwitch: boolean;
  stateCorrupted: boolean;
  httpStatus: number;
}

export interface PolicyHistoryEntry {
  version: number;
  timestamp: number;
  source: string;
  instruction?: string;
}

export interface PolicyHistoryResponse {
  currentVersion: number;
  history: PolicyHistoryEntry[];
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
  rpcHealthy?: boolean;
  lastSuccessfulCycleAt?: number | null;
  recoveryState?: string;
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
  marketRegime?: MarketRegime;
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
  ready: AgentReady;
  status: AgentStatus;
  metrics: AgentMetrics;
  decisions: AgentDecisionItem[];
  positions: { open: AgentPositionItem[]; all: AgentPositionItem[] };
  tickets: { active: AgentTicketItem[]; all: AgentTicketItem[] };
  markets: AgentMarketsResponse;
  config: AgentConfigResponse;
  policyHistory: PolicyHistoryResponse;
  fetchedAt: number;
}

export interface StrategyUpdateRequest {
  strategyType?: StrategyType;
  takeProfitBps?: number;
  stopLossBps?: number;
  maxSlippageBps?: number;
  maxPositionSizeInventory?: string;
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

export const DEFAULT_AGENT_API_URL =
  (typeof import.meta !== "undefined" &&
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env
      ?.VITE_AGENT_API_URL) ||
  "http://127.0.0.1:8787";

export function normalizeAgentApiUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_AGENT_API_URL.replace(/\/+$/, "");
  return trimmed;
}

export function isLocalAgentApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}

export function isHostedHttpsToLocalApi(apiUrl: string, pageProtocol?: string): boolean {
  const proto =
    pageProtocol ?? (typeof window !== "undefined" ? window.location.protocol : "http:");
  return proto === "https:" && apiUrl.startsWith("http://") && isLocalAgentApiUrl(apiUrl);
}

export class AgentApiClient {
  private readonly baseUrl: string;
  private token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options?: { baseUrl?: string; token?: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = (options?.baseUrl ?? DEFAULT_AGENT_API_URL).replace(/\/+$/, "");
    this.token = options?.token ?? "";
    this.fetchImpl =
      options?.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
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

  async getReady(): Promise<AgentReady> {
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.baseUrl}/ready`, { method: "GET" });
    } catch (err) {
      throw new AgentApiError(
        0,
        "API_UNREACHABLE",
        err instanceof Error ? err.message : "Local Agent API unreachable",
      );
    }
    const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    if (resp.status !== 200 && resp.status !== 503) {
      throw new AgentApiError(
        resp.status,
        typeof data.error === "string" ? data.error : `HTTP_${resp.status}`,
        typeof data.message === "string" ? data.message : `Readiness check failed (${resp.status})`,
      );
    }
    return {
      ready: Boolean(data.ready),
      recoveryState: typeof data.recoveryState === "string" ? data.recoveryState : "unknown",
      rpcHealthy: Boolean(data.rpcHealthy),
      killSwitch: Boolean(data.killSwitch),
      stateCorrupted: Boolean(data.stateCorrupted),
      httpStatus: resp.status,
    };
  }

  async fetchSnapshot(): Promise<AgentDashboardSnapshot> {
    const [health, ready, status, metrics, decisionsRes, positions, tickets, markets, config, policyHistory] =
      await Promise.all([
        this.request<AgentHealth>("GET", "/health"),
        this.getReady(),
        this.request<AgentStatus>("GET", "/agent/status"),
        this.request<AgentMetrics>("GET", "/agent/metrics"),
        this.request<{ total: number; items: AgentDecisionItem[] }>("GET", "/agent/decisions?limit=20"),
        this.request<{ open: AgentPositionItem[]; all: AgentPositionItem[] }>("GET", "/agent/positions"),
        this.request<{ active: AgentTicketItem[]; all: AgentTicketItem[] }>("GET", "/agent/tickets"),
        this.request<AgentMarketsResponse>("GET", "/agent/markets"),
        this.request<AgentConfigResponse>("GET", "/agent/config"),
        this.getPolicyHistory(),
      ]);

    return {
      health,
      ready,
      status,
      metrics,
      decisions: decisionsRes.items,
      positions,
      tickets,
      markets,
      config,
      policyHistory,
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

  proposePolicy(instruction: string) {
    return this.request<{
      provider: string;
      instruction: string;
      proposedPatch: Record<string, unknown>;
      validation: { valid: boolean; sanitizedPatch: Record<string, unknown>; rejectedFields: string[] };
      applied: boolean;
    }>("POST", "/agent/policy/propose", { instruction });
  }

  applyPolicy(instruction: string) {
    return this.request<{
      ok: boolean;
      policyVersion: number;
      instruction: string;
      appliedPatch: Record<string, unknown>;
    }>("POST", "/agent/policy/apply", { instruction });
  }

  rollbackPolicy(version: number) {
    return this.request<{
      ok: boolean;
      policyVersion: number;
      restoredFromVersion: number;
    }>("POST", "/agent/policy/rollback", { version });
  }

  getPolicyHistory(): Promise<PolicyHistoryResponse> {
    return this.request<PolicyHistoryResponse>("GET", "/agent/policy/history");
  }

  getIntelligence(): Promise<AgentIntelligenceSnapshot> {
    return this.request<AgentIntelligenceSnapshot>("GET", "/agent/intelligence");
  }

  getProtocolActivity(): Promise<ProtocolActivitySnapshot> {
    return this.request<ProtocolActivitySnapshot>("GET", "/agent/protocol/activity");
  }

  approveProtocolProposal(
    proposalId: string,
    payload: { approvedBy: string; expectedBindingHash: string },
  ): Promise<{ ok: true; proposal: ProtocolActionProposalItem }> {
    return this.request<{ ok: true; proposal: ProtocolActionProposalItem }>(
      "POST",
      `/agent/protocol/proposals/${encodeURIComponent(proposalId)}/approve`,
      payload,
    );
  }

  rejectProtocolProposal(
    proposalId: string,
    payload?: { reason?: string },
  ): Promise<{ ok: true; proposal: ProtocolActionProposalItem }> {
    return this.request<{ ok: true; proposal: ProtocolActionProposalItem }>(
      "POST",
      `/agent/protocol/proposals/${encodeURIComponent(proposalId)}/reject`,
      payload ?? {},
    );
  }

  getUserProfile(address: string): Promise<{ profile: UserAgentProfile | null }> {
    return this.request<{ profile: UserAgentProfile | null }>(
      "GET",
      `/profiles/${encodeURIComponent(address)}`,
    );
  }

  saveUserProfile(
    address: string,
    payload: {
      paused: boolean;
      strategyType: StrategyType;
      takeProfitBps: number;
      stopLossBps: number;
      maxSlippageBps: number;
      timestamp: number;
      signature: string;
    },
  ): Promise<{ ok: true; profile: UserAgentProfile }> {
    return this.request<{ ok: true; profile: UserAgentProfile }>(
      "POST",
      `/profiles/${encodeURIComponent(address)}`,
      payload,
    );
  }

  getProtocolState(): Promise<ProtocolStateSnapshot> {
    return this.request<ProtocolStateSnapshot>("GET", "/agent/protocol/state");
  }

  updateProtocolPermissions(
    patch: Partial<ProtocolPermissionsConfig>,
  ): Promise<{ ok: true; permissions: ProtocolPermissionsConfig }> {
    return this.request<{ ok: true; permissions: ProtocolPermissionsConfig }>(
      "POST",
      "/agent/protocol/permissions",
      patch,
    );
  }

  approveProposal(proposalId: string): Promise<{ ok: true; proposal: ProtocolActionProposal }> {
    return this.request<{ ok: true; proposal: ProtocolActionProposal }>(
      "POST",
      `/agent/protocol/proposals/${encodeURIComponent(proposalId)}/approve`,
      {},
    );
  }

  rejectProposal(
    proposalId: string,
    reason: string,
  ): Promise<{ ok: true; proposal: ProtocolActionProposal }> {
    return this.request<{ ok: true; proposal: ProtocolActionProposal }>(
      "POST",
      `/agent/protocol/proposals/${encodeURIComponent(proposalId)}/reject`,
      { reason },
    );
  }
}

export interface ProtocolPermissionsConfig {
  maxReservationSizePayment: string;
  dailySpendingLimitPayment: string;
  maxPortfolioAllocationBps: number;
  minExpectedNetAdvantageBps: number;
  trancheEnabled: boolean;
  hskswapEnabled: boolean;
  abstainWhenUnsuitable: boolean;
}

export type ProposalLifecycleState =
  | "PROPOSED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "SUBMITTED"
  | "CONFIRMED"
  | "FAILED"
  | "EXPIRED";

export interface ProtocolActionProposal {
  proposalId: string;
  actionType: "RESERVE_INVENTORY" | "EXERCISE_TICKET" | "CANCEL_RESERVATION";
  status: ProposalLifecycleState;
  chainId: number;
  dataProvenance: DataProvenance;
  offerId: string | null;
  ticketId: string | null;
  assetSymbol: string;
  amountInventory: string;
  reservationPremiumPayment: string;
  exercisePricePayment: string;
  expiry: number;
  estimatedTotalCostPayment: string;
  alternativeHskswapCostPayment: string;
  expectedAdvantagePayment: string;
  expectedAdvantageBps: number;
  riskChecks: Array<{ name: string; passed: boolean; detail: string }>;
  rationale: string;
  txHash: string | null;
  confirmationNote: string | null;
  rejectionReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProtocolAuditEvent {
  eventId: string;
  timestamp: number;
  category:
    | "MARKET_OBSERVATION"
    | "VENUE_COMPARISON"
    | "STRATEGY_DECISION"
    | "RESERVATION_PROPOSAL"
    | "APPROVAL_DECISION"
    | "TX_SUBMISSION"
    | "CONFIRMED_RESERVATION"
    | "TICKET_EXERCISE"
    | "TICKET_CANCELLATION"
    | "POSITION_MANAGEMENT"
    | "ABSTENTION"
    | "ERROR_RECOVERY";
  lifecycleState: ProposalLifecycleState | "OBSERVED" | "ABSTAINED";
  title: string;
  detail: string;
  chainId: number;
  dataProvenance: DataProvenance;
  proposalId?: string;
  txHash?: string;
}

export interface ProtocolStateSnapshot {
  chainId: number;
  dataSource: string;
  dataProvenance: DataProvenance;
  permissionMatrix: Record<string, "AUTONOMOUS" | "APPROVAL_REQUIRED" | "RESTRICTED">;
  permissions: ProtocolPermissionsConfig;
  proposals: ProtocolActionProposal[];
  pendingSubmittedCount: number;
  events: ProtocolAuditEvent[];
}

export interface UserAgentProfile {
  address: string;
  paused: boolean;
  strategyType: StrategyType;
  takeProfitBps: number;
  stopLossBps: number;
  maxSlippageBps: number;
  version: number;
  updatedAt: number;
}

export function buildProfileSignMessage(params: {
  address: string;
  paused: boolean;
  strategyType: StrategyType;
  takeProfitBps: number;
  stopLossBps: number;
  maxSlippageBps: number;
  timestamp: number;
}): string {
  return [
    "Tranche Agent Profile Update",
    `Wallet: ${params.address.toLowerCase()}`,
    `Status: ${params.paused ? "paused" : "active"}`,
    `Strategy: ${params.strategyType}`,
    `TakeProfitBps: ${params.takeProfitBps}`,
    `StopLossBps: ${params.stopLossBps}`,
    `MaxSlippageBps: ${params.maxSlippageBps}`,
    `Timestamp: ${params.timestamp}`,
  ].join("\n");
}

export type DataProvenance = "LIVE" | "FORK" | "REPLAY" | "MOCK";

export interface AgentIntelligenceSnapshot {
  dataProvenance: DataProvenance;
  marketRegime: MarketRegime | null;
  adaptiveStrategy: {
    regime: MarketRegime;
    suitableForTrading: boolean;
    unsuitableReasons: string[];
    selectedStrategyType: StrategyType | "NONE";
    adjustmentsApplied: string[];
  } | null;
  latestVenueEvidence: {
    timestamp: number;
    marketRegime: MarketRegime;
    quoteAgeSec: number;
    trancheCompleteCostPayment: string;
    hskswapCompleteCostPayment: string;
    costAdvantagePayment: string;
    costAdvantageBps: number;
    trancheFailureRateBps: number | null;
    hskswapFailureRateBps: number | null;
    factors: string[];
  } | null;
  positionIntegrity: {
    healthy: boolean;
    pendingTxBlocking: boolean;
    issues: Array<{ severity: "WARN" | "CRITICAL"; code: string; entityId: string; detail: string }>;
  } | null;
  portfolio: {
    availableBalancePayment: string;
    totalEquityPayment: string;
    totalCommittedCapitalPayment: string;
    availableCapitalForAllocationPayment: string;
    totalRealizedPnlPayment: string;
    totalUnrealizedPnlPayment: string;
    assetExposures: Array<{
      inventoryToken: string;
      totalCommittedPayment: string;
      allocationBps: number;
      openPositionsCount: number;
      activeTicketsCount: number;
    }>;
  } | null;
  evaluation: {
    dataProvenance: DataProvenance;
    totalDecisions: number;
    executedDecisions: number;
    rejectedDecisions: number;
    netPnlAfterFeesPayment: string;
    maxDrawdownPayment: string;
    maxDrawdownBps: number;
    closedTradesCount: number;
    wins: number;
    losses: number;
    winRateBps: number;
    profitFactor: number | null;
    sharpeRatio: number | null;
    venueSelectionAccuracyBps: number | null;
    totalExecutionCostImprovementPayment: string;
    riskLimitViolationsCount: number;
    missedExecutionAttempts: number;
    duplicateExecutionAttempts: number;
  };
}

export type ProtocolProposalStatus =
  | "PROPOSED"
  | "APPROVED"
  | "REJECTED"
  | "SUBMITTED"
  | "CONFIRMED"
  | "FAILED"
  | "EXPIRED";

export interface ProtocolActionProposalItem {
  proposalId: string;
  status: ProtocolProposalStatus;
  bindingHash: string;
  dataProvenance: DataProvenance;
  rationale: string;
  parameters: {
    action: "RESERVE" | "EXERCISE" | "RECLAIM_EXPIRED";
    wallet: string;
    chainId: number;
    contractAddress: string;
    token: string;
    amount: string;
    maxPaymentOrPremium: string;
    offerId?: string;
    ticketId?: string;
    durationSec?: number;
    recipient: string;
    expiresAt: number;
  };
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
  approvedBy?: string;
  txHash?: string;
  blockNumber?: string;
  failureReason?: string;
}

export interface ProtocolActivitySnapshot {
  dataProvenance: DataProvenance;
  chainId: number;
  autonomousMainnetSigningEnabled: boolean;
  offers: Array<{
    offerId: string;
    inventoryToken: string;
    paymentToken: string;
    availableInventory: string;
    strikePrice: string;
    expiresAt: number;
    active: boolean;
  }>;
  tickets: Array<{
    ticketId: string;
    offerId: string;
    status: "ACTIVE" | "EXERCISED" | "EXPIRED" | "RECLAIMED";
    remainingAmount: string;
    expiresAt: number;
  }>;
  latestVenueDecision: {
    selectedVenue: "TRANCHE" | "HSKSWAP" | "NONE";
    reason: string;
    timestamp: number;
  } | null;
  proposals: ProtocolActionProposalItem[];
}
