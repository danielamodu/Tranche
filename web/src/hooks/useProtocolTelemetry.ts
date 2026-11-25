import { useEffect, useState } from "react";
import { erc20Abi, parseAbi } from "viem";
import { ACTIVE_NETWORK } from "@/config/networks";
import { chunkedMulticall, tranchePublicClient } from "@/lib/protocol";

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
    if (!ACTIVE_NETWORK.isLive) {
      setData((prev) => ({ ...prev, loading: false }));
      return;
    }

    let cancelled = false;

    async function fetchLive() {
      try {
        const { liquidityVault, commitmentManager, timelock, USDT } = ACTIVE_NETWORK.contracts;
        const [blockNumber, mc] = await Promise.all([
          tranchePublicClient.getBlockNumber(),
          chunkedMulticall(tranchePublicClient, [
            { address: commitmentManager, abi: MANAGER_VIEW_ABI, functionName: "protocolFeeBps" },
            { address: commitmentManager, abi: MANAGER_VIEW_ABI, functionName: "nextOfferId" },
            { address: liquidityVault, abi: VAULT_VIEW_ABI, functionName: "owner" },
            { address: USDT, abi: erc20Abi, functionName: "balanceOf", args: [liquidityVault] },
            { address: liquidityVault, abi: VAULT_VIEW_ABI, functionName: "totalLpFree", args: [USDT] },
            {
              address: liquidityVault,
              abi: VAULT_VIEW_ABI,
              functionName: "totalOfferAvailable",
              args: [USDT],
            },
            { address: liquidityVault, abi: VAULT_VIEW_ABI, functionName: "totalReserved", args: [USDT] },
            {
              address: liquidityVault,
              abi: VAULT_VIEW_ABI,
              functionName: "totalPendingProceeds",
              args: [USDT],
            },
            { address: liquidityVault, abi: VAULT_VIEW_ABI, functionName: "protocolFees", args: [USDT] },
          ]),
        ]);

        if (cancelled) return;

        const feeBps = mc[0]?.status === "success" ? Number(mc[0].result) : null;
        const nextOfferId = mc[1]?.status === "success" ? Number(mc[1].result) : null;
        const vaultOwner = mc[2]?.status === "success" ? String(mc[2].result) : null;
        const allSolvencyOk = [mc[3], mc[4], mc[5], mc[6], mc[7], mc[8]].every(
          (r) => r?.status === "success" && typeof r.result === "bigint",
        );

        let vaultSolvent: boolean | null = null;
        if (allSolvencyOk) {
          const usdtBal = mc[3].result as bigint;
          const sumBuckets =
            (mc[4].result as bigint) +
            (mc[5].result as bigint) +
            (mc[6].result as bigint) +
            (mc[7].result as bigint) +
            (mc[8].result as bigint);
          vaultSolvent = usdtBal >= sumBuckets;
        }

        setData({
          loading: false,
          blockNumber,
          protocolFeeBps: feeBps,
          offersCreated: nextOfferId !== null ? Math.max(0, nextOfferId - 1) : null,
          timelockOwned: vaultOwner !== null ? vaultOwner.toLowerCase() === timelock.toLowerCase() : null,
          vaultSolvent,
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
