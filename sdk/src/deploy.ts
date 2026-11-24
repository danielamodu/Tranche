import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  maxUint256,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ABIS, BYTECODES } from "./abis.js";
import { TrancheClient } from "./client.js";
import type { LocalTestAccount, TrancheDeployment } from "./types.js";

export const ANVIL_PRIVATE_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
] as const satisfies readonly Hex[];

export interface DeployLocalOptions {
  protocolFeeBps?: number;
  minTicketAmount?: bigint;
  maxStaleness?: number;
  maxDeviationBps?: number;
  initialPriceX36?: bigint;
  hardMinPriceX36?: bigint;
  hardMaxPriceX36?: bigint;
}

async function deployContract(
  publicClient: PublicClient,
  walletClient: WalletClient,
  abi: Abi,
  bytecode: Hex,
  args: readonly unknown[] = [],
): Promise<Address> {
  if (!walletClient.account) {
    throw new Error("deployContract requires walletClient with an active account.");
  }
  const hash = await walletClient.deployContract({
    account: walletClient.account,
    chain: walletClient.chain,
    abi,
    bytecode,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`Contract deployment failed for tx ${hash}`);
  }
  return receipt.contractAddress;
}

async function sendAndConfirm(
  publicClient: PublicClient,
  walletClient: WalletClient,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<void> {
  if (!walletClient.account) {
    throw new Error("sendAndConfirm requires walletClient with an active account.");
  }
  const hash = await walletClient.writeContract({
    account: walletClient.account,
    chain: walletClient.chain,
    address,
    abi,
    functionName,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`Transaction ${functionName} failed: ${hash}`);
  }
}

/**
 * Deploys the full Tranche protocol stack + mock tokens onto a local Anvil RPC,
 * configures oracle pair bounds and initial price, and mints & approves test tokens
 * for Anvil accounts #0 (admin/oracleSigner), #1 (lp), #2 (trader1), #3 (trader2), #4 (keeper).
 */
export async function deployLocalTrancheStack(
  rpcUrl: string,
  options: DeployLocalOptions = {},
): Promise<TrancheDeployment> {
  const probeClient = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await probeClient.getChainId();

  const localChain = defineChain({
    id: chainId,
    name: "Anvil Local",
    nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
    rpcUrls: {
      default: { http: [rpcUrl] },
    },
  });

  const publicClient = createPublicClient({
    chain: localChain,
    transport: http(rpcUrl),
  });

  const makeAccount = (
    index: number,
    role: LocalTestAccount["role"],
    privateKey: Hex,
  ): LocalTestAccount => {
    const account = privateKeyToAccount(privateKey);
    const walletClient = createWalletClient({
      account,
      chain: localChain,
      transport: http(rpcUrl),
    });
    return {
      index,
      role,
      address: account.address,
      privateKey,
      walletClient,
    };
  };

  const admin = makeAccount(0, "admin", ANVIL_PRIVATE_KEYS[0]);
  const lp = makeAccount(1, "lp", ANVIL_PRIVATE_KEYS[1]);
  const trader1 = makeAccount(2, "trader1", ANVIL_PRIVATE_KEYS[2]);
  const trader2 = makeAccount(3, "trader2", ANVIL_PRIVATE_KEYS[3]);
  const keeper = makeAccount(4, "keeper", ANVIL_PRIVATE_KEYS[4]);

  const protocolFeeBps = options.protocolFeeBps ?? 5;
  const minTicketAmount = options.minTicketAmount ?? 100n * 10n ** 18n;
  const maxStaleness = options.maxStaleness ?? 30;
  const maxDeviationBps = options.maxDeviationBps ?? 500;
  const initialPriceX36 = options.initialPriceX36 ?? 8n * 10n ** 22n; // 1 WHSK = 0.08 USDT
  const hardMinPriceX36 = options.hardMinPriceX36 ?? 10n ** 18n;
  const hardMaxPriceX36 = options.hardMaxPriceX36 ?? 10n ** 27n;

  const whsk = await deployContract(publicClient, admin.walletClient, ABIS.MockWHSK, BYTECODES.MockWHSK);
  const usdt = await deployContract(
    publicClient,
    admin.walletClient,
    ABIS.MockERC20,
    BYTECODES.MockERC20,
    ["Tether USD", "USDT", 6],
  );

  const guardian = admin.address;
  const feeCollector = admin.address;

  const liquidityVault = await deployContract(
    publicClient,
    admin.walletClient,
    ABIS.LiquidityVault,
    BYTECODES.LiquidityVault,
    [admin.address, guardian, feeCollector],
  );

  const commitmentManager = await deployContract(
    publicClient,
    admin.walletClient,
    ABIS.CommitmentManager,
    BYTECODES.CommitmentManager,
    [admin.address, liquidityVault, guardian, protocolFeeBps],
  );

  const executionTicket = await deployContract(
    publicClient,
    admin.walletClient,
    ABIS.ExecutionTicket,
    BYTECODES.ExecutionTicket,
    [commitmentManager],
  );

  await sendAndConfirm(publicClient, admin.walletClient, liquidityVault, ABIS.LiquidityVault, "setManager", [
    commitmentManager,
  ]);
  await sendAndConfirm(
    publicClient,
    admin.walletClient,
    commitmentManager,
    ABIS.CommitmentManager,
    "setTicketNft",
    [executionTicket],
  );
  await sendAndConfirm(
    publicClient,
    admin.walletClient,
    commitmentManager,
    ABIS.CommitmentManager,
    "setTokenMinTicketAmount",
    [whsk, minTicketAmount],
  );

  const executionRouter = await deployContract(
    publicClient,
    admin.walletClient,
    ABIS.ExecutionRouter,
    BYTECODES.ExecutionRouter,
    [commitmentManager, whsk],
  );

  const signedPullOracle = await deployContract(
    publicClient,
    admin.walletClient,
    ABIS.SignedPullOracle,
    BYTECODES.SignedPullOracle,
    [admin.address, guardian, [admin.address], 1n, maxStaleness],
  );

  const oraclePriceAdapter = await deployContract(
    publicClient,
    admin.walletClient,
    ABIS.OraclePriceAdapter,
    BYTECODES.OraclePriceAdapter,
    [admin.address],
  );

  const hspComplianceHook = await deployContract(
    publicClient,
    admin.walletClient,
    ABIS.HSPComplianceHook,
    BYTECODES.HSPComplianceHook,
    [admin.address, admin.address],
  );

  await sendAndConfirm(
    publicClient,
    admin.walletClient,
    commitmentManager,
    ABIS.CommitmentManager,
    "setApprovedRouter",
    [executionRouter, true],
  );
  await sendAndConfirm(
    publicClient,
    admin.walletClient,
    commitmentManager,
    ABIS.CommitmentManager,
    "setApprovedOracle",
    [oraclePriceAdapter, true],
  );
  await sendAndConfirm(
    publicClient,
    admin.walletClient,
    commitmentManager,
    ABIS.CommitmentManager,
    "setApprovedComplianceHook",
    [hspComplianceHook, true],
  );

  await sendAndConfirm(
    publicClient,
    admin.walletClient,
    oraclePriceAdapter,
    ABIS.OraclePriceAdapter,
    "setPairConfig",
    [
      whsk,
      usdt,
      {
        primaryFeed: signedPullOracle,
        secondaryFeed: zeroAddress,
        maxStaleness,
        secondaryMaxStaleness: 0,
        maxDeviationBps,
        requireSecondaryCheck: false,
        allowSecondaryFallback: false,
        hardMinPriceX36,
        hardMaxPriceX36,
      },
    ],
  );

  const adminClient = new TrancheClient({
    publicClient,
    walletClient: admin.walletClient,
    addresses: {
      liquidityVault,
      commitmentManager,
      executionTicket,
      executionRouter,
      signedPullOracle,
      oraclePriceAdapter,
      hspComplianceHook,
    },
  });

  await adminClient.signAndUpdatePullOraclePrice({
    inventoryToken: whsk,
    paymentToken: usdt,
    priceX36: initialPriceX36,
  });

  // Mint test tokens for LP, Traders, and Keeper
  const whskMintAmount = 1_000_000n * 10n ** 18n;
  const usdtMintAmount = 1_000_000n * 10n ** 6n;

  await sendAndConfirm(publicClient, admin.walletClient, whsk, ABIS.MockWHSK, "mint", [
    lp.address,
    whskMintAmount,
  ]);
  await sendAndConfirm(publicClient, admin.walletClient, usdt, ABIS.MockERC20, "mint", [
    lp.address,
    100_000n * 10n ** 6n,
  ]);

  for (const actor of [trader1, trader2, keeper]) {
    await sendAndConfirm(publicClient, admin.walletClient, usdt, ABIS.MockERC20, "mint", [
      actor.address,
      usdtMintAmount,
    ]);
    await sendAndConfirm(publicClient, admin.walletClient, whsk, ABIS.MockWHSK, "mint", [
      actor.address,
      100_000n * 10n ** 18n,
    ]);
  }

  // Pre-approve LiquidityVault and ExecutionRouter
  for (const actor of [lp, trader1, trader2, keeper]) {
    await sendAndConfirm(publicClient, actor.walletClient, whsk, erc20Abi, "approve", [
      liquidityVault,
      maxUint256,
    ]);
    await sendAndConfirm(publicClient, actor.walletClient, usdt, erc20Abi, "approve", [
      liquidityVault,
      maxUint256,
    ]);
    await sendAndConfirm(publicClient, actor.walletClient, usdt, erc20Abi, "approve", [
      executionRouter,
      maxUint256,
    ]);
    await sendAndConfirm(publicClient, actor.walletClient, whsk, erc20Abi, "approve", [
      executionRouter,
      maxUint256,
    ]);
  }

  return {
    rpcUrl,
    chainId,
    addresses: {
      whsk,
      usdt,
      liquidityVault,
      commitmentManager,
      executionTicket,
      executionRouter,
      signedPullOracle,
      oraclePriceAdapter,
      hspComplianceHook,
      guardian,
      feeCollector,
      oracleSigner: admin.address,
      hspAttestationSigner: admin.address,
    },
    publicClient,
    accounts: {
      admin,
      lp,
      trader1,
      trader2,
      keeper,
    },
  };
}
