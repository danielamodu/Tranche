import type { Address } from "viem";
import {
  AdaptiveStrategyEngine,
  type AdaptiveStrategyConfig,
  type AdaptiveStrategyDecision,
} from "./adaptive-strategy.js";
import { BPS_DENOMINATOR, PRICE_SCALE } from "./hskswap.js";
import { classifyMarketRegime, type MarketRegime, type MarketSnapshot } from "./market.js";
import {
  PortfolioIntelligenceEngine,
  type PortfolioAllocationDecision,
  type PortfolioConstraints,
  type PortfolioSnapshot,
} from "./portfolio.js";
import { PositionStore } from "./positions.js";
import { RiskManager, type RiskLimits } from "./risk.js";
import type { AutonomousDecisionTrace } from "./runtime.js";
import type { StrategyConfig, StrategyType } from "./strategy.js";
import { VenueSelector, type SelectedVenue, type VenueSelectionConstraints } from "./venue.js";

export type DataProvenance = "LIVE" | "FORK" | "REPLAY" | "MOCK";

export interface DecisionEvaluationRecord {
  cycleId: number;
  decisionKey: string;
  timestamp: number;
  dataProvenance: DataProvenance;
  marketRegime: MarketRegime;
  spotPriceX36: bigint;
  twapPriceX36: bigint | null;
  poolLiquidity: bigint;
  strategySelected: StrategyType | "NONE";
  signalAction: "ENTER_LONG" | "WAIT";
  portfolioCommittedPayment: bigint;
  portfolioAvailablePayment: bigint;
  allocationApproved: boolean | null;
  selectedVenue: SelectedVenue;
  trancheEligible: boolean;
  hskswapEligible: boolean;
  expectedExecutionCostPayment: bigint;
  actualExecutionCostPayment: bigint | null;
  realizedSlippageBps: number | null;
  expectedCostImprovementPayment: bigint;
  venueSelectionOptimal: boolean | null;
  riskAllowed: boolean;
  failedRiskChecks: string[];
  selectedAction: string;
  rejectedOpportunities: string[];
  tradeOutcomePayment: bigint | null;
  isDuplicateAttempt: boolean;
  isMissedExecution: boolean;
}

export interface EvaluationMetricsSummary {
  dataProvenance: DataProvenance;
  totalDecisions: number;
  executedDecisions: number;
  rejectedDecisions: number;
  waitDecisions: number;
  netPnlAfterFeesPayment: bigint;
  maxDrawdownPayment: bigint;
  maxDrawdownBps: number;
  closedTradesCount: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRateBps: number;
  profitFactor: number | null;
  /** Computed strictly when closedTradesCount >= 5 and sample stddev > 0; null otherwise. */
  sharpeRatio: number | null;
  venueSelectionAccuracyBps: number | null;
  totalExecutionCostImprovementPayment: bigint;
  riskLimitViolationsCount: number;
  missedExecutionAttempts: number;
  duplicateExecutionAttempts: number;
}

/**
 * Captures structured decision evaluations and computes verifiable performance metrics.
 * Never fabricates Sharpe ratios or accuracy when sample sizes are insufficient.
 */
export class DecisionEvaluationEngine {
  private readonly records: DecisionEvaluationRecord[] = [];
  private readonly dataProvenance: DataProvenance;
  private readonly maxRecords: number;

  constructor(dataProvenance: DataProvenance = "MOCK", maxRecords = 500) {
    this.dataProvenance = dataProvenance;
    this.maxRecords = maxRecords;
  }

  getProvenance(): DataProvenance {
    return this.dataProvenance;
  }

  getRecords(): readonly DecisionEvaluationRecord[] {
    return this.records;
  }

  recordFromTrace(params: {
    trace: AutonomousDecisionTrace;
    portfolioSnapshot?: PortfolioSnapshot;
    allocationDecision?: PortfolioAllocationDecision;
    adaptiveStrategy?: AdaptiveStrategyDecision;
  }): DecisionEvaluationRecord {
    const { trace, portfolioSnapshot, allocationDecision, adaptiveStrategy } = params;
    const vs = trace.venueSelection;
    const chosenRoute = vs.selectedVenue === "TRANCHE" ? vs.tranche : vs.hskswap;
    const expectedCost = vs.selectedVenue === "NONE" ? 0n : chosenRoute.acquisitionCostPayment;

    const bothEligible = vs.tranche.eligible && vs.hskswap.eligible;
    let venueOptimal: boolean | null = null;
    let costImprovement = 0n;
    if (bothEligible && vs.selectedVenue !== "NONE") {
      if (vs.selectedVenue === "TRANCHE") {
        venueOptimal = vs.tranche.acquisitionCostPayment <= vs.hskswap.acquisitionCostPayment;
        costImprovement =
          vs.hskswap.acquisitionCostPayment > vs.tranche.acquisitionCostPayment
            ? vs.hskswap.acquisitionCostPayment - vs.tranche.acquisitionCostPayment
            : 0n;
      } else {
        venueOptimal = vs.hskswap.acquisitionCostPayment <= vs.tranche.acquisitionCostPayment;
        costImprovement =
          vs.tranche.acquisitionCostPayment > vs.hskswap.acquisitionCostPayment
            ? vs.tranche.acquisitionCostPayment - vs.hskswap.acquisitionCostPayment
            : 0n;
      }
    }

    const rejectedOpportunities: string[] = [];
    if (adaptiveStrategy && !adaptiveStrategy.suitableForTrading) {
      rejectedOpportunities.push(...adaptiveStrategy.unsuitableReasons);
    }
    if (allocationDecision && !allocationDecision.approved) {
      rejectedOpportunities.push(...allocationDecision.rejectionReasons);
    }
    if (!trace.riskReport.allowed) {
      rejectedOpportunities.push(...trace.riskReport.failedChecks.map((c) => `risk:${c.name}`));
    }

    let tradeOutcome: bigint | null = null;
    for (const pa of trace.positionActions) {
      if (pa.realizedDelta !== undefined) {
        tradeOutcome = (tradeOutcome ?? 0n) + pa.realizedDelta;
      }
    }

    const rec: DecisionEvaluationRecord = {
      cycleId: trace.cycleId,
      decisionKey: trace.decisionKey,
      timestamp: trace.timestamp,
      dataProvenance: this.dataProvenance,
      marketRegime: trace.snapshot.marketRegime,
      spotPriceX36: trace.snapshot.pool.spotPriceX36,
      twapPriceX36: trace.snapshot.pool.twapPriceX36,
      poolLiquidity: trace.snapshot.pool.liquidity,
      strategySelected: adaptiveStrategy
        ? adaptiveStrategy.selectedStrategyType
        : trace.signal.action === "ENTER_LONG"
          ? trace.strategyConfig.type
          : "NONE",
      signalAction: trace.signal.action,
      portfolioCommittedPayment: portfolioSnapshot?.totalCommittedCapitalPayment ?? 0n,
      portfolioAvailablePayment: portfolioSnapshot?.availableCapitalForAllocationPayment ?? 0n,
      allocationApproved: allocationDecision ? allocationDecision.approved : null,
      selectedVenue: vs.selectedVenue,
      trancheEligible: vs.tranche.eligible,
      hskswapEligible: vs.hskswap.eligible,
      expectedExecutionCostPayment: expectedCost,
      actualExecutionCostPayment:
        trace.selectedAction === "RESERVE_TRANCHE" || trace.selectedAction === "SWAP_HSKSWAP"
          ? expectedCost
          : null,
      realizedSlippageBps:
        trace.selectedAction === "SWAP_HSKSWAP" ? (vs.hskswap.priceImpactBps ?? 0) : null,
      expectedCostImprovementPayment: costImprovement,
      venueSelectionOptimal: venueOptimal,
      riskAllowed: trace.riskReport.allowed,
      failedRiskChecks: trace.riskReport.failedChecks.map((c) => c.name),
      selectedAction: trace.selectedAction,
      rejectedOpportunities,
      tradeOutcomePayment: tradeOutcome,
      isDuplicateAttempt: trace.selectedAction === "SKIPPED_DUPLICATE",
      isMissedExecution: trace.selectedAction === "EXECUTION_FAILED",
    };

    this.records.push(rec);
    if (this.records.length > this.maxRecords) {
      this.records.shift();
    }
    return rec;
  }

  recordManual(rec: DecisionEvaluationRecord): void {
    this.records.push(rec);
    if (this.records.length > this.maxRecords) {
      this.records.shift();
    }
  }

  computeMetrics(initialEquityPayment = 100_000_000n): EvaluationMetricsSummary {
    let executed = 0;
    let rejected = 0;
    let wait = 0;
    let riskViolations = 0;
    let missed = 0;
    let duplicates = 0;
    let dualVenueSamples = 0;
    let dualVenueOptimal = 0;
    let totalCostImprovement = 0n;

    const closedOutcomes: number[] = [];
    let netPnl = 0n;
    let grossProfit = 0n;
    let grossLoss = 0n;
    let wins = 0;
    let losses = 0;
    let breakevens = 0;

    let runningEquity = initialEquityPayment;
    let peakEquity = initialEquityPayment;
    let maxDrawdown = 0n;

    for (const r of this.records) {
      if (
        r.selectedAction === "RESERVE_TRANCHE" ||
        r.selectedAction === "SWAP_HSKSWAP" ||
        r.selectedAction === "EXIT_POSITION" ||
        r.selectedAction === "EXERCISE_TICKET"
      ) {
        executed += 1;
      } else if (r.selectedAction === "BLOCKED_RISK" || r.allocationApproved === false) {
        rejected += 1;
      } else if (r.selectedAction === "WAIT") {
        wait += 1;
      }

      if (!r.riskAllowed && r.signalAction === "ENTER_LONG") riskViolations += 1;
      if (r.isMissedExecution) missed += 1;
      if (r.isDuplicateAttempt) duplicates += 1;

      if (r.venueSelectionOptimal !== null) {
        dualVenueSamples += 1;
        if (r.venueSelectionOptimal) dualVenueOptimal += 1;
      }
      totalCostImprovement += r.expectedCostImprovementPayment;

      if (r.tradeOutcomePayment !== null) {
        netPnl += r.tradeOutcomePayment;
        closedOutcomes.push(Number(r.tradeOutcomePayment));
        if (r.tradeOutcomePayment > 0n) {
          wins += 1;
          grossProfit += r.tradeOutcomePayment;
        } else if (r.tradeOutcomePayment < 0n) {
          losses += 1;
          grossLoss += -r.tradeOutcomePayment;
        } else {
          breakevens += 1;
        }

        runningEquity += r.tradeOutcomePayment;
        if (runningEquity > peakEquity) peakEquity = runningEquity;
        const dd = peakEquity > runningEquity ? peakEquity - runningEquity : 0n;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
    }

    const closedCount = closedOutcomes.length;
    const winRateBps =
      closedCount > 0 ? Math.round((wins * Number(BPS_DENOMINATOR)) / closedCount) : 0;
    const maxDrawdownBps =
      peakEquity > 0n ? Number((maxDrawdown * BPS_DENOMINATOR) / peakEquity) : 0;

    const profitFactor =
      grossLoss > 0n
        ? Number((Number(grossProfit) / Number(grossLoss)).toFixed(3))
        : grossProfit > 0n
          ? null
          : null;

    let sharpeRatio: number | null = null;
    if (closedOutcomes.length >= 5) {
      const mean = closedOutcomes.reduce((a, b) => a + b, 0) / closedOutcomes.length;
      const variance =
        closedOutcomes.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (closedOutcomes.length - 1);
      const std = Math.sqrt(variance);
      if (std > 0) {
        sharpeRatio = Number(((mean / std) * Math.sqrt(closedOutcomes.length)).toFixed(3));
      }
    }

    const venueSelectionAccuracyBps =
      dualVenueSamples > 0
        ? Math.round((dualVenueOptimal * Number(BPS_DENOMINATOR)) / dualVenueSamples)
        : null;

    return {
      dataProvenance: this.dataProvenance,
      totalDecisions: this.records.length,
      executedDecisions: executed,
      rejectedDecisions: rejected,
      waitDecisions: wait,
      netPnlAfterFeesPayment: netPnl,
      maxDrawdownPayment: maxDrawdown,
      maxDrawdownBps,
      closedTradesCount: closedCount,
      wins,
      losses,
      breakevens,
      winRateBps,
      profitFactor,
      sharpeRatio,
      venueSelectionAccuracyBps,
      totalExecutionCostImprovementPayment: totalCostImprovement,
      riskLimitViolationsCount: riskViolations,
      missedExecutionAttempts: missed,
      duplicateExecutionAttempts: duplicates,
    };
  }
}

export interface ReplayBar {
  timestamp: number;
  spotPriceX36: bigint;
  twapPriceX36: bigint | null;
  poolLiquidity: bigint;
  dexBuyCostPayment: bigint;
  dexBuyImpactBps: number;
  dexSellProceedsPayment: bigint;
  dexSellImpactBps: number;
  trancheOfferCostPayment?: bigint;
  tranchePremiumPayment?: bigint;
  oraclePriceX36?: bigint;
  oracleAgeSec?: number;
}

export interface ReplayScenario {
  name: string;
  inventoryToken: Address;
  paymentToken: Address;
  targetAmount: bigint;
  initialBalancePayment: bigint;
  bars: readonly ReplayBar[];
  strategyConfig: StrategyConfig;
  adaptiveConfig: AdaptiveStrategyConfig;
  venueConstraints: VenueSelectionConstraints;
  portfolioConstraints: PortfolioConstraints;
  riskLimits: RiskLimits;
}

export interface ReplayResult {
  scenarioName: string;
  dataProvenance: "REPLAY";
  barsProcessed: number;
  metrics: EvaluationMetricsSummary;
  decisions: DecisionEvaluationRecord[];
}

/**
 * Deterministic historical & scenario replay harness.
 * Produces bit-for-bit identical evaluation records and metrics for identical inputs.
 * Always tags output with `dataProvenance: "REPLAY"`.
 */
export class HistoricalReplayEngine {
  runScenarioReplay(scenario: ReplayScenario): ReplayResult {
    const store = new PositionStore(undefined, scenario.bars[0]?.timestamp ?? 1_750_000_000);
    const adaptiveEngine = new AdaptiveStrategyEngine();
    const portfolioEngine = new PortfolioIntelligenceEngine();
    const venueSelector = new VenueSelector();
    const riskManager = new RiskManager();
    const evaluator = new DecisionEvaluationEngine("REPLAY", scenario.bars.length + 10);

    let cashBalance = scenario.initialBalancePayment;
    const spotHistory: bigint[] = [];

    for (let i = 0; i < scenario.bars.length; i++) {
      const bar = scenario.bars[i]!;
      spotHistory.push(bar.spotPriceX36);
      if (spotHistory.length > 16) spotHistory.shift();

      const minSpot = spotHistory.reduce((a, b) => (a < b ? a : b), spotHistory[0]!);
      const maxSpot = spotHistory.reduce((a, b) => (a > b ? a : b), spotHistory[0]!);
      const realizedVolBps =
        spotHistory.length >= 2 && minSpot > 0n
          ? Number(((maxSpot - minSpot) * BPS_DENOMINATOR) / minSpot)
          : 0;
      const momentumBps =
        spotHistory.length >= 2 && spotHistory[0]! > 0n
          ? Number(((bar.spotPriceX36 - spotHistory[0]!) * BPS_DENOMINATOR) / spotHistory[0]!)
          : 0;
      const dislocationBps =
        bar.twapPriceX36 && bar.twapPriceX36 > 0n
          ? Number(((bar.spotPriceX36 - bar.twapPriceX36) * BPS_DENOMINATOR) / bar.twapPriceX36)
          : 0;
      const marketRegime = classifyMarketRegime({
        realizedVolatilityBps: realizedVolBps,
        momentumReturnBps: momentumBps,
        dislocationVsTwapBps: dislocationBps,
      });

      const hasTranche =
        bar.trancheOfferCostPayment !== undefined && bar.tranchePremiumPayment !== undefined;
      const trancheAllInUnit =
        hasTranche && scenario.targetAmount > 0n
          ? ((bar.trancheOfferCostPayment! + bar.tranchePremiumPayment!) * PRICE_SCALE) /
            scenario.targetAmount
          : 0n;

      const snapshot: MarketSnapshot = {
        timestamp: bar.timestamp,
        inventoryToken: scenario.inventoryToken,
        paymentToken: scenario.paymentToken,
        targetAmount: scenario.targetAmount,
        pool: {
          venue: "ReplayPool",
          poolAddress: "0x0000000000000000000000000000000000000001",
          token0: scenario.inventoryToken,
          token1: scenario.paymentToken,
          fee: 3000,
          liquidity: bar.poolLiquidity,
          sqrtPriceX96: 1n << 96n,
          tick: 0,
          observationCardinality: 64,
          spotPriceX36: bar.spotPriceX36,
          twapPriceX36: bar.twapPriceX36,
          timestamp: bar.timestamp,
        },
        dexBuyQuote: {
          venue: "HSKSwapV3",
          inventoryToken: scenario.inventoryToken,
          paymentToken: scenario.paymentToken,
          inventoryAmountOut: scenario.targetAmount,
          paymentAmountIn: bar.dexBuyCostPayment,
          effectiveUnitPriceX36:
            scenario.targetAmount > 0n
              ? (bar.dexBuyCostPayment * PRICE_SCALE) / scenario.targetAmount
              : 0n,
          priceImpactBps: bar.dexBuyImpactBps,
          gasEstimate: 120_000n,
        },
        dexSellQuote: {
          venue: "HSKSwapV3",
          inventoryToken: scenario.inventoryToken,
          paymentToken: scenario.paymentToken,
          inventoryAmountIn: scenario.targetAmount,
          paymentAmountOut: bar.dexSellProceedsPayment,
          effectiveUnitPriceX36:
            scenario.targetAmount > 0n
              ? (bar.dexSellProceedsPayment * PRICE_SCALE) / scenario.targetAmount
              : 0n,
          priceImpactBps: bar.dexSellImpactBps,
          gasEstimate: 120_000n,
        },
        oracle: bar.oraclePriceX36
          ? {
              priceX36: bar.oraclePriceX36,
              updatedAt: bar.timestamp - (bar.oracleAgeSec ?? 0),
              isValid: true,
            }
          : null,
        oracleAgeSec: bar.oracleAgeSec ?? null,
        oracleDeviationBps:
          bar.oraclePriceX36 && bar.spotPriceX36 > 0n
            ? Number(
                ((bar.oraclePriceX36 > bar.spotPriceX36
                  ? bar.oraclePriceX36 - bar.spotPriceX36
                  : bar.spotPriceX36 - bar.oraclePriceX36) *
                  BPS_DENOMINATOR) /
                  bar.spotPriceX36,
              )
            : null,
        trancheOffers: hasTranche
          ? {
              timestamp: bar.timestamp,
              discoveredOffers: [],
              evaluations: [],
              selected: {
                offerId: 1n,
                eligible: true,
                rejectionReasons: [],
                priceMode: 0,
                availableCapacity: scenario.targetAmount,
                quotedGrossPremium: bar.tranchePremiumPayment!,
                quotedExerciseCost: bar.trancheOfferCostPayment!,
                effectiveAllInUnitCostX36: trancheAllInUnit,
                expiresAt: bar.timestamp + 86_400,
              },
            }
          : {
              timestamp: bar.timestamp,
              discoveredOffers: [],
              evaluations: [],
              selected: null,
            },
        realizedVolatilityBps: realizedVolBps,
        momentumReturnBps: momentumBps,
        dislocationVsTwapBps: dislocationBps,
        marketRegime,
        anomalies: [],
        dataSourceHealthy: true,
      };

      // 1. Check exits on open positions
      let realizedDeltaThisBar: bigint | null = null;
      for (const pos of store.getOpenPositions()) {
        const exitProceeds =
          bar.dexSellProceedsPayment > (scenario.venueConstraints.dexExitGasCostPayment ?? 0n)
            ? bar.dexSellProceedsPayment - (scenario.venueConstraints.dexExitGasCostPayment ?? 0n)
            : 0n;
        store.updateUnrealizedPnl(pos.positionId, exitProceeds);
        const pnlBps =
          pos.remainingCostBasisPayment > 0n
            ? Number(
                ((exitProceeds - pos.remainingCostBasisPayment) * BPS_DENOMINATOR) /
                  pos.remainingCostBasisPayment,
              )
            : 0;
        if (
          pnlBps >= scenario.strategyConfig.takeProfitBps ||
          pnlBps <= -Math.abs(scenario.strategyConfig.stopLossBps)
        ) {
          const { realizedDelta } = store.recordPositionExit({
            positionId: pos.positionId,
            soldQuantity: pos.remainingQuantity,
            proceedsPayment: exitProceeds,
            txHash: `0x${String(i + 1).padStart(64, "a")}`,
            nowSec: bar.timestamp,
          });
          cashBalance += exitProceeds;
          realizedDeltaThisBar = (realizedDeltaThisBar ?? 0n) + realizedDelta;
        }
      }

      // 2. Adaptive strategy + portfolio + venue + risk
      const adaptive = adaptiveEngine.evaluate(snapshot, scenario.adaptiveConfig);
      const venueSel = venueSelector.selectVenue(
        snapshot,
        adaptive.effectiveConfig,
        scenario.venueConstraints,
      );
      const portSnap = portfolioEngine.buildSnapshot({
        store,
        nowSec: bar.timestamp,
        availableBalancePayment: cashBalance,
        constraints: scenario.portfolioConstraints,
      });

      const chosenRoute = venueSel.selectedVenue === "TRANCHE" ? venueSel.tranche : venueSel.hskswap;
      const alloc =
        adaptive.signal.action === "ENTER_LONG" && venueSel.selectedVenue !== "NONE"
          ? portfolioEngine.evaluateAllocation({
              snapshot: portSnap,
              constraints: scenario.portfolioConstraints,
              request: {
                inventoryToken: scenario.inventoryToken,
                requestedAmountInventory: scenario.targetAmount,
                estimatedAcquisitionCostPayment: chosenRoute.acquisitionCostPayment,
                expectedNetProfitPayment: chosenRoute.expectedNetProfitAtTargetPayment,
                reservationPremiumPayment: chosenRoute.reservationPremiumPayment,
              },
            })
          : null;

      const riskState = store.getPortfolioState(bar.timestamp);
      const riskReport = riskManager.evaluateEntry({
        limits: scenario.riskLimits,
        portfolio: riskState,
        snapshot,
        venueSelection: venueSel,
      });

      let selectedAction = "WAIT";
      let actualCost: bigint | null = null;
      if (realizedDeltaThisBar !== null) {
        selectedAction = "EXIT_POSITION";
      } else if (
        adaptive.signal.action === "ENTER_LONG" &&
        venueSel.selectedVenue !== "NONE" &&
        alloc?.approved &&
        riskReport.allowed
      ) {
        const entryCost = chosenRoute.acquisitionCostPayment;
        if (cashBalance >= entryCost) {
          cashBalance -= entryCost;
          store.recordDexPosition({
            inventoryToken: scenario.inventoryToken,
            paymentToken: scenario.paymentToken,
            quantity: scenario.targetAmount,
            entryCostPayment: entryCost,
            txHash: `0x${String(i + 1).padStart(64, "b")}`,
            nowSec: bar.timestamp,
          });
          selectedAction =
            venueSel.selectedVenue === "TRANCHE" ? "RESERVE_TRANCHE" : "SWAP_HSKSWAP";
          actualCost = entryCost;
        }
      } else if (adaptive.signal.action === "ENTER_LONG" && (!riskReport.allowed || alloc?.approved === false)) {
        selectedAction = "BLOCKED_RISK";
      }

      const bothEligible = venueSel.tranche.eligible && venueSel.hskswap.eligible;
      const venueOptimal =
        bothEligible && venueSel.selectedVenue !== "NONE"
          ? venueSel.selectedVenue === "TRANCHE"
            ? venueSel.tranche.acquisitionCostPayment <= venueSel.hskswap.acquisitionCostPayment
            : venueSel.hskswap.acquisitionCostPayment <= venueSel.tranche.acquisitionCostPayment
          : null;
      const costImprovement =
        bothEligible && venueSel.selectedVenue !== "NONE"
          ? venueSel.selectedVenue === "TRANCHE" &&
            venueSel.hskswap.acquisitionCostPayment > venueSel.tranche.acquisitionCostPayment
            ? venueSel.hskswap.acquisitionCostPayment - venueSel.tranche.acquisitionCostPayment
            : venueSel.selectedVenue === "HSKSWAP" &&
                venueSel.tranche.acquisitionCostPayment > venueSel.hskswap.acquisitionCostPayment
              ? venueSel.tranche.acquisitionCostPayment - venueSel.hskswap.acquisitionCostPayment
              : 0n
          : 0n;

      evaluator.recordManual({
        cycleId: i + 1,
        decisionKey: `replay:${i + 1}:${venueSel.selectedVenue}`,
        timestamp: bar.timestamp,
        dataProvenance: "REPLAY",
        marketRegime,
        spotPriceX36: bar.spotPriceX36,
        twapPriceX36: bar.twapPriceX36,
        poolLiquidity: bar.poolLiquidity,
        strategySelected: adaptive.selectedStrategyType,
        signalAction: adaptive.signal.action,
        portfolioCommittedPayment: portSnap.totalCommittedCapitalPayment,
        portfolioAvailablePayment: portSnap.availableCapitalForAllocationPayment,
        allocationApproved: alloc ? alloc.approved : null,
        selectedVenue: venueSel.selectedVenue,
        trancheEligible: venueSel.tranche.eligible,
        hskswapEligible: venueSel.hskswap.eligible,
        expectedExecutionCostPayment:
          venueSel.selectedVenue === "NONE" ? 0n : chosenRoute.acquisitionCostPayment,
        actualExecutionCostPayment: actualCost,
        realizedSlippageBps:
          selectedAction === "SWAP_HSKSWAP" ? bar.dexBuyImpactBps : null,
        expectedCostImprovementPayment: costImprovement,
        venueSelectionOptimal: venueOptimal,
        riskAllowed: riskReport.allowed,
        failedRiskChecks: riskReport.failedChecks.map((c) => c.name),
        selectedAction,
        rejectedOpportunities: [
          ...adaptive.unsuitableReasons,
          ...(alloc && !alloc.approved ? alloc.rejectionReasons : []),
          ...riskReport.failedChecks.map((c) => `risk:${c.name}`),
        ],
        tradeOutcomePayment: realizedDeltaThisBar,
        isDuplicateAttempt: false,
        isMissedExecution: false,
      });
    }

    return {
      scenarioName: scenario.name,
      dataProvenance: "REPLAY",
      barsProcessed: scenario.bars.length,
      metrics: evaluator.computeMetrics(scenario.initialBalancePayment),
      decisions: [...evaluator.getRecords()],
    };
  }
}
