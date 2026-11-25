import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { OfferStatus, PriceMode, type DiscoveredOffer, type TrancheClient } from "@tranche/sdk";
import { TrancheExecutionAgent } from "../src/agent.js";
import {
  PRICE_SCALE,
  type DexBuyQuote,
  type DexPoolState,
  type DexSellQuote,
  type DexVenueAdapter,
} from "../src/hskswap.js";
import type { PolicyValidationBounds } from "../src/llm.js";
import { MarketIntelligence } from "../src/market.js";
import { PositionStore } from "../src/positions.js";
import type { RiskLimits } from "../src/risk.js";
import { AgentRuntime, TrancheAutonomousAgent } from "../src/runtime.js";
import { AgentApiServer } from "../src/server.js";
import type { StrategyConfig } from "../src/strategy.js";

const INV_TOKEN = "0xB210D2120d57b758EE163cFfb43e73728c471Cf1" as Address;
const PAY_TOKEN = "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029" as Address;
const POOL_ADDR = "0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC" as Address;
const DRY_ADDR = "0x000000000000000000000000000000000000dEaD" as Address;
const TARGET_QTY = 100n * 10n ** 18n;
const SPOT = 85n * 10n ** 21n;
const TEST_TOKEN = "local-test-token-123456";

function createTestApi() {
  const dex: DexVenueAdapter = {
    name: "HSKSwapV3-Test",
    async getPoolState(): Promise<DexPoolState> {
      return {
        venue: "HSKSwapV3-Test",
        poolAddress: POOL_ADDR,
        token0: INV_TOKEN,
        token1: PAY_TOKEN,
        fee: 3000,
        liquidity: 1_000_000_000_000_000_000n,
        sqrtPriceX96: 1n << 96n,
        tick: -301484,
        observationCardinality: 240,
        spotPriceX36: SPOT,
        twapPriceX36: SPOT,
        timestamp: 1_700_000_000,
      };
    },
    async quoteBuyInventory(inv, pay, qty): Promise<DexBuyQuote> {
      return {
        venue: "HSKSwapV3-Test",
        inventoryToken: inv,
        paymentToken: pay,
        inventoryAmountOut: qty,
        paymentAmountIn: 8_800_000n,
        effectiveUnitPriceX36: (8_800_000n * PRICE_SCALE) / qty,
        priceImpactBps: 35,
        gasEstimate: 82_000n,
      };
    },
    async quoteSellInventory(inv, pay, qty): Promise<DexSellQuote> {
      return {
        venue: "HSKSwapV3-Test",
        inventoryToken: inv,
        paymentToken: pay,
        inventoryAmountIn: qty,
        paymentAmountOut: 8_450_000n,
        effectiveUnitPriceX36: (8_450_000n * PRICE_SCALE) / qty,
        priceImpactBps: 30,
        gasEstimate: 82_000n,
      };
    },
    async executeSwapExactInput() {
      throw new Error("Should not broadcast in dry_run mode");
    },
  };

  const offer: DiscoveredOffer = {
    offerId: 1n,
    availableBalance: 500n * 10n ** 18n,
    lp: DRY_ADDR,
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
    fixedPriceX36: SPOT,
    minPriceX36: 0n,
    maxPriceX36: 0n,
  };

  const trancheClient = {
    discoverOffers: async () => [offer],
    quoteReservation: async () => ({ grossPremium: 50_000n, protocolFee: 250n }),
    quoteExercise: async () => ({
      actualFill: TARGET_QTY,
      grossPayment: 8_500_000n,
      effPriceX36: SPOT,
    }),
    publicClient: { getBlock: async () => ({ timestamp: 1_700_000_000n }) },
  } as unknown as TrancheClient;

  const trancheAgent = new TrancheExecutionAgent(trancheClient);
  const riskLimits: RiskLimits = {
    maxPositionSizeInventory: 200n * 10n ** 18n,
    maxTotalExposurePayment: 50_000_000n,
    maxDailyPremiumBudgetPayment: 500_000n,
    maxDailyRealizedLossPayment: 5_000_000n,
    maxConcurrentPositions: 3,
    maxConcurrentTickets: 3,
    maxSlippageBps: 100,
    minPoolLiquidity: 100_000_000_000n,
    maxOracleAgeSec: 60,
    maxOracleDeviationBps: 300,
    paused: false,
    killSwitch: false,
  };
  const strategyConfig: StrategyConfig = {
    type: "price_threshold",
    momentumThresholdBps: 100,
    maxEntryPriceX36: 90n * 10n ** 21n,
    minVolatilityBps: 50,
    maxVolatilityBps: 1000,
    dislocationThresholdBps: 50,
    takeProfitBps: 500,
    stopLossBps: 300,
    takeProfitExitBps: 10_000,
    ticketExerciseWindowSec: 300,
  };
  const policyBounds: PolicyValidationBounds = {
    hardMaxPositionSizeInventory: 500n * 10n ** 18n,
    hardMaxSlippageBps: 150,
    minStopLossBps: 50,
    maxStopLossBps: 1000,
    minTakeProfitBps: 50,
    maxTakeProfitBps: 5000,
  };

  const market = new MarketIntelligence({
    dexVenue: dex,
    trancheAgent,
    oracleReader: {
      getPriceX36: async () => ({ priceX36: SPOT, updatedAt: 1_699_999_990, isValid: true }),
    },
    poolAddress: POOL_ADDR,
    poolFee: 3000,
    minPoolLiquidity: riskLimits.minPoolLiquidity,
    maxOracleAgeSec: riskLimits.maxOracleAgeSec,
    maxOracleDeviationBps: riskLimits.maxOracleDeviationBps,
  });

  const positions = new PositionStore(undefined, 1_700_000_000);
  const agent = new TrancheAutonomousAgent({
    trancheAgent,
    dexVenue: dex,
    market,
    positions,
    recipient: DRY_ADDR,
    poolFee: 3000,
    executionMode: "dry_run",
    intent: {
      inventoryToken: INV_TOKEN,
      paymentToken: PAY_TOKEN,
      targetAmount: TARGET_QTY,
      desiredDuration: 3600,
      maxAllInCostX36: 95n * 10n ** 21n,
    },
    strategyConfig,
    riskLimits,
    venueConstraints: {
      maxAllInCostX36: 95n * 10n ** 21n,
      maxSlippageBps: 100,
      minExpectedNetProfitPayment: 100_000n,
      maxOptionOverheadBps: 100,
    },
  });

  const runtime = new AgentRuntime({ agent, pollIntervalMs: 60_000 });
  const server = new AgentApiServer({
    agent,
    runtime,
    policyBounds,
    apiToken: TEST_TOKEN,
    host: "127.0.0.1",
    port: 0,
  });

  return { agent, runtime, server, positions };
}

test("API: GET endpoints return dry-run state, decisions, markets, config, and enforce strict CORS", async () => {
  const { runtime, server } = createTestApi();
  const { url } = await server.start();
  try {
    await runtime.tickOnce(1_700_000_000);

    // Allowed local origin succeeds with exact ACAO header (not *)
    const healthRes = await fetch(`${url}/health`, {
      headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get("access-control-allow-origin"), "http://localhost:5173");
    const health = (await healthRes.json()) as { ok: boolean; mode: string };
    assert.equal(health.ok, true);
    assert.equal(health.mode, "dry_run");

    // Disallowed origin returns 403
    const badCors = await fetch(`${url}/health`, {
      headers: { Origin: "https://evil.example.com" },
    });
    assert.equal(badCors.status, 403);

    // Check all read endpoints
    for (const ep of [
      "/agent/status",
      "/agent/metrics",
      "/agent/decisions",
      "/agent/positions",
      "/agent/tickets",
      "/agent/markets",
      "/agent/config",
    ]) {
      const r = await fetch(`${url}${ep}`);
      assert.equal(r.status, 200, `${ep} should return 200`);
    }

    const dec = (await (await fetch(`${url}/agent/decisions`)).json()) as {
      items: Array<{ selectedAction: string; selectedVenue: string; txHashes: string[] }>;
    };
    assert.equal(dec.items.length, 1);
    assert.equal(dec.items[0].selectedAction, "DRY_RUN_RESERVE_TRANCHE");
    assert.equal(dec.items[0].selectedVenue, "TRANCHE");
    assert.equal(dec.items[0].txHashes.length, 0);
  } finally {
    await runtime.stop();
    await server.stop();
  }
});

test("API: Authentication blocks unauthorized state changes and validates strategy bounds", async () => {
  const { runtime, server } = createTestApi();
  const { url } = await server.start();
  try {
    // Missing token -> 401
    const unauth = await fetch(`${url}/agent/pause`, { method: "POST" });
    assert.equal(unauth.status, 401);

    // Wrong token -> 401
    const wrong = await fetch(`${url}/agent/pause`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token-0000" },
    });
    assert.equal(wrong.status, 401);

    // Invalid out-of-bounds strategy update -> 400
    const badStrat = await fetch(`${url}/agent/strategy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ maxSlippageBps: 5000, takeProfitBps: 99999 }),
    });
    assert.equal(badStrat.status, 400);
    const badBody = (await badStrat.json()) as { error: string; rejectedFields: string[] };
    assert.equal(badBody.error, "POLICY_VALIDATION_FAILED");
    assert.equal(badBody.rejectedFields.length, 2);

    // Unknown field (e.g. killSwitch injection) -> 400
    const inject = await fetch(`${url}/agent/strategy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ killSwitch: false }),
    });
    assert.equal(inject.status, 400);

    // Valid strategy update -> 200
    const goodStrat = await fetch(`${url}/agent/strategy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ strategyType: "momentum", takeProfitBps: 400, stopLossBps: 200 }),
    });
    assert.equal(goodStrat.status, 200);
  } finally {
    await runtime.stop();
    await server.stop();
  }
});

test("API: Start/Pause/Resume/Kill lifecycle, authoritative kill switch, and uncertain tx reconciliation", async () => {
  const { runtime, server, positions } = createTestApi();
  const { url } = await server.start();
  const authHeaders = {
    Authorization: `Bearer ${TEST_TOKEN}`,
    "Content-Type": "application/json",
  };
  try {
    // Start -> Pause -> Uncertain tx blocks Resume -> Reconcile -> Resume succeeds
    const startRes = await fetch(`${url}/agent/start`, { method: "POST", headers: authHeaders });
    assert.equal(startRes.status, 200);

    const pauseRes = await fetch(`${url}/agent/pause`, { method: "POST", headers: authHeaders });
    assert.equal(pauseRes.status, 200);

    positions.beginPendingTx({
      id: "tx-uncertain-1",
      decisionKey: "test:1",
      action: "SWAP_HSKSWAP",
      createdAt: 1_700_000_000,
    });
    positions.markPendingTxUncertain("tx-uncertain-1", "HTTP timeout");

    // Resume MUST fail with 409 while uncertain tx is unresolved
    const blockedResume = await fetch(`${url}/agent/resume`, { method: "POST", headers: authHeaders });
    assert.equal(blockedResume.status, 409);

    // Reconcile uncertain tx -> 200
    const recRes = await fetch(`${url}/agent/reconcile`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ pendingTxId: "tx-uncertain-1", resolution: "CONFIRMED_FAILED" }),
    });
    assert.equal(recRes.status, 200);

    // Now Resume succeeds
    const okResume = await fetch(`${url}/agent/resume`, { method: "POST", headers: authHeaders });
    assert.equal(okResume.status, 200);

    // Kill switch stops runtime and permanently blocks Resume & Start
    const killRes = await fetch(`${url}/agent/kill`, { method: "POST", headers: authHeaders });
    assert.equal(killRes.status, 200);

    const resumeAfterKill = await fetch(`${url}/agent/resume`, { method: "POST", headers: authHeaders });
    assert.equal(resumeAfterKill.status, 409);

    const startAfterKill = await fetch(`${url}/agent/start`, { method: "POST", headers: authHeaders });
    assert.equal(startAfterKill.status, 409);
  } finally {
    await runtime.stop();
    await server.stop();
  }
});
