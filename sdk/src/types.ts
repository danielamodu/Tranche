import type { Address, Hex, PublicClient, TransactionReceipt, WalletClient } from "viem";

export enum PriceMode {
  FIXED = 0,
  FLOATING = 1,
}

export enum OfferStatus {
  ACTIVE = 0,
  PAUSED = 1,
  CANCELLED = 2,
}

export enum TicketStatus {
  NONE = 0,
  ACTIVE = 1,
  EXERCISED = 2,
  RECLAIMED = 3,
}

export interface Offer {
  lp: Address;
  createdAt: number;
  expiry: number;
  priceMode: PriceMode;
  status: OfferStatus;
  inventoryToken: Address;
  minDuration: number;
  maxDuration: number;
  basePremiumBps: number;
  dailyPremiumBps: number;
  paymentToken: Address;
  spreadBps: number;
  oracle: Address;
  complianceHook: Address;
  minFillAmount: bigint;
  fixedPriceX36: bigint;
  minPriceX36: bigint;
  maxPriceX36: bigint;
}

export interface DiscoveredOffer extends Offer {
  offerId: bigint;
  availableBalance: bigint;
}

export interface Ticket {
  offerId: bigint;
  reservedAt: number;
  expiresAt: number;
  priceMode: PriceMode;
  status: TicketStatus;
  spreadBps: number;
  lp: Address;
  inventoryToken: Address;
  paymentToken: Address;
  oracle: Address;
  complianceHook: Address;
  initialAmount: bigint;
  remainingAmount: bigint;
  fixedOrMinPriceX36: bigint;
  maxPriceX36: bigint;
}

export interface DiscoveredTicket extends Ticket {
  ticketId: bigint;
  owner: Address | null;
}

export interface CreateOfferParams {
  inventoryToken: Address;
  paymentToken: Address;
  initialAmount: bigint;
  minFillAmount: bigint;
  expiry: number;
  minDuration: number;
  maxDuration: number;
  basePremiumBps: number;
  dailyPremiumBps: number;
  priceMode: PriceMode;
  spreadBps: number;
  oracle: Address;
  complianceHook: Address;
  fixedPriceX36: bigint;
  minPriceX36: bigint;
  maxPriceX36: bigint;
}

export interface ExerciseLeg {
  ticketId: bigint;
  fillAmount: bigint;
  maxLegPaymentIn: bigint;
}

export interface BatchExerciseParams {
  inventoryToken: Address;
  paymentToken: Address;
  minTotalInventoryOut: bigint;
  maxTotalPaymentIn: bigint;
  deadline: bigint;
  receiver: Address;
  unwrapInventoryToNative: boolean;
  legs: ExerciseLeg[];
}

export interface VaultTokenState {
  token: Address;
  totalLpFree: bigint;
  totalOfferAvailable: bigint;
  totalReserved: bigint;
  totalPendingProceeds: bigint;
  protocolFees: bigint;
  lpFreeBalance?: bigint;
  lpPendingProceeds?: bigint;
}

export interface ReservationQuote {
  grossPremium: bigint;
  protocolFee: bigint;
}

export interface ExerciseQuote {
  actualFill: bigint;
  grossPayment: bigint;
  effPriceX36: bigint;
}

export interface OraclePriceQuote {
  priceX36: bigint;
  updatedAt: bigint;
  isValid: boolean;
}

export interface TrancheAddresses {
  liquidityVault: Address;
  commitmentManager: Address;
  executionTicket: Address;
  executionRouter: Address;
  signedPullOracle?: Address;
  oraclePriceAdapter?: Address;
  hspComplianceHook?: Address;
  v3PositionSegregator?: Address;
}

export interface LocalTestAccount {
  index: number;
  role: "admin" | "lp" | "trader1" | "trader2" | "keeper";
  address: Address;
  privateKey: Hex;
  walletClient: WalletClient;
}

export interface TrancheDeployment {
  rpcUrl: string;
  chainId: number;
  addresses: Required<
    Pick<
      TrancheAddresses,
      | "liquidityVault"
      | "commitmentManager"
      | "executionTicket"
      | "executionRouter"
      | "signedPullOracle"
      | "oraclePriceAdapter"
      | "hspComplianceHook"
    >
  > & {
    whsk: Address;
    usdt: Address;
    guardian: Address;
    feeCollector: Address;
    oracleSigner: Address;
    hspAttestationSigner: Address;
  };
  publicClient: PublicClient;
  accounts: {
    admin: LocalTestAccount;
    lp: LocalTestAccount;
    trader1: LocalTestAccount;
    trader2: LocalTestAccount;
    keeper: LocalTestAccount;
  };
}

export interface DecodedTrancheError {
  contract: string;
  errorName: string;
  args: readonly unknown[] | undefined;
  rawMessage: string;
}

export type TxExecutionResult<TExtra extends object = Record<never, never>> = {
  hash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
  receipt: TransactionReceipt;
} & TExtra;
