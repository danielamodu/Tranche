import type { HspPaymentLifecycleState } from "./types.js";

export const ALL_PAYMENT_STATES: readonly HspPaymentLifecycleState[] = [
  "CREATED",
  "PREPARED",
  "AUTHORIZED",
  "SUBMITTED",
  "PROCESSING",
  "SAFE",
  "TIMEOUT",
  "FINALIZED",
  "FAILED",
] as const;

/**
 * Strict lifecycle state transition table.
 *
 * Key safety invariants:
 * 1. Explicit authorization is mandatory before submission: PREPARED -> AUTHORIZED -> SUBMITTED.
 * 2. TIMEOUT can NEVER transition back to AUTHORIZED or SUBMITTED — it can only reconcile forward
 *    via status queries (PROCESSING | SAFE | FINALIZED | FAILED), preventing duplicate payments.
 * 3. FINALIZED and FAILED are strictly terminal.
 */
export const VALID_PAYMENT_TRANSITIONS: Readonly<
  Record<HspPaymentLifecycleState, readonly HspPaymentLifecycleState[]>
> = {
  CREATED: ["PREPARED", "FAILED"],
  PREPARED: ["AUTHORIZED", "FAILED"],
  AUTHORIZED: ["SUBMITTED", "FAILED"],
  SUBMITTED: ["PROCESSING", "SAFE", "TIMEOUT", "FINALIZED", "FAILED"],
  PROCESSING: ["PROCESSING", "SAFE", "TIMEOUT", "FINALIZED", "FAILED"],
  SAFE: ["SAFE", "FINALIZED", "TIMEOUT", "FAILED"],
  TIMEOUT: ["TIMEOUT", "PROCESSING", "SAFE", "FINALIZED", "FAILED"],
  FINALIZED: [],
  FAILED: [],
};

export function isValidTransition(
  from: HspPaymentLifecycleState,
  to: HspPaymentLifecycleState,
): boolean {
  return VALID_PAYMENT_TRANSITIONS[from].includes(to);
}

export function assertValidTransition(
  from: HspPaymentLifecycleState,
  to: HspPaymentLifecycleState,
): void {
  if (!isValidTransition(from, to)) {
    throw new Error(`INVALID_STATE_TRANSITION: cannot transition payment from ${from} to ${to}`);
  }
}

export function isTerminalPaymentState(state: HspPaymentLifecycleState): boolean {
  return state === "FINALIZED" || state === "FAILED";
}

/**
 * States where a payment has already been dispatched to the provider and may still be settling.
 * On restart, these records must be reconciled via status queries — NEVER re-submitted.
 */
export function isInProgressPostSubmissionState(state: HspPaymentLifecycleState): boolean {
  return (
    state === "SUBMITTED" ||
    state === "PROCESSING" ||
    state === "SAFE" ||
    state === "TIMEOUT"
  );
}

/**
 * Normalizes a provider-reported status string into a known post-submission lifecycle state.
 * Returns null for unrecognized statuses so the orchestrator fails safe instead of guessing.
 */
export function mapProviderStatusToLifecycleState(
  rawStatus: string,
): "PROCESSING" | "SAFE" | "TIMEOUT" | "FINALIZED" | "FAILED" | null {
  const normalized = rawStatus.trim().toUpperCase();
  if (normalized === "PROCESSING" || normalized === "PENDING" || normalized === "SUBMITTED") {
    return "PROCESSING";
  }
  if (normalized === "SAFE") {
    return "SAFE";
  }
  if (normalized === "TIMEOUT" || normalized === "TIMED_OUT") {
    return "TIMEOUT";
  }
  if (normalized === "FINALIZED" || normalized === "CONFIRMED" || normalized === "SETTLED") {
    return "FINALIZED";
  }
  if (normalized === "FAILED" || normalized === "REVERTED" || normalized === "REJECTED") {
    return "FAILED";
  }
  return null;
}
