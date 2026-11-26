import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicClient, http, type Address } from "viem";
import type { TrancheClient } from "@tranche/sdk";
import { TrancheExecutionAgent } from "../src/agent.js";
import { CANONICAL_CHAIN_177_HSKSWAP, HskSwapVenue } from "../src/hskswap.js";
import { StructuredLogger } from "../src/logger.js";
import { MarketIntelligence } from "../src/market.js";
import { PositionStore } from "../src/positions.js";
import {
  CANONICAL_CHAIN_177_TOKENS,
  MAINNET_READONLY_RPC_URL,
  estimateGasCostInPaymentUnits,
} from "../src/protocol-config.js";
import type { RiskLimits } from "../src/risk.js";
import { TrancheAutonomousAgent } from "../src/runtime.js";
import { inspectSoakSession } from "../src/soak-evidence.js";
import { SoakRunner } from "../src/soak-runner.js";
import type { StrategyConfig } from "../src/strategy.js";

const RPC_URL = process.env.AGENT_RPC_URL ?? MAINNET_READONLY_RPC_URL;
const INV_TOKEN = CANONICAL_CHAIN_177_TOKENS.WHSK.address;
const PAY_TOKEN = CANONICAL_CHAIN_177_TOKENS.USDT.address;
const POOL_ADDR = CANONICAL_CHAIN_177_HSKSWAP.pools.WHSK_USDT_3000;
const OBSERVATION_ADDR = "0x000000000000000000000000000000000000dEaD" as Address;
const TARGET_QTY = 100n * 10n ** 18n;

test("Chain 177 Real Read-Only Integration: consumes live RPC data, records JSONL evidence, and broadcasts zero transactions", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "tranche-chain177-ro-"));
  const stateFile = path.join(tmpDir, "soak-state.json");

  try {
    // Strictly PublicClient only — NO signer, NO walletClient, NO private key
    const publicClient = createPublicClient({
      transport: http(RPC_URL, { timeout: 20_000 }),
    });

    const chainId = await publicClient.getChainId();
    assert.equal(chainId, 177, `Expected HashKey Chain Mainnet 177, got ${chainId}`);

    const dexVenue = new HskSwapVenue({
      publicClient,
      quoterV2: CANONICAL_CHAIN_177_HSKSWAP.quoterV2,
      swapRouter02: CANONICAL_CHAIN_177_HSKSWAP.swapRouter02,
      multicall3: CANONICAL_CHAIN_177_HSKSWAP.multicall3,
      readOnly: true,
    });

    const poolNow = await dexVenue.getPoolState(POOL_ADDR, INV_TOKEN, PAY_TOKEN);
    assert.ok(poolNow.blockNumber !== undefined && poolNow.blockNumber > 0n, "Expected live Chain 177 block number");
    assert.ok(poolNow.spotPriceX36 > 0n, "Expected live WHSK/USDT spotPriceX36 > 0");
    assert.ok(poolNow.liquidity > 0n, "Expected live WHSK/USDT pool liquidity > 0");

    const trancheGasCostPayment = await estimateGasCostInPaymentUnits({
      publicClient,
      gasUnits: 340_000n,
      whskToPaymentPriceX36: poolNow.spotPriceX36,
    });
    const dexGasCostPayment = await estimateGasCostInPaymentUnits({
      publicClient,
      gasUnits: 140_000n,
      whskToPaymentPriceX36: poolNow.spotPriceX36,
    });

    const emptyReadOnlyClient = {
      discoverOffers: async () => [],
      publicClient,
    } as unknown as TrancheClient;
    const trancheAgent = new TrancheExecutionAgent(emptyReadOnlyClient, { readOnly: true });

    const riskLimits: RiskLimits = {
      maxPositionSizeInventory: 200n * 10n ** 18n,
      maxTotalExposurePayment: 50_000_000n,
      maxDailyPremiumBudgetPayment: 1_000_000n,
      maxDailyRealizedLossPayment: 5_000_000n,
      maxConcurrentPositions: 3,
      maxConcurrentTickets: 3,
      maxSlippageBps: 100,
      minPoolLiquidity: 100_000_000_000n,
      maxOracleAgeSec: 180,
      maxOracleDeviationBps: 500,
      paused: false,
      killSwitch: false,
    };

    const strategyConfig: StrategyConfig = {
      type: "price_threshold",
      momentumThresholdBps: 50,
      maxEntryPriceX36: poolNow.spotPriceX36 * 2n,
      minVolatilityBps: 20,
      maxVolatilityBps: 1000,
      dislocationThresholdBps: 30,
      takeProfitBps: 500,
      stopLossBps: 300,
      takeProfitExitBps: 10_000,
      ticketExerciseWindowSec: 300,
    };

    const market = new MarketIntelligence({
      dexVenue,
      trancheAgent,
      oracleReader: {
        getPriceX36: async () => {
          const st = await dexVenue.getPoolState(POOL_ADDR, INV_TOKEN, PAY_TOKEN);
          return {
            priceX36: st.twapPriceX36 ?? st.spotPriceX36,
            updatedAt: st.timestamp,
            isValid: (st.twapPriceX36 ?? st.spotPriceX36) > 0n,
          };
        },
      },
      poolAddress: POOL_ADDR,
      poolFee: 3000,
      cacheTtlMs: 0,
      maxSnapshotAgeSec: 180,
      minPoolLiquidity: riskLimits.minPoolLiquidity,
      maxOracleAgeSec: riskLimits.maxOracleAgeSec,
      maxOracleDeviationBps: riskLimits.maxOracleDeviationBps,
    });

    const positions = new PositionStore(stateFile);
    const logger = new StructuredLogger({ silent: true });
    const agent = new TrancheAutonomousAgent({
      trancheAgent,
      dexVenue,
      market,
      positions,
      recipient: OBSERVATION_ADDR,
      poolFee: 3000,
      executionMode: "read_only",
      intent: {
        inventoryToken: INV_TOKEN,
        paymentToken: PAY_TOKEN,
        targetAmount: TARGET_QTY,
        desiredDuration: 3600,
        maxAllInCostX36: poolNow.spotPriceX36 * 2n,
      },
      strategyConfig,
      riskLimits,
      venueConstraints: {
        maxAllInCostX36: poolNow.spotPriceX36 * 2n,
        maxSlippageBps: 100,
        minExpectedNetProfitPayment: 100_000n,
        maxOptionOverheadBps: 100,
        trancheGasCostPayment,
        dexGasCostPayment,
      },
      logger,
    });

    const runner = new SoakRunner({
      agent,
      dataSource: "chain177_read_only",
      chainId: 177,
      rpcUrl: RPC_URL,
      marketLabel: "WHSK/USDT",
      logDir: tmpDir,
      stateFile,
      durationHours: 24,
      pollIntervalMs: 60_000,
      metricsEveryCycles: 1,
      logger,
    });

    // Execute 2 real live Chain 177 observation cycles
    const trace1 = await runner.tickOnce();
    assert.ok(trace1 !== null, "First live Chain 177 cycle must succeed");
    assert.equal(trace1.executionMode, "read_only");
    assert.equal(trace1.txHashes.length, 0);
    assert.ok(trace1.snapshot.blockNumber !== undefined && trace1.snapshot.blockNumber > 0n);
    assert.ok(trace1.snapshot.dexBuyQuote !== null && trace1.snapshot.dexBuyQuote.paymentAmountIn > 0n);
    assert.ok(trace1.snapshot.dexSellQuote !== null && trace1.snapshot.dexSellQuote.paymentAmountOut > 0n);

    const trace2 = await runner.tickOnce();
    assert.ok(trace2 !== null, "Second live Chain 177 cycle must succeed");
    assert.equal(trace2.txHashes.length, 0);
    assert.ok(
      trace2.snapshot.blockNumber! >= trace1.snapshot.blockNumber!,
      "Block numbers must be monotonic",
    );

    // Verify accidental write attempts fail closed even against live client
    await assert.rejects(
      () =>
        dexVenue.executeSwapExactInput({
          tokenIn: PAY_TOKEN,
          tokenOut: INV_TOKEN,
          fee: 3000,
          amountIn: 1_000_000n,
          amountOutMinimum: 1n,
          recipient: OBSERVATION_ADDR,
        }),
      /READ_ONLY_MODE_BLOCKED/,
    );
    await assert.rejects(
      () => trancheAgent.reserveBestOffer(agent.getIntent(), OBSERVATION_ADDR),
      /READ_ONLY_MODE_BLOCKED/,
    );

    await runner.stop("chain177_integration_complete", "COMPLETED");

    // Verify persistent JSONL evidence
    const report = inspectSoakSession(runner.evidence.sessionDir);
    assert.equal(report.metadata.chainId, 177);
    assert.equal(report.metadata.executionMode, "read_only");
    assert.equal(report.metadata.dataSource, "chain177_read_only");
    assert.equal(report.counts.snapshots, 2);
    assert.equal(report.counts.decisions, 2);
    assert.ok(report.counts.metrics >= 2);
    assert.equal(report.txBroadcastCount, 0);
    assert.ok(report.latestSnapshot !== null && BigInt(report.latestSnapshot.blockNumber!) > 0n);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
