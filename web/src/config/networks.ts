import testnetManifest from "./hashkey-testnet.json";

export type NetworkKey = "testnet" | "mainnet";

export interface NetworkConfig {
  key: NetworkKey;
  name: string;
  shortName: string;
  chainId: number;
  rpcUrls: readonly string[];
  explorerUrl: string;
  isLive: boolean;
  contracts: {
    liquidityVault: `0x${string}`;
    commitmentManager: `0x${string}`;
    executionTicket: `0x${string}`;
    executionRouter: `0x${string}`;
    signedPullOracle: `0x${string}`;
    oraclePriceAdapter: `0x${string}`;
    uniswapV3TwapOracle: `0x${string}`;
    hspComplianceHook: `0x${string}`;
    timelock: `0x${string}`;
    govSafe: `0x${string}`;
    guardianSafe: `0x${string}`;
    treasurySafe: `0x${string}`;
    tUSDT: `0x${string}`;
    tWBTC: `0x${string}`;
    tWETH: `0x${string}`;
    WHSK: `0x${string}`;
  };
}

export const NETWORKS: Record<NetworkKey, NetworkConfig> = {
  testnet: {
    key: "testnet",
    name: testnetManifest.network.name,
    shortName: "HashKey Testnet",
    chainId: testnetManifest.network.chainId,
    rpcUrls: testnetManifest.network.rpcUrls,
    explorerUrl: testnetManifest.network.explorerUrl,
    isLive: testnetManifest.deploymentStatus === "LIVE_DEPLOYED",
    contracts: {
      liquidityVault: testnetManifest.contracts.liquidityVault as `0x${string}`,
      commitmentManager: testnetManifest.contracts.commitmentManager as `0x${string}`,
      executionTicket: testnetManifest.contracts.executionTicket as `0x${string}`,
      executionRouter: testnetManifest.contracts.executionRouter as `0x${string}`,
      signedPullOracle: testnetManifest.contracts.signedPullOracle as `0x${string}`,
      oraclePriceAdapter: testnetManifest.contracts.oraclePriceAdapter as `0x${string}`,
      uniswapV3TwapOracle: testnetManifest.contracts.uniswapV3TwapOracle as `0x${string}`,
      hspComplianceHook: testnetManifest.contracts.hspComplianceHook as `0x${string}`,
      timelock: testnetManifest.contracts.timelock as `0x${string}`,
      govSafe: testnetManifest.contracts.govSafe as `0x${string}`,
      guardianSafe: testnetManifest.contracts.guardianSafe as `0x${string}`,
      treasurySafe: testnetManifest.contracts.treasurySafe as `0x${string}`,
      tUSDT: testnetManifest.contracts.tUSDT as `0x${string}`,
      tWBTC: testnetManifest.contracts.tWBTC as `0x${string}`,
      tWETH: testnetManifest.contracts.tWETH as `0x${string}`,
      WHSK: testnetManifest.canonicalInfrastructure.WHSK.address as `0x${string}`,
    },
  },
  // Mainnet drop-in slot: populate addresses when Chain 177 deploys — zero UI code changes.
  mainnet: {
    key: "mainnet",
    name: "HashKey Chain Mainnet",
    shortName: "HashKey Mainnet",
    chainId: 177,
    rpcUrls: ["https://mainnet.hsk.xyz"],
    explorerUrl: "https://explorer.hsk.xyz",
    isLive: false,
    contracts: {
      liquidityVault: "0x0000000000000000000000000000000000000000",
      commitmentManager: "0x0000000000000000000000000000000000000000",
      executionTicket: "0x0000000000000000000000000000000000000000",
      executionRouter: "0x0000000000000000000000000000000000000000",
      signedPullOracle: "0x0000000000000000000000000000000000000000",
      oraclePriceAdapter: "0x0000000000000000000000000000000000000000",
      uniswapV3TwapOracle: "0x0000000000000000000000000000000000000000",
      hspComplianceHook: "0x0000000000000000000000000000000000000000",
      timelock: "0x0000000000000000000000000000000000000000",
      govSafe: "0x0000000000000000000000000000000000000000",
      guardianSafe: "0x0000000000000000000000000000000000000000",
      treasurySafe: "0x0000000000000000000000000000000000000000",
      tUSDT: "0x0000000000000000000000000000000000000000",
      tWBTC: "0x0000000000000000000000000000000000000000",
      tWETH: "0x0000000000000000000000000000000000000000",
      WHSK: "0x4200000000000000000000000000000000000006",
    },
  },
};

export const ACTIVE_NETWORK_KEY: NetworkKey =
  import.meta.env.VITE_NETWORK === "mainnet" ? "mainnet" : "testnet";

export const ACTIVE_NETWORK: NetworkConfig = NETWORKS[ACTIVE_NETWORK_KEY];

export function explorerAddressUrl(address: string, net: NetworkConfig = ACTIVE_NETWORK): string {
  return `${net.explorerUrl}/address/${address}`;
}

export function explorerTxUrl(hash: string, net: NetworkConfig = ACTIVE_NETWORK): string {
  return `${net.explorerUrl}/tx/${hash}`;
}

// Verified live Chain-133 lifecycle proof tx (Ticket #1 exercise)
export const LIVE_EXERCISE_PROOF_TX =
  "0x8f98a0f76772f0ec65b4da5c1621dbf22f15454433eac3902e212327e2d78e69";
