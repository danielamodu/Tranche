// Step 4: Quantitative Evaluation of Numerical Kill Criteria, Floating Strike Risk,
// and Fixed Strike (Black-Scholes Short-Gamma) Economics on HashKey Chain mainnet.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Standard normal PDF & CDF (Abramowitz & Stegun approximation, max error < 7.5e-8)
function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
function normCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
      Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

// Black-Scholes European Call / Put value as fraction of spot S0 (r = 0 for short crypto tenors)
// moneyness = K / S0, sigma = annualized vol (decimal), T = tenor in years
function bsOptionPct(isCall, moneyness, sigma, T) {
  if (T <= 0 || sigma <= 0) {
    return isCall ? Math.max(0, 1 - moneyness) : Math.max(0, moneyness - 1);
  }
  const volSqrtT = sigma * Math.sqrt(T);
  const d1 = (-Math.log(moneyness) + 0.5 * sigma * sigma * T) / volSqrtT;
  const d2 = d1 - volSqrtT;
  if (isCall) {
    return normCdf(d1) - moneyness * normCdf(d2);
  } else {
    return moneyness * normCdf(-d2) - normCdf(-d1);
  }
}

// Expected one-sided oracle staleness toxicity loss (as fraction of notional)
// when taker holds a one-sided option to fill at stale P_ref * (1 + spread) while true price moves by N(0, sigma_tau^2):
// E[max(Delta - spread, 0)] = sigma_tau * phi(z) - spread * (1 - Phi(z)), where z = spread / sigma_tau
function oracleStalenessToxicityBps(sigmaAnnual, latencySec, spreadBps) {
  const T = latencySec / 31536000;
  const sigmaTau = sigmaAnnual * Math.sqrt(T);
  const s = spreadBps / 10000;
  if (sigmaTau <= 0) return 0;
  const z = s / sigmaTau;
  const lossFrac = sigmaTau * normPdf(z) - s * (1 - normCdf(z));
  return lossFrac * 10000;
}

function main() {
  const analysis = JSON.parse(fs.readFileSync(path.join(__dirname, "analysis_summary.json"), "utf8"));
  const { metadata, gasSummary, pools } = analysis;

  // =========================================================================
  // 1. EXPLICIT NUMERICAL KILL CRITERIA (DEFINED PRIOR TO CONCLUSION)
  // =========================================================================
  const KILL_CRITERIA = {
    KC1_minDailyPoolVolumeUsd: 10000, // Minimum $10,000/day observed DEX volume per target pool to sustain organic retail fee demand
    KC2_minLargeSwapCount14d_ge5000: 14, // Minimum 1 large swap/day (>= $5,000) over 14d (>= 14 swaps) showing active on-chain block-trade demand
    KC3_minAmmSlippageAdvantageBps_at10k: 100, // AMM all-in cost at $10,000 must exceed 100 bps (so protocol has >= 50-100 bps net savings margin)
    KC4_maxGasDragPctOfPremium_at10k: 5.0, // V3 withdraw+redeploy gas cost must be <= 5.0% of a 20 bps ($20) reservation fee at $10k (<= 1.0 bps)
    KC5_maxLpOpportunityCostAprPct: 10.0, // Current passive LP APR must be <= 10% (if LPs earn >10% passively, reservation fees are unattractive)
    KC6_maxOracleStalenessSec_at15bpsSpread: 30, // At 15 bps spread, expected staleness toxicity must stay < 2.0 bps under normal latency <= 30s
  };

  const killEvaluation = {};
  for (const [addr, p] of Object.entries(pools)) {
    const h = p.historical14d;
    const largeSwaps5k = h.sizeBuckets.find((b) => b.minUsd === 5000)?.count || 0;
    const largeSwaps1k = h.sizeBuckets.find((b) => b.minUsd === 1000)?.count || 0;
    const largeSwaps500 = h.sizeBuckets.find((b) => b.minUsd === 500)?.count || 0;
    const impact10kBuy = p.priceImpactTable.find((r) => r.tradeUsd === 10000)?.buyBase.allInCostBps || 0;
    const impact10kSell = p.priceImpactTable.find((r) => r.tradeUsd === 10000)?.sellBase.allInCostBps || 0;
    const impact5kBuy = p.priceImpactTable.find((r) => r.tradeUsd === 5000)?.buyBase.allInCostBps || 0;
    const gasDrag10kBps = p.gasDragByNotionalBps.find((g) => g.notionalUsd === 10000)?.conservativeGasBps || 0;
    const gasPctOf20bpsFee = (gasDrag10kBps / 20) * 100;
    const tox30s = oracleStalenessToxicityBps(h.realizedAnnualizedVolPct / 100, 30, 15);

    killEvaluation[addr] = {
      name: p.name,
      metrics: {
        avgDailyVolUsd: h.avgDailyVolUsd,
        largeSwapsGe5000_14d: largeSwaps5k,
        largeSwapsGe1000_14d: largeSwaps1k,
        largeSwapsGe500_14d: largeSwaps500,
        maxObservedSwapUsd: h.swapSizeStatsUsd.max,
        ammAllIn10kBuyBps: impact10kBuy,
        ammAllIn10kSellBps: impact10kSell,
        ammAllIn5kBuyBps: impact5kBuy,
        gasDrag10kBps,
        gasPctOf20bpsFee,
        lpFeeAprPct: h.lpFeeAprPct,
        toxAt30sAnd15bpsBps: tox30s,
      },
      checks: {
        KC1_dailyVolume: {
          threshold: `>= $${KILL_CRITERIA.KC1_minDailyPoolVolumeUsd}/day`,
          observed: `$${h.avgDailyVolUsd.toFixed(2)}/day`,
          status: h.avgDailyVolUsd >= KILL_CRITERIA.KC1_minDailyPoolVolumeUsd ? "PASS" : "FAIL",
        },
        KC2_largeSwapFrequency: {
          threshold: `>= ${KILL_CRITERIA.KC2_minLargeSwapCount14d_ge5000} swaps >= $5k in 14d`,
          observed: `${largeSwaps5k} swaps >= $5k (${largeSwaps1k} >= $1k, max $${h.swapSizeStatsUsd.max.toFixed(2)})`,
          status: largeSwaps5k >= KILL_CRITERIA.KC2_minLargeSwapCount14d_ge5000 ? "PASS" : "FAIL",
        },
        KC3_ammSlippageAdvantage: {
          threshold: `>= ${KILL_CRITERIA.KC3_minAmmSlippageAdvantageBps_at10k} bps all-in at $10k`,
          observed: `${impact10kBuy.toFixed(1)} bps buy / ${impact10kSell.toFixed(1)} bps sell`,
          status: impact10kBuy >= KILL_CRITERIA.KC3_minAmmSlippageAdvantageBps_at10k ? "PASS" : "FAIL",
        },
        KC4_gasDragEfficiency: {
          threshold: `<= ${KILL_CRITERIA.KC4_maxGasDragPctOfPremium_at10k}% of 20 bps fee at $10k`,
          observed: `${gasPctOf20bpsFee.toFixed(3)}% (${gasDrag10kBps.toFixed(4)} bps)`,
          status: gasPctOf20bpsFee <= KILL_CRITERIA.KC4_maxGasDragPctOfPremium_at10k ? "PASS" : "FAIL",
        },
        KC5_lpOpportunityCost: {
          threshold: `<= ${KILL_CRITERIA.KC5_maxLpOpportunityCostAprPct}% passive LP APR`,
          observed: `${h.lpFeeAprPct.toFixed(2)}% APR`,
          status: h.lpFeeAprPct <= KILL_CRITERIA.KC5_maxLpOpportunityCostAprPct ? "PASS" : "FAIL",
        },
        KC6_oracleToxicityAt30s: {
          threshold: `< 2.0 bps expected toxicity at 30s latency & 15 bps spread`,
          observed: `${tox30s.toFixed(4)} bps (realized vol ${h.realizedAnnualizedVolPct.toFixed(1)}%)`,
          status: tox30s < 2.0 ? "PASS" : "BORDERLINE/FAIL",
        },
      },
    };
  }

  // =========================================================================
  // 2. FLOATING STRIKE MODELING: ORACLE TOXICITY & INVENTORY SKEW
  // =========================================================================
  const latenciesSec = [2, 10, 30, 60, 300, 1800, 3600];
  const spreadsBps = [5, 10, 15, 25, 50];
  const floatingOracleSensitivity = {};

  for (const [addr, p] of Object.entries(pools)) {
    const sigmaRealized = p.historical14d.realizedAnnualizedVolPct / 100;
    const sigmaStress = Math.max(sigmaRealized, 0.80); // 80% stressed annualized vol
    const matrixRealized = [];
    const matrixStress = [];
    for (const lat of latenciesSec) {
      const rowR = { latencySec: lat };
      const rowS = { latencySec: lat };
      for (const sp of spreadsBps) {
        rowR[`spread_${sp}bps`] = Number(oracleStalenessToxicityBps(sigmaRealized, lat, sp).toFixed(4));
        rowS[`spread_${sp}bps`] = Number(oracleStalenessToxicityBps(sigmaStress, lat, sp).toFixed(4));
      }
      matrixRealized.push(rowR);
      matrixStress.push(rowS);
    }
    // Observed directional skew in 14d data
    const totalVol = p.historical14d.totalVolUsd;
    const sellSharePct = totalVol > 0 ? (p.historical14d.sellBaseVolUsd / totalVol) * 100 : 50;
    const buySharePct = totalVol > 0 ? (p.historical14d.buyBaseVolUsd / totalVol) * 100 : 50;

    floatingOracleSensitivity[addr] = {
      name: p.name,
      realizedAnnualizedVolPct: p.historical14d.realizedAnnualizedVolPct,
      stressedAnnualizedVolPct: sigmaStress * 100,
      observedSellBaseSharePct: sellSharePct,
      observedBuyBaseSharePct: buySharePct,
      toxicityBpsAtRealizedVol: matrixRealized,
      toxicityBpsAtStressedVol: matrixStress,
    };
  }

  // =========================================================================
  // 3. FIXED STRIKE MODELING: BLACK-SCHOLES OPTION COST & BREAKEVEN FRONTIER
  // =========================================================================
  const tenorsHours = [1, 6, 24, 72, 168]; // 1h, 6h, 24h, 3d, 7d
  const moneynessLevels = [1.0, 1.01, 1.02, 1.05]; // ATM, +1% OTM, +2% OTM, +5% OTM (for Call)
  const fixedStrikeModels = {};

  for (const [addr, p] of Object.entries(pools)) {
    const sigmaRealized = p.historical14d.realizedAnnualizedVolPct / 100;
    const sigmaImplied = sigmaRealized * 1.25; // 1.25x adverse-selection / IV-RV risk premium markup
    const rows = [];

    for (const hrs of tenorsHours) {
      const T = hrs / (365 * 24);
      const entry = { tenorHours: hrs };
      for (const m of moneynessLevels) {
        const callRealizedBps = bsOptionPct(true, m, sigmaRealized, T) * 10000;
        const callImpliedBps = bsOptionPct(true, m, sigmaImplied, T) * 10000;
        // Find minimum trade size on this pool's AMM where AMM all-in buy cost >= callImpliedBps
        entry[`K_${Math.round((m - 1) * 100)}pct_OTM`] = {
          realizedVolBps: Number(callRealizedBps.toFixed(2)),
          pricedIvBps: Number(callImpliedBps.toFixed(2)),
          ammBreakevenNotionalUsd: findAmmBreakeven(p.priceImpactTable, callImpliedBps),
        };
      }
      rows.push(entry);
    }

    // Also compute implied annualized LP yield on collateral if LP sells 24h ATM/2% OTM commitments
    // Assuming 50% utilization of committed inventory
    const atm24hBps = bsOptionPct(true, 1.0, sigmaImplied, 24 / (365 * 24)) * 10000;
    const otm2_24hBps = bsOptionPct(true, 1.02, sigmaImplied, 24 / (365 * 24)) * 10000;

    fixedStrikeModels[addr] = {
      name: p.name,
      realizedAnnualizedVolPct: sigmaRealized * 100,
      pricedImpliedVolPct: sigmaImplied * 100,
      optionCostTableBps: rows,
      // Reservation fee gross APR if 100% utilized vs 25% utilized (note: option premium compensates short-gamma, NOT risk-free!)
      grossPremiumYield24hAtmAt25PctUtilApr: (atm24hBps / 10000) * 365 * 0.25 * 100,
      grossPremiumYield24hOtm2At25PctUtilApr: (otm2_24hBps / 10000) * 365 * 0.25 * 100,
    };
  }

  const out = {
    metadata,
    gasSummary,
    KILL_CRITERIA,
    killEvaluation,
    floatingOracleSensitivity,
    fixedStrikeModels,
  };

  const outPath = path.join(__dirname, "model_evaluation.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Saved model evaluation to ${outPath}\n`);

  console.log("=== KILL CRITERIA EVALUATION ===");
  for (const k of Object.values(killEvaluation)) {
    console.log(`\nPool: ${k.name}`);
    for (const [kc, val] of Object.entries(k.checks)) {
      console.log(`  ${kc}: [${val.status}] observed=${val.observed} (threshold: ${val.threshold})`);
    }
  }

  console.log("\n=== FIXED STRIKE (BLACK-SCHOLES IV = 1.25x RV) OPTION COST (bps) ===");
  for (const fm of Object.values(fixedStrikeModels)) {
    console.log(`\nPool: ${fm.name} (RV=${fm.realizedAnnualizedVolPct.toFixed(2)}%, IV=${fm.pricedImpliedVolPct.toFixed(2)}%)`);
    for (const r of fm.optionCostTableBps) {
      console.log(
        `  T=${r.tenorHours}h | ATM=${r.K_0pct_OTM.pricedIvBps}bps (AMM BE: ${r.K_0pct_OTM.ammBreakevenNotionalUsd}) | +2%OTM=${r.K_2pct_OTM.pricedIvBps}bps (AMM BE: ${r.K_2pct_OTM.ammBreakevenNotionalUsd}) | +5%OTM=${r.K_5pct_OTM.pricedIvBps}bps`
      );
    }
  }

  console.log("\n=== FLOATING STRIKE ORACLE STALENESS TOXICITY (bps at 15 bps spread, Realized Vol) ===");
  for (const fl of Object.values(floatingOracleSensitivity)) {
    console.log(
      `\nPool: ${fl.name} (RV=${fl.realizedAnnualizedVolPct.toFixed(2)}%, SellShare=${fl.observedSellBaseSharePct.toFixed(1)}%)`
    );
    for (const row of fl.toxicityBpsAtRealizedVol) {
      console.log(
        `  latency=${row.latencySec}s: @5bps=${row.spread_5bps} | @10bps=${row.spread_10bps} | @15bps=${row.spread_15bps} | @25bps=${row.spread_25bps} | @50bps=${row.spread_50bps}`
      );
    }
  }
}

function findAmmBreakeven(priceImpactTable, targetBps) {
  for (let i = 0; i < priceImpactTable.length; i++) {
    const cur = priceImpactTable[i];
    if (cur.buyBase.allInCostBps >= targetBps) {
      if (i === 0) return `< $${cur.tradeUsd}`;
      const prev = priceImpactTable[i - 1];
      const frac =
        (targetBps - prev.buyBase.allInCostBps) /
        (cur.buyBase.allInCostBps - prev.buyBase.allInCostBps);
      const est = prev.tradeUsd + frac * (cur.tradeUsd - prev.tradeUsd);
      return `~$${Math.round(est)}`;
    }
  }
  return "> $250,000";
}

main();
