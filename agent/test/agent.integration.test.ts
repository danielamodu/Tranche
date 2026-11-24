import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import test, { after, before } from "node:test";
import {
  PriceMode,
  TicketStatus,
  TrancheClient,
  deployLocalTrancheStack,
  type TrancheDeployment,
} from "@tranche/sdk";
import { zeroAddress } from "viem";
import { TrancheAgentError, TrancheExecutionAgent } from "../src/agent.js";
import { startTempAnvil, stopTempAnvil, warpTime } from "../src/anvil.js";
import type { AgentIntent } from "../src/types.js";

const WHSK_UNIT = 10n ** 18n;
const USDT_UNIT = 10n ** 6n;

let anvilProc: ChildProcess;
let deployment: TrancheDeployment;
let adminClient: TrancheClient;
let lpClient: TrancheClient;
let trader1Client: TrancheClient;
let trader2Client: TrancheClient;
let keeperClient: TrancheClient;

before(async () => {
  const started = await startTempAnvil();
  anvilProc = started.proc;
  deployment = await deployLocalTrancheStack(started.rpcUrl);

  adminClient = new TrancheClient({
    publicClient: deployment.publicClient,
    walletClient: deployment.accounts.admin.walletClient,
    addresses: deployment.addresses,
  });
  lpClient = adminClient.withWalletClient(deployment.accounts.lp.walletClient);
  trader1Client = adminClient.withWalletClient(deployment.accounts.trader1.walletClient);
  trader2Client = adminClient.withWalletClient(deployment.accounts.trader2.walletClient);
  keeperClient = adminClient.withWalletClient(deployment.accounts.keeper.walletClient);
});

after(async () => {
  if (anvilProc) {
    await stopTempAnvil(anvilProc);
  }
});

test("1. Deterministic multi-offer ranking & selection (FIXED vs FLOATING + ineligible rejections)", async () => {
  const { addresses, publicClient } = deployment;
  const whsk = addresses.whsk;
  const usdt = addresses.usdt;

  await lpClient.deposit(whsk, 30_000n * WHSK_UNIT);

  const block = await publicClient.getBlock({ blockTag: "latest" });
  const now = Number(block.timestamp);
  const longExpiry = now + 7 * 86_400;

  // Offer #1: FIXED at 0.084 USDT/WHSK (eligible, higher cost)
  const o1 = await lpClient.createOffer({
    inventoryToken: whsk,
    paymentToken: usdt,
    initialAmount: 3_000n * WHSK_UNIT,
    minFillAmount: 100n * WHSK_UNIT,
    expiry: longExpiry,
    minDuration: 60,
    maxDuration: 86_400,
    basePremiumBps: 15,
    dailyPremiumBps: 20,
    priceMode: PriceMode.FIXED,
    spreadBps: 0,
    oracle: zeroAddress,
    complianceHook: zeroAddress,
    fixedPriceX36: 84n * 10n ** 21n,
    minPriceX36: 0n,
    maxPriceX36: 0n,
  });

  // Offer #2: FLOATING at 0.080 + 10 bps spread (eligible, lowest all-in cost)
  const o2 = await lpClient.createOffer({
    inventoryToken: whsk,
    paymentToken: usdt,
    initialAmount: 3_000n * WHSK_UNIT,
    minFillAmount: 100n * WHSK_UNIT,
    expiry: longExpiry,
    minDuration: 60,
    maxDuration: 86_400,
    basePremiumBps: 10,
    dailyPremiumBps: 10,
    priceMode: PriceMode.FLOATING,
    spreadBps: 10,
    oracle: addresses.oraclePriceAdapter,
    complianceHook: zeroAddress,
    fixedPriceX36: 0n,
    minPriceX36: 10n ** 18n,
    maxPriceX36: 10n ** 26n,
  });

  // Offer #3: PAUSED (non-ACTIVE)
  const o3 = await lpClient.createOffer({
    inventoryToken: whsk,
    paymentToken: usdt,
    initialAmount: 2_000n * WHSK_UNIT,
    minFillAmount: 100n * WHSK_UNIT,
    expiry: longExpiry,
    minDuration: 60,
    maxDuration: 86_400,
    basePremiumBps: 5,
    dailyPremiumBps: 5,
    priceMode: PriceMode.FIXED,
    spreadBps: 0,
    oracle: zeroAddress,
    complianceHook: zeroAddress,
    fixedPriceX36: 70n * 10n ** 21n,
    minPriceX36: 0n,
    maxPriceX36: 0n,
  });
  await lpClient.pauseOffer(o3.offerId);

  // Offer #4: Insufficient capacity (400 < 1,000 target)
  const o4 = await lpClient.createOffer({
    inventoryToken: whsk,
    paymentToken: usdt,
    initialAmount: 400n * WHSK_UNIT,
    minFillAmount: 100n * WHSK_UNIT,
    expiry: longExpiry,
    minDuration: 60,
    maxDuration: 86_400,
    basePremiumBps: 5,
    dailyPremiumBps: 5,
    priceMode: PriceMode.FIXED,
    spreadBps: 0,
    oracle: zeroAddress,
    complianceHook: zeroAddress,
    fixedPriceX36: 70n * 10n ** 21n,
    minPriceX36: 0n,
    maxPriceX36: 0n,
  });

  // Offer #5: Below minFillAmount (minFill = 1,500 > 1,000 target)
  const o5 = await lpClient.createOffer({
    inventoryToken: whsk,
    paymentToken: usdt,
    initialAmount: 2_000n * WHSK_UNIT,
    minFillAmount: 1_500n * WHSK_UNIT,
    expiry: longExpiry,
    minDuration: 60,
    maxDuration: 86_400,
    basePremiumBps: 5,
    dailyPremiumBps: 5,
    priceMode: PriceMode.FIXED,
    spreadBps: 0,
    oracle: zeroAddress,
    complianceHook: zeroAddress,
    fixedPriceX36: 70n * 10n ** 21n,
    minPriceX36: 0n,
    maxPriceX36: 0n,
  });

  // Offer #6: Invalid duration bounds (minDuration = 1,200 > 600 desired)
  const o6 = await lpClient.createOffer({
    inventoryToken: whsk,
    paymentToken: usdt,
    initialAmount: 2_000n * WHSK_UNIT,
    minFillAmount: 100n * WHSK_UNIT,
    expiry: longExpiry,
    minDuration: 1_200,
    maxDuration: 86_400,
    basePremiumBps: 5,
    dailyPremiumBps: 5,
    priceMode: PriceMode.FIXED,
    spreadBps: 0,
    oracle: zeroAddress,
    complianceHook: zeroAddress,
    fixedPriceX36: 70n * 10n ** 21n,
    minPriceX36: 0n,
    maxPriceX36: 0n,
  });

  // Offer #7: Expired offer (expiry = now + 10)
  const o7 = await lpClient.createOffer({
    inventoryToken: whsk,
    paymentToken: usdt,
    initialAmount: 2_000n * WHSK_UNIT,
    minFillAmount: 100n * WHSK_UNIT,
    expiry: now + 10,
    minDuration: 60,
    maxDuration: 86_400,
    basePremiumBps: 5,
    dailyPremiumBps: 5,
    priceMode: PriceMode.FIXED,
    spreadBps: 0,
    oracle: zeroAddress,
    complianceHook: zeroAddress,
    fixedPriceX36: 70n * 10n ** 21n,
    minPriceX36: 0n,
    maxPriceX36: 0n,
  });

  // Advance past Offer #7 expiry and refresh pull oracle for Offer #2
  await warpTime(deployment, 12);
  await adminClient.signAndUpdatePullOraclePrice({
    inventoryToken: whsk,
    paymentToken: usdt,
    priceX36: 80n * 10n ** 21n,
  });

  const agent = new TrancheExecutionAgent(trader1Client);
  const intent: AgentIntent = {
    inventoryToken: whsk,
    paymentToken: usdt,
    targetAmount: 1_000n * WHSK_UNIT,
    desiredDuration: 600,
    maxAllInCostX36: 90n * 10n ** 21n,
    minRemainingOfferExpirySec: 3_600,
  };

  const result = await agent.evaluateOffers(intent);
  assert.ok(result.selected, "Expected a selected offer");
  assert.equal(result.selected.offerId, o2.offerId, "FLOATING Offer #2 should rank first");
  assert.equal(result.selected.priceMode, PriceMode.FLOATING);
  assert.ok(
    result.selected.effectiveAllInUnitCostX36 <
      result.evaluations.find((e) => e.offerId === o1.offerId)!.effectiveAllInUnitCostX36,
  );

  // Verify deterministic ineligible rejection reasons
  const byId = new Map(result.evaluations.map((e) => [e.offerId, e]));
  assert.equal(byId.get(o1.offerId)?.eligible, true);
  assert.equal(byId.get(o2.offerId)?.eligible, true);

  assert.equal(byId.get(o3.offerId)?.eligible, false);
  assert.ok(byId.get(o3.offerId)?.rejectionReasons.some((r) => r.startsWith("OfferNotActive")));

  assert.equal(byId.get(o4.offerId)?.eligible, false);
  assert.ok(byId.get(o4.offerId)?.rejectionReasons.some((r) => r.startsWith("InsufficientOfferBalance")));

  assert.equal(byId.get(o5.offerId)?.eligible, false);
  assert.ok(byId.get(o5.offerId)?.rejectionReasons.some((r) => r.startsWith("BelowMinFillAmount")));

  assert.equal(byId.get(o6.offerId)?.eligible, false);
  assert.ok(byId.get(o6.offerId)?.rejectionReasons.some((r) => r.startsWith("InvalidDurationBounds")));

  assert.equal(byId.get(o7.offerId)?.eligible, false);
  assert.ok(byId.get(o7.offerId)?.rejectionReasons.includes("OfferExpired"));

  // Wrong token pair test (swapped inventory/payment tokens)
  const wrongPairResult = await agent.evaluateOffers({
    ...intent,
    inventoryToken: usdt,
    paymentToken: whsk,
  });
  assert.equal(wrongPairResult.selected, null);
  assert.ok(
    wrongPairResult.evaluations.every((e) => e.rejectionReasons.includes("TokenPairMismatch")),
  );
});

test("2. Reservation + 60% partial fill + 40% remaining full fill & expiry reclaim path", async () => {
  const { addresses, accounts } = deployment;
  const whsk = addresses.whsk;
  const usdt = addresses.usdt;

  await warpTime(deployment, 2);
  await adminClient.signAndUpdatePullOraclePrice({
    inventoryToken: whsk,
    paymentToken: usdt,
    priceX36: 80n * 10n ** 21n,
  });

  const agent = new TrancheExecutionAgent(trader1Client);
  const intent: AgentIntent = {
    inventoryToken: whsk,
    paymentToken: usdt,
    targetAmount: 1_000n * WHSK_UNIT,
    desiredDuration: 600,
    maxAllInCostX36: 90n * 10n ** 21n,
  };

  // Reserve Ticket #1 (1,000 WHSK on Offer #2)
  const res1 = await agent.reserveBestOffer(intent, accounts.trader1.address);
  assert.equal(res1.evaluation.offerId, 2n);
  assert.equal(res1.ticketId, 1n);

  // Partial fill: 60% = 600 WHSK
  const partFill = 600n * WHSK_UNIT;
  const qPart = await trader1Client.quoteExercise(res1.ticketId, partFill);
  const exPart = await agent.exerciseTicket(
    res1.ticketId,
    partFill,
    qPart.grossPayment,
    accounts.trader1.address,
  );
  assert.equal(exPart.actualFill, partFill);
  assert.equal(exPart.remainingAfter, 400n * WHSK_UNIT);

  // Full remaining fill via fillAmount === 0n (remaining 400 WHSK)
  const qRem = await trader1Client.quoteExercise(res1.ticketId, 0n);
  const exRem = await agent.exerciseTicket(
    res1.ticketId,
    0n,
    qRem.grossPayment,
    accounts.trader1.address,
  );
  assert.equal(exRem.actualFill, 400n * WHSK_UNIT);
  assert.equal(exRem.remainingAfter, 0n);

  const t1After = await trader1Client.getTicket(res1.ticketId);
  assert.equal(Number(t1After.status), TicketStatus.EXERCISED);

  // Now reserve Ticket #2, partially exercise 60%, and reclaim remaining 40% after expiry
  const res2 = await agent.reserveBestOffer(intent, accounts.trader1.address);
  const qPart2 = await trader1Client.quoteExercise(res2.ticketId, partFill);
  await agent.exerciseTicket(res2.ticketId, partFill, qPart2.grossPayment, accounts.trader1.address);

  const offerBeforeReclaim = await lpClient.getOffer(res2.evaluation.offerId);

  // Before expiry, reclaimIfExpired returns reclaimed: false
  const earlyReclaim = await agent.reclaimIfExpired(res2.ticketId);
  assert.equal(earlyReclaim.reclaimed, false);

  // Warp past 600s duration and reclaim
  await warpTime(deployment, 650);
  const keeperAgent = new TrancheExecutionAgent(keeperClient);
  const reclaimed = await keeperAgent.reclaimIfExpired(res2.ticketId);
  assert.equal(reclaimed.reclaimed, true);
  assert.equal(reclaimed.releasedAmount, 400n * WHSK_UNIT);
  assert.ok(reclaimed.tx?.hash);

  const t2After = await keeperClient.getTicket(res2.ticketId);
  assert.equal(Number(t2After.status), TicketStatus.RECLAIMED);

  const offerAfterReclaim = await lpClient.getOffer(res2.evaluation.offerId);
  assert.equal(
    offerAfterReclaim.availableBalance - offerBeforeReclaim.availableBalance,
    400n * WHSK_UNIT,
  );

  // Verify decision trace captured reservations, exercises, and reclaims
  const trace = agent.getDecisionTrace();
  assert.equal(trace.reservations.length, 2);
  assert.equal(trace.exercises.length, 3);
  assert.equal(keeperAgent.getDecisionTrace().reclaims.length, 1);
});

test("3. Failure handling: maxAllInCost, stale oracle, expired ticket + reclaim, unauthorized, slippage", async () => {
  const { addresses, accounts, publicClient } = deployment;
  const whsk = addresses.whsk;
  const usdt = addresses.usdt;

  // Refresh oracle for fresh state
  await warpTime(deployment, 2);
  await adminClient.signAndUpdatePullOraclePrice({
    inventoryToken: whsk,
    paymentToken: usdt,
    priceX36: 80n * 10n ** 21n,
  });

  const agent = new TrancheExecutionAgent(trader1Client);

  // A. Insufficient capacity across all offers
  await assert.rejects(
    () =>
      agent.reserveBestOffer(
        {
          inventoryToken: whsk,
          paymentToken: usdt,
          targetAmount: 100_000n * WHSK_UNIT,
          desiredDuration: 600,
          maxAllInCostX36: 90n * 10n ** 21n,
        },
        accounts.trader1.address,
      ),
    (err: unknown) => {
      assert.ok(err instanceof TrancheAgentError);
      assert.equal(err.errorName, "NoEligibleOffer");
      return true;
    },
  );

  // B. maxAllInCostX36 enforcement
  await assert.rejects(
    () =>
      agent.reserveBestOffer(
        {
          inventoryToken: whsk,
          paymentToken: usdt,
          targetAmount: 500n * WHSK_UNIT,
          desiredDuration: 600,
          maxAllInCostX36: 50n * 10n ** 21n, // below 0.08 USDT/WHSK
        },
        accounts.trader1.address,
      ),
    (err: unknown) => {
      assert.ok(err instanceof TrancheAgentError);
      assert.equal(err.errorName, "MaxAllInCostExceeded");
      return true;
    },
  );

  // Reserve a fresh ticket on FLOATING Offer #2 (duration 120s) for oracle/auth/slippage/expiry tests
  const res = await agent.reserveBestOffer(
    {
      inventoryToken: whsk,
      paymentToken: usdt,
      targetAmount: 500n * WHSK_UNIT,
      desiredDuration: 120,
      maxAllInCostX36: 90n * 10n ** 21n,
      preferredMode: PriceMode.FLOATING,
    },
    accounts.trader1.address,
  );
  assert.equal(res.evaluation.offerId, 2n);

  // C. Unauthorized exercise by trader2
  const unauthorizedAgent = new TrancheExecutionAgent(trader2Client);
  await assert.rejects(
    () =>
      unauthorizedAgent.exerciseTicket(
        res.ticketId,
        100n * WHSK_UNIT,
        1_000_000n * USDT_UNIT,
        accounts.trader2.address,
      ),
    (err: unknown) => {
      assert.ok(err instanceof TrancheAgentError);
      assert.equal(err.errorName, "Unauthorized");
      assert.equal(err.contract, "CommitmentManager");
      return true;
    },
  );

  // D. SlippageExceeded when maxPaymentIn is too low
  await assert.rejects(
    () => agent.exerciseTicket(res.ticketId, 100n * WHSK_UNIT, 1n, accounts.trader1.address),
    (err: unknown) => {
      assert.ok(err instanceof TrancheAgentError);
      assert.equal(err.errorName, "SlippageExceeded");
      return true;
    },
  );

  // E. Stale oracle (> 30s -> OracleUnavailable)
  await warpTime(deployment, 35);

  // Evaluating FLOATING Offer #2 now marks it ineligible with OracleUnavailable
  const evalStale = await agent.evaluateOffers({
    inventoryToken: whsk,
    paymentToken: usdt,
    targetAmount: 500n * WHSK_UNIT,
    desiredDuration: 120,
    maxAllInCostX36: 90n * 10n ** 21n,
  });
  const offer2Stale = evalStale.evaluations.find((e) => e.offerId === 2n);
  assert.equal(offer2Stale?.eligible, false);
  assert.ok(offer2Stale?.rejectionReasons.includes("OracleUnavailable"));

  // Exercising FLOATING ticket while oracle is stale aborts with OracleUnavailable
  await assert.rejects(
    () =>
      agent.exerciseTicket(
        res.ticketId,
        100n * WHSK_UNIT,
        1_000_000n * USDT_UNIT,
        accounts.trader1.address,
      ),
    (err: unknown) => {
      assert.ok(err instanceof TrancheAgentError);
      assert.equal(err.errorName, "OracleUnavailable");
      assert.equal(err.contract, "CommitmentManager");
      return true;
    },
  );

  // F. Expired ticket exercise failure + reclaim recovery
  await warpTime(deployment, 100); // total 135s > 120s ticket duration
  const blockAfterExpiry = await publicClient.getBlock({ blockTag: "latest" });
  assert.ok(Number(blockAfterExpiry.timestamp) > res.tx.expiresAt);

  await assert.rejects(
    () =>
      agent.exerciseTicket(
        res.ticketId,
        100n * WHSK_UNIT,
        1_000_000n * USDT_UNIT,
        accounts.trader1.address,
      ),
    (err: unknown) => {
      assert.ok(err instanceof TrancheAgentError);
      assert.equal(err.errorName, "TicketExpired");
      return true;
    },
  );

  const keeperAgent = new TrancheExecutionAgent(keeperClient);
  const offer2BeforeRecovery = await lpClient.getOffer(2n);
  const reclaimRes = await keeperAgent.reclaimIfExpired(res.ticketId);
  assert.equal(reclaimRes.reclaimed, true);
  assert.equal(reclaimRes.releasedAmount, 500n * WHSK_UNIT);

  const offer2AfterRecovery = await lpClient.getOffer(2n);
  assert.equal(
    offer2AfterRecovery.availableBalance - offer2BeforeRecovery.availableBalance,
    500n * WHSK_UNIT,
  );

  // Confirm failures were recorded in trace
  const failures = agent.getDecisionTrace().failures;
  assert.ok(failures.some((f) => f.errorName === "OracleUnavailable"));
  assert.ok(failures.some((f) => f.errorName === "TicketExpired"));
  assert.ok(failures.some((f) => f.errorName === "SlippageExceeded"));
  assert.ok(unauthorizedAgent.getDecisionTrace().failures.some((f) => f.errorName === "Unauthorized"));
});
