import type { PublicClient } from "viem";
import type { PendingTxRecord } from "./positions.js";

export type ReconciledTxStatus =
  | "CONFIRMED"
  | "REVERTED"
  | "REPLACED"
  | "PENDING"
  | "UNCERTAIN";

export interface TxReconciliationResult {
  pendingTxId: string;
  status: ReconciledTxStatus;
  canClearPending: boolean;
  blockNumber?: bigint;
  gasUsed?: bigint;
  reason: string;
}

/**
 * Automated on-chain transaction reconciler using chain ID, signer, nonce,
 * transaction hash, and receipt status.
 * Never auto-resubmits an uncertain transaction without proving the original cannot execute.
 */
export class TransactionReconciler {
  private readonly publicClient: Pick<
    PublicClient,
    "getChainId" | "getTransactionReceipt" | "getTransactionCount"
  >;

  constructor(
    publicClient: Pick<
      PublicClient,
      "getChainId" | "getTransactionReceipt" | "getTransactionCount"
    >,
  ) {
    this.publicClient = publicClient;
  }

  async reconcile(record: PendingTxRecord): Promise<TxReconciliationResult> {
    if (record.chainId !== undefined) {
      const actualChainId = await this.publicClient.getChainId();
      if (actualChainId !== record.chainId) {
        return {
          pendingTxId: record.id,
          status: "UNCERTAIN",
          canClearPending: false,
          reason: `Chain ID mismatch during reconciliation: expected ${record.chainId}, got ${actualChainId}`,
        };
      }
    }

    // 1. If we have a txHash, check on-chain receipt directly
    if (record.txHash) {
      try {
        const receipt = await this.publicClient.getTransactionReceipt({ hash: record.txHash });
        if (receipt.status === "success") {
          return {
            pendingTxId: record.id,
            status: "CONFIRMED",
            canClearPending: true,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
            reason: `Transaction ${record.txHash} confirmed in block ${receipt.blockNumber}`,
          };
        }
        return {
          pendingTxId: record.id,
          status: "REVERTED",
          canClearPending: true,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed,
          reason: `Transaction ${record.txHash} reverted on-chain in block ${receipt.blockNumber}`,
        };
      } catch {
        // Receipt not found yet -> fall through to nonce check
      }
    }

    // 2. Nonce-based check: if signer's mined nonce has strictly passed record.nonce,
    //    the original pending tx cannot execute anymore (replaced or mined under another hash).
    if (record.signer && record.nonce !== undefined) {
      const latestNonce = await this.publicClient.getTransactionCount({
        address: record.signer,
        blockTag: "latest",
      });
      if (latestNonce > record.nonce) {
        return {
          pendingTxId: record.id,
          status: "REPLACED",
          canClearPending: true,
          reason: `Signer nonce (${latestNonce}) > pending tx nonce (${record.nonce}); original tx replaced or mined`,
        };
      }
      return {
        pendingTxId: record.id,
        status: "PENDING",
        canClearPending: false,
        reason: `Signer nonce (${latestNonce}) <= pending tx nonce (${record.nonce}); original tx may still mine`,
      };
    }

    // 3. No txHash and no signer+nonce -> genuinely uncertain; require manual reconciliation
    return {
      pendingTxId: record.id,
      status: "UNCERTAIN",
      canClearPending: false,
      reason: "Insufficient metadata (missing txHash/nonce); requires explicit manual reconciliation",
    };
  }
}
