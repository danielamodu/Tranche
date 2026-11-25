import testnetManifest from "./hashkey-testnet.json";

export type NetworkKey = "testnet" | "mainnet";

export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export interface NetworkConfig {
  key: NetworkKey;
  name: string;
  shortName: string;
  chainId: number;
  rpcUrls: readonly string[];
  explorerUrl: string;
  isLive: boolean;
  multicall3: `0x${string}`;
  liveExerciseProofTx: `0x${string}` | null;
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
    USDT: `0x${string}`;
    WBTC: `0x${string}`;
    WETH: `0x${string}`;
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
    multicall3: MULTICALL3_ADDRESS,
    liveExerciseProofTx: "0x8f98a0f76772f0ec65b4da5c1621dbf22f15454433eac3902e212327e2d78e69",
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
      USDT: testnetManifest.contracts.tUSDT as `0x${string}`,
      WBTC: testnetManifest.contracts.tWBTC as `0x${string}`,
      WETH: testnetManifest.contracts.tWETH as `0x${string}`,
      WHSK: testnetManifest.canonicalInfrastructure.WHSK.address as `0x${string}`,
    },
  },
  // Mainnet slot prepared with verified Chain 177 canonical tokens; protocol contracts remain unset until deployed.
  mainnet: {
    key: "mainnet",
    name: "HashKey Chain Mainnet",
    shortName: "HashKey Mainnet",
    chainId: 177,
    rpcUrls: ["https://mainnet.hsk.xyz"],
    explorerUrl: "https://explorer.hsk.xyz",
    isLive: false,
    multicall3: MULTICALL3_ADDRESS,
    liveExerciseProofTx: null,
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
      USDT: "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029",
      WBTC: "0x6119CA49a79f5825C8B345F8d7aC36B272565b14",
      WETH: "0xefd4bC9afD210517803f293ABABd701CaeeCdfd0",
      WHSK: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1",
    },
  },
};

const envNetwork =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_NETWORK;

export const ACTIVE_NETWORK_KEY: NetworkKey = envNetwork === "mainnet" ? "mainnet" : "testnet";

export const ACTIVE_NETWORK: NetworkConfig = NETWORKS[ACTIVE_NETWORK_KEY];

export function explorerAddressUrl(address: string, net: NetworkConfig = ACTIVE_NETWORK): string {
  return `${net.explorerUrl}/address/${address}`;
}

export function explorerTxUrl(hash: string, net: NetworkConfig = ACTIVE_NETWORK): string {
  return `${net.explorerUrl}/tx/${hash}`;
}
