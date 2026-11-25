import type { MarketSnapshot } from "./market.js";
import type { VenueSelectionResult } from "./venue.js";

export interface RiskLimits {
  maxPositionSizeInventory: bigint;
  maxTotalExposurePayment: bigint;
  maxDailyPremiumBudgetPayment: bigint;
  maxDailyRealizedLossPayment: bigint;
  maxConcurrentPositions: number;
  maxConcurrentTickets: number;
  maxSlippageBps: number;
  minPoolLiquidity: bigint;
  maxOracleAgeSec: number;
  maxOracleDeviationBps: number;
  paused: boolean;
  killSwitch: boolean;
}

export interface RiskPortfolioState {
  openPositionsCount: number;
  activeTicketsCount: number;
  pendingTxCount: number;
  currentTotalExposurePayment: bigint;
  dailyPremiumSpentPayment: bigint;
  dailyRealizedLossPayment: bigint;
}

export interface RiskCheckItem {
  name: string;
  passed: boolean;
  detail: string;
}

export interface RiskCheckReport {
  allowed: boolean;
  checks: RiskCheckItem[];
  failedChecks: RiskCheckItem[];
}

/**
 * Independent, code-enforced RiskManager.
 * Runs before every entry, exercise, and position-management action.
 * Explicitly accounts for non-refundable reservation premiums and non-guaranteed stop-losses.
 */
export class RiskManager {
  evaluateEntry(params: {
    limits: RiskLimits;
    portfolio: RiskPortfolioState;
    snapshot: MarketSnapshot;
    venueSelection: VenueSelectionResult;
  }): RiskCheckReport {
    const { limits, portfolio, snapshot, venueSelection } = params;
    const checks: RiskCheckItem[] = [];

    const add = (name: string, passed: boolean, detail: string) => {
      checks.push({ name, passed, detail });
    };

    // 1. Emergency pause, kill switch & pending in-flight tx guard
    add("kill_switch", !limits.killSwitch, limits.killSwitch ? "Kill switch active" : "OK");
    add("emergency_pause", !limits.paused, limits.paused ? "Agent paused" : "OK");
    add(
      "no_pending_tx",
      portfolio.pendingTxCount === 0,
      portfolio.pendingTxCount === 0
        ? "OK"
        : `${portfolio.pendingTxCount} unresolved pending transaction(s) in flight`,
    );

    // 2. Venue selected
    const selected = venueSelection.selectedVenue;
    add(
      "venue_selected",
      selected !== "NONE",
      selected === "NONE" ? "No eligible venue selected" : `Selected ${selected}`,
    );

    // 3. Position size cap
    add(
      "max_position_size",
      snapshot.targetAmount <= limits.maxPositionSizeInventory,
      `target=${snapshot.targetAmount} <= cap=${limits.maxPositionSizeInventory}`,
    );

    // 4. Liquidity & Oracle health
    add(
      "min_pool_liquidity",
      snapshot.pool.liquidity >= limits.minPoolLiquidity,
      `liq=${snapshot.pool.liquidity} >= min=${limits.minPoolLiquidity}`,
    );

    if (snapshot.oracle !== null) {
      add("oracle_valid", snapshot.oracle.isValid && snapshot.oracle.priceX36 > 0n, "Oracle validity");
      add(
        "oracle_age",
        snapshot.oracleAgeSec !== null && snapshot.oracleAgeSec <= limits.maxOracleAgeSec,
        `age=${snapshot.oracleAgeSec ?? "N/A"}s <= max=${limits.maxOracleAgeSec}s`,
      );
      add(
        "oracle_deviation",
        snapshot.oracleDeviationBps !== null &&
          snapshot.oracleDeviationBps <= limits.maxOracleDeviationBps,
        `dev=${snapshot.oracleDeviationBps ?? "N/A"}bps <= max=${limits.maxOracleDeviationBps}bps`,
      );
    }

    // 5. Daily realized loss circuit breaker
    add(
      "daily_realized_loss",
      portfolio.dailyRealizedLossPayment < limits.maxDailyRealizedLossPayment,
      `loss=${portfolio.dailyRealizedLossPayment} < cap=${limits.maxDailyRealizedLossPayment}`,
    );

    // 6. Exposure, concurrency & non-refundable premium budget
    const route = selected === "TRANCHE" ? venueSelection.tranche : venueSelection.hskswap;
    const projectedExposure = portfolio.currentTotalExposurePayment + route.acquisitionCostPayment;
    add(
      "max_total_exposure",
      projectedExposure <= limits.maxTotalExposurePayment,
      `projected=${projectedExposure} <= cap=${limits.maxTotalExposurePayment}`,
    );

    if (selected === "TRANCHE") {
      add(
        "max_concurrent_tickets",
        portfolio.activeTicketsCount < limits.maxConcurrentTickets,
        `tickets=${portfolio.activeTicketsCount} < max=${limits.maxConcurrentTickets}`,
      );
      const projectedPrem = portfolio.dailyPremiumSpentPayment + route.reservationPremiumPayment;
      add(
        "daily_premium_budget",
        projectedPrem <= limits.maxDailyPremiumBudgetPayment,
        `non-refundable projectedPrem=${projectedPrem} <= cap=${limits.maxDailyPremiumBudgetPayment}`,
      );
    } else if (selected === "HSKSWAP") {
      add(
        "max_concurrent_positions",
        portfolio.openPositionsCount < limits.maxConcurrentPositions,
        `positions=${portfolio.openPositionsCount} < max=${limits.maxConcurrentPositions}`,
      );
      const impact = route.priceImpactBps ?? 0;
      add(
        "max_slippage",
        impact <= limits.maxSlippageBps,
        `impact=${impact}bps <= max=${limits.maxSlippageBps}bps`,
      );
    }

    const failedChecks = checks.filter((c) => !c.passed);
    return {
      allowed: failedChecks.length === 0,
      checks,
      failedChecks,
    };
  }

  evaluateExercise(params: {
    limits: RiskLimits;
    portfolio: RiskPortfolioState;
    exercisePayment: bigint;
    snapshot: MarketSnapshot;
  }): RiskCheckReport {
    const { limits, portfolio, exercisePayment, snapshot } = params;
    const checks: RiskCheckItem[] = [];
    const add = (name: string, passed: boolean, detail: string) => {
      checks.push({ name, passed, detail });
    };

    add("kill_switch", !limits.killSwitch, limits.killSwitch ? "Kill switch active" : "OK");
    add(
      "no_pending_tx",
      portfolio.pendingTxCount === 0,
      portfolio.pendingTxCount === 0
        ? "OK"
        : `${portfolio.pendingTxCount} unresolved pending transaction(s) in flight`,
    );
    add(
      "max_concurrent_positions",
      portfolio.openPositionsCount < limits.maxConcurrentPositions,
      `positions=${portfolio.openPositionsCount} < max=${limits.maxConcurrentPositions}`,
    );
    const projectedExposure = portfolio.currentTotalExposurePayment + exercisePayment;
    add(
      "max_total_exposure",
      projectedExposure <= limits.maxTotalExposurePayment,
      `projected=${projectedExposure} <= cap=${limits.maxTotalExposurePayment}`,
    );
    add(
      "daily_realized_loss",
      portfolio.dailyRealizedLossPayment < limits.maxDailyRealizedLossPayment,
      `loss=${portfolio.dailyRealizedLossPayment} < cap=${limits.maxDailyRealizedLossPayment}`,
    );
    if (snapshot.oracle !== null) {
      add("oracle_valid", snapshot.oracle.isValid && snapshot.oracle.priceX36 > 0n, "Oracle validity");
      add(
        "oracle_age",
        snapshot.oracleAgeSec !== null && snapshot.oracleAgeSec <= limits.maxOracleAgeSec,
        `age=${snapshot.oracleAgeSec ?? "N/A"}s <= max=${limits.maxOracleAgeSec}s`,
      );
    }

    const failedChecks = checks.filter((c) => !c.passed);
    return { allowed: failedChecks.length === 0, checks, failedChecks };
  }

  evaluateExit(params: {
    limits: RiskLimits;
    exitImpactBps: number;
    isStopLoss: boolean;
  }): RiskCheckReport {
    const { limits, exitImpactBps, isStopLoss } = params;
    const checks: RiskCheckItem[] = [];

    // Kill switch blocks all execution; regular pause still allows protective exits
    checks.push({
      name: "kill_switch",
      passed: !limits.killSwitch,
      detail: limits.killSwitch ? "Kill switch active — all execution halted" : "OK",
    });

    // Stop-loss exits allow up to 2x maxSlippageBps to avoid getting trapped in a market gap
    // (acknowledging that stop-loss is not a guaranteed maximum loss)
    const effectiveSlippageCap = isStopLoss ? limits.maxSlippageBps * 2 : limits.maxSlippageBps;
    checks.push({
      name: "exit_slippage",
      passed: exitImpactBps <= effectiveSlippageCap,
      detail: `exitImpact=${exitImpactBps}bps <= cap=${effectiveSlippageCap}bps (${isStopLoss ? "stop-loss gap allowance" : "standard"})`,
    });

    const failedChecks = checks.filter((c) => !c.passed);
    return {
      allowed: failedChecks.length === 0,
      checks,
      failedChecks,
    };
  }
}
