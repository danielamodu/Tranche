import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ABIS,
  ANVIL_PRIVATE_KEYS,
  PriceMode,
  TicketStatus,
  TrancheClient,
  deployLocalTrancheStack,
} from "@tranche/sdk";
import { FailoverRpcPool } from "../src/rpc-failover.js";
import { signQuorumPriceReport, submitQuorumPriceUpdate } from "../src/oracle-quorum.js";
import { runSoakLoop } from "../src/soak-runner.js";
import { runLiveLifecycle } from "../src/live-lifecycle.js";

async function startAnvil(): Promise<{ proc: ChildProcess; rpcUrl: string }> {
  const port = 19545 + Math.floor(Math.random() * 1000);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const proc = spawn("anvil", ["--port", String(port), "--silent"], {
    stdio: "ignore",
    windowsHide: true,
  });

  const probe = createPublicClient({ transport: http(rpcUrl) });
  for (let i = 0; i < 40; i++) {
    try {
      await probe.getChainId();
      return { proc, rpcUrl };
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  proc.kill();
  throw new Error("Timed out waiting for Anvil");
}

test("1. FailoverRpcPool switches on HTTP 503/429 outages and recovers after cooldown", async () => {
  let simTime = 1_000_000;
  let primaryHealthy = false;
  let secondaryHealthy = true;

  const pool = new FailoverRpcPool({
    urls: ["https://primary.rpc.local", "https://secondary.rpc.local"],
    cooldownMs: 10_000,
    now: () => simTime,
    requester: async (url, method) => {
      if (url.includes("primary")) {
        if (!primaryHealthy) throw new Error("HTTP_503:Service Unavailable");
        return `${method}:primary_ok`;
      }
      if (!secondaryHealthy) throw new Error("HTTP_429:Too Many Requests");
      return `${method}:secondary_ok`;
    },
  });

  // Primary down -> automatically fails over to secondary
  const r1 = await pool.request("eth_blockNumber");
  assert.equal(r1, "eth_blockNumber:secondary_ok");
  assert.equal(pool.getActiveUrl(), "https://secondary.rpc.local");
  assert.equal(pool.health[0].failures, 1);
  assert.equal(pool.health[1].successes, 1);
  assert.ok(pool.events.length >= 1);

  // Secondary stays healthy for subsequent calls
  const r2 = await pool.request("eth_chainId");
  assert.equal(r2, "eth_chainId:secondary_ok");

  // Advance past cooldown, bring primary back and degrade secondary -> recovers cleanly back to primary
  simTime += 15_000;
  primaryHealthy = true;
  secondaryHealthy = false;

  const r3 = await pool.request("eth_blockNumber");
  assert.equal(r3, "eth_blockNumber:primary_ok");
  assert.equal(pool.getActiveUrl(), "https://primary.rpc.local");
});

test("2. M-of-N oracle quorum signing (out-of-order keys) & 2-cycle soak runner with keeper reclaim", async () => {
  const { proc, rpcUrl } = await startAnvil();
  const tempDir = await mkdtemp(join(tmpdir(), "tranche-ops-"));
  try {
    const dep = await deployLocalTrancheStack(rpcUrl);
    const admin = dep.accounts.admin;
    const lp = dep.accounts.lp;
    const trader = dep.accounts.trader1;
    const keeper = dep.accounts.keeper;

    // Configure 2-of-3 quorum on SignedPullOracle (admin = signer 0 is already active, add signer 1 & 2, threshold = 2)
    const signerKeys = [
      ANVIL_PRIVATE_KEYS[0],
      ANVIL_PRIVATE_KEYS[2],
      ANVIL_PRIVATE_KEYS[3],
    ] as const;

    for (const pk of [ANVIL_PRIVATE_KEYS[2], ANVIL_PRIVATE_KEYS[3]]) {
      const addr = privateKeyToAccount(pk).address;
      const hash = await admin.walletClient.writeContract({
        account: admin.walletClient.account!,
        chain: admin.walletClient.chain,
        address: dep.addresses.signedPullOracle,
        abi: ABIS.SignedPullOracle,
        functionName: "addSigner",
        args: [addr],
      });
      await dep.publicClient.waitForTransactionReceipt({ hash });
    }

    const threshHash = await admin.walletClient.writeContract({
      account: admin.walletClient.account!,
      chain: admin.walletClient.chain,
      address: dep.addresses.signedPullOracle,
      abi: ABIS.SignedPullOracle,
      functionName: "setThreshold",
      args: [2n],
    });
    await dep.publicClient.waitForTransactionReceipt({ hash: threshHash });

    // Submit 2-of-3 quorum update with deliberately unsorted key order; helper must sort ascending
    const priceX36 = 81_000n * 10n ** 18n;
    const latest = await dep.publicClient.getBlock({ blockTag: "latest" });
    const signed = await signQuorumPriceReport({
      chainId: dep.chainId,
      pullOracleAddress: dep.addresses.signedPullOracle,
      inventoryToken: dep.addresses.whsk,
      paymentToken: dep.addresses.usdt,
      priceX36,
      reportTimestamp: latest.timestamp + 1n,
      signerPrivateKeys: [signerKeys[2], signerKeys[0]],
    });
    assert.ok(
      BigInt(signed.signerAddresses[0].toLowerCase()) <
        BigInt(signed.signerAddresses[1].toLowerCase()),
    );

    // Ensure chain timestamp >= reportTimestamp before submitting
    await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "evm_setNextBlockTimestamp",
        params: [Number(latest.timestamp + 2n)],
      }),
    });
    await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "evm_mine", params: [] }),
    });

    // Insufficient quorum preflight rejects 1-of-2
    await assert.rejects(
      submitQuorumPriceUpdate({
        publicClient: dep.publicClient,
        submitterWalletClient: admin.walletClient,
        pullOracleAddress: dep.addresses.signedPullOracle,
        inventoryToken: dep.addresses.whsk,
        paymentToken: dep.addresses.usdt,
        priceX36,
        signerPrivateKeys: [signerKeys[0]],
      }),
      /InsufficientSignatures/,
    );

    // Valid 2-of-3 quorum succeeds
    const updateRes = await submitQuorumPriceUpdate({
      publicClient: dep.publicClient,
      submitterWalletClient: admin.walletClient,
      pullOracleAddress: dep.addresses.signedPullOracle,
      inventoryToken: dep.addresses.whsk,
      paymentToken: dep.addresses.usdt,
      priceX36,
      signerPrivateKeys: [signerKeys[2], signerKeys[0]],
    });
    assert.ok(updateRes.txHash.startsWith("0x"));

    // Create an offer & reserve a short-lived ticket, then expire it for soak keeper reclamation
    const lpClient = new TrancheClient({
      publicClient: dep.publicClient,
      walletClient: lp.walletClient,
      addresses: dep.addresses,
    });
    const traderClient = new TrancheClient({
      publicClient: dep.publicClient,
      walletClient: trader.walletClient,
      addresses: dep.addresses,
    });
    await lpClient.deposit(dep.addresses.whsk, parseUnits("500", 18));
    const nowBlock = await dep.publicClient.getBlock({ blockTag: "latest" });
    const { offerId } = await lpClient.createOffer({
      inventoryToken: dep.addresses.whsk,
      paymentToken: dep.addresses.usdt,
      initialAmount: parseUnits("500", 18),
      minFillAmount: parseUnits("100", 18),
      expiry: Number(nowBlock.timestamp + 3600n),
      minDuration: 60,
      maxDuration: 600,
      basePremiumBps: 50,
      dailyPremiumBps: 0,
      priceMode: PriceMode.FIXED,
      spreadBps: 0,
      oracle: "0x0000000000000000000000000000000000000000",
      complianceHook: "0x0000000000000000000000000000000000000000",
      fixedPriceX36: priceX36,
      minPriceX36: 0n,
      maxPriceX36: 0n,
    });

    const { ticketId } = await traderClient.reserve(
      offerId,
      parseUnits("200", 18),
      60,
      parseUnits("20", 6),
      trader.address,
    );

    // Advance chain time past ticket expiry (61s)
    await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "evm_increaseTime",
        params: [120],
      }),
    });
    await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "evm_mine", params: [] }),
    });

    // Run 2 soak cycles with unreachable primary RPC + real Anvil secondary RPC to prove live failover inside soak!
    const telemetryPath = join(tempDir, "soak.jsonl");
    const history = await runSoakLoop({
      rpcUrls: ["http://127.0.0.1:19999", rpcUrl],
      chainId: dep.chainId,
      addresses: dep.addresses,
      tokens: [
        { symbol: "WHSK", address: dep.addresses.whsk, decimals: 18 },
        { symbol: "USDT", address: dep.addresses.usdt, decimals: 6 },
      ],
      pairs: [
        {
          label: "WHSK/USDT",
          inventoryToken: dep.addresses.whsk,
          paymentToken: dep.addresses.usdt,
        },
      ],
      keeperPrivateKey: ANVIL_PRIVATE_KEYS[4],
      intervalMs: 10,
      maxCycles: 2,
      telemetryLogPath: telemetryPath,
    });

    assert.equal(history.length, 2);
    assert.equal(history[0].invariantsPassed, true);
    assert.equal(history[0].activeRpcUrl, rpcUrl);
    assert.ok(history[0].failoverEventsCount >= 1);
    assert.equal(history[0].expiredReclaimableTickets, 1);
    assert.equal(history[0].reclaimedCount, 1);
    assert.ok(history[0].reclaimTxHash);
    assert.equal(history[1].expiredReclaimableTickets, 0);
    assert.equal(history[1].invariantsPassed, true);

    const ticketAfter = await lpClient.getTicket(ticketId);
    assert.equal(ticketAfter.status, TicketStatus.RECLAIMED);

    const jsonl = await readFile(telemetryPath, "utf8");
    const lines = jsonl.trim().split("\n");
    assert.equal(lines.length, 2);
  } finally {
    proc.kill();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("3. runLiveLifecycle executes LP deposit -> offer -> reserve -> exercise -> claimProceeds -> withdrawFree with event & INV-1 checks", async () => {
  const { proc, rpcUrl } = await startAnvil();
  try {
    const dep = await deployLocalTrancheStack(rpcUrl);
    const res = await runLiveLifecycle({
      publicClient: dep.publicClient,
      lpWalletClient: dep.accounts.lp.walletClient,
      traderWalletClient: dep.accounts.trader1.walletClient,
      addresses: dep.addresses,
      inventoryToken: dep.addresses.whsk,
      paymentToken: dep.addresses.usdt,
      depositAmount: parseUnits("300", 18),
      offerAmount: parseUnits("300", 18),
      reserveAmount: parseUnits("150", 18),
      minFillAmount: parseUnits("100", 18),
      fixedPriceX36: 82_000n * 10n ** 18n,
    });
    assert.equal(res.steps.length, 6);
    assert.deepEqual(
      res.steps.map((s) => s.eventVerified),
      ["Deposited", "OfferCreated", "TicketReserved", "TicketExercised", "ProceedsClaimed", "WithdrawnFree"],
    );
    assert.ok(res.lpGasUsed > 0n);
    assert.ok(res.traderGasUsed > 0n);
    console.log(
      `[lifecycle gas] lpGasUsed=${res.lpGasUsed} traderGasUsed=${res.traderGasUsed} total=${res.lpGasUsed + res.traderGasUsed}`,
    );
  } finally {
    proc.kill();
  }
});
