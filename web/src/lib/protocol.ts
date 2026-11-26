import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  fallback,
  http,
  parseAbi,
  type Abi,
  type Address,
  type PublicClient,
} from "viem";
import { ACTIVE_NETWORK } from "@/config/networks";
import type { Eip1193Provider } from "@/context/WalletContext";

export const MULTICALL_CHUNK_SIZE = 30;
export const ACTIVITY_LOOKBACK_BLOCKS = 5_000n;

export const ACTIVE_VIEM_CHAIN = defineChain({
  id: ACTIVE_NETWORK.chainId,
  name: ACTIVE_NETWORK.name,
  nativeCurrency: { name: "HashKey EcoPoints", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: [...ACTIVE_NETWORK.rpcUrls] } },
  blockExplorers: { default: { name: "Blockscout", url: ACTIVE_NETWORK.explorerUrl } },
  contracts: {
    multicall3: { address: ACTIVE_NETWORK.multicall3 },
  },
});

export const tranchePublicClient = createPublicClient({
  chain: ACTIVE_VIEM_CHAIN,
  batch: {
    multicall: {
      wait: 24,
    },
  },
  transport: fallback(ACTIVE_NETWORK.rpcUrls.map((url) => http(url, { timeout: 10_000 }))),
});

export function createTrancheWalletClient(provider: Eip1193Provider, account: Address) {
  return createWalletClient({
    account,
    chain: ACTIVE_VIEM_CHAIN,
    transport: custom(provider),
  });
}

// Verified 1:1 against contracts/src/CommitmentManager.sol & contracts/src/interfaces/IProtocol.sol
export const COMMITMENT_MANAGER_ABI = parseAbi([
  "function nextOfferId() view returns (uint64)",
  "function nextTicketId() view returns (uint256)",
  "function protocolFeeBps() view returns (uint16)",
  "function getOffer(uint64 offerId) view returns ((address lp, uint40 createdAt, uint40 expiry, uint8 priceMode, uint8 status, address inventoryToken, uint32 minDuration, uint32 maxDuration, uint16 basePremiumBps, uint16 dailyPremiumBps, address paymentToken, int16 spreadBps, uint16 protocolFeeBps, address oracle, address complianceHook, uint256 minFillAmount, uint256 fixedPriceX36, uint256 minPriceX36, uint256 maxPriceX36))",
  "function getTicket(uint256 ticketId) view returns ((uint64 offerId, uint40 reservedAt, uint40 expiresAt, uint8 priceMode, uint8 status, int16 spreadBps, uint16 protocolFeeBps, address lp, address inventoryToken, address paymentToken, address oracle, address complianceHook, uint256 initialAmount, uint256 remainingAmount, uint256 minFillAmount, uint256 fixedOrMinPriceX36, uint256 maxPriceX36))",
  "function quoteReservation(uint64 offerId, uint256 inventoryAmount, uint32 duration) view returns (uint256 grossPremium, uint256 protocolFee)",
  "function quoteExercise(uint256 ticketId, uint256 fillAmount) view returns (uint256 actualFill, uint256 grossPayment, uint256 effPriceX36)",
  "function reserve(uint64 offerId, uint256 amount, uint32 duration, uint256 maxPremium, address recipient) returns (uint256 ticketId)",
  "function exercise(uint256 ticketId, uint256 fillAmount, uint256 maxPayment, address receiver) returns (uint256 filled, uint256 paid)",
  "function splitTicket(uint256 ticketId, uint256 splitAmount, address recipient) returns (uint256 childTicketId)",
  "function reclaimExpired(uint256 ticketId)",
  "function createOffer((address inventoryToken, address paymentToken, uint256 initialAmount, uint256 minFillAmount, uint40 expiry, uint32 minDuration, uint32 maxDuration, uint16 basePremiumBps, uint16 dailyPremiumBps, uint8 priceMode, int16 spreadBps, address oracle, address complianceHook, uint256 fixedPriceX36, uint256 minPriceX36, uint256 maxPriceX36) params) returns (uint64 offerId)",
  "function cancelOffer(uint64 offerId)",
]);

// Verified 1:1 against contracts/src/LiquidityVault.sol
export const LIQUIDITY_VAULT_ABI = parseAbi([
  "function offerBalance(uint64 offerId) view returns (uint256)",
  "function lpFreeBalance(address lp, address token) view returns (uint256)",
  "function lpPendingProceeds(address lp, address token) view returns (uint256)",
  "function deposit(address token, uint256 amount)",
  "function withdrawFree(address token, uint256 amount, address to)",
  "function claimProceeds(address token, uint256 amount, address to)",
]);

export const EXECUTION_TICKET_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function transferFrom(address from, address to, uint256 tokenId)",
]);

export const ACTIVITY_EVENTS = parseAbi([
  "event OfferCreated(uint64 indexed offerId, address indexed lp, uint8 priceMode)",
  "event TicketReserved(uint256 indexed ticketId, uint64 indexed offerId, address indexed recipient, uint256 inventoryAmount, uint40 expiresAt, uint256 grossPremium)",
  "event TicketExercised(uint256 indexed ticketId, address indexed exerciser, address indexed receiver, uint256 fillAmount, uint256 grossPayment, uint256 effPriceX36)",
]);

export interface ReservationQuote {
  grossPremium: bigint;
  protocolFee: bigint;
  lpNetPremium: bigint;
}

export interface ExerciseQuote {
  actualFill: bigint;
  grossPayment: bigint;
  effectivePriceX36: bigint;
}

export function decodeQuoteReservationResult(
  raw: readonly [bigint, bigint],
): ReservationQuote {
  const [grossPremium, protocolFee] = raw;
  return {
    grossPremium,
    protocolFee,
    lpNetPremium: grossPremium > protocolFee ? grossPremium - protocolFee : 0n,
  };
}

export function decodeQuoteExerciseResult(
  raw: readonly [bigint, bigint, bigint],
): ExerciseQuote {
  const [actualFill, grossPayment, effectivePriceX36] = raw;
  return {
    actualFill,
    grossPayment,
    effectivePriceX36,
  };
}

export interface MulticallEntry {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export interface MulticallOutcome<T = unknown> {
  status: "success" | "failure";
  result?: T;
  error?: Error;
}

/**
 * Batches contract reads through Multicall3 in sequential chunks of <= chunkSize
 * to avoid HashKey Chain RPC rate limits (HTTP 429) while handling partial failures safely.
 */
export async function chunkedMulticall(
  client: Pick<PublicClient, "multicall">,
  contracts: readonly MulticallEntry[],
  multicallAddress: Address = ACTIVE_NETWORK.multicall3,
  chunkSize: number = MULTICALL_CHUNK_SIZE,
): Promise<MulticallOutcome[]> {
  if (contracts.length === 0) return [];
  const results: MulticallOutcome[] = [];
  for (let i = 0; i < contracts.length; i += chunkSize) {
    const slice = contracts.slice(i, i + chunkSize);
    const batch = await client.multicall({
      multicallAddress,
      allowFailure: true,
      contracts: slice as unknown as Parameters<PublicClient["multicall"]>[0]["contracts"],
    });
    for (const item of batch) {
      results.push(item as MulticallOutcome);
    }
  }
  return results;
}

export interface OnChainOffer {
  offerId: bigint;
  lp: Address;
  createdAt: number;
  expiry: number;
  priceMode: 0 | 1; // 0 = FIXED, 1 = FLOATING
  status: 0 | 1 | 2; // 0 = ACTIVE, 1 = PAUSED, 2 = CANCELLED
  inventoryToken: Address;
  paymentToken: Address;
  minDuration: number;
  maxDuration: number;
  basePremiumBps: number;
  dailyPremiumBps: number;
  spreadBps: number;
  protocolFeeBps: number;
  oracle: Address;
  complianceHook: Address;
  minFillAmount: bigint;
  fixedPriceX36: bigint;
  minPriceX36: bigint;
  maxPriceX36: bigint;
  availableBalance: bigint;
}

interface RawOfferStruct {
  lp: Address;
  createdAt: number;
  expiry: number;
  priceMode: number;
  status: number;
  inventoryToken: Address;
  minDuration: number;
  maxDuration: number;
  basePremiumBps: number;
  dailyPremiumBps: number;
  paymentToken: Address;
  spreadBps: number;
  protocolFeeBps: number;
  oracle: Address;
  complianceHook: Address;
  minFillAmount: bigint;
  fixedPriceX36: bigint;
  minPriceX36: bigint;
  maxPriceX36: bigint;
}

interface RawTicketStruct {
  offerId: bigint;
  reservedAt: number;
  expiresAt: number;
  priceMode: number;
  status: number;
  spreadBps: number;
  protocolFeeBps: number;
  lp: Address;
  inventoryToken: Address;
  paymentToken: Address;
  oracle: Address;
  complianceHook: Address;
  initialAmount: bigint;
  remainingAmount: bigint;
  minFillAmount: bigint;
  fixedOrMinPriceX36: bigint;
  maxPriceX36: bigint;
}

export async function fetchAllOffers(
  client: Pick<PublicClient, "readContract" | "multicall"> = tranchePublicClient,
  config = ACTIVE_NETWORK,
): Promise<OnChainOffer[]> {
  if (!config.isLive) return [];
  const { commitmentManager, liquidityVault } = config.contracts;
  const nextId = await client.readContract({
    address: commitmentManager,
    abi: COMMITMENT_MANAGER_ABI,
    functionName: "nextOfferId",
  });

  const count = Number(nextId) - 1;
  if (count <= 0) return [];

  const ids = Array.from({ length: count }, (_, i) => BigInt(i + 1));
  const calls: MulticallEntry[] = [];
  for (const id of ids) {
    calls.push({
      address: commitmentManager,
      abi: COMMITMENT_MANAGER_ABI,
      functionName: "getOffer",
      args: [id],
    });
    calls.push({
      address: liquidityVault,
      abi: LIQUIDITY_VAULT_ABI,
      functionName: "offerBalance",
      args: [id],
    });
  }

  const outcomes = await chunkedMulticall(client, calls, config.multicall3);
  const offers: OnChainOffer[] = [];

  for (let i = 0; i < ids.length; i++) {
    const offerOut = outcomes[i * 2];
    const balOut = outcomes[i * 2 + 1];
    if (offerOut?.status !== "success" || !offerOut.result) continue;

    const raw = offerOut.result as RawOfferStruct;
    const bal = balOut?.status === "success" && typeof balOut.result === "bigint" ? balOut.result : 0n;

    offers.push({
      offerId: ids[i],
      lp: raw.lp,
      createdAt: Number(raw.createdAt),
      expiry: Number(raw.expiry),
      priceMode: Number(raw.priceMode) as 0 | 1,
      status: Number(raw.status) as 0 | 1 | 2,
      inventoryToken: raw.inventoryToken,
      minDuration: Number(raw.minDuration),
      maxDuration: Number(raw.maxDuration),
      basePremiumBps: Number(raw.basePremiumBps),
      dailyPremiumBps: Number(raw.dailyPremiumBps),
      paymentToken: raw.paymentToken,
      spreadBps: Number(raw.spreadBps),
      protocolFeeBps: Number(raw.protocolFeeBps),
      oracle: raw.oracle,
      complianceHook: raw.complianceHook,
      minFillAmount: raw.minFillAmount,
      fixedPriceX36: raw.fixedPriceX36,
      minPriceX36: raw.minPriceX36,
      maxPriceX36: raw.maxPriceX36,
      availableBalance: bal,
    });
  }

  return offers.reverse();
}

export interface OnChainTicket {
  ticketId: bigint;
  owner: Address | null;
  offerId: bigint;
  reservedAt: number;
  expiresAt: number;
  priceMode: 0 | 1;
  status: 0 | 1 | 2 | 3; // 0=NONE, 1=ACTIVE, 2=EXERCISED, 3=RECLAIMED
  spreadBps: number;
  protocolFeeBps: number;
  lp: Address;
  inventoryToken: Address;
  paymentToken: Address;
  initialAmount: bigint;
  remainingAmount: bigint;
  minFillAmount: bigint;
  fixedOrMinPriceX36: bigint;
  maxPriceX36: bigint;
}

export async function fetchUserTickets(
  userAddress: Address,
  client: Pick<PublicClient, "readContract" | "multicall"> = tranchePublicClient,
  config = ACTIVE_NETWORK,
): Promise<OnChainTicket[]> {
  if (!config.isLive) return [];
  const { commitmentManager, executionTicket } = config.contracts;
  const nextId = await client.readContract({
    address: commitmentManager,
    abi: COMMITMENT_MANAGER_ABI,
    functionName: "nextTicketId",
  });

  const count = Number(nextId) - 1;
  if (count <= 0) return [];

  const ids = Array.from({ length: count }, (_, i) => BigInt(i + 1));
  const ticketCalls: MulticallEntry[] = ids.map((id) => ({
    address: commitmentManager,
    abi: COMMITMENT_MANAGER_ABI,
    functionName: "getTicket",
    args: [id],
  }));

  const ticketOutcomes = await chunkedMulticall(client, ticketCalls, config.multicall3);

  const activeIndices: number[] = [];
  const ownerCalls: MulticallEntry[] = [];
  for (let i = 0; i < ids.length; i++) {
    const out = ticketOutcomes[i];
    if (out?.status !== "success" || !out.result) continue;
    const raw = out.result as RawTicketStruct;
    if (Number(raw.status) === 1) {
      activeIndices.push(i);
      ownerCalls.push({
        address: executionTicket,
        abi: EXECUTION_TICKET_ABI,
        functionName: "ownerOf",
        args: [ids[i]],
      });
    }
  }

  const ownerOutcomes =
    ownerCalls.length > 0 ? await chunkedMulticall(client, ownerCalls, config.multicall3) : [];
  const ownerByIdx = new Map<number, Address>();
  for (let j = 0; j < activeIndices.length; j++) {
    const out = ownerOutcomes[j];
    if (out?.status === "success" && typeof out.result === "string") {
      ownerByIdx.set(activeIndices[j], out.result as Address);
    }
  }

  const lower = userAddress.toLowerCase();
  const matched: OnChainTicket[] = [];
  for (let i = 0; i < ids.length; i++) {
    const owner = ownerByIdx.get(i) ?? null;
    if (!owner || owner.toLowerCase() !== lower) continue;
    const raw = ticketOutcomes[i].result as RawTicketStruct;
    matched.push({
      ticketId: ids[i],
      owner,
      offerId: raw.offerId,
      reservedAt: Number(raw.reservedAt),
      expiresAt: Number(raw.expiresAt),
      priceMode: Number(raw.priceMode) as 0 | 1,
      status: Number(raw.status) as 0 | 1 | 2 | 3,
      spreadBps: Number(raw.spreadBps),
      protocolFeeBps: Number(raw.protocolFeeBps),
      lp: raw.lp,
      inventoryToken: raw.inventoryToken,
      paymentToken: raw.paymentToken,
      initialAmount: raw.initialAmount,
      remainingAmount: raw.remainingAmount,
      minFillAmount: raw.minFillAmount,
      fixedOrMinPriceX36: raw.fixedOrMinPriceX36,
      maxPriceX36: raw.maxPriceX36,
    });
  }

  return matched.reverse();
}

export interface ProtocolActivityItem {
  id: string;
  type: "OfferCreated" | "TicketReserved" | "TicketExercised";
  txHash: `0x${string}`;
  blockNumber: bigint;
  label: string;
  detail: string;
}

export async function fetchTotalTickets(
  client: Pick<PublicClient, "readContract"> = tranchePublicClient,
  config = ACTIVE_NETWORK,
): Promise<number> {
  if (!config.isLive) return 0;
  const nextTicketId = await client.readContract({
    address: config.contracts.commitmentManager,
    abi: COMMITMENT_MANAGER_ABI,
    functionName: "nextTicketId",
  });
  return Math.max(0, Number(nextTicketId) - 1);
}

export async function fetchRecentActivity(
  client: Pick<PublicClient, "getBlockNumber" | "readContract" | "getLogs"> = tranchePublicClient,
  config = ACTIVE_NETWORK,
): Promise<{
  totalTickets: number;
  items: ProtocolActivityItem[];
}> {
  if (!config.isLive) return { totalTickets: 0, items: [] };
  const { commitmentManager } = config.contracts;
  const [latestBlock, nextTicketId] = await Promise.all([
    client.getBlockNumber(),
    client.readContract({
      address: commitmentManager,
      abi: COMMITMENT_MANAGER_ABI,
      functionName: "nextTicketId",
    }),
  ]);

  const totalTickets = Math.max(0, Number(nextTicketId) - 1);
  // Safe lookback (< 10,000 blocks) required by HashKey Chain RPC eth_getLogs limits
  const fromBlock =
    latestBlock > ACTIVITY_LOOKBACK_BLOCKS ? latestBlock - ACTIVITY_LOOKBACK_BLOCKS : 0n;

  try {
    const [createdLogs, reservedLogs, exercisedLogs] = await Promise.all([
      client.getLogs({
        address: commitmentManager,
        event: ACTIVITY_EVENTS[0],
        fromBlock,
        toBlock: latestBlock,
      }),
      client.getLogs({
        address: commitmentManager,
        event: ACTIVITY_EVENTS[1],
        fromBlock,
        toBlock: latestBlock,
      }),
      client.getLogs({
        address: commitmentManager,
        event: ACTIVITY_EVENTS[2],
        fromBlock,
        toBlock: latestBlock,
      }),
    ]);

    const items: ProtocolActivityItem[] = [
      ...createdLogs.map((l) => ({
        id: `offer-${l.transactionHash}-${l.logIndex}`,
        type: "OfferCreated" as const,
        txHash: l.transactionHash,
        blockNumber: l.blockNumber,
        label: `Offer #${l.args.offerId?.toString() ?? "?"} published`,
        detail: `${Number(l.args.priceMode) === 0 ? "FIXED" : "FLOATING"} · LP ${l.args.lp?.slice(0, 6)}…${l.args.lp?.slice(-4)}`,
      })),
      ...reservedLogs.map((l) => ({
        id: `res-${l.transactionHash}-${l.logIndex}`,
        type: "TicketReserved" as const,
        txHash: l.transactionHash,
        blockNumber: l.blockNumber,
        label: `Ticket #${l.args.ticketId?.toString() ?? "?"} reserved`,
        detail: `Offer #${l.args.offerId?.toString() ?? "?"} · ${l.args.recipient?.slice(0, 6)}…${l.args.recipient?.slice(-4)}`,
      })),
      ...exercisedLogs.map((l) => ({
        id: `ex-${l.transactionHash}-${l.logIndex}`,
        type: "TicketExercised" as const,
        txHash: l.transactionHash,
        blockNumber: l.blockNumber,
        label: `Ticket #${l.args.ticketId?.toString() ?? "?"} settled`,
        detail: `Exercised by ${l.args.exerciser?.slice(0, 6)}…${l.args.exerciser?.slice(-4)}`,
      })),
    ];

    items.sort((a, b) => Number(b.blockNumber - a.blockNumber));
    return { totalTickets, items: items.slice(0, 8) };
  } catch {
    return { totalTickets, items: [] };
  }
}
