import { existsSync } from "node:fs";
import type { StructuredLogger } from "./logger.js";
import {
  validateRuntimeSafety,
  type AgentDataSourceMode,
} from "./protocol-config.js";
import {
  AgentRuntime,
  type AutonomousDecisionTrace,
  type TrancheAutonomousAgent,
} from "./runtime.js";
import {
  SoakEvidenceStore,
  type SoakMetricsRecord,
  type SoakStatusProvider,
  type SoakStatusSummary,
} from "./soak-evidence.js";

export interface SoakRunnerConfig {
  agent: TrancheAutonomousAgent;
  dataSource: AgentDataSourceMode;
  chainId: number;
  rpcUrl?: string;
  marketLabel: string;
  logDir: string;
  sessionId?: string;
  /** When true, resumes an unfinished (RUNNING) soak session instead of resetting duration */
  resumeIfActive?: boolean;
  stateFile?: string;
  durationHours: number;
  /** Optional explicit duration in ms (primarily for tests; defaults to remaining planned duration) */
  durationMs?: number;
  pollIntervalMs: number;
  transientRpcRetries?: number;
  retryBackoffMs?: number;
  maxRetryBackoffMs?: number;
  metricsEveryCycles?: number;
  maxRetainedSnapshots?: number;
  logger?: StructuredLogger;
  onComplete?: (metrics: SoakMetricsRecord) => void;
}

/**
 * Dedicated continuous read-only soak runner.
 * Enforces read_only execution fail-closed, records structured JSONL evidence,
 * handles automatic RPC recovery with bounded exponential backoff, and supports
 * graceful duration completion and SIGINT/SIGTERM shutdown.
 */
export class SoakRunner implements SoakStatusProvider {
  public readonly agent: TrancheAutonomousAgent;
  public readonly runtime: AgentRuntime;
  public readonly evidence: SoakEvidenceStore;

  private readonly cfg: SoakRunnerConfig;
  private readonly metricsEveryCycles: number;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private cyclesSinceMetrics = 0;

  constructor(config: SoakRunnerConfig) {
    if (config.agent.getExecutionMode() !== "read_only") {
      throw new Error(
        `SAFETY_BLOCKED: SoakRunner strictly requires agent executionMode=read_only (got ${config.agent.getExecutionMode()})`,
      );
    }
    validateRuntimeSafety({
      dataSource: config.dataSource,
      executionMode: "read_only",
      rpcUrl: config.rpcUrl,
      chainId: config.chainId,
    });

    this.cfg = config;
    this.agent = config.agent;
    this.metricsEveryCycles = Math.max(1, config.metricsEveryCycles ?? 10);

    const stateExistedBefore = Boolean(config.stateFile && existsSync(config.stateFile));

    this.evidence = new SoakEvidenceStore({
      logDir: config.logDir,
      sessionId: config.sessionId,
      resumeIfActive: config.resumeIfActive,
      plannedDurationHours: config.durationHours,
      dataSource: config.dataSource,
      executionMode: "read_only",
      chainId: config.chainId,
      marketLabel: config.marketLabel,
      pollIntervalMs: config.pollIntervalMs,
      stateFile: config.stateFile,
      maxRetainedSnapshots: config.maxRetainedSnapshots,
    });

    if (this.evidence.resumed) {
      this.evidence.recordEvent("RESTART_RESUMED", {
        sessionId: this.evidence.sessionId,
        restartsCount: this.evidence.getRestartsCount(),
        originalStartedAtSec: this.evidence.getStartedAtSec(),
        plannedDurationHours: this.evidence.getPlannedDurationHours(),
        remainingPlannedSec: Math.ceil(this.evidence.getRemainingPlannedMs() / 1000),
      });
    }

    const store = this.agent.getPositionStore();
    if (store.isStateCorrupted()) {
      this.evidence.recordEvent("CORRUPTED_STATE", {
        error: store.getCorruptionError() ?? "Unknown state corruption",
        stateFile: config.stateFile ?? null,
      });
    } else if (stateExistedBefore) {
      const persisted = store.getPersistedRuntimeConfig();
      this.evidence.recordEvent("STATE_RESTORE", {
        stateFile: config.stateFile ?? null,
        policyVersion: persisted?.policyVersion ?? 1,
        openPositions: store.getOpenPositions().length,
        activeTickets: store.getActiveTickets().length,
      });
    }

    const constraints = this.agent.getVenueConstraints();
    this.runtime = new AgentRuntime({
      agent: this.agent,
      pollIntervalMs: config.pollIntervalMs,
      transientRpcRetries: config.transientRpcRetries ?? 3,
      retryBackoffMs: config.retryBackoffMs ?? 250,
      maxRetryBackoffMs: config.maxRetryBackoffMs ?? 5000,
      autoRecoverFromRpcErrors: true,
      logger: config.logger,
      onTrace: (trace) => {
        this.evidence.recordCycle(trace, {
          trancheGasCostPayment: constraints.trancheGasCostPayment,
          dexGasCostPayment: constraints.dexGasCostPayment,
        });
        this.cyclesSinceMetrics += 1;
        if (this.cyclesSinceMetrics >= this.metricsEveryCycles) {
          this.cyclesSinceMetrics = 0;
          this.evidence.recordMetrics();
        }
      },
      onError: (err, consecutiveErrors) => {
        this.evidence.recordEvent("RPC_ERROR", {
          consecutiveErrors,
          error: err instanceof Error ? err.message : String(err),
        });
        this.evidence.recordMetrics();
      },
      onRetry: (attempt, backoffMs, err) => {
        this.evidence.recordEvent("RETRY", {
          attempt,
          backoffMs,
          error: err instanceof Error ? err.message : String(err),
        });
      },
      onRecovery: (previousConsecutiveErrors) => {
        this.evidence.recordEvent("RECOVERY", {
          previousConsecutiveErrors,
        });
      },
      onHealthTransition: (from, to, reason) => {
        this.evidence.recordEvent("HEALTH_TRANSITION", { from, to, reason });
      },
      onMissedCycle: (reason) => {
        this.evidence.recordEvent("MISSED_CYCLE", { reason });
      },
    });
  }

  getStatusSummary(): SoakStatusSummary {
    return this.evidence.getStatusSummary();
  }

  start(): void {
    this.stopped = false;
    const remainingMs =
      this.cfg.durationMs !== undefined
        ? this.cfg.durationMs
        : this.evidence.getRemainingPlannedMs();

    this.evidence.recordEvent("STARTUP", {
      dataSource: this.cfg.dataSource,
      executionMode: "read_only",
      chainId: this.cfg.chainId,
      marketLabel: this.cfg.marketLabel,
      plannedDurationHours: this.evidence.getPlannedDurationHours(),
      resumed: this.evidence.resumed,
      restartsCount: this.evidence.getRestartsCount(),
      remainingPlannedSec: Math.ceil(remainingMs / 1000),
      pollIntervalMs: this.cfg.pollIntervalMs,
      evidenceDir: this.evidence.sessionDir,
    });

    if (remainingMs <= 0) {
      void this.completeDuration();
      return;
    }

    this.runtime.start();

    if (Number.isFinite(remainingMs)) {
      this.durationTimer = setTimeout(() => {
        void this.completeDuration();
      }, remainingMs);
    }
  }

  async tickOnce(nowSecOverride?: number): Promise<AutonomousDecisionTrace | null> {
    return this.runtime.tickOnce(nowSecOverride);
  }

  private async completeDuration(): Promise<void> {
    if (this.stopped) return;
    this.evidence.recordEvent("DURATION_COMPLETE", {
      plannedDurationHours: this.cfg.durationHours,
    });
    const metrics = await this.stop("duration_complete", "COMPLETED");
    this.cfg.onComplete?.(metrics);
  }

  async stop(
    reason = "graceful_shutdown",
    finalStatus: "COMPLETED" | "STOPPED" | "FAILED" = "STOPPED",
  ): Promise<SoakMetricsRecord> {
    if (this.stopped) {
      return this.evidence.computeMetrics();
    }
    this.stopped = true;
    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }
    await this.runtime.stop();
    this.evidence.recordEvent("SHUTDOWN", { reason, finalStatus });
    return this.evidence.markFinished(finalStatus);
  }
}
