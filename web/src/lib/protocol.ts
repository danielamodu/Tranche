import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  fallback,
  http,
  parseAbi,
  type Address,
} from "viem";
import { ACTIVE_NETWORK } from "@/config/networks";
import type { Eip1193Provider } from "@/context/WalletContext";

export const ACTIVE_VIEM_CHAIN = defineChain({
  id: ACTIVE_NETWORK.chainId,
  name: ACTIVE_NETWORK.name,
  nativeCurrency: { name: "HashKey EcoPoints", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: [...ACTIVE_NETWORK.rpcUrls] } },
  blockExplorers: { default: { name: "Blockscout", url: ACTIVE_NETWORK.explorerUrl } },
});

export const tranchePublicClient = createPublicClient({
  chain: ACTIVE_VIEM_CHAIN,
  transport: fallback(ACTIVE_NETWORK.rpcUrls.map((url) => http(url, { timeout: 10_000 }))),
});

export function createTrancheWalletClient(provider: Eip1193Provider, account: Address) {
  return createWalletClient({
    account,
    chain: ACTIVE_VIEM_CHAIN,
    transport: custom(provider),
  });
}

export const COMMITMENT_MANAGER_ABI = parseAbi([
  "function nextOfferId() view returns (uint64)",
  "function nextTicketId() view returns (uint256)",
  "function protocolFeeBps() view returns (uint16)",
  "function offers(uint64 offerId) view returns (address lp, uint40 createdAt, uint40 expiry, uint8 priceMode, uint8 status, address inventoryToken, uint32 minDuration, uint32 maxDuration, uint16 basePremiumBps, uint16 dailyPremiumBps, address paymentToken, int16 spreadBps, uint16 protocolFeeBps, address oracle, address complianceHook, uint256 minFillAmount, uint256 fixedPriceX36, uint256 minPriceX36, uint256 maxPriceX36)",
  "function tickets(uint256 ticketId) view returns (uint64 offerId, uint40 reservedAt, uint40 expiresAt, uint8 priceMode, uint8 status, int16 spreadBps, uint16 protocolFeeBps, address lp, address inventoryToken, address paymentToken, address oracle, address complianceHook, uint256 initialAmount, uint256 remainingAmount, uint256 minFillAmount, uint256 fixedOrMinPriceX36, uint256 maxPriceX36)",
  "function quoteReservation(uint64 offerId, uint256 amount, uint32 duration) view returns (uint256 grossPremium, uint256 protocolFee, uint256 lpNetPremium)",
  "function quoteExercise(uint256 ticketId, uint256 fillAmount) view returns (uint256 effectivePriceX36, uint256 grossPayment, uint256 protocolFee, uint256 lpNetPayment)",
  "function reserve(uint64 offerId, uint256 amount, uint32 duration, uint256 maxPremium, address recipient) returns (uint256 ticketId)",
  "function exercise(uint256 ticketId, uint256 fillAmount, uint256 maxPayment, address receiver) returns (uint256 filled, uint256 paid)",
  "function splitTicket(uint256 ticketId, uint256 splitAmount, address recipient) returns (uint256 childTicketId)",
  "function reclaimExpired(uint256 ticketId)",
  "function createOffer((address inventoryToken, address paymentToken, uint256 initialAmount, uint256 minFillAmount, uint40 expiry, uint32 minDuration, uint32 maxDuration, uint16 basePremiumBps, uint16 dailyPremiumBps, uint8 priceMode, int16 spreadBps, address oracle, address complianceHook, uint256 fixedPriceX36, uint256 minPriceX36, uint256 maxPriceX36) params) returns (uint64 offerId)",
  "function cancelOffer(uint64 offerId)",
]);

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

export async function fetchAllOffers(): Promise<OnChainOffer[]> {
  const { commitmentManager, liquidityVault } = ACTIVE_NETWORK.contracts;
  const nextId = await tranchePublicClient.readContract({
    address: commitmentManager,
    abi: COMMITMENT_MANAGER_ABI,
    functionName: "nextOfferId",
  });

  const count = Number(nextId) - 1;
  if (count <= 0) return [];

  const ids = Array.from({ length: count }, (_, i) => BigInt(i + 1));
  const results = await Promise.all(
    ids.map(async (id) => {
      const [raw, bal] = await Promise.all([
        tranchePublicClient.readContract({
          address: commitmentManager,
          abi: COMMITMENT_MANAGER_ABI,
          functionName: "offers",
          args: [id],
        }),
        tranchePublicClient.readContract({
          address: liquidityVault,
          abi: LIQUIDITY_VAULT_ABI,
          functionName: "offerBalance",
          args: [id],
        }),
      ]);

      return {
        offerId: id,
        lp: raw[0],
        createdAt: Number(raw[1]),
        expiry: Number(raw[2]),
        priceMode: Number(raw[3]) as 0 | 1,
        status: Number(raw[4]) as 0 | 1 | 2,
        inventoryToken: raw[5],
        minDuration: Number(raw[6]),
        maxDuration: Number(raw[7]),
        basePremiumBps: Number(raw[8]),
        dailyPremiumBps: Number(raw[9]),
        paymentToken: raw[10],
        spreadBps: Number(raw[11]),
        protocolFeeBps: Number(raw[12]),
        oracle: raw[13],
        complianceHook: raw[14],
        minFillAmount: raw[15],
        fixedPriceX36: raw[16],
        minPriceX36: raw[17],
        maxPriceX36: raw[18],
        availableBalance: bal,
      } satisfies OnChainOffer;
    }),
  );

  return results.reverse();
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

export async function fetchUserTickets(userAddress: Address): Promise<OnChainTicket[]> {
  const { commitmentManager, executionTicket } = ACTIVE_NETWORK.contracts;
  const nextId = await tranchePublicClient.readContract({
    address: commitmentManager,
    abi: COMMITMENT_MANAGER_ABI,
    functionName: "nextTicketId",
  });

  const count = Number(nextId) - 1;
  if (count <= 0) return [];

  const ids = Array.from({ length: count }, (_, i) => BigInt(i + 1));
  const rawList = await Promise.all(
    ids.map(async (id) => {
      const t = await tranchePublicClient.readContract({
        address: commitmentManager,
        abi: COMMITMENT_MANAGER_ABI,
        functionName: "tickets",
        args: [id],
      });

      let owner: Address | null = null;
      if (Number(t[4]) === 1) {
        try {
          owner = await tranchePublicClient.readContract({
            address: executionTicket,
            abi: EXECUTION_TICKET_ABI,
            functionName: "ownerOf",
            args: [id],
          });
        } catch {
          owner = null;
        }
      }

      return {
        ticketId: id,
        owner,
        offerId: t[0],
        reservedAt: Number(t[1]),
        expiresAt: Number(t[2]),
        priceMode: Number(t[3]) as 0 | 1,
        status: Number(t[4]) as 0 | 1 | 2 | 3,
        spreadBps: Number(t[5]),
        protocolFeeBps: Number(t[6]),
        lp: t[7],
        inventoryToken: t[8],
        paymentToken: t[9],
        initialAmount: t[12],
        remainingAmount: t[13],
        minFillAmount: t[14],
        fixedOrMinPriceX36: t[15],
        maxPriceX36: t[16],
      } satisfies OnChainTicket;
    }),
  );

  const lower = userAddress.toLowerCase();
  return rawList
    .filter((t) => t.owner?.toLowerCase() === lower)
    .reverse();
}

export interface ProtocolActivityItem {
  id: string;
  type: "OfferCreated" | "TicketReserved" | "TicketExercised";
  txHash: `0x${string}`;
  blockNumber: bigint;
  label: string;
  detail: string;
}

const ACTIVITY_EVENTS = parseAbi([
  "event OfferCreated(uint64 indexed offerId, address indexed lp, uint8 priceMode)",
  "event TicketReserved(uint256 indexed ticketId, uint64 indexed offerId, address indexed recipient, uint256 amount, uint40 expiresAt, uint256 grossPremium)",
  "event TicketExercised(uint256 indexed ticketId, uint64 indexed offerId, address indexed exerciser, uint256 fillAmount, uint256 grossPayment, uint256 remainingAmount)",
]);

export async function fetchRecentActivity(): Promise<{
  totalTickets: number;
  items: ProtocolActivityItem[];
}> {
  const { commitmentManager } = ACTIVE_NETWORK.contracts;
  const [latestBlock, nextTicketId] = await Promise.all([
    tranchePublicClient.getBlockNumber(),
    tranchePublicClient.readContract({
      address: commitmentManager,
      abi: COMMITMENT_MANAGER_ABI,
      functionName: "nextTicketId",
    }),
  ]);

  const totalTickets = Math.max(0, Number(nextTicketId) - 1);
  const fromBlock = latestBlock > 60_000n ? latestBlock - 60_000n : 0n;

  try {
    const [createdLogs, reservedLogs, exercisedLogs] = await Promise.all([
      tranchePublicClient.getLogs({
        address: commitmentManager,
        event: ACTIVITY_EVENTS[0],
        fromBlock,
        toBlock: latestBlock,
      }),
      tranchePublicClient.getLogs({
        address: commitmentManager,
        event: ACTIVITY_EVENTS[1],
        fromBlock,
        toBlock: latestBlock,
      }),
      tranchePublicClient.getLogs({
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
        detail: `Offer #${l.args.offerId?.toString() ?? "?"} · Exercised on-chain`,
      })),
    ];

    items.sort((a, b) => Number(b.blockNumber - a.blockNumber));
    return { totalTickets, items: items.slice(0, 8) };
  } catch {
    return { totalTickets, items: [] };
  }
}
