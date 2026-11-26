import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAddress, isAddress, verifyMessage, type Hex } from "viem";

export type UserAgentStrategyType = "price_threshold" | "momentum" | "volatility_aware";

export interface UserAgentProfile {
  address: string;
  paused: boolean;
  strategyType: UserAgentStrategyType;
  takeProfitBps: number;
  stopLossBps: number;
  maxSlippageBps: number;
  version: number;
  updatedAt: number;
}

export interface SignedProfileUpdatePayload {
  paused: boolean;
  strategyType: UserAgentStrategyType;
  takeProfitBps: number;
  stopLossBps: number;
  maxSlippageBps: number;
  timestamp: number;
  signature: Hex;
}

const VALID_STRATEGIES = new Set<UserAgentStrategyType>([
  "price_threshold",
  "momentum",
  "volatility_aware",
]);

const MAX_SIGNATURE_AGE_SEC = 600; // 10 minutes

export function buildProfileSignMessage(params: {
  address: string;
  paused: boolean;
  strategyType: UserAgentStrategyType;
  takeProfitBps: number;
  stopLossBps: number;
  maxSlippageBps: number;
  timestamp: number;
}): string {
  return [
    "Tranche Agent Profile Update",
    `Wallet: ${params.address.toLowerCase()}`,
    `Status: ${params.paused ? "paused" : "active"}`,
    `Strategy: ${params.strategyType}`,
    `TakeProfitBps: ${params.takeProfitBps}`,
    `StopLossBps: ${params.stopLossBps}`,
    `MaxSlippageBps: ${params.maxSlippageBps}`,
    `Timestamp: ${params.timestamp}`,
  ].join("\n");
}

export class UserProfileStore {
  private readonly filePath: string;
  private readonly profiles = new Map<string, UserAgentProfile>();

  constructor(filePath?: string) {
    this.filePath = resolve(
      filePath ?? process.env.TRANCHE_USER_PROFILES_PATH ?? "./data/user-profiles.json",
    );
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, UserAgentProfile>;
      if (parsed && typeof parsed === "object") {
        for (const [key, val] of Object.entries(parsed)) {
          if (val && typeof val === "object" && typeof val.address === "string") {
            this.profiles.set(key.toLowerCase(), val);
          }
        }
      }
    } catch {
      // File may not exist on first boot — start empty
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const obj: Record<string, UserAgentProfile> = {};
    for (const [k, v] of this.profiles.entries()) {
      obj[k] = v;
    }
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  get(address: string): UserAgentProfile | null {
    if (!isAddress(address)) return null;
    return this.profiles.get(address.toLowerCase()) ?? null;
  }

  async verifyAndSave(
    rawAddress: string,
    payload: SignedProfileUpdatePayload,
  ): Promise<{ ok: true; profile: UserAgentProfile } | { ok: false; status: number; code: string; message: string }> {
    if (!isAddress(rawAddress)) {
      return { ok: false, status: 400, code: "INVALID_ADDRESS", message: "Invalid wallet address" };
    }
    const checksumAddress = getAddress(rawAddress);
    const key = checksumAddress.toLowerCase();

    if (!VALID_STRATEGIES.has(payload.strategyType)) {
      return { ok: false, status: 400, code: "INVALID_STRATEGY", message: "Unsupported strategy type" };
    }
    if (
      !Number.isInteger(payload.takeProfitBps) ||
      payload.takeProfitBps < 50 ||
      payload.takeProfitBps > 2000
    ) {
      return { ok: false, status: 400, code: "OUT_OF_BOUNDS", message: "Take profit must be 0.5%–20%" };
    }
    if (
      !Number.isInteger(payload.stopLossBps) ||
      payload.stopLossBps < 50 ||
      payload.stopLossBps > 1500
    ) {
      return { ok: false, status: 400, code: "OUT_OF_BOUNDS", message: "Stop loss must be 0.5%–15%" };
    }
    if (
      !Number.isInteger(payload.maxSlippageBps) ||
      payload.maxSlippageBps < 10 ||
      payload.maxSlippageBps > 300
    ) {
      return { ok: false, status: 400, code: "OUT_OF_BOUNDS", message: "Max shift must be 0.1%–3%" };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (
      !Number.isInteger(payload.timestamp) ||
      Math.abs(nowSec - payload.timestamp) > MAX_SIGNATURE_AGE_SEC
    ) {
      return {
        ok: false,
        status: 400,
        code: "EXPIRED_SIGNATURE",
        message: "Signature timestamp expired — please sign again",
      };
    }

    const message = buildProfileSignMessage({
      address: key,
      paused: Boolean(payload.paused),
      strategyType: payload.strategyType,
      takeProfitBps: payload.takeProfitBps,
      stopLossBps: payload.stopLossBps,
      maxSlippageBps: payload.maxSlippageBps,
      timestamp: payload.timestamp,
    });

    let validSig = false;
    try {
      validSig = await verifyMessage({
        address: checksumAddress,
        message,
        signature: payload.signature,
      });
    } catch {
      validSig = false;
    }

    if (!validSig) {
      return {
        ok: false,
        status: 401,
        code: "INVALID_SIGNATURE",
        message: "Wallet signature verification failed",
      };
    }

    const existing = this.profiles.get(key);
    const profile: UserAgentProfile = {
      address: checksumAddress,
      paused: Boolean(payload.paused),
      strategyType: payload.strategyType,
      takeProfitBps: payload.takeProfitBps,
      stopLossBps: payload.stopLossBps,
      maxSlippageBps: payload.maxSlippageBps,
      version: (existing?.version ?? 0) + 1,
      updatedAt: nowSec,
    };

    this.profiles.set(key, profile);
    this.persist();
    return { ok: true, profile };
  }
}
