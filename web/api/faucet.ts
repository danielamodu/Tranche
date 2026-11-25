import { createPublicClient, createWalletClient, http, isAddress, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const MINT_ABI = parseAbi(["function mint(address to, uint256 amount)"]);

// Testnet Chain-133 token addresses (strictly testnet-only)
const CHAIN_133_RPC = "https://testnet.hsk.xyz";
const TWETH_ADDRESS = "0xaEa87306DD503B1a05251B6C5Aca8c4794A710Ba" as const;
const TUSDT_ADDRESS = "0x7099a4B3a9Cb07e675746C7c0EB3360b932B8F27" as const;

const cooldownMap = new Map<string, number>();
const COOLDOWN_MS = 10 * 60 * 1000;

interface ApiRequest {
  method?: string;
  body?: { address?: string };
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (payload: unknown) => void;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (process.env.VITE_NETWORK === "mainnet") {
    return res.status(403).json({ ok: false, error: "Faucet disabled on mainnet" });
  }

  const pk = process.env.TESTNET_FAUCET_PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk || !pk.startsWith("0x")) {
    return res.status(503).json({
      ok: false,
      error: "Testnet faucet signer not configured on this deployment.",
    });
  }

  const address = req.body?.address;
  if (!address || !isAddress(address)) {
    return res.status(400).json({ ok: false, error: "Valid 0x wallet address required." });
  }

  const key = address.toLowerCase();
  const lastClaim = cooldownMap.get(key) ?? 0;
  if (Date.now() - lastClaim < COOLDOWN_MS) {
    const minsLeft = Math.ceil((COOLDOWN_MS - (Date.now() - lastClaim)) / 60_000);
    return res.status(429).json({
      ok: false,
      error: `Already claimed recently. Try again in ${minsLeft}m.`,
    });
  }

  try {
    const account = privateKeyToAccount(pk);
    const transport = http(CHAIN_133_RPC, { timeout: 15_000 });
    const publicClient = createPublicClient({ transport });
    const walletClient = createWalletClient({ account, transport });

    // Mint 1,000 tUSDT (6 dec) + 0.5 tWETH (18 dec)
    const usdtTx = await walletClient.writeContract({
      account,
      chain: null,
      address: TUSDT_ADDRESS,
      abi: MINT_ABI,
      functionName: "mint",
      args: [address, 1_000_000_000n],
    });
    await publicClient.waitForTransactionReceipt({ hash: usdtTx });

    const wethTx = await walletClient.writeContract({
      account,
      chain: null,
      address: TWETH_ADDRESS,
      abi: MINT_ABI,
      functionName: "mint",
      args: [address, 500_000_000_000_000_000n],
    });
    await publicClient.waitForTransactionReceipt({ hash: wethTx });

    cooldownMap.set(key, Date.now());
    return res.status(200).json({
      ok: true,
      minted: { tUSDT: "1,000", tWETH: "0.5" },
      usdtTx,
      wethTx,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Faucet mint failed";
    return res.status(500).json({ ok: false, error: msg.slice(0, 140) });
  }
}
