import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Address, Hex } from "viem";
import type { DataProvenance } from "../evaluation.js";

export type ProtocolAutonomousReadOp =
  | "DISCOVER_OFFERS"
  | "GET_OFFER"
  | "QUOTE_RESERVATION"
  | "SIMULATE_RESERVATION"
  | "INSPECT_TICKETS"
  | "QUOTE_EXERCISE"
  | "COMPARE_VENUES"
  | "EVALUATE_PORTFOLIO";

export type ProtocolApprovalRequiredOp =
  | "RESERVE_INVENTORY"
  | "EXERCISE_TICKET"
  | "RECLAIM_EXPIRED_TICKET";

export type ProtocolForbiddenOp =
  | "LP_DEPOSIT"
  | "LP_WITHDRAW"
  | "LP_CREATE_OFFER"
  | "LP_CANCEL_OFFER"
  | "ADMIN_UPDATE";

export type ProtocolProposalStatus =
  | "PROPOSED"
  | "APPROVED"
  | "REJECTED"
  | "SUBMITTED"
  | "CONFIRMED"
  | "FAILED"
  | "EXPIRED";

export interface ProtocolProposalParameters {
  action: ProtocolApprovalRequiredOp;
  wallet: Address;
  chainId: number;
  contractAddress: Address;
  token: Address;
  amount: bigint;
  /** Maximum payment or gross premium authorized (spending cap binding). */
  maxPaymentOrPremium: bigint;
  offerId?: bigint;
  ticketId?: bigint;
  durationSec?: number;
  /** Optional on-chain ticket expiry timestamp (seconds) for contract-semantic validation. */
  ticketExpiresAtSec?: number;
  recipient: Address;
}

export interface ProtocolActionProposal {
  proposalId: string;
  idempotencyKey: string;
  dataProvenance: DataProvenance;
  status: ProtocolProposalStatus;
  parameters: ProtocolProposalParameters;
  /** SHA-256 digest binding exact action, wallet, chain, contract, token, amount, maxPayment, recipient, and expiry. */
  bindingHash: string;
  rationale: string;
  venueEvidenceSummary?: string;
  createdAt: number;
  expiresAt: number;
  approvedAt?: number;
  approvedBy?: string;
  rejectedAt?: number;
  rejectionReason?: string;
  submittedAt?: number;
  txHash?: Hex;
  confirmedAt?: number;
  confirmedBlockNumber?: bigint;
  resultingTicketId?: bigint;
  failureReason?: string;
  history: Array<{
    timestamp: number;
    status: ProtocolProposalStatus;
    detail: string;
  }>;
}

export interface ProtocolPermissionPolicy {
  /** Maximum payment/premium allowed per individual approval-gated action. */
  maxSingleActionPayment: bigint;
  /** Maximum cumulative approved payment/premium per UTC day. */
  maxDailyApprovedPayment: bigint;
  /** Default proposal expiry TTL in seconds (default 300s). */
  defaultProposalTtlSec: number;
  /** Strictly false — autonomous mainnet signing is disabled until scoped session-key audit. */
  autonomousMainnetSigningEnabled: false;
  /** Explicitly documents delegated signing status. */
  delegatedSigningStatus: "DEFERRED_AWAITING_SCOPED_SESSION_KEY_AUDIT";
}

export class ProtocolPermissionError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProtocolPermissionError";
    this.code = code;
  }
}

export const ALLOWED_TRADING_AGENT_WRITE_OPS: ReadonlySet<ProtocolApprovalRequiredOp> =
  new Set<ProtocolApprovalRequiredOp>([
    "RESERVE_INVENTORY",
    "EXERCISE_TICKET",
    "RECLAIM_EXPIRED_TICKET",
  ]);

export const FORBIDDEN_TRADING_AGENT_OPS: ReadonlySet<string> = new Set<ProtocolForbiddenOp>([
  "LP_DEPOSIT",
  "LP_WITHDRAW",
  "LP_CREATE_OFFER",
  "LP_CANCEL_OFFER",
  "ADMIN_UPDATE",
]);

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Strict allowlist enforcement: ONLY RESERVE_INVENTORY, EXERCISE_TICKET, and
 * RECLAIM_EXPIRED_TICKET are permitted trading-agent write operations.
 * Every LP, admin, case-variant, malformed, or unknown operation fails closed.
 */
export function assertOperationAllowedForTradingAgent(op: unknown): asserts op is ProtocolApprovalRequiredOp {
  if (typeof op !== "string" || !ALLOWED_TRADING_AGENT_WRITE_OPS.has(op as ProtocolApprovalRequiredOp)) {
    throw new ProtocolPermissionError(
      "PERMISSION_DENIED_OUT_OF_SCOPE",
      `Operation "${String(op)}" is not in the trading-agent write allowlist (RESERVE_INVENTORY, EXERCISE_TICKET, RECLAIM_EXPIRED_TICKET)`,
    );
  }
}

/**
 * Validates action-specific parameters against actual CommitmentManager contract semantics.
 */
export function validateProposalParameters(
  params: ProtocolProposalParameters,
  nowSec: number,
): void {
  if (!params || typeof params !== "object") {
    throw new ProtocolPermissionError("INVALID_ACTION_PARAMETERS", "Proposal parameters object is required");
  }
  assertOperationAllowedForTradingAgent(params.action);

  if (!Number.isInteger(params.chainId) || params.chainId <= 0) {
    throw new ProtocolPermissionError("INVALID_ACTION_PARAMETERS", `Invalid chainId: ${String(params.chainId)}`);
  }
  for (const [field, addr, allowZero] of [
    ["wallet", params.wallet, false],
    ["contractAddress", params.contractAddress, false],
    ["token", params.token, true],
    ["recipient", params.recipient, false],
  ] as const) {
    if (typeof addr !== "string" || !EVM_ADDRESS_RE.test(addr)) {
      throw new ProtocolPermissionError("INVALID_ACTION_PARAMETERS", `Invalid EVM address for ${field}`);
    }
    if (!allowZero && addr.toLowerCase() === ZERO_ADDRESS) {
      throw new ProtocolPermissionError("INVALID_ACTION_PARAMETERS", `Zero address not allowed for ${field}`);
    }
  }
  if (typeof params.amount !== "bigint" || params.amount < 0n) {
    throw new ProtocolPermissionError("INVALID_ACTION_PARAMETERS", "amount must be a non-negative bigint");
  }
  if (typeof params.maxPaymentOrPremium !== "bigint" || params.maxPaymentOrPremium < 0n) {
    throw new ProtocolPermissionError(
      "INVALID_ACTION_PARAMETERS",
      "maxPaymentOrPremium must be a non-negative bigint",
    );
  }

  if (params.action === "RESERVE_INVENTORY") {
    if (params.offerId === undefined || typeof params.offerId !== "bigint" || params.offerId < 0n) {
      throw new ProtocolPermissionError(
        "INVALID_ACTION_PARAMETERS",
        "RESERVE_INVENTORY requires a valid non-negative offerId",
      );
    }
    if (params.amount <= 0n) {
      throw new ProtocolPermissionError(
        "INVALID_ACTION_PARAMETERS",
        "RESERVE_INVENTORY requires amount > 0",
      );
    }
    if (
      params.durationSec === undefined ||
      !Number.isInteger(params.durationSec) ||
      params.durationSec <= 0
    ) {
      throw new ProtocolPermissionError(
        "INVALID_ACTION_PARAMETERS",
        "RESERVE_INVENTORY requires a positive integer durationSec",
      );
    }
    if (params.ticketId !== undefined) {
      throw new ProtocolPermissionError(
        "INVALID_ACTION_PARAMETERS",
        "RESERVE_INVENTORY must not specify ticketId",
      );
    }
  } else if (params.action === "EXERCISE_TICKET") {
    if (params.ticketId === undefined || typeof params.ticketId !== "bigint" || params.ticketId < 0n) {
      throw new ProtocolPermissionError(
        "INVALID_ACTION_PARAMETERS",
        "EXERCISE_TICKET requires a valid non-negative ticketId",
      );
    }
    if (params.amount <= 0n) {
      throw new ProtocolPermissionError(
        "INVALID_ACTION_PARAMETERS",
        "EXERCISE_TICKET requires fill amount > 0",
      );
    }
    if (params.ticketExpiresAtSec !== undefined && nowSec >= params.ticketExpiresAtSec) {
      throw new ProtocolPermissionError(
        "TICKET_EXPIRED_CANNOT_EXERCISE",
        `Ticket ${params.ticketId} expired at ${params.ticketExpiresAtSec} and cannot be exercised`,
      );
    }
  } else if (params.action === "RECLAIM_EXPIRED_TICKET") {
    if (params.ticketId === undefined || typeof params.ticketId !== "bigint" || params.ticketId < 0n) {
      throw new ProtocolPermissionError(
        "INVALID_ACTION_PARAMETERS",
        "RECLAIM_EXPIRED_TICKET requires a valid non-negative ticketId",
      );
    }
    if (params.ticketExpiresAtSec !== undefined && nowSec < params.ticketExpiresAtSec) {
      throw new ProtocolPermissionError(
        "TICKET_NOT_EXPIRED_CANNOT_RECLAIM",
        `Ticket ${params.ticketId} is still active until ${params.ticketExpiresAtSec} and cannot be reclaimed early`,
      );
    }
  }
}

export function computeProposalBindingHash(
  params: ProtocolProposalParameters,
  expiresAt: number,
): string {
  const canonical = JSON.stringify({
    action: params.action,
    wallet: params.wallet.toLowerCase(),
    chainId: params.chainId,
    contractAddress: params.contractAddress.toLowerCase(),
    token: params.token.toLowerCase(),
    amount: params.amount.toString(),
    maxPaymentOrPremium: params.maxPaymentOrPremium.toString(),
    offerId: params.offerId?.toString() ?? null,
    ticketId: params.ticketId?.toString() ?? null,
    durationSec: params.durationSec ?? null,
    ticketExpiresAtSec: params.ticketExpiresAtSec ?? null,
    recipient: params.recipient.toLowerCase(),
    expiresAt,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function serializeBigInt(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { __bigint: value.toString() } : value;
}

function deserializeBigInt(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    "__bigint" in value &&
    typeof (value as { __bigint: unknown }).__bigint === "string"
  ) {
    return BigInt((value as { __bigint: string }).__bigint);
  }
  return value;
}

interface PersistedApprovalFile {
  version: 1;
  updatedAt: number;
  proposals: ProtocolActionProposal[];
  submittedKeys: string[];
  dailyApprovedDateUtc: string;
  dailyApprovedPayment: bigint;
}

function utcDateKey(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

/**
 * Persistent, tamper-evident approval & permission manager for protocol-native actions.
 *
 * Guarantees:
 * - Parameter-bound approvals (SHA-256 digest over exact action, wallet, chain, contract, token, amount, expiry)
 * - Spending caps (per-action and daily)
 * - Expiry & replay prevention across restarts
 * - Global kill-switch and pending-tx protection
 * - Zero unrestricted private-key handling
 */
export class ProtocolApprovalManager {
  private readonly policy: ProtocolPermissionPolicy;
  private readonly filePath?: string;
  private readonly nowSec: () => number;
  private readonly proposals = new Map<string, ProtocolActionProposal>();
  private readonly idByIdempotencyKey = new Map<string, string>();
  private readonly submittedKeys = new Set<string>();
  private dailyDateUtc: string;
  private dailyApprovedPayment = 0n;
  private stateCorrupted = false;

  constructor(config: {
    policy: ProtocolPermissionPolicy;
    filePath?: string;
    nowSec?: () => number;
  }) {
    this.policy = config.policy;
    this.filePath = config.filePath;
    this.nowSec = config.nowSec ?? (() => Math.floor(Date.now() / 1000));
    this.dailyDateUtc = utcDateKey(this.nowSec());
    if (this.filePath && fs.existsSync(this.filePath)) {
      this.load();
    }
  }

  getPolicy(): ProtocolPermissionPolicy {
    return { ...this.policy };
  }

  isStateCorrupted(): boolean {
    return this.stateCorrupted;
  }

  listProposals(): ProtocolActionProposal[] {
    return Array.from(this.proposals.values())
      .map((p) => this.clone(p))
      .sort((a, b) => b.createdAt - a.createdAt || b.proposalId.localeCompare(a.proposalId));
  }

  getProposal(proposalId: string): ProtocolActionProposal | null {
    const p = this.proposals.get(proposalId);
    return p ? this.clone(p) : null;
  }

  hasPendingSubmittedProposal(): boolean {
    for (const p of this.proposals.values()) {
      if (p.status === "SUBMITTED") return true;
    }
    return false;
  }

  createProposal(input: {
    idempotencyKey: string;
    dataProvenance: DataProvenance;
    parameters: ProtocolProposalParameters;
    rationale: string;
    venueEvidenceSummary?: string;
    ttlSec?: number;
    killSwitchActive?: boolean;
  }): ProtocolActionProposal {
    const now = this.nowSec();
    assertOperationAllowedForTradingAgent(input.parameters?.action);
    validateProposalParameters(input.parameters, now);
    if (input.killSwitchActive) {
      throw new ProtocolPermissionError(
        "KILL_SWITCH_ACTIVE",
        "Global kill switch is active; new protocol action proposals are blocked",
      );
    }

    const key = input.idempotencyKey.trim();
    if (!key) {
      throw new ProtocolPermissionError("INVALID_IDEMPOTENCY_KEY", "idempotencyKey is required");
    }

    const existingId = this.idByIdempotencyKey.get(key);
    if (existingId) {
      const existing = this.proposals.get(existingId)!;
      const expectedHash = computeProposalBindingHash(input.parameters, existing.expiresAt);
      if (existing.bindingHash !== expectedHash) {
        throw new ProtocolPermissionError(
          "IDEMPOTENCY_CONFLICT",
          `Idempotency key ${key} already exists with different parameters`,
        );
      }
      return this.clone(existing);
    }

    if (input.parameters.maxPaymentOrPremium > this.policy.maxSingleActionPayment) {
      throw new ProtocolPermissionError(
        "SPENDING_LIMIT_EXCEEDED",
        `maxPaymentOrPremium (${input.parameters.maxPaymentOrPremium}) exceeds per-action limit (${this.policy.maxSingleActionPayment})`,
      );
    }

    const expiresAt = now + (input.ttlSec ?? this.policy.defaultProposalTtlSec);
    const bindingHash = computeProposalBindingHash(input.parameters, expiresAt);

    const proposal: ProtocolActionProposal = {
      proposalId: `prop_${randomUUID()}`,
      idempotencyKey: key,
      dataProvenance: input.dataProvenance,
      status: "PROPOSED",
      parameters: { ...input.parameters },
      bindingHash,
      rationale: input.rationale,
      venueEvidenceSummary: input.venueEvidenceSummary,
      createdAt: now,
      expiresAt,
      history: [{ timestamp: now, status: "PROPOSED", detail: input.rationale }],
    };

    this.proposals.set(proposal.proposalId, proposal);
    this.idByIdempotencyKey.set(key, proposal.proposalId);
    this.persist();
    return this.clone(proposal);
  }

  approveProposal(input: {
    proposalId: string;
    approvedBy: string;
    expectedBindingHash?: string;
    killSwitchActive?: boolean;
  }): ProtocolActionProposal {
    if (input.killSwitchActive) {
      throw new ProtocolPermissionError(
        "KILL_SWITCH_ACTIVE",
        "Global kill switch is active; approvals are blocked",
      );
    }
    const p = this.requireProposal(input.proposalId);
    if (p.status !== "PROPOSED") {
      throw new ProtocolPermissionError(
        "INVALID_PROPOSAL_STATE",
        `Cannot approve proposal in state ${p.status}`,
      );
    }

    const now = this.nowSec();
    // Independently re-validate allowlisted action, contract semantics, and canonical binding at approval time
    assertOperationAllowedForTradingAgent(p.parameters?.action);
    validateProposalParameters(p.parameters, now);
    const canonicalHash = computeProposalBindingHash(p.parameters, p.expiresAt);
    if (canonicalHash !== p.bindingHash) {
      throw new ProtocolPermissionError(
        "APPROVAL_PARAMETER_MISMATCH",
        "Stored proposal parameters were modified and no longer match canonical binding hash",
      );
    }

    if (now >= p.expiresAt) {
      p.status = "EXPIRED";
      p.history.push({ timestamp: now, status: "EXPIRED", detail: "Proposal expired before approval" });
      this.persist();
      throw new ProtocolPermissionError("APPROVAL_EXPIRED", `Proposal ${p.proposalId} has expired`);
    }

    if (input.expectedBindingHash && input.expectedBindingHash !== p.bindingHash) {
      throw new ProtocolPermissionError(
        "APPROVAL_PARAMETER_MISMATCH",
        "Binding hash mismatch — proposal parameters do not match approved payload",
      );
    }

    this.rollDailyIfNeeded(now);
    if (this.dailyApprovedPayment + p.parameters.maxPaymentOrPremium > this.policy.maxDailyApprovedPayment) {
      throw new ProtocolPermissionError(
        "DAILY_SPENDING_LIMIT_EXCEEDED",
        `Approving ${p.parameters.maxPaymentOrPremium} exceeds daily limit ${this.policy.maxDailyApprovedPayment}`,
      );
    }

    p.status = "APPROVED";
    p.approvedAt = now;
    p.approvedBy = input.approvedBy.trim() || "wallet-user";
    p.history.push({
      timestamp: now,
      status: "APPROVED",
      detail: `Explicitly approved by ${p.approvedBy} (binding=${p.bindingHash.slice(0, 12)}…)`,
    });
    this.dailyApprovedPayment += p.parameters.maxPaymentOrPremium;
    this.persist();
    return this.clone(p);
  }

  rejectProposal(proposalId: string, reason: string): ProtocolActionProposal {
    const p = this.requireProposal(proposalId);
    if (p.status !== "PROPOSED" && p.status !== "APPROVED") {
      throw new ProtocolPermissionError(
        "INVALID_PROPOSAL_STATE",
        `Cannot reject proposal in state ${p.status}`,
      );
    }
    const now = this.nowSec();
    p.status = "REJECTED";
    p.rejectedAt = now;
    p.rejectionReason = reason;
    p.history.push({ timestamp: now, status: "REJECTED", detail: reason });
    this.persist();
    return this.clone(p);
  }

  /**
   * Validates that an APPROVED proposal is still unexpired, unmodified, non-replayed,
   * and unblocked before recording an on-chain submission txHash.
   */
  recordSubmission(input: {
    proposalId: string;
    txHash: Hex;
    submittedParameters?: ProtocolProposalParameters;
    killSwitchActive?: boolean;
    readOnlyMode?: boolean;
    externalPendingTxCount?: number;
  }): ProtocolActionProposal {
    if (input.killSwitchActive) {
      throw new ProtocolPermissionError("KILL_SWITCH_ACTIVE", "Kill switch blocks transaction submission");
    }
    if (input.readOnlyMode) {
      throw new ProtocolPermissionError("READ_ONLY_MODE_BLOCKED", "Submission blocked in read-only mode");
    }
    if ((input.externalPendingTxCount ?? 0) > 0 || this.hasPendingSubmittedProposal()) {
      throw new ProtocolPermissionError(
        "PENDING_TX_BLOCKING",
        "Reconcile existing pending transactions before submitting another action",
      );
    }

    const p = this.requireProposal(input.proposalId);
    if (this.submittedKeys.has(p.idempotencyKey) || p.status === "SUBMITTED" || p.status === "CONFIRMED") {
      throw new ProtocolPermissionError(
        "REPLAY_OR_DUPLICATE_BLOCKED",
        `Proposal ${p.proposalId} (key=${p.idempotencyKey}) has already been submitted`,
      );
    }
    if (p.status !== "APPROVED") {
      throw new ProtocolPermissionError(
        "EXPLICIT_APPROVAL_REQUIRED",
        `Proposal ${p.proposalId} must be APPROVED before submission (current=${p.status})`,
      );
    }

    const now = this.nowSec();
    // Independently re-validate stored proposal action, contract semantics, and binding hash at submission time
    assertOperationAllowedForTradingAgent(p.parameters?.action);
    validateProposalParameters(p.parameters, now);
    const storedCanonicalHash = computeProposalBindingHash(p.parameters, p.expiresAt);
    if (storedCanonicalHash !== p.bindingHash) {
      throw new ProtocolPermissionError(
        "APPROVAL_PARAMETER_MISMATCH",
        "Approved proposal parameters were tampered with prior to submission",
      );
    }

    if (now >= p.expiresAt) {
      p.status = "EXPIRED";
      p.history.push({ timestamp: now, status: "EXPIRED", detail: "Approval expired before submission" });
      this.persist();
      throw new ProtocolPermissionError("APPROVAL_EXPIRED", `Approval ${p.proposalId} expired before submission`);
    }

    if (input.submittedParameters) {
      assertOperationAllowedForTradingAgent(input.submittedParameters?.action);
      validateProposalParameters(input.submittedParameters, now);
      const checkHash = computeProposalBindingHash(input.submittedParameters, p.expiresAt);
      if (checkHash !== p.bindingHash) {
        throw new ProtocolPermissionError(
          "APPROVAL_PARAMETER_MISMATCH",
          "Submitted transaction parameters do not match the approved binding hash",
        );
      }
    }

    p.status = "SUBMITTED";
    p.submittedAt = now;
    p.txHash = input.txHash;
    p.history.push({
      timestamp: now,
      status: "SUBMITTED",
      detail: `Submitted user-signed transaction ${input.txHash}; awaiting receipt & state verification`,
    });
    this.submittedKeys.add(p.idempotencyKey);
    this.persist();
    return this.clone(p);
  }

  recordConfirmation(input: {
    proposalId: string;
    confirmed: boolean;
    blockNumber?: bigint;
    resultingTicketId?: bigint;
    detail: string;
  }): ProtocolActionProposal {
    const p = this.requireProposal(input.proposalId);
    if (p.status !== "SUBMITTED") {
      throw new ProtocolPermissionError(
        "INVALID_PROPOSAL_STATE",
        `Can only confirm/fail a SUBMITTED proposal (current=${p.status})`,
      );
    }
    const now = this.nowSec();
    if (input.confirmed) {
      p.status = "CONFIRMED";
      p.confirmedAt = now;
      p.confirmedBlockNumber = input.blockNumber;
      p.resultingTicketId = input.resultingTicketId;
      p.history.push({ timestamp: now, status: "CONFIRMED", detail: input.detail });
    } else {
      p.status = "FAILED";
      p.failureReason = input.detail;
      p.history.push({ timestamp: now, status: "FAILED", detail: input.detail });
    }
    this.persist();
    return this.clone(p);
  }

  private requireProposal(proposalId: string): ProtocolActionProposal {
    const p = this.proposals.get(proposalId);
    if (!p) {
      throw new ProtocolPermissionError("PROPOSAL_NOT_FOUND", `Proposal ${proposalId} not found`);
    }
    return p;
  }

  private rollDailyIfNeeded(now: number): void {
    const k = utcDateKey(now);
    if (k !== this.dailyDateUtc) {
      this.dailyDateUtc = k;
      this.dailyApprovedPayment = 0n;
    }
  }

  private clone(p: ProtocolActionProposal): ProtocolActionProposal {
    return {
      ...p,
      parameters: { ...p.parameters },
      history: p.history.map((h) => ({ ...h })),
    };
  }

  private persist(): void {
    if (!this.filePath || this.stateCorrupted) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: PersistedApprovalFile = {
      version: 1,
      updatedAt: this.nowSec(),
      proposals: Array.from(this.proposals.values()),
      submittedKeys: Array.from(this.submittedKeys),
      dailyApprovedDateUtc: this.dailyDateUtc,
      dailyApprovedPayment: this.dailyApprovedPayment,
    };
    const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, serializeBigInt, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }

  private load(): void {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf8"),
        deserializeBigInt,
      ) as Partial<PersistedApprovalFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.proposals)) {
        this.stateCorrupted = true;
        return;
      }
      for (const p of parsed.proposals) {
        this.proposals.set(p.proposalId, p);
        this.idByIdempotencyKey.set(p.idempotencyKey, p.proposalId);
      }
      for (const k of parsed.submittedKeys ?? []) {
        this.submittedKeys.add(k);
      }
      if (parsed.dailyApprovedDateUtc) this.dailyDateUtc = parsed.dailyApprovedDateUtc;
      if (typeof parsed.dailyApprovedPayment === "bigint") {
        this.dailyApprovedPayment = parsed.dailyApprovedPayment;
      }
    } catch {
      this.stateCorrupted = true;
    }
  }
}
