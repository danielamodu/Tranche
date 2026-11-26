import { BPS_DENOMINATOR } from "./hskswap.js";
import type { PositionStore, TrackedPosition, TrackedTicket } from "./positions.js";
import { StrategyEngine, type ExitDecision, type StrategyConfig, type TicketLifecycleDecision } from "./strategy.js";

export interface PositionIntegrityIssue {
  severity: "WARN" | "CRITICAL";
  code: string;
  entityId: string;
  detail: string;
}

export interface PositionIntegrityReport {
  healthy: boolean;
  pendingTxBlocking: boolean;
  issues: PositionIntegrityIssue[];
}

export interface ManagedExitEvaluation {
  positionId: string;
  decision: ExitDecision;
  blockedByPendingTx: boolean;
  netExecutableExitPayment: bigint;
  estimatedExitGasPayment: bigint;
  realizedEntrySlippageBps: number | null;
}

/**
 * Deterministic position & ticket lifecycle manager.
 *
 * Responsibilities:
 * - Fee-, slippage-, and gas-adjusted take-profit / stop-loss evaluation
 * - Active ticket expiry & exercise evaluation
 * - Stale or inconsistent position/ticket state detection
 * - Hard pending-tx reconciliation gate before taking lifecycle actions
 */
export class PositionLifecycleManager {
  private readonly strategyEngine = new StrategyEngine();

  auditStateIntegrity(store: PositionStore, nowSec: number): PositionIntegrityReport {
    const issues: PositionIntegrityIssue[] = [];
    const pendingTxs = store.getPendingTxs();
    const pendingTxBlocking = pendingTxs.length > 0;

    if (store.isStateCorrupted()) {
      issues.push({
        severity: "CRITICAL",
        code: "PERSISTED_STATE_CORRUPTED",
        entityId: "store",
        detail: store.getCorruptionError() ?? "Persisted state is corrupted",
      });
    }

    if (pendingTxBlocking) {
      for (const ptx of pendingTxs) {
        issues.push({
          severity: "CRITICAL",
          code: ptx.status === "UNCERTAIN_TIMEOUT" ? "UNCERTAIN_PENDING_TX" : "IN_FLIGHT_PENDING_TX",
          entityId: ptx.id,
          detail: `Pending ${ptx.action} (${ptx.status}) must be reconciled before further mutations`,
        });
      }
    }

    for (const pos of store.getAllPositions()) {
      if ((pos.status === "OPEN" || pos.status === "PARTIALLY_CLOSED") && pos.remainingQuantity <= 0n) {
        issues.push({
          severity: "CRITICAL",
          code: "INCONSISTENT_OPEN_ZERO_QTY",
          entityId: pos.positionId,
          detail: `Position is ${pos.status} but remainingQuantity=${pos.remainingQuantity}`,
        });
      }
      if (pos.status === "CLOSED" && pos.remainingQuantity > 0n) {
        issues.push({
          severity: "CRITICAL",
          code: "INCONSISTENT_CLOSED_NONZERO_QTY",
          entityId: pos.positionId,
          detail: `Position is CLOSED but remainingQuantity=${pos.remainingQuantity}`,
        });
      }
      if (pos.remainingCostBasisPayment < 0n) {
        issues.push({
          severity: "CRITICAL",
          code: "NEGATIVE_COST_BASIS",
          entityId: pos.positionId,
          detail: `Position has negative remainingCostBasisPayment=${pos.remainingCostBasisPayment}`,
        });
      }
    }

    for (const t of store.getActiveTickets()) {
      if (t.expiresAt <= nowSec) {
        issues.push({
          severity: "WARN",
          code: "EXPIRED_ACTIVE_TICKET",
          entityId: `ticket-${t.ticketId.toString()}`,
          detail: `Active ticket #${t.ticketId} expired ${nowSec - t.expiresAt}s ago and requires reclaim`,
        });
      }
      if (t.remainingAmount <= 0n) {
        issues.push({
          severity: "CRITICAL",
          code: "INCONSISTENT_ACTIVE_ZERO_TICKET",
          entityId: `ticket-${t.ticketId.toString()}`,
          detail: `Ticket #${t.ticketId} is ACTIVE with remainingAmount=0`,
        });
      }
    }

    return {
      healthy: !issues.some((i) => i.severity === "CRITICAL"),
      pendingTxBlocking,
      issues,
    };
  }

  evaluatePositionExitWithCosts(params: {
    position: TrackedPosition;
    executableExitPayment: bigint;
    estimatedExitGasPayment?: bigint;
    pendingTxCount: number;
    strategyConfig: StrategyConfig;
  }): ManagedExitEvaluation {
    const exitGas = params.estimatedExitGasPayment ?? 0n;
    const netExit =
      params.executableExitPayment > exitGas ? params.executableExitPayment - exitGas : 0n;

    let realizedEntrySlippageBps: number | null = null;
    if (
      params.position.estimatedEntryCostPayment !== undefined &&
      params.position.estimatedEntryCostPayment > 0n
    ) {
      const diff = params.position.entryCostPayment - params.position.estimatedEntryCostPayment;
      realizedEntrySlippageBps = Number(
        (diff * BPS_DENOMINATOR) / params.position.estimatedEntryCostPayment,
      );
    }

    if (params.pendingTxCount > 0) {
      return {
        positionId: params.position.positionId,
        blockedByPendingTx: true,
        netExecutableExitPayment: netExit,
        estimatedExitGasPayment: exitGas,
        realizedEntrySlippageBps,
        decision: {
          action: "HOLD",
          exitFractionBps: 0,
          reason: `Blocked by ${params.pendingTxCount} unresolved pending transaction(s); reconcile first`,
          currentExitValuePayment: netExit,
          costBasisPayment: params.position.remainingCostBasisPayment,
          pnlBps: 0,
        },
      };
    }

    const decision = this.strategyEngine.evaluatePositionExit(
      params.position.remainingCostBasisPayment,
      netExit,
      params.strategyConfig,
    );

    return {
      positionId: params.position.positionId,
      blockedByPendingTx: false,
      netExecutableExitPayment: netExit,
      estimatedExitGasPayment: exitGas,
      realizedEntrySlippageBps,
      decision,
    };
  }

  evaluateTicketLifecycle(params: {
    ticket: TrackedTicket;
    nowSec: number;
    exercisePayment: bigint;
    exerciseGasPayment?: bigint;
    dexBuyCostPayment: bigint | null;
    dexExitProceedsPayment: bigint | null;
    minExerciseEdgePayment: bigint;
    pendingTxCount: number;
    strategyConfig: StrategyConfig;
  }): TicketLifecycleDecision {
    if (params.pendingTxCount > 0) {
      return {
        action: "HOLD_TICKET",
        reason: `Blocked by ${params.pendingTxCount} unresolved pending transaction(s); reconcile first`,
        remainingSeconds: params.ticket.expiresAt - params.nowSec,
      };
    }

    const totalExerciseCost = params.exercisePayment + (params.exerciseGasPayment ?? 0n);
    return this.strategyEngine.evaluateActiveTicket({
      nowSec: params.nowSec,
      expiresAt: params.ticket.expiresAt,
      exercisePayment: totalExerciseCost,
      dexBuyCostPayment: params.dexBuyCostPayment,
      dexExitProceedsPayment: params.dexExitProceedsPayment,
      minExerciseEdgePayment: params.minExerciseEdgePayment,
      cfg: params.strategyConfig,
    });
  }
}
