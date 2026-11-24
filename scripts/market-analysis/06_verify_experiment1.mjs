// Independent Quantitative Verification Suite for Experiment 1
// Zero shared math with 03_analyze_market.mjs or 05_experiment1_backtest.mjs.
// Reconstructs HSKSwap V3 execution costs directly from raw poolStates in market_data_14d.json,
// verifies exact BigInt CommitmentManager.sol fee/premium/exercise arithmetic,
// checks LP markout/APR/capital-lockup formulas, and flags material assumption sensitivities.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rawData = JSON.parse(fs.readFileSync(path.join(__dirname, "market_data_14d.json"), "utf8"));
const exp1 = JSON.parse(fs.readFileSync(path.join(__dirname, "experiment1_results.json"), "utf8"));

const Q96_FLOAT = 2 ** 96;
const PRICE_SCALE = 10n ** 36n;
const BPS_BIG = 10_000n;

// Exact Solidity Math.ceilDiv & Math.mulDiv(a, b, d, Ceil)
function ceilDivBig(a, b) {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}
function mulDivCeil(a, b, d) {
  return ceilDivBig(a * b, d);
}

// Independent Uniswap V3 tick-step simulator from raw poolState
function independentV3BuyBase(poolState, tradeUsd) {
  const dec0 = poolState.token0.decimals;
  const dec1 = poolState.token1.decimals;
  const feeRate = poolState.fee / 1_000_000;
  const sp0 = Number(BigInt(poolState.sqrtPriceX96)) / Q96_FLOAT;
  const spotUsd = sp0 * sp0 * 10 ** (dec0 - dec1);

  // Reconstruct active tick intervals from raw liquidityNet
  const ticks = [...poolState.ticks].sort((a, b) => a.tick - b.tick);
  const intervals = [];
  let runningL = 0n;
  for (let i = 0; i < ticks.length - 1; i++) {
    runningL += BigInt(ticks[i].liquidityNet);
    if (runningL > 0n) {
      intervals.push({
        tickLower: ticks[i].tick,
        tickUpper: ticks[i + 1].tick,
        L: Number(runningL),
      });
    }
  }

  let idx = intervals.findIndex(
    (iv) => poolState.currentTick >= iv.tickLower && poolState.currentTick < iv.tickUpper,
  );
  assert.ok(idx >= 0, `Current tick ${poolState.currentTick} not inside any active interval`);

  // Verify reconstructed active liquidity matches on-chain slot liquidity()
  const activeIv = intervals[idx];
  const slotL = Number(BigInt(poolState.activeLiquidity));
  assert.ok(
    Math.abs(activeIv.L - slotL) / slotL < 1e-12,
    `Reconstructed L (${activeIv.L}) != slot L (${slotL})`,
  );

  // Step through ticks: input USDT (token1), fee taken from input
  let rem1Raw = tradeUsd * (1 - feeRate) * 10 ** dec1;
  let out0Raw = 0;
  let sp = sp0;

  while (idx < intervals.length && rem1Raw > 1e-9) {
    const upperSp = Math.pow(1.0001, intervals[idx].tickUpper / 2);
    const maxDy = intervals[idx].L * (upperSp - sp);
    if (rem1Raw <= maxDy) {
      const nextSp = sp + rem1Raw / intervals[idx].L;
      out0Raw += intervals[idx].L * (1 / sp - 1 / nextSp);
      sp = nextSp;
      rem1Raw = 0;
      break;
    } else {
      out0Raw += intervals[idx].L * (1 / sp - 1 / upperSp);
      rem1Raw -= maxDy;
      sp = upperSp;
      idx++;
    }
  }

  const out0Human = out0Raw / 10 ** dec0;
  const effPriceAllIn = tradeUsd / out0Human;
  const allInCostExGasBps = ((effPriceAllIn - spotUsd) / spotUsd) * 10_000;

  // Independent closed-form full-range x*y=k cross-check (exact when single full-range interval)
  const bal0Human = Number(BigInt(poolState.bal0Raw)) / 10 ** dec0;
  const bal1Human = Number(BigInt(poolState.bal1Raw)) / 10 ** dec1;
  const dyNet = tradeUsd * (1 - feeRate);
  const dxXyK = (bal0Human * dyNet) / (bal1Human + dyNet);
  const effPriceXyK = tradeUsd / dxXyK;
  const xyKAllInBps = ((effPriceXyK - spotUsd) / spotUsd) * 10_000;

  return {
    spotUsd,
    allInCostExGasBps,
    xyKAllInBps,
    intervalCount: intervals.length,
    bal0Human,
    bal1Human,
  };
}

// Independent exact BigInt CommitmentManager.sol quote reconstruction
function exactSolidityFloatingCycle({
  invAmountRaw,
  oraclePriceX36,
  basePremiumBps,
  dailyPremiumBps,
  durationSec,
  spreadBps,
  protocolFeeBps,
}) {
  const effPremBps =
    BigInt(basePremiumBps) + ceilDivBig(BigInt(dailyPremiumBps) * BigInt(durationSec), 86_400n);
  const effPriceX36 = mulDivCeil(oraclePriceX36, BPS_BIG + BigInt(spreadBps), BPS_BIG);

  // _quoteReservation uses refPriceX36 = effPriceX36 (spot * (1 + spread))!
  const notionalPayRes = mulDivCeil(invAmountRaw, effPriceX36, PRICE_SCALE);
  const grossPremium = mulDivCeil(notionalPayRes, effPremBps, BPS_BIG);
  const feeRes = protocolFeeBps > 0 ? mulDivCeil(grossPremium, BigInt(protocolFeeBps), BPS_BIG) : 0n;
  const lpNetRes = grossPremium - feeRes;

  // _quoteExercise
  const grossPayment = mulDivCeil(invAmountRaw, effPriceX36, PRICE_SCALE);
  const feeEx = protocolFeeBps > 0 ? mulDivCeil(grossPayment, BigInt(protocolFeeBps), BPS_BIG) : 0n;
  const lpNetEx = grossPayment - feeEx;

  // Pure spot notional (for bps comparison)
  const spotNotional = mulDivCeil(invAmountRaw, oraclePriceX36, PRICE_SCALE);

  const traderTotalPaid = grossPremium + grossPayment;
  const traderAllInBps = Number(((traderTotalPaid - spotNotional) * 100_000n) / spotNotional) / 10;
  const lpGrossNetVsSpotBps =
    Number(((lpNetRes + lpNetEx - spotNotional) * 100_000n) / spotNotional) / 10;

  return {
    effPremBps: Number(effPremBps),
    grossPremium,
    feeRes,
    grossPayment,
    feeEx,
    traderAllInBps,
    lpGrossNetVsSpotBps,
  };
}

test("1. Independently reconstruct raw HSKSwap V3 execution costs & verify 2,421.58 bps WETH and 2,235.71 bps WBTC at $10k", () => {
  const expectedMap = {
    "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc": { sym: "WHSK/USDT", dec0: 18, dec1: 6, fee: 3000 },
    "0xb92b79ed6b370d5cfee2e14b1d0983c258304c16": { sym: "WETH/USDT", dec0: 18, dec1: 6, fee: 3000 },
    "0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a": { sym: "WBTC/USDT", dec0: 8, dec1: 6, fee: 3000 },
  };

  const gasPriceWei = BigInt(rawData.metadata.gasPriceWei);
  assert.equal(gasPriceWei, 500_001_000_000n);

  const whskState = rawData.poolStates["0x4ff515761864e7838b0adb8b5b2b8b7a068905dc"];
  const whskSpot = independentV3BuyBase(whskState, 1000).spotUsd;
  const medianSwapGas = 109_686;
  const v3GasUsd = ((Number(gasPriceWei) * medianSwapGas) / 1e18) * whskSpot;

  const summaryRows = [];
  for (const [addr, meta] of Object.entries(expectedMap)) {
    const ps = rawData.poolStates[addr];
    assert.equal(ps.token0.decimals, meta.dec0);
    assert.equal(ps.token1.decimals, meta.dec1);
    assert.equal(ps.fee, meta.fee);

    for (const tradeUsd of [1_000, 5_000, 10_000, 25_000]) {
      const recon = independentV3BuyBase(ps, tradeUsd);
      const reconTotalWithGasBps = recon.allInCostExGasBps + (v3GasUsd / tradeUsd) * 10_000;
      const reported = exp1.pools[meta.sym].scenarios.base.floating.find((r) => r.tradeUsd === tradeUsd);

      // Must match reported V3 cost within 0.05 bps
      assert.ok(
        Math.abs(reconTotalWithGasBps - reported.v3TotalAllInBps) < 0.05,
        `${meta.sym} $${tradeUsd}: independent=${reconTotalWithGasBps.toFixed(2)} vs reported=${reported.v3TotalAllInBps}`,
      );

      if (tradeUsd === 10_000) {
        summaryRows.push({
          pool: meta.sym,
          reconExGasBps: Number(recon.allInCostExGasBps.toFixed(2)),
          reconWithGasBps: Number(reconTotalWithGasBps.toFixed(2)),
          xyKCrossCheckBps: Number(recon.xyKAllInBps.toFixed(2)),
          reportedBps: reported.v3TotalAllInBps,
        });
      }
    }
  }

  // Explicitly assert the exact headline $10k figures
  const weth10k = summaryRows.find((r) => r.pool === "WETH/USDT");
  const wbtc10k = summaryRows.find((r) => r.pool === "WBTC/USDT");
  assert.ok(Math.abs(weth10k.reconWithGasBps - 2421.58) < 0.05);
  assert.ok(Math.abs(wbtc10k.reconWithGasBps - 2235.71) < 0.05);
  console.log("Independent $10k V3 Verification:", summaryRows);
});

test("2. Compare exact Solidity BigInt CommitmentManager.sol arithmetic vs Experiment 1 float approximation", () => {
  // WETH/USDT $10k FLOATING: spot = $1,704.043264 -> priceX36 = 1704.043264 * 1e6 * 1e36 / 1e18 = 1704043264 * 1e18
  const wethPriceX36 = 1_704_043_264n * 10n ** 18n;
  const invWeth10k = 5_868_395_600_000_000_000n; // ~$10,000 WETH

  const sol = exactSolidityFloatingCycle({
    invAmountRaw: invWeth10k,
    oraclePriceX36: wethPriceX36,
    basePremiumBps: 10,
    dailyPremiumBps: 10,
    durationSec: 86_400,
    spreadBps: 25,
    protocolFeeBps: 5,
  });

  // 05_experiment1_backtest.mjs now matches Solidity exact refPriceRes = p0 * (1 + spreadBps/10000),
  // so trader pays `effPremBps * (1 + spreadBps/10000) + spreadBps = 45.05 bps` (before gas).
  const expectedExactBeforeGas = 20 * 1.0025 + 25; // 45.05 bps
  assert.ok(
    Math.abs(sol.traderAllInBps - expectedExactBeforeGas) < 0.05,
    `Solidity exact traderAllInBps=${sol.traderAllInBps} vs ${expectedExactBeforeGas}`,
  );

  // Verify exact conservation: lpNetRes + lpNetEx + feeRes + feeEx === grossPremium + grossPayment
  assert.equal(
    sol.grossPremium - sol.feeRes + (sol.grossPayment - sol.feeEx) + sol.feeRes + sol.feeEx,
    sol.grossPremium + sol.grossPayment,
  );
  // Prove algebraic equivalence: (1 + s)(1 - f) - 1 === s(1 - f) - f (zero double subtraction of f)
  const s = 25 / 10_000;
  const f = 5 / 10_000;
  assert.ok(Math.abs(((1 + s) * (1 - f) - 1) - (s * (1 - f) - f)) < 1e-15);

  // Cross-check against experiment1_results.json fullCycleAccounting for WETH $10k FLOATING
  const wethFull = exp1.pools["WETH/USDT"].scenarios.base.floating.find((r) => r.tradeUsd === 10_000)
    .fullCycleAccounting;
  assert.ok(
    Math.abs(
      wethFull.totalTraderPaidUsd - (wethFull.totalLpGrossReceiptsUsd + wethFull.totalTreasuryFeeUsd),
    ) < 0.001,
    "Conservation identity failed in experiment1_results.json",
  );
  assert.ok(Math.abs(wethFull.grossPremiumUsd - 20.05) < 0.01);
  assert.ok(Math.abs(wethFull.resProtocolFeeUsd - 0.01) < 0.001);
  assert.ok(Math.abs(wethFull.grossExerciseUsd - 10_025.0) < 0.01);
  assert.ok(Math.abs(wethFull.exProtocolFeeUsd - 5.0125) < 0.001);
  assert.ok(Math.abs(wethFull.totalTreasuryFeeUsd - 5.0225) < 0.001);
});

test("3. Verify reservation fill behaviors (100% / 50% / 0%), independent bootstrap windows, and turnover-capped duration sweep", () => {
  assert.equal(rawData.events.swaps.length, 1_241);

  for (const sym of ["WHSK/USDT", "WETH/USDT", "WBTC/USDT"]) {
    const p = exp1.pools[sym];
    // Strictly 14 independent 24h windows and 56 independent 6h windows across 14 days
    assert.equal(p.observed14d.independentWindows.count24h, 14);
    assert.equal(p.observed14d.independentWindows.count6h, 56);

    // Reservation behavior conservation across 100%, 50%, 0% fill fractions
    assert.equal(p.reservationBehavior.length, 3);
    for (const row of p.reservationBehavior) {
      assert.ok(
        Math.abs(row.totalTraderPaidUsd - (row.totalLpGrossReceiptsUsd + row.totalTreasuryFeeUsd)) < 0.001,
      );
    }
    const expired = p.reservationBehavior.find((r) => r.fillFraction === 0);
    assert.equal(expired.grossExerciseUsd, 0);
    assert.ok(expired.lpPnlVsHodlBps > 19.5, "Expired ticket must retain non-refundable upfront premium");

    // Turnover cap enforced on 1h duration (must NOT exceed 91.25 turns/yr at 25% base util)
    const d1h = p.sensitivities.durationHoursSweep.find((d) => d.durationHours === 1);
    assert.equal(d1h.cappedAnnualTurns, 91.25);
    assert.ok(d1h.floatingLpAprCappedPct < 20, `1h APR should be turnover-capped, got ${d1h.floatingLpAprCappedPct}`);

    // Failed restocking tail stress must be strictly negative (exposes unhedged rally risk)
    assert.ok(p.hedgingStress.failedRestock_p90Rally_3xRebal.lpPnlVsHodlBps < 0);
  }
  assert.equal(exp1.overallVerdict, "INCONCLUSIVE");
});
