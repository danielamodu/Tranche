import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, http, type Address } from "viem";
import { TrancheClient } from "@tranche/sdk";
import { TrancheExecutionAgent } from "./agent.js";
import { CANONICAL_CHAIN_177_HSKSWAP, HskSwapVenue } from "./hskswap.js";
import type { PolicyValidationBounds } from "./llm.js";
import { StructuredLogger } from "./logger.js";
import { MarketIntelligence, type OracleReader } from "./market.js";
import { PositionStore } from "./positions.js";
import {
  CANONICAL_CHAIN_177_TOKENS,
  MAINNET_READONLY_RPC_URL,
  OnChainOracleReader,
  estimateGasCostInPaymentUnits,
  validateRuntimeSafety,
  type AgentDataSourceMode,
} from "./protocol-config.js";
import type { RiskLimits } from "./risk.js";
import { TrancheAutonomousAgent, type AgentExecutionMode } from "./runtime.js";
import { AgentApiServer } from "./server.js";
import { SoakRunner } from "./soak-runner.js";
import type { StrategyConfig } from "./strategy.js";

function parseDurationHours(): number {
  const idx = process.argv.indexOf("--hours");
  if (idx !== -1 && process.argv[idx + 1]) {
    const parsed = Number(process.argv[idx + 1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const envVal = Number(process.env.AGENT_SOAK_DURATION_HOURS ?? "24");
  if (!Number.isFinite(envVal) || envVal <= 0) {
    throw new Error(`Invalid AGENT_SOAK_DURATION_HOURS: ${process.env.AGENT_SOAK_DURATION_HOURS}`);
  }
  return envVal;
}

async function main() {
  const durationHours = parseDurationHours();
  const dataSource = (process.env.AGENT_DATA_SOURCE ?? "chain177_read_only").toLowerCase() as AgentDataSourceMode;
  const executionMode = (process.env.AGENT_EXECUTION_MODE ?? "read_only").toLowerCase() as AgentExecutionMode;

  if (executionMode !== "read_only") {
    throw new Error(
      `SAFETY_BLOCKED: Soak runner strictly requires AGENT_EXECUTION_MODE=read_only (got ${executionMode})`,
    );
  }
  if (dataSource !== "chain177_read_only") {
    throw new Error(
      `SAFETY_BLOCKED: Soak runner strictly requires AGENT_DATA_SOURCE=chain177_read_only (got ${dataSource})`,
    );
  }

  const rpcUrl = process.env.AGENT_RPC_URL ?? MAINNET_READONLY_RPC_URL;
  const pollIntervalMs = Math.max(2000, Number(process.env.AGENT_POLL_MS ?? "15000"));
  const logDir = path.resolve(process.env.AGENT_SOAK_LOG_DIR ?? "soak-evidence");
  const maxRetainedSnapshots = Math.max(0, Number(process.env.AGENT_SOAK_MAX_SNAPSHOTS ?? "0"));
  const stateFile = path.resolve(
    process.env.AGENT_SOAK_STATE_FILE ?? path.join(logDir, "soak-state.json"),
  );
  const pidFile = path.join(logDir, "soak.pid");
  const apiHost = process.env.AGENT_API_HOST ?? "127.0.0.1";
  const apiPort = Number(process.env.AGENT_API_PORT ?? "8787");
  const apiToken = process.env.AGENT_API_TOKEN ?? randomBytes(16).toString("hex");
  const disableApi = process.env.AGENT_SOAK_DISABLE_API === "true";
  const sessionId = process.env.AGENT_SOAK_SESSION_ID?.trim() || undefined;
  const resumeIfActive = process.env.AGENT_SOAK_RESUME !== "false";

  // Fail-closed safety check before touching RPC
  validateRuntimeSafety({ dataSource, executionMode: "read_only", rpcUrl });

  const logger = new StructuredLogger();
  const publicClient = createPublicClient({
    transport: http(rpcUrl, { timeout: 15_000 }),
  });

  const chainId = await publicClient.getChainId();
  validateRuntimeSafety({ dataSource, executionMode: "read_only", rpcUrl, chainId });

  const INV_TOKEN = CANONICAL_CHAIN_177_TOKENS.WHSK.address;
  const PAY_TOKEN = CANONICAL_CHAIN_177_TOKENS.USDT.address;
  const POOL_ADDR = CANONICAL_CHAIN_177_HSKSWAP.pools.WHSK_USDT_3000;
  const OBSERVATION_ADDR = "0x000000000000000000000000000000000000dEaD" as Address;
  const TARGET_QTY = 100n * 10n ** 18n;

  // Strictly read-only venue & Tranche agent — NO signer, NO walletClient, fail-closed on any write
  const dexVenue = new HskSwapVenue({
    publicClient,
    quoterV2: CANONICAL_CHAIN_177_HSKSWAP.quoterV2,
    swapRouter02: CANONICAL_CHAIN_177_HSKSWAP.swapRouter02,
    multicall3: CANONICAL_CHAIN_177_HSKSWAP.multicall3,
    readOnly: true,
  });

  const poolNow = await dexVenue.getPoolState(POOL_ADDR, INV_TOKEN, PAY_TOKEN);
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

  const managerAddr = process.env.TRANCHE_COMMITMENT_MANAGER as Address | undefined;
  const vaultAddr = process.env.TRANCHE_LIQUIDITY_VAULT as Address | undefined;
  const ticketAddr = process.env.TRANCHE_EXECUTION_TICKET as Address | undefined;
  const routerAddr = process.env.TRANCHE_EXECUTION_ROUTER as Address | undefined;
  const oracleAddr = process.env.TRANCHE_ORACLE_ADAPTER as Address | undefined;

  const isNonZeroAddr = (a?: Address): a is Address =>
    Boolean(a && a.toLowerCase() !== "0x0000000000000000000000000000000000000000");

  let trancheAgent: TrancheExecutionAgent;
  if (
    isNonZeroAddr(managerAddr) &&
    isNonZeroAddr(vaultAddr) &&
    isNonZeroAddr(ticketAddr) &&
    isNonZeroAddr(routerAddr)
  ) {
    const realClient = new TrancheClient({
      publicClient,
      addresses: {
        commitmentManager: managerAddr,
        liquidityVault: vaultAddr,
        executionTicket: ticketAddr,
        executionRouter: routerAddr,
        oraclePriceAdapter: isNonZeroAddr(oracleAddr) ? oracleAddr : undefined,
      },
    });
    trancheAgent = new TrancheExecutionAgent(realClient, { readOnly: true });
  } else {
    const emptyReadOnlyClient = {
      discoverOffers: async () => [],
      publicClient,
    } as unknown as TrancheClient;
    trancheAgent = new TrancheExecutionAgent(emptyReadOnlyClient, { readOnly: true });
  }

  const oracleReader: OracleReader = isNonZeroAddr(oracleAddr)
    ? new OnChainOracleReader(publicClient, oracleAddr)
    : {
        getPriceX36: async () => {
          const st = await dexVenue.getPoolState(POOL_ADDR, INV_TOKEN, PAY_TOKEN);
          return {
            priceX36: st.twapPriceX36 ?? st.spotPriceX36,
            updatedAt: st.timestamp,
            isValid: (st.twapPriceX36 ?? st.spotPriceX36) > 0n,
          };
        },
      };

  const riskLimits: RiskLimits = {
    maxPositionSizeInventory: 200n * 10n ** 18n,
    maxTotalExposurePayment: 50_000_000n,
    maxDailyPremiumBudgetPayment: 1_000_000n,
    maxDailyRealizedLossPayment: 5_000_000n,
    maxConcurrentPositions: 3,
    maxConcurrentTickets: 3,
    maxSlippageBps: 100,
    minPoolLiquidity: 100_000_000_000n,
    maxOracleAgeSec: 120,
    maxOracleDeviationBps: 300,
    paused: false,
    killSwitch: false,
  };

  const strategyConfig: StrategyConfig = {
    type: "price_threshold",
    momentumThresholdBps: 50,
    maxEntryPriceX36: 85n * 10n ** 21n,
    minVolatilityBps: 20,
    maxVolatilityBps: 1000,
    dislocationThresholdBps: 30,
    takeProfitBps: 500,
    stopLossBps: 300,
    takeProfitExitBps: 10_000,
    ticketExerciseWindowSec: 300,
  };

  const policyBounds: PolicyValidationBounds = {
    hardMaxPositionSizeInventory: 500n * 10n ** 18n,
    hardMaxSlippageBps: 200,
    minStopLossBps: 50,
    maxStopLossBps: 1500,
    minTakeProfitBps: 50,
    maxTakeProfitBps: 5000,
  };

  const market = new MarketIntelligence({
    dexVenue,
    trancheAgent,
    oracleReader,
    poolAddress: POOL_ADDR,
    poolFee: 3000,
    cacheTtlMs: 0, // Always fetch fresh Chain 177 RPC observations during soak
    maxSnapshotAgeSec: 180,
    minPoolLiquidity: riskLimits.minPoolLiquidity,
    maxOracleAgeSec: riskLimits.maxOracleAgeSec,
    maxOracleDeviationBps: riskLimits.maxOracleDeviationBps,
  });

  const positions = new PositionStore(stateFile);
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
      maxAllInCostX36: 90n * 10n ** 21n,
    },
    strategyConfig,
    riskLimits,
    venueConstraints: {
      maxAllInCostX36: 90n * 10n ** 21n,
      maxSlippageBps: riskLimits.maxSlippageBps,
      minExpectedNetProfitPayment: 100_000n,
      maxOptionOverheadBps: 100,
      trancheGasCostPayment,
      dexGasCostPayment,
    },
    logger,
  });

  let server: AgentApiServer | null = null;
  const cleanupPid = () => {
    try {
      if (existsSync(pidFile)) unlinkSync(pidFile);
    } catch {
      // best-effort cleanup
    }
  };

  const runner = new SoakRunner({
    agent,
    dataSource,
    chainId,
    rpcUrl,
    marketLabel: "WHSK/USDT",
    logDir,
    sessionId,
    resumeIfActive,
    stateFile,
    durationHours,
    pollIntervalMs,
    maxRetainedSnapshots,
    logger,
    onComplete: async () => {
      if (server) await server.stop();
      cleanupPid();
      process.exit(0);
    },
  });

  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    pidFile,
    JSON.stringify({
      pid: process.pid,
      sessionId: runner.evidence.sessionId,
      evidenceDir: runner.evidence.sessionDir,
      startedAt: new Date().toISOString(),
    }),
    "utf8",
  );

  if (!disableApi) {
    server = new AgentApiServer({
      agent,
      runtime: runner.runtime,
      policyBounds,
      apiToken,
      host: apiHost,
      port: apiPort,
      marketLabel: "WHSK/USDT",
      dataSource,
      chainId,
      soakProvider: runner,
    });
    const addr = await server.start();
    logger.info("soak.api_listening", {
      url: addr.url,
      sessionId: runner.evidence.sessionId,
      mode: "read_only",
      dataSource,
      chainId,
      durationHours,
      evidenceDir: runner.evidence.sessionDir,
    });
  }

  runner.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("soak.shutdown_signal", { signal, sessionId: runner.evidence.sessionId });
    await runner.stop(`signal:${signal}`, "STOPPED");
    if (server) await server.stop();
    cleanupPid();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
