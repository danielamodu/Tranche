// Step 3: Quantitative Market & Economic Analysis from real HashKey Chain on-chain data.
// Reads market_data_14d.json and outputs analysis_summary.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

// Reconstruct exact tick intervals [{ tickLower, tickUpper, liquidity, liquidityBigInt }]
function buildTickIntervals(ticks) {
  const intervals = [];
  let runningL = 0n;
  for (let i = 0; i < ticks.length - 1; i++) {
    runningL += BigInt(ticks[i].liquidityNet);
    if (runningL > 0n) {
      intervals.push({
        tickLower: ticks[i].tick,
        tickUpper: ticks[i + 1].tick,
        liquidity: Number(runningL),
        liquidityBigInt: runningL,
      });
    }
  }
  return intervals;
}

// sqrt(1.0001^tick) in raw token0/token1 ratio (before decimal scaling)
function tickToSqrtP(tick) {
  return Math.pow(1.0001, tick / 2);
}

// Simulate moving spot price UP (buying token0 with token1) to targetSqrtP = currentSqrtP * sqrt(1 + bps/10000)
// Returns { amount0OutRaw, amount1InRaw, endSqrtP }
function simulateMoveUp(intervals, currentTick, currentSqrtP, targetSqrtP, dec0, dec1) {
  // Find interval containing currentTick
  let idx = intervals.findIndex((iv) => currentTick >= iv.tickLower && currentTick < iv.tickUpper);
  if (idx === -1) return { amount0Out: 0, amount1In: 0, endSqrtP: currentSqrtP };

  let sp = currentSqrtP;
  let amt0Raw = 0;
  let amt1Raw = 0;

  while (idx < intervals.length && sp < targetSqrtP) {
    const iv = intervals[idx];
    const upperSp = tickToSqrtP(iv.tickUpper);
    const nextSp = Math.min(targetSqrtP, upperSp);
    if (nextSp > sp) {
      // dx = L * (1/sp - 1/nextSp), dy = L * (nextSp - sp)
      amt0Raw += iv.liquidity * (1 / sp - 1 / nextSp);
      amt1Raw += iv.liquidity * (nextSp - sp);
      sp = nextSp;
    }
    if (sp >= upperSp) idx++;
    else break;
  }
  return {
    amount0Out: amt0Raw / 10 ** dec0,
    amount1In: amt1Raw / 10 ** dec1,
    endSqrtP: sp,
  };
}

// Simulate moving spot price DOWN (selling token0 for token1) to targetSqrtP = currentSqrtP * sqrt(1 - bps/10000)
function simulateMoveDown(intervals, currentTick, currentSqrtP, targetSqrtP, dec0, dec1) {
  let idx = intervals.findIndex((iv) => currentTick >= iv.tickLower && currentTick < iv.tickUpper);
  if (idx === -1) return { amount0In: 0, amount1Out: 0, endSqrtP: currentSqrtP };

  let sp = currentSqrtP;
  let amt0Raw = 0;
  let amt1Raw = 0;

  while (idx >= 0 && sp > targetSqrtP) {
    const iv = intervals[idx];
    const lowerSp = tickToSqrtP(iv.tickLower);
    const nextSp = Math.max(targetSqrtP, lowerSp);
    if (nextSp < sp) {
      amt0Raw += iv.liquidity * (1 / nextSp - 1 / sp);
      amt1Raw += iv.liquidity * (sp - nextSp);
      sp = nextSp;
    }
    if (sp <= lowerSp) idx--;
    else break;
  }
  return {
    amount0In: amt0Raw / 10 ** dec0,
    amount1Out: amt1Raw / 10 ** dec1,
    endSqrtP: sp,
  };
}

// Exact V3 swap simulator (zero-fee curve step + fee applied on input, matching Uniswap V3 SwapMath)
// side = 'BUY_BASE' (user sends USDT/token1, receives base/token0)
// side = 'SELL_BASE' (user sends base/token0, receives USDT/token1)
function simulateTradeImpact(intervals, currentTick, currentSqrtP, dec0, dec1, spotPrice, feeRate, tradeUsd, side) {
  let idx = intervals.findIndex((iv) => currentTick >= iv.tickLower && currentTick < iv.tickUpper);
  if (idx === -1) return null;

  let sp = currentSqrtP;

  if (side === "BUY_BASE") {
    // User inputs tradeUsd of USDT (token1). Fee is taken from input: effective dy = tradeUsd * (1 - feeRate) * 10^dec1
    let rem1Raw = tradeUsd * (1 - feeRate) * 10 ** dec1;
    let out0Raw = 0;
    while (idx < intervals.length && rem1Raw > 1e-6) {
      const iv = intervals[idx];
      const upperSp = tickToSqrtP(iv.tickUpper);
      const maxDy = iv.liquidity * (upperSp - sp);
      if (rem1Raw <= maxDy) {
        const nextSp = sp + rem1Raw / iv.liquidity;
        out0Raw += iv.liquidity * (1 / sp - 1 / nextSp);
        sp = nextSp;
        rem1Raw = 0;
      } else {
        out0Raw += iv.liquidity * (1 / sp - 1 / upperSp);
        rem1Raw -= maxDy;
        sp = upperSp;
        idx++;
      }
    }
    const baseOut = out0Raw / 10 ** dec0;
    const effPriceExFee = (tradeUsd * (1 - feeRate)) / baseOut;
    const effPriceAllIn = tradeUsd / baseOut;
    const endPrice = sp * sp * 10 ** (dec0 - dec1);
    return {
      tradeUsd,
      side,
      baseTraded: baseOut,
      effectivePriceExFee: effPriceExFee,
      effectivePriceAllIn: effPriceAllIn,
      endSpotPrice: endPrice,
      purePriceImpactBps: ((effPriceExFee / spotPrice) - 1) * 10000,
      allInCostBps: ((effPriceAllIn / spotPrice) - 1) * 10000,
      endSpotMoveBps: ((endPrice / spotPrice) - 1) * 10000,
      unfilledUsd: rem1Raw / ((1 - feeRate) * 10 ** dec1),
    };
  } else {
    // SELL_BASE: user sends base equivalent to tradeUsd at current spot: baseIn = tradeUsd / spotPrice
    const baseInHuman = tradeUsd / spotPrice;
    let rem0Raw = baseInHuman * (1 - feeRate) * 10 ** dec0;
    let out1Raw = 0;
    while (idx >= 0 && rem0Raw > 1e-6) {
      const iv = intervals[idx];
      const lowerSp = tickToSqrtP(iv.tickLower);
      const maxDx = iv.liquidity * (1 / lowerSp - 1 / sp);
      if (rem0Raw <= maxDx) {
        const invNextSp = 1 / sp + rem0Raw / iv.liquidity;
        const nextSp = 1 / invNextSp;
        out1Raw += iv.liquidity * (sp - nextSp);
        sp = nextSp;
        rem0Raw = 0;
      } else {
        out1Raw += iv.liquidity * (sp - lowerSp);
        rem0Raw -= maxDx;
        sp = lowerSp;
        idx--;
      }
    }
    const usdtOut = out1Raw / 10 ** dec1;
    const effPriceExFee = usdtOut / (baseInHuman * (1 - feeRate));
    const effPriceAllIn = usdtOut / baseInHuman;
    const endPrice = sp * sp * 10 ** (dec0 - dec1);
    return {
      tradeUsd,
      side,
      baseTraded: baseInHuman,
      usdtOut,
      effectivePriceExFee: effPriceExFee,
      effectivePriceAllIn: effPriceAllIn,
      endSpotPrice: endPrice,
      purePriceImpactBps: (1 - effPriceExFee / spotPrice) * 10000,
      allInCostBps: (1 - effPriceAllIn / spotPrice) * 10000,
      endSpotMoveBps: (1 - endPrice / spotPrice) * 10000,
      unfilledUsd: (rem0Raw / ((1 - feeRate) * 10 ** dec0)) * spotPrice,
    };
  }
}

function main() {
  const dataPath = path.join(__dirname, "market_data_14d.json");
  const raw = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  const { metadata, dailyCheckpoints, poolStates, events, gasSamples } = raw;
  const days = metadata.window.days;

  // WHSK price from primary pool
  const whskPool = poolStates["0x4ff515761864e7838b0adb8b5b2b8b7a068905dc"];
  const whskSp = Number(BigInt(whskPool.sqrtPriceX96)) / 2 ** 96;
  const whskUsdPrice = whskSp * whskSp * 10 ** (whskPool.token0.decimals - whskPool.token1.decimals);

  // Gas analysis
  const baseFeeWei = Number(metadata.baseFeeWei || metadata.gasPriceWei);
  const gasPriceWei = Number(metadata.gasPriceWei);
  const gasPriceHsk = gasPriceWei / 1e18;
  const hskPer100kGas = 100000 * gasPriceHsk;
  const usdPer100kGas = hskPer100kGas * whskUsdPrice;

  const swapGasList = gasSamples.filter((g) => g.isSwap).map((g) => g.gasUsed).sort((a, b) => a - b);
  const mintGasList = gasSamples.filter((g) => g.isMint).map((g) => g.gasUsed).sort((a, b) => a - b);
  const burnGasList = gasSamples.filter((g) => g.isBurn).map((g) => g.gasUsed).sort((a, b) => a - b);

  // Note: Uniswap V3 LP exit typically requires decreaseLiquidity + collect (or multicall).
  // Burn event tx receipts from PositionManager are either decreaseLiquidity+collect or decreaseLiquidity alone.
  const medianSwapGas = quantile(swapGasList, 0.5);
  const medianMintGas = quantile(mintGasList, 0.5);
  const medianBurnGas = quantile(burnGasList, 0.5);

  const gasSummary = {
    gasPriceWei: metadata.gasPriceWei,
    gasPriceGwei: gasPriceWei / 1e9,
    baseFeeGwei: baseFeeWei / 1e9,
    whskSpotUsd: whskUsdPrice,
    usdPer100kGas,
    swapSamples: swapGasList,
    mintSamples: mintGasList,
    burnSamples: burnGasList,
    medianSwapGas,
    medianSwapCostUsd: medianSwapGas * gasPriceHsk * whskUsdPrice,
    medianMintGas,
    medianMintCostUsd: medianMintGas * gasPriceHsk * whskUsdPrice,
    medianBurnGas,
    medianBurnCostUsd: medianBurnGas * gasPriceHsk * whskUsdPrice,
    // Round-trip V3 withdrawal (decrease + collect) + redeposit (mint) cost:
    // Note: if decreaseLiquidity+collect is separate from mint, total = medianBurnGas + medianMintGas (plus ~55k if separate collect)
    v3WithdrawAndRedeployGasConservative: medianBurnGas + 55000 + medianMintGas,
    v3WithdrawAndRedeployCostUsdConservative: (medianBurnGas + 55000 + medianMintGas) * gasPriceHsk * whskUsdPrice,
    v3WithdrawAndRedeployGasMulticall: medianBurnGas + medianMintGas,
    v3WithdrawAndRedeployCostUsdMulticall: (medianBurnGas + medianMintGas) * gasPriceHsk * whskUsdPrice,
  };

  const poolAnalyses = {};

  for (const [addr, p] of Object.entries(poolStates)) {
    const dec0 = p.token0.decimals;
    const dec1 = p.token1.decimals;
    const spRaw = Number(BigInt(p.sqrtPriceX96)) / 2 ** 96;
    const spotPrice = spRaw * spRaw * 10 ** (dec0 - dec1);
    const bal0 = Number(BigInt(p.bal0Raw)) / 10 ** dec0;
    const bal1 = Number(BigInt(p.bal1Raw)) / 10 ** dec1;
    const tvlUsd = bal0 * spotPrice + bal1;

    const intervals = buildTickIntervals(p.ticks);
    const curIv = intervals.find((iv) => p.currentTick >= iv.tickLower && p.currentTick < iv.tickUpper);
    const liquidityMatch = curIv ? curIv.liquidityBigInt === BigInt(p.activeLiquidity) : false;
    const baseFullRangeL = p.ticks.length >= 2 && p.ticks[0].tick === -887220 ? BigInt(p.ticks[0].liquidityNet) : 0n;
    const fullRangeSharePct =
      BigInt(p.activeLiquidity) > 0n ? (Number(baseFullRangeL) / Number(p.activeLiquidity)) * 100 : 0;

    // 1. Liquidity depth within +/- bps bands
    const depthBandsBps = [10, 50, 100, 500, 1000, 2000];
    const depthTable = {};
    for (const bps of depthBandsBps) {
      const upTarget = spRaw * Math.sqrt(1 + bps / 10000);
      const downTarget = spRaw * Math.sqrt(1 - bps / 10000);
      const up = simulateMoveUp(intervals, p.currentTick, spRaw, upTarget, dec0, dec1);
      const down = simulateMoveDown(intervals, p.currentTick, spRaw, downTarget, dec0, dec1);
      depthTable[`+/-${bps}bps`] = {
        bps,
        buyBaseCapacityUsd: up.amount1In,
        buyBaseCapacityTokens: up.amount0Out,
        sellBaseCapacityUsd: down.amount1Out,
        sellBaseCapacityTokens: down.amount0In,
        twoSidedUsd: up.amount1In + down.amount1Out,
        pctOfTvl: ((up.amount1In + down.amount1Out) / tvlUsd) * 100,
      };
    }

    // 2. Price impact vs trade size
    const tradeSizesUsd = [100, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000];
    const feeRate = p.fee / 1e6;
    const priceImpactTable = tradeSizesUsd.map((sz) => ({
      tradeUsd: sz,
      buyBase: simulateTradeImpact(intervals, p.currentTick, spRaw, dec0, dec1, spotPrice, feeRate, sz, "BUY_BASE"),
      sellBase: simulateTradeImpact(intervals, p.currentTick, spRaw, dec0, dec1, spotPrice, feeRate, sz, "SELL_BASE"),
    }));

    // 3. Historical Swap analysis
    const poolSwaps = events.swaps
      .filter((s) => s.pool === addr)
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

    const swapSizesUsd = [];
    let buyBaseVolUsd = 0;
    let sellBaseVolUsd = 0;
    let buyCount = 0;
    let sellCount = 0;

    // Daily buckets using dailyCheckpoints
    const dailyBuckets = Array.from({ length: 14 }, (_, d) => ({
      dayIndex: d,
      startBlock: dailyCheckpoints[d].blockNumber,
      endBlock: dailyCheckpoints[d + 1].blockNumber,
      startIso: dailyCheckpoints[d].iso,
      endIso: dailyCheckpoints[d + 1].iso,
      swapCount: 0,
      volumeUsd: 0,
      maxSwapUsd: 0,
    }));

    // Price trajectory for realized volatility
    const swapPrices = [];
    for (const s of poolSwaps) {
      const a0 = Number(BigInt(s.amount0)) / 10 ** dec0;
      const a1 = Number(BigInt(s.amount1)) / 10 ** dec1;
      const usd = Math.abs(a1); // amount1 is USDT
      swapSizesUsd.push(usd);
      if (a0 < 0) {
        // pool sent token0, received USDT -> BUY_BASE
        buyBaseVolUsd += usd;
        buyCount++;
      } else {
        sellBaseVolUsd += usd;
        sellCount++;
      }
      const spPost = Number(BigInt(s.sqrtPriceX96)) / 2 ** 96;
      const pPost = spPost * spPost * 10 ** (dec0 - dec1);
      swapPrices.push({ blockNumber: s.blockNumber, price: pPost });

      for (let d = 0; d < 14; d++) {
        if (s.blockNumber >= dailyBuckets[d].startBlock && (s.blockNumber < dailyBuckets[d].endBlock || (d === 13 && s.blockNumber <= dailyBuckets[d].endBlock))) {
          dailyBuckets[d].swapCount++;
          dailyBuckets[d].volumeUsd += usd;
          if (usd > dailyBuckets[d].maxSwapUsd) dailyBuckets[d].maxSwapUsd = usd;
          break;
        }
      }
    }

    const sortedSizes = [...swapSizesUsd].sort((a, b) => a - b);
    const totalVolUsd = buyBaseVolUsd + sellBaseVolUsd;
    const avgDailyVolUsd = totalVolUsd / days;
    const fees14dUsd = totalVolUsd * feeRate;
    const avgDailyFeesUsd = fees14dUsd / days;
    const lpFeeApr = tvlUsd > 0 ? ((avgDailyFeesUsd * 365) / tvlUsd) * 100 : 0;
    const lpFeeApy = tvlUsd > 0 ? (Math.pow(1 + avgDailyFeesUsd / tvlUsd, 365) - 1) * 100 : 0;

    // Daily close prices for realized annualized volatility
    const dailyCloses = [];
    for (let d = 0; d < 14; d++) {
      const inDay = swapPrices.filter((sp) => sp.blockNumber <= dailyCheckpoints[d + 1].blockNumber);
      if (inDay.length > 0) dailyCloses.push(inDay[inDay.length - 1].price);
    }
    const logReturns = [];
    for (let i = 1; i < dailyCloses.length; i++) {
      if (dailyCloses[i] > 0 && dailyCloses[i - 1] > 0) {
        logReturns.push(Math.log(dailyCloses[i] / dailyCloses[i - 1]));
      }
    }
    let dailyVolStd = 0;
    if (logReturns.length > 1) {
      const meanR = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
      const varR = logReturns.reduce((a, b) => a + (b - meanR) ** 2, 0) / (logReturns.length - 1);
      dailyVolStd = Math.sqrt(varR);
    }
    const annualizedVolPct = dailyVolStd * Math.sqrt(365) * 100;

    // Size thresholds
    const thresholds = [100, 500, 1000, 2500, 5000, 10000, 25000];
    const sizeBuckets = thresholds.map((th) => {
      const matching = swapSizesUsd.filter((x) => x >= th);
      const sum = matching.reduce((a, b) => a + b, 0);
      return {
        minUsd: th,
        count: matching.length,
        pctOfSwaps: poolSwaps.length > 0 ? (matching.length / poolSwaps.length) * 100 : 0,
        volumeUsd: sum,
        pctOfVolume: totalVolUsd > 0 ? (sum / totalVolUsd) * 100 : 0,
      };
    });

    // Gas drag as bps of reservation notional
    const gasDragByNotionalBps = [1000, 5000, 10000, 25000, 50000, 100000].map((notional) => ({
      notionalUsd: notional,
      conservativeGasBps: (gasSummary.v3WithdrawAndRedeployCostUsdConservative / notional) * 10000,
      multicallGasBps: (gasSummary.v3WithdrawAndRedeployCostUsdMulticall / notional) * 10000,
    }));

    poolAnalyses[addr] = {
      name: p.name,
      address: addr,
      feeBps: p.fee / 100,
      tickSpacing: p.tickSpacing,
      currentTick: p.currentTick,
      activeLiquidity: p.activeLiquidity,
      liquidityReconstructionMatchesSlot: liquidityMatch,
      initializedTickCount: p.initializedTickCount,
      tickRangeSummary: intervals.map((iv) => ({
        tickLower: iv.tickLower,
        tickUpper: iv.tickUpper,
        liquidity: iv.liquidityBigInt.toString(),
        shareOfActivePct: (Number(iv.liquidityBigInt) / Number(p.activeLiquidity)) * 100,
      })),
      spotPriceUsd: spotPrice,
      balances: {
        token0Symbol: p.token0.symbol,
        token0Amount: bal0,
        token1Symbol: p.token1.symbol,
        token1Amount: bal1,
      },
      tvlUsd,
      lpInventoryExposure: {
        token0SharePct: ((bal0 * spotPrice) / tvlUsd) * 100,
        token1SharePct: (bal1 / tvlUsd) * 100,
        fullRangeSharePct,
      },
      depthTable,
      priceImpactTable,
      historical14d: {
        swapCount: poolSwaps.length,
        swapsPerDay: poolSwaps.length / days,
        buyBaseCount: buyCount,
        sellBaseCount: sellCount,
        buyBaseVolUsd,
        sellBaseVolUsd,
        totalVolUsd,
        avgDailyVolUsd,
        fees14dUsd,
        avgDailyFeesUsd,
        lpFeeAprPct: lpFeeApr,
        lpFeeApyPct: lpFeeApy,
        realizedPriceMin: swapPrices.length ? Math.min(...swapPrices.map((x) => x.price)) : spotPrice,
        realizedPriceMax: swapPrices.length ? Math.max(...swapPrices.map((x) => x.price)) : spotPrice,
        realizedDailyVolPct: dailyVolStd * 100,
        realizedAnnualizedVolPct: annualizedVolPct,
        swapSizeStatsUsd: {
          min: sortedSizes[0] || 0,
          p25: quantile(sortedSizes, 0.25),
          median: quantile(sortedSizes, 0.5),
          p75: quantile(sortedSizes, 0.75),
          p90: quantile(sortedSizes, 0.9),
          p95: quantile(sortedSizes, 0.95),
          p99: quantile(sortedSizes, 0.99),
          max: sortedSizes[sortedSizes.length - 1] || 0,
          mean: poolSwaps.length ? totalVolUsd / poolSwaps.length : 0,
        },
        sizeBuckets,
        dailyBuckets,
        mintCount14d: events.mints.filter((m) => m.pool === addr).length,
        burnCount14d: events.burns.filter((b) => b.pool === addr).length,
      },
      gasDragByNotionalBps,
    };
  }

  const out = {
    metadata,
    gasSummary,
    pools: poolAnalyses,
  };

  const outPath = path.join(__dirname, "analysis_summary.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Saved quantitative analysis to ${outPath}`);

  // Print concise executive summary
  console.log("\n=== GAS SUMMARY (VERIFIED ON-CHAIN) ===");
  console.log(
    `GasPrice=${gasSummary.gasPriceGwei.toFixed(4)} gwei, WHSK=$${gasSummary.whskSpotUsd.toFixed(6)}, 100k gas=$${gasSummary.usdPer100kGas.toFixed(6)}`
  );
  console.log(
    `Median gasUsed: Swap=${gasSummary.medianSwapGas} ($${gasSummary.medianSwapCostUsd.toFixed(5)}), Mint=${gasSummary.medianMintGas} ($${gasSummary.medianMintCostUsd.toFixed(5)}), Burn=${gasSummary.medianBurnGas} ($${gasSummary.medianBurnCostUsd.toFixed(5)})`
  );
  console.log(
    `V3 Withdraw+Redeploy conservative=${gasSummary.v3WithdrawAndRedeployGasConservative} gas ($${gasSummary.v3WithdrawAndRedeployCostUsdConservative.toFixed(5)})`
  );

  for (const p of Object.values(poolAnalyses)) {
    console.log(`\n=== ${p.name} (${p.address}) ===`);
    console.log(
      `TVL=$${p.tvlUsd.toFixed(2)}, Spot=$${p.spotPriceUsd.toPrecision(6)}, L_match=${p.liquidityReconstructionMatchesSlot}, FullRange=${p.lpInventoryExposure.fullRangeSharePct.toFixed(4)}%`
    );
    console.log(
      `14d Swaps=${p.historical14d.swapCount} (${p.historical14d.swapsPerDay.toFixed(1)}/d), Vol14d=$${p.historical14d.totalVolUsd.toFixed(2)} ($${p.historical14d.avgDailyVolUsd.toFixed(2)}/d), Fees14d=$${p.historical14d.fees14dUsd.toFixed(2)}`
    );
    console.log(
      `LP Fee APR=${p.historical14d.lpFeeAprPct.toFixed(2)}%, APY=${p.historical14d.lpFeeApyPct.toFixed(2)}%, Realized Ann Vol=${p.historical14d.realizedAnnualizedVolPct.toFixed(2)}%`
    );
    const s = p.historical14d.swapSizeStatsUsd;
    console.log(
      `Swap Sizes ($): min=${s.min.toFixed(2)}, p50=${s.median.toFixed(2)}, p75=${s.p75.toFixed(2)}, p90=${s.p90.toFixed(2)}, p95=${s.p95.toFixed(2)}, max=${s.max.toFixed(2)}`
    );
    console.log("Depth (+/- bps two-sided USD):");
    for (const [k, d] of Object.entries(p.depthTable)) {
      console.log(`  ${k}: $${d.twoSidedUsd.toFixed(2)} (${d.pctOfTvl.toFixed(2)}% of TVL)`);
    }
    console.log("Price Impact (Buy Base / Sell Base pure slippage bps & all-in bps):");
    for (const row of p.priceImpactTable) {
      console.log(
        `  $${row.tradeUsd}: BUY pure=${row.buyBase.purePriceImpactBps.toFixed(1)}bps allIn=${row.buyBase.allInCostBps.toFixed(1)}bps | SELL pure=${row.sellBase.purePriceImpactBps.toFixed(1)}bps allIn=${row.sellBase.allInCostBps.toFixed(1)}bps`
      );
    }
  }
}

main();
