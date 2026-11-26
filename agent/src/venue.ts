import { BPS_DENOMINATOR } from "./hskswap.js";
import type { MarketSnapshot } from "./market.js";
import type { StrategyConfig } from "./strategy.js";

export type SelectedVenue = "TRANCHE" | "HSKSWAP" | "NONE";

export interface RouteCostBreakdown {
  venue: "TRANCHE" | "HSKSWAP";
  eligible: boolean;
  rejectionReasons: string[];
  acquisitionCostPayment: bigint;
  reservationPremiumPayment: bigint; // non-refundable; 0 for HSKSwap
  exercisePayment: bigint; // 0 for HSKSwap
  effectiveUnitCostX36: bigint;
  estimatedExitProceedsPayment: bigint;
  expectedTargetExitPayment: bigint;
  expectedNetProfitAtTargetPayment: bigint;
  offerId?: bigint;
  priceImpactBps?: number;
}

export interface VenueSelectionResult {
  selectedVenue: SelectedVenue;
  rationale: string;
  tranche: RouteCostBreakdown;
  hskswap: RouteCostBreakdown;
}

export interface VenueSelectionConstraints {
  maxAllInCostX36: bigint;
  maxSlippageBps: number;
  minExpectedNetProfitPayment: bigint;
  /** Maximum extra bps over HSKSwap entry allowed for Tranche when bounded downside beats spot stop-loss */
  maxOptionOverheadBps: number;
  /** Optional estimated gas cost in payment units for Tranche (reserve + exercise = 2 txs) */
  trancheGasCostPayment?: bigint;
  /** Optional estimated gas cost in payment units for HSKSwap (1 swap tx) */
  dexGasCostPayment?: bigint;
}

/**
 * Dual-venue economic selector comparing Tranche (inventory-backed reservation + exercise)
 * against HSKSwap V3 (immediate AMM execution) in consistent payment-token units.
 */
export class VenueSelector {
  selectVenue(
    snapshot: MarketSnapshot,
    strategy: StrategyConfig,
    constraints: VenueSelectionConstraints,
  ): VenueSelectionResult {
    const exitNow = snapshot.dexSellQuote?.paymentAmountOut ?? 0n;
    const expectedTargetExit =
      (exitNow * (BPS_DENOMINATOR + BigInt(strategy.takeProfitBps))) / BPS_DENOMINATOR;

    // 1. Evaluate Tranche route
    const trancheRejections: string[] = [];
    const selectedOffer = snapshot.trancheOffers.selected;
    let trancheAcq = 0n;
    let tranchePrem = 0n;
    let trancheEx = 0n;
    let trancheUnitX36 = 0n;

    if (!selectedOffer) {
      const reasons = snapshot.trancheOffers.evaluations
        .flatMap((e) => e.rejectionReasons)
        .slice(0, 4);
      trancheRejections.push(
        reasons.length > 0 ? `NO_ELIGIBLE_OFFER(${reasons.join(",")})` : "NO_ELIGIBLE_OFFER",
      );
    } else {
      tranchePrem = selectedOffer.quotedGrossPremium;
      trancheEx = selectedOffer.quotedExerciseCost;
      trancheAcq = tranchePrem + trancheEx + (constraints.trancheGasCostPayment ?? 0n);
      trancheUnitX36 = selectedOffer.effectiveAllInUnitCostX36;
      if (trancheUnitX36 > constraints.maxAllInCostX36) {
        trancheRejections.push(
          `ALL_IN_COST_EXCEEDS_CAP:${trancheUnitX36}>${constraints.maxAllInCostX36}`,
        );
      }
    }

    if (!snapshot.dexSellQuote) {
      trancheRejections.push("MISSING_EXIT_QUOTE");
    }

    const trancheExpectedNet = expectedTargetExit - trancheAcq;
    if (selectedOffer && trancheExpectedNet < constraints.minExpectedNetProfitPayment) {
      trancheRejections.push(
        `INSUFFICIENT_NET_EDGE:${trancheExpectedNet}<${constraints.minExpectedNetProfitPayment}`,
      );
    }

    const trancheRoute: RouteCostBreakdown = {
      venue: "TRANCHE",
      eligible: trancheRejections.length === 0,
      rejectionReasons: trancheRejections,
      acquisitionCostPayment: trancheAcq,
      reservationPremiumPayment: tranchePrem,
      exercisePayment: trancheEx,
      effectiveUnitCostX36: trancheUnitX36,
      estimatedExitProceedsPayment: exitNow,
      expectedTargetExitPayment: expectedTargetExit,
      expectedNetProfitAtTargetPayment: trancheExpectedNet,
      offerId: selectedOffer?.offerId,
    };

    // 2. Evaluate HSKSwap route
    const dexRejections: string[] = [];
    const buyQuote = snapshot.dexBuyQuote;
    let dexAcq = 0n;
    let dexUnitX36 = 0n;
    let dexImpactBps = 0;

    if (!buyQuote) {
      dexRejections.push("NO_DEX_BUY_QUOTE");
    } else {
      dexAcq = buyQuote.paymentAmountIn + (constraints.dexGasCostPayment ?? 0n);
      dexUnitX36 = buyQuote.effectiveUnitPriceX36;
      dexImpactBps = buyQuote.priceImpactBps;

      if (dexImpactBps > constraints.maxSlippageBps) {
        dexRejections.push(`SLIPPAGE_EXCEEDED:${dexImpactBps}bps>${constraints.maxSlippageBps}bps`);
      }
      if (dexUnitX36 > constraints.maxAllInCostX36) {
        dexRejections.push(`DEX_COST_EXCEEDS_CAP:${dexUnitX36}>${constraints.maxAllInCostX36}`);
      }
    }

    if (!snapshot.dexSellQuote) {
      dexRejections.push("MISSING_EXIT_QUOTE");
    }

    const dexExpectedNet = expectedTargetExit - dexAcq;
    if (buyQuote && dexExpectedNet < constraints.minExpectedNetProfitPayment) {
      dexRejections.push(
        `INSUFFICIENT_NET_EDGE:${dexExpectedNet}<${constraints.minExpectedNetProfitPayment}`,
      );
    }

    const hskswapRoute: RouteCostBreakdown = {
      venue: "HSKSWAP",
      eligible: dexRejections.length === 0,
      rejectionReasons: dexRejections,
      acquisitionCostPayment: dexAcq,
      reservationPremiumPayment: 0n,
      exercisePayment: 0n,
      effectiveUnitCostX36: dexUnitX36,
      estimatedExitProceedsPayment: exitNow,
      expectedTargetExitPayment: expectedTargetExit,
      expectedNetProfitAtTargetPayment: dexExpectedNet,
      priceImpactBps: dexImpactBps,
    };

    // 3. Deterministic venue selection
    if (snapshot.anomalies.length > 0) {
      return {
        selectedVenue: "NONE",
        rationale: `Market observation unhealthy — blocked by anomalies: [${snapshot.anomalies.join("; ")}]`,
        tranche: trancheRoute,
        hskswap: hskswapRoute,
      };
    }

    if (!trancheRoute.eligible && !hskswapRoute.eligible) {
      return {
        selectedVenue: "NONE",
        rationale: `Neither venue eligible. Tranche: [${trancheRejections.join("; ")}]; HSKSwap: [${dexRejections.join("; ")}]`,
        tranche: trancheRoute,
        hskswap: hskswapRoute,
      };
    }

    if (trancheRoute.eligible && !hskswapRoute.eligible) {
      return {
        selectedVenue: "TRANCHE",
        rationale: `Selected Tranche Offer #${trancheRoute.offerId} (all-in ${trancheAcq}) — HSKSwap ineligible: [${dexRejections.join("; ")}]`,
        tranche: trancheRoute,
        hskswap: hskswapRoute,
      };
    }

    if (!trancheRoute.eligible && hskswapRoute.eligible) {
      return {
        selectedVenue: "HSKSWAP",
        rationale: `Selected HSKSwap (cost ${dexAcq}, impact ${dexImpactBps} bps) — Tranche ineligible: [${trancheRejections.join("; ")}]`,
        tranche: trancheRoute,
        hskswap: hskswapRoute,
      };
    }

    // Both eligible: compare direct total acquisition cost first
    if (trancheRoute.acquisitionCostPayment <= hskswapRoute.acquisitionCostPayment) {
      const savings = hskswapRoute.acquisitionCostPayment - trancheRoute.acquisitionCostPayment;
      return {
        selectedVenue: "TRANCHE",
        rationale: `Selected Tranche Offer #${trancheRoute.offerId}: all-in cost (${trancheAcq}) <= HSKSwap (${dexAcq}), saving ${savings} payment units`,
        tranche: trancheRoute,
        hskswap: hskswapRoute,
      };
    }

    // Optional bounded-downside preference in volatility_aware mode:
    // only when non-refundable premium < spot stop-loss loss AND overhead <= maxOptionOverheadBps
    const spotStopLossPayment =
      (dexAcq * BigInt(strategy.stopLossBps)) / BPS_DENOMINATOR;
    const overheadBps =
      dexAcq > 0n
        ? Number(((trancheAcq - dexAcq) * BPS_DENOMINATOR) / dexAcq)
        : Number.MAX_SAFE_INTEGER;

    if (
      strategy.type === "volatility_aware" &&
      tranchePrem < spotStopLossPayment &&
      overheadBps <= constraints.maxOptionOverheadBps
    ) {
      return {
        selectedVenue: "TRANCHE",
        rationale: `Selected Tranche Offer #${trancheRoute.offerId}: bounded reservation premium (${tranchePrem}) < spot stop-loss risk (${spotStopLossPayment}) with ${overheadBps} bps overhead <= ${constraints.maxOptionOverheadBps} bps`,
        tranche: trancheRoute,
        hskswap: hskswapRoute,
      };
    }

    const dexSavings = trancheRoute.acquisitionCostPayment - hskswapRoute.acquisitionCostPayment;
    return {
      selectedVenue: "HSKSWAP",
      rationale: `Selected HSKSwap: immediate acquisition cost (${dexAcq}) < Tranche all-in (${trancheAcq}) by ${dexSavings} payment units`,
      tranche: trancheRoute,
      hskswap: hskswapRoute,
    };
  }
}
