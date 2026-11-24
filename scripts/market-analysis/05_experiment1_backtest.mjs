// Stage 1 — Experiment 1A: Historical HSKSwap vs. Tranche Economic Backtest (Corrected & Bootstrapped)
// Source of truth for protocol math: CommitmentManager.sol (_quoteReservation, _quoteExercise)
// and LiquidityVault.sol (collectFeeAndProceeds, settleExercise).
// Strictly separates OBSERVED 14-day on-chain data from SIMULATED / ASSUMED scenarios.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MARKET_DATA_PATH = path.join(__dirname, "market_data_14d.json");
const SUMMARY_PATH = path.join(__dirname, "analysis_summary.json");
const OUTPUT_JSON_PATH = path.join(__dirname, "experiment1_results.json");

const marketData = JSON.parse(fs.readFileSync(MARKET_DATA_PATH, "utf8"));
const summary = JSON.parse(fs.readFileSync(SUMMARY_PATH, "utf8"));

const Q96 = 2 ** 96;
const BPS = 10_000;
const SECONDS_PER_DAY = 86_400;
const DAYS_PER_YEAR = 365;
const BOOTSTRAP_RESAMPLES = 1_000;

// Measured gas units from Chain-133 fork validation (TestnetOperationalValidation.t.sol)
// priced at observed HashKey Chain Mainnet gas price (analysis_summary.json gasSummary).
const TRANCHE_GAS = {
  reserve: 409_915,
  exercise: 56_675,
  createOffer: 201_456,
  reclaimSingleApprox: 60_000,
  claimProceedsApprox: 55_000,
};

const USD_PER_GAS = summary.gasSummary.usdPer100kGas / 100_000;
const TRADER_GAS_RESERVE_ONLY_USD = TRANCHE_GAS.reserve * USD_PER_GAS;
const TRADER_GAS_FULL_USD = (TRANCHE_GAS.reserve + TRANCHE_GAS.exercise) * USD_PER_GAS;
const LP_CYCLE_GAS_USD = (TRANCHE_GAS.createOffer + TRANCHE_GAS.claimProceedsApprox) * USD_PER_GAS;
const V3_SWAP_GAS_USD = summary.gasSummary.medianSwapCostUsd;

// Pre-registered economic pass/fail criteria (unchanged)
const PASS_CRITERIA = {
  C1_minTraderSavingsBps: 25,
  C2_minLpNetMarginPerFillBps: 0.01,
  C3_mustBeatPassiveV3FeeApr: true,
  C4_minObserved14dEligibleSwapsAt1k: 14,
};

const POOL_CONFIGS = {
  "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc": {
    symbol: "WHSK/USDT",
    invSymbol: "WHSK",
    dec0: 18,
    dec1: 6,
    remediatedMinFillTokens: 1_000,
    floatingOffer: { basePremiumBps: 10, dailyPremiumBps: 10, spreadBps: 20 },
    fixedOffer: { basePremiumBps: 20, dailyPremiumBps: 25, strikeOffsetBps: 30 },
    lpRebalBpsBase: 10,
    promptOracleLagMarkoutBpsBase: 8,
  },
  "0xb92b79ed6b370d5cfee2e14b1d0983c258304c16": {
    symbol: "WETH/USDT",
    invSymbol: "WETH",
    dec0: 18,
    dec1: 6,
    remediatedMinFillTokens: 0.05,
    floatingOffer: { basePremiumBps: 10, dailyPremiumBps: 10, spreadBps: 25 },
    fixedOffer: { basePremiumBps: 25, dailyPremiumBps: 45, strikeOffsetBps: 50 },
    lpRebalBpsBase: 5,
    promptOracleLagMarkoutBpsBase: 12,
  },
  "0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a": {
    symbol: "WBTC/USDT",
    invSymbol: "WBTC",
    dec0: 8,
    dec1: 6,
    remediatedMinFillTokens: 0.001,
    floatingOffer: { basePremiumBps: 10, dailyPremiumBps: 10, spreadBps: 25 },
    fixedOffer: { basePremiumBps: 25, dailyPremiumBps: 50, strikeOffsetBps: 50 },
    lpRebalBpsBase: 5,
    promptOracleLagMarkoutBpsBase: 12,
  },
};

const TRADE_SIZES_USD = [1_000, 5_000, 10_000, 25_000];

const SCENARIOS = [
  {
    id: "base",
    label: "Base (Hypothetical 25% Util, Prompt Hedge)",
    utilization: 0.25,
    exerciseProbFloating: 0.85,
    markoutMultiplier: 1.0,
    rebalMultiplier: 1.0,
    durationHours: 24,
    protocolFeeBps: 5,
  },
  {
    id: "high_utilization",
    label: "High Utilization (Hypothetical 65% Util, Prompt Hedge)",
    utilization: 0.65,
    exerciseProbFloating: 0.90,
    markoutMultiplier: 1.2,
    rebalMultiplier: 1.0,
    durationHours: 24,
    protocolFeeBps: 5,
  },
  {
    id: "adverse_selection",
    label: "Adverse Selection (Hypothetical 25% Util, 3x Markout, 2x Rebal)",
    utilization: 0.25,
    exerciseProbFloating: 0.95,
    markoutMultiplier: 3.0,
    rebalMultiplier: 2.0,
    durationHours: 24,
    protocolFeeBps: 5,
  },
];

// Deterministic PRNG (Mulberry32) for reproducible block-bootstrap confidence intervals
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantileSorted(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

function bootstrapMeanCI90(samples, seed = 1337) {
  if (samples.length === 0) {
    return { nIndependentWindows: 0, sampleMean: null, median: null, lower90: null, upper90: null };
  }
  const sampleMean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const rng = mulberry32(seed);
  const means = [];
  const n = samples.length;
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += samples[Math.floor(rng() * n)];
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return {
    nIndependentWindows: n,
    sampleMean: round(sampleMean, 2),
    median: round(quantileSorted(means, 0.5), 2),
    lower90: round(quantileSorted(means, 0.05), 2),
    upper90: round(quantileSorted(means, 0.95), 2),
  };
}

function sqrtPriceX96ToUsd(sqrtPriceX96Str, dec0, dec1) {
  const sp = Number(BigInt(sqrtPriceX96Str)) / Q96;
  return sp * sp * 10 ** (dec0 - dec1);
}

function blockToTimestamp(blockNum) {
  const { fromBlock, fromTimestamp } = marketData.metadata.window;
  return fromTimestamp + (blockNum - fromBlock) * 2;
}

function effPremiumBpsFormula(basePremiumBps, dailyPremiumBps, durationSeconds) {
  return basePremiumBps + Math.ceil((dailyPremiumBps * durationSeconds) / SECONDS_PER_DAY);
}

function round(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// Explicit Two-Token Balance-Sheet Accounting (Solidity Source of Truth)
// Matches CommitmentManager._quoteReservation, _quoteExercise,
// LiquidityVault.collectFeeAndProceeds, and LiquidityVault.settleExercise.
// ---------------------------------------------------------------------------
function evaluateTwoTokenCycle({
  notionalUsd,
  p0,
  pEx,
  pEnd,
  fillFraction, // 0.0 (expired), 0.5 (partial), 1.0 (full)
  mode, // "FLOATING" | "FIXED"
  basePremiumBps,
  dailyPremiumBps,
  durationSeconds,
  spreadOrStrikeBps,
  protocolFeeBps,
  restockCostBps,
  hedgeDelayPrice, // price at which LP restocks filled inventory (null => zero hedging / keeps USDT)
  lpGasUsd,
  traderGasUsd,
}) {
  const Q = notionalUsd / p0; // Committed inventory tokens
  const effPremBps = effPremiumBpsFormula(basePremiumBps, dailyPremiumBps, durationSeconds);
  const f = protocolFeeBps / BPS;

  // 1. Reservation step (always paid upfront, non-refundable)
  // In Solidity: refPrice = fixedPrice (FIXED) or oracle * (1 + spread) (FLOATING)
  const refPriceRes = p0 * (1 + spreadOrStrikeBps / BPS);
  const notionalPayResUsd = Q * refPriceRes;
  const grossPremiumUsd = notionalPayResUsd * (effPremBps / BPS);
  const resProtocolFeeUsd = grossPremiumUsd * f;
  const lpNetPremiumUsd = grossPremiumUsd - resProtocolFeeUsd;

  // 2. Exercise step on filled quantity q = fillFraction * Q
  const qFilled = Q * fillFraction;
  const qRemaining = Q - qFilled;
  const effPriceEx =
    mode === "FIXED"
      ? p0 * (1 + spreadOrStrikeBps / BPS)
      : pEx * (1 + spreadOrStrikeBps / BPS);

  const grossExerciseUsd = qFilled * effPriceEx;
  const exProtocolFeeUsd = grossExerciseUsd * f;
  const lpNetExerciseUsd = grossExerciseUsd - exProtocolFeeUsd;

  // Conservation identity check (exact Solidity LiquidityVault._creditPayment invariant)
  const totalTreasuryFeeUsd = resProtocolFeeUsd + exProtocolFeeUsd;
  const totalTraderPaidUsd = grossPremiumUsd + grossExerciseUsd;
  const totalLpGrossReceiptsUsd = lpNetPremiumUsd + lpNetExerciseUsd;
  // totalTraderPaidUsd === totalLpGrossReceiptsUsd + totalTreasuryFeeUsd

  // 3. LP Inventory Exposure & Restocking / Hedging Cashflows
  // Initial LP committed inventory value = Q * p0 = notionalUsd
  // HODL benchmark value at cycle end = Q * pEnd
  const hodlEndUsd = Q * pEnd;

  let lpFinalValueUsd;
  let restockOutflowUsd = 0;

  if (qFilled === 0) {
    // Expired unexercised: LP reclaims 100% of Q + keeps non-refundable lpNetPremiumUsd - gas
    lpFinalValueUsd = Q * pEnd + lpNetPremiumUsd - lpGasUsd;
  } else if (hedgeDelayPrice === null) {
    // Zero hedging: LP holds USDT exercise proceeds + remaining inventory at pEnd
    lpFinalValueUsd = qRemaining * pEnd + lpNetPremiumUsd + lpNetExerciseUsd - lpGasUsd;
  } else {
    // LP buys back qFilled units at hedgeDelayPrice * (1 + restockCostBps/BPS) to restore Q units
    restockOutflowUsd = qFilled * hedgeDelayPrice * (1 + restockCostBps / BPS);
    const residualUsdtUsd = lpNetPremiumUsd + lpNetExerciseUsd - restockOutflowUsd - lpGasUsd;
    lpFinalValueUsd = Q * pEnd + residualUsdtUsd;
  }

  // LP P&L vs HODL (cleanly isolates execution + premium + hedge/option alpha from passive asset drift)
  const lpPnlVsHodlUsd = lpFinalValueUsd - hodlEndUsd;
  const lpPnlVsHodlBps = (lpPnlVsHodlUsd / notionalUsd) * BPS;

  // LP absolute mark-to-market P&L vs initial committed USD value (includes passive inventory drift)
  const lpPnlVsInitialUsd = lpFinalValueUsd - notionalUsd;
  const lpPnlVsInitialBps = (lpPnlVsInitialUsd / notionalUsd) * BPS;

  // Trader all-in cost vs exercise-time spot on filled quantity (or vs p0 if full immediate fill)
  const traderAllInVsSpotBps =
    qFilled > 0
      ? ((grossPremiumUsd + grossExerciseUsd + traderGasUsd - qFilled * pEx) / (qFilled * pEx)) * BPS
      : ((grossPremiumUsd + traderGasUsd) / notionalUsd) * BPS;

  return {
    fillFraction,
    effPremiumBps: effPremBps,
    grossPremiumUsd: round(grossPremiumUsd, 4),
    resProtocolFeeUsd: round(resProtocolFeeUsd, 4),
    lpNetPremiumUsd: round(lpNetPremiumUsd, 4),
    grossExerciseUsd: round(grossExerciseUsd, 4),
    exProtocolFeeUsd: round(exProtocolFeeUsd, 4),
    lpNetExerciseUsd: round(lpNetExerciseUsd, 4),
    totalTreasuryFeeUsd: round(totalTreasuryFeeUsd, 4),
    totalTraderPaidUsd: round(totalTraderPaidUsd, 4),
    totalLpGrossReceiptsUsd: round(totalLpGrossReceiptsUsd, 4),
    restockOutflowUsd: round(restockOutflowUsd, 4),
    hodlEndUsd: round(hodlEndUsd, 4),
    lpFinalValueUsd: round(lpFinalValueUsd, 4),
    lpPnlVsHodlUsd: round(lpPnlVsHodlUsd, 4),
    lpPnlVsHodlBps: round(lpPnlVsHodlBps, 2),
    lpPnlVsInitialBps: round(lpPnlVsInitialBps, 2),
    traderAllInVsSpotBps: round(traderAllInVsSpotBps, 2),
  };
}

// Reconstruct observed 14-day swap series + non-overlapping independent 24h & 6h windows
function analyzeObservedSwaps(poolAddr, cfg, summaryPool) {
  const swaps = marketData.events.swaps
    .filter((s) => s.pool.toLowerCase() === poolAddr)
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  const enriched = [];
  for (let i = 0; i < swaps.length; i++) {
    const s = swaps[i];
    const amt0 = Number(BigInt(s.amount0)) / 10 ** cfg.dec0;
    const amt1 = Number(BigInt(s.amount1)) / 10 ** cfg.dec1;
    const postPrice = sqrtPriceX96ToUsd(s.sqrtPriceX96, cfg.dec0, cfg.dec1);
    const prePrice = i > 0 ? enriched[i - 1].postPrice : postPrice;
    const ts = blockToTimestamp(s.blockNumber);
    const side = amt0 < 0 ? "BUY_BASE" : "SELL_BASE";
    const baseAbs = Math.abs(amt0);
    const usdtAbs = Math.abs(amt1);
    const effPrice = baseAbs > 0 ? usdtAbs / baseAbs : postPrice;
    const realizedAllInCostBps =
      i > 0 && prePrice > 0
        ? side === "BUY_BASE"
          ? ((effPrice - prePrice) / prePrice) * BPS
          : ((prePrice - effPrice) / prePrice) * BPS
        : null;

    enriched.push({
      blockNumber: s.blockNumber,
      ts,
      side,
      baseAbs,
      usdtAbs,
      prePrice,
      postPrice,
      effPrice,
      realizedAllInCostBps,
    });
  }

  // Helper: last observed price at or before timestamp t
  function priceAt(targetTs) {
    let lo = 0;
    let hi = enriched.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (enriched[mid].ts <= targetTs) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return enriched[best].postPrice;
  }

  // Build strictly NON-OVERLAPPING independent 24h windows (day 0..13) and 6h windows (0..55)
  const { fromTimestamp, toTimestamp } = marketData.metadata.window;
  const independent24hReturnsBps = [];
  const independent24hWindows = [];
  for (let t = fromTimestamp; t + SECONDS_PER_DAY <= toTimestamp; t += SECONDS_PER_DAY) {
    const pStart = priceAt(t);
    const pEnd = priceAt(t + SECONDS_PER_DAY);
    const retBps = ((pEnd - pStart) / pStart) * BPS;
    independent24hReturnsBps.push(retBps);
    independent24hWindows.push({ startTs: t, endTs: t + SECONDS_PER_DAY, pStart, pEnd, retBps });
  }

  const sixHours = 6 * 3600;
  const independent6hReturnsBps = [];
  for (let t = fromTimestamp; t + sixHours <= toTimestamp; t += sixHours) {
    const pStart = priceAt(t);
    const pEnd = priceAt(t + sixHours);
    independent6hReturnsBps.push(((pEnd - pStart) / pStart) * BPS);
  }

  // Empirical FIXED covered-call payoffs over independent 24h windows
  const strikeOffsetBps = cfg.fixedOffer.strikeOffsetBps;
  const independentFixedCallPayoffsBps = independent24hReturnsBps.map((r) =>
    r > strikeOffsetBps ? r - strikeOffsetBps : 0,
  );
  const fixedItmCount = independent24hReturnsBps.filter((r) => r > strikeOffsetBps).length;
  const fixedEmpiricalExerciseRate =
    independent24hReturnsBps.length > 0 ? fixedItmCount / independent24hReturnsBps.length : 0;

  // 14-day HODL & passive V3 benchmark
  const pFirst = enriched[0].postPrice;
  const pLast = enriched[enriched.length - 1].postPrice;
  const priceRatio = pLast / pFirst;
  const hodl14dReturnPct = (priceRatio - 1) * 100;
  const v3FullRangeIl14dPct = ((2 * Math.sqrt(priceRatio)) / (1 + priceRatio) - 1) * 100;
  const v3PassiveFee14dPct = (summaryPool.historical14d.fees14dUsd / summaryPool.tvlUsd) * 100;

  // Observed swap eligibility counts
  const minFillUsd = cfg.remediatedMinFillTokens * summaryPool.spotPriceUsd;
  const eligibleAtContractMin = enriched.filter((e) => e.usdtAbs >= minFillUsd);
  const eligibleAt1000 = enriched.filter((e) => e.usdtAbs >= 1_000);

  const validCosts = enriched
    .map((e) => e.realizedAllInCostBps)
    .filter((x) => x !== null && Number.isFinite(x) && x > -500 && x < 5000);
  const sortedCosts = [...validCosts].sort((a, b) => a - b);

  // Tail adverse 24h rally (90th percentile positive move) for failed-restocking stress
  const sorted24h = [...independent24hReturnsBps].sort((a, b) => a - b);
  const p90AdverseRally24hBps = Math.max(0, quantileSorted(sorted24h, 0.9) ?? 0);

  return {
    observedSwapCount: enriched.length,
    observed14dVolumeUsd: round(summaryPool.historical14d.totalVolUsd, 2),
    observedAvgDailyVolUsd: round(summaryPool.historical14d.avgDailyVolUsd, 2),
    observedMaxSwapUsd: round(summaryPool.historical14d.swapSizeStatsUsd.max, 2),
    realizedStartPriceUsd: round(pFirst, 6),
    realizedEndPriceUsd: round(pLast, 6),
    hodl14dReturnPct: round(hodl14dReturnPct, 3),
    v3PassiveFee14dPct: round(v3PassiveFee14dPct, 4),
    v3PassiveFeeAprPct: round(summaryPool.historical14d.lpFeeAprPct, 3),
    v3FullRangeIl14dPct: round(v3FullRangeIl14dPct, 4),
    v3LpVs5050Hodl14dPct: round(v3PassiveFee14dPct + v3FullRangeIl14dPct, 4),
    realizedSwapCostStatsBps: {
      sampleCount: validCosts.length,
      medianBps: round(quantileSorted(sortedCosts, 0.5), 2),
      meanBps: round(validCosts.reduce((a, b) => a + b, 0) / validCosts.length, 2),
    },
    eligibility: {
      contractMinFillTokens: cfg.remediatedMinFillTokens,
      contractMinFillUsd: round(minFillUsd, 2),
      eligibleSwapsAtContractMin: eligibleAtContractMin.length,
      eligibleVolumeAtContractMinUsd: round(
        eligibleAtContractMin.reduce((a, b) => a + b.usdtAbs, 0),
        2,
      ),
      eligibleSwapsAt1000Usd: eligibleAt1000.length,
      eligibleVolumeAt1000Usd: round(eligibleAt1000.reduce((a, b) => a + b.usdtAbs, 0), 2),
    },
    independentWindows: {
      count24h: independent24hWindows.length,
      count6h: independent6hReturnsBps.length,
      mean24hReturnBps: round(
        independent24hReturnsBps.reduce((a, b) => a + b, 0) / independent24hReturnsBps.length,
        2,
      ),
      mean6hReturnBps: round(
        independent6hReturnsBps.reduce((a, b) => a + b, 0) / independent6hReturnsBps.length,
        2,
      ),
      p90AdverseRally24hBps: round(p90AdverseRally24hBps, 2),
      fixedEmpiricalExerciseRate: round(fixedEmpiricalExerciseRate, 4),
      fixedCallPayoff24hCI90: bootstrapMeanCI90(independentFixedCallPayoffsBps, 101),
      independent24hReturnsBps,
      independent6hReturnsBps,
      independentFixedCallPayoffsBps,
    },
  };
}

// Simulate FLOATING or FIXED block ticket using exact two-token balance sheet
function simulateTrancheTrade({
  cfg,
  summaryPool,
  observed,
  tradeUsd,
  scenario,
  mode,
  maxAnnualTurnsCap = null,
}) {
  const durationSec = scenario.durationHours * 3600;
  const p0 = summaryPool.spotPriceUsd;
  const impactRow = summaryPool.priceImpactTable.find((r) => r.tradeUsd === tradeUsd);
  const v3TotalAllInBps = impactRow
    ? impactRow.buyBase.allInCostBps + (V3_SWAP_GAS_USD / tradeUsd) * BPS
    : null;

  const rawTurnsPerYear = ((DAYS_PER_YEAR * 24) / scenario.durationHours) * scenario.utilization;
  const effectiveAnnualTurns =
    maxAnnualTurnsCap !== null ? Math.min(rawTurnsPerYear, maxAnnualTurnsCap) : rawTurnsPerYear;

  const rebalBps = cfg.lpRebalBpsBase * scenario.rebalMultiplier;

  if (mode === "FLOATING") {
    const { basePremiumBps, dailyPremiumBps, spreadBps } = cfg.floatingOffer;
    const markoutBps = cfg.promptOracleLagMarkoutBpsBase * scenario.markoutMultiplier;
    const pEx = p0;
    const hedgePrice = pEx * (1 + markoutBps / BPS);

    const full = evaluateTwoTokenCycle({
      notionalUsd: tradeUsd,
      p0,
      pEx,
      pEnd: p0,
      fillFraction: 1.0,
      mode: "FLOATING",
      basePremiumBps,
      dailyPremiumBps,
      durationSeconds: durationSec,
      spreadOrStrikeBps: spreadBps,
      protocolFeeBps: scenario.protocolFeeBps,
      restockCostBps: rebalBps,
      hedgeDelayPrice: hedgePrice,
      lpGasUsd: LP_CYCLE_GAS_USD,
      traderGasUsd: TRADER_GAS_FULL_USD,
    });

    const expired = evaluateTwoTokenCycle({
      notionalUsd: tradeUsd,
      p0,
      pEx,
      pEnd: p0,
      fillFraction: 0.0,
      mode: "FLOATING",
      basePremiumBps,
      dailyPremiumBps,
      durationSeconds: durationSec,
      spreadOrStrikeBps: spreadBps,
      protocolFeeBps: scenario.protocolFeeBps,
      restockCostBps: 0,
      hedgeDelayPrice: null,
      lpGasUsd: LP_CYCLE_GAS_USD,
      traderGasUsd: TRADER_GAS_RESERVE_ONLY_USD,
    });

    const pExProb = scenario.exerciseProbFloating;
    const expectedLpNetBps =
      pExProb * full.lpPnlVsHodlBps + (1 - pExProb) * expired.lpPnlVsHodlBps;
    const lpAnnualizedAprPct = (expectedLpNetBps / BPS) * effectiveAnnualTurns * 100;

    return {
      mode,
      tradeUsd,
      v3TotalAllInBps: round(v3TotalAllInBps, 2),
      trancheTraderAllInBps: full.traderAllInVsSpotBps,
      traderSavingsVsV3Bps: v3TotalAllInBps !== null ? round(v3TotalAllInBps - full.traderAllInVsSpotBps, 2) : null,
      effPremiumBps: full.effPremiumBps,
      spreadOrStrikeBps: spreadBps,
      exerciseProb: pExProb,
      markoutBps: round(markoutBps, 2),
      rebalBps: round(rebalBps, 2),
      lpNetIfFullExerciseBps: full.lpPnlVsHodlBps,
      lpNetIfExpiredBps: expired.lpPnlVsHodlBps,
      lpNetPerCycleBps: round(expectedLpNetBps, 2),
      effectiveAnnualTurns: round(effectiveAnnualTurns, 2),
      lpAnnualizedAprPct: round(lpAnnualizedAprPct, 2),
      beatsPassiveV3FeeApr: lpAnnualizedAprPct > observed.v3PassiveFeeAprPct,
      fullCycleAccounting: full,
    };
  } else {
    // FIXED mode: evaluate exact two-token balance sheet across every independent 24h window
    const { basePremiumBps, dailyPremiumBps, strikeOffsetBps } = cfg.fixedOffer;
    const timeScale = Math.sqrt(scenario.durationHours / 24);
    const windowPnlsVsHodlBps = observed.independentWindows.independent24hReturnsBps.map((ret24h) => {
      const scaledRetBps = ret24h * timeScale * scenario.markoutMultiplier;
      const pEnd = p0 * (1 + scaledRetBps / BPS);
      const exercised = scaledRetBps > strikeOffsetBps;
      const res = evaluateTwoTokenCycle({
        notionalUsd: tradeUsd,
        p0,
        pEx: pEnd,
        pEnd,
        fillFraction: exercised ? 1.0 : 0.0,
        mode: "FIXED",
        basePremiumBps,
        dailyPremiumBps,
        durationSeconds: durationSec,
        spreadOrStrikeBps: strikeOffsetBps,
        protocolFeeBps: scenario.protocolFeeBps,
        restockCostBps: rebalBps,
        hedgeDelayPrice: exercised ? pEnd : null,
        lpGasUsd: LP_CYCLE_GAS_USD,
        traderGasUsd: exercised ? TRADER_GAS_FULL_USD : TRADER_GAS_RESERVE_ONLY_USD,
      });
      return res.lpPnlVsHodlBps;
    });

    const ci = bootstrapMeanCI90(windowPnlsVsHodlBps, 202 + scenario.durationHours);
    const lpNetPerCycleBps = ci.sampleMean;
    const lpAnnualizedAprPct = (lpNetPerCycleBps / BPS) * effectiveAnnualTurns * 100;

    // Immediate near-spot FIXED trader execution cost for comparison vs V3
    const immediateFixed = evaluateTwoTokenCycle({
      notionalUsd: tradeUsd,
      p0,
      pEx: p0,
      pEnd: p0,
      fillFraction: 1.0,
      mode: "FIXED",
      basePremiumBps,
      dailyPremiumBps,
      durationSeconds: durationSec,
      spreadOrStrikeBps: strikeOffsetBps,
      protocolFeeBps: scenario.protocolFeeBps,
      restockCostBps: rebalBps,
      hedgeDelayPrice: p0,
      lpGasUsd: LP_CYCLE_GAS_USD,
      traderGasUsd: TRADER_GAS_FULL_USD,
    });

    return {
      mode,
      tradeUsd,
      v3TotalAllInBps: round(v3TotalAllInBps, 2),
      trancheTraderAllInBps: immediateFixed.traderAllInVsSpotBps,
      traderSavingsVsV3Bps:
        v3TotalAllInBps !== null
          ? round(v3TotalAllInBps - immediateFixed.traderAllInVsSpotBps, 2)
          : null,
      effPremiumBps: immediateFixed.effPremiumBps,
      spreadOrStrikeBps: strikeOffsetBps,
      empiricalExerciseRate24h: observed.independentWindows.fixedEmpiricalExerciseRate,
      lpNetPerCycleBps,
      lpNetPerCycleCI90: ci,
      effectiveAnnualTurns: round(effectiveAnnualTurns, 2),
      lpAnnualizedAprPct: round(lpAnnualizedAprPct, 2),
      beatsPassiveV3FeeApr: lpAnnualizedAprPct > observed.v3PassiveFeeAprPct,
    };
  }
}

// Stress hedging assumptions on $10k FLOATING (full exercise): prompt (1x/2x/3x rebal), 6h delayed, 24h unhedged, failed restock
function runHedgingStress(cfg, summaryPool, observed) {
  const tradeUsd = 10_000;
  const p0 = summaryPool.spotPriceUsd;
  const { basePremiumBps, dailyPremiumBps, spreadBps } = cfg.floatingOffer;
  const durationSec = SECONDS_PER_DAY;
  const protocolFeeBps = 5;

  const promptAtMult = (rebalMult) => {
    const hedgePrice = p0 * (1 + cfg.promptOracleLagMarkoutBpsBase / BPS);
    const res = evaluateTwoTokenCycle({
      notionalUsd: tradeUsd,
      p0,
      pEx: p0,
      pEnd: p0,
      fillFraction: 1.0,
      mode: "FLOATING",
      basePremiumBps,
      dailyPremiumBps,
      durationSeconds: durationSec,
      spreadOrStrikeBps: spreadBps,
      protocolFeeBps,
      restockCostBps: cfg.lpRebalBpsBase * rebalMult,
      hedgeDelayPrice: hedgePrice,
      lpGasUsd: LP_CYCLE_GAS_USD,
      traderGasUsd: TRADER_GAS_FULL_USD,
    });
    return {
      restockCostBps: cfg.lpRebalBpsBase * rebalMult,
      oracleLagMarkoutBps: cfg.promptOracleLagMarkoutBpsBase,
      lpPnlVsHodlBps: res.lpPnlVsHodlBps,
      lpAprAt25PctUtilPct: round((res.lpPnlVsHodlBps / BPS) * 91.25 * 100, 2),
    };
  };

  // Delayed hedging (6h delay across independent 6h windows)
  const delayed6hSamples = observed.independentWindows.independent6hReturnsBps.map((r6) => {
    const p6 = p0 * (1 + r6 / BPS);
    return evaluateTwoTokenCycle({
      notionalUsd: tradeUsd,
      p0,
      pEx: p0,
      pEnd: p6,
      fillFraction: 1.0,
      mode: "FLOATING",
      basePremiumBps,
      dailyPremiumBps,
      durationSeconds: durationSec,
      spreadOrStrikeBps: spreadBps,
      protocolFeeBps,
      restockCostBps: cfg.lpRebalBpsBase,
      hedgeDelayPrice: p6,
      lpGasUsd: LP_CYCLE_GAS_USD,
      traderGasUsd: TRADER_GAS_FULL_USD,
    }).lpPnlVsHodlBps;
  });

  // Zero hedging (LP holds USDT proceeds for 24h across independent 24h windows; compared vs HODL)
  const zeroHedge24hSamples = observed.independentWindows.independent24hReturnsBps.map((r24) => {
    const p24 = p0 * (1 + r24 / BPS);
    return evaluateTwoTokenCycle({
      notionalUsd: tradeUsd,
      p0,
      pEx: p0,
      pEnd: p24,
      fillFraction: 1.0,
      mode: "FLOATING",
      basePremiumBps,
      dailyPremiumBps,
      durationSeconds: durationSec,
      spreadOrStrikeBps: spreadBps,
      protocolFeeBps,
      restockCostBps: 0,
      hedgeDelayPrice: null,
      lpGasUsd: LP_CYCLE_GAS_USD,
      traderGasUsd: TRADER_GAS_FULL_USD,
    }).lpPnlVsHodlBps;
  });

  // Failed restocking (tail stress: LP forced to restock after p90 adverse 24h rally at 3x restock cost)
  const pTail = p0 * (1 + observed.independentWindows.p90AdverseRally24hBps / BPS);
  const failedRestock = evaluateTwoTokenCycle({
    notionalUsd: tradeUsd,
    p0,
    pEx: p0,
    pEnd: pTail,
    fillFraction: 1.0,
    mode: "FLOATING",
    basePremiumBps,
    dailyPremiumBps,
    durationSeconds: durationSec,
    spreadOrStrikeBps: spreadBps,
    protocolFeeBps,
    restockCostBps: cfg.lpRebalBpsBase * 3,
    hedgeDelayPrice: pTail,
    lpGasUsd: LP_CYCLE_GAS_USD,
    traderGasUsd: TRADER_GAS_FULL_USD,
  });

  return {
    promptHedge_1xRebal: promptAtMult(1),
    promptHedge_2xRebal: promptAtMult(2),
    promptHedge_3xRebal: promptAtMult(3),
    delayedHedge_6hEmpiricalCI90: bootstrapMeanCI90(delayed6hSamples, 303),
    zeroHedge_24hEmpiricalCI90: bootstrapMeanCI90(zeroHedge24hSamples, 404),
    failedRestock_p90Rally_3xRebal: {
      adverseRally24hBps: observed.independentWindows.p90AdverseRally24hBps,
      restockCostBps: cfg.lpRebalBpsBase * 3,
      lpPnlVsHodlBps: failedRestock.lpPnlVsHodlBps,
      lpPnlVsHodlUsd: failedRestock.lpPnlVsHodlUsd,
    },
  };
}

// Reservation fill-behavior breakdown: 100% exercised, 50% partial, 0% expired
function runReservationBehaviorMatrix(cfg, summaryPool) {
  const tradeUsd = 10_000;
  const p0 = summaryPool.spotPriceUsd;
  const { basePremiumBps, dailyPremiumBps, spreadBps } = cfg.floatingOffer;
  const hedgePrice = p0 * (1 + cfg.promptOracleLagMarkoutBpsBase / BPS);

  return [1.0, 0.5, 0.0].map((fillFraction) =>
    evaluateTwoTokenCycle({
      notionalUsd: tradeUsd,
      p0,
      pEx: p0,
      pEnd: p0,
      fillFraction,
      mode: "FLOATING",
      basePremiumBps,
      dailyPremiumBps,
      durationSeconds: SECONDS_PER_DAY,
      spreadOrStrikeBps: spreadBps,
      protocolFeeBps: 5,
      restockCostBps: cfg.lpRebalBpsBase,
      hedgeDelayPrice: fillFraction > 0 ? hedgePrice : null,
      lpGasUsd: LP_CYCLE_GAS_USD,
      traderGasUsd: fillFraction > 0 ? TRADER_GAS_FULL_USD : TRADER_GAS_RESERVE_ONLY_USD,
    }),
  );
}

// Turnover-capped duration, utilization, and fee sensitivities ($10k)
function runSensitivities(cfg, summaryPool, observed) {
  const baseScenario = SCENARIOS[0];
  const tradeUsd = 10_000;
  // Cap annual turns at 91.25x (25% utilization of 1-day-equivalent demand) so 1h duration cannot extrapolate to 2,190x
  const MAX_REALISTIC_ANNUAL_TURNS_BASE = 91.25;

  const durationHoursSweep = [1, 6, 24, 72].map((durationHours) => {
    const sc = { ...baseScenario, durationHours };
    const fl = simulateTrancheTrade({
      cfg,
      summaryPool,
      observed,
      tradeUsd,
      scenario: sc,
      mode: "FLOATING",
      maxAnnualTurnsCap: MAX_REALISTIC_ANNUAL_TURNS_BASE,
    });
    const fx = simulateTrancheTrade({
      cfg,
      summaryPool,
      observed,
      tradeUsd,
      scenario: sc,
      mode: "FIXED",
      maxAnnualTurnsCap: MAX_REALISTIC_ANNUAL_TURNS_BASE,
    });
    return {
      durationHours,
      cappedAnnualTurns: fl.effectiveAnnualTurns,
      floatingTraderAllInBps: fl.trancheTraderAllInBps,
      floatingLpNetBps: fl.lpNetPerCycleBps,
      floatingLpAprCappedPct: fl.lpAnnualizedAprPct,
      fixedTraderAllInBps: fx.trancheTraderAllInBps,
      fixedLpNetBps: fx.lpNetPerCycleBps,
      fixedLpAprCappedPct: fx.lpAnnualizedAprPct,
    };
  });

  const utilizationSweep = [0.1, 0.25, 0.5, 0.75].map((utilization) => {
    const sc = { ...baseScenario, utilization };
    const fl = simulateTrancheTrade({ cfg, summaryPool, observed, tradeUsd, scenario: sc, mode: "FLOATING" });
    const fx = simulateTrancheTrade({ cfg, summaryPool, observed, tradeUsd, scenario: sc, mode: "FIXED" });
    return {
      utilizationPct: utilization * 100,
      impliedAnnualTurns: fl.effectiveAnnualTurns,
      floatingLpAprPct: fl.lpAnnualizedAprPct,
      fixedLpAprPct: fx.lpAnnualizedAprPct,
      passiveV3FeeAprPct: observed.v3PassiveFeeAprPct,
    };
  });

  const feeSweep = [0, 5, 10, 25, 50].map((protocolFeeBps) => {
    const sc = { ...baseScenario, protocolFeeBps };
    const fl = simulateTrancheTrade({ cfg, summaryPool, observed, tradeUsd, scenario: sc, mode: "FLOATING" });
    const fx = simulateTrancheTrade({ cfg, summaryPool, observed, tradeUsd, scenario: sc, mode: "FIXED" });
    return {
      protocolFeeBps,
      floatingLpNetBps: fl.lpNetPerCycleBps,
      floatingLpAprPct: fl.lpAnnualizedAprPct,
      fixedLpNetBps: fx.lpNetPerCycleBps,
      fixedLpAprPct: fx.lpAnnualizedAprPct,
    };
  });

  return { durationHoursSweep, utilizationSweep, feeSweep };
}

// Main Execution
const poolResults = {};

for (const [poolAddr, cfg] of Object.entries(POOL_CONFIGS)) {
  const summaryPool = Object.values(summary.pools).find((p) => p.address.toLowerCase() === poolAddr);
  if (!summaryPool) throw new Error(`Missing pool ${poolAddr} in analysis_summary.json`);

  const observed = analyzeObservedSwaps(poolAddr, cfg, summaryPool);

  const scenariosOut = {};
  for (const sc of SCENARIOS) {
    scenariosOut[sc.id] = {
      params: sc,
      floating: TRADE_SIZES_USD.map((tradeUsd) =>
        simulateTrancheTrade({ cfg, summaryPool, observed, tradeUsd, scenario: sc, mode: "FLOATING" }),
      ),
      fixed: TRADE_SIZES_USD.map((tradeUsd) =>
        simulateTrancheTrade({ cfg, summaryPool, observed, tradeUsd, scenario: sc, mode: "FIXED" }),
      ),
    };
  }

  const hedgingStress = runHedgingStress(cfg, summaryPool, observed);
  const reservationBehavior = runReservationBehaviorMatrix(cfg, summaryPool);
  const sensitivities = runSensitivities(cfg, summaryPool, observed);

  const baseFloat5k = scenariosOut.base.floating.find((r) => r.tradeUsd === 5_000);
  const baseFloat10k = scenariosOut.base.floating.find((r) => r.tradeUsd === 10_000);
  const baseFixed10k = scenariosOut.base.fixed.find((r) => r.tradeUsd === 10_000);
  const advFloat10k = scenariosOut.adverse_selection.floating.find((r) => r.tradeUsd === 10_000);

  const criteriaCheck = {
    C1_traderSavingsGe25Bps_at5kFloat: baseFloat5k.traderSavingsVsV3Bps >= PASS_CRITERIA.C1_minTraderSavingsBps,
    C1_traderSavingsGe25Bps_at10kFloat: baseFloat10k.traderSavingsVsV3Bps >= PASS_CRITERIA.C1_minTraderSavingsBps,
    C2_lpNetPositive_baseFloat10k: baseFloat10k.lpNetPerCycleBps > 0,
    C2_lpNetPositive_baseFixed10k: baseFixed10k.lpNetPerCycleBps > 0,
    C2_lpNetPositive_adverseFloat10k: advFloat10k.lpNetPerCycleBps > 0,
    C3_beatsPassiveV3Apr_baseFloat10k: baseFloat10k.beatsPassiveV3FeeApr,
    C4_observed14dRetailHasBlockDemand:
      observed.eligibility.eligibleSwapsAt1000Usd >= PASS_CRITERIA.C4_minObserved14dEligibleSwapsAt1k,
  };

  // Strip raw arrays from JSON summary for readability while keeping all CIs
  const { independent24hReturnsBps, independent6hReturnsBps, independentFixedCallPayoffsBps, ...cleanWindows } =
    observed.independentWindows;

  poolResults[cfg.symbol] = {
    poolAddress: poolAddr,
    spotPriceUsd: round(summaryPool.spotPriceUsd, 6),
    tvlUsd: round(summaryPool.tvlUsd, 2),
    observed14d: { ...observed, independentWindows: cleanWindows },
    scenarios: scenariosOut,
    hedgingStress,
    reservationBehavior,
    sensitivities,
    criteriaCheck,
  };
}

const allPoolsPassUnitEconOnBlockFloat = Object.values(poolResults).every(
  (p) =>
    p.criteriaCheck.C1_traderSavingsGe25Bps_at10kFloat &&
    p.criteriaCheck.C2_lpNetPositive_baseFloat10k &&
    p.criteriaCheck.C3_beatsPassiveV3Apr_baseFloat10k,
);
const anyPoolHasObservedRetailBlockDemand = Object.values(poolResults).some(
  (p) => p.criteriaCheck.C4_observed14dRetailHasBlockDemand,
);
const allPoolsSurviveAdverseSelection = Object.values(poolResults).every(
  (p) => p.criteriaCheck.C2_lpNetPositive_adverseFloat10k,
);

const overallVerdict = !allPoolsPassUnitEconOnBlockFloat
  ? "FAIL"
  : anyPoolHasObservedRetailBlockDemand && allPoolsSurviveAdverseSelection
    ? "PASS"
    : "INCONCLUSIVE";

const output = {
  experiment: "Experiment 1A — Current Tranche Vault-Backed Ticket Counterfactual (Balance-Sheet & Bootstrapped)",
  generatedAtIso: new Date().toISOString(),
  dataProvenance: {
    sourceFiles: ["scripts/market-analysis/market_data_14d.json", "scripts/market-analysis/analysis_summary.json"],
    chainId: marketData.metadata.chainId,
    window: marketData.metadata.window,
    gasPriceGwei: summary.gasSummary.gasPriceGwei,
    trancheTraderGasFullUsd: round(TRADER_GAS_FULL_USD, 5),
    trancheTraderGasReserveOnlyUsd: round(TRADER_GAS_RESERVE_ONLY_USD, 5),
    trancheLpCycleGasUsd: round(LP_CYCLE_GAS_USD, 5),
    v3MedianSwapGasUsd: round(V3_SWAP_GAS_USD, 5),
  },
  passCriteria: PASS_CRITERIA,
  overallVerdict,
  pools: poolResults,
};

fs.writeFileSync(OUTPUT_JSON_PATH, JSON.stringify(output, null, 2), "utf8");
console.log("Wrote:", OUTPUT_JSON_PATH);
console.log("Overall Verdict:", overallVerdict);
for (const [sym, p] of Object.entries(poolResults)) {
  console.log(`\n=== ${sym} ===`);
  console.log("  Independent windows:", { n24h: p.observed14d.independentWindows.count24h, n6h: p.observed14d.independentWindows.count6h, fixedCallCI90: p.observed14d.independentWindows.fixedCallPayoff24hCI90 });
  console.log("  Base FLOATING $10k:", { v3: p.scenarios.base.floating[2].v3TotalAllInBps, tr: p.scenarios.base.floating[2].trancheTraderAllInBps, save: p.scenarios.base.floating[2].traderSavingsVsV3Bps, lpNet: p.scenarios.base.floating[2].lpNetPerCycleBps, apr: p.scenarios.base.floating[2].lpAnnualizedAprPct });
  console.log("  Base FIXED $10k (bootstrapped):", { lpNet: p.scenarios.base.fixed[2].lpNetPerCycleBps, ci90: p.scenarios.base.fixed[2].lpNetPerCycleCI90, apr: p.scenarios.base.fixed[2].lpAnnualizedAprPct });
  console.log("  Hedging Stress ($10k FLOATING):", p.hedgingStress);
  console.log("  Reservation Behavior ($10k FLOATING):", p.reservationBehavior.map(r => ({ fill: r.fillFraction, lpPnlVsHodlBps: r.lpPnlVsHodlBps, treasuryUsd: r.totalTreasuryFeeUsd, traderPaidUsd: r.totalTraderPaidUsd })));
  console.log("  Duration Sweep (turnover-capped):", p.sensitivities.durationHoursSweep);
}
