import { randomUUID } from "node:crypto";
import {
  ALL_PAYMENT_STATES,
  assertValidTransition,
  isInProgressPostSubmissionState,
  isTerminalPaymentState,
  mapProviderStatusToLifecycleState,
} from "./state-machine.js";
import type { HspPaymentStore } from "./store.js";
import type {
  HspCreatePaymentInput,
  HspMcpTransportProvider,
  HspOrchestratorStatusSummary,
  HspPaymentLifecycleState,
  HspPaymentRecord,
  HspPaymentToolDiscoveryResult,
  HspWalletAuthorizationProvider,
} from "./types.js";

export class HspPaymentError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HspPaymentError";
    this.code = code;
  }
}

export interface HspPaymentOrchestratorConfig {
  store: HspPaymentStore;
  mcpProvider: HspMcpTransportProvider;
  walletAuthorizer: HspWalletAuthorizationProvider;
  nowSec?: () => number;
}

export interface AuthorizePaymentInput {
  explicitUserConsent: boolean;
  authorizedBy: string;
}

function normalizeText(value: string): string {
  return value.trim();
}

function merchantsMatch(expected: string, actual?: string): boolean {
  if (!actual) return true;
  return expected.trim().toLowerCase() === actual.trim().toLowerCase();
}

/**
 * Isolated HSP Payment Orchestrator.
 *
 * Completely decoupled from Tranche trading execution adapters and AgentRuntime.
 * Enforces:
 * - Strict 9-state lifecycle transitions
 * - Idempotent payment creation and duplicate-submission prevention
 * - Explicit user authorization prior to signing/submission
 * - Merchant attribution verification
 * - Non-duplicating TIMEOUT reconciliation and post-restart recovery
 * - Explicit distinction between MOCK_SIMULATION and LIVE_HSP_MCP evidence
 */
export class HspPaymentOrchestrator {
  private readonly store: HspPaymentStore;
  private readonly mcpProvider: HspMcpTransportProvider;
  private readonly walletAuthorizer: HspWalletAuthorizationProvider;
  private readonly nowSec: () => number;
  private readonly inFlightSubmissionIds = new Set<string>();

  constructor(config: HspPaymentOrchestratorConfig) {
    this.store = config.store;
    this.mcpProvider = config.mcpProvider;
    this.walletAuthorizer = config.walletAuthorizer;
    this.nowSec = config.nowSec ?? (() => Math.floor(Date.now() / 1000));
  }

  async discoverTools(): Promise<HspPaymentToolDiscoveryResult> {
    return this.mcpProvider.discoverPaymentTools();
  }

  getStatusSummary(): HspOrchestratorStatusSummary {
    const all = this.store.listAll();
    const countsByState = {} as Record<HspPaymentLifecycleState, number>;
    for (const s of ALL_PAYMENT_STATES) countsByState[s] = 0;

    let inProgressCount = 0;
    for (const p of all) {
      countsByState[p.state] += 1;
      if (isInProgressPostSubmissionState(p.state)) inProgressCount += 1;
    }

    return {
      providerKind: this.mcpProvider.providerKind,
      evidenceKind: this.mcpProvider.evidenceKind,
      isMockEvidence: this.mcpProvider.evidenceKind === "MOCK_SIMULATION",
      schemaDiscovered: this.mcpProvider.schemaDiscovered,
      liveMcpConnected: false,
      totalPayments: all.length,
      inProgressCount,
      countsByState,
      stateCorrupted: this.store.isStateCorrupted(),
    };
  }

  getPayment(paymentId: string): HspPaymentRecord | null {
    return this.store.getById(paymentId);
  }

  listPayments(): HspPaymentRecord[] {
    return this.store.listAll();
  }

  createPayment(input: HspCreatePaymentInput): HspPaymentRecord {
    const idempotencyKey = normalizeText(input.idempotencyKey);
    const merchant = normalizeText(input.merchant);
    const payer = normalizeText(input.payer);
    const recipient = normalizeText(input.recipient);
    const token = normalizeText(input.token);
    const amount = normalizeText(input.amount);
    const memo = input.memo ? normalizeText(input.memo) : undefined;

    if (!idempotencyKey || !merchant || !payer || !recipient || !token || !amount) {
      throw new HspPaymentError(
        "INVALID_PAYMENT_INPUT",
        "idempotencyKey, merchant, payer, recipient, token, and amount are required",
      );
    }
    if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
      throw new HspPaymentError("INVALID_AMOUNT", "amount must be a positive decimal string");
    }

    const existing = this.store.getByIdempotencyKey(idempotencyKey);
    if (existing) {
      const sameIntent =
        existing.merchant === merchant &&
        existing.payer === payer &&
        existing.recipient === recipient &&
        existing.token === token &&
        existing.amount === amount;
      if (!sameIntent) {
        throw new HspPaymentError(
          "IDEMPOTENCY_KEY_CONFLICT",
          `Idempotency key ${idempotencyKey} is already bound to a different payment intent`,
        );
      }
      return existing;
    }

    const now = this.nowSec();
    const record: HspPaymentRecord = {
      paymentId: `hsp_pay_${randomUUID()}`,
      idempotencyKey,
      state: "CREATED",
      evidenceKind: this.mcpProvider.evidenceKind,
      isMockEvidence: this.mcpProvider.evidenceKind === "MOCK_SIMULATION",
      merchant,
      payer,
      recipient,
      token,
      amount,
      memo,
      submissionAttempts: 0,
      createdAt: now,
      updatedAt: now,
      history: [
        {
          timestamp: now,
          fromState: null,
          toState: "CREATED",
          event: "PAYMENT_CREATED",
          detail: `Created payment intent for merchant ${merchant}`,
          evidenceKind: this.mcpProvider.evidenceKind,
        },
      ],
    };

    this.store.save(record);
    return this.store.getById(record.paymentId)!;
  }

  async preparePayment(paymentId: string): Promise<HspPaymentRecord> {
    const rec = this.requirePayment(paymentId);
    if (rec.state === "PREPARED") {
      return rec;
    }
    assertValidTransition(rec.state, "PREPARED");

    const outcome = await this.mcpProvider.preparePayment({
      paymentId: rec.paymentId,
      idempotencyKey: rec.idempotencyKey,
      merchant: rec.merchant,
      payer: rec.payer,
      recipient: rec.recipient,
      token: rec.token,
      amount: rec.amount,
      memo: rec.memo,
    });

    if (!outcome.ok) {
      return this.transitionToFailed(
        rec,
        outcome.failureCode ?? "PREPARATION_FAILED",
        outcome.failureReason ?? "Payment preparation failed",
        "PREPARATION_FAILED",
      );
    }

    if (!merchantsMatch(rec.merchant, outcome.attributedMerchant)) {
      return this.transitionToFailed(
        rec,
        "MERCHANT_ATTRIBUTION_MISMATCH",
        `Provider attributed merchant "${outcome.attributedMerchant}" instead of expected "${rec.merchant}"`,
        "MERCHANT_ATTRIBUTION_REJECTED",
      );
    }

    if (!outcome.preparationId || typeof outcome.expiresAt !== "number") {
      return this.transitionToFailed(
        rec,
        "MALFORMED_PREPARATION",
        "Provider returned preparation without preparationId or expiresAt",
        "PREPARATION_MALFORMED",
      );
    }

    const now = this.nowSec();
    const updated = this.applyTransition(rec, "PREPARED", "PAYMENT_PREPARED", {
      detail: `Prepared with id ${outcome.preparationId} (expires at ${outcome.expiresAt})`,
      now,
      patch: {
        preparationId: outcome.preparationId,
        preparationExpiresAt: outcome.expiresAt,
      },
    });
    return updated;
  }

  async authorizePayment(
    paymentId: string,
    input: AuthorizePaymentInput,
  ): Promise<HspPaymentRecord> {
    const rec = this.requirePayment(paymentId);
    if (rec.state === "AUTHORIZED") {
      return rec;
    }
    assertValidTransition(rec.state, "AUTHORIZED");

    if (!input.explicitUserConsent) {
      throw new HspPaymentError(
        "EXPLICIT_AUTHORIZATION_REQUIRED",
        "Explicit user consent (explicitUserConsent=true) is required before authorizing payment",
      );
    }

    const authorizedBy = normalizeText(input.authorizedBy);
    if (!authorizedBy) {
      throw new HspPaymentError("INVALID_AUTHORIZER", "authorizedBy is required");
    }

    if (!rec.preparationId || typeof rec.preparationExpiresAt !== "number") {
      throw new HspPaymentError(
        "MISSING_PREPARATION",
        "Payment must be prepared before wallet authorization",
      );
    }

    const now = this.nowSec();
    if (now >= rec.preparationExpiresAt) {
      return this.transitionToFailed(
        rec,
        "PREPARATION_EXPIRED",
        `Preparation ${rec.preparationId} expired at ${rec.preparationExpiresAt}`,
        "PREPARATION_EXPIRED",
      );
    }

    const authOutcome = await this.walletAuthorizer.requestAuthorization({
      paymentId: rec.paymentId,
      preparationId: rec.preparationId,
      merchant: rec.merchant,
      payer: rec.payer,
      recipient: rec.recipient,
      token: rec.token,
      amount: rec.amount,
      expiresAt: rec.preparationExpiresAt,
      explicitUserConsent: true,
      authorizedBy,
    });

    if (!authOutcome.approved || !authOutcome.authorizationRef) {
      return this.transitionToFailed(
        rec,
        authOutcome.rejectionCode ?? "AUTHORIZATION_REJECTED",
        authOutcome.rejectionReason ?? "Wallet authorization was rejected",
        "AUTHORIZATION_REJECTED",
      );
    }

    return this.applyTransition(rec, "AUTHORIZED", "PAYMENT_AUTHORIZED", {
      detail: `Explicitly authorized by ${authorizedBy} (ref ${authOutcome.authorizationRef})`,
      now: this.nowSec(),
      patch: {
        authorization: {
          explicitUserConsent: true,
          authorizedBy,
          authorizationRef: authOutcome.authorizationRef,
          authorizedAt: authOutcome.authorizedAt ?? this.nowSec(),
        },
      },
    });
  }

  async submitPayment(paymentId: string): Promise<HspPaymentRecord> {
    const rec = this.requirePayment(paymentId);

    // Strict duplicate-submission guard (including TIMEOUT — a timeout must NEVER re-submit)
    if (
      rec.submissionAttempts > 0 ||
      this.store.hasSubmissionBeenDispatched(rec.idempotencyKey) ||
      this.inFlightSubmissionIds.has(rec.paymentId) ||
      isInProgressPostSubmissionState(rec.state) ||
      rec.state === "FINALIZED"
    ) {
      throw new HspPaymentError(
        "DUPLICATE_SUBMISSION_BLOCKED",
        `Payment ${rec.paymentId} (state=${rec.state}) has already been submitted; duplicate submission is blocked`,
      );
    }

    if (rec.state !== "AUTHORIZED" || !rec.authorization?.explicitUserConsent) {
      throw new HspPaymentError(
        "EXPLICIT_AUTHORIZATION_REQUIRED",
        `Payment ${rec.paymentId} must be explicitly AUTHORIZED before submission (current state=${rec.state})`,
      );
    }

    if (!rec.preparationId || typeof rec.preparationExpiresAt !== "number") {
      throw new HspPaymentError("MISSING_PREPARATION", "Prepared payment details are missing");
    }

    if (this.nowSec() >= rec.preparationExpiresAt) {
      return this.transitionToFailed(
        rec,
        "PREPARATION_EXPIRED",
        `Preparation ${rec.preparationId} expired before submission`,
        "PREPARATION_EXPIRED",
      );
    }

    assertValidTransition(rec.state, "SUBMITTED");

    this.inFlightSubmissionIds.add(rec.paymentId);
    try {
      // Persist SUBMITTED BEFORE calling external provider so crash/restart can never double-submit
      const submittedRec = this.applyTransition(
        rec,
        "SUBMITTED",
        "PAYMENT_SUBMITTED",
        {
          detail: "Authorized payment dispatched to provider",
          now: this.nowSec(),
          patch: {
            submissionAttempts: rec.submissionAttempts + 1,
          },
        },
        true,
      );

      let outcome;
      try {
        outcome = await this.mcpProvider.submitAuthorizedPayment({
          paymentId: submittedRec.paymentId,
          idempotencyKey: submittedRec.idempotencyKey,
          preparationId: submittedRec.preparationId!,
          authorizationRef: submittedRec.authorization!.authorizationRef,
          merchant: submittedRec.merchant,
          payer: submittedRec.payer,
          recipient: submittedRec.recipient,
          token: submittedRec.token,
          amount: submittedRec.amount,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Transport error after dispatch -> TIMEOUT (indeterminate), NEVER reset to AUTHORIZED
        return this.applyTransition(submittedRec, "TIMEOUT", "SUBMISSION_TRANSPORT_TIMEOUT", {
          detail: `Submission transport interrupted: ${msg}`,
          now: this.nowSec(),
          patch: {
            failureCode: "SUBMISSION_TIMEOUT",
            failureReason: msg,
          },
        });
      }

      if (!merchantsMatch(submittedRec.merchant, outcome.attributedMerchant)) {
        return this.transitionToFailed(
          submittedRec,
          "MERCHANT_ATTRIBUTION_MISMATCH",
          `Submission response attributed merchant "${outcome.attributedMerchant}" instead of expected "${submittedRec.merchant}"`,
          "MERCHANT_ATTRIBUTION_REJECTED",
        );
      }

      const patch: Partial<HspPaymentRecord> = {
        submissionRef: outcome.submissionRef ?? submittedRec.submissionRef,
        txReference: outcome.txReference ?? submittedRec.txReference,
        providerStatusRaw: outcome.providerStatusRaw ?? outcome.outcome,
      };

      if (outcome.outcome === "SUBMITTED") {
        this.store.save({ ...submittedRec, ...patch, updatedAt: this.nowSec() }, true);
        return this.store.getById(submittedRec.paymentId)!;
      }

      if (outcome.outcome === "FAILED") {
        return this.transitionToFailed(
          { ...submittedRec, ...patch },
          outcome.failureCode ?? "SUBMISSION_FAILED",
          outcome.failureReason ?? "Provider rejected payment submission",
          "SUBMISSION_FAILED",
        );
      }

      if (outcome.outcome === "TIMEOUT") {
        return this.applyTransition(submittedRec, "TIMEOUT", "SUBMISSION_TIMEOUT", {
          detail: outcome.failureReason ?? "Provider submission timed out; awaiting status reconciliation",
          now: this.nowSec(),
          patch: {
            ...patch,
            failureCode: outcome.failureCode ?? "SUBMISSION_TIMEOUT",
            failureReason: outcome.failureReason ?? "Submission timed out",
          },
        });
      }

      return this.applyTransition(submittedRec, outcome.outcome, `PROVIDER_${outcome.outcome}`, {
        detail: `Provider reported ${outcome.outcome}`,
        now: this.nowSec(),
        patch,
      });
    } finally {
      this.inFlightSubmissionIds.delete(rec.paymentId);
    }
  }

  async refreshPaymentStatus(paymentId: string): Promise<HspPaymentRecord> {
    const rec = this.requirePayment(paymentId);
    if (isTerminalPaymentState(rec.state)) {
      return rec;
    }
    if (!isInProgressPostSubmissionState(rec.state)) {
      throw new HspPaymentError(
        "PAYMENT_NOT_SUBMITTED",
        `Cannot query settlement status before submission (state=${rec.state})`,
      );
    }

    const statusRes = await this.mcpProvider.queryPaymentStatus({
      paymentId: rec.paymentId,
      idempotencyKey: rec.idempotencyKey,
      submissionRef: rec.submissionRef,
      txReference: rec.txReference,
    });

    if (!merchantsMatch(rec.merchant, statusRes.attributedMerchant)) {
      return this.transitionToFailed(
        rec,
        "MERCHANT_ATTRIBUTION_MISMATCH",
        `Status query attributed merchant "${statusRes.attributedMerchant}" instead of expected "${rec.merchant}"`,
        "MERCHANT_ATTRIBUTION_REJECTED",
      );
    }

    const mapped = mapProviderStatusToLifecycleState(statusRes.providerStatusRaw);
    if (!mapped) {
      // Fail safe: record the unrecognized status in audit history without corrupting state or re-submitting
      const now = this.nowSec();
      const unchanged: HspPaymentRecord = {
        ...rec,
        providerStatusRaw: statusRes.providerStatusRaw,
        updatedAt: now,
        history: [
          ...rec.history,
          {
            timestamp: now,
            fromState: rec.state,
            toState: rec.state,
            event: "UNRECOGNIZED_PAYMENT_STATUS",
            detail: `Ignored unrecognized provider status "${statusRes.providerStatusRaw}"`,
            evidenceKind: statusRes.evidenceKind,
          },
        ],
      };
      this.store.save(unchanged);
      throw new HspPaymentError(
        "UNRECOGNIZED_PAYMENT_STATUS",
        `Provider returned unrecognized payment status "${statusRes.providerStatusRaw}"`,
      );
    }

    const patch: Partial<HspPaymentRecord> = {
      txReference: statusRes.txReference ?? rec.txReference,
      providerStatusRaw: statusRes.providerStatusRaw,
    };

    if (mapped === "FAILED") {
      return this.transitionToFailed(
        { ...rec, ...patch },
        statusRes.failureCode ?? "PROVIDER_FAILED",
        statusRes.failureReason ?? "Provider reported payment failure",
        "PROVIDER_FAILED",
      );
    }

    // Clear stale timeout failure markers once payment recovers forward
    if (rec.state === "TIMEOUT" && (mapped === "PROCESSING" || mapped === "SAFE" || mapped === "FINALIZED")) {
      patch.failureCode = undefined;
      patch.failureReason = undefined;
    }

    return this.applyTransition(rec, mapped, `STATUS_${mapped}`, {
      detail: `Provider status reconciled to ${mapped} (raw=${statusRes.providerStatusRaw})`,
      now: this.nowSec(),
      patch,
    });
  }

  /**
   * Reconciles all persisted post-submission in-progress payments after a process restart.
   * Strictly polls status — NEVER re-submits any payment.
   */
  async recoverInProgressPayments(): Promise<{
    checked: number;
    reconciled: HspPaymentRecord[];
    errors: Array<{ paymentId: string; code: string; message: string }>;
  }> {
    const candidates = this.store
      .listAll()
      .filter((p) => isInProgressPostSubmissionState(p.state));
    const reconciled: HspPaymentRecord[] = [];
    const errors: Array<{ paymentId: string; code: string; message: string }> = [];

    for (const p of candidates) {
      try {
        const updated = await this.refreshPaymentStatus(p.paymentId);
        reconciled.push(updated);
      } catch (err) {
        const code = err instanceof HspPaymentError ? err.code : "RECOVERY_ERROR";
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ paymentId: p.paymentId, code, message });
      }
    }

    return { checked: candidates.length, reconciled, errors };
  }

  private requirePayment(paymentId: string): HspPaymentRecord {
    const rec = this.store.getById(paymentId);
    if (!rec) {
      throw new HspPaymentError("PAYMENT_NOT_FOUND", `Payment ${paymentId} not found`);
    }
    return rec;
  }

  private transitionToFailed(
    rec: HspPaymentRecord,
    failureCode: string,
    failureReason: string,
    event: string,
  ): HspPaymentRecord {
    return this.applyTransition(rec, "FAILED", event, {
      detail: `${failureCode}: ${failureReason}`,
      now: this.nowSec(),
      patch: {
        failureCode,
        failureReason,
      },
    });
  }

  private applyTransition(
    rec: HspPaymentRecord,
    toState: HspPaymentLifecycleState,
    event: string,
    opts: {
      detail?: string;
      now: number;
      patch?: Partial<HspPaymentRecord>;
    },
    markSubmitted = false,
  ): HspPaymentRecord {
    assertValidTransition(rec.state, toState);
    const next: HspPaymentRecord = {
      ...rec,
      ...opts.patch,
      state: toState,
      updatedAt: opts.now,
      history: [
        ...rec.history,
        {
          timestamp: opts.now,
          fromState: rec.state,
          toState,
          event,
          detail: opts.detail,
          evidenceKind: this.mcpProvider.evidenceKind,
        },
      ],
    };
    this.store.save(next, markSubmitted);
    return this.store.getById(next.paymentId)!;
  }
}
