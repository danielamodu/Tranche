import { createPublicClient, http } from "viem";
import {
  BPS_DENOMINATOR,
  CANONICAL_CHAIN_177_HSKSWAP,
  HskSwapVenue,
  PRICE_SCALE,
  type DexPoolState,
} from "./hskswap.js";
import {
  CANONICAL_CHAIN_177_TOKENS,
  MAINNET_READONLY_RPC_URL,
} from "./protocol-config.js";

interface PairSpec {
  pair: string;
  symbol: keyof typeof CANONICAL_CHAIN_177_TOKENS;
  poolAddress: `0x${string}`;
  fee: number;
}

interface BenchmarkRow {
  pair: string;
  notionalUsd: number;
  inventoryQtyHuman: string;
  status: "QUOTED" | "LIQUIDITY_EXHAUSTED";
  hskSwapCostUsd?: number;
  hskSwapImpactBps?: number;
  trancheCostUsd: number;
  trancheFeeBps: number;
  savingsUsd?: number;
  advantageBps?: number;
  winner: "TRANCHE" | "HSKSWAP";
  gasEstimate?: string;
}

interface PoolSummary {
  pair: string;
  poolAddress: `0x${string}`;
  feeBps: number;
  spotPriceUsd: number;
  twapPriceUsd: number | null;
  liquidity: string;
  tick: number;
  blockNumber: string;
}

const PAIRS: PairSpec[] = [
  {
    pair: "WHSK/USDT",
    symbol: "WHSK",
    poolAddress: CANONICAL_CHAIN_177_HSKSWAP.pools.WHSK_USDT_3000,
    fee: 3000,
  },
  {
    pair: "WETH/USDT",
    symbol: "WETH",
    poolAddress: CANONICAL_CHAIN_177_HSKSWAP.pools.WETH_USDT_3000,
    fee: 3000,
  },
  {
    pair: "WBTC/USDT",
    symbol: "WBTC",
    poolAddress: CANONICAL_CHAIN_177_HSKSWAP.pools.WBTC_USDT_3000,
    fee: 3000,
  },
];

const DEFAULT_NOTIONALS_USD = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000];
const DEFAULT_TRANCHE_FEE_BPS = 50; // 0.50% hold fee (0.00% AMM price impact)

function parseArgs(): { feeBps: number; json: boolean; rpcUrl: string } {
  const args = process.argv.slice(2);
  let feeBps = DEFAULT_TRANCHE_FEE_BPS;
  let json = false;
  let rpcUrl = process.env.HASHKEY_MAINNET_RPC_URL ?? MAINNET_READONLY_RPC_URL;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") {
      json = true;
    } else if (args[i] === "--fee-bps" && args[i + 1]) {
      const parsed = Number(args[i + 1]);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1000) {
        feeBps = parsed;
      }
      i++;
    } else if (args[i] === "--rpc" && args[i + 1]) {
      rpcUrl = args[i + 1]!;
      i++;
    }
  }
  return { feeBps, json, rpcUrl };
}

function priceX36ToUsd(priceX36: bigint, invDecimals: number, payDecimals: number): number {
  const scaleInv = 10n ** BigInt(invDecimals);
  // Raw payment units for 1 whole inventory token
  const rawPayPerWholeInv = (priceX36 * scaleInv) / PRICE_SCALE;
  return Number(rawPayPerWholeInv) / 10 ** payDecimals;
}

function formatUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatQty(raw: bigint, decimals: number): string {
  const val = Number(raw) / 10 ** decimals;
  if (val >= 1000) return val.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (val >= 1) return val.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return val.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatBpsPct(bps: number): string {
  return `${(bps / 100).toFixed(2)}% (${bps} bps)`;
}

async function main(): Promise<void> {
  const { feeBps, json, rpcUrl } = parseArgs();

  const publicClient = createPublicClient({
    transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }),
  });

  const chainId = await publicClient.getChainId();
  if (chainId !== 177) {
    throw new Error(`Expected HashKey Chain Mainnet (177), got chainId=${chainId}`);
  }

  // Strictly read-only: no walletClient, no account, readOnly: true
  const venue = new HskSwapVenue({
    publicClient,
    quoterV2: CANONICAL_CHAIN_177_HSKSWAP.quoterV2,
    swapRouter02: CANONICAL_CHAIN_177_HSKSWAP.swapRouter02,
    multicall3: CANONICAL_CHAIN_177_HSKSWAP.multicall3,
    readOnly: true,
  });

  const usdt = CANONICAL_CHAIN_177_TOKENS.USDT;
  const block = await publicClient.getBlock();
  const timestampIso = new Date(Number(block.timestamp) * 1000).toISOString();

  const summaries: PoolSummary[] = [];
  const rows: BenchmarkRow[] = [];

  for (const spec of PAIRS) {
    const inv = CANONICAL_CHAIN_177_TOKENS[spec.symbol];
    const pool: DexPoolState = await venue.getPoolState(
      spec.poolAddress,
      inv.address,
      usdt.address,
      1800,
    );

    const spotPriceUsd = priceX36ToUsd(pool.spotPriceX36, inv.decimals, usdt.decimals);
    const twapPriceUsd = pool.twapPriceX36
      ? priceX36ToUsd(pool.twapPriceX36, inv.decimals, usdt.decimals)
      : null;

    summaries.push({
      pair: spec.pair,
      poolAddress: spec.poolAddress,
      feeBps: spec.fee / 100,
      spotPriceUsd,
      twapPriceUsd,
      liquidity: pool.liquidity.toString(),
      tick: pool.tick,
      blockNumber: (pool.blockNumber ?? block.number).toString(),
    });

    for (const notionalUsd of DEFAULT_NOTIONALS_USD) {
      const notionalUsdtRaw = BigInt(notionalUsd) * 10n ** BigInt(usdt.decimals);
      // Exact inventory units worth `notionalUsd` at live spot
      const inventoryAmountOut = (notionalUsdtRaw * PRICE_SCALE) / pool.spotPriceX36;
      const trancheCostUsd = notionalUsd * (1 + feeBps / Number(BPS_DENOMINATOR));

      try {
        const quote = await venue.quoteBuyInventory(
          inv.address,
          usdt.address,
          inventoryAmountOut,
          spec.fee,
          pool.spotPriceX36,
        );
        const hskSwapCostUsd = Number(quote.paymentAmountIn) / 10 ** usdt.decimals;
        const savingsUsd = hskSwapCostUsd - trancheCostUsd;
        const advantageBps = quote.priceImpactBps - feeBps;
        const winner: "TRANCHE" | "HSKSWAP" =
          trancheCostUsd < hskSwapCostUsd ? "TRANCHE" : "HSKSWAP";

        rows.push({
          pair: spec.pair,
          notionalUsd,
          inventoryQtyHuman: `${formatQty(inventoryAmountOut, inv.decimals)} ${spec.symbol}`,
          status: "QUOTED",
          hskSwapCostUsd,
          hskSwapImpactBps: quote.priceImpactBps,
          trancheCostUsd,
          trancheFeeBps: feeBps,
          savingsUsd,
          advantageBps,
          winner,
          gasEstimate: quote.gasEstimate.toString(),
        });
      } catch {
        rows.push({
          pair: spec.pair,
          notionalUsd,
          inventoryQtyHuman: `${formatQty(inventoryAmountOut, inv.decimals)} ${spec.symbol}`,
          status: "LIQUIDITY_EXHAUSTED",
          trancheCostUsd,
          trancheFeeBps: feeBps,
          winner: "TRANCHE",
        });
      }
    }
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          chainId,
          rpcUrl,
          blockNumber: block.number.toString(),
          timestamp: timestampIso,
          trancheBenchmarkHoldFeeBps: feeBps,
          readOnly: true,
          pools: summaries,
          results: rows,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("================================================================================");
  console.log("  TRANCHE vs. HSKSwap V3 — Live HashKey Chain Mainnet (Chain 177) Benchmark");
  console.log("================================================================================");
  console.log(`  RPC:             ${rpcUrl} (strictly read-only, 0 transactions broadcast)`);
  console.log(`  Block Number:    ${block.number.toString()}`);
  console.log(`  Block Timestamp: ${timestampIso}`);
  console.log(`  QuoterV2:        ${CANONICAL_CHAIN_177_HSKSWAP.quoterV2}`);
  console.log(`  Tranche Fee:     ${(feeBps / 100).toFixed(2)}% (${feeBps} bps) hold fee, 0.00% AMM slippage`);
  console.log("--------------------------------------------------------------------------------\n");

  console.log("### Live Chain 177 Pool State\n");
  console.log("| Pair | Pool Address | Pool Fee | Live Spot | 30m TWAP | Active Liquidity |");
  console.log("| --- | --- | ---: | ---: | ---: | ---: |");
  for (const s of summaries) {
    console.log(
      `| ${s.pair} | \`${s.poolAddress}\` | ${(s.feeBps / 100).toFixed(2)}% | ${formatUsd(s.spotPriceUsd)} | ${s.twapPriceUsd !== null ? formatUsd(s.twapPriceUsd) : "N/A"} | \`${s.liquidity}\` |`,
    );
  }

  console.log("\n### Execution Cost Comparison (Buy Inventory with USDT)\n");
  console.log(
    "| Pair | Trade Size | Qty | HSKSwap V3 Cost | HSKSwap Impact + Fee | Tranche Cost (0.50% fee) | Savings via Tranche | Winner |",
  );
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const r of rows) {
    if (r.status === "LIQUIDITY_EXHAUSTED") {
      console.log(
        `| ${r.pair} | ${formatUsd(r.notionalUsd)} | ${r.inventoryQtyHuman} | *Pool liquidity exhausted* | *Reverts* | ${formatUsd(r.trancheCostUsd)} | *Fills where AMM reverts* | **TRANCHE** |`,
      );
    } else {
      const savingsStr =
        (r.savingsUsd ?? 0) >= 0
          ? `+${formatUsd(r.savingsUsd!)}`
          : `-${formatUsd(Math.abs(r.savingsUsd!))}`;
      console.log(
        `| ${r.pair} | ${formatUsd(r.notionalUsd)} | ${r.inventoryQtyHuman} | ${formatUsd(r.hskSwapCostUsd!)} | ${formatBpsPct(r.hskSwapImpactBps!)} | ${formatUsd(r.trancheCostUsd)} | ${savingsStr} | **${r.winner}** |`,
      );
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error("Benchmark failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
