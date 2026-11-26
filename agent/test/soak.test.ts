import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { OfferStatus, PriceMode, type DiscoveredOffer, type TrancheClient } from "@tranche/sdk";
import { TrancheExecutionAgent } from "../src/agent.js";
import {
  CANONICAL_CHAIN_177_HSKSWAP,
  HskSwapVenue,
  PRICE_SCALE,
  type DexBuyQuote,
  type DexPoolState,
  type DexSellQuote,
  type DexVenueAdapter,
} from "../src/hskswap.js";
import type { PolicyValidationBounds } from "../src/llm.js";
import { StructuredLogger } from "../src/logger.js";
import { MarketIntelligence, type OracleReading } from "../src/market.js";
import { PositionStore } from "../src/positions.js";
import {
  MAINNET_READONLY_RPC_URL,
  validateRuntimeSafety,
} from "../src/protocol-config.js";
import type { RiskLimits } from "../src/risk.js";
import { TrancheAutonomousAgent } from "../src/runtime.js";
import { AgentApiServer } from "../src/server.js";
import {
  findLatestSoakSessionDir,
  inspectSoakSession,
  type SoakDecisionRecord,
  type SoakOperationalEventRecord,
  type SoakSnapshotRecord,
} from "../src/soak-evidence.js";
import { SoakRunner } from "../src/soak-runner.js";
import type { StrategyConfig } from "../src/strategy.js";

const INV = "0xB210D2120d57b758EE163cFfb43e73728c471Cf1" as Address;
const PAY = "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029" as Address;
const POOL = "0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC" as Address;
const OBS_ADDR = "0x000000000000000000000000000000000000dEaD" as Address;
const TARGET = 100n * 10n ** 18n;
const SPOT = 85n * 10n ** 21n;
const API_TOKEN = "soak-test-api-token-987654";

const BOUNDS: PolicyValidationBounds = {
  hardMaxPositionSizeInventory: 500n * 10n ** 18n,
  hardMaxSlippageBps: 150,
  minStopLossBps: 50,
  maxStopLossBps: 1000,
  minTakeProfitBps: 50,
  maxTakeProfitBps: 5000,
};

interface MockHarnessOptions {
  stateFile?: string;
  failRpcCount?: number;
  spotPriceX36?: bigint;
  twapPriceX36?: bigint | null;
  oracle?: OracleReading;
  buyCostPayment?: bigint;
  sellProceedsPayment?: bigint;
  blockNumberStart?: bigint;
  poolTimestamp?: number;
  cacheTtlMs?: number;
  maxSnapshotAgeSec?: number;
}

function buildSoakHarness(opts: MockHarnessOptions = {}) {
  let remainingRpcFails = opts.failRpcCount ?? 0;
  let currentBlock = opts.blockNumberStart ?? 10_000_000n;
  let currentSpot = opts.spotPriceX36 ?? SPOT;
  let currentTwap = opts.twapPriceX36 !== undefined ? opts.twapPriceX36 : SPOT;
  let currentPoolTimestamp = opts.poolTimestamp ?? 1_700_000_000;
  let currentOracle: OracleReading = opts.oracle ?? {
    priceX36: SPOT,
    updatedAt: 1_699_999_990,
    isValid: true,
  };
  let buyCost = opts.buyCostPayment ?? 8_800_000n;
  let sellProceeds = opts.sellProceedsPayment ?? 8_450_000n;
  let swapCalls = 0;
  let reserveCalls = 0;
  let exerciseCalls = 0;
  let reclaimCalls = 0;

  const dex: DexVenueAdapter = {
    name: "HSKSwapV3-SoakMock",
    async getPoolState(): Promise<DexPoolState> {
      if (remainingRpcFails > 0) {
        remainingRpcFails -= 1;
        throw new Error("HTTP 429 network timeout");
      }
      const blockNumber = currentBlock;
      return {
        venue: "HSKSwapV3-SoakMock",
        poolAddress: POOL,
        token0: INV,
        token1: PAY,
        fee: 3000,
        liquidity: 1_500_000_000_000_000_000n,
        sqrtPriceX96: 1n << 96n,
        tick: -301484,
        observationCardinality: 240,
        spotPriceX36: currentSpot,
        twapPriceX36: currentTwap,
        timestamp: currentPoolTimestamp,
        blockNumber,
      };
    },
    async quoteBuyInventory(inv, pay, qty): Promise<DexBuyQuote> {
      return {
        venue: "HSKSwapV3-SoakMock",
        inventoryToken: inv,
        paymentToken: pay,
        inventoryAmountOut: qty,
        paymentAmountIn: buyCost,
        effectiveUnitPriceX36: (buyCost * PRICE_SCALE) / qty,
        priceImpactBps: 30,
        gasEstimate: 85_000n,
      };
    },
    async quoteSellInventory(inv, pay, qty): Promise<DexSellQuote> {
      return {
        venue: "HSKSwapV3-SoakMock",
        inventoryToken: inv,
        paymentToken: pay,
        inventoryAmountIn: qty,
        paymentAmountOut: sellProceeds,
        effectiveUnitPriceX36: (sellProceeds * PRICE_SCALE) / qty,
        priceImpactBps: 28,
        gasEstimate: 85_000n,
      };
    },
    async executeSwapExactInput() {
      swapCalls += 1;
      throw new Error("READ_ONLY_MODE_BLOCKED: swap should never be called");
    },
  };

  const offer: DiscoveredOffer = {
    offerId: 1n,
    availableBalance: 500n * 10n ** 18n,
    lp: OBS_ADDR,
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
    getTicket: async () => ({
      offerId: 1n,
      reservedAt: 1_699_999_000,
      expiresAt: 1_700_003_600,
      priceMode: PriceMode.FIXED,
      status: 1,
      remainingAmount: TARGET,
    }),
    reserve: async () => {
      reserveCalls += 1;
      throw new Error("Should never broadcast reserve");
    },
    exercise: async () => {
      exerciseCalls += 1;
      throw new Error("Should never broadcast exercise");
    },
    reclaimExpired: async () => {
      reclaimCalls += 1;
      throw new Error("Should never broadcast reclaim");
    },
    publicClient: { getBlock: async () => ({ timestamp: BigInt(currentPoolTimestamp) }) },
  } as unknown as TrancheClient;

  const trancheAgent = new TrancheExecutionAgent(trancheClient, { readOnly: true });
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
      getPriceX36: async () => currentOracle,
    },
    poolAddress: POOL,
    poolFee: 3000,
    cacheTtlMs: opts.cacheTtlMs ?? 0,
    maxSnapshotAgeSec: opts.maxSnapshotAgeSec,
    minPoolLiquidity: riskLimits.minPoolLiquidity,
    maxOracleAgeSec: riskLimits.maxOracleAgeSec,
    maxOracleDeviationBps: riskLimits.maxOracleDeviationBps,
  });

  const logger = new StructuredLogger({ silent: true });
  const positions = new PositionStore(opts.stateFile, 1_700_000_000);
  const agent = new TrancheAutonomousAgent({
    trancheAgent,
    dexVenue: dex,
    market,
    positions,
    recipient: OBS_ADDR,
    poolFee: 3000,
    executionMode: "read_only",
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
      trancheGasCostPayment: 20_000n,
      dexGasCostPayment: 10_000n,
    },
    logger,
  });

  return {
    agent,
    trancheAgent,
    positions,
    market,
    logger,
    setBlock: (b: bigint) => {
      currentBlock = b;
    },
    setPoolTimestamp: (ts: number) => {
      currentPoolTimestamp = ts;
    },
    setSpot: (p: bigint) => {
      currentSpot = p;
    },
    setTwap: (p: bigint | null) => {
      currentTwap = p;
    },
    setOracle: (o: OracleReading) => {
      currentOracle = o;
    },
    setBuyCost: (c: bigint) => {
      buyCost = c;
    },
    setSellProceeds: (p: bigint) => {
      sellProceeds = p;
    },
    setFailRpcCount: (n: number) => {
      remainingRpcFails = n;
    },
    getWriteCounts: () => ({ swapCalls, reserveCalls, exerciseCalls, reclaimCalls }),
  };
}

test("Soak 1: Read-only mode fails closed across TrancheExecutionAgent, HskSwapVenue, and TrancheAutonomousAgent", async () => {
  const { agent, trancheAgent, positions, getWriteCounts } = buildSoakHarness();

  // Direct calls to TrancheExecutionAgent write methods must fail closed
  await assert.rejects(
    () => trancheAgent.reserveBestOffer(agent.getIntent(), OBS_ADDR, 1_700_000_000),
    /READ_ONLY_MODE_BLOCKED/,
  );
  await assert.rejects(
    () => trancheAgent.exerciseTicket(1n, 0n, 9_000_000n, OBS_ADDR, 1_700_000_000),
    /READ_ONLY_MODE_BLOCKED/,
  );
  await assert.rejects(
    () => trancheAgent.reclaimIfExpired(1n, 1_700_010_000),
    /READ_ONLY_MODE_BLOCKED/,
  );

  // Direct call to HskSwapVenue with readOnly=true fails closed even if walletClient is passed
  const readOnlyVenue = new HskSwapVenue({
    publicClient: {} as PublicClient,
    walletClient: {} as WalletClient,
    quoterV2: CANONICAL_CHAIN_177_HSKSWAP.quoterV2,
    swapRouter02: CANONICAL_CHAIN_177_HSKSWAP.swapRouter02,
    readOnly: true,
  });
  await assert.rejects(
    () =>
      readOnlyVenue.executeSwapExactInput({
        tokenIn: PAY,
        tokenOut: INV,
        fee: 3000,
        amountIn: 1_000_000n,
        amountOutMinimum: 1n,
        recipient: OBS_ADDR,
      }),
    /READ_ONLY_MODE_BLOCKED/,
  );

  // Seed an open position & an expired ticket to prove manageOpenPosition / manageActiveTicket also fail closed
  positions.recordDexPosition({
    inventoryToken: INV,
    paymentToken: PAY,
    quantity: TARGET,
    entryCostPayment: 7_000_000n, // take-profit would trigger at 8_450_000n
    txHash: `0x${"1".repeat(64)}` as Hex,
    nowSec: 1_699_999_000,
  });
  positions.recordReservedTicket({
    ticketId: 99n,
    offerId: 1n,
    inventoryToken: INV,
    paymentToken: PAY,
    inventoryAmount: TARGET,
    remainingAmount: TARGET,
    premiumPaidPayment: 50_000n,
    expiresAt: 1_699_999_500, // already expired
    reservedAt: 1_699_999_000,
    status: "ACTIVE",
    reserveTxHash: `0x${"2".repeat(64)}` as Hex,
    exerciseTxHashes: [],
  });

  const trace = await agent.runCycle(1_700_000_000);
  assert.equal(trace.executionMode, "read_only");
  assert.equal(trace.selectedAction, "READ_ONLY_RESERVE_TRANCHE");
  assert.equal(trace.executionBlockedByReadOnly, true);
  assert.equal(trace.txHashes.length, 0);
  assert.ok(trace.positionActions.some((a) => a.error?.includes("READ_ONLY_MODE_BLOCKED")));
  assert.ok(trace.ticketActions.some((a) => a.error?.includes("READ_ONLY_MODE_BLOCKED")));

  const writes = getWriteCounts();
  assert.deepEqual(writes, { swapCalls: 0, reserveCalls: 0, exerciseCalls: 0, reclaimCalls: 0 });
});

test("Soak 2: No signer is required for read-only operation & validateRuntimeSafety enforces chain177_read_only", () => {
  // Valid read_only config without any signer/private key
  assert.doesNotThrow(() =>
    validateRuntimeSafety({
      dataSource: "chain177_read_only",
      executionMode: "read_only",
      rpcUrl: MAINNET_READONLY_RPC_URL,
      chainId: 177,
    }),
  );

  // Rejects live or dry_run executionMode for chain177_read_only
  assert.throws(
    () =>
      validateRuntimeSafety({
        dataSource: "chain177_read_only",
        executionMode: "live",
        rpcUrl: MAINNET_READONLY_RPC_URL,
        chainId: 177,
      }),
    /SAFETY_BLOCKED/,
  );

  // Rejects non-177 chainId for chain177_read_only
  assert.throws(
    () =>
      validateRuntimeSafety({
        dataSource: "chain177_read_only",
        executionMode: "read_only",
        rpcUrl: MAINNET_READONLY_RPC_URL,
        chainId: 133,
      }),
    /SAFETY_BLOCKED/,
  );

  // Existing dry_run, fixture, and fork modes remain compatible
  assert.doesNotThrow(() =>
    validateRuntimeSafety({ dataSource: "fixture", executionMode: "dry_run" }),
  );
  assert.doesNotThrow(() =>
    validateRuntimeSafety({
      dataSource: "dry_run",
      executionMode: "dry_run",
      rpcUrl: MAINNET_READONLY_RPC_URL,
      chainId: 177,
    }),
  );
  assert.doesNotThrow(() =>
    validateRuntimeSafety({
      dataSource: "fork",
      executionMode: "live",
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 177,
    }),
  );
  assert.throws(
    () =>
      validateRuntimeSafety({
        dataSource: "fork",
        executionMode: "live",
        rpcUrl: MAINNET_READONLY_RPC_URL,
        chainId: 177,
      }),
    /MAINNET_EXECUTION_BLOCKED/,
  );
});

test("Soak 3: RPC interruption, bounded exponential backoff retries, and automatic recovery", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "tranche-soak-rpc-"));
  try {
    const harness = buildSoakHarness({ failRpcCount: 4 }); // > transientRpcRetries (2), so tick 1 fails
    const runner = new SoakRunner({
      agent: harness.agent,
      dataSource: "chain177_read_only",
      chainId: 177,
      rpcUrl: MAINNET_READONLY_RPC_URL,
      marketLabel: "WHSK/USDT",
      logDir: tmpDir,
      durationHours: 24,
      pollIntervalMs: 60_000,
      transientRpcRetries: 2,
      retryBackoffMs: 10,
      maxRetryBackoffMs: 25,
    });

    // First tick exhausts 2 retries (3 attempts total) and fails -> RPC_ERROR recorded
    const t1 = await runner.tickOnce(1_700_000_000);
    assert.equal(t1, null);
    assert.equal(runner.runtime.getHealthInfo().rpcHealthy, false);
    assert.equal(runner.runtime.getHealthInfo().recoveryState, "RECOVERING");

    // Second tick hits 1 remaining fail, retries once, and succeeds -> RECOVERY recorded
    const t2 = await runner.tickOnce(1_700_000_060);
    assert.ok(t2 !== null);
    assert.equal(runner.runtime.getHealthInfo().rpcHealthy, true);
    assert.equal(runner.runtime.getHealthInfo().recoveryState, "HEALTHY");

    const summary = runner.getStatusSummary();
    assert.equal(summary.cycles.failed, 1);
    assert.equal(summary.cycles.successful, 1);
    assert.ok(summary.retriesCount >= 3);
    assert.equal(summary.recoveriesCount, 1);
    assert.equal(summary.txBroadcastCount, 0);

    await runner.stop("test_complete", "COMPLETED");

    const events = readFileSync(runner.evidence.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as SoakOperationalEventRecord);
    assert.ok(events.some((e) => e.eventType === "RETRY"));
    assert.ok(events.some((e) => e.eventType === "RPC_ERROR"));
    assert.ok(events.some((e) => e.eventType === "RECOVERY"));
    assert.ok(events.some((e) => e.eventType === "HEALTH_TRANSITION"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Soak 4: Graceful shutdown, state restoration, and duplicate decision prevention across restarts", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "tranche-soak-restart-"));
  const stateFile = path.join(tmpDir, "soak-state.json");
  try {
    // Session 1: run 1 cycle in cooldown bucket, then stop gracefully
    const h1 = buildSoakHarness({ stateFile });
    const r1 = new SoakRunner({
      agent: h1.agent,
      dataSource: "chain177_read_only",
      chainId: 177,
      rpcUrl: MAINNET_READONLY_RPC_URL,
      marketLabel: "WHSK/USDT",
      logDir: tmpDir,
      stateFile,
      durationHours: 24,
      pollIntervalMs: 60_000,
    });
    r1.start();
    await new Promise((res) => setTimeout(res, 60));
    const m1 = await r1.stop("sigterm_simulated", "STOPPED");
    assert.equal(r1.runtime.isRunning(), false);
    assert.equal(existsSync(`${stateFile}.lock`), false, "Lockfile must be released on graceful shutdown");
    assert.equal(m1.txBroadcastCount, 0);

    // Session 2: restart pointing at the SAME persisted stateFile and same timestamp bucket
    const h2 = buildSoakHarness({ stateFile });
    const r2 = new SoakRunner({
      agent: h2.agent,
      dataSource: "chain177_read_only",
      chainId: 177,
      rpcUrl: MAINNET_READONLY_RPC_URL,
      marketLabel: "WHSK/USDT",
      logDir: tmpDir,
      stateFile,
      durationHours: 24,
      pollIntervalMs: 60_000,
    });

    // Tick within the exact same 60s cooldown bucket (1_700_000_000) -> MUST be SKIPPED_DUPLICATE
    const dupTrace = await r2.tickOnce(1_700_000_000);
    assert.ok(dupTrace !== null);
    assert.equal(dupTrace.selectedAction, "SKIPPED_DUPLICATE");
    assert.equal(r2.getStatusSummary().duplicateDecisionCount, 1);

    await r2.stop("restart_verified", "STOPPED");

    const events2 = readFileSync(r2.evidence.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as SoakOperationalEventRecord);
    assert.ok(
      events2.some((e) => e.eventType === "STATE_RESTORE"),
      "Restart must record STATE_RESTORE operational event",
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Soak 5: Stale oracle and abnormal market data mark observation unhealthy, yield NONE/WAIT, and recover automatically", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "tranche-soak-anomalies-"));
  try {
    const h = buildSoakHarness({
      oracle: { priceX36: SPOT, updatedAt: 1_699_999_000, isValid: true }, // 1000s stale > 60s
      blockNumberStart: 100n,
    });
    const runner = new SoakRunner({
      agent: h.agent,
      dataSource: "chain177_read_only",
      chainId: 177,
      rpcUrl: MAINNET_READONLY_RPC_URL,
      marketLabel: "WHSK/USDT",
      logDir: tmpDir,
      durationHours: 24,
      pollIntervalMs: 60_000,
    });

    // 1. Stale oracle -> unhealthy, NONE venue, WAIT action
    const tStale = await runner.tickOnce(1_700_000_000);
    assert.ok(tStale !== null);
    assert.equal(tStale.snapshot.dataSourceHealthy, false);
    assert.equal(tStale.venueSelection.selectedVenue, "NONE");
    assert.equal(tStale.selectedAction, "WAIT");
    assert.ok(tStale.snapshot.anomalies.some((a) => a.startsWith("ORACLE_STALE")));

    // 2. Extreme oracle deviation (50% off) -> unhealthy, NONE venue
    h.setBlock(101n);
    h.setOracle({ priceX36: (SPOT * 150n) / 100n, updatedAt: 1_700_000_055, isValid: true });
    const tDev = await runner.tickOnce(1_700_000_060);
    assert.ok(tDev !== null);
    assert.equal(tDev.snapshot.dataSourceHealthy, false);
    assert.equal(tDev.venueSelection.selectedVenue, "NONE");
    assert.ok(tDev.snapshot.anomalies.some((a) => a.startsWith("ORACLE_DEVIATION")));

    // 3. Block number regression (99 < 101) -> unhealthy, NONE venue
    h.setBlock(99n);
    h.setOracle({ priceX36: SPOT, updatedAt: 1_700_000_115, isValid: true });
    const tRegress = await runner.tickOnce(1_700_000_120);
    assert.ok(tRegress !== null);
    assert.equal(tRegress.snapshot.dataSourceHealthy, false);
    assert.equal(tRegress.venueSelection.selectedVenue, "NONE");
    assert.ok(tRegress.snapshot.anomalies.some((a) => a.startsWith("BLOCK_NUMBER_REGRESSION")));

    // 4. Recovery when block advances & oracle is fresh again -> healthy, TRANCHE selected (read-only blocked)
    h.setBlock(102n);
    h.setPoolTimestamp(1_700_000_180);
    h.setOracle({ priceX36: SPOT, updatedAt: 1_700_000_175, isValid: true });
    const tHealthy = await runner.tickOnce(1_700_000_180);
    assert.ok(tHealthy !== null);
    assert.equal(tHealthy.snapshot.dataSourceHealthy, true);
    assert.equal(tHealthy.venueSelection.selectedVenue, "TRANCHE");
    assert.equal(tHealthy.selectedAction, "READ_ONLY_RESERVE_TRANCHE");
    assert.equal(tHealthy.executionBlockedByReadOnly, true);

    await runner.stop("done", "COMPLETED");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Soak 6: Corrupted state fails closed and records CORRUPTED_STATE event", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "tranche-soak-corrupt-"));
  const stateFile = path.join(tmpDir, "corrupt-state.json");
  writeFileSync(stateFile, "{ broken json !!!", "utf8");
  try {
    const h = buildSoakHarness({ stateFile });
    assert.equal(h.positions.isStateCorrupted(), true);

    const runner = new SoakRunner({
      agent: h.agent,
      dataSource: "chain177_read_only",
      chainId: 177,
      rpcUrl: MAINNET_READONLY_RPC_URL,
      marketLabel: "WHSK/USDT",
      logDir: tmpDir,
      stateFile,
      durationHours: 24,
      pollIntervalMs: 60_000,
    });

    const trace = await runner.tickOnce(1_700_000_000);
    assert.ok(trace !== null);
    assert.equal(trace.selectedAction, "BLOCKED_RISK");
    assert.ok(trace.rationale.includes("corrupted"));
    assert.equal(trace.txHashes.length, 0);

    await runner.stop("corrupt_test", "STOPPED");

    const events = readFileSync(runner.evidence.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as SoakOperationalEventRecord);
    assert.ok(events.some((e) => e.eventType === "CORRUPTED_STATE"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Soak 7: Structured JSONL evidence completeness, snapshot retention, secret redaction, and determinism", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "tranche-soak-evidence-"));
  try {
    const hA = buildSoakHarness({ blockNumberStart: 500n });
    const hB = buildSoakHarness({ blockNumberStart: 500n });

    const rA = new SoakRunner({
      agent: hA.agent,
      dataSource: "chain177_read_only",
      chainId: 177,
      rpcUrl: MAINNET_READONLY_RPC_URL,
      marketLabel: "WHSK/USDT",
      logDir: tmpDir,
      durationHours: 24,
      pollIntervalMs: 60_000,
      metricsEveryCycles: 1,
      maxRetainedSnapshots: 2,
    });

    // Run 3 cycles across distinct cooldown buckets to test retention cap (2) & metrics emission
    const tA1 = await rA.tickOnce(1_700_000_000);
    hA.setBlock(501n);
    hA.setPoolTimestamp(1_700_000_060);
    hA.setOracle({ priceX36: SPOT, updatedAt: 1_700_000_055, isValid: true });
    await rA.tickOnce(1_700_000_060);
    hA.setBlock(502n);
    hA.setPoolTimestamp(1_700_000_120);
    hA.setOracle({ priceX36: SPOT, updatedAt: 1_700_000_115, isValid: true });
    await rA.tickOnce(1_700_000_120);

    // Determinism check: identical inputs on independent agent hB produce identical decision
    const tB1 = await hB.agent.runCycle(1_700_000_000);
    assert.ok(tA1 !== null);
    assert.equal(tA1.decisionKey, tB1.decisionKey);
    assert.equal(tA1.venueSelection.selectedVenue, tB1.venueSelection.selectedVenue);
    assert.equal(tA1.selectedAction, tB1.selectedAction);
    assert.equal(tA1.rationale, tB1.rationale);

    // Secret redaction check on operational event
    const fakeKey = `0x${"e".repeat(64)}`;
    rA.evidence.recordEvent("RPC_LATENCY", {
      privateKey: fakeKey,
      authorization: "Bearer super-secret-soak-token",
      note: `leaked ${fakeKey}`,
    });

    await rA.stop("evidence_complete", "COMPLETED");

    // Inspect via findLatestSoakSessionDir + inspectSoakSession
    const latestDir = findLatestSoakSessionDir(tmpDir);
    assert.equal(latestDir, rA.evidence.sessionDir);
    const report = inspectSoakSession(latestDir!);

    assert.equal(report.metadata.executionMode, "read_only");
    assert.equal(report.metadata.dataSource, "chain177_read_only");
    assert.equal(report.metadata.chainId, 177);
    assert.equal(report.counts.snapshots, 2, "Snapshot retention cap should retain 2 latest snapshots");
    assert.equal(report.counts.decisions, 3);
    assert.ok(report.counts.metrics >= 3);
    assert.equal(report.txBroadcastCount, 0);

    const snap = report.latestSnapshot as SoakSnapshotRecord;
    assert.equal(snap.chainId, 177);
    assert.equal(snap.blockNumber, "502");
    assert.equal(snap.dataSourceHealthy, true);

    const dec = report.latestDecision as SoakDecisionRecord;
    assert.equal(dec.executionBlockedByReadOnly, true);
    assert.equal(dec.selectedVenue, "TRANCHE");
    assert.ok(dec.reasoningCodes.includes("EXECUTION_BLOCKED_READ_ONLY"));

    const rawEvents = readFileSync(rA.evidence.eventsPath, "utf8");
    assert.ok(!rawEvents.includes(fakeKey), "Private key must never appear in JSONL evidence");
    assert.ok(!rawEvents.includes("super-secret-soak-token"), "Bearer token must never appear in JSONL evidence");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Soak 8: API /agent/soak exposes read-only soak telemetry while preserving auth, CORS, and rate limiting", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "tranche-soak-api-"));
  const h = buildSoakHarness();
  const runner = new SoakRunner({
    agent: h.agent,
    dataSource: "chain177_read_only",
    chainId: 177,
    rpcUrl: MAINNET_READONLY_RPC_URL,
    marketLabel: "WHSK/USDT",
    logDir: tmpDir,
    durationHours: 48,
    pollIntervalMs: 60_000,
  });
  const server = new AgentApiServer({
    agent: h.agent,
    runtime: runner.runtime,
    policyBounds: BOUNDS,
    apiToken: API_TOKEN,
    host: "127.0.0.1",
    port: 0,
    dataSource: "chain177_read_only",
    chainId: 177,
    marketLabel: "WHSK/USDT",
    soakProvider: runner,
    maxRequestsPerMinute: 20,
  });

  const { url } = await server.start();
  try {
    await runner.tickOnce(1_700_000_000);

    const soakRes = await fetch(`${url}/agent/soak`);
    assert.equal(soakRes.status, 200);
    const body = (await soakRes.json()) as Record<string, unknown>;
    assert.equal(body.sessionId, runner.evidence.sessionId);
    assert.equal(body.plannedDurationHours, 48);
    assert.equal(body.mode, "read_only");
    assert.equal(body.dataSource, "chain177_read_only");
    assert.equal(body.chainId, 177);
    assert.equal(body.txBroadcastCount, 0);
    assert.equal(body.evidenceDir, runner.evidence.sessionDir);
    assert.equal((body.cycles as { successful: number }).successful, 1);
    assert.ok(body.latestSnapshot !== null);

    // Health also surfaces mode & soakSessionId
    const healthRes = await fetch(`${url}/health`);
    const health = (await healthRes.json()) as Record<string, unknown>;
    assert.equal(health.mode, "read_only");
    assert.equal(health.soakSessionId, runner.evidence.sessionId);

    // Unauthorized POST still blocked (401)
    const unauth = await fetch(`${url}/agent/pause`, { method: "POST" });
    assert.equal(unauth.status, 401);

    // Forbidden CORS origin still blocked (403)
    const badCors = await fetch(`${url}/agent/soak`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(badCors.status, 403);
  } finally {
    await runner.stop("api_test_done", "STOPPED");
    await server.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Soak 9: Restart resumes active session without resetting 24h duration, blocks restarting completed sessions, and supports safe 48h extension", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "tranche-soak-resume-"));
  const stateFile = path.join(tmpDir, "soak-state.json");
  try {
    // Session 1 runs 1 cycle and simulates an unexpected crash (remains RUNNING, active-session.json kept)
    const h1 = buildSoakHarness({ stateFile, blockNumberStart: 700n });
    const r1 = new SoakRunner({
      agent: h1.agent,
      dataSource: "chain177_read_only",
      chainId: 177,
      rpcUrl: MAINNET_READONLY_RPC_URL,
      marketLabel: "WHSK/USDT",
      logDir: tmpDir,
      stateFile,
      durationHours: 24,
      pollIntervalMs: 60_000,
      resumeIfActive: true,
    });
    await r1.tickOnce(1_700_000_000);
    const originalSessionId = r1.evidence.sessionId;
    const originalStartedAtSec = r1.evidence.getStartedAtSec();

    // Simulate systemd restart (new process, resumeIfActive=true)
    const h2 = buildSoakHarness({ stateFile, blockNumberStart: 701n, poolTimestamp: 1_700_000_060 });
    h2.setOracle({ priceX36: SPOT, updatedAt: 1_700_000_055, isValid: true });
    const r2 = new SoakRunner({
      agent: h2.agent,
      dataSource: "chain177_read_only",
      chainId: 177,
      rpcUrl: MAINNET_READONLY_RPC_URL,
      marketLabel: "WHSK/USDT",
      logDir: tmpDir,
      stateFile,
      durationHours: 24,
      pollIntervalMs: 60_000,
      resumeIfActive: true,
    });

    assert.equal(r2.evidence.resumed, true);
    assert.equal(r2.evidence.sessionId, originalSessionId);
    assert.equal(r2.evidence.getStartedAtSec(), originalStartedAtSec);
    assert.equal(r2.evidence.getRestartsCount(), 1);

    await r2.tickOnce(1_700_000_060);
    const summary2 = r2.getStatusSummary();
    assert.equal(summary2.cycles.successful, 2, "Cumulative successful cycles must be preserved across restart");
    assert.equal(summary2.restartsCount, 1);

    // Complete the 24h session cleanly
    await r2.stop("duration_complete", "COMPLETED");

    // Re-launching with the same completed sessionId & 24h MUST fail closed
    const h3 = buildSoakHarness({ stateFile });
    assert.throws(
      () =>
        new SoakRunner({
          agent: h3.agent,
          dataSource: "chain177_read_only",
          chainId: 177,
          rpcUrl: MAINNET_READONLY_RPC_URL,
          marketLabel: "WHSK/USDT",
          logDir: tmpDir,
          sessionId: originalSessionId,
          stateFile,
          durationHours: 24,
          pollIntervalMs: 60_000,
        }),
      /SOAK_SESSION_ALREADY_COMPLETED/,
    );

    // Explicitly extending the same sessionId to 48h preserves cumulative evidence
    const r48 = new SoakRunner({
      agent: h3.agent,
      dataSource: "chain177_read_only",
      chainId: 177,
      rpcUrl: MAINNET_READONLY_RPC_URL,
      marketLabel: "WHSK/USDT",
      logDir: tmpDir,
      sessionId: originalSessionId,
      stateFile,
      durationHours: 48,
      pollIntervalMs: 60_000,
    });
    assert.equal(r48.evidence.sessionId, originalSessionId);
    assert.equal(r48.evidence.getPlannedDurationHours(), 48);
    assert.equal(r48.getStatusSummary().cycles.successful, 2);
    await r48.stop("extension_test_done", "STOPPED");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
