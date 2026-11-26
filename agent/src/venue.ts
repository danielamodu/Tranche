import { BPS_DENOMINATOR } from "./hskswap.js";
import type { MarketRegime, MarketSnapshot } from "./market.js";
import type { StrategyConfig } from "./strategy.js";

export type SelectedVenue = "TRANCHE" | "HSKSWAP" | "NONE";

export interface VenueFailureStats {
  attempts: number;
  failures: number;
}

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
  /** Extended cross-venue cost & quality evidence */
  entryGasCostPayment?: bigint;
  exitGasCostPayment?: bigint;
  estimatedExitCostPayment?: bigint;
  completeRoundTripCostPayment?: bigint;
  quoteAgeSec?: number;
  availableLiquidity?: bigint;
  failureRateBps?: number | null;
}

export interface VenueDecisionEvidence {
  timestamp: number;
  marketRegime: MarketRegime;
  quoteAgeSec: number;
  trancheCompleteCostPayment: bigint;
  hskswapCompleteCostPayment: bigint;
  costAdvantagePayment: bigint;
  costAdvantageBps: number;
  trancheFailureRateBps: number | null;
  hskswapFailureRateBps: number | null;
  factors: string[];
}

export interface VenueSelectionResult {
  selectedVenue: SelectedVenue;
  rationale: string;
  tranche: RouteCostBreakdown;
  hskswap: RouteCostBreakdown;
  evidence?: VenueDecisionEvidence;
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
  /** Optional estimated exit gas cost in payment units (unwinding spot position on HSKSwap) */
  dexExitGasCostPayment?: bigint;
  /** Optional maximum acceptable quote age in seconds (blocks stale quotes when provided) */
  maxQuoteAgeSec?: number;
  /** Optional historical venue execution failure stats (only used when attempts >= 3) */
  venueFailureStats?: Partial<Record<"TRANCHE" | "HSKSWAP", VenueFailureStats>>;
  /** Optional max acceptable measurable failure rate in bps (default 4000 = 40%) */
  maxVenueFailureRateBps?: number;
}

function computeFailureRateBps(stats?: VenueFailureStats): number | null {
  if (!stats || stats.attempts < 3) return null;
  return Math.round((stats.failures * Number(BPS_DENOMINATOR)) / stats.attempts);
}

/**
 * Dual-venue economic selector comparing Tranche (inventory-backed reservation + exercise)
 * against HSKSwap V3 (immediate AMM execution) across complete execution costs:
 * entry cost, reservation premium, slippage, entry & exit gas, expected exit costs,
 * quote freshness, liquidity, and measurable historical failure probability.
 */
export class VenueSelector {
  selectVenue(
    snapshot: MarketSnapshot,
    strategy: StrategyConfig,
    constraints: VenueSelectionConstraints,
  ): VenueSelectionResult {
    const exitNow = snapshot.dexSellQuote?.paymentAmountOut ?? 0n;
    const exitGas = constraints.dexExitGasCostPayment ?? 0n;
    const expectedTargetExitRaw =
      (exitNow * (BPS_DENOMINATOR + BigInt(strategy.takeProfitBps))) / BPS_DENOMINATOR;
    const expectedTargetExit =
      expectedTargetExitRaw > exitGas ? expectedTargetExitRaw - exitGas : 0n;

    const quoteAgeSec = Math.max(0, snapshot.timestamp - snapshot.pool.timestamp);
    const quoteStale =
      constraints.maxQuoteAgeSec !== undefined && quoteAgeSec > constraints.maxQuoteAgeSec;

    const maxFailBps = constraints.maxVenueFailureRateBps ?? 4000;
    const trancheFailureRateBps = computeFailureRateBps(constraints.venueFailureStats?.TRANCHE);
    const hskswapFailureRateBps = computeFailureRateBps(constraints.venueFailureStats?.HSKSWAP);

    // Estimate exit slippage cost from sell quote impact
    const exitImpactBps = snapshot.dexSellQuote?.priceImpactBps ?? 0;
    const estimatedExitSlippagePayment =
      exitNow > 0n ? (exitNow * BigInt(exitImpactBps)) / BPS_DENOMINATOR : 0n;
    const estimatedExitCostPayment = estimatedExitSlippagePayment + exitGas;

    // 1. Evaluate Tranche route
    const trancheRejections: string[] = [];
    const selectedOffer = snapshot.trancheOffers.selected;
    const trancheEntryGas = constraints.trancheGasCostPayment ?? 0n;
    let trancheAcq = 0n;
    let tranchePrem = 0n;
    let trancheEx = 0n;
    let trancheUnitX36 = 0n;

    if (quoteStale) {
      trancheRejections.push(`STALE_QUOTE:${quoteAgeSec}s>${constraints.maxQuoteAgeSec}s`);
    }
    if (trancheFailureRateBps !== null && trancheFailureRateBps > maxFailBps) {
      trancheRejections.push(`HIGH_FAILURE_RATE:${trancheFailureRateBps}bps>${maxFailBps}bps`);
    }

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
      trancheAcq = tranchePrem + trancheEx + trancheEntryGas;
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

    const trancheCompleteCost = trancheAcq + estimatedExitCostPayment;
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
      entryGasCostPayment: trancheEntryGas,
      exitGasCostPayment: exitGas,
      estimatedExitCostPayment,
      completeRoundTripCostPayment: trancheCompleteCost,
      quoteAgeSec,
      availableLiquidity: selectedOffer ? snapshot.targetAmount : 0n,
      failureRateBps: trancheFailureRateBps,
    };

    // 2. Evaluate HSKSwap route
    const dexRejections: string[] = [];
    const buyQuote = snapshot.dexBuyQuote;
    const dexEntryGas = constraints.dexGasCostPayment ?? 0n;
    let dexAcq = 0n;
    let dexUnitX36 = 0n;
    let dexImpactBps = 0;

    if (quoteStale) {
      dexRejections.push(`STALE_QUOTE:${quoteAgeSec}s>${constraints.maxQuoteAgeSec}s`);
    }
    if (hskswapFailureRateBps !== null && hskswapFailureRateBps > maxFailBps) {
      dexRejections.push(`HIGH_FAILURE_RATE:${hskswapFailureRateBps}bps>${maxFailBps}bps`);
    }

    if (!buyQuote) {
      dexRejections.push("NO_DEX_BUY_QUOTE");
    } else {
      dexAcq = buyQuote.paymentAmountIn + dexEntryGas;
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

    const hskswapCompleteCost = dexAcq + estimatedExitCostPayment;
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
      entryGasCostPayment: dexEntryGas,
      exitGasCostPayment: exitGas,
      estimatedExitCostPayment,
      completeRoundTripCostPayment: hskswapCompleteCost,
      quoteAgeSec,
      availableLiquidity: snapshot.pool.liquidity,
      failureRateBps: hskswapFailureRateBps,
    };

    const buildEvidence = (selected: SelectedVenue, factors: string[]): VenueDecisionEvidence => {
      const advantage =
        selected === "TRANCHE" && dexAcq > 0n
          ? hskswapCompleteCost - trancheCompleteCost
          : selected === "HSKSWAP" && trancheAcq > 0n
            ? trancheCompleteCost - hskswapCompleteCost
            : 0n;
      const baseCost =
        selected === "TRANCHE"
          ? hskswapCompleteCost
          : selected === "HSKSWAP"
            ? trancheCompleteCost
            : 0n;
      const advantageBps =
        baseCost > 0n ? Number((advantage * BPS_DENOMINATOR) / baseCost) : 0;

      return {
        timestamp: snapshot.timestamp,
        marketRegime: snapshot.marketRegime,
        quoteAgeSec,
        trancheCompleteCostPayment: trancheCompleteCost,
        hskswapCompleteCostPayment: hskswapCompleteCost,
        costAdvantagePayment: advantage,
        costAdvantageBps: advantageBps,
        trancheFailureRateBps,
        hskswapFailureRateBps,
        factors,
      };
    };

    // 3. Deterministic venue selection
    if (snapshot.anomalies.length > 0) {
      return {
        selectedVenue: "NONE",
        rationale: `Market observation unhealthy — blocked by anomalies: [${snapshot.anomalies.join("; ")}]`,
        tranche: trancheRoute,
        hskswap: hskswapRoute,
        evidence: buildEvidence("NONE", [`anomalies=${snapshot.anomalies.length}`]),
      };
    }

    if (!trancheRoute.eligible && !hskswapRoute.eligible) {
      return {
        selectedVenue: "NONE",
        rationale: `Neither venue eligible. Tranche: [${trancheRejections.join("; ")}]; HSKSwap: [${dexRejections.join("; ")}]`,
        tranche: trancheRoute,
        hskswap: hskswapRoute,
        evidence: buildEvidence("NONE", ["both_venues_ineligible"]),
      };
    }

    if (trancheRoute.eligible && !hskswapRoute.eligible) {
      return {
        selectedVenue: "TRANCHE",
        rationale: `Selected Tranche Offer #${trancheRoute.offerId} (all-in ${trancheAcq}) — HSKSwap ineligible: [${dexRejections.join("; ")}]`,
        tranche: trancheRoute,
        hskswap: hskswapRoute,
        evidence: buildEvidence("TRANCHE", ["hskswap_ineligible", `dex_impact=${dexImpactBps}bps`]),
      };
    }

    if (!trancheRoute.eligible && hskswapRoute.eligible) {
      return {
        selectedVenue: "HSKSWAP",
        rationale: `Selected HSKSwap (cost ${dexAcq}, impact ${dexImpactBps} bps) — Tranche ineligible: [${trancheRejections.join("; ")}]`,
        tranche: trancheRoute,
        hskswap: hskswapRoute,
        evidence: buildEvidence("HSKSWAP", ["tranche_ineligible", `dex_impact=${dexImpactBps}bps`]),
      };
    }

    // Both eligible: compare complete execution cost first
    if (trancheRoute.acquisitionCostPayment <= hskswapRoute.acquisitionCostPayment) {
      const savings = hskswapRoute.acquisitionCostPayment - trancheRoute.acquisitionCostPayment;
      return {
        selectedVenue: "TRANCHE",
        rationale: `Selected Tranche Offer #${trancheRoute.offerId}: all-in cost (${trancheAcq}) <= HSKSwap (${dexAcq}), saving ${savings} payment units`,
        tranche: trancheRoute,
        hskswap: hskswapRoute,
        evidence: buildEvidence("TRANCHE", [
          `direct_cost_savings=${savings}`,
          `dex_impact=${dexImpactBps}bps`,
        ]),
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
        evidence: buildEvidence("TRANCHE", [
          "bounded_downside_preference",
          `overhead_bps=${overheadBps}`,
        ]),
      };
    }

    const dexSavings = trancheRoute.acquisitionCostPayment - hskswapRoute.acquisitionCostPayment;
    return {
      selectedVenue: "HSKSWAP",
      rationale: `Selected HSKSwap: immediate acquisition cost (${dexAcq}) < Tranche all-in (${trancheAcq}) by ${dexSavings} payment units`,
      tranche: trancheRoute,
      hskswap: hskswapRoute,
      evidence: buildEvidence("HSKSWAP", [
        `direct_cost_savings=${dexSavings}`,
        `dex_impact=${dexImpactBps}bps`,
      ]),
    };
  }
}
