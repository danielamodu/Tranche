import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { startDemoServer, type StartedDemoServer } from "../src/server.js";

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

let demo: StartedDemoServer;

async function postJson<T = Record<string, unknown>>(
  pathname: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${demo.baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T;
  return { status: res.status, data };
}

async function getJson<T = Record<string, unknown>>(pathname: string): Promise<{ status: number; data: T }> {
  const res = await fetch(`${demo.baseUrl}${pathname}`);
  const data = (await res.json()) as T;
  return { status: res.status, data };
}

before(async () => {
  demo = await startDemoServer({ port: 0 });
});

after(async () => {
  if (demo) {
    await demo.close();
  }
});

test("Serves static dashboard assets without prohibited branding", async () => {
  const htmlRes = await fetch(`${demo.baseUrl}/`);
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();
  assert.match(html, /Tranche/);
  assert.doesNotMatch(html, /Negotiated Liquidity/i);

  const jsRes = await fetch(`${demo.baseUrl}/app.js`);
  assert.equal(jsRes.status, 200);
  const cssRes = await fetch(`${demo.baseUrl}/styles.css`);
  assert.equal(cssRes.status, 200);
});

test("Executes full 6-step Tranche journey sequentially via HTTP /api/* and verifies INV-1", async () => {
  const initial = await getJson<{ ok: boolean; state: any }>("/api/state");
  assert.equal(initial.status, 200);
  assert.equal(initial.data.ok, true);
  assert.equal(initial.data.state.projectName, "Tranche");
  assert.equal(initial.data.state.hspStatus.activeMode, "LOCAL_EIP712_COMPLIANCE");
  assert.equal(initial.data.state.hspStatus.liveCaasReport.verificationStatus, "BLOCKED");
  assert.equal(initial.data.state.vault.inv1Verified, true);

  // Step 1: LP supplies inventory & creates FIXED offer
  const s1 = await postJson<{ ok: boolean; stepResult: any; state: any }>("/api/step/1", {
    priceMode: "FIXED",
  });
  assert.equal(s1.status, 200);
  assert.equal(s1.data.ok, true);
  assert.equal(s1.data.stepResult.offerId, "1");
  assert.match(s1.data.stepResult.transactions.attestation.txHash, TX_HASH_RE);
  assert.match(s1.data.stepResult.transactions.deposit.txHash, TX_HASH_RE);
  assert.match(s1.data.stepResult.transactions.createOffer.txHash, TX_HASH_RE);
  assert.equal(s1.data.state.vault.whsk.totalLpFreeFormatted, "5000");
  assert.equal(s1.data.state.vault.whsk.totalOfferAvailableFormatted, "5000");

  // Step 2: Trader / agent discovers offers
  const s2 = await postJson<{ ok: boolean; stepResult: any; state: any }>("/api/step/2");
  assert.equal(s2.status, 200);
  assert.equal(s2.data.stepResult.offersCount, 1);
  assert.equal(s2.data.stepResult.selectedOfferId, "1");
  assert.equal(s2.data.stepResult.mode, "FIXED");
  assert.equal(s2.data.stepResult.availableCapacityWhsk, "5000");
  assert.ok(BigInt(s2.data.stepResult.plannedReservation.grossPremiumRaw) > 0n);

  // Step 3: Trader 1 reserves capacity & receives ERC-721 ticket
  const s3 = await postJson<{ ok: boolean; stepResult: any; state: any }>("/api/step/3");
  assert.equal(s3.status, 200);
  assert.equal(s3.data.stepResult.ticketId, "1");
  assert.match(s3.data.stepResult.transactions.attestation.txHash, TX_HASH_RE);
  assert.match(s3.data.stepResult.transactions.reserve.txHash, TX_HASH_RE);
  assert.equal(s3.data.stepResult.bucketShiftWhsk.offerAvailableBefore, "5000");
  assert.equal(s3.data.stepResult.bucketShiftWhsk.offerAvailableAfter, "4000");
  assert.equal(s3.data.stepResult.bucketShiftWhsk.ticketReservedBefore, "0");
  assert.equal(s3.data.stepResult.bucketShiftWhsk.ticketReservedAfter, "1000");

  const trader1Addr = s3.data.state.actors.find((a: any) => a.role === "trader1").address;
  const trader2Addr = s3.data.state.actors.find((a: any) => a.role === "trader2").address;
  assert.equal(s3.data.stepResult.owner.toLowerCase(), trader1Addr.toLowerCase());

  // Step 4: Ticket transferred from Trader 1 -> Trader 2
  const s4 = await postJson<{ ok: boolean; stepResult: any; state: any }>("/api/step/4");
  assert.equal(s4.status, 200);
  assert.match(s4.data.stepResult.transactions.attestation.txHash, TX_HASH_RE);
  assert.match(s4.data.stepResult.transactions.transferFrom.txHash, TX_HASH_RE);
  assert.equal(s4.data.stepResult.verifiedOwner.toLowerCase(), trader2Addr.toLowerCase());
  assert.equal(s4.data.state.tickets[0].owner.toLowerCase(), trader2Addr.toLowerCase());

  // Step 5: Trader 2 exercises 60% partial fill (600 WHSK)
  const s5 = await postJson<{ ok: boolean; stepResult: any; state: any }>("/api/step/5", {
    fillPercent: 60,
  });
  assert.equal(s5.status, 200);
  assert.match(s5.data.stepResult.transactions.exercise.txHash, TX_HASH_RE);
  assert.equal(s5.data.stepResult.actualFillWhsk, "600");
  assert.equal(s5.data.stepResult.remainingAmountWhsk, "400");
  assert.equal(s5.data.stepResult.trader2WhskReceived, "600");
  assert.equal(s5.data.stepResult.grossPaymentUsdt, "48");
  assert.equal(s5.data.stepResult.settlementReceipt.status, "SETTLED_ONCHAIN");
  assert.equal(
    s5.data.stepResult.settlementReceipt.txHash,
    s5.data.stepResult.transactions.exercise.txHash,
  );
  assert.equal(s5.data.state.tickets[0].status, "ACTIVE");

  // Step 6: Warp time, reclaim expired ticket, LP claims proceeds, verify INV-1
  const s6 = await postJson<{ ok: boolean; stepResult: any; state: any }>("/api/step/6");
  assert.equal(s6.status, 200);
  assert.match(s6.data.stepResult.transactions.reclaimExpired.txHash, TX_HASH_RE);
  assert.match(s6.data.stepResult.transactions.claimProceeds.txHash, TX_HASH_RE);
  assert.equal(s6.data.stepResult.ticketStatusAfter, "RECLAIMED");
  assert.equal(s6.data.stepResult.nftBurned, true);
  assert.equal(s6.data.stepResult.reclaimedWhsk, "400");
  assert.equal(s6.data.stepResult.offerAvailableBeforeWhsk, "4000");
  assert.equal(s6.data.stepResult.offerAvailableAfterWhsk, "4400");
  assert.equal(s6.data.stepResult.inv1Solvent, true);
  assert.equal(s6.data.state.vault.inv1Verified, true);
  assert.equal(s6.data.state.vault.usdt.lpPendingProceeds, "0");

  // Verify every logged transaction has a valid 66-char 0x hash
  assert.ok(s6.data.state.evidenceLog.length >= 8);
  for (const ev of s6.data.state.evidenceLog) {
    assert.match(ev.txHash, TX_HASH_RE);
    assert.ok(BigInt(ev.blockNumber) > 0n);
    assert.ok(BigInt(ev.gasUsed) > 0n);
  }
});

test("Reset and /api/run-all also succeed end-to-end in FLOATING price mode", async () => {
  const resetRes = await postJson<{ ok: boolean; state: any }>("/api/reset");
  assert.equal(resetRes.status, 200);
  assert.equal(resetRes.data.state.completedSteps.length, 0);

  const runAllRes = await postJson<{ ok: boolean; results: any[]; state: any }>("/api/run-all", {
    priceMode: "FLOATING",
    fillPercent: 60,
  });
  assert.equal(runAllRes.status, 200);
  assert.equal(runAllRes.data.results.length, 6);
  assert.equal(runAllRes.data.state.selectedPriceMode, "FLOATING");
  assert.equal(runAllRes.data.state.allCompleted, true);
  assert.equal(runAllRes.data.state.vault.inv1Verified, true);
});
