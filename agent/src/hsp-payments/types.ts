/**
 * Isolated HSP Payment Orchestration Foundation — Interface Contracts.
 *
 * BOUNDARY NOTICE:
 * - Completely decoupled from trading execution adapters (TrancheExecutionAgent, HskSwapVenue, AgentRuntime).
 * - Does NOT define or fabricate live HSP MCP tool schemas, auth headers, request payloads, or response structures.
 *   Live wire schemas must be populated strictly from live HSP MCP tool discovery after EC2 IP allowlisting.
 */

export type HspPaymentLifecycleState =
  | "CREATED"
  | "PREPARED"
  | "AUTHORIZED"
  | "SUBMITTED"
  | "PROCESSING"
  | "SAFE"
  | "TIMEOUT"
  | "FINALIZED"
  | "FAILED";

/**
 * Explicitly distinguishes simulated/mock outputs from verified live HSP MCP evidence.
 */
export type HspPaymentEvidenceKind = "MOCK_SIMULATION" | "LIVE_HSP_MCP";

export interface HspDiscoveredToolDescriptor {
  /** Logical capability role within the orchestrator (not a hardcoded live tool name). */
  capability: "prepare" | "submit" | "status" | "unknown";
  /** Tool identifier reported dynamically by the MCP provider during discovery. */
  toolName: string;
  /** Opaque schema reported by the provider at discovery time (never fabricated ahead of time). */
  rawSchema?: unknown;
}

export interface HspPaymentToolDiscoveryResult {
  providerKind: "mock" | "live_unconfigured";
  evidenceKind: HspPaymentEvidenceKind;
  /** True only after live MCP tool discovery has completed against an allowlisted endpoint. */
  schemaDiscovered: boolean;
  discoveredAt: number;
  tools: HspDiscoveredToolDescriptor[];
  note?: string;
}

export interface HspCreatePaymentInput {
  idempotencyKey: string;
  merchant: string;
  payer: string;
  recipient: string;
  token: string;
  /** Human-readable or canonical decimal string (e.g. "25.00"); never floating-point math. */
  amount: string;
  memo?: string;
}

export interface HspPaymentPreparationInput {
  paymentId: string;
  idempotencyKey: string;
  merchant: string;
  payer: string;
  recipient: string;
  token: string;
  amount: string;
  memo?: string;
}

export interface HspPaymentPreparationOutcome {
  ok: boolean;
  evidenceKind: HspPaymentEvidenceKind;
  preparationId?: string;
  /** Unix timestamp (seconds) after which this preparation must not be authorized or submitted. */
  expiresAt?: number;
  /** Merchant identifier echoed by the provider for attribution verification. */
  attributedMerchant?: string;
  /** Optional opaque provider payload returned by discovery-bound MCP tools. */
  rawProviderPayload?: unknown;
  failureCode?:
    | "INSUFFICIENT_BALANCE"
    | "PREPARATION_REJECTED"
    | "PROVIDER_UNAVAILABLE"
    | "UNCONFIGURED_LIVE_PROVIDER";
  failureReason?: string;
}

export interface HspWalletAuthorizationRequest {
  paymentId: string;
  preparationId: string;
  merchant: string;
  payer: string;
  recipient: string;
  token: string;
  amount: string;
  expiresAt: number;
  /** Must be explicitly true — orchestrator rejects implicit or missing user consent. */
  explicitUserConsent: boolean;
  authorizedBy: string;
}

export interface HspWalletAuthorizationOutcome {
  approved: boolean;
  /** Opaque non-secret authorization reference (never raw private keys or signing secrets). */
  authorizationRef?: string;
  authorizedAt?: number;
  rejectionCode?: "USER_REJECTED" | "MISSING_EXPLICIT_CONSENT" | "AUTHORIZER_UNAVAILABLE";
  rejectionReason?: string;
}

export interface HspPaymentSubmissionInput {
  paymentId: string;
  idempotencyKey: string;
  preparationId: string;
  authorizationRef: string;
  merchant: string;
  payer: string;
  recipient: string;
  token: string;
  amount: string;
}

export interface HspPaymentSubmissionOutcome {
  /** Provider accepted or reached an indeterminate transport outcome. */
  outcome: "SUBMITTED" | "PROCESSING" | "SAFE" | "FINALIZED" | "TIMEOUT" | "FAILED";
  evidenceKind: HspPaymentEvidenceKind;
  submissionRef?: string;
  txReference?: string;
  attributedMerchant?: string;
  providerStatusRaw?: string;
  rawProviderPayload?: unknown;
  failureCode?: string;
  failureReason?: string;
}

export interface HspPaymentStatusQueryInput {
  paymentId: string;
  idempotencyKey: string;
  submissionRef?: string;
  txReference?: string;
}

export interface HspPaymentStatusQueryOutcome {
  evidenceKind: HspPaymentEvidenceKind;
  /** Raw status string reported by provider; validated by orchestrator before any transition. */
  providerStatusRaw: string;
  txReference?: string;
  attributedMerchant?: string;
  rawProviderPayload?: unknown;
  failureCode?: string;
  failureReason?: string;
}

/**
 * Interface 1–3 & 5–6: MCP Transport / Provider, Tool Discovery, Preparation, Submission, Status Queries.
 */
export interface HspMcpTransportProvider {
  readonly providerKind: "mock" | "live_unconfigured";
  readonly evidenceKind: HspPaymentEvidenceKind;
  readonly schemaDiscovered: boolean;
  discoverPaymentTools(): Promise<HspPaymentToolDiscoveryResult>;
  preparePayment(input: HspPaymentPreparationInput): Promise<HspPaymentPreparationOutcome>;
  submitAuthorizedPayment(input: HspPaymentSubmissionInput): Promise<HspPaymentSubmissionOutcome>;
  queryPaymentStatus(input: HspPaymentStatusQueryInput): Promise<HspPaymentStatusQueryOutcome>;
}

/**
 * Interface 4: Wallet Authorization Provider (isolated from signing secrets).
 */
export interface HspWalletAuthorizationProvider {
  requestAuthorization(
    request: HspWalletAuthorizationRequest,
  ): Promise<HspWalletAuthorizationOutcome>;
}

export interface HspPaymentAuditEntry {
  timestamp: number;
  fromState: HspPaymentLifecycleState | null;
  toState: HspPaymentLifecycleState;
  event: string;
  detail?: string;
  evidenceKind: HspPaymentEvidenceKind;
}

export interface HspPaymentAuthorizationSummary {
  explicitUserConsent: true;
  authorizedBy: string;
  authorizationRef: string;
  authorizedAt: number;
}

export interface HspPaymentRecord {
  paymentId: string;
  idempotencyKey: string;
  state: HspPaymentLifecycleState;
  evidenceKind: HspPaymentEvidenceKind;
  isMockEvidence: boolean;
  merchant: string;
  payer: string;
  recipient: string;
  token: string;
  amount: string;
  memo?: string;
  preparationId?: string;
  preparationExpiresAt?: number;
  authorization?: HspPaymentAuthorizationSummary;
  submissionRef?: string;
  txReference?: string;
  providerStatusRaw?: string;
  submissionAttempts: number;
  failureCode?: string;
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
  history: HspPaymentAuditEntry[];
}

export interface HspOrchestratorStatusSummary {
  providerKind: "mock" | "live_unconfigured";
  evidenceKind: HspPaymentEvidenceKind;
  isMockEvidence: boolean;
  schemaDiscovered: boolean;
  liveMcpConnected: false;
  totalPayments: number;
  inProgressCount: number;
  countsByState: Record<HspPaymentLifecycleState, number>;
  stateCorrupted: boolean;
}
