import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Address, Hex } from "viem";
import { PRICE_SCALE, ceilDiv } from "./hskswap.js";
import type { RiskPortfolioState } from "./risk.js";

export interface PendingTxRecord {
  id: string;
  decisionKey: string;
  action: "RESERVE_TRANCHE" | "SWAP_HSKSWAP" | "EXERCISE_TICKET" | "EXIT_POSITION";
  createdAt: number;
  status: "IN_FLIGHT" | "UNCERTAIN_TIMEOUT";
  note?: string;
}

export interface TrackedPosition {
  positionId: string;
  venue: "TRANCHE" | "HSKSWAP";
  inventoryToken: Address;
  paymentToken: Address;
  initialQuantity: bigint;
  remainingQuantity: bigint;
  entryCostPayment: bigint;
  remainingCostBasisPayment: bigint;
  reservationPremiumPaid: bigint;
  entryUnitPriceX36: bigint;
  realizedPnlPayment: bigint;
  unrealizedPnlPayment: bigint;
  status: "OPEN" | "PARTIALLY_CLOSED" | "CLOSED";
  openedAt: number;
  closedAt: number | null;
  sourceTicketId?: bigint;
  entryTxHashes: Hex[];
  exitTxHashes: Hex[];
}

export interface TrackedTicket {
  ticketId: bigint;
  offerId: bigint;
  inventoryToken: Address;
  paymentToken: Address;
  inventoryAmount: bigint;
  remainingAmount: bigint;
  premiumPaidPayment: bigint;
  expiresAt: number;
  reservedAt: number;
  status: "ACTIVE" | "EXERCISED" | "EXPIRED_ABANDONED" | "RECLAIMED";
  reserveTxHash: Hex;
  exerciseTxHashes: Hex[];
  reclaimTxHash?: Hex;
}

export interface DailyAccounting {
  dateUtc: string;
  premiumSpentPayment: bigint;
  realizedLossPayment: bigint;
  realizedProfitPayment: bigint;
}

export interface PersistedAgentState {
  version: number;
  positions: TrackedPosition[];
  tickets: TrackedTicket[];
  pendingTxs: PendingTxRecord[];
  daily: DailyAccounting;
  executedDecisionKeys: string[];
  lastUpdatedAt: number;
}

function serializeBigInt(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { __bigint: value.toString() } : value;
}

function deserializeBigInt(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    "__bigint" in value &&
    typeof (value as { __bigint: unknown }).__bigint === "string"
  ) {
    return BigInt((value as { __bigint: string }).__bigint);
  }
  return value;
}

function utcDateKey(timestampSec: number): string {
  return new Date(timestampSec * 1000).toISOString().slice(0, 10);
}

/**
 * Persistent position, ticket, daily-budget, and deduplication ledger.
 * Survives runtime restarts via atomic JSON persistence.
 */
export class PositionStore {
  private positions: TrackedPosition[] = [];
  private tickets: TrackedTicket[] = [];
  private pendingTxs: PendingTxRecord[] = [];
  private daily: DailyAccounting;
  private executedKeys = new Set<string>();
  private stateCorrupted = false;
  private corruptionError: string | null = null;
  private readonly filePath?: string;

  constructor(filePath?: string, nowSec: number = Math.floor(Date.now() / 1000)) {
    this.filePath = filePath;
    this.daily = {
      dateUtc: utcDateKey(nowSec),
      premiumSpentPayment: 0n,
      realizedLossPayment: 0n,
      realizedProfitPayment: 0n,
    };
    if (filePath && existsSync(filePath)) {
      this.load();
    }
  }

  isStateCorrupted(): boolean {
    return this.stateCorrupted;
  }

  getCorruptionError(): string | null {
    return this.corruptionError;
  }

  beginPendingTx(record: Omit<PendingTxRecord, "status">): void {
    this.pendingTxs.push({ ...record, status: "IN_FLIGHT" });
    this.save();
  }

  resolvePendingTx(id: string): void {
    this.pendingTxs = this.pendingTxs.filter((p) => p.id !== id);
    this.save();
  }

  markPendingTxUncertain(id: string, note: string): void {
    const rec = this.pendingTxs.find((p) => p.id === id);
    if (rec) {
      rec.status = "UNCERTAIN_TIMEOUT";
      rec.note = note;
      this.save();
    }
  }

  getPendingTxs(): readonly PendingTxRecord[] {
    return this.pendingTxs;
  }

  private rollDayIfNeeded(nowSec: number): void {
    const key = utcDateKey(nowSec);
    if (this.daily.dateUtc !== key) {
      this.daily = {
        dateUtc: key,
        premiumSpentPayment: 0n,
        realizedLossPayment: 0n,
        realizedProfitPayment: 0n,
      };
    }
  }

  hasExecutedDecision(key: string): boolean {
    return this.executedKeys.has(key);
  }

  markDecisionExecuted(key: string): void {
    this.executedKeys.add(key);
    this.save();
  }

  recordReservedTicket(ticket: TrackedTicket): void {
    this.rollDayIfNeeded(ticket.reservedAt);
    this.tickets.push(ticket);
    this.daily.premiumSpentPayment += ticket.premiumPaidPayment;
    this.save();
  }

  markTicketExercised(
    ticketId: bigint,
    filledAmount: bigint,
    exercisePayment: bigint,
    txHash: Hex,
    nowSec: number,
  ): TrackedPosition {
    const ticket = this.tickets.find((t) => t.ticketId === ticketId);
    if (!ticket) throw new Error(`Tracked ticket #${ticketId} not found`);

    ticket.remainingAmount =
      ticket.remainingAmount > filledAmount ? ticket.remainingAmount - filledAmount : 0n;
    ticket.exerciseTxHashes.push(txHash);
    if (ticket.remainingAmount === 0n) {
      ticket.status = "EXERCISED";
    }

    // Proportional share of non-refundable premium attached to this exercised fill
    const allocatedPremium =
      ticket.inventoryAmount > 0n
        ? (ticket.premiumPaidPayment * filledAmount) / ticket.inventoryAmount
        : 0n;
    const totalEntryCost = exercisePayment + allocatedPremium;
    const entryUnitPriceX36 = ceilDiv(totalEntryCost * PRICE_SCALE, filledAmount);

    const position: TrackedPosition = {
      positionId: `pos-tranche-${ticketId}-${ticket.exerciseTxHashes.length}`,
      venue: "TRANCHE",
      inventoryToken: ticket.inventoryToken,
      paymentToken: ticket.paymentToken,
      initialQuantity: filledAmount,
      remainingQuantity: filledAmount,
      entryCostPayment: totalEntryCost,
      remainingCostBasisPayment: totalEntryCost,
      reservationPremiumPaid: allocatedPremium,
      entryUnitPriceX36,
      realizedPnlPayment: 0n,
      unrealizedPnlPayment: 0n,
      status: "OPEN",
      openedAt: nowSec,
      closedAt: null,
      sourceTicketId: ticketId,
      entryTxHashes: [ticket.reserveTxHash, txHash],
      exitTxHashes: [],
    };
    this.positions.push(position);
    this.save();
    return position;
  }

  markTicketReclaimed(ticketId: bigint, txHash: Hex): void {
    const ticket = this.tickets.find((t) => t.ticketId === ticketId);
    if (!ticket) return;
    ticket.status = "RECLAIMED";
    ticket.remainingAmount = 0n;
    ticket.reclaimTxHash = txHash;
    this.save();
  }

  markTicketAbandoned(ticketId: bigint): void {
    const ticket = this.tickets.find((t) => t.ticketId === ticketId);
    if (!ticket) return;
    ticket.status = "EXPIRED_ABANDONED";
    this.save();
  }

  recordDexPosition(params: {
    inventoryToken: Address;
    paymentToken: Address;
    quantity: bigint;
    entryCostPayment: bigint;
    txHash: Hex;
    nowSec: number;
  }): TrackedPosition {
    this.rollDayIfNeeded(params.nowSec);
    const entryUnitPriceX36 = ceilDiv(params.entryCostPayment * PRICE_SCALE, params.quantity);
    const position: TrackedPosition = {
      positionId: `pos-dex-${this.positions.length + 1}-${params.nowSec}`,
      venue: "HSKSWAP",
      inventoryToken: params.inventoryToken,
      paymentToken: params.paymentToken,
      initialQuantity: params.quantity,
      remainingQuantity: params.quantity,
      entryCostPayment: params.entryCostPayment,
      remainingCostBasisPayment: params.entryCostPayment,
      reservationPremiumPaid: 0n,
      entryUnitPriceX36,
      realizedPnlPayment: 0n,
      unrealizedPnlPayment: 0n,
      status: "OPEN",
      openedAt: params.nowSec,
      closedAt: null,
      entryTxHashes: [params.txHash],
      exitTxHashes: [],
    };
    this.positions.push(position);
    this.save();
    return position;
  }

  recordPositionExit(params: {
    positionId: string;
    soldQuantity: bigint;
    proceedsPayment: bigint;
    txHash: Hex;
    nowSec: number;
  }): { position: TrackedPosition; realizedDelta: bigint } {
    this.rollDayIfNeeded(params.nowSec);
    const pos = this.positions.find((p) => p.positionId === params.positionId);
    if (!pos) throw new Error(`Position ${params.positionId} not found`);

    const proportionalBasis =
      pos.remainingQuantity > 0n
        ? (pos.remainingCostBasisPayment * params.soldQuantity) / pos.remainingQuantity
        : pos.remainingCostBasisPayment;
    const realizedDelta = params.proceedsPayment - proportionalBasis;

    pos.remainingQuantity =
      pos.remainingQuantity > params.soldQuantity ? pos.remainingQuantity - params.soldQuantity : 0n;
    pos.remainingCostBasisPayment =
      pos.remainingCostBasisPayment > proportionalBasis
        ? pos.remainingCostBasisPayment - proportionalBasis
        : 0n;
    pos.realizedPnlPayment += realizedDelta;
    pos.exitTxHashes.push(params.txHash);

    if (realizedDelta < 0n) {
      this.daily.realizedLossPayment += -realizedDelta;
    } else {
      this.daily.realizedProfitPayment += realizedDelta;
    }

    if (pos.remainingQuantity === 0n) {
      pos.status = "CLOSED";
      pos.unrealizedPnlPayment = 0n;
      pos.closedAt = params.nowSec;
    } else {
      pos.status = "PARTIALLY_CLOSED";
    }

    this.save();
    return { position: pos, realizedDelta };
  }

  updateUnrealizedPnl(positionId: string, executableExitPayment: bigint): void {
    const pos = this.positions.find((p) => p.positionId === positionId);
    if (!pos || pos.status === "CLOSED") return;
    pos.unrealizedPnlPayment = executableExitPayment - pos.remainingCostBasisPayment;
  }

  getOpenPositions(): TrackedPosition[] {
    return this.positions.filter((p) => p.status === "OPEN" || p.status === "PARTIALLY_CLOSED");
  }

  getAllPositions(): readonly TrackedPosition[] {
    return this.positions;
  }

  getActiveTickets(): TrackedTicket[] {
    return this.tickets.filter((t) => t.status === "ACTIVE");
  }

  getAllTickets(): readonly TrackedTicket[] {
    return this.tickets;
  }

  getPortfolioState(nowSec: number): RiskPortfolioState {
    this.rollDayIfNeeded(nowSec);
    const openPos = this.getOpenPositions();
    const activeTix = this.getActiveTickets();
    let totalExposure = 0n;
    for (const p of openPos) totalExposure += p.remainingCostBasisPayment;
    for (const t of activeTix) totalExposure += t.premiumPaidPayment;

    return {
      openPositionsCount: openPos.length,
      activeTicketsCount: activeTix.length,
      pendingTxCount: this.pendingTxs.length,
      currentTotalExposurePayment: totalExposure,
      dailyPremiumSpentPayment: this.daily.premiumSpentPayment,
      dailyRealizedLossPayment: this.daily.realizedLossPayment,
    };
  }

  save(): void {
    if (!this.filePath || this.stateCorrupted) return;
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload: PersistedAgentState = {
      version: 1,
      positions: this.positions,
      tickets: this.tickets,
      pendingTxs: this.pendingTxs,
      daily: this.daily,
      executedDecisionKeys: Array.from(this.executedKeys),
      lastUpdatedAt: Math.floor(Date.now() / 1000),
    };
    const tmpPath = `${this.filePath}.tmp`;
    const bakPath = `${this.filePath}.bak`;
    writeFileSync(tmpPath, JSON.stringify(payload, serializeBigInt, 2), "utf8");
    if (existsSync(this.filePath)) {
      try {
        copyFileSync(this.filePath, bakPath);
      } catch {
        // best-effort backup
      }
    }
    renameSync(tmpPath, this.filePath);
  }

  load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw, deserializeBigInt) as PersistedAgentState;
      if (parsed.version !== 1 || !Array.isArray(parsed.positions) || !Array.isArray(parsed.tickets)) {
        throw new Error("Invalid persisted state schema");
      }
      this.positions = parsed.positions;
      this.tickets = parsed.tickets;
      this.pendingTxs = Array.isArray(parsed.pendingTxs) ? parsed.pendingTxs : [];
      this.daily = parsed.daily ?? this.daily;
      this.executedKeys = new Set(parsed.executedDecisionKeys ?? []);
      this.stateCorrupted = false;
      this.corruptionError = null;
    } catch (err) {
      // Fail closed: do NOT silently wipe state on corrupted JSON
      this.stateCorrupted = true;
      this.corruptionError = err instanceof Error ? err.message : String(err);
    }
  }
}
