import type { Address, Hex } from "viem";
import type { TrancheExecutionAgent } from "./agent.js";
import { BPS_DENOMINATOR, type DexVenueAdapter } from "./hskswap.js";
import type { StructuredLogger } from "./logger.js";
import type { MarketIntelligence, MarketSnapshot } from "./market.js";
import type { PositionStore, TrackedPosition } from "./positions.js";
import type { TransactionReconciler, TxReconciliationResult } from "./reconciler.js";
import { RiskManager, type RiskCheckReport, type RiskLimits } from "./risk.js";
import {
  StrategyEngine,
  type ExitDecision,
  type StrategyConfig,
  type StrategySignal,
  type TicketLifecycleDecision,
} from "./strategy.js";
import type { AgentIntent } from "./types.js";
import {
  VenueSelector,
  type VenueSelectionConstraints,
  type VenueSelectionResult,
} from "./venue.js";

export type AgentExecutionMode = "read_only" | "dry_run" | "live";

export type AutonomousAction =
  | "WAIT"
  | "READ_ONLY_RESERVE_TRANCHE"
  | "READ_ONLY_SWAP_HSKSWAP"
  | "DRY_RUN_RESERVE_TRANCHE"
  | "DRY_RUN_SWAP_HSKSWAP"
  | "RESERVE_TRANCHE"
  | "SWAP_HSKSWAP"
  | "EXERCISE_TICKET"
  | "RECLAIM_TICKET"
  | "EXIT_POSITION"
  | "SKIPPED_DUPLICATE"
  | "BLOCKED_RISK"
  | "EXECUTION_FAILED";

export interface AutonomousDecisionTrace {
  cycleId: number;
  decisionKey: string;
  timestamp: number;
  executionMode: AgentExecutionMode;
  policyVersion: number;
  executionBlockedByReadOnly: boolean;
  rpcLatencyMs?: number;
  strategyConfig: StrategyConfig;
  riskLimits: RiskLimits;
  snapshot: MarketSnapshot;
  signal: StrategySignal;
  venueSelection: VenueSelectionResult;
  riskReport: RiskCheckReport;
  ticketActions: Array<{
    ticketId: bigint;
    decision: TicketLifecycleDecision;
    txHash?: Hex;
    error?: string;
  }>;
  positionActions: Array<{
    positionId: string;
    decision: ExitDecision;
    txHash?: Hex;
    realizedDelta?: bigint;
    error?: string;
  }>;
  selectedAction: AutonomousAction;
  rationale: string;
  txHashes: Hex[];
  error?: string;
}

export interface TrancheAutonomousAgentConfig {
  trancheAgent: TrancheExecutionAgent;
  dexVenue: DexVenueAdapter;
  market: MarketIntelligence;
  positions: PositionStore;
  recipient: Address;
  poolFee: number;
  intent: AgentIntent;
  strategyConfig: StrategyConfig;
  riskLimits: RiskLimits;
  venueConstraints: VenueSelectionConstraints;
  /** Execution mode: defaults to "live" when omitted for existing unit tests, set "dry_run" for local API */
  executionMode?: AgentExecutionMode;
  minExerciseEdgePayment?: bigint;
  /** Cooldown bucket window (seconds) for decision deduplication (default 60s) */
  decisionCooldownSec?: number;
  /** Max allowed age (seconds) between pool snapshot timestamp and execution (default 30s) */
  maxQuoteAgeSec?: number;
  /** Optional: immediately exercise a reserved Tranche ticket in the same cycle if profitable */
  autoExerciseOnArb?: boolean;
  /** Optional structured logger with correlation IDs & secret redaction */
  logger?: StructuredLogger;
  /** Optional automated on-chain pending-tx reconciler */
  reconciler?: TransactionReconciler;
}

function isUncertainRpcError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("network") ||
    msg.includes("429") ||
    msg.includes("socket hang up")
  );
}

/**
 * Single-cycle deterministic autonomous trading decision & execution engine.
 * Separated cleanly from the continuous scheduler (`AgentRuntime`).
 */
export class TrancheAutonomousAgent {
  private readonly cfg: TrancheAutonomousAgentConfig;
  private readonly strategyEngine = new StrategyEngine();
  private readonly venueSelector = new VenueSelector();
  private readonly riskManager = new RiskManager();
  private readonly traces: AutonomousDecisionTrace[] = [];
  private cycleCounter = 0;

  constructor(config: TrancheAutonomousAgentConfig) {
    this.cfg = config;
    // Restore persisted safety & policy state on restart so killSwitch/paused/limits are never silently reset
    const persisted = config.positions.getPersistedRuntimeConfig();
    if (persisted) {
      Object.assign(this.cfg.strategyConfig, persisted.strategy);
      Object.assign(this.cfg.riskLimits, persisted.riskLimits);
    } else if (!config.positions.isStateCorrupted()) {
      config.positions.saveRuntimeConfig(this.cfg.strategyConfig, this.cfg.riskLimits, {
        source: "initial",
      });
    }
  }

  getTraces(): readonly AutonomousDecisionTrace[] {
    return this.traces;
  }

  getRiskLimits(): RiskLimits {
    return this.cfg.riskLimits;
  }

  getStrategyConfig(): StrategyConfig {
    return this.cfg.strategyConfig;
  }

  getExecutionMode(): AgentExecutionMode {
    return this.cfg.executionMode ?? "live";
  }

  getPositionStore(): PositionStore {
    return this.cfg.positions;
  }

  getIntent(): AgentIntent {
    return this.cfg.intent;
  }

  getVenueConstraints(): VenueSelectionConstraints {
    return this.cfg.venueConstraints;
  }

  setPaused(paused: boolean): void {
    if (!paused && this.cfg.riskLimits.killSwitch) {
      throw new Error("Cannot unpause while kill switch is active");
    }
    this.cfg.riskLimits.paused = paused;
    this.cfg.positions.saveRuntimeConfig(this.cfg.strategyConfig, this.cfg.riskLimits, {
      source: "api",
      instruction: paused ? "pause" : "resume",
    });
    this.cfg.logger?.info("agent.pause_changed", { paused });
  }

  reconcilePendingTx(pendingTxId: string): boolean {
    const exists = this.cfg.positions.getPendingTxs().some((p) => p.id === pendingTxId);
    if (!exists) return false;
    this.cfg.positions.resolvePendingTx(pendingTxId);
    this.cfg.logger?.info("agent.pending_tx_reconciled", { pendingTxId });
    return true;
  }

  async autoReconcilePendingTxs(): Promise<TxReconciliationResult[]> {
    if (!this.cfg.reconciler) return [];
    const pending = [...this.cfg.positions.getPendingTxs()];
    const results: TxReconciliationResult[] = [];
    for (const ptx of pending) {
      const res = await this.cfg.reconciler.reconcile(ptx);
      results.push(res);
      if (res.canClearPending) {
        this.cfg.positions.resolvePendingTx(ptx.id);
        this.cfg.logger?.info("agent.pending_tx_auto_reconciled", {
          pendingTxId: ptx.id,
          status: res.status,
          reason: res.reason,
        });
      }
    }
    return results;
  }

  triggerKillSwitch(): void {
    this.cfg.riskLimits.killSwitch = true;
    this.cfg.riskLimits.paused = true;
    this.cfg.positions.saveRuntimeConfig(this.cfg.strategyConfig, this.cfg.riskLimits, {
      source: "api",
      instruction: "kill_switch",
    });
    this.cfg.logger?.warn("agent.kill_switch_activated", { killSwitch: true });
  }

  async runCycle(nowSecOverride?: number): Promise<AutonomousDecisionTrace> {
    const cycleId = ++this.cycleCounter;
    const mode = this.getExecutionMode();
    if (mode !== "read_only" && this.cfg.reconciler && this.cfg.positions.getPendingTxs().length > 0) {
      await this.autoReconcilePendingTxs();
    }
    const snapshotStartMs = Date.now();
    const snapshot = await this.cfg.market.collectSnapshot(this.cfg.intent, nowSecOverride);
    const rpcLatencyMs = Date.now() - snapshotStartMs;
    const nowSec = snapshot.timestamp;
    const txHashes: Hex[] = [];
    const ticketActions: AutonomousDecisionTrace["ticketActions"] = [];
    const positionActions: AutonomousDecisionTrace["positionActions"] = [];

    // 1. Monitor & manage open positions (take-profit / stop-loss exits via HSKSwap)
    for (const pos of this.cfg.positions.getOpenPositions()) {
      await this.manageOpenPosition(pos, snapshot, nowSec, txHashes, positionActions);
    }

    // 2. Monitor & manage active Tranche tickets (exercise if profitable/confirmed, reclaim if expired)
    for (const ticket of this.cfg.positions.getActiveTickets()) {
      await this.manageActiveTicket(ticket.ticketId, snapshot, nowSec, txHashes, ticketActions);
    }

    // 3. Evaluate strategy entry signal & dual-venue economics
    const signal = this.strategyEngine.evaluateEntry(snapshot, this.cfg.strategyConfig);
    const venueSelection = this.venueSelector.selectVenue(
      snapshot,
      this.cfg.strategyConfig,
      this.cfg.venueConstraints,
    );
    const portfolio = this.cfg.positions.getPortfolioState(nowSec);
    const riskReport = this.riskManager.evaluateEntry({
      limits: this.cfg.riskLimits,
      portfolio,
      snapshot,
      venueSelection,
    });

    const cooldown = Math.max(1, this.cfg.decisionCooldownSec ?? 60);
    const bucket = Math.floor(nowSec / cooldown);
    const decisionKey = `${this.cfg.intent.inventoryToken.toLowerCase()}:${bucket}:${venueSelection.selectedVenue}:${venueSelection.tranche.offerId ?? 0n}`;

    let selectedAction: AutonomousAction = "WAIT";
    let rationale = signal.reason;
    let errorMsg: string | undefined;
    let executionBlockedByReadOnly = false;

    if (this.cfg.positions.isStateCorrupted()) {
      selectedAction = "BLOCKED_RISK";
      rationale = `Fail-closed: persisted state file is corrupted (${this.cfg.positions.getCorruptionError()})`;
    } else if (signal.action === "ENTER_LONG") {
      const maxQuoteAge = this.cfg.maxQuoteAgeSec ?? 30;
      const quoteAge = Math.max(0, nowSec - snapshot.pool.timestamp);
      if (quoteAge > maxQuoteAge) {
        selectedAction = "BLOCKED_RISK";
        rationale = `Stale quote blocked: quoteAge=${quoteAge}s > maxQuoteAgeSec=${maxQuoteAge}s`;
      } else if (venueSelection.selectedVenue === "NONE") {
        selectedAction = "WAIT";
        rationale = venueSelection.rationale;
      } else if (!riskReport.allowed) {
        selectedAction = "BLOCKED_RISK";
        rationale = `Risk blocked: ${riskReport.failedChecks.map((c) => `${c.name}(${c.detail})`).join("; ")}`;
      } else if (this.cfg.positions.hasExecutedDecision(decisionKey)) {
        selectedAction = "SKIPPED_DUPLICATE";
        rationale = `Duplicate decision prevented for key ${decisionKey}`;
      } else if (venueSelection.selectedVenue === "TRANCHE") {
        if (mode === "read_only") {
          executionBlockedByReadOnly = true;
          this.cfg.positions.markDecisionExecuted(decisionKey);
          selectedAction = "READ_ONLY_RESERVE_TRANCHE";
          rationale = `[READ-ONLY MODE — EXECUTION BLOCKED, NO TX BROADCAST] ${venueSelection.rationale}`;
        } else if (mode === "dry_run") {
          selectedAction = "DRY_RUN_RESERVE_TRANCHE";
          rationale = `[DRY-RUN ONLY — NO TX BROADCAST] ${venueSelection.rationale}`;
        } else {
        const pendingId = `tx-res-${cycleId}-${nowSec}`;
        this.cfg.positions.beginPendingTx({
          id: pendingId,
          decisionKey,
          action: "RESERVE_TRANCHE",
          createdAt: nowSec,
        });
        try {
          const res = await this.cfg.trancheAgent.reserveBestOffer(
            this.cfg.intent,
            this.cfg.recipient,
          );
          txHashes.push(res.tx.hash);
          const ticketExpiry =
            res.tx.expiresAt ?? nowSec + this.cfg.intent.desiredDuration;
          this.cfg.positions.recordReservedTicket({
            ticketId: res.ticketId,
            offerId: res.evaluation.offerId,
            inventoryToken: this.cfg.intent.inventoryToken,
            paymentToken: this.cfg.intent.paymentToken,
            inventoryAmount: this.cfg.intent.targetAmount,
            remainingAmount: this.cfg.intent.targetAmount,
            premiumPaidPayment: res.evaluation.quotedGrossPremium,
            expiresAt: ticketExpiry,
            reservedAt: nowSec,
            status: "ACTIVE",
            reserveTxHash: res.tx.hash,
            exerciseTxHashes: [],
          });
          this.cfg.positions.resolvePendingTx(pendingId);
          this.cfg.positions.markDecisionExecuted(decisionKey);
          selectedAction = "RESERVE_TRANCHE";
          rationale = `${venueSelection.rationale} -> Reserved Ticket #${res.ticketId}`;
        } catch (err) {
          errorMsg = err instanceof Error ? err.message : String(err);
          if (isUncertainRpcError(err)) {
            this.cfg.positions.markPendingTxUncertain(pendingId, errorMsg);
          } else {
            this.cfg.positions.resolvePendingTx(pendingId);
          }
          selectedAction = "EXECUTION_FAILED";
          rationale = `Tranche reservation failed: ${errorMsg}`;
        }
        }
      } else if (venueSelection.selectedVenue === "HSKSWAP" && snapshot.dexBuyQuote) {
        if (mode === "read_only") {
          executionBlockedByReadOnly = true;
          this.cfg.positions.markDecisionExecuted(decisionKey);
          selectedAction = "READ_ONLY_SWAP_HSKSWAP";
          rationale = `[READ-ONLY MODE — EXECUTION BLOCKED, NO TX BROADCAST] ${venueSelection.rationale}`;
        } else if (mode === "dry_run") {
          selectedAction = "DRY_RUN_SWAP_HSKSWAP";
          rationale = `[DRY-RUN ONLY — NO TX BROADCAST] ${venueSelection.rationale}`;
        } else {
        const pendingId = `tx-dex-${cycleId}-${nowSec}`;
        this.cfg.positions.beginPendingTx({
          id: pendingId,
          decisionKey,
          action: "SWAP_HSKSWAP",
          createdAt: nowSec,
        });
        try {
          const amountIn = snapshot.dexBuyQuote.paymentAmountIn;
          const minOut =
            (this.cfg.intent.targetAmount *
              (BPS_DENOMINATOR - BigInt(this.cfg.riskLimits.maxSlippageBps))) /
            BPS_DENOMINATOR;

          const swap = await this.cfg.dexVenue.executeSwapExactInput({
            tokenIn: this.cfg.intent.paymentToken,
            tokenOut: this.cfg.intent.inventoryToken,
            fee: this.cfg.poolFee,
            amountIn,
            amountOutMinimum: minOut,
            recipient: this.cfg.recipient,
            deadlineSec: nowSec + 120,
          });
          txHashes.push(swap.txHash);
          this.cfg.positions.recordDexPosition({
            inventoryToken: this.cfg.intent.inventoryToken,
            paymentToken: this.cfg.intent.paymentToken,
            quantity: swap.amountOut,
            entryCostPayment: swap.amountIn,
            txHash: swap.txHash,
            nowSec,
          });
          this.cfg.positions.resolvePendingTx(pendingId);
          this.cfg.positions.markDecisionExecuted(decisionKey);
          selectedAction = "SWAP_HSKSWAP";
          rationale = `${venueSelection.rationale} -> Swapped ${swap.amountIn} for ${swap.amountOut}`;
        } catch (err) {
          errorMsg = err instanceof Error ? err.message : String(err);
          if (isUncertainRpcError(err)) {
            this.cfg.positions.markPendingTxUncertain(pendingId, errorMsg);
          } else {
            this.cfg.positions.resolvePendingTx(pendingId);
          }
          selectedAction = "EXECUTION_FAILED";
          rationale = `HSKSwap execution failed: ${errorMsg}`;
        }
        }
      }
    } else if (positionActions.some((a) => a.txHash)) {
      selectedAction = "EXIT_POSITION";
      rationale = positionActions.map((a) => a.decision.reason).join("; ");
    } else if (ticketActions.some((a) => a.txHash)) {
      const first = ticketActions.find((a) => a.txHash)!;
      selectedAction =
        first.decision.action === "RECLAIM_EXPIRED" ? "RECLAIM_TICKET" : "EXERCISE_TICKET";
      rationale = first.decision.reason;
    }

    const policyVersion = this.cfg.positions.getPersistedRuntimeConfig()?.policyVersion ?? 1;
    const trace: AutonomousDecisionTrace = {
      cycleId,
      decisionKey,
      timestamp: nowSec,
      executionMode: mode,
      policyVersion,
      executionBlockedByReadOnly,
      rpcLatencyMs,
      strategyConfig: { ...this.cfg.strategyConfig },
      riskLimits: { ...this.cfg.riskLimits },
      snapshot,
      signal,
      venueSelection,
      riskReport,
      ticketActions,
      positionActions,
      selectedAction,
      rationale,
      txHashes,
      error: errorMsg,
    };
    this.traces.push(trace);
    return trace;
  }

  private async manageOpenPosition(
    pos: TrackedPosition,
    snapshot: MarketSnapshot,
    nowSec: number,
    txHashes: Hex[],
    positionActions: AutonomousDecisionTrace["positionActions"],
  ): Promise<void> {
    try {
      const exitQuote = await this.cfg.dexVenue.quoteSellInventory(
        pos.inventoryToken,
        pos.paymentToken,
        pos.remainingQuantity,
        this.cfg.poolFee,
        snapshot.pool.spotPriceX36,
      );
      this.cfg.positions.updateUnrealizedPnl(pos.positionId, exitQuote.paymentAmountOut);

      const exitDecision = this.strategyEngine.evaluatePositionExit(
        pos.remainingCostBasisPayment,
        exitQuote.paymentAmountOut,
        this.cfg.strategyConfig,
      );
      if (exitDecision.action === "HOLD") return;

      const exitRisk = this.riskManager.evaluateExit({
        limits: this.cfg.riskLimits,
        exitImpactBps: exitQuote.priceImpactBps,
        isStopLoss: exitDecision.action === "STOP_LOSS",
      });
      if (!exitRisk.allowed) {
        positionActions.push({
          positionId: pos.positionId,
          decision: exitDecision,
          error: `Exit risk blocked: ${exitRisk.failedChecks.map((c) => c.name).join(", ")}`,
        });
        return;
      }

      const sellQty =
        (pos.remainingQuantity * BigInt(exitDecision.exitFractionBps)) / BPS_DENOMINATOR;
      if (sellQty === 0n) return;

      const sellQuote =
        sellQty === pos.remainingQuantity
          ? exitQuote
          : await this.cfg.dexVenue.quoteSellInventory(
              pos.inventoryToken,
              pos.paymentToken,
              sellQty,
              this.cfg.poolFee,
              snapshot.pool.spotPriceX36,
            );

      const slipBps =
        exitDecision.action === "STOP_LOSS"
          ? this.cfg.riskLimits.maxSlippageBps * 2
          : this.cfg.riskLimits.maxSlippageBps;
      const minOut =
        (sellQuote.paymentAmountOut * (BPS_DENOMINATOR - BigInt(slipBps))) / BPS_DENOMINATOR;

      if (this.getExecutionMode() === "read_only" || this.getExecutionMode() === "dry_run") {
        positionActions.push({
          positionId: pos.positionId,
          decision: exitDecision,
          error: `READ_ONLY_MODE_BLOCKED: position exit suppressed in ${this.getExecutionMode()} mode`,
        });
        return;
      }

      const swap = await this.cfg.dexVenue.executeSwapExactInput({
        tokenIn: pos.inventoryToken,
        tokenOut: pos.paymentToken,
        fee: this.cfg.poolFee,
        amountIn: sellQty,
        amountOutMinimum: minOut,
        recipient: this.cfg.recipient,
      });

      const { realizedDelta } = this.cfg.positions.recordPositionExit({
        positionId: pos.positionId,
        soldQuantity: sellQty,
        proceedsPayment: swap.amountOut,
        txHash: swap.txHash,
        nowSec,
      });
      txHashes.push(swap.txHash);
      positionActions.push({
        positionId: pos.positionId,
        decision: exitDecision,
        txHash: swap.txHash,
        realizedDelta,
      });
    } catch (err) {
      positionActions.push({
        positionId: pos.positionId,
        decision: {
          action: "HOLD",
          exitFractionBps: 0,
          reason: "Exit evaluation/execution failed",
          currentExitValuePayment: 0n,
          costBasisPayment: pos.remainingCostBasisPayment,
          pnlBps: 0,
        },
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async manageActiveTicket(
    ticketId: bigint,
    snapshot: MarketSnapshot,
    nowSec: number,
    txHashes: Hex[],
    ticketActions: AutonomousDecisionTrace["ticketActions"],
  ): Promise<void> {
    const tracked = this.cfg.positions.getActiveTickets().find((t) => t.ticketId === ticketId);
    if (!tracked) return;

    try {
      const remainingSeconds = tracked.expiresAt - nowSec;
      if (remainingSeconds <= 0) {
        const decision: TicketLifecycleDecision = {
          action: "RECLAIM_EXPIRED",
          reason: `Ticket #${ticketId} expired; calling reclaimIfExpired`,
          remainingSeconds,
        };
        if (this.getExecutionMode() === "read_only" || this.getExecutionMode() === "dry_run") {
          ticketActions.push({
            ticketId,
            decision,
            error: `READ_ONLY_MODE_BLOCKED: ticket reclaim suppressed in ${this.getExecutionMode()} mode`,
          });
          return;
        }
        const rec = await this.cfg.trancheAgent.reclaimIfExpired(ticketId);
        if (rec.reclaimed && rec.tx) {
          this.cfg.positions.markTicketReclaimed(ticketId, rec.tx.hash);
          txHashes.push(rec.tx.hash);
          ticketActions.push({ ticketId, decision, txHash: rec.tx.hash });
        } else {
          this.cfg.positions.markTicketAbandoned(ticketId);
          ticketActions.push({ ticketId, decision, error: rec.reason });
        }
        return;
      }

      // Estimate remaining exercise cost vs HSKSwap
      const quoteEx = await this.cfg.trancheAgent.client.quoteExercise(ticketId, 0n);
      const dexBuy = snapshot.dexBuyQuote?.paymentAmountIn ?? null;
      const dexExit = snapshot.dexSellQuote?.paymentAmountOut ?? null;

      const decision = this.strategyEngine.evaluateActiveTicket({
        nowSec,
        expiresAt: tracked.expiresAt,
        exercisePayment: quoteEx.grossPayment,
        dexBuyCostPayment: dexBuy,
        dexExitProceedsPayment: dexExit,
        minExerciseEdgePayment: this.cfg.minExerciseEdgePayment ?? 0n,
        cfg: this.cfg.strategyConfig,
      });

      if (decision.action === "EXERCISE_TICKET") {
        const portfolio = this.cfg.positions.getPortfolioState(nowSec);
        const exRisk = this.riskManager.evaluateExercise({
          limits: this.cfg.riskLimits,
          portfolio,
          exercisePayment: quoteEx.grossPayment,
          snapshot,
        });
        if (!exRisk.allowed) {
          ticketActions.push({
            ticketId,
            decision,
            error: `Exercise risk blocked: ${exRisk.failedChecks.map((c) => c.name).join(", ")}`,
          });
          return;
        }

        if (this.getExecutionMode() === "read_only" || this.getExecutionMode() === "dry_run") {
          ticketActions.push({
            ticketId,
            decision,
            error: `READ_ONLY_MODE_BLOCKED: ticket exercise suppressed in ${this.getExecutionMode()} mode`,
          });
          return;
        }

        const pendingId = `tx-ex-${ticketId}-${nowSec}`;
        this.cfg.positions.beginPendingTx({
          id: pendingId,
          decisionKey: `exercise:${ticketId}`,
          action: "EXERCISE_TICKET",
          createdAt: nowSec,
        });
        try {
          const maxPayment =
            (quoteEx.grossPayment * (BPS_DENOMINATOR + BigInt(this.cfg.riskLimits.maxSlippageBps))) /
            BPS_DENOMINATOR;
          const ex = await this.cfg.trancheAgent.exerciseTicket(
            ticketId,
            0n,
            maxPayment,
            this.cfg.recipient,
          );
          this.cfg.positions.markTicketExercised(
            ticketId,
            ex.actualFill,
            ex.grossPayment,
            ex.tx.hash,
            nowSec,
          );
          this.cfg.positions.resolvePendingTx(pendingId);
          txHashes.push(ex.tx.hash);
          ticketActions.push({ ticketId, decision, txHash: ex.tx.hash });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isUncertainRpcError(err)) {
            this.cfg.positions.markPendingTxUncertain(pendingId, msg);
          } else {
            this.cfg.positions.resolvePendingTx(pendingId);
          }
          ticketActions.push({ ticketId, decision, error: msg });
        }
      } else {
        ticketActions.push({ ticketId, decision });
      }
    } catch (err) {
      ticketActions.push({
        ticketId,
        decision: {
          action: "HOLD_TICKET",
          reason: "Ticket evaluation/execution failed safely",
          remainingSeconds: tracked.expiresAt - nowSec,
        },
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export type RuntimeRecoveryState =
  | "HEALTHY"
  | "RECOVERING"
  | "PAUSED_CIRCUIT_BREAKER"
  | "PENDING_TX_BLOCKED"
  | "CORRUPTED_STATE"
  | "KILLED";

export interface RuntimeHealthInfo {
  running: boolean;
  rpcHealthy: boolean;
  consecutiveErrors: number;
  lastSuccessfulCycleAt: number | null;
  recoveryState: RuntimeRecoveryState;
}

export interface AgentRuntimeConfig {
  agent: TrancheAutonomousAgent;
  pollIntervalMs: number;
  maxConsecutiveErrors?: number;
  /** Bounded retries per tick on transient RPC errors (default 2) */
  transientRpcRetries?: number;
  /** Initial retry backoff in ms (default 100ms, doubles per attempt) */
  retryBackoffMs?: number;
  /** Maximum backoff cap in ms for bounded exponential backoff (default 5000ms) */
  maxRetryBackoffMs?: number;
  /** When true, do not permanently pause on consecutive RPC errors so observation recovers automatically */
  autoRecoverFromRpcErrors?: boolean;
  logger?: StructuredLogger;
  onTrace?: (trace: AutonomousDecisionTrace) => void;
  onError?: (err: unknown, consecutiveErrors: number) => void;
  onRetry?: (attempt: number, backoffMs: number, err: unknown) => void;
  onRecovery?: (previousConsecutiveErrors: number) => void;
  onHealthTransition?: (from: RuntimeRecoveryState, to: RuntimeRecoveryState, reason: string) => void;
  onMissedCycle?: (reason: string) => void;
}

/**
 * Persistent continuous scheduler for TrancheAutonomousAgent.
 * Guarantees exclusive state locking, non-overlapping cycles, bounded transient RPC retry
 * with exponential backoff, consecutive-error circuit breaker, and graceful shutdown.
 */
export class AgentRuntime {
  private readonly cfg: AgentRuntimeConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private running = false;
  private consecutiveErrors = 0;
  private lastSuccessfulCycleAt: number | null = null;
  private rpcHealthy = true;
  private lastReportedRecoveryState: RuntimeRecoveryState = "HEALTHY";

  constructor(config: AgentRuntimeConfig) {
    this.cfg = config;
    this.lastReportedRecoveryState = this.getHealthInfo().recoveryState;
  }

  isRunning(): boolean {
    return this.running;
  }

  private emitHealthTransitionIfChanged(reason: string): void {
    const next = this.getHealthInfo().recoveryState;
    if (next !== this.lastReportedRecoveryState) {
      const prev = this.lastReportedRecoveryState;
      this.lastReportedRecoveryState = next;
      this.cfg.logger?.info("runtime.health_transition", {
        from: prev,
        to: next,
        reason,
        mode: this.cfg.agent.getExecutionMode(),
      });
      this.cfg.onHealthTransition?.(prev, next, reason);
    }
  }

  getHealthInfo(): RuntimeHealthInfo {
    const store = this.cfg.agent.getPositionStore();
    const limits = this.cfg.agent.getRiskLimits();
    let recoveryState: RuntimeRecoveryState = "HEALTHY";
    if (store.isStateCorrupted()) recoveryState = "CORRUPTED_STATE";
    else if (limits.killSwitch) recoveryState = "KILLED";
    else if (store.getPendingTxs().length > 0) recoveryState = "PENDING_TX_BLOCKED";
    else if (
      this.consecutiveErrors >= (this.cfg.maxConsecutiveErrors ?? 5) &&
      !(this.cfg.autoRecoverFromRpcErrors ?? this.cfg.agent.getExecutionMode() === "read_only")
    ) {
      recoveryState = "PAUSED_CIRCUIT_BREAKER";
    } else if (!this.rpcHealthy || this.consecutiveErrors > 0) {
      recoveryState = "RECOVERING";
    }

    return {
      running: this.running,
      rpcHealthy: this.rpcHealthy,
      consecutiveErrors: this.consecutiveErrors,
      lastSuccessfulCycleAt: this.lastSuccessfulCycleAt,
      recoveryState,
    };
  }

  start(): void {
    if (this.running) return;
    this.cfg.agent.getPositionStore().acquireLock();
    this.running = true;
    this.cfg.logger?.info("runtime.started", {
      pollIntervalMs: this.cfg.pollIntervalMs,
      mode: this.cfg.agent.getExecutionMode(),
    });
    void this.tickOnce();
    this.timer = setInterval(() => {
      if (this.inFlight) {
        this.cfg.logger?.warn("runtime.cycle_missed", {
          reason: "previous_cycle_still_in_flight",
          mode: this.cfg.agent.getExecutionMode(),
        });
        this.cfg.onMissedCycle?.("previous_cycle_still_in_flight");
        return;
      }
      void this.tickOnce();
    }, this.cfg.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.inFlight) {
      await new Promise((r) => setTimeout(r, 15));
    }
    this.cfg.agent.getPositionStore().releaseLock();
    this.cfg.logger?.info("runtime.stopped", { mode: this.cfg.agent.getExecutionMode() });
  }

  async tickOnce(nowSecOverride?: number): Promise<AutonomousDecisionTrace | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    const maxRetries = Math.max(0, this.cfg.transientRpcRetries ?? 2);
    const baseBackoff = Math.max(10, this.cfg.retryBackoffMs ?? 100);
    const maxBackoff = Math.max(baseBackoff, this.cfg.maxRetryBackoffMs ?? 5000);
    const autoRecover =
      this.cfg.autoRecoverFromRpcErrors ?? this.cfg.agent.getExecutionMode() === "read_only";
    try {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const trace = await this.cfg.agent.runCycle(nowSecOverride);
          const prevErrors = this.consecutiveErrors;
          const wasUnhealthy = !this.rpcHealthy || prevErrors > 0;
          this.consecutiveErrors = 0;
          this.rpcHealthy = true;
          this.lastSuccessfulCycleAt = trace.timestamp;
          if (wasUnhealthy) {
            this.cfg.logger?.info("runtime.rpc_recovered", {
              previousConsecutiveErrors: prevErrors,
              mode: trace.executionMode,
            });
            this.cfg.onRecovery?.(prevErrors);
          }
          this.emitHealthTransitionIfChanged("cycle_succeeded");
          this.cfg.logger?.info(
            "runtime.cycle_completed",
            {
              cycleId: trace.cycleId,
              mode: trace.executionMode,
              action: trace.selectedAction,
              venue: trace.venueSelection.selectedVenue,
              txCount: trace.txHashes.length,
              rpcLatencyMs: trace.rpcLatencyMs,
            },
            trace.decisionKey,
          );
          this.cfg.onTrace?.(trace);
          return trace;
        } catch (err) {
          lastErr = err;
          if (attempt < maxRetries && isUncertainRpcError(err)) {
            const backoffMs = Math.min(maxBackoff, baseBackoff * 2 ** attempt);
            this.cfg.logger?.warn("runtime.rpc_retry", {
              attempt: attempt + 1,
              maxRetries,
              backoffMs,
              mode: this.cfg.agent.getExecutionMode(),
              error: err instanceof Error ? err.message : String(err),
            });
            this.cfg.onRetry?.(attempt + 1, backoffMs, err);
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          break;
        }
      }

      this.consecutiveErrors += 1;
      if (isUncertainRpcError(lastErr)) {
        this.rpcHealthy = false;
      }
      this.cfg.logger?.warn("runtime.cycle_failed", {
        consecutiveErrors: this.consecutiveErrors,
        transient: isUncertainRpcError(lastErr),
        mode: this.cfg.agent.getExecutionMode(),
        error: lastErr instanceof Error ? lastErr.message : String(lastErr),
      });
      this.cfg.onError?.(lastErr, this.consecutiveErrors);
      const maxErrs = this.cfg.maxConsecutiveErrors ?? 5;
      if (this.consecutiveErrors >= maxErrs && !autoRecover) {
        this.cfg.agent.setPaused(true);
      }
      this.emitHealthTransitionIfChanged("cycle_failed");
      return null;
    } finally {
      this.inFlight = false;
    }
  }
}
