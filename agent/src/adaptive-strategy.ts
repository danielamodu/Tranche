import type { MarketRegime, MarketSnapshot } from "./market.js";
import { StrategyEngine, type StrategyConfig, type StrategySignal, type StrategyType } from "./strategy.js";

export interface AdaptiveStrategyHardBounds {
  minTakeProfitBps: number;
  maxTakeProfitBps: number;
  minStopLossBps: number;
  maxStopLossBps: number;
  hardMaxVolatilityBps: number;
}

export interface AdaptiveStrategyConfig {
  enabled: boolean;
  baseStrategy: StrategyConfig;
  minPoolLiquidity: bigint;
  maxOracleAgeSec: number;
  maxOracleDeviationBps: number;
  /** Maximum positive TWAP deviation (bps) above which buying is deemed chasing an overheated spike. */
  maxPositiveTwapDislocationBps: number;
  hardBounds: AdaptiveStrategyHardBounds;
  regimeOverrides?: Partial<
    Record<
      MarketRegime,
      Partial<
        Pick<
          StrategyConfig,
          "type" | "takeProfitBps" | "stopLossBps" | "momentumThresholdBps" | "dislocationThresholdBps"
        >
      >
    >
  >;
}

export interface AdaptiveStrategyDecision {
  regime: MarketRegime;
  suitableForTrading: boolean;
  unsuitableReasons: string[];
  selectedStrategyType: StrategyType | "NONE";
  effectiveConfig: StrategyConfig;
  signal: StrategySignal;
  adjustmentsApplied: string[];
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Regime-aware adaptive strategy layer.
 *
 * Dynamically selects among deterministic strategies (`momentum`, `price_threshold`,
 * `volatility_aware`) based on MarketIntelligence regime classification and applies
 * strictly bounded parameter adjustments. Returns `NONE` / `WAIT` whenever market
 * suitability checks fail (stale oracle, thin liquidity, anomalies, extreme volatility).
 */
export class AdaptiveStrategyEngine {
  private readonly strategyEngine = new StrategyEngine();

  evaluate(snapshot: MarketSnapshot, cfg: AdaptiveStrategyConfig): AdaptiveStrategyDecision {
    const regime = snapshot.marketRegime;
    const unsuitableReasons: string[] = [];

    if (snapshot.anomalies.length > 0) {
      unsuitableReasons.push(`MARKET_ANOMALIES(${snapshot.anomalies.join(",")})`);
    }
    if (snapshot.pool.liquidity < cfg.minPoolLiquidity) {
      unsuitableReasons.push(`THIN_LIQUIDITY(${snapshot.pool.liquidity}<${cfg.minPoolLiquidity})`);
    }
    if (snapshot.oracle !== null) {
      if (!snapshot.oracle.isValid || snapshot.oracle.priceX36 <= 0n) {
        unsuitableReasons.push("ORACLE_INVALID");
      }
      if (snapshot.oracleAgeSec !== null && snapshot.oracleAgeSec > cfg.maxOracleAgeSec) {
        unsuitableReasons.push(`ORACLE_STALE(${snapshot.oracleAgeSec}s>${cfg.maxOracleAgeSec}s)`);
      }
      if (
        snapshot.oracleDeviationBps !== null &&
        snapshot.oracleDeviationBps > cfg.maxOracleDeviationBps
      ) {
        unsuitableReasons.push(
          `ORACLE_DEVIATION(${snapshot.oracleDeviationBps}bps>${cfg.maxOracleDeviationBps}bps)`,
        );
      }
    }
    if (snapshot.realizedVolatilityBps > cfg.hardBounds.hardMaxVolatilityBps) {
      unsuitableReasons.push(
        `EXTREME_VOLATILITY(${snapshot.realizedVolatilityBps}bps>${cfg.hardBounds.hardMaxVolatilityBps}bps)`,
      );
    }
    if (snapshot.dislocationVsTwapBps > cfg.maxPositiveTwapDislocationBps) {
      unsuitableReasons.push(
        `OVERHEATED_ABOVE_TWAP(+${snapshot.dislocationVsTwapBps}bps>+${cfg.maxPositiveTwapDislocationBps}bps)`,
      );
    }

    if (unsuitableReasons.length > 0) {
      const waitSignal: StrategySignal = {
        strategyType: cfg.baseStrategy.type,
        action: "WAIT",
        timestamp: snapshot.timestamp,
        valid: false,
        confidence: 0,
        reason: `Unsuitable market conditions (${regime}): ${unsuitableReasons.join("; ")}`,
        invalidationConditions: ["Await healthy liquidity, fresh oracle, and bounded volatility"],
        supportingData: {
          spotPriceX36: snapshot.pool.spotPriceX36,
          twapPriceX36: snapshot.pool.twapPriceX36,
          momentumReturnBps: snapshot.momentumReturnBps,
          realizedVolatilityBps: snapshot.realizedVolatilityBps,
          dislocationVsTwapBps: snapshot.dislocationVsTwapBps,
          anomalies: [...snapshot.anomalies],
        },
      };
      return {
        regime,
        suitableForTrading: false,
        unsuitableReasons,
        selectedStrategyType: "NONE",
        effectiveConfig: { ...cfg.baseStrategy },
        signal: waitSignal,
        adjustmentsApplied: [],
      };
    }

    // Default regime -> strategy mapping (deterministic, bounded)
    const adjustmentsApplied: string[] = [];
    const effective: StrategyConfig = { ...cfg.baseStrategy };

    if (cfg.enabled) {
      if (regime === "TRENDING") {
        effective.type = "momentum";
        adjustmentsApplied.push("regime=TRENDING->strategy=momentum");
      } else if (regime === "DISLOCATED") {
        effective.type = "volatility_aware";
        // Tighten stop-loss slightly in dislocated regime within hard bounds
        effective.stopLossBps = clampInt(
          Math.round(cfg.baseStrategy.stopLossBps * 0.85),
          cfg.hardBounds.minStopLossBps,
          cfg.hardBounds.maxStopLossBps,
        );
        adjustmentsApplied.push(
          `regime=DISLOCATED->strategy=volatility_aware,stopLossBps=${effective.stopLossBps}`,
        );
      } else if (regime === "VOLATILE") {
        effective.type = "volatility_aware";
        effective.takeProfitBps = clampInt(
          Math.round(cfg.baseStrategy.takeProfitBps * 1.15),
          cfg.hardBounds.minTakeProfitBps,
          cfg.hardBounds.maxTakeProfitBps,
        );
        effective.stopLossBps = clampInt(
          Math.round(cfg.baseStrategy.stopLossBps * 0.9),
          cfg.hardBounds.minStopLossBps,
          cfg.hardBounds.maxStopLossBps,
        );
        adjustmentsApplied.push(
          `regime=VOLATILE->strategy=volatility_aware,tp=${effective.takeProfitBps},sl=${effective.stopLossBps}`,
        );
      } else {
        // CALM
        effective.type = "price_threshold";
        adjustmentsApplied.push("regime=CALM->strategy=price_threshold");
      }

      // Apply optional bounded regime overrides
      const ov = cfg.regimeOverrides?.[regime];
      if (ov) {
        if (ov.type) effective.type = ov.type;
        if (ov.takeProfitBps !== undefined) {
          effective.takeProfitBps = clampInt(
            ov.takeProfitBps,
            cfg.hardBounds.minTakeProfitBps,
            cfg.hardBounds.maxTakeProfitBps,
          );
        }
        if (ov.stopLossBps !== undefined) {
          effective.stopLossBps = clampInt(
            ov.stopLossBps,
            cfg.hardBounds.minStopLossBps,
            cfg.hardBounds.maxStopLossBps,
          );
        }
        if (ov.momentumThresholdBps !== undefined && ov.momentumThresholdBps > 0) {
          effective.momentumThresholdBps = ov.momentumThresholdBps;
        }
        if (ov.dislocationThresholdBps !== undefined && ov.dislocationThresholdBps > 0) {
          effective.dislocationThresholdBps = ov.dislocationThresholdBps;
        }
        adjustmentsApplied.push(`applied_bounded_override(${regime})`);
      }

      // Enforce hard volatility ceiling regardless of base config
      effective.maxVolatilityBps = Math.min(
        effective.maxVolatilityBps,
        cfg.hardBounds.hardMaxVolatilityBps,
      );
    }

    const signal = this.strategyEngine.evaluateEntry(snapshot, effective);
    return {
      regime,
      suitableForTrading: true,
      unsuitableReasons: [],
      selectedStrategyType: signal.action === "ENTER_LONG" ? effective.type : "NONE",
      effectiveConfig: effective,
      signal,
      adjustmentsApplied,
    };
  }
}
