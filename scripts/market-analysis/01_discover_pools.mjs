// Step 1: Discover and verify active DEX pools on HashKey Chain mainnet (chain ID 177)
// Combines:
//  (a) On-chain Swap event scan over the last 7 days (302,400 blocks) across all contracts
//  (b) Direct PoolCreated queries on known V3 factories around their deployment/creation blocks
//  (c) Direct eth_call state verification for every discovered pool and its tokens

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
  decodeInt24,
  decodeString,
  encodeAddress,
} from "./rpc.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KNOWN_FACTORIES = [
  {
    name: "HSKSwap V3 Factory (Primary)",
    address: "0x972ca9d1662f5e029cd18327d29026532e84c742",
    creationBlocks: [
      [17406000, 17407000],
      [17712000, 17716000],
      [17796000, 17797000],
      [17836000, 17838000],
      [21198000, 21208500],
      [23660000, 23661000],
      [30088000, 30089000],
    ],
  },
  {
    name: "HSKSwap V3 Factory (Legacy/Alt)",
    address: "0xd136e36610f35e0cc3cad40de858c151f2aa65d4",
    creationBlocks: [
      [12180000, 12181000],
      [12454000, 12455000],
    ],
  },
];

// Additional candidate token pairs to probe via factory.getPool(tokenA, tokenB, fee)
const KNOWN_TOKENS = [
  "0xb210d2120d57b758ee163cffb43e73728c471cf1", // WHSK
  "0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029", // USDT
  "0x054ed45810dbbab8b27668922d110669c9d88d0a", // USDC
  "0xefd4bc9afd210517803f293ababd701caeecdfd0", // WETH
  "0x6119ca49a79f5825c8b345f8d7ac36b272565b14", // WBTC
  "0xd2fdff28a534300ae961c5435e16f9465253b76".padEnd(42, "0").slice(0, 42), // placeholder cleaned below
];

const EXTRA_TOKENS = [
  "0xb210d2120d57b758ee163cffb43e73728c471cf1", // WHSK
  "0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029", // USDT
  "0x054ed45810dbbab8b27668922d110669c9d88d0a", // USDC.e
  "0xefd4bc9afd210517803f293ababd701caeecdfd0", // WETH
  "0x6119ca49a79f5825c8b345f8d7ac36b272565b14", // WBTC
  "0xd2fddff28a534300ae961c5435e16f9465253b76", // stHSK
  "0xe4577dcf1c44f04cf489aa995e01e988f461cc4a", // seen in Factory PoolCreated
  "0xcf9bec9f2769ecc09107c58fa5eb0199d989a606", // seen in Factory PoolCreated
];

async function getTokenInfo(tokenAddr, poolAddr) {
  let symbol = "UNKNOWN";
  let decimals = 18;
  let poolBalance = "0";
  try {
    symbol = decodeString(await ethCall(tokenAddr, "0x95d89b41")); // symbol()
  } catch {}
  try {
    decimals = Number(decodeUint256(await ethCall(tokenAddr, "0x313ce567"))); // decimals()
  } catch {}
  try {
    const data = "0x70a08231" + encodeAddress(poolAddr); // balanceOf(address)
    poolBalance = decodeUint256(await ethCall(tokenAddr, data)).toString();
  } catch {}
  return { address: tokenAddr, symbol, decimals, poolBalanceRaw: poolBalance };
}

async function inspectV3Pool(poolAddr, swapCount7d = 0) {
  const [factoryHex, t0Hex, t1Hex, feeHex, tsHex, slot0Hex, liqHex] = await Promise.all([
    ethCall(poolAddr, "0xc45a0155").catch(() => null), // factory()
    ethCall(poolAddr, "0x0dfe1681").catch(() => null), // token0()
    ethCall(poolAddr, "0xd21220a7").catch(() => null), // token1()
    ethCall(poolAddr, "0xddca3f43").catch(() => null), // fee()
    ethCall(poolAddr, "0xd0c93a7c").catch(() => null), // tickSpacing()
    ethCall(poolAddr, "0x3850c7bd").catch(() => null), // slot0()
    ethCall(poolAddr, "0x1a686502").catch(() => null), // liquidity()
  ]);
  if (!t0Hex || !t1Hex || !slot0Hex || slot0Hex === "0x") return null;

  const token0Addr = decodeAddress(t0Hex);
  const token1Addr = decodeAddress(t1Hex);
  const [token0, token1] = await Promise.all([
    getTokenInfo(token0Addr, poolAddr),
    getTokenInfo(token1Addr, poolAddr),
  ]);

  const sqrtPriceX96 = BigInt("0x" + slot0Hex.slice(2, 66));
  const currentTick = decodeInt24("0x" + slot0Hex.slice(66, 130));
  const liquidity = decodeUint256(liqHex);
  const fee = Number(decodeUint256(feeHex));
  const tickSpacing = Number(decodeUint256(tsHex));

  // Price of token0 in token1 (human units): (sqrtPriceX96 / 2^96)^2 * 10^(dec0 - dec1)
  const sp = Number(sqrtPriceX96) / 2 ** 96;
  const priceToken0InToken1 = sp * sp * 10 ** (token0.decimals - token1.decimals);

  const bal0 = Number(token0.poolBalanceRaw) / 10 ** token0.decimals;
  const bal1 = Number(token1.poolBalanceRaw) / 10 ** token1.decimals;

  return {
    pool: poolAddr.toLowerCase(),
    kind: "UniswapV3",
    factory: decodeAddress(factoryHex),
    fee,
    feeBps: fee / 100,
    tickSpacing,
    sqrtPriceX96: sqrtPriceX96.toString(),
    currentTick,
    activeLiquidity: liquidity.toString(),
    priceToken0InToken1,
    token0: { ...token0, poolBalance: bal0 },
    token1: { ...token1, poolBalance: bal1 },
    swapCount7d,
  };
}

async function main() {
  const chainId = parseInt(await rpc("eth_chainId"), 16);
  const latestBlock = parseInt(await rpc("eth_blockNumber"), 16);
  const latestBlkObj = await rpc("eth_getBlockByNumber", ["0x" + latestBlock.toString(16), false]);
  const latestTs = parseInt(latestBlkObj.timestamp, 16);
  const gasPriceWei = BigInt(await rpc("eth_gasPrice"));
  const baseFeeWei = latestBlkObj.baseFeePerGas ? BigInt(latestBlkObj.baseFeePerGas) : null;

  // 7 days = 7 * 86400 / 2 = 302,400 blocks
  const lookbackBlocks = 302400;
  const fromBlock = latestBlock - lookbackBlocks;
  const fromBlkObj = await rpc("eth_getBlockByNumber", ["0x" + fromBlock.toString(16), false]);
  const fromTs = parseInt(fromBlkObj.timestamp, 16);

  console.log(`Chain ID: ${chainId}, Latest Block: ${latestBlock} (${new Date(latestTs * 1000).toISOString()})`);
  console.log(`7-day Swap Scan: ${fromBlock} -> ${latestBlock} (${((latestTs - fromTs) / 86400).toFixed(4)} days)`);

  // 1. Scan all V3 and V2 Swap events across chain in last 7 days
  const [v3Swaps, v2Swaps] = await Promise.all([
    getLogsChunked({ topics: [TOPICS.V3_SWAP], fromBlock, toBlock: latestBlock, chunkSize: 4999, concurrency: 8 }),
    getLogsChunked({ topics: [TOPICS.V2_SWAP], fromBlock, toBlock: latestBlock, chunkSize: 4999, concurrency: 8 }),
  ]);
  console.log(`Found ${v3Swaps.length} V3 Swap logs and ${v2Swaps.length} V2 Swap logs in last 7 days.`);

  const swapCounts = new Map();
  for (const log of v3Swaps) {
    const addr = log.address.toLowerCase();
    swapCounts.set(addr, (swapCounts.get(addr) || 0) + 1);
  }
  const v2Pools = new Map();
  for (const log of v2Swaps) {
    const addr = log.address.toLowerCase();
    v2Pools.set(addr, (v2Pools.get(addr) || 0) + 1);
  }

  // 2. Also collect PoolCreated events from known V3 factories via JSON-RPC
  const discoveredPoolSet = new Set(swapCounts.keys());
  const factoryPools = [];
  for (const fac of KNOWN_FACTORIES) {
    for (const [s, e] of fac.creationBlocks) {
      const logs = await getLogsChunked({
        address: fac.address,
        topics: [TOPICS.V3_POOL_CREATED],
        fromBlock: s,
        toBlock: e,
        chunkSize: 4999,
        concurrency: 4,
      });
      for (const l of logs) {
        const poolAddr = ("0x" + l.data.slice(90, 130)).toLowerCase();
        discoveredPoolSet.add(poolAddr);
        factoryPools.push({ factory: fac.address, pool: poolAddr, blockNumber: parseInt(l.blockNumber, 16) });
      }
    }
    // Probe getPool(tokenA, tokenB, fee) in parallel batches
    const probeCalls = [];
    for (let i = 0; i < EXTRA_TOKENS.length; i++) {
      for (let j = i + 1; j < EXTRA_TOKENS.length; j++) {
        for (const fee of [100, 500, 3000, 10000]) {
          const [a, b] = EXTRA_TOKENS[i].toLowerCase() < EXTRA_TOKENS[j].toLowerCase()
            ? [EXTRA_TOKENS[i], EXTRA_TOKENS[j]]
            : [EXTRA_TOKENS[j], EXTRA_TOKENS[i]];
          const data = "0x1698ee82" + encodeAddress(a) + encodeAddress(b) + fee.toString(16).padStart(64, "0");
          probeCalls.push({ method: "eth_call", params: [{ to: fac.address, data }, "latest"] });
        }
      }
    }
    for (let k = 0; k < probeCalls.length; k += 40) {
      const batchRes = await rpcBatch(probeCalls.slice(k, k + 40)).catch(() => []);
      for (const res of batchRes) {
        if (res && res !== "0x" && !res.endsWith("0000000000000000000000000000000000000000")) {
          discoveredPoolSet.add(decodeAddress(res));
        }
      }
    }
  }

  console.log(`Total unique V3 pool addresses to inspect: ${discoveredPoolSet.size}`);
  const pools = [];
  for (const addr of discoveredPoolSet) {
    const info = await inspectV3Pool(addr, swapCounts.get(addr) || 0);
    if (info) pools.push(info);
  }

  // Sort by swapCount7d desc, then activeLiquidity desc
  pools.sort((a, b) => {
    if (b.swapCount7d !== a.swapCount7d) return b.swapCount7d - a.swapCount7d;
    return BigInt(b.activeLiquidity) > BigInt(a.activeLiquidity) ? 1 : -1;
  });

  const out = {
    rpcUrl: RPC_URL,
    chainId,
    snapshotBlock: latestBlock,
    snapshotTimestamp: latestTs,
    snapshotIso: new Date(latestTs * 1000).toISOString(),
    gasPriceWei: gasPriceWei.toString(),
    baseFeeWei: baseFeeWei ? baseFeeWei.toString() : null,
    scanWindow: {
      fromBlock,
      toBlock: latestBlock,
      fromTimestamp: fromTs,
      toTimestamp: latestTs,
      days: (latestTs - fromTs) / 86400,
    },
    v3SwapCount7dTotal: v3Swaps.length,
    v2SwapCount7dTotal: v2Swaps.length,
    v2ActivePools: Object.fromEntries(v2Pools),
    pools,
  };

  const outPath = path.join(__dirname, "pools_discovered.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Saved ${pools.length} verified V3 pools to ${outPath}`);
  for (const p of pools) {
    console.log(
      `${p.pool} | ${p.token0.symbol}/${p.token1.symbol} | fee=${p.fee} | swaps7d=${p.swapCount7d} | L=${p.activeLiquidity} | bal0=${p.token0.poolBalance.toFixed(4)} ${p.token0.symbol} | bal1=${p.token1.poolBalance.toFixed(4)} ${p.token1.symbol} | price=${p.priceToken0InToken1.toPrecision(6)}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
