import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { BPS_DENOMINATOR } from "./hskswap.js";
import { redactSensitive } from "./logger.js";
import type { MarketRegime } from "./market.js";
import type { AgentDataSourceMode } from "./protocol-config.js";
import type {
  AgentExecutionMode,
  AutonomousAction,
  AutonomousDecisionTrace,
} from "./runtime.js";
import type { SelectedVenue } from "./venue.js";

export type SoakEventType =
  | "STARTUP"
  | "RESTART_RESUMED"
  | "SHUTDOWN"
  | "RPC_ERROR"
  | "RPC_LATENCY"
  | "RETRY"
  | "RECOVERY"
  | "STATE_RESTORE"
  | "MISSED_CYCLE"
  | "HEALTH_TRANSITION"
  | "CORRUPTED_STATE"
  | "DURATION_COMPLETE";

export type SoakSessionStatus = "RUNNING" | "COMPLETED" | "STOPPED" | "FAILED";

export interface SoakSnapshotRecord {
  recordType: "market_snapshot";
  sessionId: string;
  recordedAt: string;
  chainId: number;
  blockNumber: string | null;
  snapshotTimestamp: number;
  pair: {
    label: string;
    inventoryToken: string;
    paymentToken: string;
    poolAddress: string;
    poolFee: number;
  };
  spotPriceX36: string;
  twapPriceX36: string | null;
  oraclePriceX36: string | null;
  oracleAgeSec: number | null;
  oracleDeviationBps: number | null;
  oracleValid: boolean | null;
  liquidity: string;
  roundTripSpreadBps: number | null;
  dexBuyImpactBps: number | null;
  dexSellImpactBps: number | null;
  realizedVolatilityBps: number;
  momentumReturnBps: number;
  dislocationVsTwapBps: number;
  marketRegime: MarketRegime;
  dataSourceHealthy: boolean;
  anomalies: string[];
}

export interface SoakDecisionRecord {
  recordType: "agent_decision";
  sessionId: string;
  recordedAt: string;
  decisionId: string;
  decisionKey: string;
  cycleId: number;
  timestamp: number;
  strategyType: string;
  policyVersion: number;
  snapshotRef: {
    snapshotTimestamp: number;
    blockNumber: string | null;
    marketRegime: MarketRegime;
    dataSourceHealthy: boolean;
  };
  riskEvaluation: {
    allowed: boolean;
    failedChecks: Array<{ name: string; detail: string }>;
  };
  selectedVenue: SelectedVenue;
  selectedAction: AutonomousAction;
  expectedExecutionCostPayment: string;
  estimatedGasUnits: string | null;
  estimatedGasCostPayment: string | null;
  reasoningCodes: string[];
  explanation: string;
  executionMode: AgentExecutionMode;
  executionBlockedByReadOnly: boolean;
  txBroadcastCount: number;
}

export interface SoakOperationalEventRecord {
  recordType: "operational_event";
  sessionId: string;
  recordedAt: string;
  eventType: SoakEventType;
  details: Record<string, unknown>;
}

export interface SoakMetricsRecord {
  recordType: "periodic_metrics";
  sessionId: string;
  recordedAt: string;
  uptimeSec: number;
  totalCycles: number;
  successfulCycles: number;
  failedCycles: number;
  missedCycles: number;
  rpcSuccessRate: number;
  avgRpcLatencyMs: number;
  maxRpcLatencyMs: number;
  lastRpcLatencyMs: number | null;
  decisionsByVenue: Record<SelectedVenue, number>;
  riskRejectionCount: number;
  duplicateDecisionCount: number;
  observedRegimes: Record<MarketRegime, number>;
  latestSnapshotAgeSec: number | null;
  errorCount: number;
  retryCount: number;
  recoveryCount: number;
  txBroadcastCount: number;
}

export interface SoakSessionMetadata {
  sessionId: string;
  status: SoakSessionStatus;
  startedAt: string;
  startedAtSec: number;
  endedAt: string | null;
  plannedDurationHours: number;
  dataSource: AgentDataSourceMode;
  executionMode: AgentExecutionMode;
  chainId: number;
  marketLabel: string;
  pollIntervalMs: number;
  evidenceDir: string;
  stateFile: string | null;
  pid: number;
  restartsCount: number;
  lastResumedAt: string | null;
  latestMetrics: SoakMetricsRecord | null;
}

export interface SoakStatusSummary {
  active: boolean;
  sessionId: string;
  status: SoakSessionStatus;
  plannedDurationHours: number;
  mode: AgentExecutionMode;
  dataSource: AgentDataSourceMode;
  chainId: number;
  marketLabel: string;
  startedAt: string;
  uptimeSec: number;
  restartsCount: number;
  lastResumedAt: string | null;
  remainingPlannedSec: number;
  lastSuccessfulObservationAt: number | null;
  latestSnapshot: SoakSnapshotRecord | null;
  rpcHealth: {
    healthy: boolean;
    successRate: number;
    avgLatencyMs: number;
    maxLatencyMs: number;
    lastLatencyMs: number | null;
  };
  cycles: {
    total: number;
    successful: number;
    failed: number;
    missed: number;
  };
  decisionsByVenue: Record<SelectedVenue, number>;
  riskRejectionCount: number;
  duplicateDecisionCount: number;
  observedRegimes: Record<MarketRegime, number>;
  unobservedRegimes: MarketRegime[];
  errorsCount: number;
  recoveriesCount: number;
  retriesCount: number;
  txBroadcastCount: number;
  evidenceDir: string;
}

export interface SoakStatusProvider {
  getStatusSummary(): SoakStatusSummary;
}

export interface SoakEvidenceStoreConfig {
  logDir: string;
  sessionId?: string;
  /** When true, automatically resumes an unfinished (RUNNING) session tracked in active-session.json */
  resumeIfActive?: boolean;
  plannedDurationHours: number;
  dataSource: AgentDataSourceMode;
  executionMode: AgentExecutionMode;
  chainId: number;
  marketLabel: string;
  pollIntervalMs: number;
  stateFile?: string;
  /** Optional max number of snapshot JSONL records to retain on disk (0 = unlimited) */
  maxRetainedSnapshots?: number;
}

const ALL_REGIMES: readonly MarketRegime[] = ["CALM", "TRENDING", "VOLATILE", "DISLOCATED"];

function safeStringify(obj: unknown): string {
  return JSON.stringify(redactSensitive(obj));
}

function buildReasoningCodes(trace: AutonomousDecisionTrace): string[] {
  const codes: string[] = [];
  codes.push(`ACTION:${trace.selectedAction}`);
  codes.push(`VENUE:${trace.venueSelection.selectedVenue}`);
  codes.push(`SIGNAL:${trace.signal.action}`);
  codes.push(`REGIME:${trace.snapshot.marketRegime}`);
  if (trace.executionBlockedByReadOnly) {
    codes.push("EXECUTION_BLOCKED_READ_ONLY");
  }
  for (const anomaly of trace.snapshot.anomalies) {
    codes.push(`ANOMALY:${anomaly.split(":")[0]}`);
  }
  for (const failed of trace.riskReport.failedChecks) {
    codes.push(`RISK_FAIL:${failed.name}`);
  }
  return codes;
}

function computeRoundTripSpreadBps(trace: AutonomousDecisionTrace): number | null {
  const buy = trace.snapshot.dexBuyQuote;
  const sell = trace.snapshot.dexSellQuote;
  if (!buy || !sell || buy.paymentAmountIn <= 0n) return null;
  if (buy.paymentAmountIn <= sell.paymentAmountOut) return 0;
  return Number(
    ((buy.paymentAmountIn - sell.paymentAmountOut) * BPS_DENOMINATOR) / buy.paymentAmountIn,
  );
}

/**
 * Persistent append-only JSONL evidence store for continuous read-only soak sessions.
 * All records are attributable to a sessionId and automatically scrubbed of secrets.
 */
export class SoakEvidenceStore implements SoakStatusProvider {
  public readonly sessionId: string;
  public readonly sessionDir: string;
  public readonly snapshotsPath: string;
  public readonly decisionsPath: string;
  public readonly eventsPath: string;
  public readonly metricsPath: string;
  public readonly sessionMetaPath: string;
  public readonly resumed: boolean;

  private readonly cfg: SoakEvidenceStoreConfig;
  private readonly activeMarkerPath: string;
  private readonly startedAtDate: Date;
  private readonly startedAtSec: number;
  private plannedDurationHours: number;
  private status: SoakSessionStatus = "RUNNING";
  private endedAt: string | null = null;
  private restartsCount = 0;
  private lastResumedAt: string | null = null;

  private successfulCycles = 0;
  private failedCycles = 0;
  private missedCycles = 0;
  private errorCount = 0;
  private retryCount = 0;
  private recoveryCount = 0;
  private riskRejectionCount = 0;
  private duplicateDecisionCount = 0;
  private txBroadcastCount = 0;
  private rpcHealthy = true;

  private latencyCount = 0;
  private latencySumMs = 0;
  private maxRpcLatencyMs = 0;
  private lastRpcLatencyMs: number | null = null;
  private lastSuccessfulObservationAt: number | null = null;
  private latestSnapshot: SoakSnapshotRecord | null = null;
  private writtenSnapshotsCount = 0;

  private readonly decisionsByVenue: Record<SelectedVenue, number> = {
    TRANCHE: 0,
    HSKSWAP: 0,
    NONE: 0,
  };

  private readonly observedRegimes: Record<MarketRegime, number> = {
    CALM: 0,
    TRENDING: 0,
    VOLATILE: 0,
    DISLOCATED: 0,
  };

  constructor(config: SoakEvidenceStoreConfig) {
    this.cfg = config;
    this.activeMarkerPath = path.resolve(config.logDir, "active-session.json");
    this.plannedDurationHours = config.plannedDurationHours;

    // Resolve whether we are resuming an existing session
    let targetSessionId = config.sessionId;
    if (!targetSessionId && config.resumeIfActive && existsSync(this.activeMarkerPath)) {
      try {
        const marker = JSON.parse(readFileSync(this.activeMarkerPath, "utf8")) as {
          sessionId?: string;
        };
        if (marker.sessionId) {
          const candidateMetaPath = path.resolve(config.logDir, marker.sessionId, "session.json");
          if (existsSync(candidateMetaPath)) {
            const candidate = JSON.parse(
              readFileSync(candidateMetaPath, "utf8"),
            ) as SoakSessionMetadata;
            if (candidate.status === "RUNNING") {
              targetSessionId = candidate.sessionId;
            }
          }
        }
      } catch {
        // ignore corrupted active-session pointer; start fresh session
      }
    }

    const nowDate = new Date();
    const candidateDir = targetSessionId
      ? path.resolve(config.logDir, targetSessionId)
      : null;
    const candidateMetaPath = candidateDir ? path.join(candidateDir, "session.json") : null;

    if (targetSessionId && candidateDir && candidateMetaPath && existsSync(candidateMetaPath)) {
      const existing = JSON.parse(
        readFileSync(candidateMetaPath, "utf8"),
      ) as SoakSessionMetadata;
      if (existing.status === "COMPLETED" && config.plannedDurationHours <= existing.plannedDurationHours) {
        throw new Error(
          `SOAK_SESSION_ALREADY_COMPLETED: Session ${existing.sessionId} already completed ${existing.plannedDurationHours}h. Pass a larger duration (e.g. 48 or 72) to extend or omit sessionId for a new session.`,
        );
      }

      this.resumed = true;
      this.sessionId = existing.sessionId;
      this.sessionDir = candidateDir;
      this.startedAtDate = new Date(existing.startedAt);
      this.startedAtSec = existing.startedAtSec;
      this.plannedDurationHours = Math.max(existing.plannedDurationHours, config.plannedDurationHours);
      this.restartsCount = (existing.restartsCount ?? 0) + 1;
      this.lastResumedAt = nowDate.toISOString();
      this.status = "RUNNING";
      this.endedAt = null;
    } else {
      this.resumed = false;
      this.startedAtDate = nowDate;
      this.startedAtSec = Math.floor(nowDate.getTime() / 1000);
      const stamp = nowDate.toISOString().replace(/[:.]/g, "-");
      this.sessionId = targetSessionId ?? `soak-${stamp}-${process.pid}`;
      this.sessionDir = path.resolve(config.logDir, this.sessionId);
    }

    mkdirSync(this.sessionDir, { recursive: true });

    this.snapshotsPath = path.join(this.sessionDir, "snapshots.jsonl");
    this.decisionsPath = path.join(this.sessionDir, "decisions.jsonl");
    this.eventsPath = path.join(this.sessionDir, "events.jsonl");
    this.metricsPath = path.join(this.sessionDir, "metrics.jsonl");
    this.sessionMetaPath = path.join(this.sessionDir, "session.json");

    if (this.resumed) {
      this.restoreCumulativeCountersFromDisk();
    }

    this.writeSessionMeta();
    this.writeActiveMarker();
  }

  private restoreCumulativeCountersFromDisk(): void {
    const snapshots = readJsonlFile<SoakSnapshotRecord>(this.snapshotsPath);
    const decisions = readJsonlFile<SoakDecisionRecord>(this.decisionsPath);
    const events = readJsonlFile<SoakOperationalEventRecord>(this.eventsPath);
    const metrics = readJsonlFile<SoakMetricsRecord>(this.metricsPath);

    this.writtenSnapshotsCount = snapshots.length;
    if (snapshots.length > 0) {
      this.latestSnapshot = snapshots[snapshots.length - 1];
      this.lastSuccessfulObservationAt = this.latestSnapshot.snapshotTimestamp;
    }
    for (const s of snapshots) {
      if (s.marketRegime in this.observedRegimes) {
        this.observedRegimes[s.marketRegime] += 1;
      }
    }

    this.successfulCycles = decisions.length;
    for (const d of decisions) {
      if (d.selectedVenue in this.decisionsByVenue) {
        this.decisionsByVenue[d.selectedVenue] += 1;
      }
      if (d.selectedAction === "BLOCKED_RISK" || !d.riskEvaluation.allowed) {
        this.riskRejectionCount += 1;
      }
      if (d.selectedAction === "SKIPPED_DUPLICATE") {
        this.duplicateDecisionCount += 1;
      }
      this.txBroadcastCount += d.txBroadcastCount ?? 0;
    }

    for (const e of events) {
      if (e.eventType === "RPC_ERROR") {
        this.failedCycles += 1;
        this.errorCount += 1;
      } else if (e.eventType === "RETRY") {
        this.retryCount += 1;
      } else if (e.eventType === "RECOVERY") {
        this.recoveryCount += 1;
      } else if (e.eventType === "MISSED_CYCLE") {
        this.missedCycles += 1;
      }
    }

    if (metrics.length > 0) {
      const lastM = metrics[metrics.length - 1];
      this.maxRpcLatencyMs = lastM.maxRpcLatencyMs ?? 0;
      this.lastRpcLatencyMs = lastM.lastRpcLatencyMs ?? null;
      if (lastM.avgRpcLatencyMs > 0 && lastM.successfulCycles > 0) {
        this.latencyCount = lastM.successfulCycles;
        this.latencySumMs = lastM.avgRpcLatencyMs * lastM.successfulCycles;
      }
    }
  }

  private writeActiveMarker(): void {
    const dir = path.dirname(this.activeMarkerPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.activeMarkerPath}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          sessionId: this.sessionId,
          sessionDir: this.sessionDir,
          startedAtSec: this.startedAtSec,
          plannedDurationHours: this.plannedDurationHours,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    renameSync(tmp, this.activeMarkerPath);
  }

  private clearActiveMarker(): void {
    try {
      if (existsSync(this.activeMarkerPath)) unlinkSync(this.activeMarkerPath);
    } catch {
      // best-effort cleanup
    }
  }

  getRemainingPlannedMs(nowMs: number = Date.now()): number {
    const targetEndMs = (this.startedAtSec + Math.round(this.plannedDurationHours * 3600)) * 1000;
    return Math.max(0, targetEndMs - nowMs);
  }

  getStartedAtSec(): number {
    return this.startedAtSec;
  }

  getPlannedDurationHours(): number {
    return this.plannedDurationHours;
  }

  getRestartsCount(): number {
    return this.restartsCount;
  }

  private appendJsonl(filePath: string, record: unknown): void {
    appendFileSync(filePath, `${safeStringify(record)}\n`, "utf8");
  }

  private enforceSnapshotRetention(): void {
    const maxRetained = this.cfg.maxRetainedSnapshots ?? 0;
    if (maxRetained <= 0 || this.writtenSnapshotsCount <= maxRetained) return;
    if (!existsSync(this.snapshotsPath)) return;
    const lines = readFileSync(this.snapshotsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    if (lines.length <= maxRetained) return;
    const kept = lines.slice(-maxRetained);
    const tmp = `${this.snapshotsPath}.tmp`;
    writeFileSync(tmp, `${kept.join("\n")}\n`, "utf8");
    renameSync(tmp, this.snapshotsPath);
    this.writtenSnapshotsCount = kept.length;
  }

  recordCycle(
    trace: AutonomousDecisionTrace,
    gasEstimate?: { trancheGasCostPayment?: bigint; dexGasCostPayment?: bigint },
  ): { snapshotRecord: SoakSnapshotRecord; decisionRecord: SoakDecisionRecord } {
    const recordedAt = new Date().toISOString();
    const snap = trace.snapshot;
    const blockNumberStr = snap.blockNumber !== undefined ? snap.blockNumber.toString() : null;
    const dataSourceHealthy = snap.dataSourceHealthy ?? snap.anomalies.length === 0;

    const snapshotRecord: SoakSnapshotRecord = {
      recordType: "market_snapshot",
      sessionId: this.sessionId,
      recordedAt,
      chainId: this.cfg.chainId,
      blockNumber: blockNumberStr,
      snapshotTimestamp: snap.timestamp,
      pair: {
        label: this.cfg.marketLabel,
        inventoryToken: snap.inventoryToken,
        paymentToken: snap.paymentToken,
        poolAddress: snap.pool.poolAddress,
        poolFee: snap.pool.fee,
      },
      spotPriceX36: snap.pool.spotPriceX36.toString(),
      twapPriceX36: snap.pool.twapPriceX36 !== null ? snap.pool.twapPriceX36.toString() : null,
      oraclePriceX36: snap.oracle !== null ? snap.oracle.priceX36.toString() : null,
      oracleAgeSec: snap.oracleAgeSec,
      oracleDeviationBps: snap.oracleDeviationBps,
      oracleValid: snap.oracle !== null ? snap.oracle.isValid : null,
      liquidity: snap.pool.liquidity.toString(),
      roundTripSpreadBps: computeRoundTripSpreadBps(trace),
      dexBuyImpactBps: snap.dexBuyQuote?.priceImpactBps ?? null,
      dexSellImpactBps: snap.dexSellQuote?.priceImpactBps ?? null,
      realizedVolatilityBps: snap.realizedVolatilityBps,
      momentumReturnBps: snap.momentumReturnBps,
      dislocationVsTwapBps: snap.dislocationVsTwapBps,
      marketRegime: snap.marketRegime,
      dataSourceHealthy,
      anomalies: [...snap.anomalies],
    };

    const selectedVenue = trace.venueSelection.selectedVenue;
    const expectedCost =
      selectedVenue === "TRANCHE"
        ? trace.venueSelection.tranche.acquisitionCostPayment
        : selectedVenue === "HSKSWAP"
          ? trace.venueSelection.hskswap.acquisitionCostPayment
          : 0n;

    const estimatedGasUnits =
      selectedVenue === "HSKSWAP"
        ? (snap.dexBuyQuote?.gasEstimate?.toString() ?? null)
        : selectedVenue === "TRANCHE"
          ? "340000"
          : null;

    const estimatedGasCostPayment =
      selectedVenue === "TRANCHE"
        ? (gasEstimate?.trancheGasCostPayment?.toString() ?? null)
        : selectedVenue === "HSKSWAP"
          ? (gasEstimate?.dexGasCostPayment?.toString() ?? null)
          : null;

    const decisionRecord: SoakDecisionRecord = {
      recordType: "agent_decision",
      sessionId: this.sessionId,
      recordedAt,
      decisionId: `${this.sessionId}:c${trace.cycleId}`,
      decisionKey: trace.decisionKey,
      cycleId: trace.cycleId,
      timestamp: trace.timestamp,
      strategyType: trace.strategyConfig.type,
      policyVersion: trace.policyVersion,
      snapshotRef: {
        snapshotTimestamp: snap.timestamp,
        blockNumber: blockNumberStr,
        marketRegime: snap.marketRegime,
        dataSourceHealthy,
      },
      riskEvaluation: {
        allowed: trace.riskReport.allowed,
        failedChecks: trace.riskReport.failedChecks.map((c) => ({
          name: c.name,
          detail: c.detail,
        })),
      },
      selectedVenue,
      selectedAction: trace.selectedAction,
      expectedExecutionCostPayment: expectedCost.toString(),
      estimatedGasUnits,
      estimatedGasCostPayment,
      reasoningCodes: buildReasoningCodes(trace),
      explanation: trace.rationale,
      executionMode: trace.executionMode,
      executionBlockedByReadOnly: trace.executionBlockedByReadOnly,
      txBroadcastCount: trace.txHashes.length,
    };

    this.appendJsonl(this.snapshotsPath, snapshotRecord);
    this.writtenSnapshotsCount += 1;
    this.enforceSnapshotRetention();

    this.appendJsonl(this.decisionsPath, decisionRecord);

    // Update live counters
    this.successfulCycles += 1;
    this.rpcHealthy = true;
    this.lastSuccessfulObservationAt = snap.timestamp;
    this.latestSnapshot = snapshotRecord;
    this.decisionsByVenue[selectedVenue] += 1;
    this.observedRegimes[snap.marketRegime] += 1;
    this.txBroadcastCount += trace.txHashes.length;

    if (trace.selectedAction === "BLOCKED_RISK" || !trace.riskReport.allowed) {
      this.riskRejectionCount += 1;
    }
    if (trace.selectedAction === "SKIPPED_DUPLICATE") {
      this.duplicateDecisionCount += 1;
    }

    if (typeof trace.rpcLatencyMs === "number" && Number.isFinite(trace.rpcLatencyMs)) {
      this.latencyCount += 1;
      this.latencySumMs += trace.rpcLatencyMs;
      this.lastRpcLatencyMs = trace.rpcLatencyMs;
      if (trace.rpcLatencyMs > this.maxRpcLatencyMs) {
        this.maxRpcLatencyMs = trace.rpcLatencyMs;
      }
    }

    return { snapshotRecord, decisionRecord };
  }

  recordEvent(eventType: SoakEventType, details: Record<string, unknown> = {}): SoakOperationalEventRecord {
    const record: SoakOperationalEventRecord = {
      recordType: "operational_event",
      sessionId: this.sessionId,
      recordedAt: new Date().toISOString(),
      eventType,
      details: redactSensitive(details) as Record<string, unknown>,
    };
    this.appendJsonl(this.eventsPath, record);

    if (eventType === "RPC_ERROR") {
      this.failedCycles += 1;
      this.errorCount += 1;
      this.rpcHealthy = false;
    } else if (eventType === "RETRY") {
      this.retryCount += 1;
    } else if (eventType === "RECOVERY") {
      this.recoveryCount += 1;
      this.rpcHealthy = true;
    } else if (eventType === "MISSED_CYCLE") {
      this.missedCycles += 1;
    }

    return record;
  }

  computeMetrics(nowSec: number = Math.floor(Date.now() / 1000)): SoakMetricsRecord {
    const totalCycles = this.successfulCycles + this.failedCycles;
    const rpcSuccessRate =
      totalCycles > 0 ? Number((this.successfulCycles / totalCycles).toFixed(4)) : 1;
    const avgRpcLatencyMs =
      this.latencyCount > 0 ? Number((this.latencySumMs / this.latencyCount).toFixed(2)) : 0;
    const latestSnapshotAgeSec =
      this.lastSuccessfulObservationAt !== null
        ? Math.max(0, nowSec - this.lastSuccessfulObservationAt)
        : null;

    return {
      recordType: "periodic_metrics",
      sessionId: this.sessionId,
      recordedAt: new Date().toISOString(),
      uptimeSec: Math.max(0, nowSec - this.startedAtSec),
      totalCycles,
      successfulCycles: this.successfulCycles,
      failedCycles: this.failedCycles,
      missedCycles: this.missedCycles,
      rpcSuccessRate,
      avgRpcLatencyMs,
      maxRpcLatencyMs: this.maxRpcLatencyMs,
      lastRpcLatencyMs: this.lastRpcLatencyMs,
      decisionsByVenue: { ...this.decisionsByVenue },
      riskRejectionCount: this.riskRejectionCount,
      duplicateDecisionCount: this.duplicateDecisionCount,
      observedRegimes: { ...this.observedRegimes },
      latestSnapshotAgeSec,
      errorCount: this.errorCount,
      retryCount: this.retryCount,
      recoveryCount: this.recoveryCount,
      txBroadcastCount: this.txBroadcastCount,
    };
  }

  recordMetrics(nowSec?: number): SoakMetricsRecord {
    const metrics = this.computeMetrics(nowSec);
    this.appendJsonl(this.metricsPath, metrics);
    this.writeSessionMeta(metrics);
    return metrics;
  }

  markFinished(status: Exclude<SoakSessionStatus, "RUNNING">): SoakMetricsRecord {
    this.status = status;
    this.endedAt = new Date().toISOString();
    if (status === "COMPLETED") {
      this.clearActiveMarker();
    }
    return this.recordMetrics();
  }

  getStatusSummary(): SoakStatusSummary {
    const metrics = this.computeMetrics();
    const unobservedRegimes = ALL_REGIMES.filter((r) => metrics.observedRegimes[r] === 0);
    const remainingPlannedSec = Math.ceil(this.getRemainingPlannedMs() / 1000);
    return {
      active: this.status === "RUNNING",
      sessionId: this.sessionId,
      status: this.status,
      plannedDurationHours: this.plannedDurationHours,
      mode: this.cfg.executionMode,
      dataSource: this.cfg.dataSource,
      chainId: this.cfg.chainId,
      marketLabel: this.cfg.marketLabel,
      startedAt: this.startedAtDate.toISOString(),
      uptimeSec: metrics.uptimeSec,
      restartsCount: this.restartsCount,
      lastResumedAt: this.lastResumedAt,
      remainingPlannedSec,
      lastSuccessfulObservationAt: this.lastSuccessfulObservationAt,
      latestSnapshot: this.latestSnapshot,
      rpcHealth: {
        healthy: this.rpcHealthy,
        successRate: metrics.rpcSuccessRate,
        avgLatencyMs: metrics.avgRpcLatencyMs,
        maxLatencyMs: metrics.maxRpcLatencyMs,
        lastLatencyMs: metrics.lastRpcLatencyMs,
      },
      cycles: {
        total: metrics.totalCycles,
        successful: metrics.successfulCycles,
        failed: metrics.failedCycles,
        missed: metrics.missedCycles,
      },
      decisionsByVenue: metrics.decisionsByVenue,
      riskRejectionCount: metrics.riskRejectionCount,
      duplicateDecisionCount: metrics.duplicateDecisionCount,
      observedRegimes: metrics.observedRegimes,
      unobservedRegimes,
      errorsCount: metrics.errorCount,
      recoveriesCount: metrics.recoveryCount,
      retriesCount: metrics.retryCount,
      txBroadcastCount: metrics.txBroadcastCount,
      evidenceDir: this.sessionDir,
    };
  }

  private writeSessionMeta(latestMetrics?: SoakMetricsRecord): void {
    const meta: SoakSessionMetadata = {
      sessionId: this.sessionId,
      status: this.status,
      startedAt: this.startedAtDate.toISOString(),
      startedAtSec: this.startedAtSec,
      endedAt: this.endedAt,
      plannedDurationHours: this.plannedDurationHours,
      dataSource: this.cfg.dataSource,
      executionMode: this.cfg.executionMode,
      chainId: this.cfg.chainId,
      marketLabel: this.cfg.marketLabel,
      pollIntervalMs: this.cfg.pollIntervalMs,
      evidenceDir: this.sessionDir,
      stateFile: this.cfg.stateFile ?? null,
      pid: process.pid,
      restartsCount: this.restartsCount,
      lastResumedAt: this.lastResumedAt,
      latestMetrics: latestMetrics ?? null,
    };
    const tmp = `${this.sessionMetaPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(redactSensitive(meta), null, 2), "utf8");
    renameSync(tmp, this.sessionMetaPath);
  }
}

export interface InspectedSoakReport {
  sessionDir: string;
  metadata: SoakSessionMetadata;
  counts: {
    snapshots: number;
    decisions: number;
    events: number;
    metrics: number;
  };
  latestSnapshot: SoakSnapshotRecord | null;
  latestDecision: SoakDecisionRecord | null;
  latestMetrics: SoakMetricsRecord | null;
  txBroadcastCount: number;
  observedRegimes: Record<MarketRegime, number>;
  unobservedRegimes: MarketRegime[];
}

function readJsonlFile<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed) as T);
  }
  return out;
}

export function findLatestSoakSessionDir(logDir: string): string | null {
  const abs = path.resolve(logDir);
  if (!existsSync(abs)) return null;
  const entries = readdirSync(abs)
    .map((name) => path.join(abs, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory() && existsSync(path.join(p, "session.json"));
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return entries[0] ?? null;
}

export function inspectSoakSession(sessionDir: string): InspectedSoakReport {
  const metaPath = path.join(sessionDir, "session.json");
  if (!existsSync(metaPath)) {
    throw new Error(`No session.json found in ${sessionDir}`);
  }
  const metadata = JSON.parse(readFileSync(metaPath, "utf8")) as SoakSessionMetadata;
  const snapshots = readJsonlFile<SoakSnapshotRecord>(path.join(sessionDir, "snapshots.jsonl"));
  const decisions = readJsonlFile<SoakDecisionRecord>(path.join(sessionDir, "decisions.jsonl"));
  const events = readJsonlFile<SoakOperationalEventRecord>(path.join(sessionDir, "events.jsonl"));
  const metrics = readJsonlFile<SoakMetricsRecord>(path.join(sessionDir, "metrics.jsonl"));

  const observedRegimes: Record<MarketRegime, number> = {
    CALM: 0,
    TRENDING: 0,
    VOLATILE: 0,
    DISLOCATED: 0,
  };
  for (const s of snapshots) {
    if (s.marketRegime in observedRegimes) {
      observedRegimes[s.marketRegime] += 1;
    }
  }
  const txBroadcastCount = decisions.reduce((acc, d) => acc + (d.txBroadcastCount ?? 0), 0);
  const unobservedRegimes = ALL_REGIMES.filter((r) => observedRegimes[r] === 0);

  return {
    sessionDir,
    metadata,
    counts: {
      snapshots: snapshots.length,
      decisions: decisions.length,
      events: events.length,
      metrics: metrics.length,
    },
    latestSnapshot: snapshots.length > 0 ? snapshots[snapshots.length - 1] : null,
    latestDecision: decisions.length > 0 ? decisions[decisions.length - 1] : null,
    latestMetrics:
      metrics.length > 0 ? metrics[metrics.length - 1] : metadata.latestMetrics,
    txBroadcastCount,
    observedRegimes,
    unobservedRegimes,
  };
}
