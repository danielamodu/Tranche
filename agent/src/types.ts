import type { DecodedTrancheError, DiscoveredOffer, PriceMode, TxExecutionResult } from "@tranche/sdk";
import type { Address, Hex } from "viem";

export interface AgentIntent {
  inventoryToken: Address;
  paymentToken: Address;
  targetAmount: bigint;
  desiredDuration: number;
  maxAllInCostX36: bigint;
  preferredMode?: PriceMode;
  minRemainingOfferExpirySec?: number;
}

export interface OfferEvaluation {
  offerId: bigint;
  eligible: boolean;
  rejectionReasons: string[];
  priceMode: PriceMode;
  availableCapacity: bigint;
  quotedGrossPremium: bigint;
  quotedExerciseCost: bigint;
  effectiveAllInUnitCostX36: bigint;
  expiresAt: number;
}

export interface EvaluateOffersResult {
  timestamp: number;
  discoveredOffers: DiscoveredOffer[];
  selected: OfferEvaluation | null;
  evaluations: OfferEvaluation[];
}

export interface ReserveBestOfferResult {
  ticketId: bigint;
  evaluation: OfferEvaluation;
  tx: TxExecutionResult<{ ticketId: bigint; expiresAt: number; grossPremium: bigint }>;
}

export interface ExerciseTicketResult {
  ticketId: bigint;
  fillAmountRequested: bigint;
  actualFill: bigint;
  grossPayment: bigint;
  effPriceX36: bigint;
  remainingAfter: bigint;
  tx: TxExecutionResult<{ actualFill: bigint; grossPayment: bigint; effPriceX36: bigint }>;
}

export interface ReclaimTicketResult {
  reclaimed: boolean;
  ticketId: bigint;
  releasedAmount: bigint;
  reason?: string;
  tx?: TxExecutionResult;
}

export interface DecodedAgentFailure {
  action: "evaluateOffers" | "reserveBestOffer" | "exerciseTicket" | "reclaimIfExpired";
  timestamp: number;
  targetId?: bigint;
  errorName: string;
  contract: string;
  message: string;
  decoded?: DecodedTrancheError;
}

export interface ReservationTraceRecord {
  offerId: bigint;
  ticketId: bigint;
  recipient: Address;
  inventoryAmount: bigint;
  duration: number;
  grossPremium: bigint;
  effectiveAllInUnitCostX36: bigint;
  expiresAt: number;
  txHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
}

export interface ExerciseTraceRecord {
  ticketId: bigint;
  fillAmountRequested: bigint;
  actualFill: bigint;
  grossPayment: bigint;
  effPriceX36: bigint;
  remainingAfter: bigint;
  receiver: Address;
  txHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
}

export interface ReclaimTraceRecord {
  ticketId: bigint;
  releasedAmount: bigint;
  txHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
}

export interface AgentDecisionTrace {
  intent: AgentIntent | null;
  evaluatedAt: number | null;
  discoveredOfferIds: bigint[];
  evaluations: OfferEvaluation[];
  chosenOfferId: bigint | null;
  reservations: ReservationTraceRecord[];
  exercises: ExerciseTraceRecord[];
  reclaims: ReclaimTraceRecord[];
  failures: DecodedAgentFailure[];
}
