// Step 2: Collect full tick liquidity distributions, 14-day Swap/Mint/Burn logs,
// and real transaction gas usage for the 3 active HSKSwap V3 pools on HashKey Chain mainnet.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RPC_URL,
  TOPICS,
  rpc,
  rpcBatch,
  ethCall,
  getLogsChunked,
  decodeAddress,
  decodeUint256,
  decodeInt256,
  decodeInt24,
  encodeInt16,
  encodeInt24,
} from "./rpc.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TARGET_POOLS = [
  {
    name: "WHSK/USDT (0.30%)",
    address: "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc",
    token0: { symbol: "WHSK", decimals: 18 },
    token1: { symbol: "USDT", decimals: 6 },
    fee: 3000,
    tickSpacing: 60,
  },
  {
    name: "WETH/USDT (0.30%)",
    address: "0xb92b79ed6b370d5cfee2e14b1d0983c258304c16",
    token0: { symbol: "WETH", decimals: 18 },
    token1: { symbol: "USDT", decimals: 6 },
    fee: 3000,
    tickSpacing: 60,
  },
  {
    name: "WBTC/USDT (0.30%)",
    address: "0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a",
    token0: { symbol: "WBTC", decimals: 8 },
    token1: { symbol: "USDT", decimals: 6 },
    fee: 3000,
    tickSpacing: 60,
  },
];

function decodeSigned128(hex64) {
  return decodeInt256(hex64);
}

async function fetchInitializedTicks(poolAddr, currentTick, tickSpacing, blockTag) {
  const compressed = Math.floor(currentTick / tickSpacing);
  const currentWord = compressed >> 8;
  // Scan +-15 words around currentWord (+/- 15 * 256 * 60 = +/- 230,400 ticks -> huge range)
  // Plus min/max edge words (-58 to 57 for tickSpacing 60, covers full [-887272, 887272])!
  // Actually [-58, 57] is only 116 words total — we can scan the ENTIRE tick space in 2 batches!
  const words = [];
  for (let w = -58; w <= 58; w++) words.push(w);

  const bitmapCalls = words.map((w) => ({
    method: "eth_call",
    params: [{ to: poolAddr, data: "0x5339c296" + encodeInt16(w) }, blockTag], // tickBitmap(int16)
  }));

  const bitmapResults = [];
  for (let i = 0; i < bitmapCalls.length; i += 60) {
    const res = await rpcBatch(bitmapCalls.slice(i, i + 60));
    bitmapResults.push(...res);
  }

  const initTicks = [];
  for (let idx = 0; idx < words.length; idx++) {
    const wordPos = words[idx];
    const wordVal = BigInt(bitmapResults[idx]);
    if (wordVal === 0n) continue;
    for (let bit = 0; bit < 256; bit++) {
      if ((wordVal >> BigInt(bit)) & 1n) {
        const tick = ((wordPos << 8) + bit) * tickSpacing;
        initTicks.push(tick);
      }
    }
  }
  initTicks.sort((a, b) => a - b);

  // Query ticks(int24) = 0xf30dba93 for all initialized ticks
  const tickCalls = initTicks.map((t) => ({
    method: "eth_call",
    params: [{ to: poolAddr, data: "0xf30dba93" + encodeInt24(t) }, blockTag],
  }));

  const tickResults = [];
  for (let i = 0; i < tickCalls.length; i += 60) {
    const res = await rpcBatch(tickCalls.slice(i, i + 60));
    tickResults.push(...res);
  }

  const ticks = initTicks.map((tick, i) => {
    const clean = tickResults[i].replace(/^0x/, "");
    const liquidityGross = BigInt("0x" + clean.slice(0, 64));
    const liquidityNet = decodeSigned128(clean.slice(64, 128));
    const initialized = BigInt("0x" + clean.slice(448, 512)) === 1n;
    return {
      tick,
      liquidityGross: liquidityGross.toString(),
      liquidityNet: liquidityNet.toString(),
      initialized,
    };
  });

  return { currentWord, ticks };
}

function decodeSwapLog(log) {
  const clean = log.data.replace(/^0x/, "");
  // Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
  const amount0 = decodeInt256(clean.slice(0, 64));
  const amount1 = decodeInt256(clean.slice(64, 128));
  const sqrtPriceX96 = BigInt("0x" + clean.slice(128, 192));
  const liquidity = BigInt("0x" + clean.slice(192, 256));
  const tick = decodeInt24("0x" + clean.slice(256, 320));
  return {
    event: "Swap",
    pool: log.address.toLowerCase(),
    blockNumber: parseInt(log.blockNumber, 16),
    txHash: log.transactionHash,
    logIndex: parseInt(log.logIndex, 16),
    sender: decodeAddress(log.topics[1]),
    recipient: decodeAddress(log.topics[2]),
    amount0: amount0.toString(),
    amount1: amount1.toString(),
    sqrtPriceX96: sqrtPriceX96.toString(),
    liquidity: liquidity.toString(),
    tick,
  };
}

function decodeMintLog(log) {
  const clean = log.data.replace(/^0x/, "");
  // Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)
  const sender = decodeAddress(clean.slice(0, 64));
  const owner = decodeAddress(log.topics[1]);
  const tickLower = decodeInt24(log.topics[2]);
  const tickUpper = decodeInt24(log.topics[3]);
  const amount = BigInt("0x" + clean.slice(64, 128));
  const amount0 = BigInt("0x" + clean.slice(128, 192));
  const amount1 = BigInt("0x" + clean.slice(192, 256));
  return {
    event: "Mint",
    pool: log.address.toLowerCase(),
    blockNumber: parseInt(log.blockNumber, 16),
    txHash: log.transactionHash,
    logIndex: parseInt(log.logIndex, 16),
    sender,
    owner,
    tickLower,
    tickUpper,
    amount: amount.toString(),
    amount0: amount0.toString(),
    amount1: amount1.toString(),
  };
}

function decodeBurnLog(log) {
  const clean = log.data.replace(/^0x/, "");
  // Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)
  const owner = decodeAddress(log.topics[1]);
  const tickLower = decodeInt24(log.topics[2]);
  const tickUpper = decodeInt24(log.topics[3]);
  const amount = BigInt("0x" + clean.slice(0, 64));
  const amount0 = BigInt("0x" + clean.slice(64, 128));
  const amount1 = BigInt("0x" + clean.slice(128, 192));
  return {
    event: "Burn",
    pool: log.address.toLowerCase(),
    blockNumber: parseInt(log.blockNumber, 16),
    txHash: log.transactionHash,
    logIndex: parseInt(log.logIndex, 16),
    owner,
    tickLower,
    tickUpper,
    amount: amount.toString(),
    amount0: amount0.toString(),
    amount1: amount1.toString(),
  };
}

async function main() {
  const latestBlock = parseInt(await rpc("eth_blockNumber"), 16);
  const blockTag = "0x" + latestBlock.toString(16);
  const latestBlk = await rpc("eth_getBlockByNumber", [blockTag, false]);
  const latestTs = parseInt(latestBlk.timestamp, 16);
  const gasPriceWei = BigInt(await rpc("eth_gasPrice"));
  const baseFeeWei = latestBlk.baseFeePerGas ? BigInt(latestBlk.baseFeePerGas) : null;

  // 14 days = 14 * 86400 / 2 = 604,800 blocks
  const lookbackBlocks = 604800;
  const fromBlock = latestBlock - lookbackBlocks;
  const fromBlk = await rpc("eth_getBlockByNumber", ["0x" + fromBlock.toString(16), false]);
  const fromTs = parseInt(fromBlk.timestamp, 16);

  console.log(`Snapshot block: ${latestBlock} (${new Date(latestTs * 1000).toISOString()})`);
  console.log(`Event window: ${fromBlock} (${new Date(fromTs * 1000).toISOString()}) -> ${latestBlock} (${((latestTs - fromTs) / 86400).toFixed(4)} days)`);

  // 1. Collect current slot0, liquidity, feeGrowthGlobal, balances, and full tick map at exact snapshotBlock
  const poolStates = {};
  for (const p of TARGET_POOLS) {
    const [slot0Hex, liqHex, bal0Hex, bal1Hex] = await Promise.all([
      ethCall(p.address, "0x3850c7bd", blockTag),
      ethCall(p.address, "0x1a686502", blockTag),
      ethCall(
        p.address === "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc"
          ? "0xb210d2120d57b758ee163cffb43e73728c471cf1"
          : p.address === "0xb92b79ed6b370d5cfee2e14b1d0983c258304c16"
          ? "0xefd4bc9afd210517803f293ababd701caeecdfd0"
          : "0x6119ca49a79f5825c8b345f8d7ac36b272565b14",
        "0x70a08231" + p.address.slice(2).padStart(64, "0"),
        blockTag
      ),
      ethCall(
        "0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029",
        "0x70a08231" + p.address.slice(2).padStart(64, "0"),
        blockTag
      ),
    ]);
    const sqrtPriceX96 = BigInt("0x" + slot0Hex.slice(2, 66));
    const currentTick = decodeInt24("0x" + slot0Hex.slice(66, 130));
    const activeLiquidity = decodeUint256(liqHex);
    const bal0Raw = decodeUint256(bal0Hex);
    const bal1Raw = decodeUint256(bal1Hex);

    console.log(`Fetching full initialized ticks for ${p.name} (tick=${currentTick})...`);
    const tickData = await fetchInitializedTicks(p.address, currentTick, p.tickSpacing, blockTag);
    console.log(`  Found ${tickData.ticks.length} initialized ticks.`);

    poolStates[p.address] = {
      ...p,
      snapshotBlock: latestBlock,
      sqrtPriceX96: sqrtPriceX96.toString(),
      currentTick,
      activeLiquidity: activeLiquidity.toString(),
      bal0Raw: bal0Raw.toString(),
      bal1Raw: bal1Raw.toString(),
      initializedTickCount: tickData.ticks.length,
      ticks: tickData.ticks,
    };
  }

  // 2. Fetch all Swap, Mint, Burn logs across the 3 pools in 14-day window
  console.log(`Fetching 14-day Swap/Mint/Burn logs across 3 pools (from ${fromBlock} to ${latestBlock})...`);
  const logs = await getLogsChunked({
    address: TARGET_POOLS.map((p) => p.address),
    topics: [[TOPICS.V3_SWAP, TOPICS.V3_MINT, TOPICS.V3_BURN]],
    fromBlock,
    toBlock: latestBlock,
    chunkSize: 4999,
    concurrency: 6,
  });
  console.log(`Fetched ${logs.length} total logs.`);

  const swaps = [];
  const mints = [];
  const burns = [];
  for (const log of logs) {
    const t0 = log.topics[0].toLowerCase();
    if (t0 === TOPICS.V3_SWAP) swaps.push(decodeSwapLog(log));
    else if (t0 === TOPICS.V3_MINT) mints.push(decodeMintLog(log));
    else if (t0 === TOPICS.V3_BURN) burns.push(decodeBurnLog(log));
  }
  console.log(`Decoded: ${swaps.length} Swaps, ${mints.length} Mints, ${burns.length} Burns.`);

  // 3. Fetch daily checkpoint block timestamps (15 checkpoints for exact 24h buckets)
  const dailyCheckpoints = [];
  const cpCalls = [];
  for (let d = 0; d <= 14; d++) {
    const b = Math.min(latestBlock, fromBlock + d * 43200);
    cpCalls.push({ method: "eth_getBlockByNumber", params: ["0x" + b.toString(16), false] });
  }
  const cpBlocks = await rpcBatch(cpCalls);
  for (const b of cpBlocks) {
    dailyCheckpoints.push({
      blockNumber: parseInt(b.number, 16),
      timestamp: parseInt(b.timestamp, 16),
      iso: new Date(parseInt(b.timestamp, 16) * 1000).toISOString(),
    });
  }

  // 4. Fetch receipts for Swap gas profiling + historical Mint/Burn gas profiling (blocks 28888150..28889300)
  const histLpLogs = await getLogsChunked({
    address: TARGET_POOLS.map((p) => p.address),
    topics: [[TOPICS.V3_MINT, TOPICS.V3_BURN]],
    fromBlock: 28888150,
    toBlock: 28889300,
    chunkSize: 4999,
    concurrency: 2,
  });
  const histMints = histLpLogs.filter((l) => l.topics[0].toLowerCase() === TOPICS.V3_MINT).map(decodeMintLog);
  const histBurns = histLpLogs.filter((l) => l.topics[0].toLowerCase() === TOPICS.V3_BURN).map(decodeBurnLog);

  const sampleSwapHashes = [...new Set(swaps.slice(-15).map((s) => s.txHash))];
  const sampleMintHashes = [...new Set([...mints, ...histMints].slice(-10).map((m) => m.txHash))];
  const sampleBurnHashes = [...new Set([...burns, ...histBurns].slice(-10).map((b) => b.txHash))];
  const allSampleHashes = [...new Set([...sampleSwapHashes, ...sampleMintHashes, ...sampleBurnHashes])];

  const receiptCalls = allSampleHashes.map((h) => ({
    method: "eth_getTransactionReceipt",
    params: [h],
  }));
  const receipts = await rpcBatch(receiptCalls, 10);
  const gasSamples = receipts.filter(Boolean).map((r) => ({
    txHash: r.transactionHash,
    to: r.to,
    blockNumber: parseInt(r.blockNumber, 16),
    gasUsed: parseInt(r.gasUsed, 16),
    effectiveGasPriceWei: r.effectiveGasPrice ? BigInt(r.effectiveGasPrice).toString() : null,
    isSwap: sampleSwapHashes.includes(r.transactionHash),
    isMint: sampleMintHashes.includes(r.transactionHash),
    isBurn: sampleBurnHashes.includes(r.transactionHash),
  }));

  const out = {
    metadata: {
      rpcUrl: RPC_URL,
      chainId: 177,
      snapshotBlock: latestBlock,
      snapshotTimestamp: latestTs,
      snapshotIso: new Date(latestTs * 1000).toISOString(),
      gasPriceWei: gasPriceWei.toString(),
      baseFeeWei: baseFeeWei ? baseFeeWei.toString() : null,
      window: {
        fromBlock,
        toBlock: latestBlock,
        fromTimestamp: fromTs,
        toTimestamp: latestTs,
        fromIso: new Date(fromTs * 1000).toISOString(),
        toIso: new Date(latestTs * 1000).toISOString(),
        days: (latestTs - fromTs) / 86400,
      },
    },
    dailyCheckpoints,
    poolStates,
    events: {
      swaps,
      mints,
      burns,
      historicalGasSampleMints: histMints,
      historicalGasSampleBurns: histBurns,
    },
    gasSamples,
  };

  const outPath = path.join(__dirname, "market_data_14d.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Saved complete dataset to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
