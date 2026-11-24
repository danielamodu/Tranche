import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ABIS, TicketStatus, type TrancheAddresses } from "@tranche/sdk";
import { FailoverRpcPool } from "./rpc-failover.js";

export interface TrackedToken {
  symbol: string;
  address: Address;
  decimals: number;
}

export interface TrackedPair {
  label: string;
  inventoryToken: Address;
  paymentToken: Address;
}

export interface VaultTokenInvariantCheck {
  symbol: string;
  token: Address;
  vaultBalance: bigint;
  sumBuckets: bigint;
  lpFree: bigint;
  offerAvailable: bigint;
  reserved: bigint;
  pendingProceeds: bigint;
  protocolFees: bigint;
  solvent: boolean;
}

export interface OraclePairHealth {
  label: string;
  pullValid: boolean;
  pullPriceX36: bigint;
  pullUpdatedAt: bigint;
  adapterValid: boolean;
  adapterPriceX36: bigint;
  ageSeconds: bigint;
}

export interface SoakCycleRecord {
  cycle: number;
  timestampIso: string;
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
  activeRpcUrl: string;
  failoverEventsCount: number;
  invariantsPassed: boolean;
  vaultChecks: VaultTokenInvariantCheck[];
  oracleChecks: OraclePairHealth[];
  pullThreshold: bigint;
  pullSignerCount: bigint;
  totalOffers: number;
  totalTickets: number;
  activeTickets: number;
  expiredReclaimableTickets: number;
  reclaimedCount: number;
  reclaimTxHash?: Hex;
  errors: string[];
}

export interface SoakConfig {
  rpcUrls: readonly string[];
  chainId?: number;
  addresses: Pick<
    TrancheAddresses,
    | "liquidityVault"
    | "commitmentManager"
    | "executionTicket"
    | "signedPullOracle"
    | "oraclePriceAdapter"
  >;
  tokens: readonly TrackedToken[];
  pairs: readonly TrackedPair[];
  keeperPrivateKey?: Hex;
  intervalMs?: number;
  durationMs?: number;
  maxCycles?: number;
  maxReclaimBatchSize?: number;
  telemetryLogPath?: string;
  incidentLogPath?: string;
}

const DEFAULT_DURATION_MS = 72 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_RECLAIM_BATCH_SIZE = 35;

export async function runSoakCycle(params: {
  cycle: number;
  publicClient: PublicClient;
  keeperWalletClient?: WalletClient;
  rpcPool: FailoverRpcPool;
  config: SoakConfig;
}): Promise<SoakCycleRecord> {
  const { cycle, publicClient, keeperWalletClient, rpcPool, config } = params;
  const errors: string[] = [];
  const batchSize = config.maxReclaimBatchSize ?? DEFAULT_RECLAIM_BATCH_SIZE;
  const addrs = config.addresses;

  const [chainId, block, nextOfferId, nextTicketId, pullThreshold, pullSignerCount] =
    await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlock({ blockTag: "latest" }),
      publicClient.readContract({
        address: addrs.commitmentManager,
        abi: ABIS.CommitmentManager as Abi,
        functionName: "nextOfferId",
      }) as Promise<bigint>,
      publicClient.readContract({
        address: addrs.commitmentManager,
        abi: ABIS.CommitmentManager as Abi,
        functionName: "nextTicketId",
      }) as Promise<bigint>,
      publicClient.readContract({
        address: addrs.signedPullOracle!,
        abi: ABIS.SignedPullOracle as Abi,
        functionName: "threshold",
      }) as Promise<bigint>,
      publicClient.readContract({
        address: addrs.signedPullOracle!,
        abi: ABIS.SignedPullOracle as Abi,
        functionName: "signerCount",
      }) as Promise<bigint>,
    ]);

  // 1. Verify INV-1 vault physical solvency for every tracked token
  const vaultChecks: VaultTokenInvariantCheck[] = [];
  for (const tok of config.tokens) {
    const [vaultBalance, lpFree, offerAvailable, reserved, pendingProceeds, protocolFees] =
      await Promise.all([
        publicClient.readContract({
          address: tok.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [addrs.liquidityVault],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: addrs.liquidityVault,
          abi: ABIS.LiquidityVault as Abi,
          functionName: "totalLpFree",
          args: [tok.address],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: addrs.liquidityVault,
          abi: ABIS.LiquidityVault as Abi,
          functionName: "totalOfferAvailable",
          args: [tok.address],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: addrs.liquidityVault,
          abi: ABIS.LiquidityVault as Abi,
          functionName: "totalReserved",
          args: [tok.address],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: addrs.liquidityVault,
          abi: ABIS.LiquidityVault as Abi,
          functionName: "totalPendingProceeds",
          args: [tok.address],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: addrs.liquidityVault,
          abi: ABIS.LiquidityVault as Abi,
          functionName: "protocolFees",
          args: [tok.address],
        }) as Promise<bigint>,
      ]);

    const sumBuckets = lpFree + offerAvailable + reserved + pendingProceeds + protocolFees;
    const solvent = vaultBalance >= sumBuckets;
    if (!solvent) {
      errors.push(
        `INV-1_VIOLATION:${tok.symbol} vaultBalance=${vaultBalance} < sumBuckets=${sumBuckets}`,
      );
    }
    vaultChecks.push({
      symbol: tok.symbol,
      token: tok.address,
      vaultBalance,
      sumBuckets,
      lpFree,
      offerAvailable,
      reserved,
      pendingProceeds,
      protocolFees,
      solvent,
    });
  }

  // 2. Check oracle freshness & adapter health
  const oracleChecks: OraclePairHealth[] = [];
  for (const pair of config.pairs) {
    const [pullQ, adapterQ] = await Promise.all([
      publicClient.readContract({
        address: addrs.signedPullOracle!,
        abi: ABIS.SignedPullOracle as Abi,
        functionName: "getPriceX36",
        args: [pair.inventoryToken, pair.paymentToken],
      }) as Promise<{ priceX36: bigint; updatedAt: bigint; isValid: boolean }>,
      publicClient.readContract({
        address: addrs.oraclePriceAdapter!,
        abi: ABIS.OraclePriceAdapter as Abi,
        functionName: "getPriceX36",
        args: [pair.inventoryToken, pair.paymentToken],
      }) as Promise<{ priceX36: bigint; updatedAt: bigint; isValid: boolean }>,
    ]);

    const ageSeconds =
      pullQ.updatedAt > 0n && block.timestamp >= pullQ.updatedAt
        ? block.timestamp - pullQ.updatedAt
        : 0n;
    oracleChecks.push({
      label: pair.label,
      pullValid: pullQ.isValid,
      pullPriceX36: pullQ.priceX36,
      pullUpdatedAt: pullQ.updatedAt,
      adapterValid: adapterQ.isValid,
      adapterPriceX36: adapterQ.priceX36,
      ageSeconds,
    });
  }

  // 3. Scan tickets and run best-effort expiry reclamation if keeper key provided
  const totalOffers = Number(nextOfferId > 1n ? nextOfferId - 1n : 0n);
  const totalTickets = Number(nextTicketId > 1n ? nextTicketId - 1n : 0n);
  let activeTickets = 0;
  const expiredIds: bigint[] = [];

  for (let id = 1n; id < nextTicketId; id++) {
    const ticket = (await publicClient.readContract({
      address: addrs.commitmentManager,
      abi: ABIS.CommitmentManager as Abi,
      functionName: "getTicket",
      args: [id],
    })) as { status: number; expiresAt: number | bigint };

    if (Number(ticket.status) === TicketStatus.ACTIVE) {
      activeTickets++;
      if (block.timestamp > BigInt(ticket.expiresAt)) {
        expiredIds.push(id);
      }
    }
  }

  let reclaimedCount = 0;
  let reclaimTxHash: Hex | undefined;
  if (expiredIds.length > 0 && keeperWalletClient?.account) {
    const chunk = expiredIds.slice(0, batchSize);
    try {
      const sim = await publicClient.simulateContract({
        account: keeperWalletClient.account,
        address: addrs.commitmentManager,
        abi: ABIS.CommitmentManager as Abi,
        functionName: "reclaimExpiredBatchBestEffort",
        args: [chunk],
      });
      reclaimedCount = Number(sim.result as bigint);
      const txHash = await keeperWalletClient.writeContract(sim.request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") {
        errors.push(`KEEPER_RECLAIM_REVERTED:${txHash}`);
      } else {
        reclaimTxHash = txHash;
      }
    } catch (err) {
      errors.push(`KEEPER_RECLAIM_ERR:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const record: SoakCycleRecord = {
    cycle,
    timestampIso: new Date().toISOString(),
    chainId,
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
    activeRpcUrl: rpcPool.getActiveUrl(),
    failoverEventsCount: rpcPool.events.length,
    invariantsPassed: vaultChecks.every((v) => v.solvent),
    vaultChecks,
    oracleChecks,
    pullThreshold,
    pullSignerCount,
    totalOffers,
    totalTickets,
    activeTickets,
    expiredReclaimableTickets: expiredIds.length,
    reclaimedCount,
    reclaimTxHash,
    errors,
  };

  if (config.telemetryLogPath) {
    await mkdir(dirname(config.telemetryLogPath), { recursive: true });
    await appendFile(
      config.telemetryLogPath,
      `${JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n`,
      "utf8",
    );
  }

  if (errors.length > 0 && config.incidentLogPath) {
    await mkdir(dirname(config.incidentLogPath), { recursive: true });
    await appendFile(
      config.incidentLogPath,
      `\n### Automated Soak Alert (${record.timestampIso}, cycle ${cycle})\n- RPC: \`${record.activeRpcUrl}\`\n- Errors: ${errors.join("; ")}\n`,
      "utf8",
    );
  }

  return record;
}

export async function runSoakLoop(config: SoakConfig): Promise<SoakCycleRecord[]> {
  const rpcPool = new FailoverRpcPool({ urls: config.rpcUrls });
  const chainId = config.chainId ?? 133;
  const chain = defineChain({
    id: chainId,
    name: `HashKey Chain (${chainId})`,
    nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
    rpcUrls: { default: { http: [...config.rpcUrls] } },
  });

  const transport = rpcPool.toViemTransport();
  const publicClient = createPublicClient({ chain, transport });
  const keeperWalletClient = config.keeperPrivateKey
    ? createWalletClient({
        account: privateKeyToAccount(config.keeperPrivateKey),
        chain,
        transport,
      })
    : undefined;

  const startMs = Date.now();
  const durationMs = config.durationMs ?? DEFAULT_DURATION_MS;
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxCycles = config.maxCycles ?? Number.POSITIVE_INFINITY;

  const history: SoakCycleRecord[] = [];
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    const rec = await runSoakCycle({
      cycle,
      publicClient,
      keeperWalletClient,
      rpcPool,
      config,
    });
    history.push(rec);

    if (Date.now() - startMs >= durationMs || cycle >= maxCycles) {
      break;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return history;
}

async function main(): Promise<void> {
  const cfgPath = process.env.SOAK_CONFIG_PATH ?? resolve(process.cwd(), "../../deployments/hashkey-testnet.json");
  const raw = JSON.parse(await readFile(cfgPath, "utf8")) as {
    deploymentStatus?: string;
    network: { chainId: number; rpcUrls: string[] };
    contracts: Partial<TrancheAddresses>;
    tokens: TrackedToken[];
  };

  if (raw.deploymentStatus !== "LIVE_DEPLOYED") {
    throw new Error(
      `Cannot start live 72h soak: ${cfgPath} has deploymentStatus="${raw.deploymentStatus ?? "UNKNOWN"}" (live addresses not yet deployed).`,
    );
  }

  const rpcUrls = process.env.HASHKEY_TESTNET_RPCS
    ? process.env.HASHKEY_TESTNET_RPCS.split(",").map((s) => s.trim()).filter(Boolean)
    : raw.network.rpcUrls;

  const usdt = raw.tokens.find((t) => t.symbol.toLowerCase().includes("usdt"));
  const whsk = raw.tokens.find((t) => t.symbol.toLowerCase().includes("whsk"));
  const pairs: TrackedPair[] =
    usdt && whsk ? [{ label: `${whsk.symbol}/${usdt.symbol}`, inventoryToken: whsk.address, paymentToken: usdt.address }] : [];

  await runSoakLoop({
    rpcUrls,
    chainId: raw.network.chainId,
    addresses: {
      liquidityVault: raw.contracts.liquidityVault!,
      commitmentManager: raw.contracts.commitmentManager!,
      executionTicket: raw.contracts.executionTicket!,
      signedPullOracle: raw.contracts.signedPullOracle!,
      oraclePriceAdapter: raw.contracts.oraclePriceAdapter!,
    },
    tokens: raw.tokens,
    pairs,
    keeperPrivateKey: process.env.KEEPER_PRIVATE_KEY as Hex | undefined,
    intervalMs: Number(process.env.SOAK_INTERVAL_MS ?? DEFAULT_INTERVAL_MS),
    durationMs: Number(process.env.SOAK_DURATION_MS ?? DEFAULT_DURATION_MS),
    telemetryLogPath: resolve(process.cwd(), "../../research/soak-telemetry.jsonl"),
  });
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  main().catch((err) => {
    console.error("[tranche-soak]", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
