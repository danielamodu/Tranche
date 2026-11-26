import type { EvaluationMetricsSummary } from "./evaluation.js";
import type { MarketRegime } from "./market.js";
import type { PortfolioSnapshot } from "./portfolio.js";
import type { RiskLimits } from "./risk.js";
import type { AutonomousDecisionTrace } from "./runtime.js";
import type { StrategyConfig, StrategyType } from "./strategy.js";

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

export interface StructuredPortfolioExplanation {
  summary: string;
  marketRegime: MarketRegime;
  portfolioHealth: "HEALTHY" | "CONSTRAINED" | "CAUTION";
  keyFacts: string[];
}

export interface StructuredDecisionSummary {
  cycleId: number;
  headline: string;
  venueSummary: string;
  riskSummary: string;
  actionTaken: string;
}

export interface EvaluationInterpretation {
  dataProvenance: EvaluationMetricsSummary["dataProvenance"];
  headline: string;
  strengths: string[];
  concerns: string[];
  sampleSizeSufficient: boolean;
}

export interface BoundedStrategyRecommendation {
  /** Recommendations NEVER auto-apply; operator approval is strictly required. */
  requiresExplicitApproval: true;
  autoApplied: false;
  rationale: string;
  proposedPatch: AgentPolicyPatch;
  validation: PolicyValidationResult;
}

const ALLOWED_PATCH_KEYS = new Set<string>([
  "strategyType",
  "takeProfitBps",
  "stopLossBps",
  "maxSlippageBps",
  "maxPositionSizeInventory",
  "maxVolatilityBps",
  "maxTotalExposurePayment",
  "maxDailyRealizedLossPayment",
  "paused",
]);

/**
 * Strictly validates raw/untrusted LLM output objects against allowed keys and hard bounds.
 * Rejects malformed JSON, forbidden fields (e.g., killSwitch, privateKey, signTransaction),
 * and out-of-bounds numeric proposals.
 */
export function sanitizeRawLlmPatch(
  raw: unknown,
  bounds: PolicyValidationBounds,
): PolicyValidationResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      valid: false,
      sanitizedPatch: {},
      rejectedFields: ["MALFORMED_OUTPUT:expected_object"],
    };
  }

  const obj = raw as Record<string, unknown>;
  const unknownRejections: string[] = [];
  const candidate: AgentPolicyPatch = {};

  for (const [k, v] of Object.entries(obj)) {
    if (!ALLOWED_PATCH_KEYS.has(k)) {
      unknownRejections.push(`FORBIDDEN_OR_UNKNOWN_FIELD:${k}`);
      continue;
    }
    if (k === "strategyType" && typeof v === "string") {
      candidate.strategyType = v as StrategyType;
    } else if (
      (k === "takeProfitBps" ||
        k === "stopLossBps" ||
        k === "maxSlippageBps" ||
        k === "maxVolatilityBps") &&
      typeof v === "number"
    ) {
      candidate[k] = v;
    } else if (
      k === "maxPositionSizeInventory" ||
      k === "maxTotalExposurePayment" ||
      k === "maxDailyRealizedLossPayment"
    ) {
      if (typeof v === "bigint") {
        candidate[k] = v;
      } else if (typeof v === "string" && /^\d+$/.test(v)) {
        candidate[k] = BigInt(v);
      } else {
        unknownRejections.push(`${k}:invalid_bigint`);
      }
    } else if (k === "paused" && typeof v === "boolean") {
      candidate.paused = v;
    } else if (v !== undefined) {
      unknownRejections.push(`${k}:invalid_type`);
    }
  }

  const base = validatePolicyPatch(candidate, bounds);
  const allRejected = [...unknownRejections, ...base.rejectedFields];
  return {
    valid: allRejected.length === 0,
    sanitizedPatch: base.sanitizedPatch,
    rejectedFields: allRejected,
  };
}

/**
 * Provider-agnostic LLM interface.
 * Responsibilities are strictly bounded to:
 *  1) Interpreting natural-language objectives into a validated AgentPolicyPatch
 *  2) Explaining market, portfolio, and AutonomousDecisionTrace records
 *  3) Interpreting evaluation metrics and proposing bounded, approval-gated adjustments
 * It can NEVER bypass RiskManager, modify hard risk limits, clear killSwitch, or sign transactions.
 */
export interface LlmProvider {
  readonly name: string;
  parseInstruction(
    instruction: string,
    currentStrategy: StrategyConfig,
    currentLimits: RiskLimits,
  ): Promise<AgentPolicyPatch>;
  explainTrace(trace: AutonomousDecisionTrace): Promise<string>;
  explainPortfolioAndMarket?(params: {
    portfolio: PortfolioSnapshot;
    marketRegime: MarketRegime;
    anomalies: string[];
  }): Promise<StructuredPortfolioExplanation>;
  summarizeDecision?(trace: AutonomousDecisionTrace): Promise<StructuredDecisionSummary>;
  interpretEvaluation?(summary: EvaluationMetricsSummary): Promise<EvaluationInterpretation>;
  proposeBoundedAdjustments?(params: {
    evaluation: EvaluationMetricsSummary;
    currentStrategy: StrategyConfig;
    currentLimits: RiskLimits;
    bounds: PolicyValidationBounds;
  }): Promise<BoundedStrategyRecommendation>;
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
 * Deterministic zero-cost local provider so the full agent, NL policy interface,
 * portfolio explanations, and bounded evaluation recommendations work offline
 * with zero paid API keys and strict fallback guarantees.
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

  async explainPortfolioAndMarket(params: {
    portfolio: PortfolioSnapshot;
    marketRegime: MarketRegime;
    anomalies: string[];
  }): Promise<StructuredPortfolioExplanation> {
    const { portfolio, marketRegime, anomalies } = params;
    const health: StructuredPortfolioExplanation["portfolioHealth"] =
      anomalies.length > 0 || portfolio.pendingTxCount > 0
        ? "CAUTION"
        : portfolio.availableCapitalForAllocationPayment === 0n
          ? "CONSTRAINED"
          : "HEALTHY";

    const keyFacts = [
      `Market regime: ${marketRegime}${anomalies.length > 0 ? ` (${anomalies.length} anomaly flag(s))` : ""}`,
      `Committed capital: ${portfolio.totalCommittedCapitalPayment.toString()} payment units across ${portfolio.assetExposures.length} asset(s)`,
      `Available for allocation: ${portfolio.availableCapitalForAllocationPayment.toString()} payment units`,
      `Open positions: ${portfolio.openPositionsCount}, Active tickets: ${portfolio.activeTicketsCount}, Pending txs: ${portfolio.pendingTxCount}`,
    ];

    return {
      summary: `Portfolio is ${health} in a ${marketRegime} market with ${portfolio.availableCapitalForAllocationPayment.toString()} payment units available for allocation.`,
      marketRegime,
      portfolioHealth: health,
      keyFacts,
    };
  }

  async summarizeDecision(trace: AutonomousDecisionTrace): Promise<StructuredDecisionSummary> {
    return {
      cycleId: trace.cycleId,
      headline: `Cycle #${trace.cycleId}: ${trace.selectedAction} (${trace.snapshot.marketRegime})`,
      venueSummary: `${trace.venueSelection.selectedVenue} — ${trace.venueSelection.rationale}`,
      riskSummary: trace.riskReport.allowed
        ? "All deterministic risk checks passed"
        : `Blocked by ${trace.riskReport.failedChecks.map((c) => c.name).join(", ")}`,
      actionTaken: trace.selectedAction,
    };
  }

  async interpretEvaluation(summary: EvaluationMetricsSummary): Promise<EvaluationInterpretation> {
    const strengths: string[] = [];
    const concerns: string[] = [];
    const sampleSizeSufficient = summary.closedTradesCount >= 5;

    if (summary.venueSelectionAccuracyBps !== null && summary.venueSelectionAccuracyBps >= 8000) {
      strengths.push(
        `High cross-venue accuracy (${(summary.venueSelectionAccuracyBps / 100).toFixed(1)}%) with ${summary.totalExecutionCostImprovementPayment.toString()} payment units saved.`,
      );
    }
    if (summary.duplicateExecutionAttempts === 0 && summary.missedExecutionAttempts === 0) {
      strengths.push("Zero duplicate or missed execution attempts recorded.");
    }
    if (!sampleSizeSufficient) {
      concerns.push(
        `Insufficient closed trades (${summary.closedTradesCount} < 5) for statistically meaningful Sharpe or policy adaptation.`,
      );
    }
    if (summary.maxDrawdownBps > 500) {
      concerns.push(`Observed max drawdown of ${(summary.maxDrawdownBps / 100).toFixed(2)}% exceeds 5% watch threshold.`);
    }
    if (summary.riskLimitViolationsCount > 0) {
      concerns.push(`${summary.riskLimitViolationsCount} entry signal(s) were blocked by deterministic risk limits.`);
    }

    return {
      dataProvenance: summary.dataProvenance,
      headline: `[${summary.dataProvenance}] ${summary.totalDecisions} decisions evaluated; net P&L ${summary.netPnlAfterFeesPayment.toString()} payment units.`,
      strengths,
      concerns,
      sampleSizeSufficient,
    };
  }

  async proposeBoundedAdjustments(params: {
    evaluation: EvaluationMetricsSummary;
    currentStrategy: StrategyConfig;
    currentLimits: RiskLimits;
    bounds: PolicyValidationBounds;
  }): Promise<BoundedStrategyRecommendation> {
    const { evaluation, currentStrategy, bounds } = params;
    const proposed: AgentPolicyPatch = {};
    const reasons: string[] = [];

    if (evaluation.closedTradesCount < 5) {
      const validation = validatePolicyPatch(proposed, bounds);
      return {
        requiresExplicitApproval: true,
        autoApplied: false,
        rationale:
          "No strategy changes recommended: fewer than 5 closed trades observed; avoiding noisy policy drift.",
        proposedPatch: {},
        validation,
      };
    }

    if (evaluation.maxDrawdownBps > 500) {
      const tighterSl = Math.max(bounds.minStopLossBps, Math.round(currentStrategy.stopLossBps * 0.85));
      if (tighterSl < currentStrategy.stopLossBps) {
        proposed.stopLossBps = tighterSl;
        reasons.push(`Tighten stop-loss to ${tighterSl} bps following ${evaluation.maxDrawdownBps} bps drawdown`);
      }
    }

    if (evaluation.winRateBps < 4000 && evaluation.losses > evaluation.wins) {
      const tighterVol = Math.max(150, Math.round(currentStrategy.maxVolatilityBps * 0.85));
      proposed.maxVolatilityBps = tighterVol;
      reasons.push(`Lower maxVolatilityBps to ${tighterVol} bps due to sub-40% win rate`);
    }

    const validation = validatePolicyPatch(proposed, bounds);
    return {
      requiresExplicitApproval: true,
      autoApplied: false,
      rationale:
        reasons.length > 0
          ? `${reasons.join("; ")}. Requires explicit operator approval.`
          : "Current bounded parameters remain well-calibrated for observed performance.",
      proposedPatch: validation.sanitizedPatch,
      validation,
    };
  }
}
