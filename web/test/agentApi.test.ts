import test from "node:test";
import assert from "node:assert/strict";
import { AgentApiClient, AgentApiError } from "@/lib/agentApi";

test("AgentApiClient: parses typed snapshot and forwards Bearer token on POST", async () => {
  const seenAuth: string[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (init?.method === "POST") {
      seenAuth.push(headers.Authorization ?? "");
      if (url.endsWith("/agent/strategy")) {
        return new Response(
          JSON.stringify({
            error: "POLICY_VALIDATION_FAILED",
            message: "Out of bounds",
            rejectedFields: ["maxSlippageBps:9999"],
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true, paused: true, killSwitch: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const payloads: Record<string, unknown> = {
      "/health": {
        ok: true,
        uptimeSec: 12,
        runtimeRunning: true,
        mode: "dry_run",
        stateCorrupted: false,
        pendingTxCount: 0,
      },
      "/agent/status": {
        running: true,
        mode: "dry_run",
        market: "WHSK/USDT",
        activeStrategy: "price_threshold",
        paused: false,
        killSwitch: false,
        stateCorrupted: false,
        pendingTxs: [],
        lastCycleId: 1,
        lastCycleTimestamp: 1_700_000_000,
        lastDecisionAction: "DRY_RUN_RESERVE_TRANCHE",
        lastSelectedVenue: "TRANCHE",
        lastTxHash: null,
      },
      "/agent/metrics": {
        mode: "dry_run",
        totalRealizedPnlPayment: "0",
        totalUnrealizedPnlPayment: "0",
        currentTotalExposurePayment: "0",
        dailyPremiumSpentPayment: "0",
        dailyRealizedLossPayment: "0",
        openPositionsCount: 0,
        activeTicketsCount: 0,
        pendingTxCount: 0,
        closedPositionsCount: 0,
        wins: 0,
        losses: 0,
        totalCycles: 1,
        liveExecutionsCount: 0,
        dryRunEvaluationsCount: 1,
      },
      "/agent/decisions?limit=20": { total: 0, items: [] },
      "/agent/positions": { open: [], all: [] },
      "/agent/tickets": { active: [], all: [] },
      "/agent/markets": { available: false, market: "WHSK/USDT" },
      "/agent/config": {
        mode: "dry_run",
        strategy: {
          type: "price_threshold",
          momentumThresholdBps: 50,
          maxEntryPriceX36: "85000000000000000000000",
          takeProfitBps: 500,
          stopLossBps: 300,
          takeProfitExitBps: 10000,
          ticketExerciseWindowSec: 300,
        },
        riskLimits: {
          maxPositionSizeInventory: "200000000000000000000",
          maxTotalExposurePayment: "50000000",
          maxDailyPremiumBudgetPayment: "1000000",
          maxDailyRealizedLossPayment: "5000000",
          maxConcurrentPositions: 3,
          maxConcurrentTickets: 3,
          maxSlippageBps: 100,
          minPoolLiquidity: "100000000000",
          maxOracleAgeSec: 60,
          maxOracleDeviationBps: 300,
          paused: false,
          killSwitch: false,
        },
        policyBounds: {
          hardMaxPositionSizeInventory: "500000000000000000000",
          hardMaxSlippageBps: 200,
          minStopLossBps: 50,
          maxStopLossBps: 1500,
          minTakeProfitBps: 50,
          maxTakeProfitBps: 5000,
        },
      },
    };
    const pathKey = Object.keys(payloads).find((k) => url.endsWith(k));
    return new Response(JSON.stringify(pathKey ? payloads[pathKey] : {}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const client = new AgentApiClient({
    baseUrl: "http://127.0.0.1:8787",
    token: "secret-local-token",
    fetchImpl: mockFetch,
  });

  const snap = await client.fetchSnapshot();
  assert.equal(snap.status.mode, "dry_run");
  assert.equal(snap.status.lastSelectedVenue, "TRANCHE");
  assert.equal(snap.metrics.dryRunEvaluationsCount, 1);

  const pauseRes = await client.pause();
  assert.equal(pauseRes.paused, true);
  assert.equal(seenAuth[0], "Bearer secret-local-token");

  await assert.rejects(
    () => client.updateStrategy({ maxSlippageBps: 9999 }),
    (err: unknown) =>
      err instanceof AgentApiError &&
      err.status === 400 &&
      err.code === "POLICY_VALIDATION_FAILED" &&
      err.rejectedFields?.length === 1,
  );
});

test("AgentApiClient: surfaces API_UNREACHABLE cleanly on network disconnection", async () => {
  const client = new AgentApiClient({
    baseUrl: "http://127.0.0.1:19999",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });

  await assert.rejects(
    () => client.fetchSnapshot(),
    (err: unknown) => err instanceof AgentApiError && err.status === 0 && err.code === "API_UNREACHABLE",
  );
});
