import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Address } from "viem";
import { ACTIVE_NETWORK } from "@/config/networks";

export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  providers?: Eip1193Provider[];
  isMetaMask?: boolean;
  isZerion?: boolean;
  isRabby?: boolean;
  isCoinbaseWallet?: boolean;
  isPhantom?: boolean;
  isAvalanche?: boolean;
}

export interface DiscoveredWallet {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
  provider: Eip1193Provider;
}

export type UserRole = "agent" | "trader" | "lp";

interface WalletContextValue {
  wallets: DiscoveredWallet[];
  activeProvider: Eip1193Provider | null;
  hasInjectedFallback: boolean;
  address: Address | null;
  chainId: number | null;
  hskBalance: string | null;
  isConnected: boolean;
  isWrongNetwork: boolean;
  connecting: boolean;
  connectingWalletRdns: string | null;
  lastUsedWalletRdns: string | null;
  switching: boolean;
  error: string | null;
  selectedRole: UserRole | null;
  connect: (provider?: Eip1193Provider, walletRdns?: string) => Promise<boolean>;
  switchToActiveChain: () => Promise<boolean>;
  disconnect: () => void;
  setSelectedRole: (role: UserRole) => void;
  clearError: () => void;
}

const WalletContext = createContext<WalletContextValue | null>(null);

async function fetchNativeBalanceWei(addr: Address): Promise<bigint> {
  for (const url of ACTIVE_NETWORK.rpcUrls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8_000);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_getBalance",
            params: [addr, "latest"],
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) continue;
        const data = (await res.json()) as { result?: string };
        if (typeof data.result === "string") return BigInt(data.result);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // try next RPC fallback
    }
  }
  throw new Error("RPC balance read failed");
}

function formatWeiToEtherNumber(wei: bigint): number {
  const whole = wei / 10n ** 18n;
  const frac = wei % 10n ** 18n;
  return Number(whole) + Number(frac) / 1e18;
}

function getWindowWithWallets() {
  return window as unknown as {
    ethereum?: Eip1193Provider;
    zerionWallet?: Eip1193Provider;
  };
}

function isMissingChainError(err: unknown): boolean {
  const e = err as { code?: number; data?: { originalError?: { code?: number } }; message?: string };
  const code = e?.code ?? e?.data?.originalError?.code;
  if (code === 4902 || code === -32603) return true;
  const msg = (e?.message ?? "").toLowerCase();
  return (
    msg.includes("unrecognized chain") ||
    msg.includes("unknown chain") ||
    msg.includes("try adding the chain") ||
    msg.includes("not been added")
  );
}

async function ensureActiveChain(provider: Eip1193Provider): Promise<boolean> {
  const targetHex = `0x${ACTIVE_NETWORK.chainId.toString(16)}`;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: targetHex }],
    });
    return true;
  } catch (switchErr) {
    if (isMissingChainError(switchErr)) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: targetHex,
            chainName: ACTIVE_NETWORK.name,
            nativeCurrency: {
              name: "HashKey EcoPoints",
              symbol: "HSK",
              decimals: 18,
            },
            rpcUrls: [...ACTIVE_NETWORK.rpcUrls],
            blockExplorerUrls: [ACTIVE_NETWORK.explorerUrl],
          },
        ],
      });
      return true;
    }
    throw switchErr;
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [activeProvider, setActiveProvider] = useState<Eip1193Provider | null>(null);
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [hskBalance, setHskBalance] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectingWalletRdns, setConnectingWalletRdns] = useState<string | null>(null);
  const [lastUsedWalletRdns, setLastUsedWalletRdns] = useState<string | null>(() => {
    try {
      return localStorage.getItem("tranche-wallet-rdns");
    } catch {
      return null;
    }
  });
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRole, setSelectedRoleState] = useState<UserRole | null>(() => {
    const saved = localStorage.getItem("tranche-role");
    return saved === "agent" || saved === "trader" || saved === "lp" ? saved : null;
  });

  // Silent auto-reconnect for returning users (eth_accounts — never triggers a popup)
  useEffect(() => {
    if (address || localStorage.getItem("tranche-disconnected") === "1") return;
    const preferredRdns = lastUsedWalletRdns ?? localStorage.getItem("tranche-wallet-rdns");
    const win = getWindowWithWallets();

    // Build deduplicated priority list: saved wallet -> Zerion -> all EIP-6963 wallets -> window.ethereum
    const candidates: Array<{ provider: Eip1193Provider; rdns?: string }> = [];
    const seen = new Set<Eip1193Provider>();
    const pushUnique = (p?: Eip1193Provider, rdns?: string) => {
      if (p && !seen.has(p)) {
        seen.add(p);
        candidates.push({ provider: p, rdns });
      }
    };
    if (preferredRdns) {
      const preferred = wallets.find((w) => (w.rdns || w.uuid) === preferredRdns);
      pushUnique(preferred?.provider, preferred?.rdns || preferred?.uuid);
    }
    for (const w of wallets) pushUnique(w.provider, w.rdns || w.uuid);
    pushUnique(win.zerionWallet, "io.zerion.wallet");
    if (Array.isArray(win.ethereum?.providers)) {
      for (const p of win.ethereum.providers) pushUnique(p);
    }
    pushUnique(win.ethereum);

    if (candidates.length === 0) return;

    const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), ms);
        promise.then(
          (val) => {
            clearTimeout(timer);
            resolve(val);
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      });

    let cancelled = false;
    (async () => {
      for (const candidate of candidates) {
        if (cancelled) return;
        try {
          const accs = await withTimeout(
            candidate.provider.request({ method: "eth_accounts" }),
            3_500,
          );
          if (cancelled) return;
          const list = Array.isArray(accs) ? (accs as Address[]) : [];
          if (list.length === 0) continue;
          const hexChain = (await withTimeout(
            candidate.provider.request({ method: "eth_chainId" }),
            3_500,
          )) as string;
          if (cancelled) return;
          setActiveProvider(candidate.provider);
          setAddress(list[0]);
          setChainId(Number.parseInt(hexChain, 16));
          if (candidate.rdns) {
            localStorage.setItem("tranche-wallet-rdns", candidate.rdns);
            setLastUsedWalletRdns(candidate.rdns);
          }
          return;
        } catch {
          // try next wallet provider
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [wallets, address, lastUsedWalletRdns]);

  // EIP-6963 multi-wallet discovery + legacy window.ethereum.providers / window.zerionWallet fallback
  useEffect(() => {
    const map = new Map<string, DiscoveredWallet>();

    const syncList = () => {
      const win = getWindowWithWallets();
      const existingNames = new Set(Array.from(map.values()).map((w) => w.name.toLowerCase()));

      const legacyCandidates: Eip1193Provider[] = [];
      if (win.zerionWallet) legacyCandidates.push(win.zerionWallet);
      if (Array.isArray(win.ethereum?.providers)) {
        legacyCandidates.push(...win.ethereum.providers);
      } else if (win.ethereum) {
        legacyCandidates.push(win.ethereum);
      }

      for (const p of legacyCandidates) {
        if (p.isZerion && !existingNames.has("zerion")) {
          map.set("legacy-zerion", {
            uuid: "legacy-zerion",
            name: "Zerion",
            icon: "",
            rdns: "io.zerion.wallet",
            provider: p,
          });
          existingNames.add("zerion");
        } else if (
          p.isMetaMask &&
          !p.isZerion &&
          !p.isRabby &&
          !p.isPhantom &&
          !p.isAvalanche &&
          !existingNames.has("metamask")
        ) {
          map.set("legacy-metamask", {
            uuid: "legacy-metamask",
            name: "MetaMask",
            icon: "",
            rdns: "io.metamask",
            provider: p,
          });
          existingNames.add("metamask");
        } else if (p.isRabby && !existingNames.has("rabby wallet")) {
          map.set("legacy-rabby", {
            uuid: "legacy-rabby",
            name: "Rabby Wallet",
            icon: "",
            rdns: "io.rabby",
            provider: p,
          });
          existingNames.add("rabby wallet");
        }
      }

      setWallets(Array.from(map.values()));
    };

    const onAnnounce = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          info: { uuid: string; name: string; icon: string; rdns: string };
          provider: Eip1193Provider;
        }>
      ).detail;
      if (!detail?.info?.uuid || !detail.provider) return;
      map.set(detail.info.rdns || detail.info.uuid, {
        uuid: detail.info.uuid,
        name: detail.info.name,
        icon: detail.info.icon,
        rdns: detail.info.rdns,
        provider: detail.provider,
      });
      syncList();
    };

    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    syncList();

    // Catch extensions that inject asynchronously after initial load (e.g., Zerion, MetaMask)
    const t1 = setTimeout(() => {
      window.dispatchEvent(new Event("eip6963:requestProvider"));
      syncList();
    }, 300);
    const t2 = setTimeout(() => {
      window.dispatchEvent(new Event("eip6963:requestProvider"));
      syncList();
    }, 1000);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
    };
  }, []);

  const refreshBalance = useCallback(async (addr: Address) => {
    try {
      const wei = await fetchNativeBalanceWei(addr);
      const formatted = formatWeiToEtherNumber(wei);
      setHskBalance(formatted >= 1 ? formatted.toFixed(3) : formatted.toFixed(4));
    } catch {
      setHskBalance(null);
    }
  }, []);

  useEffect(() => {
    if (!address) {
      setHskBalance(null);
      return;
    }
    refreshBalance(address);
  }, [address, chainId, refreshBalance]);

  useEffect(() => {
    if (!activeProvider?.on) return;

    const handleAccounts = (accounts: unknown) => {
      const list = Array.isArray(accounts) ? (accounts as Address[]) : [];
      setAddress(list.length === 0 ? null : list[0]);
    };

    const handleChain = (hexChainId: unknown) => {
      if (typeof hexChainId === "string") {
        setChainId(Number.parseInt(hexChainId, 16));
      }
    };

    activeProvider.on("accountsChanged", handleAccounts);
    activeProvider.on("chainChanged", handleChain);
    return () => {
      activeProvider.removeListener?.("accountsChanged", handleAccounts);
      activeProvider.removeListener?.("chainChanged", handleChain);
    };
  }, [activeProvider]);

  const connect = useCallback(
    async (chosenProvider?: Eip1193Provider, explicitWalletRdns?: string): Promise<boolean> => {
      const provider = chosenProvider ?? getWindowWithWallets().ethereum;
      if (!provider) {
        setError("No browser wallet detected. Install MetaMask, Zerion, or Rabby to continue.");
        return false;
      }

      const matched = wallets.find((w) => w.provider === provider);
      const resolvedRdns = explicitWalletRdns ?? matched?.rdns ?? matched?.uuid ?? null;

      setError(null);
      setConnecting(true);
      setConnectingWalletRdns(resolvedRdns);
      try {
        const accounts = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
        if (!accounts || accounts.length === 0) {
          setError("Wallet connection returned no account.");
          return false;
        }
        const hexChain = (await provider.request({ method: "eth_chainId" })) as string;
        let currentChain = Number.parseInt(hexChain, 16);

        setActiveProvider(provider);
        setAddress(accounts[0]);
        setChainId(currentChain);
        localStorage.removeItem("tranche-disconnected");
        if (resolvedRdns) {
          localStorage.setItem("tranche-wallet-rdns", resolvedRdns);
          setLastUsedWalletRdns(resolvedRdns);
        }

        // Automatically switch to / add HashKey Chain right after connecting
        if (currentChain !== ACTIVE_NETWORK.chainId) {
          setSwitching(true);
          try {
            await ensureActiveChain(provider);
            currentChain = ACTIVE_NETWORK.chainId;
            setChainId(currentChain);
          } catch (chainErr) {
            const msg =
              chainErr instanceof Error
                ? chainErr.message
                : `Please approve adding ${ACTIVE_NETWORK.name} (Chain ${ACTIVE_NETWORK.chainId}).`;
            setError(msg);
          } finally {
            setSwitching(false);
          }
        }

        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Connection request was rejected.";
        setError(msg.includes("User rejected") ? "Connection request rejected in wallet." : msg);
        return false;
      } finally {
        setConnecting(false);
        setConnectingWalletRdns(null);
      }
    },
    [wallets],
  );

  const switchToActiveChain = useCallback(async (): Promise<boolean> => {
    const provider = activeProvider ?? getWindowWithWallets().ethereum;
    if (!provider) {
      setError("Wallet provider unavailable.");
      return false;
    }

    setError(null);
    setSwitching(true);
    try {
      await ensureActiveChain(provider);
      setChainId(ACTIVE_NETWORK.chainId);
      return true;
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : `Failed to switch to ${ACTIVE_NETWORK.name}.`;
      setError(msg);
      return false;
    } finally {
      setSwitching(false);
    }
  }, [activeProvider]);

  const disconnect = useCallback(() => {
    localStorage.setItem("tranche-disconnected", "1");
    setAddress(null);
    setChainId(null);
    setHskBalance(null);
    setActiveProvider(null);
    setError(null);
  }, []);

  const setSelectedRole = useCallback((role: UserRole) => {
    localStorage.setItem("tranche-role", role);
    setSelectedRoleState(role);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const sortedWallets = useMemo(() => {
    if (!lastUsedWalletRdns) return wallets;
    return [...wallets].sort((a, b) => {
      const aLast = (a.rdns || a.uuid) === lastUsedWalletRdns ? 0 : 1;
      const bLast = (b.rdns || b.uuid) === lastUsedWalletRdns ? 0 : 1;
      return aLast - bLast;
    });
  }, [wallets, lastUsedWalletRdns]);

  const value = useMemo<WalletContextValue>(
    () => ({
      wallets: sortedWallets,
      activeProvider,
      hasInjectedFallback: Boolean(getWindowWithWallets().ethereum),
      address,
      chainId,
      hskBalance,
      isConnected: Boolean(address),
      isWrongNetwork: Boolean(address && chainId !== null && chainId !== ACTIVE_NETWORK.chainId),
      connecting,
      connectingWalletRdns,
      lastUsedWalletRdns,
      switching,
      error,
      selectedRole,
      connect,
      switchToActiveChain,
      disconnect,
      setSelectedRole,
      clearError,
    }),
    [
      sortedWallets,
      activeProvider,
      address,
      chainId,
      hskBalance,
      connecting,
      connectingWalletRdns,
      lastUsedWalletRdns,
      switching,
      error,
      selectedRole,
      connect,
      switchToActiveChain,
      disconnect,
      setSelectedRole,
      clearError,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}
