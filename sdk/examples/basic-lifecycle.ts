import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { zeroAddress } from "viem";
import {
  PriceMode,
  TrancheClient,
  deployLocalTrancheStack,
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

async function startTempAnvil(): Promise<{ rpcUrl: string; stop: () => Promise<void> }> {
  const port = await getFreePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn(resolveAnvilBinary(), ["--host", "127.0.0.1", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const start = Date.now();
  while (Date.now() - start < 10_000) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) {
        return {
          rpcUrl,
          stop: async () => {
            if (!proc.killed) {
              proc.kill("SIGKILL");
            }
          },
        };
      }
    } catch {
      // Wait for Anvil to listen.
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  proc.kill("SIGKILL");
  throw new Error("Timed out waiting for temporary anvil instance.");
}

async function main() {
  const externalRpc = process.env.TRANCHE_RPC_URL;
  const anvil = externalRpc ? null : await startTempAnvil();
  const rpcUrl = externalRpc ?? anvil!.rpcUrl;

  try {
    console.log(`Deploying Tranche stack to ${rpcUrl}...`);
    const deployment = await deployLocalTrancheStack(rpcUrl);
    const { addresses, accounts, publicClient } = deployment;

    const lpClient = new TrancheClient({
      publicClient,
      walletClient: accounts.lp.walletClient,
      addresses,
    });
    const trader1Client = lpClient.withWalletClient(accounts.trader1.walletClient);
    const trader2Client = lpClient.withWalletClient(accounts.trader2.walletClient);
    const keeperClient = lpClient.withWalletClient(accounts.keeper.walletClient);

    // 1. LP deposits 5,000 WHSK and creates a FIXED-price offer
    const depositAmount = 5_000n * 10n ** 18n;
    await lpClient.deposit(addresses.whsk, depositAmount);

    const latestBlock = await publicClient.getBlock({ blockTag: "latest" });
    const offerTx = await lpClient.createOffer({
      inventoryToken: addresses.whsk,
      paymentToken: addresses.usdt,
      initialAmount: depositAmount,
      minFillAmount: 100n * 10n ** 18n,
      expiry: Number(latestBlock.timestamp) + 7 * 86_400,
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
    console.log(`Created Offer #${offerTx.offerId} (tx ${offerTx.hash})`);

    // 2. Discover offers
    const offers = await trader1Client.discoverOffers();
    console.log(`Discovered ${offers.length} offer(s); Offer #1 availableBalance=${offers[0].availableBalance}`);

    // 3. Trader1 quotes and reserves 1,000 WHSK for 300 seconds
    const reserveAmount = 1_000n * 10n ** 18n;
    const duration = 300;
    const quote = await trader1Client.quoteReservation(offerTx.offerId, reserveAmount, duration);
    const reserveTx = await trader1Client.reserve(
      offerTx.offerId,
      reserveAmount,
      duration,
      quote.grossPremium,
      accounts.trader1.address,
    );
    console.log(`Reserved Ticket #${reserveTx.ticketId} (grossPremium=${reserveTx.grossPremium})`);

    // 4. Trader1 transfers Ticket to Trader2
    await trader1Client.transferTicket(
      accounts.trader1.address,
      accounts.trader2.address,
      reserveTx.ticketId,
    );
    const transferred = await trader2Client.getTicket(reserveTx.ticketId);
    console.log(`Ticket #${reserveTx.ticketId} owner is now ${transferred.owner}`);

    // 5. Trader2 partially exercises 400 WHSK
    const partialFill = 400n * 10n ** 18n;
    const exQuote = await trader2Client.quoteExercise(reserveTx.ticketId, partialFill);
    const exTx = await trader2Client.exercise(
      reserveTx.ticketId,
      partialFill,
      exQuote.grossPayment,
      accounts.trader2.address,
    );
    console.log(`Partially exercised ${exTx.actualFill} WHSK for ${exTx.grossPayment} USDT`);

    // 6. Warp past ticket expiry and permissionlessly reclaim remaining 600 WHSK
    await publicClient.request({
      method: "evm_increaseTime" as never,
      params: [duration + 10] as never,
    });
    await publicClient.request({
      method: "evm_mine" as never,
      params: [] as never,
    });

    await keeperClient.reclaimExpired(reserveTx.ticketId);
    const offerAfterReclaim = await lpClient.getOffer(offerTx.offerId);
    console.log(`After reclaim, Offer #${offerTx.offerId} availableBalance=${offerAfterReclaim.availableBalance}`);

    // 7. LP claims proceeds
    const vaultState = await lpClient.getVaultState(addresses.usdt, accounts.lp.address);
    console.log(`LP pending USDT proceeds: ${vaultState.lpPendingProceeds}`);
    if ((vaultState.lpPendingProceeds ?? 0n) > 0n) {
      await lpClient.claimProceeds(addresses.usdt, 0n, accounts.lp.address);
      console.log("LP claimed all USDT proceeds.");
    }
  } finally {
    if (anvil) {
      await anvil.stop();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
