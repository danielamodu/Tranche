import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { OfferStatus, PriceMode, TicketStatus, type DiscoveredOffer, type DiscoveredTicket, type TrancheClient } from "@tranche/sdk";
import type { Address } from "viem";
import { PRICE_SCALE } from "../src/hskswap.js";
import type { MarketSnapshot } from "../src/market.js";
import { PortfolioIntelligenceEngine, type PortfolioConstraints } from "../src/portfolio.js";
import { PositionStore } from "../src/positions.js";
import {
  ProtocolApprovalManager,
  ProtocolPermissionError,
  TrancheProtocolActionLayer,
  type ProtocolPermissionPolicy,
} from "../src/protocol-actions/index.js";
import { TransactionReconciler } from "../src/reconciler.js";
import type { StrategyConfig } from "../src/strategy.js";
import { VenueSelector, type VenueSelectionConstraints } from "../src/venue.js";

const WHSK = "0xB210D2120d57b758EE163cFfb43e73728c471Cf1" as Address;
const USDT = "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029" as Address;
const MANAGER = "0xBF79786d5B86D10616E31A40a867eA27bbbbFA3c" as Address;
const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const LP = "0x2222222222222222222222222222222222222222" as Address;

const STRATEGY: StrategyConfig = {
  type: "price_threshold",
  momentumThresholdBps: 80,
  maxEntryPriceX36: 85n * 10n ** 21n,
  minVolatilityBps: 20,
  maxVolatilityBps: 800,
  dislocationThresholdBps: 40,
  takeProfitBps: 500,
  stopLossBps: 300,
  takeProfitExitBps: 10_000,
  ticketExerciseWindowSec: 300,
};

const VENUE_CONSTRAINTS: VenueSelectionConstraints = {
  maxAllInCostX36: 95n * 10n ** 21n,
  maxSlippageBps: 100,
  minExpectedNetProfitPayment: 100_000n,
  maxOptionOverheadBps: 100,
  trancheGasCostPayment: 20_000n,
  dexGasCostPayment: 10_000n,
  dexExitGasCostPayment: 10_000n,
  maxQuoteAgeSec: 30,
};

const POLICY: ProtocolPermissionPolicy = {
  maxSingleActionPayment: 25_000_000n,
  maxDailyApprovedPayment: 50_000_000n,
  defaultProposalTtlSec: 300,
  autonomousMainnetSigningEnabled: false,
  delegatedSigningStatus: "DEFERRED_AWAITING_SCOPED_SESSION_KEY_AUDIT",
};

const PORTFOLIO_CONSTRAINTS: PortfolioConstraints = {
  maxAssetAllocationBps: 4000,
  maxCorrelatedGroupAllocationBps: 6000,
  minAvailableCapitalReservePayment: 10_000_000n,
  minExpectedPortfolioEdgePayment: 100_000n,
};

function makeSnap(params: {
  dexBuyCost: bigint;
  dexBuyImpactBps?: number;
  dexSellProceeds?: bigint;
  trancheExerciseCost?: bigint;
  tranchePremium?: bigint;
  trancheEligible?: boolean;
  anomalies?: string[];
}): MarketSnapshot {
  const spot = 80n * 10n ** 21n;
  const target = 100n * 10n ** 18n;
  const hasTranche = params.trancheEligible !== false && params.trancheExerciseCost !== undefined;
  const prem = params.tranchePremium ?? 40_000n;
  const ex = params.trancheExerciseCost ?? 8_020_000n;
  return {
    timestamp: 1_750_000_100,
    inventoryToken: WHSK,
    paymentToken: USDT,
    targetAmount: target,
    pool: {
      venue: "HSKSwapV3",
      poolAddress: "0x0000000000000000000000000000000000000001",
      token0: WHSK,
      token1: USDT,
      fee: 3000,
      liquidity: 50_000_000n,
      sqrtPriceX96: 1n << 96n,
      tick: 0,
      observationCardinality: 64,
      spotPriceX36: spot,
      twapPriceX36: spot,
      timestamp: 1_750_000_095,
    },
    dexBuyQuote: {
      venue: "HSKSwapV3",
      inventoryToken: WHSK,
      paymentToken: USDT,
      inventoryAmountOut: target,
      paymentAmountIn: params.dexBuyCost,
      effectiveUnitPriceX36: (params.dexBuyCost * PRICE_SCALE) / target,
      priceImpactBps: params.dexBuyImpactBps ?? 35,
      gasEstimate: 120_000n,
    },
    dexSellQuote: {
      venue: "HSKSwapV3",
      inventoryToken: WHSK,
      paymentToken: USDT,
      inventoryAmountIn: target,
      paymentAmountOut: params.dexSellProceeds ?? 8_150_000n,
      effectiveUnitPriceX36: ((params.dexSellProceeds ?? 8_150_000n) * PRICE_SCALE) / target,
      priceImpactBps: 25,
      gasEstimate: 120_000n,
    },
    oracle: { priceX36: spot, updatedAt: 1_750_000_095, isValid: true },
    oracleAgeSec: 5,
    oracleDeviationBps: 10,
    trancheOffers: {
      timestamp: 1_750_000_100,
      discoveredOffers: [],
      evaluations: hasTranche
        ? []
        : [
            {
              offerId: 1n,
              eligible: false,
              rejectionReasons: ["InsufficientOfferBalance"],
              priceMode: PriceMode.FIXED,
              availableCapacity: 10n * 10n ** 18n,
              quotedGrossPremium: 0n,
              quotedExerciseCost: 0n,
              effectiveAllInUnitCostX36: 0n,
              expiresAt: 1_750_086_400,
            },
          ],
      selected: hasTranche
        ? {
            offerId: 1n,
            eligible: true,
            rejectionReasons: [],
            priceMode: PriceMode.FIXED,
            availableCapacity: target,
            quotedGrossPremium: prem,
            quotedExerciseCost: ex,
            effectiveAllInUnitCostX36: ((prem + ex) * PRICE_SCALE) / target,
            expiresAt: 1_750_086_400,
          }
        : null,
    },
    realizedVolatilityBps: 50,
    momentumReturnBps: 10,
    dislocationVsTwapBps: 0,
    marketRegime: "CALM",
    anomalies: params.anomalies ?? [],
    dataSourceHealthy: (params.anomalies ?? []).length === 0,
  };
}

function makeMockClient(opts: {
  offers?: DiscoveredOffer[];
  tickets?: DiscoveredTicket[];
  grossPremium?: bigint;
}): TrancheClient {
  const offers = opts.offers ?? [];
  const tickets = opts.tickets ?? [];
  return {
    addresses: {
      commitmentManager: MANAGER,
      liquidityVault: "0xC2E5d68cd030677CB8f851b66ee370B304504cE1" as Address,
      executionTicket: "0x05d966961AE75505f15883ddD2715e1D7c1752c1" as Address,
      executionRouter: "0x471221ea2cAEFD3f17f5c55dE74B3e2876E14aAb" as Address,
    },
    publicClient: {
      simulateContract: async () => ({ result: 1n }),
    },
    discoverOffers: async () => offers,
    getOffer: async (id: bigint) => offers.find((o) => o.offerId === id)!,
    quoteReservation: async () => ({
      grossPremium: opts.grossPremium ?? 40_000n,
      protocolFee: 200n,
    }),
    discoverTickets: async () => tickets,
    getTicket: async (id: bigint) => tickets.find((t) => t.ticketId === id)!,
    quoteExercise: async () => ({
      actualFill: 100n * 10n ** 18n,
      grossPayment: 8_020_000n,
      effPriceX36: 80n * 10n ** 21n,
    }),
  } as unknown as TrancheClient;
}

describe("Tranche Protocol-Native Execution, Permissions & 10 Validation Scenarios", () => {
  it("Scenario 1: Tranche is cheaper than HSKSwap -> selects TRANCHE with evidence", () => {
    const sel = new VenueSelector().selectVenue(
      makeSnap({ dexBuyCost: 8_300_000n, trancheExerciseCost: 8_020_000n, tranchePremium: 40_000n }),
      STRATEGY,
      VENUE_CONSTRAINTS,
    );
    assert.equal(sel.selectedVenue, "TRANCHE");
    assert.ok(sel.evidence!.costAdvantagePayment > 0n);
  });

  it("Scenario 2: HSKSwap is cheaper than Tranche -> selects HSKSWAP (no artificial Tranche bias)", () => {
    const sel = new VenueSelector().selectVenue(
      makeSnap({ dexBuyCost: 8_000_000n, trancheExerciseCost: 8_100_000n, tranchePremium: 80_000n }),
      STRATEGY,
      VENUE_CONSTRAINTS,
    );
    assert.equal(sel.selectedVenue, "HSKSWAP");
  });

  it("Scenario 3: Tranche has insufficient inventory -> selects HSKSWAP and records InsufficientOfferBalance", () => {
    const sel = new VenueSelector().selectVenue(
      makeSnap({ dexBuyCost: 8_100_000n, trancheEligible: false }),
      STRATEGY,
      VENUE_CONSTRAINTS,
    );
    assert.equal(sel.selectedVenue, "HSKSWAP");
    assert.ok(sel.tranche.rejectionReasons.some((r) => r.includes("InsufficientOfferBalance")));
  });

  it("Scenario 4: High reservation premium makes Tranche uneconomical -> selects HSKSWAP", () => {
    const sel = new VenueSelector().selectVenue(
      makeSnap({ dexBuyCost: 8_100_000n, trancheExerciseCost: 8_020_000n, tranchePremium: 600_000n }),
      STRATEGY,
      VENUE_CONSTRAINTS,
    );
    assert.equal(sel.selectedVenue, "HSKSWAP");
    assert.equal(sel.tranche.eligible, false);
  });

  it("Scenario 5: Reservation expires before exercise -> canReclaimExpired=true; active ticket cannot be cancelled early", async () => {
    const now = 1_750_001_000;
    const tickets: DiscoveredTicket[] = [
      {
        ticketId: 1n,
        offerId: 1n,
        owner: WALLET,
        reservedAt: 1_750_000_000,
        expiresAt: 1_750_000_500, // expired
        priceMode: PriceMode.FIXED,
        status: TicketStatus.ACTIVE,
        spreadBps: 0,
        protocolFeeBps: 5,
        lp: LP,
        inventoryToken: WHSK,
        paymentToken: USDT,
        oracle: "0x0000000000000000000000000000000000000000",
        complianceHook: "0x0000000000000000000000000000000000000000",
        initialAmount: 100n * 10n ** 18n,
        remainingAmount: 100n * 10n ** 18n,
        minFillAmount: 10n * 10n ** 18n,
        fixedOrMinPriceX36: 80n * 10n ** 21n,
        maxPriceX36: 0n,
      },
      {
        ticketId: 2n,
        offerId: 1n,
        owner: WALLET,
        reservedAt: 1_750_000_800,
        expiresAt: 1_750_005_000, // still active
        priceMode: PriceMode.FIXED,
        status: TicketStatus.ACTIVE,
        spreadBps: 0,
        protocolFeeBps: 5,
        lp: LP,
        inventoryToken: WHSK,
        paymentToken: USDT,
        oracle: "0x0000000000000000000000000000000000000000",
        complianceHook: "0x0000000000000000000000000000000000000000",
        initialAmount: 100n * 10n ** 18n,
        remainingAmount: 100n * 10n ** 18n,
        minFillAmount: 10n * 10n ** 18n,
        fixedOrMinPriceX36: 80n * 10n ** 21n,
        maxPriceX36: 0n,
      },
    ];
    const layer = new TrancheProtocolActionLayer({
      client: makeMockClient({ tickets }),
      nowSec: () => now,
    });

    const expiredTicket = await layer.getTicketDetails(1n);
    assert.equal(expiredTicket.isExpired, true);
    assert.equal(expiredTicket.canExercise, false);
    assert.equal(expiredTicket.canReclaimExpired, true);
    const reclaimOk = await layer.simulateReclaimExpired({ ticketId: 1n, account: WALLET });
    assert.equal(reclaimOk.ok, true);

    const activeReclaim = await layer.simulateReclaimExpired({ ticketId: 2n, account: WALLET });
    assert.equal(activeReclaim.ok, false);
    assert.equal(activeReclaim.revertReason, "NOT_EXPIRED_ACTIVE_TICKETS_CANNOT_BE_CANCELLED_EARLY");
  });

  it("Scenario 6: Portfolio allocation prevents reservation when reserve floor leaves zero allocatable capital", async () => {
    const offer: DiscoveredOffer = {
      offerId: 1n,
      lp: LP,
      createdAt: 1_750_000_000,
      expiry: 1_750_086_400,
      priceMode: PriceMode.FIXED,
      status: OfferStatus.ACTIVE,
      inventoryToken: WHSK,
      minDuration: 60,
      maxDuration: 86_400,
      basePremiumBps: 50,
      dailyPremiumBps: 10,
      paymentToken: USDT,
      spreadBps: 0,
      protocolFeeBps: 5,
      oracle: "0x0000000000000000000000000000000000000000",
      complianceHook: "0x0000000000000000000000000000000000000000",
      minFillAmount: 10n * 10n ** 18n,
      fixedPriceX36: 80n * 10n ** 21n,
      minPriceX36: 0n,
      maxPriceX36: 0n,
      availableBalance: 500n * 10n ** 18n,
    };
    const layer = new TrancheProtocolActionLayer({
      client: makeMockClient({ offers: [offer] }),
      nowSec: () => 1_750_000_100,
    });
    const store = new PositionStore(undefined, 1_750_000_100);
    const portSnap = new PortfolioIntelligenceEngine().buildSnapshot({
      store,
      nowSec: 1_750_000_100,
      availableBalancePayment: 10_000_000n, // equals $10 reserve floor -> $0 available!
      constraints: PORTFOLIO_CONSTRAINTS,
    });

    const evalRes = await layer.evaluateOfferAgainstPortfolio({
      offerId: 1n,
      inventoryAmount: 100n * 10n ** 18n,
      durationSec: 3600,
      expectedTargetExitPayment: 8_600_000n,
      portfolioSnapshot: portSnap,
      portfolioConstraints: PORTFOLIO_CONSTRAINTS,
    });
    assert.equal(evalRes.inventorySufficient, true);
    assert.equal(evalRes.allocation.approved, false);
  });

  it("Scenario 7 & Permission Security: Pending txs block duplicates, forbidden LP ops & tampered bindings rejected", () => {
    let now = 1_750_000_000;
    const mgr = new ProtocolApprovalManager({ policy: POLICY, nowSec: () => now });

    // Forbidden LP/admin op must fail closed
    assert.throws(
      () =>
        mgr.createProposal({
          idempotencyKey: "k-lp",
          dataProvenance: "MOCK",
          rationale: "LP withdraw attempt",
          parameters: {
            action: "LP_WITHDRAW" as never,
            wallet: WALLET,
            chainId: 133,
            contractAddress: MANAGER,
            token: USDT,
            amount: 100n,
            maxPaymentOrPremium: 100n,
            recipient: WALLET,
          },
        }),
      (e: unknown) => e instanceof ProtocolPermissionError && e.code === "PERMISSION_DENIED_OUT_OF_SCOPE",
    );

    const p1 = mgr.createProposal({
      idempotencyKey: "k-res-1",
      dataProvenance: "FORK",
      rationale: "Reserve 100 WHSK",
      parameters: {
        action: "RESERVE_INVENTORY",
        wallet: WALLET,
        chainId: 133,
        contractAddress: MANAGER,
        token: USDT,
        amount: 100n * 10n ** 18n,
        maxPaymentOrPremium: 45_000n,
        offerId: 1n,
        durationSec: 3600,
        recipient: WALLET,
      },
    });
    const approved = mgr.approveProposal({
      proposalId: p1.proposalId,
      approvedBy: WALLET,
      expectedBindingHash: p1.bindingHash,
    });

    // Tampered parameter on submission must be rejected
    assert.throws(
      () =>
        mgr.recordSubmission({
          proposalId: approved.proposalId,
          txHash: `0x${"a".repeat(64)}`,
          submittedParameters: { ...approved.parameters, maxPaymentOrPremium: 99_999n },
        }),
      (e: unknown) => e instanceof ProtocolPermissionError && e.code === "APPROVAL_PARAMETER_MISMATCH",
    );

    // Valid submission succeeds
    mgr.recordSubmission({
      proposalId: approved.proposalId,
      txHash: `0x${"a".repeat(64)}`,
      submittedParameters: approved.parameters,
    });

    // Second proposal cannot submit while first is still SUBMITTED (pending)
    const p2 = mgr.createProposal({
      idempotencyKey: "k-res-2",
      dataProvenance: "FORK",
      rationale: "Second reserve",
      parameters: { ...p1.parameters },
    });
    mgr.approveProposal({ proposalId: p2.proposalId, approvedBy: WALLET });
    assert.throws(
      () => mgr.recordSubmission({ proposalId: p2.proposalId, txHash: `0x${"b".repeat(64)}` }),
      (e: unknown) => e instanceof ProtocolPermissionError && e.code === "PENDING_TX_BLOCKING",
    );
  });

  it("Scenario 8: Neither venue suitable -> abstains (NONE)", () => {
    const sel = new VenueSelector().selectVenue(
      makeSnap({ dexBuyCost: 9_000_000n, dexBuyImpactBps: 450, trancheEligible: false }),
      STRATEGY,
      VENUE_CONSTRAINTS,
    );
    assert.equal(sel.selectedVenue, "NONE");
  });

  it("Scenario 9: Submission succeeds but confirmation is delayed -> stays unverified PENDING until receipt", async () => {
    const reconciler = new TransactionReconciler({
      getChainId: async () => 133,
      getTransactionReceipt: async () => {
        throw new Error("TransactionReceiptNotFoundError");
      },
      getTransactionCount: async () => 0,
    });
    const layer = new TrancheProtocolActionLayer({
      client: makeMockClient({}),
      reconciler,
      nowSec: () => 1_750_000_100,
    });
    const res = await layer.reconcileAndVerifyTicketTx({
      pendingTxId: "ptx-delayed",
      txHash: `0x${"c".repeat(64)}`,
      chainId: 133,
    });
    assert.equal(res.onChainStateVerified, false);
    assert.equal(res.reconciliation.canClearPending, false);
  });

  it("Scenario 10: Restart with outstanding submitted proposal preserves state, blocks replay, and confirms cleanly", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tranche-proto-restart-"));
    const file = path.join(dir, "approvals.json");

    const mgr1 = new ProtocolApprovalManager({ policy: POLICY, filePath: file });
    const prop = mgr1.createProposal({
      idempotencyKey: "k-restart-1",
      dataProvenance: "FORK",
      rationale: "Reserve before restart",
      parameters: {
        action: "RESERVE_INVENTORY",
        wallet: WALLET,
        chainId: 133,
        contractAddress: MANAGER,
        token: USDT,
        amount: 100n * 10n ** 18n,
        maxPaymentOrPremium: 45_000n,
        offerId: 1n,
        durationSec: 3600,
        recipient: WALLET,
      },
    });
    mgr1.approveProposal({ proposalId: prop.proposalId, approvedBy: WALLET });
    mgr1.recordSubmission({ proposalId: prop.proposalId, txHash: `0x${"d".repeat(64)}` });

    // Process restart -> fresh manager from disk
    const mgr2 = new ProtocolApprovalManager({ policy: POLICY, filePath: file });
    const reloaded = mgr2.getProposal(prop.proposalId)!;
    assert.equal(reloaded.status, "SUBMITTED");
    assert.equal(mgr2.hasPendingSubmittedProposal(), true);

    // Replay blocked after restart
    assert.throws(
      () => mgr2.recordSubmission({ proposalId: prop.proposalId, txHash: `0x${"e".repeat(64)}` }),
      (e: unknown) =>
        e instanceof ProtocolPermissionError &&
        (e.code === "PENDING_TX_BLOCKING" || e.code === "REPLAY_OR_DUPLICATE_BLOCKED"),
    );

    const confirmed = mgr2.recordConfirmation({
      proposalId: prop.proposalId,
      confirmed: true,
      blockNumber: 12345n,
      resultingTicketId: 9n,
      detail: "Verified receipt and Ticket #9 on-chain",
    });
    assert.equal(confirmed.status, "CONFIRMED");
    assert.equal(confirmed.resultingTicketId, 9n);
  });
});
