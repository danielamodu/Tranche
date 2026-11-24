import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import test, { after, before } from "node:test";
import { erc20Abi, zeroAddress } from "viem";
import {
  OfferStatus,
  PriceMode,
  TicketStatus,
  TrancheClient,
  decodeTrancheError,
  deployLocalTrancheStack,
  type TrancheDeployment,
} from "../src/index.js";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Failed to allocate free port")));
        return;
      }
      const { port } = addr;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function resolveAnvilBinary(): string {
  const windowsPath = "C:\\Users\\USER\\.foundry\\bin\\anvil.exe";
  if (existsSync(windowsPath)) return windowsPath;
  return "anvil";
}

async function startTempAnvil(): Promise<{ rpcUrl: string; proc: ChildProcess }> {
  const port = await getFreePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const proc = spawn(resolveAnvilBinary(), ["--host", "127.0.0.1", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) {
        return { rpcUrl, proc };
      }
    } catch {
      // Wait for Anvil RPC readiness.
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  proc.kill();
  throw new Error("Timed out waiting for temporary anvil node.");
}

async function stopTempAnvil(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Ignore if already exited.
      }
      resolve();
    }, 2_000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill();
  });
}

async function warpTime(deployment: TrancheDeployment, seconds: number): Promise<bigint> {
  await deployment.publicClient.request({
    method: "evm_increaseTime" as never,
    params: [seconds] as never,
  });
  await deployment.publicClient.request({
    method: "evm_mine" as never,
    params: [] as never,
  });
  const block = await deployment.publicClient.getBlock({ blockTag: "latest" });
  return block.timestamp;
}

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

test("Full happy-path lifecycle: deposit, offers, reserve, transfer, split, partial & batch exercise, expiry reclaim, claimProceeds", async () => {
  const { addresses, accounts, publicClient } = deployment;
  const whsk = addresses.whsk;
  const usdt = addresses.usdt;

  // 1. LP deposits 10,000 WHSK and creates Offer #1 (FIXED)
  const initialDeposit = 10_000n * 10n ** 18n;
  const depositTx = await lpClient.deposit(whsk, initialDeposit);
  assert.equal(depositTx.receipt.status, "success");
  assert.ok(depositTx.gasUsed > 0n);

  const block = await publicClient.getBlock({ blockTag: "latest" });
  const offerExpiry = Number(block.timestamp) + 7 * 86_400;

  const createTx1 = await lpClient.createOffer({
    inventoryToken: whsk,
    paymentToken: usdt,
    initialAmount: 4_000n * 10n ** 18n,
    minFillAmount: 100n * 10n ** 18n,
    expiry: offerExpiry,
    minDuration: 60,
    maxDuration: 86_400,
    basePremiumBps: 10,
    dailyPremiumBps: 20,
    priceMode: PriceMode.FIXED,
    spreadBps: 0,
    oracle: zeroAddress,
    complianceHook: zeroAddress,
    fixedPriceX36: 8n * 10n ** 22n, // 0.08 USDT per WHSK
    minPriceX36: 0n,
    maxPriceX36: 0n,
  });
  assert.equal(createTx1.offerId, 1n);

  // Also test topUpOffer, pauseOffer, unpauseOffer, decreaseOffer, and a second FLOATING offer
  await lpClient.topUpOffer(createTx1.offerId, 1_000n * 10n ** 18n);
  await lpClient.pauseOffer(createTx1.offerId);
  let offer1 = await lpClient.getOffer(createTx1.offerId);
  assert.equal(Number(offer1.status), OfferStatus.PAUSED);
  await lpClient.unpauseOffer(createTx1.offerId);
  await lpClient.decreaseOffer(createTx1.offerId, 500n * 10n ** 18n);
  offer1 = await lpClient.getOffer(createTx1.offerId);
  assert.equal(Number(offer1.status), OfferStatus.ACTIVE);
  assert.equal(offer1.availableBalance, 4_500n * 10n ** 18n);

  // Create Offer #2 (FLOATING via OraclePriceAdapter)
  await warpTime(deployment, 2);
  await adminClient.signAndUpdatePullOraclePrice({
    inventoryToken: whsk,
    paymentToken: usdt,
    priceX36: 8n * 10n ** 22n,
  });
  const createTx2 = await lpClient.createOffer({
    inventoryToken: whsk,
    paymentToken: usdt,
    initialAmount: 2_000n * 10n ** 18n,
    minFillAmount: 100n * 10n ** 18n,
    expiry: offerExpiry,
    minDuration: 60,
    maxDuration: 86_400,
    basePremiumBps: 10,
    dailyPremiumBps: 10,
    priceMode: PriceMode.FLOATING,
    spreadBps: 25,
    oracle: addresses.oraclePriceAdapter,
    complianceHook: zeroAddress,
    fixedPriceX36: 0n,
    minPriceX36: 10n ** 18n,
    maxPriceX36: 10n ** 26n,
  });
  assert.equal(createTx2.offerId, 2n);

  // 2. Discover offers
  const offers = await trader1Client.discoverOffers();
  assert.equal(offers.length, 2);
  assert.equal(offers[0].offerId, 1n);
  assert.equal(offers[0].availableBalance, 4_500n * 10n ** 18n);
  assert.equal(offers[1].offerId, 2n);
  assert.equal(offers[1].availableBalance, 2_000n * 10n ** 18n);

  // 3. Reserve Ticket #1 from Offer #1 and Ticket #2 from Offer #2
  const resQuote1 = await trader1Client.quoteReservation(1n, 1_000n * 10n ** 18n, 600);
  assert.ok(resQuote1.grossPremium > 0n);
  const reserveTx1 = await trader1Client.reserve(
    1n,
    1_000n * 10n ** 18n,
    600,
    resQuote1.grossPremium,
    accounts.trader1.address,
  );
  assert.equal(reserveTx1.ticketId, 1n);

  const resQuote2 = await trader1Client.quoteReservation(2n, 500n * 10n ** 18n, 600);
  const reserveTx2 = await trader1Client.reserve(
    2n,
    500n * 10n ** 18n,
    600,
    resQuote2.grossPremium,
    accounts.trader1.address,
  );
  assert.equal(reserveTx2.ticketId, 2n);

  // 4. Transfer Ticket #1 from trader1 -> trader2
  await trader1Client.transferTicket(accounts.trader1.address, accounts.trader2.address, 1n);
  const ticket1AfterTransfer = await trader2Client.getTicket(1n);
  assert.equal(ticket1AfterTransfer.owner?.toLowerCase(), accounts.trader2.address.toLowerCase());

  // 5. Split Ticket #1 (1000 WHSK -> 600 remaining on #1, 400 on #3 to trader2)
  const splitTx = await trader2Client.splitTicket(1n, 400n * 10n ** 18n, accounts.trader2.address);
  assert.equal(splitTx.newTicketId, 3n);

  const discoveredTickets = await trader2Client.discoverTickets({ activeOnly: true });
  assert.equal(discoveredTickets.length, 3);

  // 6. Partial exercise on Ticket #1 (exercise 250 of 600 WHSK)
  const exQuote1 = await trader2Client.quoteExercise(1n, 250n * 10n ** 18n);
  const exTx1 = await trader2Client.exercise(
    1n,
    250n * 10n ** 18n,
    exQuote1.grossPayment,
    accounts.trader2.address,
  );
  assert.equal(exTx1.actualFill, 250n * 10n ** 18n);
  const t1AfterPartial = await trader2Client.getTicket(1n);
  assert.equal(t1AfterPartial.remainingAmount, 350n * 10n ** 18n);
  assert.equal(Number(t1AfterPartial.status), TicketStatus.ACTIVE);

  // 7. Batch exercise via ExecutionRouter:
  // Transfer Ticket #2 to trader2 so trader2 owns both Ticket #2 (500 WHSK) and Ticket #3 (400 WHSK)
  await trader1Client.transferTicket(accounts.trader1.address, accounts.trader2.address, 2n);
  await trader2Client.approveTicketNftAll(addresses.executionRouter, true);

  // Refresh pull oracle so FLOATING Ticket #2 stays fresh
  await warpTime(deployment, 2);
  await adminClient.signAndUpdatePullOraclePrice({
    inventoryToken: whsk,
    paymentToken: usdt,
    priceX36: 8n * 10n ** 22n,
  });

  const qLeg2 = await trader2Client.quoteExercise(2n, 200n * 10n ** 18n);
  const qLeg3 = await trader2Client.quoteExercise(3n, 0n); // 0 = full remaining 400 WHSK
  const latest = await publicClient.getBlock({ blockTag: "latest" });
  const batchTx = await trader2Client.batchExercise({
    inventoryToken: whsk,
    paymentToken: usdt,
    minTotalInventoryOut: 600n * 10n ** 18n,
    maxTotalPaymentIn: qLeg2.grossPayment + qLeg3.grossPayment,
    deadline: latest.timestamp + 300n,
    receiver: accounts.trader2.address,
    unwrapInventoryToNative: false,
    legs: [
      {
        ticketId: 2n,
        fillAmount: 200n * 10n ** 18n,
        maxLegPaymentIn: qLeg2.grossPayment,
      },
      {
        ticketId: 3n,
        fillAmount: 0n,
        maxLegPaymentIn: qLeg3.grossPayment,
      },
    ],
  });
  assert.equal(batchTx.totalInventoryOut, 600n * 10n ** 18n);
  assert.equal(batchTx.totalPaymentIn, qLeg2.grossPayment + qLeg3.grossPayment);

  const t3AfterBatch = await trader2Client.getTicket(3n);
  assert.equal(Number(t3AfterBatch.status), TicketStatus.EXERCISED);
  assert.equal(t3AfterBatch.owner, null);

  // 8. Warp time past ticket expiry (600s) and reclaim Ticket #1 (350 remaining) and Ticket #2 (300 remaining)
  await warpTime(deployment, 650);
  await keeperClient.reclaimExpired(1n);
  const t1Reclaimed = await keeperClient.getTicket(1n);
  assert.equal(Number(t1Reclaimed.status), TicketStatus.RECLAIMED);

  await keeperClient.reclaimExpiredBatch([2n]);
  const t2Reclaimed = await keeperClient.getTicket(2n);
  assert.equal(Number(t2Reclaimed.status), TicketStatus.RECLAIMED);

  const offer1AfterReclaim = await lpClient.getOffer(1n);
  // 4500 - 1000 + 350 reclaimed = 3850 WHSK
  assert.equal(offer1AfterReclaim.availableBalance, 3_850n * 10n ** 18n);

  // 9. Verify vault accounting & LP claimProceeds
  const usdtVaultBeforeClaim = await lpClient.getVaultState(usdt, accounts.lp.address);
  assert.ok((usdtVaultBeforeClaim.lpPendingProceeds ?? 0n) > 0n);

  const lpUsdtBefore = (await publicClient.readContract({
    address: usdt,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [accounts.lp.address],
  })) as bigint;

  await lpClient.claimProceeds(usdt, 0n, accounts.lp.address);

  const lpUsdtAfter = (await publicClient.readContract({
    address: usdt,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [accounts.lp.address],
  })) as bigint;
  assert.equal(lpUsdtAfter - lpUsdtBefore, usdtVaultBeforeClaim.lpPendingProceeds);

  const usdtVaultAfterClaim = await lpClient.getVaultState(usdt, accounts.lp.address);
  assert.equal(usdtVaultAfterClaim.lpPendingProceeds, 0n);
});

test("Error decoding & negative paths", async () => {
  const { addresses, accounts, publicClient } = deployment;
  const whsk = addresses.whsk;
  const usdt = addresses.usdt;

  // Refresh oracle price for new setup
  await warpTime(deployment, 2);
  await adminClient.signAndUpdatePullOraclePrice({
    inventoryToken: whsk,
    paymentToken: usdt,
    priceX36: 8n * 10n ** 22n,
  });

  // Create a dedicated short-lived offer (#3) for negative tests
  const block = await publicClient.getBlock({ blockTag: "latest" });
  const shortExpiry = Number(block.timestamp) + 200;
  const offer3Tx = await lpClient.createOffer({
    inventoryToken: whsk,
    paymentToken: usdt,
    initialAmount: 300n * 10n ** 18n,
    minFillAmount: 100n * 10n ** 18n,
    expiry: shortExpiry,
    minDuration: 60,
    maxDuration: 300,
    basePremiumBps: 10,
    dailyPremiumBps: 10,
    priceMode: PriceMode.FLOATING,
    spreadBps: 0,
    oracle: addresses.oraclePriceAdapter,
    complianceHook: zeroAddress,
    fixedPriceX36: 0n,
    minPriceX36: 10n ** 18n,
    maxPriceX36: 10n ** 26n,
  });
  const offer3Id = offer3Tx.offerId;

  // 1. Insufficient offer balance
  await assert.rejects(
    async () => {
      await trader1Client.reserve(offer3Id, 500n * 10n ** 18n, 60, 1_000_000n * 10n ** 6n, accounts.trader1.address);
    },
    (err) => {
      const decoded = decodeTrancheError(err);
      assert.equal(decoded.contract, "CommitmentManager");
      assert.equal(decoded.errorName, "InsufficientOfferBalance");
      return true;
    },
  );

  // Reserve a valid ticket (#4) with 60s duration while oracle is fresh
  const quote4 = await trader1Client.quoteReservation(offer3Id, 200n * 10n ** 18n, 60);
  const reserve4Tx = await trader1Client.reserve(
    offer3Id,
    200n * 10n ** 18n,
    60,
    quote4.grossPremium,
    accounts.trader1.address,
  );
  const ticket4Id = reserve4Tx.ticketId;

  // 2. Unauthorized exercise (trader2 does not own or have approval for ticket #4)
  await assert.rejects(
    async () => {
      await trader2Client.exercise(ticket4Id, 100n * 10n ** 18n, 1_000_000n * 10n ** 6n, accounts.trader2.address);
    },
    (err) => {
      const decoded = decodeTrancheError(err);
      assert.equal(decoded.contract, "CommitmentManager");
      assert.equal(decoded.errorName, "Unauthorized");
      return true;
    },
  );

  // 3. Router confused-deputy attack (trader2 calls ExecutionRouter on trader1's ticket #4)
  await assert.rejects(
    async () => {
      const nowBlock = await publicClient.getBlock({ blockTag: "latest" });
      await trader2Client.batchExercise({
        inventoryToken: whsk,
        paymentToken: usdt,
        minTotalInventoryOut: 100n * 10n ** 18n,
        maxTotalPaymentIn: 100n * 10n ** 6n,
        deadline: nowBlock.timestamp + 300n,
        receiver: accounts.trader2.address,
        unwrapInventoryToNative: false,
        legs: [
          {
            ticketId: ticket4Id,
            fillAmount: 100n * 10n ** 18n,
            maxLegPaymentIn: 100n * 10n ** 6n,
          },
        ],
      });
    },
    (err) => {
      const decoded = decodeTrancheError(err);
      assert.equal(decoded.contract, "ExecutionRouter");
      assert.equal(decoded.errorName, "NotTicketAuthorized");
      return true;
    },
  );

  // 4. Stale oracle (> 30s -> OracleUnavailable)
  await warpTime(deployment, 35);
  await assert.rejects(
    async () => {
      await trader1Client.exercise(ticket4Id, 100n * 10n ** 18n, 1_000_000n * 10n ** 6n, accounts.trader1.address);
    },
    (err) => {
      const decoded = decodeTrancheError(err);
      assert.equal(decoded.contract, "CommitmentManager");
      assert.equal(decoded.errorName, "OracleUnavailable");
      return true;
    },
  );

  // 5. Expired ticket exercise (TicketExpired, warp another 40s so total > 60s duration)
  await warpTime(deployment, 40);
  await assert.rejects(
    async () => {
      await trader1Client.exercise(ticket4Id, 100n * 10n ** 18n, 1_000_000n * 10n ** 6n, accounts.trader1.address);
    },
    (err) => {
      const decoded = decodeTrancheError(err);
      assert.equal(decoded.contract, "CommitmentManager");
      assert.equal(decoded.errorName, "TicketExpired");
      return true;
    },
  );

  // 6. Expired offer reservation (OfferExpired, warp past shortExpiry = 200s)
  await warpTime(deployment, 150);
  await assert.rejects(
    async () => {
      await trader1Client.reserve(offer3Id, 100n * 10n ** 18n, 60, 1_000_000n * 10n ** 6n, accounts.trader1.address);
    },
    (err) => {
      const decoded = decodeTrancheError(err);
      assert.equal(decoded.contract, "CommitmentManager");
      assert.equal(decoded.errorName, "OfferExpired");
      return true;
    },
  );
});
