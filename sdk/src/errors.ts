import { BaseError, decodeErrorResult, type Abi, type Hex } from "viem";
import { ABIS, STANDARD_TOKEN_ERRORS_ABI } from "./abis.js";
import type { DecodedTrancheError } from "./types.js";

interface ContractAbiEntry {
  name: string;
  abi: Abi;
}

const CONTRACT_ABI_REGISTRY: readonly ContractAbiEntry[] = [
  { name: "CommitmentManager", abi: ABIS.CommitmentManager },
  { name: "LiquidityVault", abi: ABIS.LiquidityVault },
  { name: "ExecutionTicket", abi: ABIS.ExecutionTicket },
  { name: "ExecutionRouter", abi: ABIS.ExecutionRouter },
  { name: "OraclePriceAdapter", abi: ABIS.OraclePriceAdapter },
  { name: "SignedPullOracle", abi: ABIS.SignedPullOracle },
  { name: "HSPComplianceHook", abi: ABIS.HSPComplianceHook },
  { name: "V3PositionSegregator", abi: ABIS.V3PositionSegregator },
  { name: "ERC20/ERC721", abi: STANDARD_TOKEN_ERRORS_ABI },
];

function extractRawRevertData(err: unknown): Hex | undefined {
  const visited = new Set<unknown>();
  let current: unknown = err;

  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const obj = current as Record<string, unknown>;

    if (typeof obj.raw === "string" && obj.raw.startsWith("0x") && obj.raw.length >= 10) {
      return obj.raw as Hex;
    }

    if (typeof obj.data === "string" && obj.data.startsWith("0x") && obj.data.length >= 10) {
      return obj.data as Hex;
    }

    if (obj.data && typeof obj.data === "object") {
      const nestedData = (obj.data as Record<string, unknown>).data;
      if (typeof nestedData === "string" && nestedData.startsWith("0x") && nestedData.length >= 10) {
        return nestedData as Hex;
      }
    }

    current = obj.cause;
  }

  // Fallback: extract embedded hex revert payload from Anvil / RPC error messages
  const rawMsg =
    err instanceof Error
      ? `${err.message} ${(err as { details?: string }).details ?? ""}`
      : String(err);
  const match = rawMsg.match(/\b(0x[0-9a-fA-F]{8,})\b/);
  if (match) {
    return match[1] as Hex;
  }

  return undefined;
}

function extractAlreadyDecoded(err: unknown): { errorName: string; args?: readonly unknown[] } | undefined {
  if (err instanceof BaseError) {
    let found: { errorName: string; args?: readonly unknown[] } | undefined;
    err.walk((node) => {
      const record = node as unknown as Record<string, unknown>;
      if (
        record.name === "ContractFunctionRevertedError" &&
        record.data &&
        typeof record.data === "object"
      ) {
        const data = record.data as { errorName?: unknown; args?: unknown };
        if (typeof data.errorName === "string") {
          found = {
            errorName: data.errorName,
            args: Array.isArray(data.args) ? data.args : undefined,
          };
          return true;
        }
      }
      return false;
    });
    if (found) return found;
  }
  return undefined;
}

function inferTargetContractName(err: unknown): string | undefined {
  const visited = new Set<unknown>();
  let current: unknown = err;

  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const obj = current as Record<string, unknown>;
    const fn = typeof obj.functionName === "string" ? obj.functionName : undefined;
    if (fn) {
      if (fn === "batchExercise") return "ExecutionRouter";
      if (fn === "updatePrice" || fn === "setAuthorizedSigner") return "SignedPullOracle";
      if (fn === "setPairConfig") return "OraclePriceAdapter";
      if (
        fn === "deposit" ||
        fn === "depositFor" ||
        fn === "withdrawFree" ||
        fn === "claimProceeds" ||
        fn === "withdrawProtocolFees"
      ) {
        return "LiquidityVault";
      }
      if (
        fn === "transferFrom" ||
        fn === "safeTransferFrom" ||
        fn === "approve" ||
        fn === "setApprovalForAll" ||
        fn === "permit"
      ) {
        return "ExecutionTicket";
      }
      if (
        fn === "createOffer" ||
        fn === "topUpOffer" ||
        fn === "decreaseOffer" ||
        fn === "pauseOffer" ||
        fn === "unpauseOffer" ||
        fn === "cancelOffer" ||
        fn === "reserve" ||
        fn === "exercise" ||
        fn === "splitTicket" ||
        fn === "reclaimExpired" ||
        fn === "reclaimExpiredBatch" ||
        fn === "quoteReservation" ||
        fn === "quoteExercise"
      ) {
        return "CommitmentManager";
      }
    }
    current = obj.cause;
  }
  return undefined;
}

/**
 * Decodes custom Solidity errors across all Tranche contracts plus standard
 * ERC-20 / ERC-721 / OpenZeppelin errors from a viem or RPC error.
 */
export function decodeTrancheError(err: unknown): DecodedTrancheError {
  const rawMessage =
    err instanceof BaseError
      ? err.shortMessage || err.message
      : err instanceof Error
        ? err.message
        : String(err);

  const hintedContract = inferTargetContractName(err);
  const orderedEntries = hintedContract
    ? [
        ...CONTRACT_ABI_REGISTRY.filter((entry) => entry.name === hintedContract),
        ...CONTRACT_ABI_REGISTRY.filter((entry) => entry.name !== hintedContract),
      ]
    : CONTRACT_ABI_REGISTRY;

  const rawData = extractRawRevertData(err);
  if (rawData) {
    for (const entry of orderedEntries) {
      try {
        const decoded = decodeErrorResult({
          abi: entry.abi,
          data: rawData,
        });
        return {
          contract:
            decoded.errorName === "Error" || decoded.errorName === "Panic"
              ? hintedContract ?? entry.name
              : entry.name,
          errorName: decoded.errorName,
          args: decoded.args ? [...decoded.args] : undefined,
          rawMessage,
        };
      } catch {
        // Selector did not match this ABI; try next contract ABI.
      }
    }
  }

  const alreadyDecoded = extractAlreadyDecoded(err);
  if (alreadyDecoded) {
    return {
      contract: hintedContract ?? "Unknown",
      errorName: alreadyDecoded.errorName,
      args: alreadyDecoded.args,
      rawMessage,
    };
  }

  return {
    contract: hintedContract ?? "Unknown",
    errorName: "UnknownError",
    args: undefined,
    rawMessage,
  };
}
