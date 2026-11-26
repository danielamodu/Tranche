import fs from "node:fs";
import path from "node:path";
import type { HspPaymentRecord } from "./types.js";

interface PersistedHspPaymentsFile {
  version: 1;
  updatedAt: number;
  payments: HspPaymentRecord[];
  /** Monotonic set of idempotencyKeys for which a submission was ever dispatched. */
  submittedIdempotencyKeys: string[];
}

function cloneRecord(record: HspPaymentRecord): HspPaymentRecord {
  return {
    ...record,
    authorization: record.authorization ? { ...record.authorization } : undefined,
    history: record.history.map((h) => ({ ...h })),
  };
}

/**
 * Atomic JSON-file persistence store for HSP payment records.
 * Completely separate from PositionStore (trading state).
 */
export class HspPaymentStore {
  private readonly filePath?: string;
  private readonly byId = new Map<string, HspPaymentRecord>();
  private readonly idByIdempotencyKey = new Map<string, string>();
  private readonly submittedKeys = new Set<string>();
  private stateCorrupted = false;

  constructor(filePath?: string) {
    this.filePath = filePath;
    if (filePath) {
      this.loadFromDisk(filePath);
    }
  }

  isStateCorrupted(): boolean {
    return this.stateCorrupted;
  }

  getById(paymentId: string): HspPaymentRecord | null {
    const rec = this.byId.get(paymentId);
    return rec ? cloneRecord(rec) : null;
  }

  getByIdempotencyKey(idempotencyKey: string): HspPaymentRecord | null {
    const id = this.idByIdempotencyKey.get(idempotencyKey);
    if (!id) return null;
    return this.getById(id);
  }

  hasSubmissionBeenDispatched(idempotencyKey: string): boolean {
    return this.submittedKeys.has(idempotencyKey);
  }

  listAll(): HspPaymentRecord[] {
    return Array.from(this.byId.values())
      .map(cloneRecord)
      .sort((a, b) => b.createdAt - a.createdAt || b.paymentId.localeCompare(a.paymentId));
  }

  save(record: HspPaymentRecord, markSubmitted = false): void {
    const copy = cloneRecord(record);
    this.byId.set(copy.paymentId, copy);
    this.idByIdempotencyKey.set(copy.idempotencyKey, copy.paymentId);
    if (markSubmitted || copy.submissionAttempts > 0) {
      this.submittedKeys.add(copy.idempotencyKey);
    }
    this.persist();
  }

  private loadFromDisk(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedHspPaymentsFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.payments)) {
        this.stateCorrupted = true;
        return;
      }
      for (const rec of parsed.payments) {
        if (!rec?.paymentId || !rec?.idempotencyKey || !rec?.state) {
          this.stateCorrupted = true;
          return;
        }
        this.byId.set(rec.paymentId, cloneRecord(rec));
        this.idByIdempotencyKey.set(rec.idempotencyKey, rec.paymentId);
        if (rec.submissionAttempts > 0) {
          this.submittedKeys.add(rec.idempotencyKey);
        }
      }
      if (Array.isArray(parsed.submittedIdempotencyKeys)) {
        for (const key of parsed.submittedIdempotencyKeys) {
          if (typeof key === "string") this.submittedKeys.add(key);
        }
      }
    } catch {
      this.stateCorrupted = true;
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload: PersistedHspPaymentsFile = {
      version: 1,
      updatedAt: Math.floor(Date.now() / 1000),
      payments: Array.from(this.byId.values()),
      submittedIdempotencyKeys: Array.from(this.submittedKeys),
    };
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmpPath, this.filePath);
  }
}
