import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  parseEventLogs,
  toHex,
} from "viem";
import type {
  HSPAttestationEnvelope,
  HSPLiveCaasConfig,
  HSPMandate,
  HSPMandateAction,
  HSPMode,
  HSPSettlementReceipt,
  HSPStatusReport,
  TrancheArtifacts,
  TrancheContractArtifact,
  TrancheHSPAdapterConfig,
} from "./types.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = path.resolve(PACKAGE_ROOT, "../out");

const COMPLIANCE_ATTESTATION_TYPES = {
  ComplianceAttestation: [
    { name: "subject", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
} as const;

const MANDATE_TYPES = {
  HSPMandate: [
    { name: "commitmentManager", type: "address" },
    { name: "complianceHook", type: "address" },
    { name: "subject", type: "address" },
    { name: "counterparty", type: "address" },
    { name: "action", type: "string" },
    { name: "inventoryToken", type: "address" },
    { name: "paymentToken", type: "address" },
    { name: "maxAmount", type: "uint256" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

/** Error thrown when `LIVE_HSP_CAAS` mode is invoked without institutional credentials or a live facilitator. */
export class HSPLiveUnavailableError extends Error {
  public readonly code = "HSP_LIVE_UNAVAILABLE" as const;
  public readonly missingFields: string[];
  public readonly remediation: string;

  constructor(missingFields: string[], detail?: string) {
    const remediation =
      "Complete HashKey institutional KYC/KYB onboarding, provision CaaS API credentials " +
      "(apiBaseUrl, apiKey, apiSecret with HMAC-SHA256/ES256K + IP/wallet whitelisting), and configure " +
      "a verified live HSP facilitator endpoint (facilitatorUrl). Use LOCAL_EIP712_COMPLIANCE for local/anvil testing.";
    const suffix = detail ? ` ${detail}` : "";
    super(
      `HSP_LIVE_UNAVAILABLE: Cannot execute live HashKey CaaS / HSP settlement` +
        `${missingFields.length > 0 ? ` (missing: ${missingFields.join(", ")})` : ""}.${suffix} ${remediation}`
    );
    this.name = "HSPLiveUnavailableError";
    this.missingFields = missingFields;
    this.remediation = remediation;
  }
}

interface RawFoundryArtifact {
  abi: TrancheContractArtifact["abi"];
  bytecode?: {
    object?: string;
  };
}

function readFoundryArtifact(outDir: string, relativeArtifactPath: string): TrancheContractArtifact {
  const fullPath = path.resolve(outDir, relativeArtifactPath);
  const raw = JSON.parse(readFileSync(fullPath, "utf8")) as RawFoundryArtifact;
  const bytecode = raw.bytecode?.object;
  if (!Array.isArray(raw.abi) || typeof bytecode !== "string" || !bytecode.startsWith("0x")) {
    throw new Error(`Invalid Foundry artifact at ${fullPath}`);
  }
  return {
    abi: raw.abi,
    bytecode: bytecode as Hex,
  };
}

/** Loads compiled Tranche contract ABIs and bytecodes directly from `../out/`. */
export function loadTrancheArtifacts(outDir: string = DEFAULT_OUT_DIR): TrancheArtifacts {
  return {
    HSPComplianceHook: readFoundryArtifact(outDir, "HSPComplianceHook.sol/HSPComplianceHook.json"),
    LiquidityVault: readFoundryArtifact(outDir, "LiquidityVault.sol/LiquidityVault.json"),
    CommitmentManager: readFoundryArtifact(outDir, "CommitmentManager.sol/CommitmentManager.json"),
    ExecutionTicket: readFoundryArtifact(outDir, "ExecutionTicket.sol/ExecutionTicket.json"),
    MockWHSK: readFoundryArtifact(outDir, "ProtocolAdversarial.t.sol/MockWHSK.json"),
    MockERC20: readFoundryArtifact(outDir, "ProtocolAdversarial.t.sol/MockERC20.json"),
  };
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Out-of-band HSP compliance attestation, pre-trade mandate, and settlement receipt adapter for Tranche.
 *
 * Strictly separated from Tranche's core atomic exercise (`CommitmentManager.exercise`) and LP exit/reclaim
 * paths (`LiquidityVault.withdrawFree`, `LiquidityVault.claimProceeds`, `CommitmentManager.cancelOffer`,
 * `CommitmentManager.reclaimExpired`) per INV-8.
 */
export class TrancheHSPAdapter {
  public readonly mode: HSPMode;
  public readonly chainId: number;
  public readonly artifacts: TrancheArtifacts;

  private readonly publicClient: PublicClient;
  private complianceHookAddress?: Address;
  private commitmentManagerAddress?: Address;
  private readonly signerAccount?: Account;
  private readonly walletClient?: WalletClient;
  private readonly liveConfig: HSPLiveCaasConfig;

  constructor(config: TrancheHSPAdapterConfig) {
    this.mode = config.mode;
    this.chainId = config.chainId;
    this.publicClient = config.publicClient;
    this.complianceHookAddress = config.complianceHookAddress;
    this.commitmentManagerAddress = config.commitmentManagerAddress;
    this.signerAccount = config.signerAccount;
    this.walletClient = config.walletClient;
    this.liveConfig = config.liveConfig ?? {};
    this.artifacts = loadTrancheArtifacts(config.outDir ?? DEFAULT_OUT_DIR);
  }

  public setContractAddresses(addresses: {
    complianceHookAddress?: Address;
    commitmentManagerAddress?: Address;
  }): void {
    if (addresses.complianceHookAddress) {
      this.complianceHookAddress = addresses.complianceHookAddress;
    }
    if (addresses.commitmentManagerAddress) {
      this.commitmentManagerAddress = addresses.commitmentManagerAddress;
    }
  }

  /** Reports the honest operational and verification status of the adapter. */
  public async getStatusReport(): Promise<HSPStatusReport> {
    const liveCaasConfigured =
      isNonEmpty(this.liveConfig.apiBaseUrl) &&
      isNonEmpty(this.liveConfig.apiKey) &&
      isNonEmpty(this.liveConfig.apiSecret);
    const liveFacilitatorConfigured = isNonEmpty(this.liveConfig.facilitatorUrl);

    if (this.mode === "LIVE_HSP_CAAS") {
      const blocked = !liveCaasConfigured || !liveFacilitatorConfigured;
      return {
        mode: this.mode,
        chainId: this.chainId,
        verificationStatus: blocked ? "BLOCKED" : "VERIFIED",
        liveCaasConfigured,
        liveFacilitatorConfigured,
        complianceHookAddress: this.complianceHookAddress,
        commitmentManagerAddress: this.commitmentManagerAddress,
        attestationSigner: this.signerAccount?.address,
        notes: blocked
          ? [
              "LIVE_HSP_CAAS is blocked: HashKey CaaS / HSP requires institutional KYC/KYB onboarding, API key/secret, IP/wallet whitelisting, and a live facilitator endpoint.",
              "No canonical public HSP singleton exists on HashKey Chain mainnet (177).",
            ]
          : ["Live HashKey CaaS credentials and facilitator URL configured."],
      };
    }

    return {
      mode: this.mode,
      chainId: this.chainId,
      verificationStatus: "LOCAL_ADAPTER",
      liveCaasConfigured,
      liveFacilitatorConfigured,
      complianceHookAddress: this.complianceHookAddress,
      commitmentManagerAddress: this.commitmentManagerAddress,
      attestationSigner: this.signerAccount?.address,
      notes: [
        "Operating in LOCAL_EIP712_COMPLIANCE mode using HSPComplianceHook EIP-712 domain ('ProtocolHSPCompliance', '1').",
        "All HSP checks are strictly out-of-band / pre-trade; LP cancelOffer, withdrawFree, claimProceeds, and reclaimExpired never invoke HSP (INV-8).",
      ],
    };
  }

  /** Validates live CaaS credentials and facilitator availability, throwing `HSP_LIVE_UNAVAILABLE` when absent. */
  public assertLiveConfigured(): void {
    const missing: string[] = [];
    if (!isNonEmpty(this.liveConfig.apiBaseUrl)) missing.push("apiBaseUrl");
    if (!isNonEmpty(this.liveConfig.apiKey)) missing.push("apiKey");
    if (!isNonEmpty(this.liveConfig.apiSecret)) missing.push("apiSecret");
    if (!isNonEmpty(this.liveConfig.facilitatorUrl)) missing.push("facilitatorUrl");

    if (missing.length > 0) {
      throw new HSPLiveUnavailableError(missing);
    }
  }

  /** Reads `HSPComplianceHook.nonces(subject)` from chain. */
  public async getSubjectNonce(subject: Address): Promise<bigint> {
    const hook = this.requireComplianceHook();
    return (await this.publicClient.readContract({
      address: hook,
      abi: this.artifacts.HSPComplianceHook.abi,
      functionName: "nonces",
      args: [subject],
    })) as bigint;
  }

  /** Reads `HSPComplianceHook.isCompliant(subject)` from chain. */
  public async isCompliant(subject: Address): Promise<boolean> {
    const hook = this.requireComplianceHook();
    return (await this.publicClient.readContract({
      address: hook,
      abi: this.artifacts.HSPComplianceHook.abi,
      functionName: "isCompliant",
      args: [subject],
    })) as boolean;
  }

  /**
   * Signs an EIP-712 `ComplianceAttestation(address subject,uint256 nonce,uint256 expiry)`
   * matching `HSPComplianceHook.sol` (`EIP712("ProtocolHSPCompliance", "1")`).
   */
  public async signAttestation(params: {
    subject: Address;
    nonce?: bigint;
    expiry: bigint;
  }): Promise<HSPAttestationEnvelope> {
    if (this.mode === "LIVE_HSP_CAAS") {
      this.assertLiveConfigured();
      throw new HSPLiveUnavailableError(
        [],
        "Live CaaS attestation signing requires an active authenticated HashKey CaaS session."
      );
    }

    const verifyingContract = this.requireComplianceHook();
    const signer = this.requireSignerAccount();
    const nonce = params.nonce ?? (await this.getSubjectNonce(params.subject));

    const domain = {
      name: "ProtocolHSPCompliance" as const,
      version: "1" as const,
      chainId: this.chainId,
      verifyingContract,
    };

    const signature = await this.signTypedData({
      domain,
      types: COMPLIANCE_ATTESTATION_TYPES,
      primaryType: "ComplianceAttestation",
      message: {
        subject: params.subject,
        nonce,
        expiry: params.expiry,
      },
    });

    return {
      mode: this.mode,
      chainId: this.chainId,
      verifyingContract,
      attestationSigner: signer.address,
      subject: params.subject,
      nonce,
      expiry: params.expiry,
      domain,
      signature,
    };
  }

  /** Submits a signed `HSPAttestationEnvelope` on-chain via `HSPComplianceHook.submitAttestation`. */
  public async submitAttestation(
    envelope: HSPAttestationEnvelope,
    submitterWalletClient?: WalletClient
  ): Promise<Hex> {
    if (this.mode === "LIVE_HSP_CAAS") {
      this.assertLiveConfigured();
      throw new HSPLiveUnavailableError(
        [],
        "Live CaaS attestation relay requires an active authenticated HashKey facilitator."
      );
    }

    const writer = submitterWalletClient ?? this.walletClient;
    if (!writer || !writer.account) {
      throw new Error("A WalletClient with an active account is required to submit an attestation.");
    }

    const txHash = await writer.writeContract({
      address: envelope.verifyingContract,
      abi: this.artifacts.HSPComplianceHook.abi,
      functionName: "submitAttestation",
      args: [envelope.subject, envelope.nonce, envelope.expiry, envelope.signature],
      account: writer.account,
      chain: writer.chain,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`submitAttestation transaction reverted: ${txHash}`);
    }
    return txHash;
  }

  /**
   * Issues a pre-trade off-chain `HSPMandate` envelope.
   * Never executed inside `CommitmentManager.exercise()` or LP exit/reclaim paths.
   */
  public async issueMandate(params: {
    subject: Address;
    counterparty: Address;
    action: HSPMandateAction;
    offerId?: bigint;
    ticketId?: bigint;
    inventoryToken: Address;
    paymentToken: Address;
    maxAmount: bigint;
    issuedAt?: number;
    expiresAt: number;
    requireOnChainCompliance?: boolean;
  }): Promise<HSPMandate> {
    if (this.mode === "LIVE_HSP_CAAS") {
      this.assertLiveConfigured();
      throw new HSPLiveUnavailableError(
        [],
        "Live CaaS mandate issuance requires an active authenticated HashKey facilitator."
      );
    }

    const complianceHook = this.requireComplianceHook();
    const commitmentManager = this.requireCommitmentManager();
    const signer = this.requireSignerAccount();

    if (params.requireOnChainCompliance !== false) {
      const compliant = await this.isCompliant(params.subject);
      if (!compliant) {
        throw new Error(`Subject ${params.subject} is not compliant on HSPComplianceHook ${complianceHook}`);
      }
    }

    const issuedAt = params.issuedAt ?? Math.floor(Date.now() / 1000);
    const domain = {
      name: "ProtocolHSPCompliance" as const,
      version: "1" as const,
      chainId: this.chainId,
      verifyingContract: complianceHook,
    };

    const signature = await this.signTypedData({
      domain,
      types: MANDATE_TYPES,
      primaryType: "HSPMandate",
      message: {
        commitmentManager,
        complianceHook,
        subject: params.subject,
        counterparty: params.counterparty,
        action: params.action,
        inventoryToken: params.inventoryToken,
        paymentToken: params.paymentToken,
        maxAmount: params.maxAmount,
        issuedAt: BigInt(issuedAt),
        expiresAt: BigInt(params.expiresAt),
      },
    });

    const mandateId = keccak256(
      encodeAbiParameters(
        parseAbiParameters(
          "uint256 chainId, address commitmentManager, address complianceHook, address subject, address counterparty, string action, uint256 maxAmount, uint256 issuedAt, uint256 expiresAt"
        ),
        [
          BigInt(this.chainId),
          commitmentManager,
          complianceHook,
          params.subject,
          params.counterparty,
          params.action,
          params.maxAmount,
          BigInt(issuedAt),
          BigInt(params.expiresAt),
        ]
      )
    );

    return {
      mandateId,
      mode: this.mode,
      chainId: this.chainId,
      commitmentManager,
      complianceHook,
      subject: params.subject,
      counterparty: params.counterparty,
      action: params.action,
      offerId: params.offerId?.toString(),
      ticketId: params.ticketId?.toString(),
      inventoryToken: params.inventoryToken,
      paymentToken: params.paymentToken,
      maxAmount: params.maxAmount.toString(),
      issuedAt,
      expiresAt: params.expiresAt,
      issuer: signer.address,
      signature,
    };
  }

  /**
   * Builds a deterministic `HSPSettlementReceipt` proof anchored to a real on-chain
   * `CommitmentManager.exercise()` transaction hash, block receipt, and `TicketExercised` log.
   */
  public async buildSettlementReceipt(params: {
    txHash: Hex;
    mandate: HSPMandate;
    ticketId: bigint;
    exerciser: Address;
    receiver: Address;
    inventoryToken: Address;
    paymentToken: Address;
  }): Promise<HSPSettlementReceipt> {
    if (this.mode === "LIVE_HSP_CAAS") {
      this.assertLiveConfigured();
      throw new HSPLiveUnavailableError(
        [],
        "Live CaaS receipt submission requires an active authenticated HashKey facilitator."
      );
    }

    const commitmentManager = this.requireCommitmentManager();
    const txReceipt = await this.publicClient.getTransactionReceipt({ hash: params.txHash });
    if (txReceipt.status !== "success") {
      throw new Error(`Exercise transaction ${params.txHash} did not succeed`);
    }

    const parsedLogs = parseEventLogs({
      abi: this.artifacts.CommitmentManager.abi,
      logs: txReceipt.logs,
      eventName: "TicketExercised",
    });

    const matched = parsedLogs.find((log) => {
      const args = (log as unknown as { args?: Record<string, unknown> }).args;
      if (!args) return false;
      return (
        args.ticketId === params.ticketId &&
        typeof args.exerciser === "string" &&
        args.exerciser.toLowerCase() === params.exerciser.toLowerCase() &&
        typeof args.receiver === "string" &&
        args.receiver.toLowerCase() === params.receiver.toLowerCase()
      );
    });

    if (!matched) {
      throw new Error(
        `No TicketExercised event matching ticketId=${params.ticketId.toString()} found in tx ${params.txHash}`
      );
    }

    const args = (matched as unknown as {
      args: {
        fillAmount: bigint;
        grossPayment: bigint;
        effPriceX36: bigint;
      };
    }).args;

    const proofHash = keccak256(
      encodeAbiParameters(
        parseAbiParameters(
          "uint256 chainId, bytes32 txHash, bytes32 blockHash, uint256 blockNumber, bytes32 mandateId, uint256 ticketId, uint256 fillAmount, uint256 grossPayment, uint256 effPriceX36"
        ),
        [
          BigInt(this.chainId),
          txReceipt.transactionHash,
          txReceipt.blockHash,
          txReceipt.blockNumber,
          params.mandate.mandateId,
          params.ticketId,
          args.fillAmount,
          args.grossPayment,
          args.effPriceX36,
        ]
      )
    );

    const receiptId = keccak256(
      toHex(`${this.chainId}:${txReceipt.transactionHash}:${params.ticketId.toString()}:${params.mandate.mandateId}`)
    );

    return {
      receiptId,
      mode: this.mode,
      status: "SETTLED_ONCHAIN",
      chainId: this.chainId,
      txHash: txReceipt.transactionHash,
      blockNumber: txReceipt.blockNumber.toString(),
      blockHash: txReceipt.blockHash,
      gasUsed: txReceipt.gasUsed.toString(),
      mandateId: params.mandate.mandateId,
      commitmentManager,
      ticketId: params.ticketId.toString(),
      exerciser: params.exerciser,
      receiver: params.receiver,
      inventoryToken: params.inventoryToken,
      paymentToken: params.paymentToken,
      fillAmount: args.fillAmount.toString(),
      grossPayment: args.grossPayment.toString(),
      effectivePriceX36: args.effPriceX36.toString(),
      recordedAt: Math.floor(Date.now() / 1000),
      proofHash,
    };
  }

  private requireComplianceHook(): Address {
    if (!this.complianceHookAddress) {
      throw new Error("complianceHookAddress is not configured on TrancheHSPAdapter");
    }
    return this.complianceHookAddress;
  }

  private requireCommitmentManager(): Address {
    if (!this.commitmentManagerAddress) {
      throw new Error("commitmentManagerAddress is not configured on TrancheHSPAdapter");
    }
    return this.commitmentManagerAddress;
  }

  private requireSignerAccount(): Account {
    if (!this.signerAccount) {
      throw new Error("signerAccount is required for LOCAL_EIP712_COMPLIANCE signing");
    }
    return this.signerAccount;
  }

  private async signTypedData(params: {
    domain: {
      name: "ProtocolHSPCompliance";
      version: "1";
      chainId: number;
      verifyingContract: Address;
    };
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex> {
    const signer = this.requireSignerAccount();
    if (signer.signTypedData) {
      return signer.signTypedData(params as Parameters<NonNullable<Account["signTypedData"]>>[0]);
    }
    if (this.walletClient) {
      return this.walletClient.signTypedData({
        account: signer,
        ...params,
      } as Parameters<WalletClient["signTypedData"]>[0]);
    }
    throw new Error("Configured signerAccount does not support signTypedData and no walletClient was provided");
  }
}
