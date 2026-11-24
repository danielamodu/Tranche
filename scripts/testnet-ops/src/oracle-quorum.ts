import {
  createWalletClient,
  keccak256,
  encodePacked,
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
  type Chain,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ABIS } from "@tranche/sdk";

export interface QuorumSignedReport {
  inventoryToken: Address;
  paymentToken: Address;
  priceX36: bigint;
  reportTimestamp: bigint;
  signerAddresses: Address[];
  signatures: Hex[];
}

export interface QuorumSubmitResult extends QuorumSignedReport {
  txHash: Hex;
  gasUsed: bigint;
}

const PRICE_REPORT_TYPES = {
  PriceReport: [
    { name: "inventoryToken", type: "address" },
    { name: "paymentToken", type: "address" },
    { name: "priceX36", type: "uint256" },
    { name: "reportTimestamp", type: "uint256" },
  ],
} as const;

export function sortSignaturesAscending<T extends { address: Address; signature: Hex }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => {
    const aa = BigInt(a.address.toLowerCase());
    const bb = BigInt(b.address.toLowerCase());
    if (aa < bb) return -1;
    if (aa > bb) return 1;
    throw new Error(`Duplicate oracle signer detected: ${a.address}`);
  });
}

export async function signQuorumPriceReport(params: {
  chainId: number;
  pullOracleAddress: Address;
  inventoryToken: Address;
  paymentToken: Address;
  priceX36: bigint;
  reportTimestamp: bigint;
  signerPrivateKeys: readonly Hex[];
}): Promise<QuorumSignedReport> {
  if (params.priceX36 <= 0n) {
    throw new Error("ZeroPrice: priceX36 must be positive");
  }

  const domain = {
    name: "ProtocolSignedPullOracle",
    version: "2",
    chainId: BigInt(params.chainId),
    verifyingContract: params.pullOracleAddress,
  } as const;

  const message = {
    inventoryToken: params.inventoryToken,
    paymentToken: params.paymentToken,
    priceX36: params.priceX36,
    reportTimestamp: params.reportTimestamp,
  } as const;

  const signedPairs = await Promise.all(
    params.signerPrivateKeys.map(async (pk) => {
      const account = privateKeyToAccount(pk);
      const signature = await account.signTypedData({
        domain,
        types: PRICE_REPORT_TYPES,
        primaryType: "PriceReport",
        message,
      });
      return { address: account.address, signature };
    }),
  );

  const sorted = sortSignaturesAscending(signedPairs);
  return {
    inventoryToken: params.inventoryToken,
    paymentToken: params.paymentToken,
    priceX36: params.priceX36,
    reportTimestamp: params.reportTimestamp,
    signerAddresses: sorted.map((s) => s.address),
    signatures: sorted.map((s) => s.signature),
  };
}

export async function submitQuorumPriceUpdate(params: {
  publicClient: PublicClient;
  submitterWalletClient: WalletClient;
  pullOracleAddress: Address;
  inventoryToken: Address;
  paymentToken: Address;
  priceX36: bigint;
  signerPrivateKeys: readonly Hex[];
  reportTimestamp?: bigint;
  enforceOnChainPreflight?: boolean;
}): Promise<QuorumSubmitResult> {
  const { publicClient, submitterWalletClient } = params;
  if (!submitterWalletClient.account) {
    throw new Error("submitterWalletClient must have an active account");
  }

  const [chainId, block, threshold] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlock({ blockTag: "latest" }),
    publicClient.readContract({
      address: params.pullOracleAddress,
      abi: ABIS.SignedPullOracle,
      functionName: "threshold",
    }) as Promise<bigint>,
  ]);

  const reportTimestamp = params.reportTimestamp ?? block.timestamp;
  if (BigInt(params.signerPrivateKeys.length) < threshold) {
    throw new Error(
      `InsufficientSignatures preflight: supplied ${params.signerPrivateKeys.length}, threshold=${threshold}`,
    );
  }

  if (params.enforceOnChainPreflight !== false) {
    const pairKey = keccak256(encodePacked(["address", "address"], [params.inventoryToken, params.paymentToken]));
    const [prevQuote, jumpCapBps] = await Promise.all([
      publicClient.readContract({
        address: params.pullOracleAddress,
        abi: ABIS.SignedPullOracle,
        functionName: "getPriceX36",
        args: [params.inventoryToken, params.paymentToken],
      }) as Promise<{ priceX36: bigint; updatedAt: bigint; isValid: boolean }>,
      publicClient.readContract({
        address: params.pullOracleAddress,
        abi: ABIS.SignedPullOracle,
        functionName: "maxJumpBps",
        args: [pairKey],
      }) as Promise<number>,
    ]);

    if (prevQuote.updatedAt >= reportTimestamp) {
      throw new Error(
        `StaleTimestamp preflight: reportTimestamp=${reportTimestamp} <= updatedAt=${prevQuote.updatedAt}`,
      );
    }
    if (prevQuote.isValid && prevQuote.priceX36 > 0n && jumpCapBps > 0) {
      const diff =
        params.priceX36 > prevQuote.priceX36
          ? params.priceX36 - prevQuote.priceX36
          : prevQuote.priceX36 - params.priceX36;
      const jumpBps = (diff * 10_000n) / prevQuote.priceX36;
      if (jumpBps > BigInt(jumpCapBps)) {
        throw new Error(`MaxJumpExceeded preflight: jumpBps=${jumpBps} > maxJumpBps=${jumpCapBps}`);
      }
    }
  }

  const report = await signQuorumPriceReport({
    chainId,
    pullOracleAddress: params.pullOracleAddress,
    inventoryToken: params.inventoryToken,
    paymentToken: params.paymentToken,
    priceX36: params.priceX36,
    reportTimestamp,
    signerPrivateKeys: params.signerPrivateKeys,
  });

  const { request } = await publicClient.simulateContract({
    account: submitterWalletClient.account,
    address: params.pullOracleAddress,
    abi: ABIS.SignedPullOracle,
    functionName: "updatePrice",
    args: [
      report.inventoryToken,
      report.paymentToken,
      report.priceX36,
      report.reportTimestamp,
      report.signatures,
    ],
  });

  const txHash = await submitterWalletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`SignedPullOracle.updatePrice reverted in tx ${txHash}`);
  }

  return {
    ...report,
    txHash,
    gasUsed: receipt.gasUsed,
  };
}

export function createKeyWalletClient(chain: Chain, transport: Transport, privateKey: Hex): WalletClient {
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain,
    transport,
  });
}
