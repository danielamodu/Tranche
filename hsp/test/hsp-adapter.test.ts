import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import {
  type Account,
  type Address,
  BaseError,
  type Chain,
  ContractFunctionRevertedError,
  type Hex,
  type PublicClient,
  RawContractError,
  type TestClient,
  type Transport,
  type WalletClient,
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeErrorResult,
  defineChain,
  http,
  parseEventLogs,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  HSPLiveUnavailableError,
  TrancheHSPAdapter,
  loadTrancheArtifacts,
} from "../src/index.js";

// Deterministic Anvil default dev private keys (local test-only, never used on mainnet)
const ADMIN_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const HSP_SIGNER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const LP_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
const TRADER1_PK = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as const;
const TRADER2_PK = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" as const;
const UNATTESTED_PK = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const;

const CHAIN_ID = 31337;
const ONE_WHSK = 10n ** 18n;
const ONE_USDT = 10n ** 6n;
// 1 WHSK (1e18) -> 1 USDT (1e6) => effPriceX36 = 1e6 * 1e36 / 1e18 = 1e24
const ONE_TO_ONE_PRICE_X36 = 10n ** 24n;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Failed to allocate ephemeral TCP port")));
        return;
      }
      const port = addr.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForAnvil(rpcUrl: string, proc: ChildProcess, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`anvil exited prematurely with code ${proc.exitCode}`);
    }
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) {
        const json = (await res.json()) as { result?: string };
        if (json.result) return;
      }
    } catch {
      // retry until ready
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for anvil at ${rpcUrl}`);
}

const loadedArtifacts = loadTrancheArtifacts();
const COMBINED_ERROR_ABI = [
  ...loadedArtifacts.HSPComplianceHook.abi,
  ...loadedArtifacts.CommitmentManager.abi,
  ...loadedArtifacts.ExecutionTicket.abi,
  ...loadedArtifacts.LiquidityVault.abi,
];

function extractRevertName(err: unknown): string | undefined {
  if (err instanceof BaseError) {
    const revertErr = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revertErr instanceof ContractFunctionRevertedError) {
      if (revertErr.data?.errorName) return revertErr.data.errorName;
      if (revertErr.raw) {
        try {
          return decodeErrorResult({ abi: COMBINED_ERROR_ABI, data: revertErr.raw }).errorName;
        } catch {
          // fall through
        }
      }
    }
    const rawErr = err.walk((e) => e instanceof RawContractError);
    if (rawErr instanceof RawContractError && typeof rawErr.data === "string" && rawErr.data.startsWith("0x")) {
      try {
        return decodeErrorResult({ abi: COMBINED_ERROR_ABI, data: rawErr.data as Hex }).errorName;
      } catch {
        // fall through
      }
    }
  }
  return undefined;
}

describe("TrancheHSPAdapter Integration (local anvil)", () => {
  let anvilProc: ChildProcess | undefined;
  let rpcUrl = "";

  const adminAccount = privateKeyToAccount(ADMIN_PK);
  const hspSignerAccount = privateKeyToAccount(HSP_SIGNER_PK);
  const lpAccount = privateKeyToAccount(LP_PK);
  const trader1Account = privateKeyToAccount(TRADER1_PK);
  const trader2Account = privateKeyToAccount(TRADER2_PK);
  const unattestedAccount = privateKeyToAccount(UNATTESTED_PK);

  const artifacts = loadedArtifacts;

  let chain: Chain;
  let publicClient: PublicClient;
  let testClient: TestClient;
  let adminWallet: WalletClient<Transport, Chain, Account>;
  let lpWallet: WalletClient<Transport, Chain, Account>;
  let trader1Wallet: WalletClient<Transport, Chain, Account>;
  let trader2Wallet: WalletClient<Transport, Chain, Account>;

  let whskAddress: Address;
  let usdtAddress: Address;
  let vaultAddress: Address;
  let managerAddress: Address;
  let ticketNftAddress: Address;
  let hookAddress: Address;
  let adapter: TrancheHSPAdapter;

  async function deployContract(
    wallet: WalletClient<Transport, Chain, Account>,
    abi: typeof artifacts.MockWHSK.abi,
    bytecode: Hex,
    args: unknown[] = []
  ): Promise<Address> {
    const hash = await wallet.deployContract({
      abi,
      bytecode,
      args,
      account: wallet.account,
      chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    assert.ok(receipt.contractAddress, "Contract deployment must produce an address");
    return receipt.contractAddress;
  }

  async function writeAndWait(
    wallet: WalletClient<Transport, Chain, Account>,
    address: Address,
    abi: typeof artifacts.CommitmentManager.abi,
    functionName: string,
    args: unknown[] = []
  ) {
    const hash = await wallet.writeContract({
      address,
      abi,
      functionName,
      args,
      account: wallet.account,
      chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", `${functionName} tx must succeed`);
    return { hash, receipt };
  }

  async function currentTimestamp(): Promise<bigint> {
    const block = await publicClient.getBlock();
    return block.timestamp;
  }

  before(async () => {
    const port = await getFreePort();
    rpcUrl = `http://127.0.0.1:${port}`;
    anvilProc = spawn(
      "anvil",
      ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(CHAIN_ID), "--silent"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    await waitForAnvil(rpcUrl, anvilProc);

    chain = defineChain({
      id: CHAIN_ID,
      name: "Anvil Local",
      nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });

    const transport = http(rpcUrl);
    publicClient = createPublicClient({ chain, transport });
    testClient = createTestClient({ chain, mode: "anvil", transport });
    adminWallet = createWalletClient({ chain, transport, account: adminAccount });
    lpWallet = createWalletClient({ chain, transport, account: lpAccount });
    trader1Wallet = createWalletClient({ chain, transport, account: trader1Account });
    trader2Wallet = createWalletClient({ chain, transport, account: trader2Account });

    process.once("exit", () => {
      if (anvilProc && anvilProc.exitCode === null) {
        anvilProc.kill("SIGKILL");
      }
    });

    // Deploy mocks + Tranche core + HSPComplianceHook
    whskAddress = await deployContract(adminWallet, artifacts.MockWHSK.abi, artifacts.MockWHSK.bytecode);
    usdtAddress = await deployContract(adminWallet, artifacts.MockERC20.abi, artifacts.MockERC20.bytecode, [
      "Tether USD",
      "USDT",
      6,
    ]);
    vaultAddress = await deployContract(adminWallet, artifacts.LiquidityVault.abi, artifacts.LiquidityVault.bytecode, [
      adminAccount.address,
      adminAccount.address,
      adminAccount.address,
    ]);
    managerAddress = await deployContract(
      adminWallet,
      artifacts.CommitmentManager.abi,
      artifacts.CommitmentManager.bytecode,
      [adminAccount.address, vaultAddress, adminAccount.address, 5]
    );
    ticketNftAddress = await deployContract(
      adminWallet,
      artifacts.ExecutionTicket.abi,
      artifacts.ExecutionTicket.bytecode,
      [managerAddress]
    );
    hookAddress = await deployContract(
      adminWallet,
      artifacts.HSPComplianceHook.abi,
      artifacts.HSPComplianceHook.bytecode,
      [adminAccount.address, hspSignerAccount.address]
    );

    await writeAndWait(adminWallet, vaultAddress, artifacts.LiquidityVault.abi, "setManager", [managerAddress]);
    await writeAndWait(adminWallet, managerAddress, artifacts.CommitmentManager.abi, "setTicketNft", [ticketNftAddress]);
    await writeAndWait(adminWallet, managerAddress, artifacts.CommitmentManager.abi, "setTokenMinTicketAmount", [
      whskAddress,
      ONE_WHSK,
    ]);
    await writeAndWait(adminWallet, managerAddress, artifacts.CommitmentManager.abi, "setApprovedComplianceHook", [
      hookAddress,
      true,
    ]);

    // Fund LP with WHSK and Traders with USDT
    await writeAndWait(adminWallet, whskAddress, artifacts.MockWHSK.abi, "mint", [lpAccount.address, 500n * ONE_WHSK]);
    await writeAndWait(adminWallet, usdtAddress, artifacts.MockERC20.abi, "mint", [
      trader1Account.address,
      1_000n * ONE_USDT,
    ]);
    await writeAndWait(adminWallet, usdtAddress, artifacts.MockERC20.abi, "mint", [
      trader2Account.address,
      1_000n * ONE_USDT,
    ]);
    await writeAndWait(adminWallet, usdtAddress, artifacts.MockERC20.abi, "mint", [
      unattestedAccount.address,
      1_000n * ONE_USDT,
    ]);

    adapter = new TrancheHSPAdapter({
      mode: "LOCAL_EIP712_COMPLIANCE",
      chainId: CHAIN_ID,
      publicClient,
      complianceHookAddress: hookAddress,
      commitmentManagerAddress: managerAddress,
      signerAccount: hspSignerAccount,
      walletClient: adminWallet,
    });
  });

  after(async () => {
    if (anvilProc && anvilProc.exitCode === null) {
      anvilProc.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        anvilProc!.once("exit", () => resolve());
        setTimeout(resolve, 1_000);
      });
    }
  });

  it("1. Attests LP & Traders via EIP-712, executes gated offer -> reserve -> transfer -> exercise, and generates HSPMandate & HSPSettlementReceipt", async () => {
    const status = await adapter.getStatusReport();
    assert.equal(status.mode, "LOCAL_EIP712_COMPLIANCE");
    assert.equal(status.verificationStatus, "LOCAL_ADAPTER");

    const now = await currentTimestamp();
    const expiry = now + 7n * 86_400n;

    // Out-of-band EIP-712 attestations for LP, Trader1, Trader2
    for (const subject of [lpAccount.address, trader1Account.address, trader2Account.address]) {
      const envelope = await adapter.signAttestation({ subject, expiry });
      await adapter.submitAttestation(envelope);
      assert.equal(await adapter.isCompliant(subject), true);
    }

    // LP deposits WHSK into LiquidityVault and creates an HSP-gated fixed-price offer
    const offerAmount = 100n * ONE_WHSK;
    await writeAndWait(lpWallet, whskAddress, artifacts.MockWHSK.abi, "approve", [vaultAddress, offerAmount]);
    await writeAndWait(lpWallet, vaultAddress, artifacts.LiquidityVault.abi, "deposit", [whskAddress, offerAmount]);

    const { receipt: createReceipt } = await writeAndWait(
      lpWallet,
      managerAddress,
      artifacts.CommitmentManager.abi,
      "createOffer",
      [
        {
          inventoryToken: whskAddress,
          paymentToken: usdtAddress,
          initialAmount: offerAmount,
          minFillAmount: ONE_WHSK,
          expiry: Number(now + 7n * 86_400n),
          minDuration: 60,
          maxDuration: 86_400,
          basePremiumBps: 50,
          dailyPremiumBps: 10,
          priceMode: 0, // PriceMode.FIXED
          spreadBps: 0,
          oracle: zeroAddress,
          complianceHook: hookAddress,
          fixedPriceX36: ONE_TO_ONE_PRICE_X36,
          minPriceX36: 0n,
          maxPriceX36: 0n,
        },
      ]
    );

    const offerLogs = parseEventLogs({
      abi: artifacts.CommitmentManager.abi,
      logs: createReceipt.logs,
      eventName: "OfferCreated",
    });
    assert.equal(offerLogs.length, 1);
    const offerId = (offerLogs[0] as unknown as { args: { offerId: bigint } }).args.offerId;

    // Trader1 reserves 10 WHSK ticket
    const reserveAmount = 10n * ONE_WHSK;
    const duration = 3600;
    const [grossPremium] = (await publicClient.readContract({
      address: managerAddress,
      abi: artifacts.CommitmentManager.abi,
      functionName: "quoteReservation",
      args: [offerId, reserveAmount, duration],
    })) as [bigint, bigint];

    await writeAndWait(trader1Wallet, usdtAddress, artifacts.MockERC20.abi, "approve", [
      vaultAddress,
      grossPremium,
    ]);
    const { receipt: reserveReceipt } = await writeAndWait(
      trader1Wallet,
      managerAddress,
      artifacts.CommitmentManager.abi,
      "reserve",
      [offerId, reserveAmount, duration, grossPremium, trader1Account.address]
    );

    const reserveLogs = parseEventLogs({
      abi: artifacts.CommitmentManager.abi,
      logs: reserveReceipt.logs,
      eventName: "TicketReserved",
    });
    assert.equal(reserveLogs.length, 1);
    const ticketId = (reserveLogs[0] as unknown as { args: { ticketId: bigint } }).args.ticketId;

    // Secondary transfer between compliant users: Trader1 -> Trader2
    await writeAndWait(trader1Wallet, ticketNftAddress, artifacts.ExecutionTicket.abi, "transferFrom", [
      trader1Account.address,
      trader2Account.address,
      ticketId,
    ]);
    const ownerAfterTransfer = (await publicClient.readContract({
      address: ticketNftAddress,
      abi: artifacts.ExecutionTicket.abi,
      functionName: "ownerOf",
      args: [ticketId],
    })) as Address;
    assert.equal(ownerAfterTransfer.toLowerCase(), trader2Account.address.toLowerCase());

    // Pre-trade out-of-band HSPMandate for Trader2 exercising ticketId
    const [, expectedGrossPayment] = (await publicClient.readContract({
      address: managerAddress,
      abi: artifacts.CommitmentManager.abi,
      functionName: "quoteExercise",
      args: [ticketId, reserveAmount],
    })) as [bigint, bigint, bigint];

    const mandate = await adapter.issueMandate({
      subject: trader2Account.address,
      counterparty: lpAccount.address,
      action: "EXERCISE",
      offerId,
      ticketId,
      inventoryToken: whskAddress,
      paymentToken: usdtAddress,
      maxAmount: expectedGrossPayment,
      expiresAt: Number(expiry),
    });
    assert.match(mandate.mandateId, /^0x[0-9a-f]{64}$/);
    assert.match(mandate.signature, /^0x[0-9a-f]+$/);

    // Atomic on-chain exercise by Trader2
    await writeAndWait(trader2Wallet, usdtAddress, artifacts.MockERC20.abi, "approve", [
      vaultAddress,
      expectedGrossPayment,
    ]);
    const { hash: exerciseTxHash } = await writeAndWait(
      trader2Wallet,
      managerAddress,
      artifacts.CommitmentManager.abi,
      "exercise",
      [ticketId, reserveAmount, expectedGrossPayment, trader2Account.address]
    );

    // Post-settlement HSPSettlementReceipt linked to real tx hash & receipt
    const settlementReceipt = await adapter.buildSettlementReceipt({
      txHash: exerciseTxHash,
      mandate,
      ticketId,
      exerciser: trader2Account.address,
      receiver: trader2Account.address,
      inventoryToken: whskAddress,
      paymentToken: usdtAddress,
    });

    assert.equal(settlementReceipt.status, "SETTLED_ONCHAIN");
    assert.equal(settlementReceipt.txHash, exerciseTxHash);
    assert.equal(settlementReceipt.mandateId, mandate.mandateId);
    assert.equal(settlementReceipt.fillAmount, reserveAmount.toString());
    assert.equal(settlementReceipt.grossPayment, expectedGrossPayment.toString());
    assert.match(settlementReceipt.proofHash, /^0x[0-9a-f]{64}$/);
  });

  it("2. Rejects non-compliant ticket transfer and non-compliant exercise with NotCompliant", async () => {
    assert.equal(await adapter.isCompliant(unattestedAccount.address), false);

    // Trader2 reserves a fresh ticket on offer #1
    const offerId = 1n;
    const reserveAmount = 5n * ONE_WHSK;
    const duration = 3600;
    const [grossPremium] = (await publicClient.readContract({
      address: managerAddress,
      abi: artifacts.CommitmentManager.abi,
      functionName: "quoteReservation",
      args: [offerId, reserveAmount, duration],
    })) as [bigint, bigint];

    await writeAndWait(trader2Wallet, usdtAddress, artifacts.MockERC20.abi, "approve", [
      vaultAddress,
      grossPremium,
    ]);
    const { receipt } = await writeAndWait(
      trader2Wallet,
      managerAddress,
      artifacts.CommitmentManager.abi,
      "reserve",
      [offerId, reserveAmount, duration, grossPremium, trader2Account.address]
    );
    const logs = parseEventLogs({
      abi: artifacts.CommitmentManager.abi,
      logs: receipt.logs,
      eventName: "TicketReserved",
    });
    const ticketId = (logs[0] as unknown as { args: { ticketId: bigint } }).args.ticketId;

    // Transfer to unattested user must revert with NotCompliant
    await assert.rejects(
      async () => {
        await trader2Wallet.writeContract({
          address: ticketNftAddress,
          abi: artifacts.ExecutionTicket.abi,
          functionName: "transferFrom",
          args: [trader2Account.address, unattestedAccount.address, ticketId],
          account: trader2Account,
          chain,
        });
      },
      (err: unknown) => {
        assert.equal(extractRevertName(err), "NotCompliant");
        return true;
      }
    );

    // Exercise sending inventory to unattested receiver must also revert with NotCompliant
    const [, expectedPay] = (await publicClient.readContract({
      address: managerAddress,
      abi: artifacts.CommitmentManager.abi,
      functionName: "quoteExercise",
      args: [ticketId, reserveAmount],
    })) as [bigint, bigint, bigint];
    await writeAndWait(trader2Wallet, usdtAddress, artifacts.MockERC20.abi, "approve", [vaultAddress, expectedPay]);

    await assert.rejects(
      async () => {
        await trader2Wallet.writeContract({
          address: managerAddress,
          abi: artifacts.CommitmentManager.abi,
          functionName: "exercise",
          args: [ticketId, reserveAmount, expectedPay, unattestedAccount.address],
          account: trader2Account,
          chain,
        });
      },
      (err: unknown) => {
        assert.equal(extractRevertName(err), "NotCompliant");
        return true;
      }
    );
  });

  it("3. Rejects attestation replay with InvalidNonce", async () => {
    const now = await currentTimestamp();
    const envelope = await adapter.signAttestation({
      subject: trader1Account.address,
      expiry: now + 86_400n,
    });

    await adapter.submitAttestation(envelope);

    await assert.rejects(
      async () => {
        await adminWallet.writeContract({
          address: envelope.verifyingContract,
          abi: artifacts.HSPComplianceHook.abi,
          functionName: "submitAttestation",
          args: [envelope.subject, envelope.nonce, envelope.expiry, envelope.signature],
          account: adminAccount,
          chain,
        });
      },
      (err: unknown) => {
        assert.equal(extractRevertName(err), "InvalidNonce");
        return true;
      }
    );
  });

  it("4. INV-8: Revoked LP can still reclaimExpired, cancelOffer, withdrawFree, and claimProceeds", async () => {
    // Advance time past ticket #2 expiry (duration was 3600s)
    await testClient.increaseTime({ seconds: 3700 });
    await testClient.mine({ blocks: 1 });

    // Admin revokes LP compliance on HSPComplianceHook
    await writeAndWait(adminWallet, hookAddress, artifacts.HSPComplianceHook.abi, "revoke", [lpAccount.address]);
    assert.equal(await adapter.isCompliant(lpAccount.address), false);

    // Confirm revoked LP is blocked from creating a NEW gated offer
    const now = await currentTimestamp();
    await assert.rejects(
      async () => {
        await lpWallet.writeContract({
          address: managerAddress,
          abi: artifacts.CommitmentManager.abi,
          functionName: "createOffer",
          args: [
            {
              inventoryToken: whskAddress,
              paymentToken: usdtAddress,
              initialAmount: 0n,
              minFillAmount: ONE_WHSK,
              expiry: Number(now + 86_400n),
              minDuration: 60,
              maxDuration: 86_400,
              basePremiumBps: 50,
              dailyPremiumBps: 0,
              priceMode: 0,
              spreadBps: 0,
              oracle: zeroAddress,
              complianceHook: hookAddress,
              fixedPriceX36: ONE_TO_ONE_PRICE_X36,
              minPriceX36: 0n,
              maxPriceX36: 0n,
            },
          ],
          account: lpAccount,
          chain,
        });
      },
      (err: unknown) => {
        assert.equal(extractRevertName(err), "NotCompliant");
        return true;
      }
    );

    // 1) Revoked LP can reclaim expired ticket #2
    await writeAndWait(lpWallet, managerAddress, artifacts.CommitmentManager.abi, "reclaimExpired", [2n]);

    // 2) Revoked LP can cancelOffer #1 (moves remaining offerBalance + reclaimed 5 WHSK to lpFreeBalance)
    await writeAndWait(lpWallet, managerAddress, artifacts.CommitmentManager.abi, "cancelOffer", [1n]);

    const freeWhsk = (await publicClient.readContract({
      address: vaultAddress,
      abi: artifacts.LiquidityVault.abi,
      functionName: "lpFreeBalance",
      args: [lpAccount.address, whskAddress],
    })) as bigint;
    assert.equal(freeWhsk, 90n * ONE_WHSK);

    // 3) Revoked LP can withdrawFree all WHSK
    const lpWhskBefore = (await publicClient.readContract({
      address: whskAddress,
      abi: artifacts.MockWHSK.abi,
      functionName: "balanceOf",
      args: [lpAccount.address],
    })) as bigint;
    await writeAndWait(lpWallet, vaultAddress, artifacts.LiquidityVault.abi, "withdrawFree", [
      whskAddress,
      freeWhsk,
      lpAccount.address,
    ]);
    const lpWhskAfter = (await publicClient.readContract({
      address: whskAddress,
      abi: artifacts.MockWHSK.abi,
      functionName: "balanceOf",
      args: [lpAccount.address],
    })) as bigint;
    assert.equal(lpWhskAfter - lpWhskBefore, 90n * ONE_WHSK);

    // 4) Revoked LP can claimProceeds (reservation premiums + exercise payment)
    const pendingUsdt = (await publicClient.readContract({
      address: vaultAddress,
      abi: artifacts.LiquidityVault.abi,
      functionName: "lpPendingProceeds",
      args: [lpAccount.address, usdtAddress],
    })) as bigint;
    assert.ok(pendingUsdt > 0n, "LP should have pending USDT proceeds");

    const lpUsdtBefore = (await publicClient.readContract({
      address: usdtAddress,
      abi: artifacts.MockERC20.abi,
      functionName: "balanceOf",
      args: [lpAccount.address],
    })) as bigint;
    await writeAndWait(lpWallet, vaultAddress, artifacts.LiquidityVault.abi, "claimProceeds", [
      usdtAddress,
      0n,
      lpAccount.address,
    ]);
    const lpUsdtAfter = (await publicClient.readContract({
      address: usdtAddress,
      abi: artifacts.MockERC20.abi,
      functionName: "balanceOf",
      args: [lpAccount.address],
    })) as bigint;
    assert.equal(lpUsdtAfter - lpUsdtBefore, pendingUsdt);
  });

  it("5. LIVE_HSP_CAAS mode without partner credentials explicitly throws HSP_LIVE_UNAVAILABLE", async () => {
    const liveAdapter = new TrancheHSPAdapter({
      mode: "LIVE_HSP_CAAS",
      chainId: 177,
      publicClient,
      complianceHookAddress: hookAddress,
      commitmentManagerAddress: managerAddress,
    });

    const report = await liveAdapter.getStatusReport();
    assert.equal(report.mode, "LIVE_HSP_CAAS");
    assert.equal(report.verificationStatus, "BLOCKED");
    assert.equal(report.liveCaasConfigured, false);
    assert.equal(report.liveFacilitatorConfigured, false);

    await assert.rejects(
      async () => {
        await liveAdapter.signAttestation({
          subject: trader1Account.address,
          expiry: 9999999999n,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof HSPLiveUnavailableError);
        assert.equal(err.code, "HSP_LIVE_UNAVAILABLE");
        assert.match(err.message, /HSP_LIVE_UNAVAILABLE/);
        assert.ok(err.missingFields.includes("apiBaseUrl"));
        assert.ok(err.missingFields.includes("apiKey"));
        assert.ok(err.missingFields.includes("apiSecret"));
        assert.ok(err.missingFields.includes("facilitatorUrl"));
        return true;
      }
    );

    // Even if apiBaseUrl/apiKey/apiSecret are provided without a live facilitatorUrl, it still throws HSP_LIVE_UNAVAILABLE
    const partialLiveAdapter = new TrancheHSPAdapter({
      mode: "LIVE_HSP_CAAS",
      chainId: 177,
      publicClient,
      liveConfig: {
        apiBaseUrl: "https://caas.example.invalid",
        apiKey: "dummy-key",
        apiSecret: "dummy-secret",
      },
    });
    assert.throws(() => partialLiveAdapter.assertLiveConfigured(), (err: unknown) => {
      assert.ok(err instanceof HSPLiveUnavailableError);
      assert.equal(err.code, "HSP_LIVE_UNAVAILABLE");
      assert.deepEqual(err.missingFields, ["facilitatorUrl"]);
      return true;
    });
  });
});
