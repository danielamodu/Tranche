import type { Abi, Account, Address, Hex, PublicClient, WalletClient } from "viem";

/** Execution mode for the Tranche HSP adapter. */
export type HSPMode = "LOCAL_EIP712_COMPLIANCE" | "LIVE_HSP_CAAS";

/** Epistemic classification of the adapter's current verification state. */
export type HSPVerificationStatus = "LOCAL_ADAPTER" | "BLOCKED" | "VERIFIED";

/** Action types authorized by a pre-trade HSP mandate envelope. */
export type HSPMandateAction = "CREATE_OFFER" | "RESERVE" | "TRANSFER" | "EXERCISE";

/** Credentials and endpoints required for live HashKey CaaS / HSP facilitator calls. */
export interface HSPLiveCaasConfig {
  apiBaseUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  facilitatorUrl?: string;
}

/** Loaded Foundry contract artifact subset required by viem. */
export interface TrancheContractArtifact {
  abi: Abi;
  bytecode: Hex;
}

/** Collection of Tranche contract artifacts loaded from `../out/`. */
export interface TrancheArtifacts {
  HSPComplianceHook: TrancheContractArtifact;
  LiquidityVault: TrancheContractArtifact;
  CommitmentManager: TrancheContractArtifact;
  ExecutionTicket: TrancheContractArtifact;
  MockWHSK: TrancheContractArtifact;
  MockERC20: TrancheContractArtifact;
}

/** EIP-712 domain matching `HSPComplianceHook.sol` (`EIP712("ProtocolHSPCompliance", "1")`). */
export interface HSPComplianceDomain {
  name: "ProtocolHSPCompliance";
  version: "1";
  chainId: number;
  verifyingContract: Address;
}

/** Signed out-of-band compliance attestation envelope submitted to `HSPComplianceHook.submitAttestation`. */
export interface HSPAttestationEnvelope {
  mode: HSPMode;
  chainId: number;
  verifyingContract: Address;
  attestationSigner: Address;
  subject: Address;
  nonce: bigint;
  expiry: bigint;
  domain: HSPComplianceDomain;
  signature: Hex;
}

/** Pre-trade off-chain HSP authorization mandate signed by the adapter/compliance issuer. */
export interface HSPMandate {
  mandateId: Hex;
  mode: HSPMode;
  chainId: number;
  commitmentManager: Address;
  complianceHook: Address;
  subject: Address;
  counterparty: Address;
  action: HSPMandateAction;
  offerId?: string;
  ticketId?: string;
  inventoryToken: Address;
  paymentToken: Address;
  maxAmount: string;
  issuedAt: number;
  expiresAt: number;
  issuer: Address;
  signature: Hex;
}

/** Post-settlement verifiable receipt anchored to a real EVM transaction hash and block receipt. */
export interface HSPSettlementReceipt {
  receiptId: Hex;
  mode: HSPMode;
  status: "SETTLED_ONCHAIN" | "BLOCKED";
  chainId: number;
  txHash: Hex;
  blockNumber: string;
  blockHash: Hex;
  gasUsed: string;
  mandateId: Hex;
  commitmentManager: Address;
  ticketId: string;
  exerciser: Address;
  receiver: Address;
  inventoryToken: Address;
  paymentToken: Address;
  fillAmount: string;
  grossPayment: string;
  effectivePriceX36: string;
  recordedAt: number;
  proofHash: Hex;
}

/** Honest status report distinguishing local EIP-712 compliance from blocked live CaaS endpoints. */
export interface HSPStatusReport {
  mode: HSPMode;
  chainId: number;
  verificationStatus: HSPVerificationStatus;
  liveCaasConfigured: boolean;
  liveFacilitatorConfigured: boolean;
  complianceHookAddress?: Address;
  commitmentManagerAddress?: Address;
  attestationSigner?: Address;
  notes: string[];
}

/** Constructor options for `TrancheHSPAdapter`. */
export interface TrancheHSPAdapterConfig {
  mode: HSPMode;
  chainId: number;
  publicClient: PublicClient;
  complianceHookAddress?: Address;
  commitmentManagerAddress?: Address;
  signerAccount?: Account;
  walletClient?: WalletClient;
  liveConfig?: HSPLiveCaasConfig;
  outDir?: string;
}
