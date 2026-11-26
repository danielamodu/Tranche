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
  ALLOWED_TRADING_AGENT_WRITE_OPS,
  ProtocolApprovalManager,
  ProtocolPermissionError,
  TrancheProtocolActionLayer,
  assertOperationAllowedForTradingAgent,
  type ProtocolPermissionPolicy,
} from "../src/protocol-actions/index.js";
import { TransactionReconciler } from "../src/reconciler.js";
import { AgentRuntime, TrancheAutonomousAgent } from "../src/runtime.js";
import { AgentApiServer } from "../src/server.js";
import { TrancheExecutionAgent } from "../src/agent.js";
import { MarketIntelligence } from "../src/market.js";
import type { RiskLimits } from "../src/risk.js";
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

  it("Adversarial 11: Strict allowlist rejects CANCEL_OFFER, LP/admin ops, case variants, unknown & malformed actions", () => {
    assert.deepEqual(Array.from(ALLOWED_TRADING_AGENT_WRITE_OPS).sort(), [
      "EXERCISE_TICKET",
      "RECLAIM_EXPIRED_TICKET",
      "RESERVE_INVENTORY",
    ]);

    const mgr = new ProtocolApprovalManager({ policy: POLICY });
    const rejectedActions: unknown[] = [
      "CANCEL_OFFER",
      "LP_CANCEL_OFFER",
      "LP_DEPOSIT",
      "LP_WITHDRAW",
      "LP_CREATE_OFFER",
      "ADMIN_UPDATE",
      "TRANSFER_FUNDS",
      "SWEEP_VAULT",
      "__proto__",
      "reserve_inventory",
      "Reserve_Inventory",
      " RESERVE_INVENTORY ",
      "exercise_ticket",
      "reclaim_expired_ticket",
      "",
      null,
      undefined,
      123,
      { action: "RESERVE_INVENTORY" },
    ];

    for (let i = 0; i < rejectedActions.length; i += 1) {
      const badAction = rejectedActions[i];
      assert.throws(
        () => assertOperationAllowedForTradingAgent(badAction),
        (e: unknown) => e instanceof ProtocolPermissionError && e.code === "PERMISSION_DENIED_OUT_OF_SCOPE",
      );
      assert.throws(
        () =>
          mgr.createProposal({
            idempotencyKey: `adv-bad-op-${i}`,
            dataProvenance: "LIVE",
            rationale: "Adversarial action test",
            parameters: {
              action: badAction as never,
              wallet: WALLET,
              chainId: 133,
              contractAddress: MANAGER,
              token: USDT,
              amount: 100n,
              maxPaymentOrPremium: 1_000n,
              offerId: 1n,
              durationSec: 600,
              recipient: WALLET,
            },
          }),
        (e: unknown) => e instanceof ProtocolPermissionError && e.code === "PERMISSION_DENIED_OUT_OF_SCOPE",
      );
    }
  });

  it("Adversarial 12: Contract-semantic validation blocks expired exercise, active reclaim, invalid params & post-approval action mutation", () => {
    const now = 1_750_000_000;
    const mgr = new ProtocolApprovalManager({ policy: POLICY, nowSec: () => now });

    // Expired ticket cannot be exercised
    assert.throws(
      () =>
        mgr.createProposal({
          idempotencyKey: "adv-exp-ex",
          dataProvenance: "LIVE",
          rationale: "Exercise expired ticket",
          parameters: {
            action: "EXERCISE_TICKET",
            wallet: WALLET,
            chainId: 133,
            contractAddress: MANAGER,
            token: USDT,
            amount: 10n * 10n ** 18n,
            maxPaymentOrPremium: 100_000n,
            ticketId: 5n,
            ticketExpiresAtSec: now - 1,
            recipient: WALLET,
          },
        }),
      (e: unknown) => e instanceof ProtocolPermissionError && e.code === "TICKET_EXPIRED_CANNOT_EXERCISE",
    );

    // Active ticket cannot be reclaimed early
    assert.throws(
      () =>
        mgr.createProposal({
          idempotencyKey: "adv-act-rec",
          dataProvenance: "LIVE",
          rationale: "Reclaim active ticket",
          parameters: {
            action: "RECLAIM_EXPIRED_TICKET",
            wallet: WALLET,
            chainId: 133,
            contractAddress: MANAGER,
            token: USDT,
            amount: 0n,
            maxPaymentOrPremium: 0n,
            ticketId: 5n,
            ticketExpiresAtSec: now + 600,
            recipient: WALLET,
          },
        }),
      (e: unknown) => e instanceof ProtocolPermissionError && e.code === "TICKET_NOT_EXPIRED_CANNOT_RECLAIM",
    );

    // RESERVE_INVENTORY missing offerId / durationSec fails closed
    assert.throws(
      () =>
        mgr.createProposal({
          idempotencyKey: "adv-missing-offer",
          dataProvenance: "LIVE",
          rationale: "Missing offerId",
          parameters: {
            action: "RESERVE_INVENTORY",
            wallet: WALLET,
            chainId: 133,
            contractAddress: MANAGER,
            token: USDT,
            amount: 10n,
            maxPaymentOrPremium: 100n,
            recipient: WALLET,
          },
        }),
      (e: unknown) => e instanceof ProtocolPermissionError && e.code === "INVALID_ACTION_PARAMETERS",
    );

    // Modified action after approval is rejected at submission time
    const valid = mgr.createProposal({
      idempotencyKey: "adv-mutate-after-approve",
      dataProvenance: "LIVE",
      rationale: "Legit reserve",
      parameters: {
        action: "RESERVE_INVENTORY",
        wallet: WALLET,
        chainId: 133,
        contractAddress: MANAGER,
        token: USDT,
        amount: 50n * 10n ** 18n,
        maxPaymentOrPremium: 45_000n,
        offerId: 2n,
        durationSec: 1800,
        recipient: WALLET,
      },
    });
    mgr.approveProposal({
      proposalId: valid.proposalId,
      approvedBy: WALLET,
      expectedBindingHash: valid.bindingHash,
    });

    // Attempt to swap action to LP_CANCEL_OFFER on submission
    assert.throws(
      () =>
        mgr.recordSubmission({
          proposalId: valid.proposalId,
          txHash: `0x${"f".repeat(64)}`,
          submittedParameters: {
            ...valid.parameters,
            action: "LP_CANCEL_OFFER" as never,
          },
        }),
      (e: unknown) => e instanceof ProtocolPermissionError && e.code === "PERMISSION_DENIED_OUT_OF_SCOPE",
    );

    // Attempt to swap action to EXERCISE_TICKET on submission (allowlisted but mismatched binding)
    assert.throws(
      () =>
        mgr.recordSubmission({
          proposalId: valid.proposalId,
          txHash: `0x${"f".repeat(64)}`,
          submittedParameters: {
            ...valid.parameters,
            action: "EXERCISE_TICKET",
            offerId: undefined,
            durationSec: undefined,
            ticketId: 9n,
          },
        }),
      (e: unknown) => e instanceof ProtocolPermissionError && e.code === "APPROVAL_PARAMETER_MISMATCH",
    );
  });

  it("Adversarial 13: Direct HTTP API rejects unauthorized/bypass attempts and exposes sanitized public read-only endpoints", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tranche-api-sec-"));
    const store = new PositionStore(path.join(dir, "state.json"));
    const approvals = new ProtocolApprovalManager({
      policy: POLICY,
      filePath: path.join(dir, "approvals.json"),
    });
    const fakeClient = {
      discoverOffers: async () => [],
      publicClient: { getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }) },
    } as unknown as TrancheClient;
    const trancheAgent = new TrancheExecutionAgent(fakeClient);
    const dexVenue = {
      name: "MockDex",
      getPoolState: async () => ({
        venue: "MockDex",
        poolAddress: MANAGER,
        token0: WHSK,
        token1: USDT,
        fee: 3000,
        liquidity: 1_000_000n,
        sqrtPriceX96: 1n << 96n,
        tick: 0,
        observationCardinality: 10,
        spotPriceX36: 81n * 10n ** 21n,
        twapPriceX36: 81n * 10n ** 21n,
        timestamp: Math.floor(Date.now() / 1000),
      }),
      quoteBuyInventory: async () => ({
        venue: "MockDex",
        inventoryToken: WHSK,
        paymentToken: USDT,
        inventoryAmountOut: 100n * 10n ** 18n,
        paymentAmountIn: 8_200_000n,
        effectiveUnitPriceX36: 82n * 10n ** 21n,
        priceImpactBps: 30,
        gasEstimate: 80_000n,
      }),
      quoteSellInventory: async () => ({
        venue: "MockDex",
        inventoryToken: WHSK,
        paymentToken: USDT,
        inventoryAmountIn: 100n * 10n ** 18n,
        paymentAmountOut: 8_050_000n,
        effectiveUnitPriceX36: 80n * 10n ** 21n,
        priceImpactBps: 30,
        gasEstimate: 80_000n,
      }),
      executeSwapExactInput: async () => {
        throw new Error("Blocked");
      },
    };
    const riskLimits: RiskLimits = {
      maxPositionSizeInventory: 200n * 10n ** 18n,
      maxTotalExposurePayment: 50_000_000n,
      maxDailyPremiumBudgetPayment: 500_000n,
      maxDailyRealizedLossPayment: 5_000_000n,
      maxConcurrentPositions: 3,
      maxConcurrentTickets: 3,
      maxSlippageBps: 100,
      minPoolLiquidity: 100_000_000_000n,
      maxOracleAgeSec: 60,
      maxOracleDeviationBps: 300,
      paused: false,
      killSwitch: false,
    };
    const market = new MarketIntelligence({
      dexVenue,
      trancheAgent,
      oracleReader: {
        getPriceX36: async () => ({
          priceX36: 81n * 10n ** 21n,
          updatedAt: Math.floor(Date.now() / 1000),
          isValid: true,
        }),
      },
      poolAddress: MANAGER,
      poolFee: 3000,
      minPoolLiquidity: riskLimits.minPoolLiquidity,
      maxOracleAgeSec: riskLimits.maxOracleAgeSec,
      maxOracleDeviationBps: riskLimits.maxOracleDeviationBps,
    });
    const autonomous = new TrancheAutonomousAgent({
      market,
      trancheAgent,
      dexVenue,
      positions: store,
      recipient: WALLET,
      poolFee: 3000,
      executionMode: "read_only",
      intent: {
        inventoryToken: WHSK,
        paymentToken: USDT,
        targetAmount: 100n * 10n ** 18n,
        desiredDuration: 3600,
        maxAllInCostX36: 95n * 10n ** 21n,
      },
      strategyConfig: STRATEGY,
      riskLimits,
      venueConstraints: {
        maxAllInCostX36: 95n * 10n ** 21n,
        maxSlippageBps: 100,
        minExpectedNetProfitPayment: 100_000n,
        maxOptionOverheadBps: 100,
      },
    });
    const runtime = new AgentRuntime({ agent: autonomous, pollIntervalMs: 60_000 });
    const apiToken = "test-secret-operator-token-123456";
    const server = new AgentApiServer({
      agent: autonomous,
      runtime,
      policyBounds: {
        hardMaxPositionSizeInventory: 500n * 10n ** 18n,
        hardMaxSlippageBps: 150,
        minStopLossBps: 50,
        maxStopLossBps: 1000,
        minTakeProfitBps: 50,
        maxTakeProfitBps: 5000,
      },
      apiToken,
      host: "127.0.0.1",
      port: 0,
      chainId: 177,
      dataSource: "chain177_read_only",
      protocolApprovalManager: approvals,
    });
    const { url } = await server.start();
    try {
      // 1. Existing operator endpoints remain strictly 401 without Bearer token
      for (const ep of ["/agent/intelligence", "/agent/protocol/activity"]) {
        const r = await fetch(`${url}${ep}`);
        assert.equal(r.status, 401, `${ep} must remain 401 unauthenticated`);
      }

      // 2. Direct API bypass attempts for forbidden/unknown/case-variant actions fail closed (403)
      for (const badAction of [
        "CANCEL_OFFER",
        "LP_CANCEL_OFFER",
        "LP_DEPOSIT",
        "LP_WITHDRAW",
        "ADMIN_UPDATE",
        "reserve_inventory",
        "UNKNOWN_OP",
      ]) {
        const r = await fetch(`${url}/agent/protocol/propose`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            idempotencyKey: `api-bypass-${badAction}`,
            action: badAction,
            wallet: WALLET,
            chainId: 133,
            contractAddress: MANAGER,
            token: USDT,
            amount: "100",
            maxPaymentOrPremium: "1000",
            offerId: "1",
            durationSec: 600,
            recipient: WALLET,
          }),
        });
        assert.equal(r.status, 403, `Expected 403 for ${badAction}`);
        const body = (await r.json()) as { error: string };
        assert.equal(body.error, "PERMISSION_DENIED_OUT_OF_SCOPE");
      }

      // 3. Create one valid proposal (authenticated), then verify public read-only endpoints sanitize it
      const createRes = await fetch(`${url}/agent/protocol/propose`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: "api-valid-reserve-1",
          action: "RESERVE_INVENTORY",
          wallet: WALLET,
          chainId: 133,
          contractAddress: MANAGER,
          token: USDT,
          amount: "100",
          maxPaymentOrPremium: "1000",
          offerId: "2",
          durationSec: 1800,
          recipient: WALLET,
          rationale: "Valid sanitized public test",
        }),
      });
      assert.equal(createRes.status, 201);

      const pubIntel = await fetch(`${url}/agent/public/intelligence`);
      assert.equal(pubIntel.status, 200);
      const intelJson = (await pubIntel.json()) as Record<string, unknown>;
      assert.equal(intelJson.readOnlyPublicView, true);
      assert.equal(intelJson.chainId, 177);

      const pubProto = await fetch(`${url}/agent/public/protocol/activity`);
      assert.equal(pubProto.status, 200);
      const protoJson = (await pubProto.json()) as {
        readOnlyPublicView: boolean;
        autonomousMainnetSigningEnabled: boolean;
        proposals: Array<Record<string, unknown>>;
      };
      assert.equal(protoJson.readOnlyPublicView, true);
      assert.equal(protoJson.autonomousMainnetSigningEnabled, false);
      assert.equal(protoJson.proposals.length, 1);
      const p0 = protoJson.proposals[0]!;
      assert.equal("approvedBy" in p0, false);
      assert.equal("idempotencyKey" in p0, false);
      const params0 = p0.parameters as Record<string, unknown>;
      assert.equal("wallet" in params0, false);
      assert.equal("recipient" in params0, false);
    } finally {
      await server.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
