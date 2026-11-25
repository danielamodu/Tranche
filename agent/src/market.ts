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

export interface MarketSnapshot {
  timestamp: number;
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
  anomalies: string[];
}

export interface MarketIntelligenceConfig {
  dexVenue: DexVenueAdapter;
  trancheAgent: TrancheExecutionAgent;
  oracleReader?: OracleReader;
  poolAddress: Address;
  poolFee: number;
  maxHistorySize?: number;
  minPoolLiquidity: bigint;
  maxOracleAgeSec: number;
  maxOracleDeviationBps: number;
  maxAbnormalSpreadBps?: number;
}

/**
 * Modular market-intelligence layer combining live DEX quotes, Tranche offer discovery,
 * oracle freshness/deviation checks, and rolling price/volatility history.
 */
export class MarketIntelligence {
  private readonly cfg: MarketIntelligenceConfig;
  private readonly history: MarketObservation[] = [];
  private readonly maxHistory: number;

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
    const anomalies: string[] = [];

    const pool = await this.cfg.dexVenue.getPoolState(
      this.cfg.poolAddress,
      intent.inventoryToken,
      intent.paymentToken,
    );
    const timestamp = nowSecOverride ?? pool.timestamp;

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

    // Record observation & compute rolling metrics
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

    const realizedVolatilityBps = this.computeRealizedVolatilityBps();
    const momentumReturnBps = this.computeMomentumReturnBps();
    const dislocationVsTwapBps = this.computeDislocationVsTwapBps(pool.spotPriceX36, pool.twapPriceX36);

    return {
      timestamp,
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
      anomalies,
    };
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
