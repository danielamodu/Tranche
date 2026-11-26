import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Address } from "viem";
import { AdaptiveStrategyEngine, type AdaptiveStrategyConfig } from "../src/adaptive-strategy.js";
import {
  DecisionEvaluationEngine,
  HistoricalReplayEngine,
  type ReplayBar,
} from "../src/evaluation.js";
import { PRICE_SCALE } from "../src/hskswap.js";
import {
  LocalRuleBasedLlmProvider,
  sanitizeRawLlmPatch,
  type PolicyValidationBounds,
} from "../src/llm.js";
import type { MarketSnapshot } from "../src/market.js";
import {
  PortfolioIntelligenceEngine,
  computePearsonCorrelation,
  type PortfolioConstraints,
} from "../src/portfolio.js";
import { PositionLifecycleManager } from "../src/position-manager.js";
import { PositionStore } from "../src/positions.js";
import { TransactionReconciler } from "../src/reconciler.js";
import type { RiskLimits } from "../src/risk.js";
import type { StrategyConfig } from "../src/strategy.js";
import { VenueSelector, type VenueSelectionConstraints } from "../src/venue.js";

const WHSK = "0xB210D2120d57b758EE163cFfb43e73728c471Cf1" as Address;
const WETH = "0xefd4bC9afD210517803f293ABABd701CaeeCdfd0" as Address;
const USDT = "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029" as Address;

const BASE_STRATEGY: StrategyConfig = {
  type: "price_threshold",
  momentumThresholdBps: 80,
  maxEntryPriceX36: 85n * 10n ** 21n,
  minVolatilityBps: 20,
  maxVolatilityBps: 800,
  dislocationThresholdBps: 40,
  takeProfitBps: 500,
  stopLossBps: 300,
  takeProfitExitBps: 10_000,
  ticketExerciseWindowSec: 300,
};

const BASE_ADAPTIVE_CFG: AdaptiveStrategyConfig = {
  enabled: true,
  baseStrategy: BASE_STRATEGY,
  minPoolLiquidity: 1_000_000n,
  maxOracleAgeSec: 60,
  maxOracleDeviationBps: 250,
  maxPositiveTwapDislocationBps: 200,
  hardBounds: {
    minTakeProfitBps: 100,
    maxTakeProfitBps: 2000,
    minStopLossBps: 100,
    maxStopLossBps: 1000,
    hardMaxVolatilityBps: 1200,
  },
};

const BASE_PORTFOLIO_CONSTRAINTS: PortfolioConstraints = {
  maxAssetAllocationBps: 4000, // 40%
  maxCorrelatedGroupAllocationBps: 6000, // 60%
  minAvailableCapitalReservePayment: 10_000_000n, // $10 reserve
  minExpectedPortfolioEdgePayment: 100_000n, // $0.10 min edge
  correlationGroups: {
    L1_BETA: [WHSK, WETH],
  },
};

function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  const spot = 80n * 10n ** 21n;
  const target = 100n * 10n ** 18n;
  return {
    timestamp: 1_750_000_100,
    inventoryToken: WHSK,
    paymentToken: USDT,
    targetAmount: target,
    pool: {
      venue: "HSKSwapV3",
      poolAddress: "0x0000000000000000000000000000000000000001",
      token0: WHSK,
      token1: USDT,
      fee: 3000,
      liquidity: 50_000_000n,
      sqrtPriceX96: 1n << 96n,
      tick: 0,
      observationCardinality: 64,
      spotPriceX36: spot,
      twapPriceX36: spot,
      timestamp: 1_750_000_095,
    },
    dexBuyQuote: {
      venue: "HSKSwapV3",
      inventoryToken: WHSK,
      paymentToken: USDT,
      inventoryAmountOut: target,
      paymentAmountIn: 8_250_000n,
      effectiveUnitPriceX36: (8_250_000n * PRICE_SCALE) / target,
      priceImpactBps: 45,
      gasEstimate: 120_000n,
    },
    dexSellQuote: {
      venue: "HSKSwapV3",
      inventoryToken: WHSK,
      paymentToken: USDT,
      inventoryAmountIn: target,
      paymentAmountOut: 8_150_000n,
      effectiveUnitPriceX36: (8_150_000n * PRICE_SCALE) / target,
      priceImpactBps: 30,
      gasEstimate: 120_000n,
    },
    oracle: { priceX36: spot, updatedAt: 1_750_000_095, isValid: true },
    oracleAgeSec: 5,
    oracleDeviationBps: 10,
    trancheOffers: {
      timestamp: 1_750_000_100,
      discoveredOffers: [],
      evaluations: [],
      selected: {
        offerId: 1n,
        eligible: true,
        rejectionReasons: [],
        priceMode: 0,
        availableCapacity: target,
        quotedGrossPremium: 40_000n,
        quotedExerciseCost: 8_050_000n,
        effectiveAllInUnitCostX36: (8_090_000n * PRICE_SCALE) / target,
        expiresAt: 1_750_086_500,
      },
    },
    realizedVolatilityBps: 60,
    momentumReturnBps: 15,
    dislocationVsTwapBps: -5,
    marketRegime: "CALM",
    anomalies: [],
    dataSourceHealthy: true,
    ...overrides,
  };
}

describe("Tranche Agent Intelligence Upgrade — Regression & Adversarial Suite", () => {
  it("1 & 2. Portfolio capital allocation, per-asset concentration, and correlated group exposure", () => {
    const store = new PositionStore(undefined, 1_750_000_000);
    // Open $30 WETH position
    store.recordDexPosition({
      inventoryToken: WETH,
      paymentToken: USDT,
      quantity: 10n ** 16n,
      entryCostPayment: 30_000_000n,
      txHash: `0x${"1".repeat(64)}`,
      nowSec: 1_750_000_000,
    });

    const engine = new PortfolioIntelligenceEngine();
    const snap = engine.buildSnapshot({
      store,
      nowSec: 1_750_000_050,
      availableBalancePayment: 70_000_000n, // $70 cash + $30 WETH = $100 equity
      constraints: BASE_PORTFOLIO_CONSTRAINTS,
      assetReturnSeriesBps: {
        [WHSK.toLowerCase()]: [10, 20, -15, 30, 25, -10],
        [WETH.toLowerCase()]: [12, 18, -12, 28, 22, -8],
      },
    });

    assert.equal(snap.totalEquityPayment, 100_000_000n);
    assert.equal(snap.availableCapitalForAllocationPayment, 60_000_000n); // $70 - $10 reserve
    assert.equal(snap.correlatedExposures.length, 1);
    assert.equal(snap.correlatedExposures[0]!.correlationStatus, "COMPUTED");
    assert.ok((snap.correlatedExposures[0]!.empiricalCorrelation ?? 0) > 0.95);

    // Request $45 in WHSK -> correlated group L1_BETA cap is 60% ($60), already $30 in WETH -> headroom $30
    const alloc = engine.evaluateAllocation({
      snapshot: snap,
      constraints: BASE_PORTFOLIO_CONSTRAINTS,
      request: {
        inventoryToken: WHSK,
        requestedAmountInventory: 450n * 10n ** 18n,
        estimatedAcquisitionCostPayment: 45_000_000n,
        expectedNetProfitPayment: 2_000_000n,
      },
    });
    assert.equal(alloc.approved, true);
    assert.equal(alloc.recommendedCostPayment, 30_000_000n); // scaled down to correlated headroom
    assert.equal(alloc.recommendedAmountInventory, 300n * 10n ** 18n);

    // Insufficient correlation sample returns null
    assert.equal(computePearsonCorrelation([1, 2], [1, 2], 5), null);
  });

  it("3. Duplicate capital accounting prevention across positions, tickets, and pending txs", () => {
    const store = new PositionStore(undefined, 1_750_000_000);
    store.recordReservedTicket({
      ticketId: 7n,
      offerId: 1n,
      inventoryToken: WHSK,
      paymentToken: USDT,
      inventoryAmount: 100n * 10n ** 18n,
      remainingAmount: 100n * 10n ** 18n,
      premiumPaidPayment: 500_000n, // $0.50 sunk premium
      expiresAt: 1_750_003_600,
      reservedAt: 1_750_000_000,
      status: "ACTIVE",
      reserveTxHash: `0x${"2".repeat(64)}`,
      exerciseTxHashes: [],
    });
    store.beginPendingTx({
      id: "ptx-1",
      decisionKey: "dk-1",
      action: "SWAP_HSKSWAP",
      createdAt: 1_750_000_010,
    });

    const engine = new PortfolioIntelligenceEngine();
    const snap = engine.buildSnapshot({
      store,
      nowSec: 1_750_000_020,
      availableBalancePayment: 50_000_000n,
      constraints: BASE_PORTFOLIO_CONSTRAINTS,
      ticketExerciseObligations: new Map([[7n, 8_000_000n]]),
      // Pass duplicate pending reservation entries + an unknown stale pendingTxId
      pendingReservations: [
        { pendingTxId: "ptx-1", inventoryToken: WHSK, reservedPayment: 5_000_000n },
        { pendingTxId: "ptx-1", inventoryToken: WHSK, reservedPayment: 5_000_000n },
        { pendingTxId: "stale-nonexistent", inventoryToken: WHSK, reservedPayment: 9_000_000n },
      ],
    });

    // Pending reserved must be counted strictly once ($5), stale ignored, sunk premium NOT double-counted
    assert.equal(snap.pendingTxReservedPayment, 5_000_000n);
    assert.equal(snap.activeTicketsExerciseObligationPayment, 8_000_000n);
    assert.equal(snap.totalCommittedCapitalPayment, 13_000_000n);
    // Available = $50 - $8 (ticket obligation) - $5 (pending) - $10 (reserve floor) = $27
    assert.equal(snap.availableCapitalForAllocationPayment, 27_000_000n);
  });

  it("4 & 5. Regime-dependent adaptive strategy selection and stale/unsuitable market gating", () => {
    const adaptive = new AdaptiveStrategyEngine();

    // TRENDING -> momentum
    const trending = adaptive.evaluate(
      makeSnapshot({ marketRegime: "TRENDING", momentumReturnBps: 140 }),
      BASE_ADAPTIVE_CFG,
    );
    assert.equal(trending.suitableForTrading, true);
    assert.equal(trending.selectedStrategyType, "momentum");
    assert.equal(trending.signal.action, "ENTER_LONG");

    // DISLOCATED (negative discount vs TWAP) -> volatility_aware with tightened bounded stop-loss
    const dislocated = adaptive.evaluate(
      makeSnapshot({
        marketRegime: "DISLOCATED",
        realizedVolatilityBps: 120,
        dislocationVsTwapBps: -180,
      }),
      BASE_ADAPTIVE_CFG,
    );
    assert.equal(dislocated.suitableForTrading, true);
    assert.equal(dislocated.selectedStrategyType, "volatility_aware");
    assert.ok(dislocated.effectiveConfig.stopLossBps < BASE_STRATEGY.stopLossBps);
    assert.ok(dislocated.effectiveConfig.stopLossBps >= BASE_ADAPTIVE_CFG.hardBounds.minStopLossBps);

    // Stale oracle -> unsuitable -> NONE / WAIT
    const stale = adaptive.evaluate(
      makeSnapshot({ oracleAgeSec: 120 }),
      BASE_ADAPTIVE_CFG,
    );
    assert.equal(stale.suitableForTrading, false);
    assert.equal(stale.selectedStrategyType, "NONE");
    assert.equal(stale.signal.action, "WAIT");
    assert.ok(stale.unsuitableReasons.some((r) => r.startsWith("ORACLE_STALE")));

    // Overheated positive TWAP dislocation -> unsuitable -> NONE
    const overheated = adaptive.evaluate(
      makeSnapshot({ dislocationVsTwapBps: 350 }),
      BASE_ADAPTIVE_CFG,
    );
    assert.equal(overheated.suitableForTrading, false);
    assert.equal(overheated.selectedStrategyType, "NONE");
  });

  it("6. Cross-venue comparison under thin liquidity, stale quotes, exit gas, and venue failure history", () => {
    const selector = new VenueSelector();
    const baseConstraints: VenueSelectionConstraints = {
      maxAllInCostX36: 95n * 10n ** 21n,
      maxSlippageBps: 100,
      minExpectedNetProfitPayment: 100_000n,
      maxOptionOverheadBps: 100,
      trancheGasCostPayment: 20_000n,
      dexGasCostPayment: 10_000n,
      dexExitGasCostPayment: 10_000n,
      maxQuoteAgeSec: 30,
    };

    // High AMM slippage on thin pool -> TRANCHE selected with structured evidence
    const res1 = selector.selectVenue(makeSnapshot(), BASE_STRATEGY, baseConstraints);
    assert.equal(res1.selectedVenue, "TRANCHE");
    assert.ok(res1.evidence);
    assert.ok(res1.evidence!.costAdvantagePayment > 0n);

    // Stale quote -> NONE
    const staleSnap = makeSnapshot({ timestamp: 1_750_000_200 }); // pool.timestamp is 1_750_000_095 (105s old)
    const resStale = selector.selectVenue(staleSnap, BASE_STRATEGY, baseConstraints);
    assert.equal(resStale.selectedVenue, "NONE");
    assert.ok(resStale.tranche.rejectionReasons.some((r) => r.startsWith("STALE_QUOTE")));

    // High measurable Tranche failure rate (3/4 = 75%) -> falls back to HSKSWAP
    const resFailRate = selector.selectVenue(makeSnapshot(), BASE_STRATEGY, {
      ...baseConstraints,
      venueFailureStats: { TRANCHE: { attempts: 4, failures: 3 } },
      maxVenueFailureRateBps: 4000,
    });
    assert.equal(resFailRate.selectedVenue, "HSKSWAP");
    assert.ok(resFailRate.tranche.rejectionReasons.some((r) => r.startsWith("HIGH_FAILURE_RATE")));
  });

  it("7 & 8. Position lifecycle management, fee-aware exits, state integrity, and reconciler gating", async () => {
    const store = new PositionStore(undefined, 1_750_000_000);
    const pos = store.recordDexPosition({
      inventoryToken: WHSK,
      paymentToken: USDT,
      quantity: 100n * 10n ** 18n,
      entryCostPayment: 10_000_000n,
      txHash: `0x${"3".repeat(64)}`,
      nowSec: 1_750_000_000,
    });
    const manager = new PositionLifecycleManager();

    // Exit quote is $10.52 (+520 bps), but exit gas is $0.05 -> net $10.47 (+470 bps < 500 bps TP) -> HOLD
    const evalGas = manager.evaluatePositionExitWithCosts({
      position: pos,
      executableExitPayment: 10_520_000n,
      estimatedExitGasPayment: 50_000n,
      pendingTxCount: 0,
      strategyConfig: BASE_STRATEGY,
    });
    assert.equal(evalGas.decision.action, "HOLD");
    assert.equal(evalGas.netExecutableExitPayment, 10_470_000n);

    // Unresolved pending tx blocks exit & flags critical integrity issue
    store.beginPendingTx({
      id: "ptx-block",
      decisionKey: "dk-block",
      action: "EXIT_POSITION",
      createdAt: 1_750_000_050,
      txHash: `0x${"4".repeat(64)}`,
    });
    const evalBlocked = manager.evaluatePositionExitWithCosts({
      position: pos,
      executableExitPayment: 12_000_000n,
      estimatedExitGasPayment: 50_000n,
      pendingTxCount: store.getPendingTxs().length,
      strategyConfig: BASE_STRATEGY,
    });
    assert.equal(evalBlocked.blockedByPendingTx, true);
    assert.equal(evalBlocked.decision.action, "HOLD");

    const integrity = manager.auditStateIntegrity(store, 1_750_000_060);
    assert.equal(integrity.healthy, false);
    assert.equal(integrity.pendingTxBlocking, true);

    // Reconciler proves receipt confirmed -> clears pending tx
    const reconciler = new TransactionReconciler({
      getChainId: async () => 177,
      getTransactionReceipt: async () =>
        ({ status: "success", blockNumber: 123n, gasUsed: 90_000n }) as never,
      getTransactionCount: async () => 1,
    });
    const rec = await reconciler.reconcile(store.getPendingTxs()[0]!);
    assert.equal(rec.status, "CONFIRMED");
    assert.equal(rec.canClearPending, true);
  });

  it("10. LLM malformed, adversarial, and out-of-bounds outputs are strictly rejected", async () => {
    const bounds: PolicyValidationBounds = {
      hardMaxPositionSizeInventory: 200n * 10n ** 18n,
      hardMaxSlippageBps: 150,
      minStopLossBps: 100,
      maxStopLossBps: 1000,
      minTakeProfitBps: 100,
      maxTakeProfitBps: 2000,
    };

    // Malformed non-object
    const malformed = sanitizeRawLlmPatch("DROP TABLE; killSwitch=false", bounds);
    assert.equal(malformed.valid, false);
    assert.deepEqual(malformed.sanitizedPatch, {});

    // Adversarial payload attempting to clear killSwitch, inject privateKey, and breach slippage cap
    const adv = sanitizeRawLlmPatch(
      {
        killSwitch: false,
        privateKey: "0xdeadbeef",
        signTransaction: true,
        maxSlippageBps: 9999,
        takeProfitBps: 600,
      },
      bounds,
    );
    assert.equal(adv.valid, false);
    assert.ok(adv.rejectedFields.some((f) => f.includes("killSwitch")));
    assert.ok(adv.rejectedFields.some((f) => f.includes("privateKey")));
    assert.ok(adv.rejectedFields.some((f) => f.includes("maxSlippageBps")));
    assert.equal(adv.sanitizedPatch.takeProfitBps, 600);

    // Bounded recommendations strictly require explicit approval & avoid noisy updates on small sample
    const llm = new LocalRuleBasedLlmProvider();
    const evalEngine = new DecisionEvaluationEngine("REPLAY");
    const smallSummary = evalEngine.computeMetrics();
    const rec = await llm.proposeBoundedAdjustments({
      evaluation: smallSummary,
      currentStrategy: BASE_STRATEGY,
      currentLimits: {
        maxPositionSizeInventory: 200n * 10n ** 18n,
        maxTotalExposurePayment: 50_000_000n,
        maxDailyPremiumBudgetPayment: 1_000_000n,
        maxDailyRealizedLossPayment: 5_000_000n,
        maxConcurrentPositions: 3,
        maxConcurrentTickets: 3,
        maxSlippageBps: 100,
        minPoolLiquidity: 1_000_000n,
        maxOracleAgeSec: 60,
        maxOracleDeviationBps: 300,
        paused: false,
        killSwitch: false,
      },
      bounds,
    });
    assert.equal(rec.requiresExplicitApproval, true);
    assert.equal(rec.autoApplied, false);
    assert.deepEqual(rec.proposedPatch, {});
  });

  it("11. Historical replay determinism produces identical REPLAY metrics and decisions", () => {
    const bars: ReplayBar[] = [
      {
        timestamp: 1_750_000_000,
        spotPriceX36: 80n * 10n ** 21n,
        twapPriceX36: 80n * 10n ** 21n,
        poolLiquidity: 50_000_000n,
        dexBuyCostPayment: 8_250_000n,
        dexBuyImpactBps: 50,
        dexSellProceedsPayment: 8_000_000n,
        dexSellImpactBps: 30,
        trancheOfferCostPayment: 8_020_000n,
        tranchePremiumPayment: 40_000n,
      },
      {
        timestamp: 1_750_000_060,
        spotPriceX36: 86n * 10n ** 21n,
        twapPriceX36: 82n * 10n ** 21n,
        poolLiquidity: 50_000_000n,
        dexBuyCostPayment: 8_800_000n,
        dexBuyImpactBps: 40,
        dexSellProceedsPayment: 8_600_000n,
        dexSellImpactBps: 25,
      },
    ];

    const limits: RiskLimits = {
      maxPositionSizeInventory: 200n * 10n ** 18n,
      maxTotalExposurePayment: 50_000_000n,
      maxDailyPremiumBudgetPayment: 2_000_000n,
      maxDailyRealizedLossPayment: 5_000_000n,
      maxConcurrentPositions: 3,
      maxConcurrentTickets: 3,
      maxSlippageBps: 100,
      minPoolLiquidity: 1_000_000n,
      maxOracleAgeSec: 60,
      maxOracleDeviationBps: 300,
      paused: false,
      killSwitch: false,
    };

    const replayEngine = new HistoricalReplayEngine();
    const scenario = {
      name: "whsk-deterministic-replay",
      inventoryToken: WHSK,
      paymentToken: USDT,
      targetAmount: 100n * 10n ** 18n,
      initialBalancePayment: 50_000_000n,
      bars,
      strategyConfig: BASE_STRATEGY,
      adaptiveConfig: BASE_ADAPTIVE_CFG,
      venueConstraints: {
        maxAllInCostX36: 90n * 10n ** 21n,
        maxSlippageBps: 100,
        minExpectedNetProfitPayment: 100_000n,
        maxOptionOverheadBps: 100,
        trancheGasCostPayment: 10_000n,
        dexGasCostPayment: 10_000n,
        dexExitGasCostPayment: 10_000n,
      },
      portfolioConstraints: BASE_PORTFOLIO_CONSTRAINTS,
      riskLimits: limits,
    };

    const run1 = replayEngine.runScenarioReplay(scenario);
    const run2 = replayEngine.runScenarioReplay(scenario);

    assert.equal(run1.dataProvenance, "REPLAY");
    assert.deepEqual(run1.metrics, run2.metrics);
    assert.deepEqual(run1.decisions, run2.decisions);
    assert.equal(run1.metrics.closedTradesCount, 1);
    assert.ok(run1.metrics.netPnlAfterFeesPayment > 0n);
    assert.equal(run1.metrics.sharpeRatio, null); // < 5 trades -> never fabricated
  });

  it("12. Restart recovery preserves positions, pending txs, policy version, and kill switch", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tranche-intel-restart-"));
    const stateFile = path.join(tmpDir, "agent-state.json");

    const store1 = new PositionStore(stateFile, 1_750_000_000);
    store1.recordDexPosition({
      inventoryToken: WHSK,
      paymentToken: USDT,
      quantity: 100n * 10n ** 18n,
      entryCostPayment: 8_100_000n,
      txHash: `0x${"9".repeat(64)}`,
      nowSec: 1_750_000_000,
    });
    store1.beginPendingTx({
      id: "ptx-restart",
      decisionKey: "dk-restart",
      action: "SWAP_HSKSWAP",
      createdAt: 1_750_000_010,
    });
    store1.saveRuntimeConfig(
      BASE_STRATEGY,
      {
        maxPositionSizeInventory: 200n * 10n ** 18n,
        maxTotalExposurePayment: 50_000_000n,
        maxDailyPremiumBudgetPayment: 1_000_000n,
        maxDailyRealizedLossPayment: 5_000_000n,
        maxConcurrentPositions: 3,
        maxConcurrentTickets: 3,
        maxSlippageBps: 100,
        minPoolLiquidity: 1_000_000n,
        maxOracleAgeSec: 60,
        maxOracleDeviationBps: 300,
        paused: true,
        killSwitch: true,
      },
      { source: "api", instruction: "kill_switch" },
    );

    const store2 = new PositionStore(stateFile, 1_750_000_100);
    assert.equal(store2.isStateCorrupted(), false);
    assert.equal(store2.getOpenPositions().length, 1);
    assert.equal(store2.getPendingTxs().length, 1);
    assert.equal(store2.getPersistedRuntimeConfig()?.riskLimits.killSwitch, true);
    assert.equal(store2.getPersistedRuntimeConfig()?.riskLimits.paused, true);
  });
});
