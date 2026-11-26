import { parseAbi, type Address, type PublicClient } from "viem";
import { PRICE_SCALE, ceilDiv } from "./hskswap.js";
import type { OracleReader, OracleReading } from "./market.js";
import type { AgentExecutionMode } from "./runtime.js";

export type AgentDataSourceMode = "fixture" | "dry_run" | "fork" | "chain177_read_only";

export const CANONICAL_CHAIN_177_TOKENS = {
  WHSK: { address: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1" as Address, decimals: 18, symbol: "WHSK" },
  USDT: { address: "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029" as Address, decimals: 6, symbol: "USDT" },
  WETH: { address: "0xefd4bC9afD210517803f293ABABd701CaeeCdfd0" as Address, decimals: 18, symbol: "WETH" },
  WBTC: { address: "0x6119CA49a79f5825C8B345F8d7aC36B272565b14" as Address, decimals: 8, symbol: "WBTC" },
} as const;

export const MAINNET_READONLY_RPC_URL = "https://mainnet.hsk.xyz";

export const PRICE_ORACLE_ABI = parseAbi([
  "function getPriceX36(address inventoryToken, address paymentToken) view returns ((uint256 priceX36, uint256 updatedAt, bool isValid))",
]);

export function isLocalRpcUrl(rpcUrl: string): boolean {
  try {
    const parsed = new URL(rpcUrl);
    return (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}

export interface RuntimeSafetyCheckParams {
  dataSource: AgentDataSourceMode;
  executionMode: AgentExecutionMode;
  rpcUrl?: string;
  chainId?: number;
}

/**
 * Fail-closed RPC & Chain ID safety guard.
 * Guarantees that no configuration mistake can silently enable live mainnet execution.
 */
export function validateRuntimeSafety(params: RuntimeSafetyCheckParams): void {
  const { dataSource, executionMode, rpcUrl, chainId } = params;

  if (dataSource === "fixture") {
    if (executionMode !== "dry_run" && executionMode !== "read_only") {
      throw new Error("SAFETY_BLOCKED: fixture data source must run in dry_run or read_only mode");
    }
    return;
  }

  if (!rpcUrl) {
    throw new Error(`SAFETY_BLOCKED: rpcUrl is required for dataSource=${dataSource}`);
  }

  if (dataSource === "chain177_read_only") {
    if (executionMode !== "read_only") {
      throw new Error("SAFETY_BLOCKED: chain177_read_only data source strictly requires read_only executionMode");
    }
    if (chainId !== undefined && chainId !== 177) {
      throw new Error(`SAFETY_BLOCKED: chain177_read_only strictly requires Chain 177 (got ${chainId})`);
    }
    return;
  }

  if (dataSource === "dry_run") {
    if (executionMode !== "dry_run" && executionMode !== "read_only") {
      throw new Error("SAFETY_BLOCKED: dry_run data source cannot enable live execution");
    }
    if (chainId !== undefined && chainId !== 177 && chainId !== 133 && chainId !== 31337) {
      throw new Error(`SAFETY_BLOCKED: unsupported chainId ${chainId} for dry_run mode`);
    }
    return;
  }

  // dataSource === "fork"
  if (!isLocalRpcUrl(rpcUrl)) {
    throw new Error(
      `MAINNET_EXECUTION_BLOCKED: fork mode strictly requires a localhost Anvil RPC (got ${rpcUrl})`,
    );
  }
  if (chainId !== undefined && chainId !== 177 && chainId !== 31337) {
    throw new Error(`SAFETY_BLOCKED: fork mode expects Chain 177 or 31337 (got ${chainId})`);
  }
}

/**
 * Real on-chain IPriceOracle adapter (works with OraclePriceAdapter or UniswapV3TwapOracle).
 */
export class OnChainOracleReader implements OracleReader {
  private readonly publicClient: PublicClient;
  private readonly oracleAddress: Address;

  constructor(publicClient: PublicClient, oracleAddress: Address) {
    this.publicClient = publicClient;
    this.oracleAddress = oracleAddress;
  }

  async getPriceX36(inventoryToken: Address, paymentToken: Address): Promise<OracleReading> {
    const res = await this.publicClient.readContract({
      address: this.oracleAddress,
      abi: PRICE_ORACLE_ABI,
      functionName: "getPriceX36",
      args: [inventoryToken, paymentToken],
    });
    return {
      priceX36: res.priceX36,
      updatedAt: Number(res.updatedAt),
      isValid: res.isValid,
    };
  }
}

/**
 * Converts estimated gas units into payment-token (e.g. USDT 6-dec) units using
 * live RPC gasPrice (wei of HSK) and live WHSK/payment spotPriceX36.
 */
export async function estimateGasCostInPaymentUnits(params: {
  publicClient: PublicClient;
  gasUnits: bigint;
  whskToPaymentPriceX36: bigint;
}): Promise<bigint> {
  if (params.gasUnits === 0n || params.whskToPaymentPriceX36 === 0n) return 0n;
  const gasPriceWei = await params.publicClient.getGasPrice();
  const costHskWei = params.gasUnits * gasPriceWei;
  return ceilDiv(costHskWei * params.whskToPaymentPriceX36, PRICE_SCALE);
}
