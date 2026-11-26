import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  HspPaymentError,
  HspPaymentOrchestrator,
  HspPaymentStore,
  MockHspMcpProvider,
  MockHspWalletAuthorizer,
} from "../src/hsp-payments/index.js";
import { AgentApiServer } from "../src/server.js";
import type { PolicyValidationBounds } from "../src/llm.js";
import type { AgentRuntime, TrancheAutonomousAgent } from "../src/runtime.js";

function makeTempStateFile(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tranche-hsp-${label}-`));
  return path.join(dir, "hsp-payments.json");
}

const SAMPLE_INTENT = {
  idempotencyKey: "idem-order-001",
  merchant: "merchant_hashkey_demo",
  payer: "0x1111111111111111111111111111111111111111",
  recipient: "0x2222222222222222222222222222222222222222",
  token: "USDT",
  amount: "25.00",
  memo: "Invoice #1042",
};

describe("HspPaymentOrchestrator (isolated mock MCP lifecycle)", () => {
  it("1. Successful payment lifecycle: CREATED -> PREPARED -> AUTHORIZED -> SUBMITTED -> PROCESSING -> SAFE -> FINALIZED", async () => {
    let now = 1_750_000_000;
    const store = new HspPaymentStore(makeTempStateFile("success"));
    const provider = new MockHspMcpProvider({
      nowSec: () => now,
      statusSequence: [
        {
          evidenceKind: "MOCK_SIMULATION",
          providerStatusRaw: "SAFE",
          txReference: "0xmock_tx_safe_01",
          attributedMerchant: SAMPLE_INTENT.merchant,
        },
        {
          evidenceKind: "MOCK_SIMULATION",
          providerStatusRaw: "FINALIZED",
          txReference: "0xmock_tx_final_01",
          attributedMerchant: SAMPLE_INTENT.merchant,
        },
      ],
    });
    const authorizer = new MockHspWalletAuthorizer({ nowSec: () => now });
    const orch = new HspPaymentOrchestrator({
      store,
      mcpProvider: provider,
      walletAuthorizer: authorizer,
      nowSec: () => now,
    });

    const discovery = await orch.discoverTools();
    assert.equal(discovery.evidenceKind, "MOCK_SIMULATION");
    assert.equal(discovery.schemaDiscovered, false);

    const created = orch.createPayment(SAMPLE_INTENT);
    assert.equal(created.state, "CREATED");
    assert.equal(created.evidenceKind, "MOCK_SIMULATION");
    assert.equal(created.isMockEvidence, true);

    now += 5;
    const prepared = await orch.preparePayment(created.paymentId);
    assert.equal(prepared.state, "PREPARED");
    assert.ok(prepared.preparationId);
    assert.ok(prepared.preparationExpiresAt && prepared.preparationExpiresAt > now);

    now += 5;
    const authorized = await orch.authorizePayment(created.paymentId, {
      explicitUserConsent: true,
      authorizedBy: "operator@tranche",
    });
    assert.equal(authorized.state, "AUTHORIZED");
    assert.equal(authorized.authorization?.explicitUserConsent, true);

    now += 5;
    const submitted = await orch.submitPayment(created.paymentId);
    assert.equal(submitted.state, "PROCESSING");
    assert.equal(submitted.submissionAttempts, 1);
    assert.equal(provider.submitCalls, 1);

    now += 5;
    const safe = await orch.refreshPaymentStatus(created.paymentId);
    assert.equal(safe.state, "SAFE");
    assert.equal(safe.txReference, "0xmock_tx_safe_01");

    now += 5;
    const finalized = await orch.refreshPaymentStatus(created.paymentId);
    assert.equal(finalized.state, "FINALIZED");
    assert.equal(finalized.txReference, "0xmock_tx_final_01");
    assert.equal(finalized.isMockEvidence, true);

    const visitedStates = finalized.history.map((h) => h.toState);
    assert.deepEqual(visitedStates, [
      "CREATED",
      "PREPARED",
      "AUTHORIZED",
      "SUBMITTED",
      "PROCESSING",
      "SAFE",
      "FINALIZED",
    ]);
  });

  it("2. Insufficient balance transitions cleanly to FAILED during preparation", async () => {
    const store = new HspPaymentStore(makeTempStateFile("insuff"));
    const provider = new MockHspMcpProvider({
      onPrepare: () => ({
        ok: false,
        evidenceKind: "MOCK_SIMULATION",
        failureCode: "INSUFFICIENT_BALANCE",
        failureReason: "Payer USDT balance below required 25.00",
      }),
    });
    const orch = new HspPaymentOrchestrator({
      store,
      mcpProvider: provider,
      walletAuthorizer: new MockHspWalletAuthorizer(),
    });

    const created = orch.createPayment({ ...SAMPLE_INTENT, idempotencyKey: "idem-insuff-1" });
    const failed = await orch.preparePayment(created.paymentId);
    assert.equal(failed.state, "FAILED");
    assert.equal(failed.failureCode, "INSUFFICIENT_BALANCE");
    assert.equal(provider.submitCalls, 0);
  });

  it("3. Expired preparation fails authorization and blocks submission", async () => {
    let now = 1_750_000_000;
    const store = new HspPaymentStore(makeTempStateFile("expired"));
    const provider = new MockHspMcpProvider({
      defaultPreparationTtlSec: 60,
      nowSec: () => now,
    });
    const authorizer = new MockHspWalletAuthorizer({ nowSec: () => now });
    const orch = new HspPaymentOrchestrator({
      store,
      mcpProvider: provider,
      walletAuthorizer: authorizer,
      nowSec: () => now,
    });

    const created = orch.createPayment({ ...SAMPLE_INTENT, idempotencyKey: "idem-exp-1" });
    await orch.preparePayment(created.paymentId);

    // Advance past preparation TTL
    now += 61;
    const expired = await orch.authorizePayment(created.paymentId, {
      explicitUserConsent: true,
      authorizedBy: "operator@tranche",
    });
    assert.equal(expired.state, "FAILED");
    assert.equal(expired.failureCode, "PREPARATION_EXPIRED");
    assert.equal(authorizer.authCalls, 0);
  });

  it("4. Authorization rejection: blocks missing consent and fails on wallet rejection", async () => {
    const store = new HspPaymentStore(makeTempStateFile("auth-rej"));
    const provider = new MockHspMcpProvider();
    const authorizer = new MockHspWalletAuthorizer({
      approve: false,
      rejectionCode: "USER_REJECTED",
      rejectionReason: "User clicked reject in wallet prompt",
    });
    const orch = new HspPaymentOrchestrator({
      store,
      mcpProvider: provider,
      walletAuthorizer: authorizer,
    });

    const created = orch.createPayment({ ...SAMPLE_INTENT, idempotencyKey: "idem-auth-rej-1" });
    await orch.preparePayment(created.paymentId);

    // Explicit consent false must throw before calling authorizer
    await assert.rejects(
      () =>
        orch.authorizePayment(created.paymentId, {
          explicitUserConsent: false,
          authorizedBy: "operator@tranche",
        }),
      (err: unknown) => err instanceof HspPaymentError && err.code === "EXPLICIT_AUTHORIZATION_REQUIRED",
    );
    assert.equal(authorizer.authCalls, 0);

    // Explicit consent true, but wallet rejects
    const failed = await orch.authorizePayment(created.paymentId, {
      explicitUserConsent: true,
      authorizedBy: "operator@tranche",
    });
    assert.equal(failed.state, "FAILED");
    assert.equal(failed.failureCode, "USER_REJECTED");
    assert.equal(provider.submitCalls, 0);
  });

  it("5. Submission failure transitions AUTHORIZED -> SUBMITTED -> FAILED", async () => {
    const store = new HspPaymentStore(makeTempStateFile("sub-fail"));
    const provider = new MockHspMcpProvider({
      onSubmit: () => ({
        outcome: "FAILED",
        evidenceKind: "MOCK_SIMULATION",
        failureCode: "SUBMISSION_REJECTED_BY_PROVIDER",
        failureReason: "Simulated provider rejection",
      }),
    });
    const orch = new HspPaymentOrchestrator({
      store,
      mcpProvider: provider,
      walletAuthorizer: new MockHspWalletAuthorizer(),
    });

    const created = orch.createPayment({ ...SAMPLE_INTENT, idempotencyKey: "idem-sub-fail-1" });
    await orch.preparePayment(created.paymentId);
    await orch.authorizePayment(created.paymentId, {
      explicitUserConsent: true,
      authorizedBy: "operator@tranche",
    });

    const failed = await orch.submitPayment(created.paymentId);
    assert.equal(failed.state, "FAILED");
    assert.equal(failed.failureCode, "SUBMISSION_REJECTED_BY_PROVIDER");
    assert.equal(provider.submitCalls, 1);
  });

  it("6. Timeout and recovery: timeout NEVER triggers duplicate payment and reconciles to FINALIZED", async () => {
    const store = new HspPaymentStore(makeTempStateFile("timeout"));
    const provider = new MockHspMcpProvider({
      onSubmit: () => ({
        outcome: "TIMEOUT",
        evidenceKind: "MOCK_SIMULATION",
        submissionRef: "mock_sub_timeout_1",
        failureCode: "GATEWAY_TIMEOUT",
        failureReason: "Upstream response timed out after dispatch",
      }),
      statusSequence: [
        {
          evidenceKind: "MOCK_SIMULATION",
          providerStatusRaw: "PROCESSING",
          txReference: "0xmock_recovered_tx",
          attributedMerchant: SAMPLE_INTENT.merchant,
        },
        {
          evidenceKind: "MOCK_SIMULATION",
          providerStatusRaw: "FINALIZED",
          txReference: "0xmock_recovered_tx",
          attributedMerchant: SAMPLE_INTENT.merchant,
        },
      ],
    });
    const orch = new HspPaymentOrchestrator({
      store,
      mcpProvider: provider,
      walletAuthorizer: new MockHspWalletAuthorizer(),
    });

    const created = orch.createPayment({ ...SAMPLE_INTENT, idempotencyKey: "idem-timeout-1" });
    await orch.preparePayment(created.paymentId);
    await orch.authorizePayment(created.paymentId, {
      explicitUserConsent: true,
      authorizedBy: "operator@tranche",
    });

    const timedOut = await orch.submitPayment(created.paymentId);
    assert.equal(timedOut.state, "TIMEOUT");
    assert.equal(provider.submitCalls, 1);

    // Attempting to re-submit after TIMEOUT must be strictly blocked
    await assert.rejects(
      () => orch.submitPayment(created.paymentId),
      (err: unknown) => err instanceof HspPaymentError && err.code === "DUPLICATE_SUBMISSION_BLOCKED",
    );
    assert.equal(provider.submitCalls, 1);

    // Recovery happens strictly via status polling
    const processing = await orch.refreshPaymentStatus(created.paymentId);
    assert.equal(processing.state, "PROCESSING");
    const finalized = await orch.refreshPaymentStatus(created.paymentId);
    assert.equal(finalized.state, "FINALIZED");
    assert.equal(finalized.txReference, "0xmock_recovered_tx");
    assert.equal(provider.submitCalls, 1);
  });

  it("7. Duplicate submission prevention & idempotency key conflict protection", async () => {
    const store = new HspPaymentStore(makeTempStateFile("dup"));
    const provider = new MockHspMcpProvider();
    const orch = new HspPaymentOrchestrator({
      store,
      mcpProvider: provider,
      walletAuthorizer: new MockHspWalletAuthorizer(),
    });

    const p1 = orch.createPayment({ ...SAMPLE_INTENT, idempotencyKey: "idem-dup-1" });
    const p2 = orch.createPayment({ ...SAMPLE_INTENT, idempotencyKey: "idem-dup-1" });
    assert.equal(p1.paymentId, p2.paymentId);

    // Conflicting parameters for the same idempotencyKey must throw
    assert.throws(
      () =>
        orch.createPayment({
          ...SAMPLE_INTENT,
          idempotencyKey: "idem-dup-1",
          amount: "99.00",
        }),
      (err: unknown) => err instanceof HspPaymentError && err.code === "IDEMPOTENCY_KEY_CONFLICT",
    );

    await orch.preparePayment(p1.paymentId);
    await orch.authorizePayment(p1.paymentId, {
      explicitUserConsent: true,
      authorizedBy: "operator@tranche",
    });
    await orch.submitPayment(p1.paymentId);

    await assert.rejects(
      () => orch.submitPayment(p1.paymentId),
      (err: unknown) => err instanceof HspPaymentError && err.code === "DUPLICATE_SUBMISSION_BLOCKED",
    );
    assert.equal(provider.submitCalls, 1);
  });

  it("8. Restart during an in-progress payment recovers persisted state without re-submitting", async () => {
    const stateFile = makeTempStateFile("restart");

    // Process 1: submit payment, enters PROCESSING, then crashes/restarts
    const store1 = new HspPaymentStore(stateFile);
    const provider1 = new MockHspMcpProvider();
    const orch1 = new HspPaymentOrchestrator({
      store: store1,
      mcpProvider: provider1,
      walletAuthorizer: new MockHspWalletAuthorizer(),
    });
    const created = orch1.createPayment({ ...SAMPLE_INTENT, idempotencyKey: "idem-restart-1" });
    await orch1.preparePayment(created.paymentId);
    await orch1.authorizePayment(created.paymentId, {
      explicitUserConsent: true,
      authorizedBy: "operator@tranche",
    });
    const inFlight = await orch1.submitPayment(created.paymentId);
    assert.equal(inFlight.state, "PROCESSING");
    assert.equal(provider1.submitCalls, 1);

    // Process 2: fresh store + orchestrator loaded from disk
    const store2 = new HspPaymentStore(stateFile);
    const provider2 = new MockHspMcpProvider({
      statusSequence: [
        {
          evidenceKind: "MOCK_SIMULATION",
          providerStatusRaw: "FINALIZED",
          txReference: inFlight.txReference,
          attributedMerchant: SAMPLE_INTENT.merchant,
        },
      ],
    });
    const orch2 = new HspPaymentOrchestrator({
      store: store2,
      mcpProvider: provider2,
      walletAuthorizer: new MockHspWalletAuthorizer(),
    });

    // Duplicate submit after restart must still be blocked
    await assert.rejects(
      () => orch2.submitPayment(created.paymentId),
      (err: unknown) => err instanceof HspPaymentError && err.code === "DUPLICATE_SUBMISSION_BLOCKED",
    );

    const recovery = await orch2.recoverInProgressPayments();
    assert.equal(recovery.checked, 1);
    assert.equal(recovery.errors.length, 0);
    assert.equal(recovery.reconciled[0]?.state, "FINALIZED");
    assert.equal(provider2.submitCalls, 0);
    assert.equal(provider2.statusCalls, 1);
  });

  it("9. Unrecognized payment status fails safe without corrupting state or re-submitting", async () => {
    const store = new HspPaymentStore(makeTempStateFile("unrecognized"));
    const provider = new MockHspMcpProvider({
      statusSequence: [
        {
          evidenceKind: "MOCK_SIMULATION",
          providerStatusRaw: "UNKNOWN_OPAQUE_STATUS_99",
          attributedMerchant: SAMPLE_INTENT.merchant,
        },
      ],
    });
    const orch = new HspPaymentOrchestrator({
      store,
      mcpProvider: provider,
      walletAuthorizer: new MockHspWalletAuthorizer(),
    });

    const created = orch.createPayment({ ...SAMPLE_INTENT, idempotencyKey: "idem-unk-1" });
    await orch.preparePayment(created.paymentId);
    await orch.authorizePayment(created.paymentId, {
      explicitUserConsent: true,
      authorizedBy: "operator@tranche",
    });
    await orch.submitPayment(created.paymentId);

    await assert.rejects(
      () => orch.refreshPaymentStatus(created.paymentId),
      (err: unknown) => err instanceof HspPaymentError && err.code === "UNRECOGNIZED_PAYMENT_STATUS",
    );

    const reloaded = orch.getPayment(created.paymentId)!;
    assert.equal(reloaded.state, "PROCESSING");
    assert.equal(reloaded.providerStatusRaw, "UNKNOWN_OPAQUE_STATUS_99");
    assert.equal(provider.submitCalls, 1);
  });

  it("10. Incorrect merchant attribution is rejected on preparation and status query", async () => {
    const store = new HspPaymentStore(makeTempStateFile("merchant"));
    const provider = new MockHspMcpProvider({
      onPrepare: () => ({
        ok: true,
        evidenceKind: "MOCK_SIMULATION",
        preparationId: "mock_prep_wrong_merchant",
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        attributedMerchant: "evil_spoofed_merchant",
      }),
    });
    const orch = new HspPaymentOrchestrator({
      store,
      mcpProvider: provider,
      walletAuthorizer: new MockHspWalletAuthorizer(),
    });

    const created = orch.createPayment({ ...SAMPLE_INTENT, idempotencyKey: "idem-merch-1" });
    const failed = await orch.preparePayment(created.paymentId);
    assert.equal(failed.state, "FAILED");
    assert.equal(failed.failureCode, "MERCHANT_ATTRIBUTION_MISMATCH");
    assert.equal(provider.submitCalls, 0);
  });

  it("11. Authenticated HTTP API enforces Bearer auth and exposes zero signing secrets", async () => {
    const store = new HspPaymentStore(makeTempStateFile("api"));
    const provider = new MockHspMcpProvider();
    const orch = new HspPaymentOrchestrator({
      store,
      mcpProvider: provider,
      walletAuthorizer: new MockHspWalletAuthorizer(),
    });

    const stubAgent = {
      getPositionStore: () => ({ isStateCorrupted: () => false, getPendingTxs: () => [] }),
      getExecutionMode: () => "dry_run",
    } as unknown as TrancheAutonomousAgent;
    const stubRuntime = {
      getHealthInfo: () => ({
        running: false,
        rpcHealthy: true,
        lastSuccessfulCycleAt: null,
        recoveryState: "HEALTHY",
      }),
    } as unknown as AgentRuntime;
    const policyBounds: PolicyValidationBounds = {
      hardMaxPositionSizeInventory: 100n,
      hardMaxSlippageBps: 200,
      minStopLossBps: 50,
      maxStopLossBps: 1500,
      minTakeProfitBps: 50,
      maxTakeProfitBps: 5000,
    };

    const apiToken = "test-hsp-api-token-123456";
    const server = new AgentApiServer({
      agent: stubAgent,
      runtime: stubRuntime,
      policyBounds,
      apiToken,
      port: 0,
      hspPaymentOrchestrator: orch,
    });
    const addr = await server.start();

    try {
      // Unauthenticated GET must return 401
      const unauth = await fetch(`${addr.url}/hsp/payments/status`);
      assert.equal(unauth.status, 401);

      const headers = {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      };

      const statusRes = await fetch(`${addr.url}/hsp/payments/status`, { headers });
      assert.equal(statusRes.status, 200);
      const statusJson = (await statusRes.json()) as {
        isMockEvidence: boolean;
        liveMcpConnected: boolean;
        schemaDiscovered: boolean;
      };
      assert.equal(statusJson.isMockEvidence, true);
      assert.equal(statusJson.liveMcpConnected, false);
      assert.equal(statusJson.schemaDiscovered, false);

      // Create -> Prepare -> Authorize -> Submit -> Refresh via API
      const createRes = await fetch(`${addr.url}/hsp/payments`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...SAMPLE_INTENT, idempotencyKey: "idem-api-1" }),
      });
      assert.equal(createRes.status, 201);
      const created = (await createRes.json()) as { payment: { paymentId: string; state: string } };
      const pid = created.payment.paymentId;
      assert.equal(created.payment.state, "CREATED");

      const prepRes = await fetch(`${addr.url}/hsp/payments/${pid}/prepare`, {
        method: "POST",
        headers,
      });
      assert.equal(prepRes.status, 200);

      const authRes = await fetch(`${addr.url}/hsp/payments/${pid}/authorize`, {
        method: "POST",
        headers,
        body: JSON.stringify({ explicitUserConsent: true, authorizedBy: "operator@tranche" }),
      });
      assert.equal(authRes.status, 200);

      const subRes = await fetch(`${addr.url}/hsp/payments/${pid}/submit`, {
        method: "POST",
        headers,
      });
      assert.equal(subRes.status, 200);

      const refRes = await fetch(`${addr.url}/hsp/payments/${pid}/refresh`, {
        method: "POST",
        headers,
      });
      assert.equal(refRes.status, 200);
      const finalBody = await refRes.text();
      assert.ok(finalBody.includes('"FINALIZED"'));
      assert.ok(!finalBody.includes("privateKey"));
      assert.ok(!finalBody.includes("secret"));
    } finally {
      await server.stop();
    }
  });
});
