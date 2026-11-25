import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Address, Hex, PublicClient } from "viem";
import { OfferStatus, PriceMode, type DiscoveredOffer, type TrancheClient } from "@tranche/sdk";
import { TrancheExecutionAgent } from "../src/agent.js";
import {
  PRICE_SCALE,
  type DexBuyQuote,
  type DexPoolState,
  type DexSellQuote,
  type DexVenueAdapter,
} from "../src/hskswap.js";
import { LocalRuleBasedLlmProvider, validatePolicyPatch, type PolicyValidationBounds } from "../src/llm.js";
import { StructuredLogger, redactSensitive } from "../src/logger.js";
import { MarketIntelligence, classifyMarketRegime } from "../src/market.js";
import { PositionStore } from "../src/positions.js";
import { TransactionReconciler } from "../src/reconciler.js";
import type { RiskLimits } from "../src/risk.js";
import { AgentRuntime, TrancheAutonomousAgent } from "../src/runtime.js";
import { AgentApiServer } from "../src/server.js";
import type { StrategyConfig } from "../src/strategy.js";

const INV = "0xB210D2120d57b758EE163cFfb43e73728c471Cf1" as Address;
const PAY = "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029" as Address;
const POOL = "0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC" as Address;
const SIGNER = "0x1111111111111111111111111111111111111111" as Address;
const TARGET = 100n * 10n ** 18n;
const SPOT = 85n * 10n ** 21n;
const TOKEN = "ops-test-secret-token-9999";

const BOUNDS: PolicyValidationBounds = {
  hardMaxPositionSizeInventory: 500n * 10n ** 18n,
  hardMaxSlippageBps: 150,
  minStopLossBps: 50,
  maxStopLossBps: 1000,
  minTakeProfitBps: 50,
  maxTakeProfitBps: 5000,
  hardMaxVolatilityBps: 1500,
  hardMaxTotalExposurePayment: 100_000_000n,
  hardMaxDailyRealizedLossPayment: 20_000_000n,
};

function makeAgent(stateFile?: string, opts?: { failRpcCount?: number }) {
  let remainingRpcFails = opts?.failRpcCount ?? 0;
  const dex: DexVenueAdapter = {
    name: "HSKSwapV3-Ops",
    async getPoolState(): Promise<DexPoolState> {
      if (remainingRpcFails > 0) {
        remainingRpcFails -= 1;
        throw new Error("HTTP 429 network timeout");
      }
      return {
        venue: "HSKSwapV3-Ops",
        poolAddress: POOL,
        token0: INV,
        token1: PAY,
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
        venue: "HSKSwapV3-Ops",
        inventoryToken: inv,
        paymentToken: pay,
        inventoryAmountOut: qty,
        paymentAmountIn: 8_800_000n,
        effectiveUnitPriceX36: (8_800_000n * PRICE_SCALE) / qty,
        priceImpactBps: 30,
        gasEstimate: 80_000n,
      };
    },
    async quoteSellInventory(inv, pay, qty): Promise<DexSellQuote> {
      return {
        venue: "HSKSwapV3-Ops",
        inventoryToken: inv,
        paymentToken: pay,
        inventoryAmountIn: qty,
        paymentAmountOut: 8_450_000n,
        effectiveUnitPriceX36: (8_450_000n * PRICE_SCALE) / qty,
        priceImpactBps: 30,
        gasEstimate: 80_000n,
      };
    },
    async executeSwapExactInput() {
      throw new Error("dry_run only");
    },
  };

  const offer: DiscoveredOffer = {
    offerId: 1n,
    availableBalance: 500n * 10n ** 18n,
    lp: SIGNER,
    createdAt: 1_699_990_000,
    expiry: 1_700_500_000,
    priceMode: PriceMode.FIXED,
    status: OfferStatus.ACTIVE,
    inventoryToken: INV,
    minDuration: 60,
    maxDuration: 86_400,
    basePremiumBps: 50,
    dailyPremiumBps: 10,
    paymentToken: PAY,
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
    quoteExercise: async () => ({ actualFill: TARGET, grossPayment: 8_500_000n, effPriceX36: SPOT }),
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

  const market = new MarketIntelligence({
    dexVenue: dex,
    trancheAgent,
    oracleReader: {
      getPriceX36: async () => ({ priceX36: SPOT, updatedAt: 1_699_999_990, isValid: true }),
    },
    poolAddress: POOL,
    poolFee: 3000,
    minPoolLiquidity: riskLimits.minPoolLiquidity,
    maxOracleAgeSec: riskLimits.maxOracleAgeSec,
    maxOracleDeviationBps: riskLimits.maxOracleDeviationBps,
  });

  const logger = new StructuredLogger({ silent: true });
  const positions = new PositionStore(stateFile, 1_700_000_000);
  const agent = new TrancheAutonomousAgent({
    trancheAgent,
    dexVenue: dex,
    market,
    positions,
    recipient: SIGNER,
    poolFee: 3000,
    executionMode: "dry_run",
    intent: {
      inventoryToken: INV,
      paymentToken: PAY,
      targetAmount: TARGET,
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
    logger,
  });

  return { agent, positions, logger };
}

test("Ops 1: Single-instance lockfile blocks concurrent runtimes & restart preserves killSwitch and pause state", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "tranche-ops-"));
  const stateFile = path.join(tmpDir, "state.json");
  try {
    const first = makeAgent(stateFile);
    const rt1 = new AgentRuntime({ agent: first.agent, pollIntervalMs: 60_000 });
    rt1.start();

    // Second runtime targeting the same stateFile MUST fail with STATE_LOCKED
    const second = makeAgent(stateFile);
    const rt2 = new AgentRuntime({ agent: second.agent, pollIntervalMs: 60_000 });
    assert.throws(() => rt2.start(), /STATE_LOCKED/);

    // Trigger killSwitch and stop rt1
    first.agent.triggerKillSwitch();
    await rt1.stop();

    // Restart from stateFile -> killSwitch & paused MUST still be true (never silently reset!)
    const restarted = makeAgent(stateFile);
    assert.equal(restarted.agent.getRiskLimits().killSwitch, true);
    assert.equal(restarted.agent.getRiskLimits().paused, true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Ops 2: Automated TransactionReconciler distinguishes CONFIRMED, REVERTED, REPLACED, PENDING, UNCERTAIN", async () => {
  const makeClient = (opts: {
    chainId?: number;
    receiptStatus?: "success" | "reverted" | "missing";
    latestNonce?: number;
  }) =>
    ({
      getChainId: async () => opts.chainId ?? 177,
      getTransactionReceipt: async () => {
        if (opts.receiptStatus === "missing") throw new Error("Receipt not found");
        return {
          status: opts.receiptStatus ?? "success",
          blockNumber: 12345n,
          gasUsed: 120_000n,
        };
      },
      getTransactionCount: async () => opts.latestNonce ?? 5,
    }) as unknown as Pick<PublicClient, "getChainId" | "getTransactionReceipt" | "getTransactionCount">;

  const txHash = `0x${"1".repeat(64)}` as Hex;

  // Confirmed
  const rConf = await new TransactionReconciler(makeClient({ receiptStatus: "success" })).reconcile({
    id: "p1",
    decisionKey: "k1",
    action: "SWAP_HSKSWAP",
    createdAt: 1,
    status: "UNCERTAIN_TIMEOUT",
    chainId: 177,
    txHash,
  });
  assert.equal(rConf.status, "CONFIRMED");
  assert.equal(rConf.canClearPending, true);

  // Reverted
  const rRev = await new TransactionReconciler(makeClient({ receiptStatus: "reverted" })).reconcile({
    id: "p2",
    decisionKey: "k2",
    action: "SWAP_HSKSWAP",
    createdAt: 1,
    status: "UNCERTAIN_TIMEOUT",
    chainId: 177,
    txHash,
  });
  assert.equal(rRev.status, "REVERTED");
  assert.equal(rRev.canClearPending, true);

  // Replaced (latestNonce 6 > tx nonce 5)
  const rRep = await new TransactionReconciler(
    makeClient({ receiptStatus: "missing", latestNonce: 6 }),
  ).reconcile({
    id: "p3",
    decisionKey: "k3",
    action: "SWAP_HSKSWAP",
    createdAt: 1,
    status: "UNCERTAIN_TIMEOUT",
    chainId: 177,
    signer: SIGNER,
    nonce: 5,
  });
  assert.equal(rRep.status, "REPLACED");
  assert.equal(rRep.canClearPending, true);

  // Still Pending (latestNonce 5 <= tx nonce 5 -> MUST NOT clear!)
  const rPend = await new TransactionReconciler(
    makeClient({ receiptStatus: "missing", latestNonce: 5 }),
  ).reconcile({
    id: "p4",
    decisionKey: "k4",
    action: "SWAP_HSKSWAP",
    createdAt: 1,
    status: "UNCERTAIN_TIMEOUT",
    chainId: 177,
    signer: SIGNER,
    nonce: 5,
  });
  assert.equal(rPend.status, "PENDING");
  assert.equal(rPend.canClearPending, false);

  // Chain ID mismatch -> UNCERTAIN
  const rChain = await new TransactionReconciler(makeClient({ chainId: 133 })).reconcile({
    id: "p5",
    decisionKey: "k5",
    action: "SWAP_HSKSWAP",
    createdAt: 1,
    status: "UNCERTAIN_TIMEOUT",
    chainId: 177,
    txHash,
  });
  assert.equal(rChain.status, "UNCERTAIN");
  assert.equal(rChain.canClearPending, false);
});

test("Ops 3: StructuredLogger redacts private keys & Bearer tokens while preserving txHashes", () => {
  const sampleTxHash = `0x${"a".repeat(64)}`;
  const samplePrivKey = `0x${"f".repeat(64)}`;
  const redacted = redactSensitive({
    privateKey: samplePrivKey,
    authorization: "Bearer super-secret-token-123",
    note: `leaked ${samplePrivKey} and Bearer another-secret-token`,
    txHash: sampleTxHash,
  }) as Record<string, unknown>;

  assert.equal(redacted.privateKey, "[REDACTED]");
  assert.equal(redacted.authorization, "[REDACTED]");
  assert.ok(!String(redacted.note).includes(samplePrivKey));
  assert.ok(!String(redacted.note).includes("another-secret-token"));
  assert.equal(redacted.txHash, sampleTxHash);
});

test("Ops 4: Market regime classification & bounded transient RPC retry recovery", async () => {
  assert.equal(
    classifyMarketRegime({ realizedVolatilityBps: 40, momentumReturnBps: 20, dislocationVsTwapBps: 10 }),
    "CALM",
  );
  assert.equal(
    classifyMarketRegime({ realizedVolatilityBps: 80, momentumReturnBps: 150, dislocationVsTwapBps: 30 }),
    "TRENDING",
  );
  assert.equal(
    classifyMarketRegime({ realizedVolatilityBps: 400, momentumReturnBps: 20, dislocationVsTwapBps: 40 }),
    "VOLATILE",
  );
  assert.equal(
    classifyMarketRegime({ realizedVolatilityBps: 50, momentumReturnBps: 10, dislocationVsTwapBps: -200 }),
    "DISLOCATED",
  );

  // Runtime recovers automatically on 2nd transient RPC retry within a single tick
  const { agent } = makeAgent(undefined, { failRpcCount: 2 });
  const rt = new AgentRuntime({
    agent,
    pollIntervalMs: 60_000,
    transientRpcRetries: 2,
    retryBackoffMs: 10,
  });
  const trace = await rt.tickOnce(1_700_000_000);
  assert.ok(trace !== null);
  assert.equal(rt.getHealthInfo().rpcHealthy, true);
  assert.equal(rt.getHealthInfo().recoveryState, "HEALTHY");
});

test("Ops 5: LLM policy proposal, versioned apply, rollback, readiness probe & API rate limiting", async () => {
  const llm = new LocalRuleBasedLlmProvider();
  const p1 = await llm.parseInstruction(
    "Trade WHSK/USDT using momentum, avoid elevated volatility, limit exposure to $30, daily loss $3",
  );
  const v1 = validatePolicyPatch(p1, BOUNDS);
  assert.equal(v1.valid, true);
  assert.equal(v1.sanitizedPatch.strategyType, "momentum");
  assert.equal(v1.sanitizedPatch.maxVolatilityBps, 350);
  assert.equal(v1.sanitizedPatch.maxTotalExposurePayment, 30_000_000n);
  assert.equal(v1.sanitizedPatch.maxDailyRealizedLossPayment, 3_000_000n);

  const { agent } = makeAgent();
  const rt = new AgentRuntime({ agent, pollIntervalMs: 60_000 });
  const server = new AgentApiServer({
    agent,
    runtime: rt,
    policyBounds: BOUNDS,
    apiToken: TOKEN,
    host: "127.0.0.1",
    port: 0,
    maxRequestsPerMinute: 12,
  });
  const { url } = await server.start();
  const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  try {
    // Readiness probe 200
    assert.equal((await fetch(`${url}/ready`)).status, 200);

    // Propose does NOT mutate config
    const propRes = await fetch(`${url}/agent/policy/propose`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ instruction: "switch to momentum, take profit 4%" }),
    });
    assert.equal(propRes.status, 200);
    assert.equal(agent.getStrategyConfig().type, "price_threshold");

    // Apply mutates & increments policyVersion to 2
    const applyRes = await fetch(`${url}/agent/policy/apply`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ instruction: "switch to momentum, take profit 4%" }),
    });
    assert.equal(applyRes.status, 200);
    assert.equal(agent.getStrategyConfig().type, "momentum");

    // Rollback to v1 restores price_threshold
    const rbRes = await fetch(`${url}/agent/policy/rollback`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(rbRes.status, 200);
    assert.equal(agent.getStrategyConfig().type, "price_threshold");

    // Kill switch causes /ready to return 503
    await fetch(`${url}/agent/kill`, { method: "POST", headers: auth });
    assert.equal((await fetch(`${url}/ready`)).status, 503);

    // Rate limiting triggers 429 after exceeding maxRequestsPerMinute (12)
    let hit429 = false;
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${url}/health`);
      if (r.status === 429) {
        hit429 = true;
        break;
      }
    }
    assert.equal(hit429, true, "Expected rate limiter to return 429");
  } finally {
    await rt.stop();
    await server.stop();
  }
});
