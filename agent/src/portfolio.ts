import type { Address } from "viem";
import { BPS_DENOMINATOR } from "./hskswap.js";
import type { PendingTxRecord, PositionStore, TrackedPosition, TrackedTicket } from "./positions.js";

export interface PortfolioConstraints {
  /** Max share of total portfolio equity/budget allocatable to a single inventory asset (bps, e.g. 4000 = 40%). */
  maxAssetAllocationBps: number;
  /** Max share of total portfolio equity/budget allocatable to a correlated asset group (bps, e.g. 6000 = 60%). */
  maxCorrelatedGroupAllocationBps: number;
  /** Minimum liquid payment balance reserve that must remain uncommitted. */
  minAvailableCapitalReservePayment: bigint;
  /** Minimum expected net profit (payment units) required to justify adding a trade to the portfolio. */
  minExpectedPortfolioEdgePayment: bigint;
  /** Optional explicit correlation groups (e.g. { ETH_ECOSYSTEM: [WETH, WHSK] }). */
  correlationGroups?: Readonly<Record<string, readonly Address[]>>;
  /** Minimum return sample size required before computing empirical Pearson correlation (default 5). */
  minCorrelationSamples?: number;
}

export interface AssetExposure {
  inventoryToken: Address;
  openPositionExposurePayment: bigint;
  activeTicketPremiumPaidPayment: bigint;
  activeTicketExerciseObligationPayment: bigint;
  pendingReservedPayment: bigint;
  totalCommittedPayment: bigint;
  allocationBps: number;
  unrealizedPnlPayment: bigint;
  realizedPnlPayment: bigint;
  openPositionsCount: number;
  activeTicketsCount: number;
}

export interface CorrelatedExposureGroup {
  groupName: string;
  assets: Address[];
  totalCommittedPayment: bigint;
  allocationBps: number;
  /** Empirical Pearson correlation (-1..1) when sufficient return series exist; null otherwise. */
  empiricalCorrelation: number | null;
  correlationStatus: "COMPUTED" | "GROUP_CONFIGURED" | "INSUFFICIENT_DATA";
}

export interface PortfolioSnapshot {
  timestamp: number;
  availableBalancePayment: bigint;
  totalEquityPayment: bigint;
  openPositionsExposurePayment: bigint;
  activeTicketsPremiumPaidPayment: bigint;
  activeTicketsExerciseObligationPayment: bigint;
  pendingTxReservedPayment: bigint;
  totalCommittedCapitalPayment: bigint;
  availableCapitalForAllocationPayment: bigint;
  totalRealizedPnlPayment: bigint;
  totalUnrealizedPnlPayment: bigint;
  dailyExposurePayment: bigint;
  dailyRealizedLossPayment: bigint;
  dailyPremiumSpentPayment: bigint;
  openPositionsCount: number;
  activeTicketsCount: number;
  pendingTxCount: number;
  assetExposures: AssetExposure[];
  correlatedExposures: CorrelatedExposureGroup[];
}

export interface PendingCapitalReservation {
  pendingTxId: string;
  inventoryToken: Address;
  reservedPayment: bigint;
}

export interface PortfolioAllocationRequest {
  inventoryToken: Address;
  requestedAmountInventory: bigint;
  estimatedAcquisitionCostPayment: bigint;
  expectedNetProfitPayment: bigint;
  /** For Tranche reservations, the upfront non-refundable premium paid immediately. */
  reservationPremiumPayment?: bigint;
  /** Minimum viable inventory amount below which scaling down is rejected. */
  minViableAmountInventory?: bigint;
}

export interface PortfolioAllocationDecision {
  approved: boolean;
  portfolioImproves: boolean;
  recommendedAmountInventory: bigint;
  recommendedCostPayment: bigint;
  expectedPortfolioReturnBps: number;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  rejectionReasons: string[];
  snapshot: PortfolioSnapshot;
}

function normAddr(addr: Address): string {
  return addr.toLowerCase();
}

/**
 * Computes empirical Pearson correlation between two return series.
 * Returns null if sample size < minSamples or either series has zero variance.
 */
export function computePearsonCorrelation(
  seriesA: readonly number[],
  seriesB: readonly number[],
  minSamples = 5,
): number | null {
  const n = Math.min(seriesA.length, seriesB.length);
  if (n < minSamples) return null;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += seriesA[i]!;
    sumB += seriesB[i]!;
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = seriesA[i]! - meanA;
    const db = seriesB[i]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA <= 0 || varB <= 0) return null;
  return Number((cov / Math.sqrt(varA * varB)).toFixed(4));
}

/**
 * Portfolio-level intelligence & capital allocation engine.
 *
 * Strictly prevents double-counting across:
 * 1) Open positions (remainingCostBasisPayment)
 * 2) Active Tranche tickets (sunk premium vs contingent exercise obligation)
 * 3) Unresolved pending transactions (only counted if not already settled into positions/tickets)
 */
export class PortfolioIntelligenceEngine {
  buildSnapshot(params: {
    store: PositionStore;
    nowSec: number;
    availableBalancePayment: bigint;
    constraints: PortfolioConstraints;
    /** Estimated remaining exercise payment per active ticketId (optional). */
    ticketExerciseObligations?: ReadonlyMap<bigint, bigint>;
    /** Capital reserved by in-flight pending txs (keyed by pendingTxId). */
    pendingReservations?: readonly PendingCapitalReservation[];
    /** Optional per-asset return series (bps) for empirical correlation computation. */
    assetReturnSeriesBps?: Readonly<Record<string, readonly number[]>>;
  }): PortfolioSnapshot {
    const { store, nowSec, availableBalancePayment, constraints } = params;
    const riskState = store.getPortfolioState(nowSec);
    const allPositions = store.getAllPositions();
    const openPositions = store.getOpenPositions();
    const activeTickets = store.getActiveTickets();
    const pendingTxs = store.getPendingTxs();

    // Map per-asset exposures without double-counting
    const byAsset = new Map<string, AssetExposure>();
    const ensureAsset = (token: Address): AssetExposure => {
      const k = normAddr(token);
      let entry = byAsset.get(k);
      if (!entry) {
        entry = {
          inventoryToken: token,
          openPositionExposurePayment: 0n,
          activeTicketPremiumPaidPayment: 0n,
          activeTicketExerciseObligationPayment: 0n,
          pendingReservedPayment: 0n,
          totalCommittedPayment: 0n,
          allocationBps: 0,
          unrealizedPnlPayment: 0n,
          realizedPnlPayment: 0n,
          openPositionsCount: 0,
          activeTicketsCount: 0,
        };
        byAsset.set(k, entry);
      }
      return entry;
    };

    let totalRealizedPnl = 0n;
    let totalUnrealizedPnl = 0n;
    let openPositionsExposure = 0n;

    for (const p of allPositions) {
      const entry = ensureAsset(p.inventoryToken);
      entry.realizedPnlPayment += p.realizedPnlPayment;
      totalRealizedPnl += p.realizedPnlPayment;
    }

    for (const p of openPositions) {
      const entry = ensureAsset(p.inventoryToken);
      entry.openPositionExposurePayment += p.remainingCostBasisPayment;
      entry.unrealizedPnlPayment += p.unrealizedPnlPayment;
      entry.openPositionsCount += 1;
      openPositionsExposure += p.remainingCostBasisPayment;
      totalUnrealizedPnl += p.unrealizedPnlPayment;
    }

    // Active tickets: separate sunk premium paid from contingent exercise obligation
    // (never double-count a ticket that has already been exercised into an open position)
    const exercisedTicketIds = new Set<bigint>(
      openPositions
        .map((p: TrackedPosition) => p.sourceTicketId)
        .filter((id): id is bigint => id !== undefined),
    );
    let activeTicketsPremiumPaid = 0n;
    let activeTicketsExerciseObligation = 0n;

    for (const t of activeTickets) {
      if (t.remainingAmount <= 0n) continue;
      const entry = ensureAsset(t.inventoryToken);
      // Proportional remaining sunk premium (only for unexercised portion)
      const remainingPremium =
        t.inventoryAmount > 0n
          ? (t.premiumPaidPayment * t.remainingAmount) / t.inventoryAmount
          : t.premiumPaidPayment;
      const exerciseObligation = params.ticketExerciseObligations?.get(t.ticketId) ?? 0n;

      // If this ticket was already fully converted into a position, skip to avoid double-counting
      if (exercisedTicketIds.has(t.ticketId) && t.remainingAmount === 0n) continue;

      entry.activeTicketPremiumPaidPayment += remainingPremium;
      entry.activeTicketExerciseObligationPayment += exerciseObligation;
      entry.activeTicketsCount += 1;
      activeTicketsPremiumPaid += remainingPremium;
      activeTicketsExerciseObligation += exerciseObligation;
    }

    // Pending tx capital reservations: deduplicated by active pendingTx IDs only
    const activePendingIds = new Set(pendingTxs.map((p: PendingTxRecord) => p.id));
    const seenPendingIds = new Set<string>();
    let pendingTxReserved = 0n;
    for (const res of params.pendingReservations ?? []) {
      if (!activePendingIds.has(res.pendingTxId) || seenPendingIds.has(res.pendingTxId)) continue;
      seenPendingIds.add(res.pendingTxId);
      const entry = ensureAsset(res.inventoryToken);
      entry.pendingReservedPayment += res.reservedPayment;
      pendingTxReserved += res.reservedPayment;
    }

    // Total committed capital = open position cost basis + contingent ticket exercise obligation + pending reservations
    // (Sunk premiums are already deducted from availableBalancePayment, so they are NOT added again to cash encumbrance.)
    const totalCommittedCapital =
      openPositionsExposure + activeTicketsExerciseObligation + pendingTxReserved;

    // Total equity = liquid payment balance + current mark-to-market value of open positions
    const openMarkToMarket =
      openPositionsExposure + totalUnrealizedPnl > 0n
        ? openPositionsExposure + totalUnrealizedPnl
        : 0n;
    const totalEquity = availableBalancePayment + openMarkToMarket;

    // Available capital for new allocation = liquid balance - contingent obligations - pending reservations - reserve floor
    const encumberedCash =
      activeTicketsExerciseObligation +
      pendingTxReserved +
      constraints.minAvailableCapitalReservePayment;
    const availableCapitalForAllocation =
      availableBalancePayment > encumberedCash ? availableBalancePayment - encumberedCash : 0n;

    const assetExposures: AssetExposure[] = [];
    for (const entry of byAsset.values()) {
      entry.totalCommittedPayment =
        entry.openPositionExposurePayment +
        entry.activeTicketExerciseObligationPayment +
        entry.pendingReservedPayment;
      entry.allocationBps =
        totalEquity > 0n
          ? Number((entry.totalCommittedPayment * BPS_DENOMINATOR) / totalEquity)
          : 0;
      assetExposures.push(entry);
    }

    // Correlated exposure groups
    const correlatedExposures: CorrelatedExposureGroup[] = [];
    const minSamples = constraints.minCorrelationSamples ?? 5;
    for (const [groupName, assets] of Object.entries(constraints.correlationGroups ?? {})) {
      let groupCommitted = 0n;
      for (const a of assets) {
        const exp = byAsset.get(normAddr(a));
        if (exp) groupCommitted += exp.totalCommittedPayment;
      }
      const allocationBps =
        totalEquity > 0n ? Number((groupCommitted * BPS_DENOMINATOR) / totalEquity) : 0;

      // Compute empirical correlation if at least 2 assets have sufficient return series
      let empiricalCorrelation: number | null = null;
      let correlationStatus: CorrelatedExposureGroup["correlationStatus"] = "GROUP_CONFIGURED";
      if (assets.length >= 2 && params.assetReturnSeriesBps) {
        const s0 = params.assetReturnSeriesBps[normAddr(assets[0]!)];
        const s1 = params.assetReturnSeriesBps[normAddr(assets[1]!)];
        if (s0 && s1) {
          empiricalCorrelation = computePearsonCorrelation(s0, s1, minSamples);
          correlationStatus = empiricalCorrelation !== null ? "COMPUTED" : "INSUFFICIENT_DATA";
        } else {
          correlationStatus = "INSUFFICIENT_DATA";
        }
      }

      correlatedExposures.push({
        groupName,
        assets: [...assets],
        totalCommittedPayment: groupCommitted,
        allocationBps,
        empiricalCorrelation,
        correlationStatus,
      });
    }

    return {
      timestamp: nowSec,
      availableBalancePayment,
      totalEquityPayment: totalEquity,
      openPositionsExposurePayment: openPositionsExposure,
      activeTicketsPremiumPaidPayment: activeTicketsPremiumPaid,
      activeTicketsExerciseObligationPayment: activeTicketsExerciseObligation,
      pendingTxReservedPayment: pendingTxReserved,
      totalCommittedCapitalPayment: totalCommittedCapital,
      availableCapitalForAllocationPayment: availableCapitalForAllocation,
      totalRealizedPnlPayment: totalRealizedPnl,
      totalUnrealizedPnlPayment: totalUnrealizedPnl,
      dailyExposurePayment: riskState.currentTotalExposurePayment,
      dailyRealizedLossPayment: riskState.dailyRealizedLossPayment,
      dailyPremiumSpentPayment: riskState.dailyPremiumSpentPayment,
      openPositionsCount: riskState.openPositionsCount,
      activeTicketsCount: riskState.activeTicketsCount,
      pendingTxCount: riskState.pendingTxCount,
      assetExposures,
      correlatedExposures,
    };
  }

  evaluateAllocation(params: {
    snapshot: PortfolioSnapshot;
    request: PortfolioAllocationRequest;
    constraints: PortfolioConstraints;
  }): PortfolioAllocationDecision {
    const { snapshot, request, constraints } = params;
    const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
    const rejectionReasons: string[] = [];

    const add = (name: string, passed: boolean, detail: string) => {
      checks.push({ name, passed, detail });
      if (!passed) rejectionReasons.push(`${name}:${detail}`);
    };

    // 1. Portfolio improvement check: expected edge must strictly clear minimum hurdle
    const portfolioImproves =
      request.expectedNetProfitPayment >= constraints.minExpectedPortfolioEdgePayment &&
      request.expectedNetProfitPayment > 0n;
    add(
      "portfolio_edge_improvement",
      portfolioImproves,
      `expectedEdge=${request.expectedNetProfitPayment} >= minEdge=${constraints.minExpectedPortfolioEdgePayment}`,
    );

    // 2. Available capital check (after reserve floor, pending txs, and ticket obligations)
    let maxAllowedCost = snapshot.availableCapitalForAllocationPayment;
    add(
      "available_capital",
      maxAllowedCost > 0n,
      `available=${snapshot.availableCapitalForAllocationPayment}, requested=${request.estimatedAcquisitionCostPayment}`,
    );

    // 3. Single-asset concentration cap
    const targetNorm = normAddr(request.inventoryToken);
    const existingAsset = snapshot.assetExposures.find(
      (a) => normAddr(a.inventoryToken) === targetNorm,
    );
    const currentAssetCommitted = existingAsset?.totalCommittedPayment ?? 0n;
    const maxAssetPayment =
      (snapshot.totalEquityPayment * BigInt(constraints.maxAssetAllocationBps)) / BPS_DENOMINATOR;
    const remainingAssetHeadroom =
      maxAssetPayment > currentAssetCommitted ? maxAssetPayment - currentAssetCommitted : 0n;
    add(
      "single_asset_concentration",
      remainingAssetHeadroom > 0n,
      `committed=${currentAssetCommitted}, cap=${maxAssetPayment} (${constraints.maxAssetAllocationBps} bps)`,
    );
    if (remainingAssetHeadroom < maxAllowedCost) {
      maxAllowedCost = remainingAssetHeadroom;
    }

    // 4. Correlated group exposure cap
    for (const group of snapshot.correlatedExposures) {
      if (!group.assets.some((a) => normAddr(a) === targetNorm)) continue;
      const maxGroupPayment =
        (snapshot.totalEquityPayment * BigInt(constraints.maxCorrelatedGroupAllocationBps)) /
        BPS_DENOMINATOR;
      const groupHeadroom =
        maxGroupPayment > group.totalCommittedPayment
          ? maxGroupPayment - group.totalCommittedPayment
          : 0n;
      add(
        `correlated_group_${group.groupName}`,
        groupHeadroom > 0n,
        `groupCommitted=${group.totalCommittedPayment}, cap=${maxGroupPayment} (${constraints.maxCorrelatedGroupAllocationBps} bps)`,
      );
      if (groupHeadroom < maxAllowedCost) {
        maxAllowedCost = groupHeadroom;
      }
    }

    // 5. Scale trade size down proportionally if requested cost exceeds remaining headroom
    let recommendedCost =
      request.estimatedAcquisitionCostPayment <= maxAllowedCost
        ? request.estimatedAcquisitionCostPayment
        : maxAllowedCost;
    let recommendedAmount = request.requestedAmountInventory;
    if (
      request.estimatedAcquisitionCostPayment > 0n &&
      recommendedCost < request.estimatedAcquisitionCostPayment
    ) {
      recommendedAmount =
        (request.requestedAmountInventory * recommendedCost) /
        request.estimatedAcquisitionCostPayment;
    }

    const minViable = request.minViableAmountInventory ?? 1n;
    const meetsMinViable = recommendedAmount >= minViable && recommendedCost > 0n;
    add(
      "min_viable_allocation",
      meetsMinViable,
      `recommendedAmount=${recommendedAmount} >= minViable=${minViable}`,
    );

    const expectedPortfolioReturnBps =
      snapshot.totalEquityPayment > 0n && request.estimatedAcquisitionCostPayment > 0n
        ? Number(
            (((request.expectedNetProfitPayment * recommendedCost) /
              request.estimatedAcquisitionCostPayment) *
              BPS_DENOMINATOR) /
              snapshot.totalEquityPayment,
          )
        : 0;

    const approved = rejectionReasons.length === 0;
    return {
      approved,
      portfolioImproves,
      recommendedAmountInventory: approved ? recommendedAmount : 0n,
      recommendedCostPayment: approved ? recommendedCost : 0n,
      expectedPortfolioReturnBps: approved ? expectedPortfolioReturnBps : 0,
      checks,
      rejectionReasons,
      snapshot,
    };
  }
}

export function estimateActiveTicketObligations(
  tickets: readonly TrackedTicket[],
  spotPriceX36ByToken: Readonly<Record<string, bigint>>,
  priceScale: bigint = 10n ** 36n,
): Map<bigint, bigint> {
  const out = new Map<bigint, bigint>();
  for (const t of tickets) {
    if (t.status !== "ACTIVE" || t.remainingAmount <= 0n) continue;
    const spot = spotPriceX36ByToken[normAddr(t.inventoryToken)];
    if (spot && spot > 0n) {
      out.set(t.ticketId, (t.remainingAmount * spot) / priceScale);
    }
  }
  return out;
}
