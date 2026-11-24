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

  // Note subtle second-order difference discovered:
  // In CommitmentManager.sol, _quoteReservation prices grossPremium off `effPriceX36 = spot * (1 + spread)`,
  // so trader pays `effPremBps * (1 + spreadBps/10000) + spreadBps = 20 * 1.0025 + 25 = 45.05 bps` (before gas),
  // whereas 05_experiment1_backtest.mjs approximated `effPremBps + spreadBps = 45.00 bps` (-0.05 bps diff).
  const expectedExactBeforeGas = 20 * 1.0025 + 25; // 45.05 bps
  assert.ok(
    Math.abs(sol.traderAllInBps - expectedExactBeforeGas) < 0.05,
    `Solidity exact traderAllInBps=${sol.traderAllInBps} vs ${expectedExactBeforeGas}`,
  );

  // Verify LP gross-net (pEx = 100%, before markout/rebal/gas):
  // 20 * 1.0025 * 0.9995 + 25 * 0.9995 - 5 = 20.040 + 24.9875 - 5 = 40.0275 bps
  assert.ok(Math.abs(sol.lpGrossNetVsSpotBps - 40.0) < 0.15);
  console.log("Exact Solidity BigInt vs Float Delta (WETH $10k FLOATING):", {
    solidityTraderExGasBps: sol.traderAllInBps,
    exp1TraderExGasBps: 45.0,
    secondOrderPremOnSpreadDeltaBps: Number((sol.traderAllInBps - 45.0).toFixed(3)),
    solidityLpNetBeforeCostsBps: sol.lpGrossNetVsSpotBps,
  });
});

test("3. Verify swap count, eligibility, and flag material assumption sensitivities (1h APR turnover & markout)", () => {
  // Independently recount raw swap events
  assert.equal(rawData.events.swaps.length, 1_241);
  const counts = { whsk: 0, weth: 0, wbtc: 0 };
  for (const s of rawData.events.swaps) {
    const p = s.pool.toLowerCase();
    if (p === "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc") counts.whsk++;
    else if (p === "0xb92b79ed6b370d5cfee2e14b1d0983c258304c16") counts.weth++;
    else if (p === "0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a") counts.wbtc++;
  }
  assert.equal(counts.whsk, 1_047);
  assert.equal(counts.weth, 173);
  assert.equal(counts.wbtc, 21);

  // Verify the 1h duration APR annualization caveat:
  // At durationHours=1 and utilization=25%, cyclesPerYear * util = 8760 * 0.25 = 2,190 turns/year!
  // That means the reported 1h APRs (184.5% WHSK, 296.2% WETH/WBTC) assume 2,190x annual capital turnover.
  const weth1h = exp1.pools["WETH/USDT"].sensitivities.durationHoursSweep.find((d) => d.durationHours === 1);
  const impliedAnnualTurnsAt1h = (365 * 24) * 0.25;
  assert.equal(impliedAnnualTurnsAt1h, 2_190);
  const recomputed1hApr = (weth1h.floatingLpNetBps / 10_000) * impliedAnnualTurnsAt1h * 100;
  assert.ok(Math.abs(recomputed1hApr - weth1h.floatingLpAprPct) < 0.15);

  // Verify break-even markout threshold for Base FLOATING $10k (5 bps fee):
  // lpNet = 20*0.9995 + 0.85*(25*0.9995 - 5 - M - 5) - 0.01 = 0 => M_breakeven ~ 38.5 bps (WETH/WBTC)
  const wethBreakEvenMarkoutBps =
    (20 * 0.9995) / 0.85 + 25 * 0.9995 - 5 - 5; // ~38.50 bps
  const whskBreakEvenMarkoutBps =
    (20 * 0.9995) / 0.85 + 20 * 0.9995 - 5 - 10; // ~28.51 bps
  assert.ok(wethBreakEvenMarkoutBps > 38 && wethBreakEvenMarkoutBps < 39);
  assert.ok(whskBreakEvenMarkoutBps > 28 && whskBreakEvenMarkoutBps < 29);

  console.log("Material Assumption Sensitivity Audit:", {
    impliedAnnualTurnsAt1h25PctUtil: impliedAnnualTurnsAt1h,
    impliedAnnualTurnsAt24h25PctUtil: 365 * 0.25,
    wethBaseFloatingBreakEvenMarkoutBps: Number(wethBreakEvenMarkoutBps.toFixed(2)),
    whskBaseFloatingBreakEvenMarkoutBps: Number(whskBreakEvenMarkoutBps.toFixed(2)),
    empiricalWeth24hBuyMarkoutBps: exp1.pools["WETH/USDT"].observed14d.empirical24hPathStats.meanBuyMarkout24hBps,
    empiricalWbtc24hBuyMarkoutBps: exp1.pools["WBTC/USDT"].observed14d.empirical24hPathStats.meanBuyMarkout24hBps,
  });
});
