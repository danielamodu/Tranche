import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  LocalRuleBasedLlmProvider,
  applyValidatedPolicyPatch,
  validatePolicyPatch,
  type AgentPolicyPatch,
  type LlmProvider,
  type PolicyValidationBounds,
} from "./llm.js";
import type { AgentDataSourceMode } from "./protocol-config.js";
import type { AgentRuntime, AutonomousDecisionTrace, TrancheAutonomousAgent } from "./runtime.js";
import type { SoakStatusProvider } from "./soak-evidence.js";

export interface AgentApiServerConfig {
  agent: TrancheAutonomousAgent;
  runtime: AgentRuntime;
  policyBounds: PolicyValidationBounds;
  apiToken: string;
  host?: string;
  port?: number;
  allowedOrigins?: readonly string[];
  marketLabel?: string;
  dataSource?: AgentDataSourceMode;
  chainId?: number;
  llmProvider?: LlmProvider;
  maxRequestsPerMinute?: number;
  soakProvider?: SoakStatusProvider;
}

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
] as const;

const MAX_BODY_BYTES = 16_384;

function jsonSafeReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body, jsonSafeReplacer);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(payload);
}

function constantTimeTokenMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("BODY_TOO_LARGE");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("INVALID_JSON_OBJECT");
  }
  return parsed as Record<string, unknown>;
}

function summarizeDecision(t: AutonomousDecisionTrace) {
  return {
    cycleId: t.cycleId,
    decisionKey: t.decisionKey,
    timestamp: t.timestamp,
    strategyType: t.strategyConfig.type,
    signalAction: t.signal.action,
    signalValid: t.signal.valid,
    signalConfidence: t.signal.confidence,
    signalReason: t.signal.reason,
    selectedVenue: t.venueSelection.selectedVenue,
    venueRationale: t.venueSelection.rationale,
    tranche: {
      eligible: t.venueSelection.tranche.eligible,
      offerId: t.venueSelection.tranche.offerId?.toString() ?? null,
      acquisitionCostPayment: t.venueSelection.tranche.acquisitionCostPayment.toString(),
      reservationPremiumPayment: t.venueSelection.tranche.reservationPremiumPayment.toString(),
      exercisePayment: t.venueSelection.tranche.exercisePayment.toString(),
      expectedNetProfitAtTargetPayment:
        t.venueSelection.tranche.expectedNetProfitAtTargetPayment.toString(),
      rejectionReasons: t.venueSelection.tranche.rejectionReasons,
    },
    hskswap: {
      eligible: t.venueSelection.hskswap.eligible,
      acquisitionCostPayment: t.venueSelection.hskswap.acquisitionCostPayment.toString(),
      priceImpactBps: t.venueSelection.hskswap.priceImpactBps ?? null,
      expectedNetProfitAtTargetPayment:
        t.venueSelection.hskswap.expectedNetProfitAtTargetPayment.toString(),
      rejectionReasons: t.venueSelection.hskswap.rejectionReasons,
    },
    riskAllowed: t.riskReport.allowed,
    riskChecks: t.riskReport.checks,
    failedRiskChecks: t.riskReport.failedChecks,
    selectedAction: t.selectedAction,
    rationale: t.rationale,
    txHashes: t.txHashes,
    error: t.error ?? null,
  };
}

/**
 * Localhost-bound HTTP control and telemetry API for TrancheAutonomousAgent.
 * Uses the live runtime, RiskManager, and PositionStore as the single source of truth.
 */
export class AgentApiServer {
  private readonly cfg: AgentApiServerConfig;
  private readonly allowedOrigins: Set<string>;
  private readonly host: string;
  private port: number;
  private server: Server | null = null;
  private controlBusy = false;
  private readonly startedAt = Math.floor(Date.now() / 1000);
  private readonly llmProvider: LlmProvider;
  private readonly maxRequestsPerMinute: number;
  private readonly requestTimestampsByIp = new Map<string, number[]>();

  constructor(config: AgentApiServerConfig) {
    if (!config.apiToken || config.apiToken.length < 8) {
      throw new Error("AgentApiServer requires an apiToken of at least 8 characters");
    }
    this.cfg = config;
    this.host = config.host ?? "127.0.0.1";
    this.port = config.port ?? 8787;
    this.allowedOrigins = new Set(config.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
    this.llmProvider = config.llmProvider ?? new LocalRuleBasedLlmProvider();
    this.maxRequestsPerMinute = config.maxRequestsPerMinute ?? 120;
  }

  private checkRateLimit(req: IncomingMessage): boolean {
    const ip = req.socket.remoteAddress ?? "127.0.0.1";
    const now = Date.now();
    const windowStart = now - 60_000;
    const prev = (this.requestTimestampsByIp.get(ip) ?? []).filter((t) => t > windowStart);
    if (prev.length >= this.maxRequestsPerMinute) {
      this.requestTimestampsByIp.set(ip, prev);
      return false;
    }
    prev.push(now);
    this.requestTimestampsByIp.set(ip, prev);
    return true;
  }

  getAddress(): { host: string; port: number; url: string } {
    return { host: this.host, port: this.port, url: `http://${this.host}:${this.port}` };
  }

  async start(): Promise<{ host: string; port: number; url: string }> {
    if (this.server) return this.getAddress();
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, this.host, () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        resolve();
      });
    });
    return this.getAddress();
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private applyCors(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin;
    if (origin) {
      if (!this.allowedOrigins.has(origin)) {
        sendJson(res, 403, { error: "CORS_ORIGIN_FORBIDDEN", message: "Origin not allowed" });
        return false;
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Agent-Token");
    }
    return true;
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      return constantTimeTokenMatch(authHeader.slice(7).trim(), this.cfg.apiToken);
    }
    const tokenHeader = req.headers["x-agent-token"];
    if (typeof tokenHeader === "string") {
      return constantTimeTokenMatch(tokenHeader.trim(), this.cfg.apiToken);
    }
    return false;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.applyCors(req, res)) return;

    const method = req.method ?? "GET";
    if (method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (!this.checkRateLimit(req)) {
      return sendJson(res, 429, {
        error: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests; retry after 60s",
      });
    }

    const url = new URL(req.url ?? "/", `http://${this.host}:${this.port}`);
    const pathname = url.pathname;

    try {
      // Public read-only endpoints (localhost only, zero secrets)
      if (method === "GET" && pathname === "/health") {
        const store = this.cfg.agent.getPositionStore();
        const health = this.cfg.runtime.getHealthInfo();
        const dataSource = this.cfg.dataSource ?? "fixture";
        const soak = this.cfg.soakProvider?.getStatusSummary() ?? null;
        return sendJson(res, 200, {
          ok: !store.isStateCorrupted(),
          uptimeSec: Math.floor(Date.now() / 1000) - this.startedAt,
          runtimeRunning: health.running,
          rpcHealthy: health.rpcHealthy,
          lastSuccessfulCycleAt: health.lastSuccessfulCycleAt,
          recoveryState: health.recoveryState,
          mode: this.cfg.agent.getExecutionMode(),
          dataSource,
          chainId: this.cfg.chainId ?? 0,
          quotesAreReal: dataSource !== "fixture",
          stateCorrupted: store.isStateCorrupted(),
          pendingTxCount: store.getPendingTxs().length,
          soakSessionId: soak?.sessionId ?? null,
          evidenceDir: soak?.evidenceDir ?? null,
        });
      }

      if (method === "GET" && pathname === "/ready") {
        const store = this.cfg.agent.getPositionStore();
        const health = this.cfg.runtime.getHealthInfo();
        const limits = this.cfg.agent.getRiskLimits();
        const ready = !store.isStateCorrupted() && !limits.killSwitch && health.rpcHealthy;
        return sendJson(res, ready ? 200 : 503, {
          ready,
          recoveryState: health.recoveryState,
          rpcHealthy: health.rpcHealthy,
          killSwitch: limits.killSwitch,
          stateCorrupted: store.isStateCorrupted(),
        });
      }

      if (method === "GET" && pathname === "/agent/soak") {
        if (this.cfg.soakProvider) {
          return sendJson(res, 200, this.cfg.soakProvider.getStatusSummary());
        }
        const health = this.cfg.runtime.getHealthInfo();
        const traces = this.cfg.agent.getTraces();
        const dataSource = this.cfg.dataSource ?? "fixture";
        return sendJson(res, 200, {
          active: false,
          sessionId: null,
          status: "INACTIVE",
          plannedDurationHours: null,
          mode: this.cfg.agent.getExecutionMode(),
          dataSource,
          chainId: this.cfg.chainId ?? 0,
          marketLabel: this.cfg.marketLabel ?? "WHSK/USDT",
          startedAt: new Date(this.startedAt * 1000).toISOString(),
          uptimeSec: Math.floor(Date.now() / 1000) - this.startedAt,
          lastSuccessfulObservationAt: health.lastSuccessfulCycleAt,
          latestSnapshot: null,
          rpcHealth: {
            healthy: health.rpcHealthy,
            successRate: 1,
            avgLatencyMs: 0,
            maxLatencyMs: 0,
            lastLatencyMs: null,
          },
          cycles: {
            total: traces.length,
            successful: traces.length,
            failed: 0,
            missed: 0,
          },
          decisionsByVenue: { TRANCHE: 0, HSKSWAP: 0, NONE: 0 },
          riskRejectionCount: 0,
          duplicateDecisionCount: 0,
          observedRegimes: { CALM: 0, TRENDING: 0, VOLATILE: 0, DISLOCATED: 0 },
          unobservedRegimes: ["CALM", "TRENDING", "VOLATILE", "DISLOCATED"],
          errorsCount: health.consecutiveErrors,
          recoveriesCount: 0,
          retriesCount: 0,
          txBroadcastCount: 0,
          evidenceDir: null,
        });
      }

      if (method === "GET" && pathname === "/agent/status") {
        const limits = this.cfg.agent.getRiskLimits();
        const strategy = this.cfg.agent.getStrategyConfig();
        const traces = this.cfg.agent.getTraces();
        const last = traces.length > 0 ? traces[traces.length - 1] : null;
        const store = this.cfg.agent.getPositionStore();
        const health = this.cfg.runtime.getHealthInfo();
        const dataSource = this.cfg.dataSource ?? "fixture";
        const soak = this.cfg.soakProvider?.getStatusSummary() ?? null;
        return sendJson(res, 200, {
          running: health.running,
          rpcHealthy: health.rpcHealthy,
          lastSuccessfulCycleAt: health.lastSuccessfulCycleAt,
          recoveryState: health.recoveryState,
          mode: this.cfg.agent.getExecutionMode(),
          dataSource,
          chainId: this.cfg.chainId ?? 0,
          quotesAreReal: dataSource !== "fixture",
          market: this.cfg.marketLabel ?? "WHSK/USDT",
          activeStrategy: strategy.type,
          paused: limits.paused,
          killSwitch: limits.killSwitch,
          stateCorrupted: store.isStateCorrupted(),
          pendingTxs: store.getPendingTxs(),
          soakSessionId: soak?.sessionId ?? null,
          evidenceDir: soak?.evidenceDir ?? null,
          lastCycleId: last?.cycleId ?? null,
          lastCycleTimestamp: last?.timestamp ?? null,
          lastDecisionAction: last?.selectedAction ?? null,
          lastSelectedVenue: last?.venueSelection.selectedVenue ?? null,
          lastTxHash:
            traces
              .slice()
              .reverse()
              .find((t) => t.txHashes.length > 0)?.txHashes[0] ?? null,
        });
      }

      if (method === "GET" && pathname === "/agent/policy/history") {
        const persisted = this.cfg.agent.getPositionStore().getPersistedRuntimeConfig();
        return sendJson(res, 200, {
          currentVersion: persisted?.policyVersion ?? 0,
          history: persisted?.policyHistory ?? [],
        });
      }

      if (method === "GET" && pathname === "/agent/metrics") {
        const store = this.cfg.agent.getPositionStore();
        const nowSec = Math.floor(Date.now() / 1000);
        const portfolio = store.getPortfolioState(nowSec);
        const allPositions = store.getAllPositions();
        const closed = allPositions.filter((p) => p.status === "CLOSED");
        const wins = closed.filter((p) => p.realizedPnlPayment > 0n).length;
        const losses = closed.filter((p) => p.realizedPnlPayment < 0n).length;
        let totalRealizedPnl = 0n;
        let totalUnrealizedPnl = 0n;
        for (const p of allPositions) {
          totalRealizedPnl += p.realizedPnlPayment;
          if (p.status !== "CLOSED") totalUnrealizedPnl += p.unrealizedPnlPayment;
        }
        const traces = this.cfg.agent.getTraces();
        const liveExecutions = traces.filter((t) => t.txHashes.length > 0).length;
        const dryRunEvaluations = traces.filter((t) => t.selectedAction.startsWith("DRY_RUN_")).length;

        return sendJson(res, 200, {
          mode: this.cfg.agent.getExecutionMode(),
          totalRealizedPnlPayment: totalRealizedPnl.toString(),
          totalUnrealizedPnlPayment: totalUnrealizedPnl.toString(),
          currentTotalExposurePayment: portfolio.currentTotalExposurePayment.toString(),
          dailyPremiumSpentPayment: portfolio.dailyPremiumSpentPayment.toString(),
          dailyRealizedLossPayment: portfolio.dailyRealizedLossPayment.toString(),
          openPositionsCount: portfolio.openPositionsCount,
          activeTicketsCount: portfolio.activeTicketsCount,
          pendingTxCount: portfolio.pendingTxCount,
          closedPositionsCount: closed.length,
          wins,
          losses,
          totalCycles: traces.length,
          liveExecutionsCount: liveExecutions,
          dryRunEvaluationsCount: dryRunEvaluations,
        });
      }

      if (method === "GET" && pathname === "/agent/decisions") {
        const limitParam = Number(url.searchParams.get("limit") ?? "25");
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(100, limitParam) : 25;
        const traces = this.cfg.agent.getTraces();
        const items = traces.slice(-limit).reverse().map(summarizeDecision);
        return sendJson(res, 200, { total: traces.length, items });
      }

      if (method === "GET" && pathname === "/agent/positions") {
        const store = this.cfg.agent.getPositionStore();
        return sendJson(res, 200, {
          open: store.getOpenPositions(),
          all: store.getAllPositions(),
        });
      }

      if (method === "GET" && pathname === "/agent/tickets") {
        const store = this.cfg.agent.getPositionStore();
        return sendJson(res, 200, {
          active: store.getActiveTickets(),
          all: store.getAllTickets(),
        });
      }

      if (method === "GET" && pathname === "/agent/markets") {
        const traces = this.cfg.agent.getTraces();
        const last = traces.length > 0 ? traces[traces.length - 1] : null;
        if (!last) {
          return sendJson(res, 200, {
            available: false,
            market: this.cfg.marketLabel ?? "WHSK/USDT",
            snapshot: null,
            venueComparison: null,
          });
        }
        return sendJson(res, 200, {
          available: true,
          market: this.cfg.marketLabel ?? "WHSK/USDT",
          timestamp: last.timestamp,
          pool: last.snapshot.pool,
          oracle: last.snapshot.oracle,
          oracleAgeSec: last.snapshot.oracleAgeSec,
          oracleDeviationBps: last.snapshot.oracleDeviationBps,
          dexBuyQuote: last.snapshot.dexBuyQuote,
          dexSellQuote: last.snapshot.dexSellQuote,
          trancheOffersCount: last.snapshot.trancheOffers.evaluations.length,
          trancheSelectedOffer: last.snapshot.trancheOffers.selected,
          realizedVolatilityBps: last.snapshot.realizedVolatilityBps,
          momentumReturnBps: last.snapshot.momentumReturnBps,
          dislocationVsTwapBps: last.snapshot.dislocationVsTwapBps,
          marketRegime: last.snapshot.marketRegime,
          anomalies: last.snapshot.anomalies,
          venueComparison: last.venueSelection,
        });
      }

      if (method === "GET" && pathname === "/agent/config") {
        return sendJson(res, 200, {
          mode: this.cfg.agent.getExecutionMode(),
          strategy: this.cfg.agent.getStrategyConfig(),
          riskLimits: this.cfg.agent.getRiskLimits(),
          venueConstraints: this.cfg.agent.getVenueConstraints(),
          policyBounds: this.cfg.policyBounds,
          intent: this.cfg.agent.getIntent(),
        });
      }

      // All POST endpoints require authentication
      if (method === "POST") {
        if (!this.isAuthorized(req)) {
          return sendJson(res, 401, {
            error: "UNAUTHORIZED",
            message: "Valid Bearer or X-Agent-Token required for state-changing endpoints",
          });
        }

        if (pathname === "/agent/start") {
          if (this.controlBusy) {
            return sendJson(res, 409, { error: "CONTROL_BUSY", message: "Control operation in progress" });
          }
          const limits = this.cfg.agent.getRiskLimits();
          const store = this.cfg.agent.getPositionStore();
          if (limits.killSwitch) {
            return sendJson(res, 409, {
              error: "KILL_SWITCH_ACTIVE",
              message: "Cannot start runtime while kill switch is active",
            });
          }
          if (store.isStateCorrupted()) {
            return sendJson(res, 409, {
              error: "STATE_CORRUPTED",
              message: "Cannot start runtime with corrupted persisted state",
            });
          }
          this.controlBusy = true;
          try {
            this.cfg.runtime.start();
            return sendJson(res, 200, {
              ok: true,
              running: this.cfg.runtime.isRunning(),
              mode: this.cfg.agent.getExecutionMode(),
            });
          } finally {
            this.controlBusy = false;
          }
        }

        if (pathname === "/agent/pause") {
          this.cfg.agent.setPaused(true);
          return sendJson(res, 200, {
            ok: true,
            paused: this.cfg.agent.getRiskLimits().paused,
            killSwitch: this.cfg.agent.getRiskLimits().killSwitch,
          });
        }

        if (pathname === "/agent/resume") {
          const limits = this.cfg.agent.getRiskLimits();
          const store = this.cfg.agent.getPositionStore();
          if (limits.killSwitch) {
            return sendJson(res, 409, {
              error: "KILL_SWITCH_ACTIVE",
              message: "Resume denied: kill switch is authoritative and cannot be cleared via /agent/resume",
            });
          }
          if (store.isStateCorrupted()) {
            return sendJson(res, 409, {
              error: "STATE_CORRUPTED",
              message: "Resume denied: persisted state is corrupted",
            });
          }
          if (store.getPendingTxs().length > 0) {
            return sendJson(res, 409, {
              error: "PENDING_TX_UNRESOLVED",
              message: "Resume denied: reconcile uncertain pending transactions via POST /agent/reconcile first",
            });
          }
          this.cfg.agent.setPaused(false);
          return sendJson(res, 200, {
            ok: true,
            paused: this.cfg.agent.getRiskLimits().paused,
          });
        }

        if (pathname === "/agent/kill") {
          if (this.controlBusy) {
            return sendJson(res, 409, { error: "CONTROL_BUSY", message: "Control operation in progress" });
          }
          this.controlBusy = true;
          try {
            this.cfg.agent.triggerKillSwitch();
            await this.cfg.runtime.stop();
            return sendJson(res, 200, {
              ok: true,
              running: this.cfg.runtime.isRunning(),
              paused: this.cfg.agent.getRiskLimits().paused,
              killSwitch: this.cfg.agent.getRiskLimits().killSwitch,
            });
          } finally {
            this.controlBusy = false;
          }
        }

        if (pathname === "/agent/strategy") {
          const body = await readJsonBody(req);
          const allowedKeys = new Set([
            "strategyType",
            "takeProfitBps",
            "stopLossBps",
            "maxSlippageBps",
            "maxPositionSizeInventory",
          ]);
          const unknownKeys = Object.keys(body).filter((k) => !allowedKeys.has(k));
          if (unknownKeys.length > 0) {
            return sendJson(res, 400, {
              error: "UNKNOWN_FIELDS",
              message: `Unsupported fields: ${unknownKeys.join(", ")}`,
            });
          }

          const patch: AgentPolicyPatch = {};
          if (body.strategyType !== undefined) {
            if (typeof body.strategyType !== "string") {
              return sendJson(res, 400, { error: "INVALID_FIELD", message: "strategyType must be a string" });
            }
            patch.strategyType = body.strategyType as AgentPolicyPatch["strategyType"];
          }
          if (body.takeProfitBps !== undefined) {
            if (typeof body.takeProfitBps !== "number") {
              return sendJson(res, 400, { error: "INVALID_FIELD", message: "takeProfitBps must be a number" });
            }
            patch.takeProfitBps = body.takeProfitBps;
          }
          if (body.stopLossBps !== undefined) {
            if (typeof body.stopLossBps !== "number") {
              return sendJson(res, 400, { error: "INVALID_FIELD", message: "stopLossBps must be a number" });
            }
            patch.stopLossBps = body.stopLossBps;
          }
          if (body.maxSlippageBps !== undefined) {
            if (typeof body.maxSlippageBps !== "number") {
              return sendJson(res, 400, { error: "INVALID_FIELD", message: "maxSlippageBps must be a number" });
            }
            patch.maxSlippageBps = body.maxSlippageBps;
          }
          if (body.maxPositionSizeInventory !== undefined) {
            if (typeof body.maxPositionSizeInventory !== "string" && typeof body.maxPositionSizeInventory !== "number") {
              return sendJson(res, 400, {
                error: "INVALID_FIELD",
                message: "maxPositionSizeInventory must be a numeric string",
              });
            }
            try {
              patch.maxPositionSizeInventory = BigInt(body.maxPositionSizeInventory);
            } catch {
              return sendJson(res, 400, {
                error: "INVALID_FIELD",
                message: "maxPositionSizeInventory must be a valid integer",
              });
            }
          }

          const validation = applyValidatedPolicyPatch(
            this.cfg.agent.getStrategyConfig(),
            this.cfg.agent.getRiskLimits(),
            patch,
            this.cfg.policyBounds,
          );
          if (!validation.valid) {
            return sendJson(res, 400, {
              error: "POLICY_VALIDATION_FAILED",
              rejectedFields: validation.rejectedFields,
              message: `Rejected out-of-bounds fields: ${validation.rejectedFields.join(", ")}`,
            });
          }

          const saved = this.cfg.agent
            .getPositionStore()
            .saveRuntimeConfig(
              this.cfg.agent.getStrategyConfig(),
              this.cfg.agent.getRiskLimits(),
              { source: "api" },
            );

          return sendJson(res, 200, {
            ok: true,
            policyVersion: saved.version,
            strategy: this.cfg.agent.getStrategyConfig(),
            riskLimits: this.cfg.agent.getRiskLimits(),
          });
        }

        if (pathname === "/agent/policy/propose") {
          const body = await readJsonBody(req);
          if (typeof body.instruction !== "string" || !body.instruction.trim()) {
            return sendJson(res, 400, {
              error: "INVALID_FIELD",
              message: "instruction (non-empty string) is required",
            });
          }
          const proposedPatch = await this.llmProvider.parseInstruction(
            body.instruction,
            this.cfg.agent.getStrategyConfig(),
            this.cfg.agent.getRiskLimits(),
          );
          const validation = validatePolicyPatch(proposedPatch, this.cfg.policyBounds);
          return sendJson(res, 200, {
            provider: this.llmProvider.name,
            instruction: body.instruction,
            proposedPatch,
            validation,
            applied: false,
          });
        }

        if (pathname === "/agent/policy/apply") {
          const body = await readJsonBody(req);
          if (typeof body.instruction !== "string" || !body.instruction.trim()) {
            return sendJson(res, 400, {
              error: "INVALID_FIELD",
              message: "instruction (non-empty string) is required",
            });
          }
          const proposedPatch = await this.llmProvider.parseInstruction(
            body.instruction,
            this.cfg.agent.getStrategyConfig(),
            this.cfg.agent.getRiskLimits(),
          );
          const validation = applyValidatedPolicyPatch(
            this.cfg.agent.getStrategyConfig(),
            this.cfg.agent.getRiskLimits(),
            proposedPatch,
            this.cfg.policyBounds,
          );
          if (!validation.valid) {
            return sendJson(res, 400, {
              error: "POLICY_VALIDATION_FAILED",
              rejectedFields: validation.rejectedFields,
              message: `Rejected fields: ${validation.rejectedFields.join(", ")}`,
            });
          }
          const saved = this.cfg.agent
            .getPositionStore()
            .saveRuntimeConfig(
              this.cfg.agent.getStrategyConfig(),
              this.cfg.agent.getRiskLimits(),
              { source: "llm", instruction: body.instruction },
            );
          return sendJson(res, 200, {
            ok: true,
            policyVersion: saved.version,
            instruction: body.instruction,
            appliedPatch: validation.sanitizedPatch,
            strategy: this.cfg.agent.getStrategyConfig(),
            riskLimits: this.cfg.agent.getRiskLimits(),
          });
        }

        if (pathname === "/agent/policy/rollback") {
          const body = await readJsonBody(req);
          if (typeof body.version !== "number" || !Number.isInteger(body.version) || body.version < 1) {
            return sendJson(res, 400, {
              error: "INVALID_FIELD",
              message: "version (positive integer) is required",
            });
          }
          const restored = this.cfg.agent.getPositionStore().rollbackPolicy(body.version);
          if (!restored) {
            return sendJson(res, 404, {
              error: "POLICY_VERSION_NOT_FOUND",
              message: `No policy version ${body.version} found in history`,
            });
          }
          Object.assign(this.cfg.agent.getStrategyConfig(), restored.strategy);
          Object.assign(this.cfg.agent.getRiskLimits(), restored.riskLimits);
          return sendJson(res, 200, {
            ok: true,
            policyVersion: restored.version,
            restoredFromVersion: body.version,
            strategy: this.cfg.agent.getStrategyConfig(),
            riskLimits: this.cfg.agent.getRiskLimits(),
          });
        }

        if (pathname === "/agent/reconcile") {
          const body = await readJsonBody(req);
          const pendingTxId = body.pendingTxId;
          const resolution = body.resolution;
          if (typeof pendingTxId !== "string" || !pendingTxId.trim()) {
            return sendJson(res, 400, {
              error: "INVALID_FIELD",
              message: "pendingTxId (non-empty string) is required",
            });
          }
          if (resolution !== "CONFIRMED_FAILED" && resolution !== "CONFIRMED_MANUAL") {
            return sendJson(res, 400, {
              error: "INVALID_FIELD",
              message: "resolution must be CONFIRMED_FAILED or CONFIRMED_MANUAL",
            });
          }
          const reconciled = this.cfg.agent.reconcilePendingTx(pendingTxId);
          if (!reconciled) {
            return sendJson(res, 404, {
              error: "PENDING_TX_NOT_FOUND",
              message: `No pending transaction found with id ${pendingTxId}`,
            });
          }
          return sendJson(res, 200, {
            ok: true,
            pendingTxId,
            resolution,
            remainingPendingTxs: this.cfg.agent.getPositionStore().getPendingTxs().length,
          });
        }
      }

      return sendJson(res, 404, { error: "NOT_FOUND", message: `Unknown route ${method} ${pathname}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "BODY_TOO_LARGE") {
        return sendJson(res, 413, { error: "BODY_TOO_LARGE", message: "Request body exceeds 16KB limit" });
      }
      if (msg === "INVALID_JSON_OBJECT" || err instanceof SyntaxError) {
        return sendJson(res, 400, { error: "INVALID_JSON", message: "Request body must be a valid JSON object" });
      }
      return sendJson(res, 500, { error: "INTERNAL_ERROR", message: "Unexpected server error" });
    }
  }
}
