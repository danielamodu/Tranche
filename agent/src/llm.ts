import type { RiskLimits } from "./risk.js";
import type { StrategyConfig, StrategyType } from "./strategy.js";
import type { AutonomousDecisionTrace } from "./runtime.js";

export interface AgentPolicyPatch {
  strategyType?: StrategyType;
  takeProfitBps?: number;
  stopLossBps?: number;
  maxSlippageBps?: number;
  maxPositionSizeInventory?: bigint;
  maxVolatilityBps?: number;
  maxTotalExposurePayment?: bigint;
  maxDailyRealizedLossPayment?: bigint;
  paused?: boolean;
}

export interface PolicyValidationBounds {
  hardMaxPositionSizeInventory: bigint;
  hardMaxSlippageBps: number;
  minStopLossBps: number;
  maxStopLossBps: number;
  minTakeProfitBps: number;
  maxTakeProfitBps: number;
  hardMaxVolatilityBps?: number;
  hardMaxTotalExposurePayment?: bigint;
  hardMaxDailyRealizedLossPayment?: bigint;
}

export interface PolicyValidationResult {
  valid: boolean;
  sanitizedPatch: AgentPolicyPatch;
  rejectedFields: string[];
}

/**
 * Provider-agnostic LLM interface.
 * Responsibilities are strictly bounded to:
 *  1) Interpreting natural-language instructions into a validated AgentPolicyPatch
 *  2) Explaining actual AutonomousDecisionTrace records in plain English
 * It can NEVER bypass RiskManager, modify contract addresses, or sign transactions.
 */
export interface LlmProvider {
  readonly name: string;
  parseInstruction(
    instruction: string,
    currentStrategy: StrategyConfig,
    currentLimits: RiskLimits,
  ): Promise<AgentPolicyPatch>;
  explainTrace(trace: AutonomousDecisionTrace): Promise<string>;
}

export function validatePolicyPatch(
  patch: AgentPolicyPatch,
  bounds: PolicyValidationBounds,
): PolicyValidationResult {
  const sanitized: AgentPolicyPatch = {};
  const rejectedFields: string[] = [];

  if (patch.strategyType !== undefined) {
    if (["momentum", "price_threshold", "volatility_aware"].includes(patch.strategyType)) {
      sanitized.strategyType = patch.strategyType;
    } else {
      rejectedFields.push(`strategyType:${String(patch.strategyType)}`);
    }
  }

  if (patch.takeProfitBps !== undefined) {
    if (
      Number.isInteger(patch.takeProfitBps) &&
      patch.takeProfitBps >= bounds.minTakeProfitBps &&
      patch.takeProfitBps <= bounds.maxTakeProfitBps
    ) {
      sanitized.takeProfitBps = patch.takeProfitBps;
    } else {
      rejectedFields.push(`takeProfitBps:${patch.takeProfitBps}`);
    }
  }

  if (patch.stopLossBps !== undefined) {
    if (
      Number.isInteger(patch.stopLossBps) &&
      patch.stopLossBps >= bounds.minStopLossBps &&
      patch.stopLossBps <= bounds.maxStopLossBps
    ) {
      sanitized.stopLossBps = patch.stopLossBps;
    } else {
      rejectedFields.push(`stopLossBps:${patch.stopLossBps}`);
    }
  }

  if (patch.maxSlippageBps !== undefined) {
    if (
      Number.isInteger(patch.maxSlippageBps) &&
      patch.maxSlippageBps > 0 &&
      patch.maxSlippageBps <= bounds.hardMaxSlippageBps
    ) {
      sanitized.maxSlippageBps = patch.maxSlippageBps;
    } else {
      rejectedFields.push(`maxSlippageBps:${patch.maxSlippageBps}`);
    }
  }

  if (patch.maxPositionSizeInventory !== undefined) {
    if (
      patch.maxPositionSizeInventory > 0n &&
      patch.maxPositionSizeInventory <= bounds.hardMaxPositionSizeInventory
    ) {
      sanitized.maxPositionSizeInventory = patch.maxPositionSizeInventory;
    } else {
      rejectedFields.push(`maxPositionSizeInventory:${patch.maxPositionSizeInventory}`);
    }
  }

  if (patch.maxVolatilityBps !== undefined) {
    const volCap = bounds.hardMaxVolatilityBps ?? 3000;
    if (
      Number.isInteger(patch.maxVolatilityBps) &&
      patch.maxVolatilityBps >= 50 &&
      patch.maxVolatilityBps <= volCap
    ) {
      sanitized.maxVolatilityBps = patch.maxVolatilityBps;
    } else {
      rejectedFields.push(`maxVolatilityBps:${patch.maxVolatilityBps}`);
    }
  }

  if (patch.maxTotalExposurePayment !== undefined) {
    const expCap = bounds.hardMaxTotalExposurePayment ?? 100_000_000n;
    if (patch.maxTotalExposurePayment > 0n && patch.maxTotalExposurePayment <= expCap) {
      sanitized.maxTotalExposurePayment = patch.maxTotalExposurePayment;
    } else {
      rejectedFields.push(`maxTotalExposurePayment:${patch.maxTotalExposurePayment}`);
    }
  }

  if (patch.maxDailyRealizedLossPayment !== undefined) {
    const lossCap = bounds.hardMaxDailyRealizedLossPayment ?? 25_000_000n;
    if (patch.maxDailyRealizedLossPayment > 0n && patch.maxDailyRealizedLossPayment <= lossCap) {
      sanitized.maxDailyRealizedLossPayment = patch.maxDailyRealizedLossPayment;
    } else {
      rejectedFields.push(`maxDailyRealizedLossPayment:${patch.maxDailyRealizedLossPayment}`);
    }
  }

  if (patch.paused !== undefined) {
    sanitized.paused = Boolean(patch.paused);
  }

  return {
    valid: rejectedFields.length === 0,
    sanitizedPatch: sanitized,
    rejectedFields,
  };
}

/**
 * Applies ONLY validated, sanitized fields from an AgentPolicyPatch.
 * Never touches killSwitch, contract addresses, or wallet/signing state.
 */
export function applyValidatedPolicyPatch(
  strategy: StrategyConfig,
  limits: RiskLimits,
  patch: AgentPolicyPatch,
  bounds: PolicyValidationBounds,
): PolicyValidationResult {
  const result = validatePolicyPatch(patch, bounds);
  const s = result.sanitizedPatch;
  if (s.strategyType !== undefined) strategy.type = s.strategyType;
  if (s.takeProfitBps !== undefined) strategy.takeProfitBps = s.takeProfitBps;
  if (s.stopLossBps !== undefined) strategy.stopLossBps = s.stopLossBps;
  if (s.maxVolatilityBps !== undefined) strategy.maxVolatilityBps = s.maxVolatilityBps;
  if (s.maxSlippageBps !== undefined) limits.maxSlippageBps = s.maxSlippageBps;
  if (s.maxPositionSizeInventory !== undefined) {
    limits.maxPositionSizeInventory = s.maxPositionSizeInventory;
  }
  if (s.maxTotalExposurePayment !== undefined) {
    limits.maxTotalExposurePayment = s.maxTotalExposurePayment;
  }
  if (s.maxDailyRealizedLossPayment !== undefined) {
    limits.maxDailyRealizedLossPayment = s.maxDailyRealizedLossPayment;
  }
  if (s.paused !== undefined && !limits.killSwitch) {
    // Kill switch can never be cleared via natural language
    limits.paused = s.paused;
  }
  return result;
}

/**
 * Deterministic zero-cost local provider so the full agent & NL policy interface
 * works offline with zero paid API keys.
 */
export class LocalRuleBasedLlmProvider implements LlmProvider {
  public readonly name = "local-deterministic";

  async parseInstruction(instruction: string): Promise<AgentPolicyPatch> {
    const text = instruction.toLowerCase();
    const patch: AgentPolicyPatch = {};

    if (text.includes("pause")) patch.paused = true;
    else if (text.includes("resume") || text.includes("unpause")) patch.paused = false;

    if (text.includes("momentum")) patch.strategyType = "momentum";
    else if (text.includes("threshold") || text.includes("dip")) patch.strategyType = "price_threshold";
    else if (text.includes("volatility")) patch.strategyType = "volatility_aware";

    const tpMatch = text.match(/take[\s-]?profit\s+(\d+(?:\.\d+)?)\s*(%|bps)?/);
    if (tpMatch) {
      const val = Number(tpMatch[1]);
      patch.takeProfitBps = tpMatch[2] === "bps" ? Math.round(val) : Math.round(val * 100);
    }

    const slMatch = text.match(/stop[\s-]?loss\s+(\d+(?:\.\d+)?)\s*(%|bps)?/);
    if (slMatch) {
      const val = Number(slMatch[1]);
      patch.stopLossBps = slMatch[2] === "bps" ? Math.round(val) : Math.round(val * 100);
    }

    const slipMatch = text.match(/slippage\s+(\d+(?:\.\d+)?)\s*(%|bps)?/);
    if (slipMatch) {
      const val = Number(slipMatch[1]);
      patch.maxSlippageBps = slipMatch[2] === "bps" ? Math.round(val) : Math.round(val * 100);
    }

    const volMatch = text.match(/max[\s-]?volatility\s+(\d+(?:\.\d+)?)\s*(%|bps)?/);
    if (volMatch) {
      const val = Number(volMatch[1]);
      patch.maxVolatilityBps = volMatch[2] === "%" ? Math.round(val * 100) : Math.round(val);
    } else if (text.includes("avoid") && text.includes("elevated volatility")) {
      patch.maxVolatilityBps = 350;
    }

    const expMatch = text.match(/(?:limit|max)\s+exposure(?:\s+to)?\s+\$?(\d+(?:\.\d+)?)/);
    if (expMatch) {
      patch.maxTotalExposurePayment = BigInt(Math.round(Number(expMatch[1]) * 1_000_000));
    }

    const lossMatch = text.match(/daily[\s-]?loss(?:\s+(?:to|cap|limit))?\s+\$?(\d+(?:\.\d+)?)/);
    if (lossMatch) {
      patch.maxDailyRealizedLossPayment = BigInt(Math.round(Number(lossMatch[1]) * 1_000_000));
    }

    return patch;
  }

  async explainTrace(trace: AutonomousDecisionTrace): Promise<string> {
    const parts = [
      `Cycle #${trace.cycleId} (${trace.strategyConfig.type}) -> action=${trace.selectedAction}.`,
      `Signal: ${trace.signal.reason}.`,
      `Venue: ${trace.venueSelection.selectedVenue} (${trace.venueSelection.rationale}).`,
      `Risk: ${trace.riskReport.allowed ? "PASSED" : `BLOCKED (${trace.riskReport.failedChecks.map((c) => c.name).join(", ")})`}.`,
    ];
    if (trace.txHashes.length > 0) {
      parts.push(`Transactions: ${trace.txHashes.join(", ")}.`);
    }
    return parts.join(" ");
  }
}
