import type { Address } from "viem";
import type { TrancheExecutionAgent } from "./agent.js";
import type { AgentIntent, EvaluateOffersResult } from "./types.js";
import {
  BPS_DENOMINATOR,
  type DexBuyQuote,
  type DexPoolState,
  type DexSellQuote,
  type DexVenueAdapter,
} from "./hskswap.js";

export interface OracleReading {
  priceX36: bigint;
  updatedAt: number;
  isValid: boolean;
}

export interface OracleReader {
  getPriceX36(inventoryToken: Address, paymentToken: Address): Promise<OracleReading>;
}

export interface MarketObservation {
  timestamp: number;
  spotPriceX36: bigint;
  twapPriceX36: bigint | null;
  poolLiquidity: bigint;
  dexEntryCostPayment: bigint | null;
  dexExitProceedsPayment: bigint | null;
  dexEntryImpactBps: number | null;
  dexExitImpactBps: number | null;
}

export type MarketRegime = "CALM" | "TRENDING" | "VOLATILE" | "DISLOCATED";

export interface MarketSnapshot {
  timestamp: number;
  blockNumber?: bigint;
  inventoryToken: Address;
  paymentToken: Address;
  targetAmount: bigint;
  pool: DexPoolState;
  dexBuyQuote: DexBuyQuote | null;
  dexSellQuote: DexSellQuote | null;
  oracle: OracleReading | null;
  oracleAgeSec: number | null;
  oracleDeviationBps: number | null;
  trancheOffers: EvaluateOffersResult;
  realizedVolatilityBps: number;
  momentumReturnBps: number;
  dislocationVsTwapBps: number;
  marketRegime: MarketRegime;
  anomalies: string[];
  dataSourceHealthy?: boolean;
}

export interface MarketIntelligenceConfig {
  dexVenue: DexVenueAdapter;
  trancheAgent: TrancheExecutionAgent;
  oracleReader?: OracleReader;
  poolAddress: Address;
  poolFee: number;
  maxHistorySize?: number;
  /** Optional snapshot cache TTL in ms to prevent redundant RPC bursts (default 0 = disabled) */
  cacheTtlMs?: number;
  /** Optional max wall-clock age in seconds for live pool timestamps (disabled if omitted) */
  maxSnapshotAgeSec?: number;
  minPoolLiquidity: bigint;
  maxOracleAgeSec: number;
  maxOracleDeviationBps: number;
  maxAbnormalSpreadBps?: number;
}

export function classifyMarketRegime(params: {
  realizedVolatilityBps: number;
  momentumReturnBps: number;
  dislocationVsTwapBps: number;
}): MarketRegime {
  if (Math.abs(params.dislocationVsTwapBps) >= 150) return "DISLOCATED";
  if (params.realizedVolatilityBps >= 300) return "VOLATILE";
  if (Math.abs(params.momentumReturnBps) >= 100) return "TRENDING";
  return "CALM";
}

/**
 * Modular market-intelligence layer combining live DEX quotes, Tranche offer discovery,
 * oracle freshness/deviation checks, and rolling price/volatility history.
 */
export class MarketIntelligence {
  private readonly cfg: MarketIntelligenceConfig;
  private readonly history: MarketObservation[] = [];
  private readonly maxHistory: number;
  private cachedSnapshot: { snapshot: MarketSnapshot; cachedAtMs: number } | null = null;
  private lastBlockNumber: bigint | null = null;
  private lastSnapshotTimestamp: number | null = null;

  constructor(config: MarketIntelligenceConfig) {
    this.cfg = config;
    this.maxHistory = config.maxHistorySize ?? 64;
  }

  getHistory(): readonly MarketObservation[] {
    return this.history;
  }

  seedHistory(observations: MarketObservation[]): void {
    for (const obs of observations) {
      this.pushObservation(obs);
    }
  }

  async collectSnapshot(intent: AgentIntent, nowSecOverride?: number): Promise<MarketSnapshot> {
    const ttl = this.cfg.cacheTtlMs ?? 0;
    if (
      ttl > 0 &&
      nowSecOverride === undefined &&
      this.cachedSnapshot &&
      Date.now() - this.cachedSnapshot.cachedAtMs < ttl
    ) {
      const cachedAgeSec = Math.max(0, Math.floor(Date.now() / 1000) - this.cachedSnapshot.snapshot.timestamp);
      const maxAge = this.cfg.maxSnapshotAgeSec;
      if (maxAge === undefined || cachedAgeSec <= maxAge) {
        return this.cachedSnapshot.snapshot;
      }
      // Never return stale cached data as a fresh observation
      this.cachedSnapshot = null;
    }

    const anomalies: string[] = [];

    const pool = await this.cfg.dexVenue.getPoolState(
      this.cfg.poolAddress,
      intent.inventoryToken,
      intent.paymentToken,
    );
    const timestamp = nowSecOverride ?? pool.timestamp;
    const blockNumber = pool.blockNumber;

    if (pool.spotPriceX36 <= 0n) {
      anomalies.push("INVALID_SPOT_PRICE:spotPriceX36<=0");
    }

    if (blockNumber !== undefined && this.lastBlockNumber !== null && blockNumber < this.lastBlockNumber) {
      anomalies.push(`BLOCK_NUMBER_REGRESSION:${blockNumber}<${this.lastBlockNumber}`);
    }

    if (this.lastSnapshotTimestamp !== null && timestamp < this.lastSnapshotTimestamp) {
      anomalies.push(`TIMESTAMP_REGRESSION:${timestamp}<${this.lastSnapshotTimestamp}`);
    }

    if (nowSecOverride === undefined && this.cfg.maxSnapshotAgeSec !== undefined) {
      const wallAgeSec = Math.floor(Date.now() / 1000) - pool.timestamp;
      if (wallAgeSec > this.cfg.maxSnapshotAgeSec) {
        anomalies.push(`STALE_POOL_TIMESTAMP:${wallAgeSec}s>${this.cfg.maxSnapshotAgeSec}s`);
      }
    }

    if (pool.liquidity < this.cfg.minPoolLiquidity) {
      anomalies.push(`LOW_POOL_LIQUIDITY:${pool.liquidity}<${this.cfg.minPoolLiquidity}`);
    }

    let dexBuyQuote: DexBuyQuote | null = null;
    let dexSellQuote: DexSellQuote | null = null;
    try {
      dexBuyQuote = await this.cfg.dexVenue.quoteBuyInventory(
        intent.inventoryToken,
        intent.paymentToken,
        intent.targetAmount,
        this.cfg.poolFee,
        pool.spotPriceX36,
      );
    } catch (err) {
      anomalies.push(`DEX_BUY_QUOTE_FAILED:${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      dexSellQuote = await this.cfg.dexVenue.quoteSellInventory(
        intent.inventoryToken,
        intent.paymentToken,
        intent.targetAmount,
        this.cfg.poolFee,
        pool.spotPriceX36,
      );
    } catch (err) {
      anomalies.push(`DEX_SELL_QUOTE_FAILED:${err instanceof Error ? err.message : String(err)}`);
    }

    // Oracle reading & freshness/deviation validation
    let oracle: OracleReading | null = null;
    let oracleAgeSec: number | null = null;
    let oracleDeviationBps: number | null = null;
    if (this.cfg.oracleReader) {
      try {
        oracle = await this.cfg.oracleReader.getPriceX36(intent.inventoryToken, intent.paymentToken);
        if (!oracle.isValid || oracle.priceX36 === 0n) {
          anomalies.push("ORACLE_INVALID");
        } else {
          oracleAgeSec = Math.max(0, timestamp - oracle.updatedAt);
          if (oracleAgeSec > this.cfg.maxOracleAgeSec) {
            anomalies.push(`ORACLE_STALE:${oracleAgeSec}s>${this.cfg.maxOracleAgeSec}s`);
          }
          if (pool.spotPriceX36 > 0n) {
            const diff =
              oracle.priceX36 > pool.spotPriceX36
                ? oracle.priceX36 - pool.spotPriceX36
                : pool.spotPriceX36 - oracle.priceX36;
            const minP = oracle.priceX36 < pool.spotPriceX36 ? oracle.priceX36 : pool.spotPriceX36;
            oracleDeviationBps = Number((diff * BPS_DENOMINATOR) / minP);
            if (oracleDeviationBps > this.cfg.maxOracleDeviationBps) {
              anomalies.push(
                `ORACLE_DEVIATION:${oracleDeviationBps}bps>${this.cfg.maxOracleDeviationBps}bps`,
              );
            }
          }
        }
      } catch (err) {
        anomalies.push(`ORACLE_READ_FAILED:${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Abnormal round-trip spread check
    if (dexBuyQuote && dexSellQuote && dexBuyQuote.paymentAmountIn > 0n) {
      const roundTripSpreadBps =
        dexBuyQuote.paymentAmountIn > dexSellQuote.paymentAmountOut
          ? Number(
              ((dexBuyQuote.paymentAmountIn - dexSellQuote.paymentAmountOut) * BPS_DENOMINATOR) /
                dexBuyQuote.paymentAmountIn,
            )
          : 0;
      const maxSpread = this.cfg.maxAbnormalSpreadBps ?? 500;
      if (roundTripSpreadBps > maxSpread) {
        anomalies.push(`ABNORMAL_SPREAD:${roundTripSpreadBps}bps>${maxSpread}bps`);
      }
    }

    // Discover & evaluate Tranche offers using existing TrancheExecutionAgent
    const trancheOffers = await this.cfg.trancheAgent.evaluateOffers(intent, timestamp);

    // Record observation & compute rolling metrics only when spot price is valid & monotonic
    const hasConsistencyAnomaly = anomalies.some(
      (a) =>
        a.startsWith("INVALID_SPOT_PRICE") ||
        a.startsWith("BLOCK_NUMBER_REGRESSION") ||
        a.startsWith("TIMESTAMP_REGRESSION"),
    );
    if (!hasConsistencyAnomaly) {
      if (blockNumber !== undefined) this.lastBlockNumber = blockNumber;
      this.lastSnapshotTimestamp = timestamp;
      this.pushObservation({
        timestamp,
        spotPriceX36: pool.spotPriceX36,
        twapPriceX36: pool.twapPriceX36,
        poolLiquidity: pool.liquidity,
        dexEntryCostPayment: dexBuyQuote?.paymentAmountIn ?? null,
        dexExitProceedsPayment: dexSellQuote?.paymentAmountOut ?? null,
        dexEntryImpactBps: dexBuyQuote?.priceImpactBps ?? null,
        dexExitImpactBps: dexSellQuote?.priceImpactBps ?? null,
      });
    }

    const realizedVolatilityBps = this.computeRealizedVolatilityBps();
    const momentumReturnBps = this.computeMomentumReturnBps();
    const dislocationVsTwapBps = this.computeDislocationVsTwapBps(pool.spotPriceX36, pool.twapPriceX36);
    const marketRegime = classifyMarketRegime({
      realizedVolatilityBps,
      momentumReturnBps,
      dislocationVsTwapBps,
    });

    const dataSourceHealthy = anomalies.length === 0;
    const snapshot: MarketSnapshot = {
      timestamp,
      blockNumber,
      inventoryToken: intent.inventoryToken,
      paymentToken: intent.paymentToken,
      targetAmount: intent.targetAmount,
      pool,
      dexBuyQuote,
      dexSellQuote,
      oracle,
      oracleAgeSec,
      oracleDeviationBps,
      trancheOffers,
      realizedVolatilityBps,
      momentumReturnBps,
      dislocationVsTwapBps,
      marketRegime,
      anomalies,
      dataSourceHealthy,
    };
    this.cachedSnapshot = dataSourceHealthy && ttl > 0 ? { snapshot, cachedAtMs: Date.now() } : null;
    return snapshot;
  }

  private pushObservation(obs: MarketObservation): void {
    this.history.push(obs);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  private computeMomentumReturnBps(): number {
    if (this.history.length < 2) return 0;
    const first = this.history[0].spotPriceX36;
    const last = this.history[this.history.length - 1].spotPriceX36;
    if (first === 0n) return 0;
    return Number(((last - first) * BPS_DENOMINATOR) / first);
  }

  private computeRealizedVolatilityBps(): number {
    if (this.history.length < 2) return 0;
    let minP = this.history[0].spotPriceX36;
    let maxP = this.history[0].spotPriceX36;
    for (const obs of this.history) {
      if (obs.spotPriceX36 < minP) minP = obs.spotPriceX36;
      if (obs.spotPriceX36 > maxP) maxP = obs.spotPriceX36;
    }
    if (minP === 0n) return 0;
    return Number(((maxP - minP) * BPS_DENOMINATOR) / minP);
  }

  private computeDislocationVsTwapBps(spot: bigint, twap: bigint | null): number {
    if (!twap || twap === 0n || spot === 0n) return 0;
    return Number(((spot - twap) * BPS_DENOMINATOR) / twap);
  }
}
