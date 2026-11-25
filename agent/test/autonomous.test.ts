import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Address, Hex } from "viem";
import {
  OfferStatus,
  PriceMode,
  type DiscoveredOffer,
  type TrancheClient,
} from "@tranche/sdk";
import { TrancheExecutionAgent } from "../src/agent.js";
import {
  PRICE_SCALE,
  tickToPriceX36,
  type DexBuyQuote,
  type DexPoolState,
  type DexSellQuote,
  type DexSwapExecution,
  type DexVenueAdapter,
} from "../src/hskswap.js";
import {
  LocalRuleBasedLlmProvider,
  applyValidatedPolicyPatch,
  validatePolicyPatch,
} from "../src/llm.js";
import { MarketIntelligence, type OracleReader, type OracleReading } from "../src/market.js";
import { PositionStore } from "../src/positions.js";
import type { RiskLimits } from "../src/risk.js";
import { AgentRuntime, TrancheAutonomousAgent } from "../src/runtime.js";
import type { StrategyConfig } from "../src/strategy.js";
import type { AgentIntent } from "../src/types.js";
import type { VenueSelectionConstraints } from "../src/venue.js";

const INV_TOKEN = "0xB210D2120d57b758EE163cFfb43e73728c471Cf1" as Address; // WHSK (18 dec)
const PAY_TOKEN = "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029" as Address; // USDT (6 dec)
const POOL_ADDR = "0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC" as Address;
const AGENT_ADDR = "0x1111111111111111111111111111111111111111" as Address;
const LP_ADDR = "0x2222222222222222222222222222222222222222" as Address;

// 100 WHSK @ $0.085 = 8.50 USDT (8_500_000 raw 6-dec) -> priceX36 = 85e21
const TARGET_QTY = 100n * 10n ** 18n;
const SPOT_0085 = 85n * 10n ** 21n;

class FixtureDexVenue implements DexVenueAdapter {
  public readonly name = "HSKSwapV3-Fixture";
  public spotPriceX36 = SPOT_0085;
  public twapPriceX36: bigint | null = SPOT_0085;
  public liquidity = 1_000_000_000_000_000_000n;
  public buyCostPayment = 8_800_000n; // $8.80 for 100 WHSK (397 bps round-trip spread < 500 bps anomaly ceiling)
  public buyImpactBps = 35;
  public sellProceedsPayment = 8_450_000n; // $8.45 exit for 100 WHSK
  public sellImpactBps = 30;
  public swapCounter = 0;
  public failNextSwap = false;
  public failNextPoolRead = false;
  public executedSwaps: Array<{ tokenIn: Address; tokenOut: Address; amountIn: bigint }> = [];

  async getPoolState(): Promise<DexPoolState> {
    if (this.failNextPoolRead) {
      this.failNextPoolRead = false;
      throw new Error("Transient RPC 429");
    }
    return {
      venue: this.name,
      poolAddress: POOL_ADDR,
      token0: INV_TOKEN,
      token1: PAY_TOKEN,
      fee: 3000,
      liquidity: this.liquidity,
      sqrtPriceX96: 1n << 96n,
      tick: -301484,
      observationCardinality: 240,
      spotPriceX36: this.spotPriceX36,
      twapPriceX36: this.twapPriceX36,
      timestamp: 1_700_000_000,
    };
  }

  async quoteBuyInventory(
    inventoryToken: Address,
    paymentToken: Address,
    inventoryAmountOut: bigint,
  ): Promise<DexBuyQuote> {
    const scaledIn = (this.buyCostPayment * inventoryAmountOut) / TARGET_QTY;
    return {
      venue: this.name,
      inventoryToken,
      paymentToken,
      inventoryAmountOut,
      paymentAmountIn: scaledIn,
      effectiveUnitPriceX36: (scaledIn * PRICE_SCALE) / inventoryAmountOut,
      priceImpactBps: this.buyImpactBps,
      gasEstimate: 85_000n,
    };
  }

  async quoteSellInventory(
    inventoryToken: Address,
    paymentToken: Address,
    inventoryAmountIn: bigint,
  ): Promise<DexSellQuote> {
    const scaledOut = (this.sellProceedsPayment * inventoryAmountIn) / TARGET_QTY;
    return {
      venue: this.name,
      inventoryToken,
      paymentToken,
      inventoryAmountIn,
      paymentAmountOut: scaledOut,
      effectiveUnitPriceX36: (scaledOut * PRICE_SCALE) / inventoryAmountIn,
      priceImpactBps: this.sellImpactBps,
      gasEstimate: 85_000n,
    };
  }

  async executeSwapExactInput(params: {
    tokenIn: Address;
    tokenOut: Address;
    fee: number;
    amountIn: bigint;
    amountOutMinimum: bigint;
    recipient: Address;
  }): Promise<DexSwapExecution> {
    if (this.failNextSwap) {
      this.failNextSwap = false;
      throw new Error("SwapRouter02: Too little received");
    }
    this.swapCounter += 1;
    this.executedSwaps.push({
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
    });
    const isBuy = params.tokenOut.toLowerCase() === INV_TOKEN.toLowerCase();
    const amountOut = isBuy
      ? TARGET_QTY
      : (this.sellProceedsPayment * params.amountIn) / TARGET_QTY;
    if (amountOut < params.amountOutMinimum) {
      throw new Error(`Slippage: ${amountOut} < ${params.amountOutMinimum}`);
    }
    return {
      venue: this.name,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
      amountOut,
      txHash: `0x${this.swapCounter.toString(16).padStart(64, "a")}` as Hex,
      blockNumber: BigInt(100 + this.swapCounter),
      gasUsed: 110_000n,
    };
  }
}

class FixtureTrancheClient {
  public offers: DiscoveredOffer[] = [];
  public reservePremium = 50_000n; // $0.05
  public exercisePayment = 8_500_000n; // $8.50
  public failNextReserve = false;
  public failNextExercise = false;
  public nextTicketId = 1n;
  public tickets = new Map<
    bigint,
    {
      offerId: bigint;
      expiresAt: number;
      remainingAmount: bigint;
      status: number;
    }
  >();

  async discoverOffers(): Promise<DiscoveredOffer[]> {
    return this.offers;
  }

  async quoteReservation() {
    return { grossPremium: this.reservePremium, protocolFee: 250n };
  }

  async quoteExercise(ticketId: bigint, fillAmount: bigint) {
    const t = this.tickets.get(ticketId);
    const actualFill = fillAmount === 0n ? (t?.remainingAmount ?? TARGET_QTY) : fillAmount;
    const grossPayment = (this.exercisePayment * actualFill) / TARGET_QTY;
    return {
      actualFill,
      grossPayment,
      effPriceX36: (grossPayment * PRICE_SCALE) / actualFill,
    };
  }

  async getTicket(ticketId: bigint) {
    const t = this.tickets.get(ticketId);
    return {
      offerId: t?.offerId ?? 1n,
      reservedAt: 1_700_000_000,
      expiresAt: t?.expiresAt ?? 1_700_003_600,
      priceMode: PriceMode.FIXED,
      status: t?.status ?? 1, // ACTIVE
      spreadBps: 0,
      protocolFeeBps: 5,
      lp: LP_ADDR,
      inventoryToken: INV_TOKEN,
      paymentToken: PAY_TOKEN,
      oracle: "0x0000000000000000000000000000000000000000" as Address,
      complianceHook: "0x0000000000000000000000000000000000000000" as Address,
      initialAmount: TARGET_QTY,
      remainingAmount: t?.remainingAmount ?? TARGET_QTY,
      minFillAmount: 10n * 10n ** 18n,
      fixedOrMinPriceX36: SPOT_0085,
      maxPriceX36: 0n,
    };
  }

  async reserve(offerId: bigint, amount: bigint, duration: number) {
    if (this.failNextReserve) {
      this.failNextReserve = false;
      throw new Error("CommitmentManager: InsufficientOfferBalance");
    }
    const ticketId = this.nextTicketId++;
    const expiresAt = 1_700_000_000 + duration;
    this.tickets.set(ticketId, {
      offerId,
      expiresAt,
      remainingAmount: amount,
      status: 1,
    });
    return {
      hash: `0x${ticketId.toString(16).padStart(64, "b")}` as Hex,
      blockNumber: 200n,
      gasUsed: 180_000n,
      ticketId,
      expiresAt,
      grossPremium: this.reservePremium,
    };
  }

  async exercise(params: { ticketId: bigint; fillAmount: bigint }) {
    if (this.failNextExercise) {
      this.failNextExercise = false;
      throw new Error("CommitmentManager: SlippageExceeded");
    }
    const q = await this.quoteExercise(params.ticketId, params.fillAmount);
    const t = this.tickets.get(params.ticketId);
    if (t) {
      t.remainingAmount = t.remainingAmount > q.actualFill ? t.remainingAmount - q.actualFill : 0n;
      if (t.remainingAmount === 0n) t.status = 2; // EXERCISED
    }
    return {
      hash: `0x${params.ticketId.toString(16).padStart(64, "c")}` as Hex,
      blockNumber: 205n,
      gasUsed: 160_000n,
      parsed: q,
    };
  }

  async reclaimExpired(ticketId: bigint) {
    const t = this.tickets.get(ticketId);
    if (t) {
      t.status = 3; // RECLAIMED
      t.remainingAmount = 0n;
    }
    return {
      hash: `0x${ticketId.toString(16).padStart(64, "d")}` as Hex,
      blockNumber: 210n,
      gasUsed: 90_000n,
    };
  }

  publicClient = {
    getBlock: async () => ({ timestamp: 1_700_000_000n }),
  };
}

function makeFixedOffer(offerId: bigint, priceX36: bigint): DiscoveredOffer {
  return {
    offerId,
    availableBalance: 500n * 10n ** 18n,
    lp: LP_ADDR,
    createdAt: 1_699_990_000,
    expiry: 1_700_500_000,
    priceMode: PriceMode.FIXED,
    status: OfferStatus.ACTIVE,
    inventoryToken: INV_TOKEN,
    minDuration: 60,
    maxDuration: 86_400,
    basePremiumBps: 50,
    dailyPremiumBps: 10,
    paymentToken: PAY_TOKEN,
    spreadBps: 0,
    protocolFeeBps: 5,
    oracle: "0x0000000000000000000000000000000000000000" as Address,
    complianceHook: "0x0000000000000000000000000000000000000000" as Address,
    minFillAmount: 10n * 10n ** 18n,
    fixedPriceX36: priceX36,
    minPriceX36: 0n,
    maxPriceX36: 0n,
  };
}

function buildHarness(overrides?: {
  strategy?: Partial<StrategyConfig>;
  limits?: Partial<RiskLimits>;
  constraints?: Partial<VenueSelectionConstraints>;
  oracle?: OracleReading;
  stateFile?: string;
}) {
  const dex = new FixtureDexVenue();
  const trancheClient = new FixtureTrancheClient();
  trancheClient.offers = [makeFixedOffer(1n, SPOT_0085)];
  const trancheAgent = new TrancheExecutionAgent(trancheClient as unknown as TrancheClient);

  const oracleState: OracleReading = overrides?.oracle ?? {
    priceX36: SPOT_0085,
    updatedAt: 1_699_999_990,
    isValid: true,
  };
  const oracleReader: OracleReader = {
    getPriceX36: async () => oracleState,
  };

  const riskLimits: RiskLimits = {
    maxPositionSizeInventory: 200n * 10n ** 18n,
    maxTotalExposurePayment: 50_000_000n, // $50
    maxDailyPremiumBudgetPayment: 500_000n, // $0.50
    maxDailyRealizedLossPayment: 5_000_000n, // $5.00
    maxConcurrentPositions: 3,
    maxConcurrentTickets: 3,
    maxSlippageBps: 100, // 1.00%
    minPoolLiquidity: 100_000_000_000n,
    maxOracleAgeSec: 60,
    maxOracleDeviationBps: 300,
    paused: false,
    killSwitch: false,
    ...overrides?.limits,
  };

  const strategyConfig: StrategyConfig = {
    type: "price_threshold",
    momentumThresholdBps: 100,
    maxEntryPriceX36: 90n * 10n ** 21n, // buy below $0.090
    minVolatilityBps: 50,
    maxVolatilityBps: 1000,
    dislocationThresholdBps: 50,
    takeProfitBps: 500, // +5%
    stopLossBps: 300, // -3%
    takeProfitExitBps: 10_000,
    ticketExerciseWindowSec: 300,
    ...overrides?.strategy,
  };

  const venueConstraints: VenueSelectionConstraints = {
    maxAllInCostX36: 95n * 10n ** 21n,
    maxSlippageBps: riskLimits.maxSlippageBps,
    minExpectedNetProfitPayment: 100_000n, // $0.10 minimum net edge
    maxOptionOverheadBps: 100,
    ...overrides?.constraints,
  };

  const intent: AgentIntent = {
    inventoryToken: INV_TOKEN,
    paymentToken: PAY_TOKEN,
    targetAmount: TARGET_QTY,
    desiredDuration: 3600,
    maxAllInCostX36: venueConstraints.maxAllInCostX36,
  };

  const market = new MarketIntelligence({
    dexVenue: dex,
    trancheAgent,
    oracleReader,
    poolAddress: POOL_ADDR,
    poolFee: 3000,
    minPoolLiquidity: riskLimits.minPoolLiquidity,
    maxOracleAgeSec: riskLimits.maxOracleAgeSec,
    maxOracleDeviationBps: riskLimits.maxOracleDeviationBps,
  });

  const positions = new PositionStore(overrides?.stateFile, 1_700_000_000);
  const agent = new TrancheAutonomousAgent({
    trancheAgent,
    dexVenue: dex,
    market,
    positions,
    recipient: AGENT_ADDR,
    poolFee: 3000,
    intent,
    strategyConfig,
    riskLimits,
    venueConstraints,
  });

  return { dex, trancheClient, oracleState, market, positions, agent };
}

test("1. Venue selection: selects TRANCHE when all-in cost ($8.55) beats HSKSwap ($8.80) and records full trace", async () => {
  const { agent, positions } = buildHarness();
  const trace = await agent.runCycle(1_700_000_000);

  assert.equal(trace.selectedAction, "RESERVE_TRANCHE");
  assert.equal(trace.venueSelection.selectedVenue, "TRANCHE");
  assert.equal(trace.venueSelection.tranche.acquisitionCostPayment, 8_550_000n);
  assert.equal(trace.venueSelection.hskswap.acquisitionCostPayment, 8_800_000n);
  assert.equal(trace.txHashes.length, 1);
  assert.equal(positions.getActiveTickets().length, 1);
  assert.equal(positions.getPortfolioState(1_700_000_000).dailyPremiumSpentPayment, 50_000n);
});

test("2. Venue selection: selects HSKSWAP when immediate DEX cost ($8.20) beats Tranche ($8.55)", async () => {
  const { agent, dex, positions } = buildHarness();
  dex.buyCostPayment = 8_200_000n; // $8.20 < $8.55 Tranche all-in
  const trace = await agent.runCycle(1_700_000_000);

  assert.equal(trace.selectedAction, "SWAP_HSKSWAP");
  assert.equal(trace.venueSelection.selectedVenue, "HSKSWAP");
  assert.equal(trace.txHashes.length, 1);
  assert.equal(positions.getOpenPositions().length, 1);
  assert.equal(positions.getOpenPositions()[0].venue, "HSKSWAP");
});

test("3. Venue selection: selects NEITHER (WAIT) when both routes fail strategy constraints", async () => {
  const { agent, dex } = buildHarness({
    constraints: { minExpectedNetProfitPayment: 5_000_000n }, // unreachable $5 edge on $8.50 trade
  });
  dex.buyCostPayment = 8_900_000n;
  const trace = await agent.runCycle(1_700_000_000);

  assert.equal(trace.selectedAction, "WAIT");
  assert.equal(trace.venueSelection.selectedVenue, "NONE");
  assert.ok(trace.venueSelection.tranche.rejectionReasons.some((r) => r.includes("INSUFFICIENT_NET_EDGE")));
  assert.ok(trace.venueSelection.hskswap.rejectionReasons.some((r) => r.includes("INSUFFICIENT_NET_EDGE")));
  assert.equal(trace.txHashes.length, 0);
});

test("4. Oracle guard: stale or invalid oracle data blocks execution", async () => {
  const { agent } = buildHarness({
    oracle: { priceX36: SPOT_0085, updatedAt: 1_699_999_000, isValid: true }, // 1000s old > 60s max
  });
  const trace = await agent.runCycle(1_700_000_000);

  assert.equal(trace.selectedAction, "WAIT");
  assert.equal(trace.signal.valid, false);
  assert.ok(trace.snapshot.anomalies.some((a) => a.startsWith("ORACLE_STALE")));
  assert.equal(trace.riskReport.allowed, false);
  assert.equal(trace.txHashes.length, 0);
});

test("5. Slippage guard: excessive HSKSwap slippage blocks DEX execution", async () => {
  const { agent, dex, trancheClient } = buildHarness();
  trancheClient.offers = []; // only HSKSwap available
  dex.buyCostPayment = 8_400_000n;
  dex.buyImpactBps = 250; // 2.5% > 1.0% maxSlippageBps
  const trace = await agent.runCycle(1_700_000_000);

  assert.equal(trace.selectedAction, "WAIT");
  assert.equal(trace.venueSelection.selectedVenue, "NONE");
  assert.ok(trace.venueSelection.hskswap.rejectionReasons.some((r) => r.includes("SLIPPAGE_EXCEEDED")));
});

test("6. Risk limits: non-refundable premium budget and exposure caps block execution", async () => {
  const { agent } = buildHarness({
    limits: { maxDailyPremiumBudgetPayment: 20_000n }, // $0.02 cap < $0.05 premium
  });
  const trace = await agent.runCycle(1_700_000_000);

  assert.equal(trace.selectedAction, "BLOCKED_RISK");
  assert.equal(trace.riskReport.allowed, false);
  assert.ok(trace.riskReport.failedChecks.some((c) => c.name === "daily_premium_budget"));
  assert.equal(trace.txHashes.length, 0);
});

test("7. Failure handling: reservation revert is caught safely without corrupting state", async () => {
  const { agent, trancheClient, positions } = buildHarness();
  trancheClient.failNextReserve = true;
  const trace = await agent.runCycle(1_700_000_000);

  assert.equal(trace.selectedAction, "EXECUTION_FAILED");
  assert.ok(trace.error?.includes("InsufficientOfferBalance"));
  assert.equal(positions.getActiveTickets().length, 0);
  assert.equal(positions.hasExecutedDecision(trace.decisionKey), false);
});

test("8 & 9. Partial + full position exits, take-profit and stop-loss triggers", async () => {
  const { agent, dex, positions } = buildHarness({
    strategy: { takeProfitBps: 500, takeProfitExitBps: 5000, stopLossBps: 300 }, // 50% partial exit on TP
  });
  dex.buyCostPayment = 8_200_000n;
  // Cycle 1: enter via HSKSwap ($8.20)
  const t1 = await agent.runCycle(1_700_000_000);
  assert.equal(t1.selectedAction, "SWAP_HSKSWAP");
  assert.equal(positions.getOpenPositions().length, 1);

  // Cycle 2: price rises +10% -> executable exit = $9.02 -> triggers 50% partial TAKE_PROFIT
  dex.sellProceedsPayment = 9_020_000n;
  dex.spotPriceX36 = 95n * 10n ** 21n; // above maxEntryPriceX36 so no new entry
  const t2 = await agent.runCycle(1_700_000_060);
  assert.equal(t2.selectedAction, "EXIT_POSITION");
  assert.equal(t2.positionActions[0].decision.action, "TAKE_PROFIT");
  assert.equal(positions.getOpenPositions()[0].status, "PARTIALLY_CLOSED");
  assert.equal(positions.getOpenPositions()[0].remainingQuantity, TARGET_QTY / 2n);

  // Cycle 3: price drops -10% -> triggers full STOP_LOSS on remaining 50%
  dex.sellProceedsPayment = 7_380_000n;
  const t3 = await agent.runCycle(1_700_000_120);
  assert.equal(t3.selectedAction, "EXIT_POSITION");
  assert.equal(t3.positionActions[0].decision.action, "STOP_LOSS");
  assert.equal(positions.getOpenPositions().length, 0);
  assert.equal(positions.getAllPositions()[0].status, "CLOSED");
});

test("10 & 11. Duplicate execution prevention, state persistence across restart, and runtime error recovery", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "tranche-agent-test-"));
  const stateFile = path.join(tmpDir, "state.json");
  try {
    const h1 = buildHarness({ stateFile });
    const t1 = await h1.agent.runCycle(1_700_000_000);
    assert.equal(t1.selectedAction, "RESERVE_TRANCHE");

    // Re-running same timestamp/offer decision key must be deduplicated
    const tDup = await h1.agent.runCycle(1_700_000_000);
    assert.equal(tDup.selectedAction, "SKIPPED_DUPLICATE");

    // Simulate full process restart loading from stateFile
    const h2 = buildHarness({ stateFile });
    assert.equal(h2.positions.getActiveTickets().length, 1);
    assert.equal(h2.positions.getPortfolioState(1_700_000_000).dailyPremiumSpentPayment, 50_000n);
    assert.equal(h2.positions.hasExecutedDecision(t1.decisionKey), true);

    // Runtime transient RPC error recovery
    h2.dex.failNextPoolRead = true;
    let errorsCaught = 0;
    const runtime = new AgentRuntime({
      agent: h2.agent,
      pollIntervalMs: 60_000,
      maxConsecutiveErrors: 3,
      onError: () => {
        errorsCaught += 1;
      },
    });
    const failedTick = await runtime.tickOnce(1_700_000_100);
    assert.equal(failedTick, null);
    assert.equal(errorsCaught, 1);
    assert.equal(h2.agent.getRiskLimits().paused, false);

    // Next tick recovers cleanly
    const recovered = await runtime.tickOnce(1_700_000_200);
    assert.ok(recovered !== null);
    await runtime.stop();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("12. Provider-agnostic LLM interface validates policy patches strictly and explains traces without API keys", async () => {
  const llm = new LocalRuleBasedLlmProvider();
  const { agent } = buildHarness();
  const trace = await agent.runCycle(1_700_000_000);

  const patch = await llm.parseInstruction(
    "switch to momentum, take profit 4%, stop loss 2%, slippage 50 bps",
  );
  const validated = validatePolicyPatch(patch, {
    hardMaxPositionSizeInventory: 500n * 10n ** 18n,
    hardMaxSlippageBps: 150,
    minStopLossBps: 50,
    maxStopLossBps: 1000,
    minTakeProfitBps: 50,
    maxTakeProfitBps: 5000,
  });
  assert.equal(validated.valid, true);
  assert.equal(validated.sanitizedPatch.strategyType, "momentum");
  assert.equal(validated.sanitizedPatch.takeProfitBps, 400);
  assert.equal(validated.sanitizedPatch.stopLossBps, 200);
  assert.equal(validated.sanitizedPatch.maxSlippageBps, 50);

  // Adversarial LLM output attempting to bypass slippage/position ceilings is rejected
  const unsafe = validatePolicyPatch(
    { maxSlippageBps: 5000, maxPositionSizeInventory: 999_999n * 10n ** 18n },
    {
      hardMaxPositionSizeInventory: 500n * 10n ** 18n,
      hardMaxSlippageBps: 150,
      minStopLossBps: 50,
      maxStopLossBps: 1000,
      minTakeProfitBps: 50,
      maxTakeProfitBps: 5000,
    },
  );
  assert.equal(unsafe.valid, false);
  assert.equal(unsafe.rejectedFields.length, 2);

  const explanation = await llm.explainTrace(trace);
  assert.ok(explanation.includes("RESERVE_TRANCHE"));
  assert.ok(explanation.includes("TRANCHE"));
});

test("13. [CRITICAL-1 Regression] Active ticket exercise enforces RiskManager exposure & concurrency limits", async () => {
  // Max exposure $10. Reserve ticket ($0.05 prem, $8.50 exercise). Then lower cap to $5 before exercise cycle.
  const { agent, dex, positions } = buildHarness({
    limits: { maxTotalExposurePayment: 10_000_000n },
  });
  const t1 = await agent.runCycle(1_700_000_000);
  assert.equal(t1.selectedAction, "RESERVE_TRANCHE");

  // Make ticket deeply in-the-money ($9.50 exit vs $8.50 exercise) so strategy wants to EXERCISE_TICKET
  dex.sellProceedsPayment = 9_500_000n;
  dex.spotPriceX36 = 95n * 10n ** 21n;
  // Tighten exposure cap to $5 -> exercising $8.50 ticket MUST be blocked by RiskManager!
  agent.getRiskLimits().maxTotalExposurePayment = 5_000_000n;

  const t2 = await agent.runCycle(1_700_000_010);
  assert.equal(t2.ticketActions.length, 1);
  assert.equal(t2.ticketActions[0].decision.action, "EXERCISE_TICKET");
  assert.ok(t2.ticketActions[0].error?.includes("Exercise risk blocked"));
  assert.ok(t2.ticketActions[0].error?.includes("max_total_exposure"));
  assert.equal(positions.getOpenPositions().length, 0);
});

test("14. [HIGH-1 Regression] Exact integer tickToPriceX36 matches Chain 177 WHSK/WETH/WBTC pools without float overflow", () => {
  // Exact live ticks from HashKey Chain Mainnet (177) verified earlier
  const whskX36 = tickToPriceX36(-301484, true); // ~$0.08079 -> ~8.08e22
  const wethX36 = tickToPriceX36(-202153, true); // ~$1,663 -> ~1.66e27
  const wbtcX36 = tickToPriceX36(63825, true); // ~$59,121 -> ~5.91e38 (previously threw/truncated in float!)

  assert.ok(whskX36 > 80n * 10n ** 21n && whskX36 < 82n * 10n ** 21n, `WHSK tick mismatch: ${whskX36}`);
  assert.ok(wethX36 > 1600n * 10n ** 24n && wethX36 < 1750n * 10n ** 24n, `WETH tick mismatch: ${wethX36}`);
  assert.ok(wbtcX36 > 58_000n * 10n ** 34n && wbtcX36 < 61_000n * 10n ** 34n, `WBTC tick mismatch: ${wbtcX36}`);
});

test("15. [HIGH-2 Regression] Reserved ticket records actual ticket expiry (not 30-day offer expiry)", async () => {
  const { agent, positions } = buildHarness();
  const t1 = await agent.runCycle(1_700_000_000);
  assert.equal(t1.selectedAction, "RESERVE_TRANCHE");
  const ticket = positions.getActiveTickets()[0];
  // Offer expiry is 1_700_500_000, but desiredDuration is 3600 -> ticket expiry must be 1_700_003_600
  assert.equal(ticket.expiresAt, 1_700_003_600);
});

test("16. [HIGH-3 Regression] Corrupted state fails closed; RPC timeout leaves UNCERTAIN_TIMEOUT pending tx blocking duplicates", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "tranche-adv-test-"));
  const corruptedFile = path.join(tmpDir, "corrupted.json");
  const timeoutFile = path.join(tmpDir, "timeout.json");
  try {
    // A. Corrupted JSON state file -> fail-closed
    writeFileSync(corruptedFile, "{ invalid json truncated...", "utf8");
    const hCorrupt = buildHarness({ stateFile: corruptedFile });
    assert.equal(hCorrupt.positions.isStateCorrupted(), true);
    const tCorrupt = await hCorrupt.agent.runCycle(1_700_000_000);
    assert.equal(tCorrupt.selectedAction, "BLOCKED_RISK");
    assert.ok(tCorrupt.rationale.includes("corrupted"));

    // B. RPC timeout during swap -> must NOT treat as confirmed revert; blocks duplicate on next cycle
    const hTimeout = buildHarness({ stateFile: timeoutFile });
    hTimeout.dex.buyCostPayment = 8_200_000n;
    hTimeout.dex.executeSwapExactInput = async () => {
      throw new Error("HTTP request timed out after 10000ms");
    };
    const t1 = await hTimeout.agent.runCycle(1_700_000_000);
    assert.equal(t1.selectedAction, "EXECUTION_FAILED");
    assert.equal(hTimeout.positions.getPendingTxs().length, 1);
    assert.equal(hTimeout.positions.getPendingTxs()[0].status, "UNCERTAIN_TIMEOUT");

    // Next cycle (even after restart!) MUST block new entries until reconciled
    const hRestarted = buildHarness({
      stateFile: timeoutFile,
      oracle: { priceX36: SPOT_0085, updatedAt: 1_700_000_005, isValid: true },
    });
    assert.equal(hRestarted.positions.getPendingTxs().length, 1);
    const t2 = await hRestarted.agent.runCycle(1_700_000_010);
    assert.equal(t2.selectedAction, "BLOCKED_RISK");
    assert.ok(t2.riskReport.failedChecks.some((c) => c.name === "no_pending_tx"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("17. [HIGH-4, MEDIUM-1 & MEDIUM-2 Regressions] Stale quote guard, gas-adjusted venue selection, and cooldown deduplication", async () => {
  // A. Stale quote (pool timestamp 1_700_000_000, nowSec 1_700_000_045 > 30s maxQuoteAgeSec, while oracle is fresh)
  const hStale = buildHarness({
    oracle: { priceX36: SPOT_0085, updatedAt: 1_700_000_040, isValid: true },
  });
  const tStale = await hStale.agent.runCycle(1_700_000_045);
  assert.equal(tStale.selectedAction, "BLOCKED_RISK");
  assert.ok(tStale.rationale.includes("Stale quote"));

  // B. Gas cost flips marginal venue choice ($8.55 Tranche + $0.10 gas = $8.65 > $8.60 HSKSwap + $0.02 gas = $8.62)
  const hGas = buildHarness({
    constraints: {
      trancheGasCostPayment: 100_000n,
      dexGasCostPayment: 20_000n,
    },
  });
  hGas.dex.buyCostPayment = 8_600_000n;
  const tGas = await hGas.agent.runCycle(1_700_000_000);
  assert.equal(tGas.venueSelection.selectedVenue, "HSKSWAP");

  // C. Cooldown bucket deduplication across adjacent timestamps (15s apart within 60s bucket)
  const hDedup = buildHarness();
  const d1 = await hDedup.agent.runCycle(1_700_000_000);
  assert.equal(d1.selectedAction, "RESERVE_TRANCHE");
  const d2 = await hDedup.agent.runCycle(1_700_000_015);
  assert.equal(d2.selectedAction, "SKIPPED_DUPLICATE");
});

test("18. [MEDIUM-3 Regression] applyValidatedPolicyPatch cannot clear killSwitch via natural language", async () => {
  const { agent } = buildHarness();
  agent.triggerKillSwitch();
  assert.equal(agent.getRiskLimits().killSwitch, true);
  assert.equal(agent.getRiskLimits().paused, true);

  const llm = new LocalRuleBasedLlmProvider();
  const patch = await llm.parseInstruction("resume trading now, take profit 3%");
  applyValidatedPolicyPatch(agent.getStrategyConfig(), agent.getRiskLimits(), patch, {
    hardMaxPositionSizeInventory: 500n * 10n ** 18n,
    hardMaxSlippageBps: 150,
    minStopLossBps: 50,
    maxStopLossBps: 1000,
    minTakeProfitBps: 50,
    maxTakeProfitBps: 5000,
  });

  // Kill switch & paused MUST remain true!
  assert.equal(agent.getRiskLimits().killSwitch, true);
  assert.equal(agent.getRiskLimits().paused, true);
});
