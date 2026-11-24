import {
  OfferStatus,
  PriceMode,
  TicketStatus,
  decodeTrancheError,
  type DecodedTrancheError,
  type DiscoveredOffer,
  type TrancheClient,
} from "@tranche/sdk";
import type { Address } from "viem";
import type {
  AgentDecisionTrace,
  AgentIntent,
  DecodedAgentFailure,
  EvaluateOffersResult,
  ExerciseTicketResult,
  OfferEvaluation,
  ReclaimTicketResult,
  ReserveBestOfferResult,
} from "./types.js";

const PRICE_SCALE = 10n ** 36n;
const BPS_DENOMINATOR = 10_000n;

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("Denominator must be positive.");
  }
  if (numerator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export class TrancheAgentError extends Error {
  public readonly errorName: string;
  public readonly contract: string;
  public readonly decoded?: DecodedTrancheError;

  constructor(
    errorName: string,
    contract: string,
    message: string,
    decoded?: DecodedTrancheError,
  ) {
    super(message);
    this.name = "TrancheAgentError";
    this.errorName = errorName;
    this.contract = contract;
    this.decoded = decoded;
  }
}

export class TrancheExecutionAgent {
  public readonly client: TrancheClient;

  private readonly trace: AgentDecisionTrace = {
    intent: null,
    evaluatedAt: null,
    discoveredOfferIds: [],
    evaluations: [],
    chosenOfferId: null,
    reservations: [],
    exercises: [],
    reclaims: [],
    failures: [],
  };

  constructor(client: TrancheClient) {
    this.client = client;
  }

  public getDecisionTrace(): AgentDecisionTrace {
    return {
      ...this.trace,
      discoveredOfferIds: [...this.trace.discoveredOfferIds],
      evaluations: this.trace.evaluations.map((e) => ({
        ...e,
        rejectionReasons: [...e.rejectionReasons],
      })),
      reservations: [...this.trace.reservations],
      exercises: [...this.trace.exercises],
      reclaims: [...this.trace.reclaims],
      failures: [...this.trace.failures],
    };
  }

  private async resolveTimestamp(currentTimestamp?: number): Promise<number> {
    if (currentTimestamp !== undefined) return currentTimestamp;
    const block = await this.client.publicClient.getBlock({ blockTag: "latest" });
    return Number(block.timestamp);
  }

  private recordFailure(failure: DecodedAgentFailure): void {
    this.trace.failures.push(failure);
  }

  private toAgentError(
    action: DecodedAgentFailure["action"],
    timestamp: number,
    err: unknown,
    targetId?: bigint,
  ): TrancheAgentError {
    if (err instanceof TrancheAgentError) {
      return err;
    }
    const decoded = decodeTrancheError(err);
    const message = `${action} failed (${decoded.contract}.${decoded.errorName}): ${decoded.rawMessage}`;
    this.recordFailure({
      action,
      timestamp,
      targetId,
      errorName: decoded.errorName,
      contract: decoded.contract,
      message,
      decoded,
    });
    return new TrancheAgentError(decoded.errorName, decoded.contract, message, decoded);
  }

  private async evaluateSingleOffer(
    offer: DiscoveredOffer,
    intent: AgentIntent,
    currentTimestamp: number,
  ): Promise<OfferEvaluation> {
    const rejectionReasons: string[] = [];
    const priceMode = Number(offer.priceMode) as PriceMode;
    const status = Number(offer.status) as OfferStatus;
    const expiresAt = Number(offer.expiry);

    if (status !== OfferStatus.ACTIVE) {
      rejectionReasons.push(`OfferNotActive(status=${OfferStatus[status] ?? String(status)})`);
    }

    if (currentTimestamp >= expiresAt) {
      rejectionReasons.push("OfferExpired");
    } else if (
      intent.minRemainingOfferExpirySec !== undefined &&
      expiresAt - currentTimestamp < intent.minRemainingOfferExpirySec
    ) {
      rejectionReasons.push(
        `InsufficientRemainingOfferExpiry(remaining=${expiresAt - currentTimestamp}s,required=${intent.minRemainingOfferExpirySec}s)`,
      );
    }

    if (
      !sameAddress(offer.inventoryToken, intent.inventoryToken) ||
      !sameAddress(offer.paymentToken, intent.paymentToken)
    ) {
      rejectionReasons.push("TokenPairMismatch");
    }

    if (intent.targetAmount <= 0n) {
      rejectionReasons.push("ZeroTargetAmount");
    } else if (intent.targetAmount < offer.minFillAmount) {
      rejectionReasons.push(
        `BelowMinFillAmount(target=${intent.targetAmount},minFill=${offer.minFillAmount})`,
      );
    }

    if (offer.availableBalance < intent.targetAmount) {
      rejectionReasons.push(
        `InsufficientOfferBalance(available=${offer.availableBalance},target=${intent.targetAmount})`,
      );
    }

    const minDuration = Number(offer.minDuration);
    const maxDuration = Number(offer.maxDuration);
    if (intent.desiredDuration < minDuration || intent.desiredDuration > maxDuration) {
      rejectionReasons.push(
        `InvalidDurationBounds(desired=${intent.desiredDuration},min=${minDuration},max=${maxDuration})`,
      );
    }

    let quotedGrossPremium = 0n;
    let quotedExerciseCost = 0n;
    let effectiveAllInUnitCostX36 = 0n;

    if (rejectionReasons.length === 0) {
      try {
        const resQuote = await this.client.quoteReservation(
          offer.offerId,
          intent.targetAmount,
          intent.desiredDuration,
        );
        quotedGrossPremium = resQuote.grossPremium;

        let effPriceX36: bigint;
        if (priceMode === PriceMode.FIXED) {
          effPriceX36 = offer.fixedPriceX36;
          if (effPriceX36 <= 0n) {
            rejectionReasons.push("InvalidPriceParams");
          }
        } else {
          const oracleQuote = await this.client.getOracleQuote(
            offer.inventoryToken,
            offer.paymentToken,
            offer.oracle,
          );
          if (!oracleQuote.isValid || oracleQuote.priceX36 === 0n) {
            rejectionReasons.push("OracleUnavailable");
            effPriceX36 = 0n;
          } else {
            const factor = BPS_DENOMINATOR + BigInt(offer.spreadBps);
            effPriceX36 = ceilDiv(oracleQuote.priceX36 * factor, BPS_DENOMINATOR);
            if (offer.minPriceX36 > 0n && effPriceX36 < offer.minPriceX36) {
              effPriceX36 = offer.minPriceX36;
            }
            if (offer.maxPriceX36 > 0n && effPriceX36 > offer.maxPriceX36) {
              effPriceX36 = offer.maxPriceX36;
            }
          }
        }

        if (rejectionReasons.length === 0) {
          quotedExerciseCost = ceilDiv(intent.targetAmount * effPriceX36, PRICE_SCALE);
          const totalAllInCost = quotedGrossPremium + quotedExerciseCost;
          effectiveAllInUnitCostX36 = ceilDiv(totalAllInCost * PRICE_SCALE, intent.targetAmount);
        }
      } catch (err) {
        const decoded = decodeTrancheError(err);
        rejectionReasons.push(decoded.errorName);
        this.recordFailure({
          action: "evaluateOffers",
          timestamp: currentTimestamp,
          targetId: offer.offerId,
          errorName: decoded.errorName,
          contract: decoded.contract,
          message: `Quote failed for offer ${offer.offerId}: ${decoded.errorName}`,
          decoded,
        });
      }
    }

    return {
      offerId: offer.offerId,
      eligible: rejectionReasons.length === 0,
      rejectionReasons,
      priceMode,
      availableCapacity: offer.availableBalance,
      quotedGrossPremium,
      quotedExerciseCost,
      effectiveAllInUnitCostX36,
      expiresAt,
    };
  }

  /**
   * Discovers on-chain offers, filters ineligible offers against the intent policy,
   * and deterministically ranks eligible offers by lowest effective all-in unit cost.
   */
  public async evaluateOffers(
    intent: AgentIntent,
    currentTimestamp?: number,
  ): Promise<EvaluateOffersResult> {
    const timestamp = await this.resolveTimestamp(currentTimestamp);
    const discoveredOffers = await this.client.discoverOffers();

    const rawEvaluations = await Promise.all(
      discoveredOffers.map((offer) => this.evaluateSingleOffer(offer, intent, timestamp)),
    );

    const eligible = rawEvaluations.filter((e) => e.eligible);
    const ineligible = rawEvaluations.filter((e) => !e.eligible);

    eligible.sort((a, b) => {
      if (a.effectiveAllInUnitCostX36 !== b.effectiveAllInUnitCostX36) {
        return a.effectiveAllInUnitCostX36 < b.effectiveAllInUnitCostX36 ? -1 : 1;
      }
      if (intent.preferredMode !== undefined && a.priceMode !== b.priceMode) {
        if (a.priceMode === intent.preferredMode) return -1;
        if (b.priceMode === intent.preferredMode) return 1;
      }
      return a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0;
    });

    ineligible.sort((a, b) => (a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0));

    const evaluations = [...eligible, ...ineligible];
    const selected = eligible[0] ?? null;

    this.trace.intent = intent;
    this.trace.evaluatedAt = timestamp;
    this.trace.discoveredOfferIds = discoveredOffers.map((o) => o.offerId);
    this.trace.evaluations = evaluations;
    this.trace.chosenOfferId = selected ? selected.offerId : null;

    return {
      timestamp,
      discoveredOffers,
      selected,
      evaluations,
    };
  }

  /**
   * Evaluates all offers, selects the lowest-cost eligible offer, enforces maxAllInCostX36,
   * and executes the on-chain reservation.
   */
  public async reserveBestOffer(
    intent: AgentIntent,
    recipient: Address,
    currentTimestamp?: number,
  ): Promise<ReserveBestOfferResult> {
    const { timestamp, selected, evaluations } = await this.evaluateOffers(intent, currentTimestamp);

    if (!selected) {
      const summary = evaluations
        .map((e) => `offer#${e.offerId}:[${e.rejectionReasons.join(",")}]`)
        .join("; ");
      const message = `No eligible offer found for intent (${summary || "no offers discovered"}).`;
      this.recordFailure({
        action: "reserveBestOffer",
        timestamp,
        errorName: "NoEligibleOffer",
        contract: "TrancheExecutionAgent",
        message,
      });
      throw new TrancheAgentError("NoEligibleOffer", "TrancheExecutionAgent", message);
    }

    if (selected.effectiveAllInUnitCostX36 > intent.maxAllInCostX36) {
      const message =
        `Best offer #${selected.offerId} effectiveAllInUnitCostX36 ` +
        `(${selected.effectiveAllInUnitCostX36}) exceeds maxAllInCostX36 (${intent.maxAllInCostX36}).`;
      this.recordFailure({
        action: "reserveBestOffer",
        timestamp,
        targetId: selected.offerId,
        errorName: "MaxAllInCostExceeded",
        contract: "TrancheExecutionAgent",
        message,
      });
      throw new TrancheAgentError("MaxAllInCostExceeded", "TrancheExecutionAgent", message);
    }

    try {
      const tx = await this.client.reserve(
        selected.offerId,
        intent.targetAmount,
        intent.desiredDuration,
        selected.quotedGrossPremium,
        recipient,
      );

      this.trace.reservations.push({
        offerId: selected.offerId,
        ticketId: tx.ticketId,
        recipient,
        inventoryAmount: intent.targetAmount,
        duration: intent.desiredDuration,
        grossPremium: tx.grossPremium,
        effectiveAllInUnitCostX36: selected.effectiveAllInUnitCostX36,
        expiresAt: tx.expiresAt,
        txHash: tx.hash,
        blockNumber: tx.blockNumber,
        gasUsed: tx.gasUsed,
      });

      return {
        ticketId: tx.ticketId,
        evaluation: selected,
        tx,
      };
    } catch (err) {
      throw this.toAgentError("reserveBestOffer", timestamp, err, selected.offerId);
    }
  }

  /**
   * Inspects ticket state and quotes exercise cost, validates expiry and remaining amount,
   * executes partial (fillAmount > 0n) or full (fillAmount === 0n) exercise, and decodes any failures.
   */
  public async exerciseTicket(
    ticketId: bigint,
    fillAmount: bigint,
    maxPaymentIn: bigint,
    receiver: Address,
    currentTimestamp?: number,
  ): Promise<ExerciseTicketResult> {
    const timestamp = await this.resolveTimestamp(currentTimestamp);
    const ticket = await this.client.getTicket(ticketId);
    const status = Number(ticket.status) as TicketStatus;

    if (status !== TicketStatus.ACTIVE) {
      const message = `Ticket #${ticketId} is not active (status=${TicketStatus[status] ?? String(status)}).`;
      this.recordFailure({
        action: "exerciseTicket",
        timestamp,
        targetId: ticketId,
        errorName: "TicketNotActive",
        contract: "CommitmentManager",
        message,
      });
      throw new TrancheAgentError("TicketNotActive", "CommitmentManager", message);
    }

    const expiresAt = Number(ticket.expiresAt);
    if (timestamp > expiresAt) {
      const message = `Ticket #${ticketId} expired at ${expiresAt} (now=${timestamp}).`;
      this.recordFailure({
        action: "exerciseTicket",
        timestamp,
        targetId: ticketId,
        errorName: "TicketExpired",
        contract: "CommitmentManager",
        message,
      });
      throw new TrancheAgentError("TicketExpired", "CommitmentManager", message);
    }

    if (fillAmount > ticket.remainingAmount) {
      const message = `Requested fillAmount (${fillAmount}) exceeds ticket #${ticketId} remainingAmount (${ticket.remainingAmount}).`;
      this.recordFailure({
        action: "exerciseTicket",
        timestamp,
        targetId: ticketId,
        errorName: "InvalidFillAmount",
        contract: "CommitmentManager",
        message,
      });
      throw new TrancheAgentError("InvalidFillAmount", "CommitmentManager", message);
    }

    try {
      const quote = await this.client.quoteExercise(ticketId, fillAmount);
      if (quote.grossPayment > maxPaymentIn) {
        const message = `Quoted payment (${quote.grossPayment}) exceeds maxPaymentIn (${maxPaymentIn}) for ticket #${ticketId}.`;
        this.recordFailure({
          action: "exerciseTicket",
          timestamp,
          targetId: ticketId,
          errorName: "SlippageExceeded",
          contract: "CommitmentManager",
          message,
        });
        throw new TrancheAgentError("SlippageExceeded", "CommitmentManager", message);
      }

      const tx = await this.client.exercise(ticketId, fillAmount, maxPaymentIn, receiver);
      const remainingAfter = ticket.remainingAmount - tx.actualFill;

      this.trace.exercises.push({
        ticketId,
        fillAmountRequested: fillAmount,
        actualFill: tx.actualFill,
        grossPayment: tx.grossPayment,
        effPriceX36: tx.effPriceX36,
        remainingAfter,
        receiver,
        txHash: tx.hash,
        blockNumber: tx.blockNumber,
        gasUsed: tx.gasUsed,
      });

      return {
        ticketId,
        fillAmountRequested: fillAmount,
        actualFill: tx.actualFill,
        grossPayment: tx.grossPayment,
        effPriceX36: tx.effPriceX36,
        remainingAfter,
        tx,
      };
    } catch (err) {
      throw this.toAgentError("exerciseTicket", timestamp, err, ticketId);
    }
  }

  /**
   * Reclaims an expired active ticket's remaining locked capacity back to the LP offer (or free balance).
   */
  public async reclaimIfExpired(
    ticketId: bigint,
    currentTimestamp?: number,
  ): Promise<ReclaimTicketResult> {
    const timestamp = await this.resolveTimestamp(currentTimestamp);
    const ticket = await this.client.getTicket(ticketId);
    const status = Number(ticket.status) as TicketStatus;
    const expiresAt = Number(ticket.expiresAt);

    if (status !== TicketStatus.ACTIVE) {
      return {
        reclaimed: false,
        ticketId,
        releasedAmount: 0n,
        reason: `TicketNotActive(status=${TicketStatus[status] ?? String(status)})`,
      };
    }

    if (timestamp <= expiresAt) {
      return {
        reclaimed: false,
        ticketId,
        releasedAmount: 0n,
        reason: `TicketNotExpired(expiresAt=${expiresAt},now=${timestamp})`,
      };
    }

    try {
      const tx = await this.client.reclaimExpired(ticketId);
      this.trace.reclaims.push({
        ticketId,
        releasedAmount: ticket.remainingAmount,
        txHash: tx.hash,
        blockNumber: tx.blockNumber,
        gasUsed: tx.gasUsed,
      });

      return {
        reclaimed: true,
        ticketId,
        releasedAmount: ticket.remainingAmount,
        tx,
      };
    } catch (err) {
      throw this.toAgentError("reclaimIfExpired", timestamp, err, ticketId);
    }
  }
}
