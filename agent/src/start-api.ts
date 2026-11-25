import { randomBytes } from "node:crypto";
import path from "node:path";
import { createPublicClient, http, type Address } from "viem";
import { OfferStatus, PriceMode, TrancheClient, type DiscoveredOffer } from "@tranche/sdk";
import { TrancheExecutionAgent } from "./agent.js";
import {
  CANONICAL_CHAIN_177_HSKSWAP,
  HskSwapVenue,
  PRICE_SCALE,
  type DexBuyQuote,
  type DexPoolState,
  type DexSellQuote,
  type DexVenueAdapter,
} from "./hskswap.js";
import type { PolicyValidationBounds } from "./llm.js";
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
import { AgentRuntime, TrancheAutonomousAgent, type AgentExecutionMode } from "./runtime.js";
import { AgentApiServer } from "./server.js";
import type { StrategyConfig } from "./strategy.js";

/**
 * Local launcher for Tranche Agent + localhost HTTP control API.
 * Explicit AGENT_DATA_SOURCE modes:
 *  - `dry_run` (default): Real read-only Chain 177 HSKSwap V3 QuoterV2 + Multicall3 quotes, ZERO tx broadcasting.
 *  - `fixture`: Offline deterministic market fixture, ZERO RPC calls, ZERO tx broadcasting.
 *  - `fork`: Localhost Anvil fork only (fail-closed RPC/chain check blocks any remote/mainnet broadcast).
 */
async function main() {
  const host = process.env.AGENT_API_HOST ?? "127.0.0.1";
  const port = Number(process.env.AGENT_API_PORT ?? "8787");
  const apiToken = process.env.AGENT_API_TOKEN ?? randomBytes(16).toString("hex");
  const pollIntervalMs = Number(process.env.AGENT_POLL_MS ?? "15000");

  const rawSource = (process.env.AGENT_DATA_SOURCE ?? "dry_run").toLowerCase();
  const dataSource: AgentDataSourceMode =
    rawSource === "fixture" || rawSource === "fork" || rawSource === "dry_run"
      ? rawSource
      : "dry_run";

  const executionMode: AgentExecutionMode =
    dataSource === "fork" && process.env.AGENT_FORK_EXECUTE === "true" ? "live" : "dry_run";

  const rpcUrl =
    dataSource === "fixture"
      ? undefined
      : process.env.AGENT_RPC_URL ??
        (dataSource === "fork" ? "http://127.0.0.1:8545" : MAINNET_READONLY_RPC_URL);

  // Fail-closed safety check before touching any network or wallet
  validateRuntimeSafety({ dataSource, executionMode, rpcUrl });

  const INV_TOKEN = CANONICAL_CHAIN_177_TOKENS.WHSK.address;
  const PAY_TOKEN = CANONICAL_CHAIN_177_TOKENS.USDT.address;
  const POOL_ADDR = CANONICAL_CHAIN_177_HSKSWAP.pools.WHSK_USDT_3000;
  const DRY_RUN_ADDR = "0x000000000000000000000000000000000000dEaD" as Address;
  const TARGET_QTY = 100n * 10n ** 18n;
  const SPOT_FALLBACK = 81n * 10n ** 21n;

  let chainId = 0;
  let dexVenue: DexVenueAdapter;
  let trancheAgent: TrancheExecutionAgent;
  let oracleReader: OracleReader;
  let trancheGasCostPayment = 20_000n;
  let dexGasCostPayment = 10_000n;

  if (dataSource === "fixture") {
    let tickStep = 0;
    dexVenue = {
      name: "HSKSwapV3-Fixture",
      async getPoolState(): Promise<DexPoolState> {
        tickStep += 1;
        const drift = BigInt((tickStep % 5) - 2) * 2n * 10n ** 20n;
        return {
          venue: "HSKSwapV3-Fixture",
          poolAddress: POOL_ADDR,
          token0: INV_TOKEN,
          token1: PAY_TOKEN,
          fee: 3000,
          liquidity: 1_475_813_786_831_558_685n,
          sqrtPriceX96: 1n << 96n,
          tick: -301484,
          observationCardinality: 240,
          spotPriceX36: SPOT_FALLBACK + drift,
          twapPriceX36: SPOT_FALLBACK,
          timestamp: Math.floor(Date.now() / 1000),
        };
      },
      async quoteBuyInventory(inv, pay, qty): Promise<DexBuyQuote> {
        const paymentAmountIn = 8_220_000n;
        return {
          venue: "HSKSwapV3-Fixture",
          inventoryToken: inv,
          paymentToken: pay,
          inventoryAmountOut: qty,
          paymentAmountIn,
          effectiveUnitPriceX36: (paymentAmountIn * PRICE_SCALE) / qty,
          priceImpactBps: 38,
          gasEstimate: 82_000n,
        };
      },
      async quoteSellInventory(inv, pay, qty): Promise<DexSellQuote> {
        const paymentAmountOut = 8_050_000n;
        return {
          venue: "HSKSwapV3-Fixture",
          inventoryToken: inv,
          paymentToken: pay,
          inventoryAmountIn: qty,
          paymentAmountOut,
          effectiveUnitPriceX36: (paymentAmountOut * PRICE_SCALE) / qty,
          priceImpactBps: 34,
          gasEstimate: 82_000n,
        };
      },
      async executeSwapExactInput() {
        throw new Error("Blocked: fixture mode never broadcasts transactions");
      },
    };

    const dryOffer: DiscoveredOffer = {
      offerId: 1n,
      availableBalance: 500n * 10n ** 18n,
      lp: DRY_RUN_ADDR,
      createdAt: Math.floor(Date.now() / 1000) - 3600,
      expiry: Math.floor(Date.now() / 1000) + 86_400 * 7,
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
      fixedPriceX36: SPOT_FALLBACK,
      minPriceX36: 0n,
      maxPriceX36: 0n,
    };

    const dryTrancheClient = {
      discoverOffers: async () => [dryOffer],
      quoteReservation: async () => ({ grossPremium: 41_000n, protocolFee: 205n }),
      quoteExercise: async () => ({
        actualFill: TARGET_QTY,
        grossPayment: 8_100_000n,
        effPriceX36: SPOT_FALLBACK,
      }),
      publicClient: { getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }) },
    } as unknown as TrancheClient;

    trancheAgent = new TrancheExecutionAgent(dryTrancheClient);
    oracleReader = {
      getPriceX36: async () => ({
        priceX36: SPOT_FALLBACK,
        updatedAt: Math.floor(Date.now() / 1000) - 5,
        isValid: true,
      }),
    };
  } else {
    // Real read-only Chain 177 RPC (dry_run) or localhost Chain 177 fork
    const publicClient = createPublicClient({
      transport: http(rpcUrl!, { timeout: 15_000 }),
    });
    chainId = await publicClient.getChainId();
    validateRuntimeSafety({ dataSource, executionMode, rpcUrl, chainId });

    const hskVenue = new HskSwapVenue({
      publicClient,
      quoterV2: CANONICAL_CHAIN_177_HSKSWAP.quoterV2,
      swapRouter02: CANONICAL_CHAIN_177_HSKSWAP.swapRouter02,
      multicall3: CANONICAL_CHAIN_177_HSKSWAP.multicall3,
    });
    dexVenue = hskVenue;

    const poolNow = await hskVenue.getPoolState(POOL_ADDR, INV_TOKEN, PAY_TOKEN);
    trancheGasCostPayment = await estimateGasCostInPaymentUnits({
      publicClient,
      gasUnits: 340_000n,
      whskToPaymentPriceX36: poolNow.spotPriceX36,
    });
    dexGasCostPayment = await estimateGasCostInPaymentUnits({
      publicClient,
      gasUnits: 140_000n,
      whskToPaymentPriceX36: poolNow.spotPriceX36,
    });

    const managerAddr = process.env.TRANCHE_COMMITMENT_MANAGER as Address | undefined;
    const vaultAddr = process.env.TRANCHE_LIQUIDITY_VAULT as Address | undefined;
    const ticketAddr = process.env.TRANCHE_EXECUTION_TICKET as Address | undefined;
    const routerAddr = process.env.TRANCHE_EXECUTION_ROUTER as Address | undefined;
    const oracleAddr = process.env.TRANCHE_ORACLE_ADAPTER as Address | undefined;

    if (managerAddr && vaultAddr && ticketAddr && routerAddr) {
      const realClient = new TrancheClient({
        publicClient,
        addresses: {
          commitmentManager: managerAddr,
          liquidityVault: vaultAddr,
          executionTicket: ticketAddr,
          executionRouter: routerAddr,
          oraclePriceAdapter: oracleAddr,
        },
      });
      trancheAgent = new TrancheExecutionAgent(realClient);
    } else {
      // No Tranche contracts deployed yet on Chain 177 -> real empty offer list (never faked)
      const emptyClient = {
        discoverOffers: async () => [],
        publicClient,
      } as unknown as TrancheClient;
      trancheAgent = new TrancheExecutionAgent(emptyClient);
    }

    oracleReader = oracleAddr
      ? new OnChainOracleReader(publicClient, oracleAddr)
      : {
          // Use live HSKSwap V3 30m TWAP from pool state as read-only oracle reference
          getPriceX36: async () => {
            const st = await hskVenue.getPoolState(POOL_ADDR, INV_TOKEN, PAY_TOKEN);
            return {
              priceX36: st.twapPriceX36 ?? st.spotPriceX36,
              updatedAt: st.timestamp,
              isValid: (st.twapPriceX36 ?? st.spotPriceX36) > 0n,
            };
          },
        };
  }

  const riskLimits: RiskLimits = {
    maxPositionSizeInventory: 200n * 10n ** 18n,
    maxTotalExposurePayment: 50_000_000n,
    maxDailyPremiumBudgetPayment: 1_000_000n,
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
    minPoolLiquidity: riskLimits.minPoolLiquidity,
    maxOracleAgeSec: riskLimits.maxOracleAgeSec,
    maxOracleDeviationBps: riskLimits.maxOracleDeviationBps,
  });

  const positions = new PositionStore(path.resolve("node_modules/.tmp/agent-state.json"));
  const agent = new TrancheAutonomousAgent({
    trancheAgent,
    dexVenue,
    market,
    positions,
    recipient: DRY_RUN_ADDR,
    poolFee: 3000,
    executionMode,
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
  });

  const runtime = new AgentRuntime({ agent, pollIntervalMs });
  const server = new AgentApiServer({
    agent,
    runtime,
    policyBounds,
    apiToken,
    host,
    port,
    marketLabel: "WHSK/USDT",
    dataSource,
    chainId,
  });

  const addr = await server.start();
  await runtime.tickOnce();
  console.log(
    `Tranche Agent Local API listening on ${addr.url} (dataSource=${dataSource}, mode=${executionMode}, chainId=${chainId})`,
  );
  if (!process.env.AGENT_API_TOKEN) {
    console.log(`Generated local session token (set AGENT_API_TOKEN to customize): ${apiToken}`);
  }

  const shutdown = async () => {
    await runtime.stop();
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main();
