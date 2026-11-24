import { PriceMode, TrancheClient, deployLocalTrancheStack } from "@tranche/sdk";
import { zeroAddress } from "viem";
import { TrancheAgentError, TrancheExecutionAgent } from "./agent.js";
import { startTempAnvil, stopTempAnvil, warpTime } from "./anvil.js";
import type { AgentIntent } from "./types.js";

const WHSK_UNIT = 10n ** 18n;
const USDT_UNIT = 10n ** 6n;

function stringifyTrace(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}

function formatUsdt(raw: bigint): string {
  const whole = raw / USDT_UNIT;
  const frac = (raw % USDT_UNIT).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

async function main(): Promise<void> {
  const anvil = await startTempAnvil();

  try {
    console.log(`[Tranche Demo] Ephemeral Anvil running at ${anvil.rpcUrl}`);
    const deployment = await deployLocalTrancheStack(anvil.rpcUrl);
    const { addresses, accounts, publicClient } = deployment;

    const adminClient = new TrancheClient({
      publicClient,
      walletClient: accounts.admin.walletClient,
      addresses,
    });
    const lpClient = adminClient.withWalletClient(accounts.lp.walletClient);
    const traderClient = adminClient.withWalletClient(accounts.trader1.walletClient);
    const keeperClient = adminClient.withWalletClient(accounts.keeper.walletClient);

    // 1. LP deposits inventory and posts competing FIXED + FLOATING + ineligible offers
    await lpClient.deposit(addresses.whsk, 20_000n * WHSK_UNIT);

    const initialBlock = await publicClient.getBlock({ blockTag: "latest" });
    const now = Number(initialBlock.timestamp);
    const longExpiry = now + 7 * 86_400;

    // Offer #1: FIXED at 0.083 USDT/WHSK
    await lpClient.createOffer({
      inventoryToken: addresses.whsk,
      paymentToken: addresses.usdt,
      initialAmount: 5_000n * WHSK_UNIT,
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
      fixedPriceX36: 83n * 10n ** 21n,
      minPriceX36: 0n,
      maxPriceX36: 0n,
    });

    // Offer #2: FLOATING at oracle 0.080 + 10 bps spread (lowest effective all-in cost)
    await lpClient.createOffer({
      inventoryToken: addresses.whsk,
      paymentToken: addresses.usdt,
      initialAmount: 5_000n * WHSK_UNIT,
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

    // Offer #3: FIXED with insufficient capacity for 1,000 WHSK intent
    await lpClient.createOffer({
      inventoryToken: addresses.whsk,
      paymentToken: addresses.usdt,
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
      fixedPriceX36: 79n * 10n ** 21n,
      minPriceX36: 0n,
      maxPriceX36: 0n,
    });

    // Offer #4: FIXED that expires before agent evaluation
    await lpClient.createOffer({
      inventoryToken: addresses.whsk,
      paymentToken: addresses.usdt,
      initialAmount: 2_000n * WHSK_UNIT,
      minFillAmount: 100n * WHSK_UNIT,
      expiry: now + 8,
      minDuration: 60,
      maxDuration: 86_400,
      basePremiumBps: 5,
      dailyPremiumBps: 5,
      priceMode: PriceMode.FIXED,
      spreadBps: 0,
      oracle: zeroAddress,
      complianceHook: zeroAddress,
      fixedPriceX36: 78n * 10n ** 21n,
      minPriceX36: 0n,
      maxPriceX36: 0n,
    });

    // Advance chain 12s so Offer #4 expires, and refresh pull oracle for FLOATING Offer #2
    await warpTime(deployment, 12);
    await adminClient.signAndUpdatePullOraclePrice({
      inventoryToken: addresses.whsk,
      paymentToken: addresses.usdt,
      priceX36: 80n * 10n ** 21n,
    });

    const intent: AgentIntent = {
      inventoryToken: addresses.whsk,
      paymentToken: addresses.usdt,
      targetAmount: 1_000n * WHSK_UNIT,
      desiredDuration: 600,
      maxAllInCostX36: 85n * 10n ** 21n, // max 0.085 USDT/WHSK
      minRemainingOfferExpirySec: 3_600,
    };

    const agent = new TrancheExecutionAgent(traderClient);

    // 2. Discover & score offers
    const evalResult = await agent.evaluateOffers(intent);
    console.log("\n=== Offer Evaluation Table ===");
    console.table(
      evalResult.evaluations.map((e) => ({
        offerId: e.offerId.toString(),
        mode: e.priceMode === PriceMode.FIXED ? "FIXED" : "FLOATING",
        eligible: e.eligible,
        capacityWHSK: (e.availableCapacity / WHSK_UNIT).toString(),
        premiumUSDT: formatUsdt(e.quotedGrossPremium),
        exerciseUSDT: formatUsdt(e.quotedExerciseCost),
        unitCostX36: e.effectiveAllInUnitCostX36.toString(),
        rejectionReasons: e.rejectionReasons.join("; ") || "-",
      })),
    );

    // 3. Reserve best offer
    const reservation = await agent.reserveBestOffer(intent, accounts.trader1.address);
    console.log(
      `\n[Reserve] Chosen offer #${reservation.evaluation.offerId} -> ticket #${reservation.ticketId} (tx=${reservation.tx.hash})`,
    );

    // 4. Partial exercise (60% = 600 WHSK)
    const partialAmount = 600n * WHSK_UNIT;
    const quotePartial = await traderClient.quoteExercise(reservation.ticketId, partialAmount);
    const partialExec = await agent.exerciseTicket(
      reservation.ticketId,
      partialAmount,
      quotePartial.grossPayment,
      accounts.trader1.address,
    );
    console.log(
      `[Exercise 60%] Filled ${partialExec.actualFill / WHSK_UNIT} WHSK for ${formatUsdt(partialExec.grossPayment)} USDT, remaining=${partialExec.remainingAfter / WHSK_UNIT} WHSK (tx=${partialExec.tx.hash})`,
    );

    // 5. Simulate expiry failure case + clean error handling
    await warpTime(deployment, 650);
    try {
      await agent.exerciseTicket(
        reservation.ticketId,
        0n,
        1_000_000n * USDT_UNIT,
        accounts.trader1.address,
      );
    } catch (err) {
      if (err instanceof TrancheAgentError) {
        console.log(
          `[Expected Failure Handled] ${err.contract}.${err.errorName}: ${err.message}`,
        );
      } else {
        throw err;
      }
    }

    // 6. Reclaim remaining 40% expired capacity back to Offer #2
    const keeperAgent = new TrancheExecutionAgent(keeperClient);
    const reclaim = await keeperAgent.reclaimIfExpired(reservation.ticketId);
    const offer2After = await lpClient.getOffer(reservation.evaluation.offerId);
    console.log(
      `[Reclaim] reclaimed=${reclaim.reclaimed} released=${reclaim.releasedAmount / WHSK_UNIT} WHSK tx=${reclaim.tx?.hash} -> offer#${offer2After.offerId} available=${offer2After.availableBalance / WHSK_UNIT} WHSK`,
    );

    // 7. Print combined structured decision trace
    const traderTrace = agent.getDecisionTrace();
    const keeperTrace = keeperAgent.getDecisionTrace();
    const fullTrace = {
      ...traderTrace,
      reclaims: keeperTrace.reclaims,
    };

    console.log("\n=== AgentDecisionTrace (JSON) ===");
    console.log(stringifyTrace(fullTrace));
  } finally {
    await stopTempAnvil(anvil.proc);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
