import { formatUnits, parseUnits, type Address } from "viem";
import { ACTIVE_NETWORK, type NetworkConfig } from "@/config/networks";

export interface TokenMeta {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
}

export function getNetworkTokens(network: NetworkConfig): Record<string, TokenMeta> {
  const isTestnet = network.key === "testnet";
  return {
    [network.contracts.WETH.toLowerCase()]: {
      address: network.contracts.WETH,
      symbol: isTestnet ? "tWETH" : "WETH",
      name: isTestnet ? "Testnet Wrapped Ether" : "Wrapped Ether",
      decimals: 18,
    },
    [network.contracts.WHSK.toLowerCase()]: {
      address: network.contracts.WHSK,
      symbol: "WHSK",
      name: "Wrapped HSK",
      decimals: 18,
    },
    [network.contracts.WBTC.toLowerCase()]: {
      address: network.contracts.WBTC,
      symbol: isTestnet ? "tWBTC" : "WBTC",
      name: isTestnet ? "Testnet Wrapped Bitcoin" : "Wrapped Bitcoin",
      decimals: 8,
    },
    [network.contracts.USDT.toLowerCase()]: {
      address: network.contracts.USDT,
      symbol: isTestnet ? "tUSDT" : "USDT",
      name: isTestnet ? "Testnet Tether USD" : "Tether USD",
      decimals: 6,
    },
  };
}

export const TOKENS: Record<string, TokenMeta> = getNetworkTokens(ACTIVE_NETWORK);

export const TOKEN_LIST: TokenMeta[] = Object.values(TOKENS);

export function getTokenMeta(
  address: string,
  tokensMap: Record<string, TokenMeta> = TOKENS,
): TokenMeta {
  const found = tokensMap[address.toLowerCase()];
  if (found) return found;
  return {
    address: address as Address,
    symbol: `${address.slice(0, 6)}…`,
    name: "ERC-20 Token",
    decimals: 18,
  };
}

export function formatTokenAmount(raw: bigint, decimals: number, maxFrac = 4): string {
  const num = Number(formatUnits(raw, decimals));
  if (!Number.isFinite(num)) return formatUnits(raw, decimals);
  if (num === 0) return "0";
  if (num < 0.0001) return "<0.0001";
  return num.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFrac,
  });
}

/**
 * Converts a 1e36-scaled priceX36 (raw payment units per raw inventory unit * 1e36)
 * into human payment-token units per 1 whole inventory token.
 */
export function formatPriceX36(
  priceX36: bigint,
  invDecimals: number,
  payDecimals: number,
): string {
  // humanPrice = (priceX36 * 10^invDecimals) / (10^36 * 10^payDecimals)
  const scaled = Number(priceX36) / 1e36;
  const human = scaled * 10 ** (invDecimals - payDecimals);
  if (!Number.isFinite(human) || human <= 0) return "—";
  if (human >= 100) {
    return human.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return human.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(seconds % 3600 === 0 ? 0 : 1)}h`;
  return `${(seconds / 86400).toFixed(seconds % 86400 === 0 ? 0 : 1)}d`;
}

/**
 * Exact BigInt conversion from human payment-per-inventory price (e.g. "3000")
 * into 1e36-scaled priceX36 matching Solidity CommitmentManager scaling.
 */
export function parseHumanPriceToX36(
  humanPrice: string,
  invDecimals: number,
  payDecimals: number,
): bigint {
  const p18 = parseUnits(humanPrice, 18);
  const exp = 18 + payDecimals - invDecimals;
  if (exp >= 0) {
    return p18 * 10n ** BigInt(exp);
  }
  return p18 / 10n ** BigInt(-exp);
}
