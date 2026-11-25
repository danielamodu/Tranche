import type { MarketSnapshot } from "./market.js";

export type StrategyType = "momentum" | "price_threshold" | "volatility_aware";

export interface StrategyConfig {
  type: StrategyType;
  /** Minimum positive momentum return in bps for `momentum` entry */
  momentumThresholdBps: number;
  /** Maximum acceptable unit price (1e36) for `price_threshold` buy-dip entry */
  maxEntryPriceX36: bigint;
  /** Minimum volatility (bps) for `volatility_aware` entry */
  minVolatilityBps: number;
  /** Maximum volatility (bps) before blocking entry */
  maxVolatilityBps: number;
  /** Dislocation vs TWAP (bps, negative = discount to TWAP) for `volatility_aware` entry */
  dislocationThresholdBps: number;
  /** Take-profit trigger in bps above position cost basis */
  takeProfitBps: number;
  /** Stop-loss trigger in bps below position cost basis */
  stopLossBps: number;
  /** Optional partial exit fraction in bps on take-profit (default 10_000 = 100%) */
  takeProfitExitBps: number;
  /** Window before ticket expiry (seconds) to confirm directional exercise */
  ticketExerciseWindowSec: number;
}

export interface StrategySignal {
  strategyType: StrategyType;
  action: "ENTER_LONG" | "WAIT";
  timestamp: number;
  valid: boolean;
  confidence: number; // 0..1 deterministic score
  reason: string;
  invalidationConditions: string[];
  supportingData: {
    spotPriceX36: bigint;
    twapPriceX36: bigint | null;
    momentumReturnBps: number;
    realizedVolatilityBps: number;
    dislocationVsTwapBps: number;
    anomalies: string[];
  };
}

export interface ExitDecision {
  action: "HOLD" | "TAKE_PROFIT" | "STOP_LOSS";
  exitFractionBps: number;
  reason: string;
  currentExitValuePayment: bigint;
  costBasisPayment: bigint;
  pnlBps: number;
}

export interface TicketLifecycleDecision {
  action: "HOLD_TICKET" | "EXERCISE_TICKET" | "ABANDON_EXPIRE" | "RECLAIM_EXPIRED";
  reason: string;
  remainingSeconds: number;
}

/**
 * Deterministic strategy & signal engine.
 * Never relies on an LLM to invent trading signals or override constraints.
 */
export class StrategyEngine {
  evaluateEntry(snapshot: MarketSnapshot, cfg: StrategyConfig): StrategySignal {
    const supportingData = {
      spotPriceX36: snapshot.pool.spotPriceX36,
      twapPriceX36: snapshot.pool.twapPriceX36,
      momentumReturnBps: snapshot.momentumReturnBps,
      realizedVolatilityBps: snapshot.realizedVolatilityBps,
      dislocationVsTwapBps: snapshot.dislocationVsTwapBps,
      anomalies: [...snapshot.anomalies],
    };

    const invalidationConditions = [
      `Stop-loss triggered at -${cfg.stopLossBps} bps executable exit vs cost basis`,
      `Volatility exceeds ${cfg.maxVolatilityBps} bps ceiling`,
      `Oracle becomes stale or deviates beyond configured limit`,
    ];

    if (snapshot.anomalies.length > 0) {
      return {
        strategyType: cfg.type,
        action: "WAIT",
        timestamp: snapshot.timestamp,
        valid: false,
        confidence: 0,
        reason: `Blocked by market anomalies: ${snapshot.anomalies.join(", ")}`,
        invalidationConditions,
        supportingData,
      };
    }

    if (snapshot.realizedVolatilityBps > cfg.maxVolatilityBps) {
      return {
        strategyType: cfg.type,
        action: "WAIT",
        timestamp: snapshot.timestamp,
        valid: true,
        confidence: 0,
        reason: `Realized volatility ${snapshot.realizedVolatilityBps} bps exceeds ceiling ${cfg.maxVolatilityBps} bps`,
        invalidationConditions,
        supportingData,
      };
    }

    if (cfg.type === "momentum") {
      const triggered = snapshot.momentumReturnBps >= cfg.momentumThresholdBps;
      const confidence = triggered
        ? Math.min(1, snapshot.momentumReturnBps / Math.max(1, cfg.momentumThresholdBps * 2))
        : 0;
      return {
        strategyType: cfg.type,
        action: triggered ? "ENTER_LONG" : "WAIT",
        timestamp: snapshot.timestamp,
        valid: true,
        confidence: Number(confidence.toFixed(2)),
        reason: triggered
          ? `Momentum +${snapshot.momentumReturnBps} bps >= threshold +${cfg.momentumThresholdBps} bps`
          : `Momentum ${snapshot.momentumReturnBps} bps below threshold +${cfg.momentumThresholdBps} bps`,
        invalidationConditions,
        supportingData,
      };
    }

    if (cfg.type === "price_threshold") {
      const spot = snapshot.pool.spotPriceX36;
      const triggered = spot > 0n && spot <= cfg.maxEntryPriceX36;
      const discountBps =
        triggered && cfg.maxEntryPriceX36 > 0n
          ? Number(((cfg.maxEntryPriceX36 - spot) * 10_000n) / cfg.maxEntryPriceX36)
          : 0;
      return {
        strategyType: cfg.type,
        action: triggered ? "ENTER_LONG" : "WAIT",
        timestamp: snapshot.timestamp,
        valid: true,
        confidence: triggered ? Number(Math.min(1, 0.5 + discountBps / 500).toFixed(2)) : 0,
        reason: triggered
          ? `Spot price ${spot} <= maxEntryPriceX36 ${cfg.maxEntryPriceX36} (${discountBps} bps below ceiling)`
          : `Spot price ${spot} above maxEntryPriceX36 ${cfg.maxEntryPriceX36}`,
        invalidationConditions,
        supportingData,
      };
    }

    // volatility_aware
    const inVolBand =
      snapshot.realizedVolatilityBps >= cfg.minVolatilityBps &&
      snapshot.realizedVolatilityBps <= cfg.maxVolatilityBps;
    const dislocated = snapshot.dislocationVsTwapBps <= -Math.abs(cfg.dislocationThresholdBps);
    const triggered = inVolBand && dislocated;
    return {
      strategyType: cfg.type,
      action: triggered ? "ENTER_LONG" : "WAIT",
      timestamp: snapshot.timestamp,
      valid: true,
      confidence: triggered ? 0.8 : 0,
      reason: triggered
        ? `Volatility ${snapshot.realizedVolatilityBps} bps in [${cfg.minVolatilityBps}, ${cfg.maxVolatilityBps}] & dislocation ${snapshot.dislocationVsTwapBps} bps <= -${Math.abs(cfg.dislocationThresholdBps)} bps`
        : `Volatility/dislocation conditions not met (vol=${snapshot.realizedVolatilityBps} bps, dislocation=${snapshot.dislocationVsTwapBps} bps)`,
      invalidationConditions,
      supportingData,
    };
  }

  evaluatePositionExit(
    costBasisPayment: bigint,
    executableExitPayment: bigint,
    cfg: StrategyConfig,
  ): ExitDecision {
    if (costBasisPayment === 0n) {
      return {
        action: "HOLD",
        exitFractionBps: 0,
        reason: "Zero cost basis",
        currentExitValuePayment: executableExitPayment,
        costBasisPayment,
        pnlBps: 0,
      };
    }

    const pnlBps = Number(((executableExitPayment - costBasisPayment) * 10_000n) / costBasisPayment);

    if (pnlBps >= cfg.takeProfitBps) {
      return {
        action: "TAKE_PROFIT",
        exitFractionBps: cfg.takeProfitExitBps > 0 ? cfg.takeProfitExitBps : 10_000,
        reason: `Executable exit P&L +${pnlBps} bps >= take-profit +${cfg.takeProfitBps} bps`,
        currentExitValuePayment: executableExitPayment,
        costBasisPayment,
        pnlBps,
      };
    }

    if (pnlBps <= -Math.abs(cfg.stopLossBps)) {
      return {
        action: "STOP_LOSS",
        exitFractionBps: 10_000, // full protective exit
        reason: `Executable exit P&L ${pnlBps} bps <= stop-loss -${Math.abs(cfg.stopLossBps)} bps`,
        currentExitValuePayment: executableExitPayment,
        costBasisPayment,
        pnlBps,
      };
    }

    return {
      action: "HOLD",
      exitFractionBps: 0,
      reason: `Executable exit P&L ${pnlBps} bps within [-${cfg.stopLossBps}, +${cfg.takeProfitBps}] bps`,
      currentExitValuePayment: executableExitPayment,
      costBasisPayment,
      pnlBps,
    };
  }

  /**
   * Evaluates an active reserved Tranche ticket before/after expiry.
   * Note: reservation premium is already sunk & non-refundable, so exercise depends strictly
   * on remaining exercise cost vs live HSKSwap executable exit / buy cost.
   */
  evaluateActiveTicket(params: {
    nowSec: number;
    expiresAt: number;
    exercisePayment: bigint;
    dexBuyCostPayment: bigint | null;
    dexExitProceedsPayment: bigint | null;
    minExerciseEdgePayment: bigint;
    cfg: StrategyConfig;
  }): TicketLifecycleDecision {
    const remainingSeconds = params.expiresAt - params.nowSec;
    if (remainingSeconds <= 0) {
      return {
        action: "RECLAIM_EXPIRED",
        reason: `Ticket expired ${Math.abs(remainingSeconds)}s ago; reclaimable`,
        remainingSeconds,
      };
    }

    // Immediate executable arb: selling on HSKSwap exceeds remaining exercise payment + edge
    if (
      params.dexExitProceedsPayment !== null &&
      params.dexExitProceedsPayment > params.exercisePayment + params.minExerciseEdgePayment
    ) {
      return {
        action: "EXERCISE_TICKET",
        reason: `Executable HSKSwap exit (${params.dexExitProceedsPayment}) > exercise payment (${params.exercisePayment}) + minEdge (${params.minExerciseEdgePayment})`,
        remainingSeconds,
      };
    }

    // Near expiry window: exercise only if strictly cheaper than buying spot on HSKSwap
    if (remainingSeconds <= params.cfg.ticketExerciseWindowSec) {
      if (params.dexBuyCostPayment !== null && params.exercisePayment < params.dexBuyCostPayment) {
        return {
          action: "EXERCISE_TICKET",
          reason: `Within ${remainingSeconds}s expiry window and exercise payment (${params.exercisePayment}) < HSKSwap spot buy (${params.dexBuyCostPayment})`,
          remainingSeconds,
        };
      }
      return {
        action: "ABANDON_EXPIRE",
        reason: `Out-of-the-money near expiry: exercise payment (${params.exercisePayment}) >= HSKSwap buy (${params.dexBuyCostPayment ?? "N/A"}); letting expire to cap loss at sunk premium`,
        remainingSeconds,
      };
    }

    return {
      action: "HOLD_TICKET",
      reason: `Holding ticket (${remainingSeconds}s remaining) awaiting confirmation or positive exit edge`,
      remainingSeconds,
    };
  }
}
