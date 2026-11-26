import {
  ABIS,
  OfferStatus,
  TicketStatus,
  type DiscoveredOffer,
  type DiscoveredTicket,
  type ExerciseQuote,
  type ReservationQuote,
  type TrancheClient,
} from "@tranche/sdk";
import type { Address, Hex } from "viem";
import { BPS_DENOMINATOR, PRICE_SCALE } from "../hskswap.js";
import {
  PortfolioIntelligenceEngine,
  type PortfolioAllocationDecision,
  type PortfolioConstraints,
  type PortfolioSnapshot,
} from "../portfolio.js";
import type { TransactionReconciler, TxReconciliationResult } from "../reconciler.js";

export interface OfferSummary {
  offerId: bigint;
  lp: Address;
  inventoryToken: Address;
  paymentToken: Address;
  availableBalance: bigint;
  minFillAmount: bigint;
  priceMode: "FIXED" | "FLOATING";
  fixedPriceX36: bigint;
  basePremiumBps: number;
  dailyPremiumBps: number;
  minDurationSec: number;
  maxDurationSec: number;
  expiry: number;
  remainingExpirySec: number;
  active: boolean;
}

export interface TicketSummary {
  ticketId: bigint;
  offerId: bigint;
  owner: Address | null;
  inventoryToken: Address;
  paymentToken: Address;
  initialAmount: bigint;
  remainingAmount: bigint;
  expiresAt: number;
  remainingSeconds: number;
  status: "NONE" | "ACTIVE" | "EXERCISED" | "RECLAIMED";
  isExpired: boolean;
  canExercise: boolean;
  /** Under CommitmentManager ABI, expired unexercised tickets release via reclaimExpired(ticketId). */
  canReclaimExpired: boolean;
}

export interface ProtocolSimulationResult {
  action: "RESERVE_INVENTORY" | "EXERCISE_TICKET" | "RECLAIM_EXPIRED_TICKET";
  ok: boolean;
  estimatedGas?: bigint;
  simulatedReturnValue?: unknown;
  revertReason?: string;
}

export interface ProtocolReceiptVerification {
  reconciliation: TxReconciliationResult;
  onChainStateVerified: boolean;
  verifiedTicket?: TicketSummary | null;
  detail: string;
}

/**
 * Dedicated Tranche Protocol Action Layer.
 *
 * Uses strictly the actual deployed contract interfaces & ABIs (`CommitmentManager`,
 * `LiquidityVault`, `ExecutionTicket` via `@tranche/sdk`).
 *
 * Completely isolated from HSP agentic payments (zero imports or cross-calls).
 */
export class TrancheProtocolActionLayer {
  private readonly client: TrancheClient;
  private readonly portfolioEngine = new PortfolioIntelligenceEngine();
  private readonly reconciler?: TransactionReconciler;
  private readonly nowSec: () => number;

  constructor(config: {
    client: TrancheClient;
    reconciler?: TransactionReconciler;
    nowSec?: () => number;
  }) {
    this.client = config.client;
    this.reconciler = config.reconciler;
    this.nowSec = config.nowSec ?? (() => Math.floor(Date.now() / 1000));
  }

  getAddresses() {
    return { ...this.client.addresses };
  }

  /** 1 & 2. Discover available inventory, active offers, and expiry terms. */
  async discoverActiveOffers(filter?: {
    inventoryToken?: Address;
    paymentToken?: Address;
  }): Promise<OfferSummary[]> {
    const now = this.nowSec();
    const raw = await this.client.discoverOffers();
    return raw
      .map((o) => this.toOfferSummary(o, now))
      .filter((o) => {
        if (!o.active || o.availableBalance <= 0n || o.remainingExpirySec <= 0) return false;
        if (
          filter?.inventoryToken &&
          o.inventoryToken.toLowerCase() !== filter.inventoryToken.toLowerCase()
        ) {
          return false;
        }
        if (
          filter?.paymentToken &&
          o.paymentToken.toLowerCase() !== filter.paymentToken.toLowerCase()
        ) {
          return false;
        }
        return true;
      });
  }

  async getOfferDetails(offerId: bigint): Promise<OfferSummary> {
    const raw = await this.client.getOffer(offerId);
    return this.toOfferSummary(raw, this.nowSec());
  }

  /** 3. Calculate exact reservation premium & protocol fee via CommitmentManager.quoteReservation. */
  async quoteReservation(
    offerId: bigint,
    inventoryAmount: bigint,
    durationSec: number,
  ): Promise<ReservationQuote> {
    return this.client.quoteReservation(offerId, inventoryAmount, durationSec);
  }

  /** 4. Evaluate an offer's available inventory against portfolio constraints. */
  async evaluateOfferAgainstPortfolio(params: {
    offerId: bigint;
    inventoryAmount: bigint;
    durationSec: number;
    expectedTargetExitPayment: bigint;
    portfolioSnapshot: PortfolioSnapshot;
    portfolioConstraints: PortfolioConstraints;
  }): Promise<{
    offer: OfferSummary;
    quote: ReservationQuote;
    estimatedExercisePayment: bigint;
    allocation: PortfolioAllocationDecision;
    inventorySufficient: boolean;
  }> {
    const [offer, quote] = await Promise.all([
      this.getOfferDetails(params.offerId),
      this.quoteReservation(params.offerId, params.inventoryAmount, params.durationSec),
    ]);

    const inventorySufficient =
      offer.active &&
      offer.remainingExpirySec > 0 &&
      offer.availableBalance >= params.inventoryAmount &&
      params.inventoryAmount >= offer.minFillAmount;

    const estimatedExercisePayment =
      offer.fixedPriceX36 > 0n
        ? (params.inventoryAmount * offer.fixedPriceX36) / PRICE_SCALE
        : 0n;
    const totalCost = quote.grossPremium + estimatedExercisePayment;
    const expectedNet =
      params.expectedTargetExitPayment > totalCost
        ? params.expectedTargetExitPayment - totalCost
        : 0n;

    const allocation = this.portfolioEngine.evaluateAllocation({
      snapshot: params.portfolioSnapshot,
      constraints: params.portfolioConstraints,
      request: {
        inventoryToken: offer.inventoryToken,
        requestedAmountInventory: params.inventoryAmount,
        estimatedAcquisitionCostPayment: totalCost,
        expectedNetProfitPayment: expectedNet,
        reservationPremiumPayment: quote.grossPremium,
        minViableAmountInventory: offer.minFillAmount > 0n ? offer.minFillAmount : 1n,
      },
    });

    return {
      offer,
      quote,
      estimatedExercisePayment,
      allocation,
      inventorySufficient,
    };
  }

  /** 5. Simulate CommitmentManager.reserve without broadcasting any transaction. */
  async simulateReservation(params: {
    offerId: bigint;
    amount: bigint;
    durationSec: number;
    maxPremium: bigint;
    recipient: Address;
    account: Address;
  }): Promise<ProtocolSimulationResult> {
    try {
      const sim = await this.client.publicClient.simulateContract({
        account: params.account,
        address: this.client.addresses.commitmentManager,
        abi: ABIS.CommitmentManager,
        functionName: "reserve",
        args: [
          params.offerId,
          params.amount,
          params.durationSec,
          params.maxPremium,
          params.recipient,
        ],
      });
      return {
        action: "RESERVE_INVENTORY",
        ok: true,
        simulatedReturnValue: sim.result,
      };
    } catch (err) {
      return {
        action: "RESERVE_INVENTORY",
        ok: false,
        revertReason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 7. Inspect existing reservation tickets and their lifecycle states. */
  async inspectTickets(ownerFilter?: Address): Promise<TicketSummary[]> {
    const now = this.nowSec();
    const raw = await this.client.discoverTickets();
    return raw
      .map((t) => this.toTicketSummary(t, now))
      .filter((t) => {
        if (!ownerFilter) return true;
        return t.owner !== null && t.owner.toLowerCase() === ownerFilter.toLowerCase();
      });
  }

  async getTicketDetails(ticketId: bigint): Promise<TicketSummary> {
    const raw = await this.client.getTicket(ticketId);
    return this.toTicketSummary(raw, this.nowSec());
  }

  async quoteExercise(ticketId: bigint, fillAmount = 0n): Promise<ExerciseQuote> {
    return this.client.quoteExercise(ticketId, fillAmount);
  }

  /** 8. Simulate CommitmentManager.exercise without broadcasting. */
  async simulateExercise(params: {
    ticketId: bigint;
    fillAmount: bigint;
    maxPayment: bigint;
    receiver: Address;
    account: Address;
  }): Promise<ProtocolSimulationResult> {
    try {
      const sim = await this.client.publicClient.simulateContract({
        account: params.account,
        address: this.client.addresses.commitmentManager,
        abi: ABIS.CommitmentManager,
        functionName: "exercise",
        args: [params.ticketId, params.fillAmount, params.maxPayment, params.receiver],
      });
      return {
        action: "EXERCISE_TICKET",
        ok: true,
        simulatedReturnValue: sim.result,
      };
    } catch (err) {
      return {
        action: "EXERCISE_TICKET",
        ok: false,
        revertReason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 9. Simulate releasing an expired reservation via CommitmentManager.reclaimExpired.
   * Note: Deployed CommitmentManager has no early trader cancelReservation() on active tickets.
   */
  async simulateReclaimExpired(params: {
    ticketId: bigint;
    account: Address;
  }): Promise<ProtocolSimulationResult> {
    const ticket = await this.getTicketDetails(params.ticketId);
    if (!ticket.canReclaimExpired) {
      return {
        action: "RECLAIM_EXPIRED_TICKET",
        ok: false,
        revertReason:
          ticket.status === "ACTIVE" && !ticket.isExpired
            ? "NOT_EXPIRED_ACTIVE_TICKETS_CANNOT_BE_CANCELLED_EARLY"
            : `TICKET_NOT_RECLAIMABLE(status=${ticket.status})`,
      };
    }
    try {
      const sim = await this.client.publicClient.simulateContract({
        account: params.account,
        address: this.client.addresses.commitmentManager,
        abi: ABIS.CommitmentManager,
        functionName: "reclaimExpired",
        args: [params.ticketId],
      });
      return {
        action: "RECLAIM_EXPIRED_TICKET",
        ok: true,
        simulatedReturnValue: sim.result,
      };
    } catch (err) {
      return {
        action: "RECLAIM_EXPIRED_TICKET",
        ok: false,
        revertReason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 10. Reconcile tx receipt AND verify resulting on-chain ticket state. */
  async reconcileAndVerifyTicketTx(params: {
    pendingTxId: string;
    txHash: Hex;
    chainId?: number;
    expectedTicketId?: bigint;
  }): Promise<ProtocolReceiptVerification> {
    if (!this.reconciler) {
      return {
        reconciliation: {
          pendingTxId: params.pendingTxId,
          status: "UNCERTAIN",
          canClearPending: false,
          reason: "No TransactionReconciler configured",
        },
        onChainStateVerified: false,
        detail: "Cannot verify transaction without TransactionReconciler",
      };
    }

    const reconciliation = await this.reconciler.reconcile({
      id: params.pendingTxId,
      decisionKey: `protocol:${params.pendingTxId}`,
      action: "RESERVE_TRANCHE",
      createdAt: this.nowSec(),
      status: "IN_FLIGHT",
      txHash: params.txHash,
      chainId: params.chainId,
    });

    if (reconciliation.status !== "CONFIRMED") {
      return {
        reconciliation,
        onChainStateVerified: false,
        detail: `Transaction not confirmed (status=${reconciliation.status}): ${reconciliation.reason}`,
      };
    }

    if (params.expectedTicketId !== undefined) {
      try {
        const ticket = await this.getTicketDetails(params.expectedTicketId);
        return {
          reconciliation,
          onChainStateVerified: true,
          verifiedTicket: ticket,
          detail: `Confirmed in block ${reconciliation.blockNumber}; verified Ticket #${ticket.ticketId} (status=${ticket.status})`,
        };
      } catch (err) {
        return {
          reconciliation,
          onChainStateVerified: false,
          detail: `Receipt confirmed but on-chain ticket read failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    return {
      reconciliation,
      onChainStateVerified: true,
      detail: `Confirmed in block ${reconciliation.blockNumber}`,
    };
  }

  private toOfferSummary(o: DiscoveredOffer, nowSec: number): OfferSummary {
    const expiry = Number(o.expiry);
    return {
      offerId: o.offerId,
      lp: o.lp,
      inventoryToken: o.inventoryToken,
      paymentToken: o.paymentToken,
      availableBalance: o.availableBalance,
      minFillAmount: o.minFillAmount,
      priceMode: Number(o.priceMode) === 0 ? "FIXED" : "FLOATING",
      fixedPriceX36: o.fixedPriceX36,
      basePremiumBps: Number(o.basePremiumBps),
      dailyPremiumBps: Number(o.dailyPremiumBps),
      minDurationSec: Number(o.minDuration),
      maxDurationSec: Number(o.maxDuration),
      expiry,
      remainingExpirySec: Math.max(0, expiry - nowSec),
      active: Number(o.status) === OfferStatus.ACTIVE,
    };
  }

  private toTicketSummary(t: DiscoveredTicket, nowSec: number): TicketSummary {
    const statusNum = Number(t.status);
    const statusMap: Record<number, TicketSummary["status"]> = {
      [TicketStatus.NONE]: "NONE",
      [TicketStatus.ACTIVE]: "ACTIVE",
      [TicketStatus.EXERCISED]: "EXERCISED",
      [TicketStatus.RECLAIMED]: "RECLAIMED",
    };
    const status = statusMap[statusNum] ?? "NONE";
    const expiresAt = Number(t.expiresAt);
    const remainingSeconds = expiresAt - nowSec;
    const isExpired = remainingSeconds <= 0;
    return {
      ticketId: t.ticketId,
      offerId: t.offerId,
      owner: t.owner,
      inventoryToken: t.inventoryToken,
      paymentToken: t.paymentToken,
      initialAmount: t.initialAmount,
      remainingAmount: t.remainingAmount,
      expiresAt,
      remainingSeconds,
      status,
      isExpired,
      canExercise: status === "ACTIVE" && !isExpired && t.remainingAmount > 0n,
      canReclaimExpired: status === "ACTIVE" && isExpired && t.remainingAmount > 0n,
    };
  }
}

export { BPS_DENOMINATOR };
