import { useEffect, useState } from "react";
import { createPublicClient, erc20Abi, fallback, http, parseAbi } from "viem";
import { ACTIVE_NETWORK } from "@/config/networks";

const MANAGER_VIEW_ABI = parseAbi([
  "function protocolFeeBps() view returns (uint16)",
  "function nextOfferId() view returns (uint64)",
]);

const VAULT_VIEW_ABI = parseAbi([
  "function owner() view returns (address)",
  "function totalLpFree(address token) view returns (uint256)",
  "function totalOfferAvailable(address token) view returns (uint256)",
  "function totalReserved(address token) view returns (uint256)",
  "function totalPendingProceeds(address token) view returns (uint256)",
  "function protocolFees(address token) view returns (uint256)",
]);

export interface ProtocolTelemetry {
  loading: boolean;
  blockNumber: bigint | null;
  protocolFeeBps: number | null;
  offersCreated: number | null;
  timelockOwned: boolean | null;
  vaultSolvent: boolean | null;
}

const publicClient = createPublicClient({
  transport: fallback(ACTIVE_NETWORK.rpcUrls.map((url) => http(url, { timeout: 8_000 }))),
});

export function useProtocolTelemetry(): ProtocolTelemetry {
  const [data, setData] = useState<ProtocolTelemetry>({
    loading: true,
    blockNumber: null,
    protocolFeeBps: null,
    offersCreated: null,
    timelockOwned: null,
    vaultSolvent: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function fetchLive() {
      try {
        const { liquidityVault, commitmentManager, timelock, tUSDT } = ACTIVE_NETWORK.contracts;
        const [
          blockNumber,
          feeBps,
          nextOfferId,
          vaultOwner,
          usdtBal,
          free,
          avail,
          reserved,
          proceeds,
          fees,
        ] = await Promise.all([
          publicClient.getBlockNumber(),
          publicClient.readContract({
            address: commitmentManager,
            abi: MANAGER_VIEW_ABI,
            functionName: "protocolFeeBps",
          }),
          publicClient.readContract({
            address: commitmentManager,
            abi: MANAGER_VIEW_ABI,
            functionName: "nextOfferId",
          }),
          publicClient.readContract({
            address: liquidityVault,
            abi: VAULT_VIEW_ABI,
            functionName: "owner",
          }),
          publicClient.readContract({
            address: tUSDT,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [liquidityVault],
          }),
          publicClient.readContract({
            address: liquidityVault,
            abi: VAULT_VIEW_ABI,
            functionName: "totalLpFree",
            args: [tUSDT],
          }),
          publicClient.readContract({
            address: liquidityVault,
            abi: VAULT_VIEW_ABI,
            functionName: "totalOfferAvailable",
            args: [tUSDT],
          }),
          publicClient.readContract({
            address: liquidityVault,
            abi: VAULT_VIEW_ABI,
            functionName: "totalReserved",
            args: [tUSDT],
          }),
          publicClient.readContract({
            address: liquidityVault,
            abi: VAULT_VIEW_ABI,
            functionName: "totalPendingProceeds",
            args: [tUSDT],
          }),
          publicClient.readContract({
            address: liquidityVault,
            abi: VAULT_VIEW_ABI,
            functionName: "protocolFees",
            args: [tUSDT],
          }),
        ]);

        if (cancelled) return;
        const sumBuckets = free + avail + reserved + proceeds + fees;
        setData({
          loading: false,
          blockNumber,
          protocolFeeBps: Number(feeBps),
          offersCreated: Math.max(0, Number(nextOfferId) - 1),
          timelockOwned: vaultOwner.toLowerCase() === timelock.toLowerCase(),
          vaultSolvent: usdtBal >= sumBuckets,
        });
      } catch {
        if (!cancelled) {
          setData((prev) => ({ ...prev, loading: false }));
        }
      }
    }

    fetchLive();
    const interval = setInterval(fetchLive, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return data;
}
