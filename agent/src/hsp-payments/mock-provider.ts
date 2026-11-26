import { randomBytes } from "node:crypto";
import type {
  HspMcpTransportProvider,
  HspPaymentPreparationInput,
  HspPaymentPreparationOutcome,
  HspPaymentStatusQueryInput,
  HspPaymentStatusQueryOutcome,
  HspPaymentSubmissionInput,
  HspPaymentSubmissionOutcome,
  HspPaymentToolDiscoveryResult,
  HspWalletAuthorizationOutcome,
  HspWalletAuthorizationProvider,
  HspWalletAuthorizationRequest,
} from "./types.js";

export interface MockHspMcpProviderOptions {
  /** Override preparation behavior. */
  onPrepare?: (
    input: HspPaymentPreparationInput,
  ) => HspPaymentPreparationOutcome | Promise<HspPaymentPreparationOutcome>;
  /** Override submission behavior (can also throw to simulate transport timeout). */
  onSubmit?: (
    input: HspPaymentSubmissionInput,
  ) => HspPaymentSubmissionOutcome | Promise<HspPaymentSubmissionOutcome>;
  /** Sequential status responses returned on each queryPaymentStatus call. */
  statusSequence?: HspPaymentStatusQueryOutcome[];
  /** Custom status handler (takes precedence over statusSequence). */
  onQueryStatus?: (
    input: HspPaymentStatusQueryInput,
    callIndex: number,
  ) => HspPaymentStatusQueryOutcome | Promise<HspPaymentStatusQueryOutcome>;
  /** Default preparation TTL in seconds (default: 300s). */
  defaultPreparationTtlSec?: number;
  nowSec?: () => number;
}

/**
 * Configurable Mock HSP MCP Provider for offline lifecycle testing and UI development.
 *
 * Explicitly tags all results with `evidenceKind: "MOCK_SIMULATION"` and `schemaDiscovered: false`
 * so simulated results are never confused with real HSP MCP evidence.
 */
export class MockHspMcpProvider implements HspMcpTransportProvider {
  public readonly providerKind = "mock" as const;
  public readonly evidenceKind = "MOCK_SIMULATION" as const;
  public readonly schemaDiscovered = false as const;

  public prepareCalls = 0;
  public submitCalls = 0;
  public statusCalls = 0;

  private readonly opts: MockHspMcpProviderOptions;
  private readonly nowSec: () => number;
  private statusIndex = 0;

  constructor(opts: MockHspMcpProviderOptions = {}) {
    this.opts = opts;
    this.nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  }

  async discoverPaymentTools(): Promise<HspPaymentToolDiscoveryResult> {
    return {
      providerKind: this.providerKind,
      evidenceKind: this.evidenceKind,
      schemaDiscovered: false,
      discoveredAt: this.nowSec(),
      tools: [],
      note: "MOCK_SIMULATION: live HSP MCP tool schemas are pending EC2 IP allowlisting and live discovery.",
    };
  }

  async preparePayment(input: HspPaymentPreparationInput): Promise<HspPaymentPreparationOutcome> {
    this.prepareCalls += 1;
    if (this.opts.onPrepare) {
      return this.opts.onPrepare(input);
    }
    const ttl = this.opts.defaultPreparationTtlSec ?? 300;
    return {
      ok: true,
      evidenceKind: this.evidenceKind,
      preparationId: `mock_prep_${randomBytes(6).toString("hex")}`,
      expiresAt: this.nowSec() + ttl,
      attributedMerchant: input.merchant,
    };
  }

  async submitAuthorizedPayment(
    input: HspPaymentSubmissionInput,
  ): Promise<HspPaymentSubmissionOutcome> {
    this.submitCalls += 1;
    if (this.opts.onSubmit) {
      return this.opts.onSubmit(input);
    }
    return {
      outcome: "PROCESSING",
      evidenceKind: this.evidenceKind,
      submissionRef: `mock_sub_${randomBytes(6).toString("hex")}`,
      txReference: `0xmock_${randomBytes(12).toString("hex")}`,
      attributedMerchant: input.merchant,
      providerStatusRaw: "PROCESSING",
    };
  }

  async queryPaymentStatus(
    input: HspPaymentStatusQueryInput,
  ): Promise<HspPaymentStatusQueryOutcome> {
    const idx = this.statusCalls;
    this.statusCalls += 1;
    if (this.opts.onQueryStatus) {
      return this.opts.onQueryStatus(input, idx);
    }
    if (this.opts.statusSequence && this.opts.statusSequence.length > 0) {
      const next =
        this.opts.statusSequence[Math.min(this.statusIndex, this.opts.statusSequence.length - 1)]!;
      this.statusIndex += 1;
      return next;
    }
    return {
      evidenceKind: this.evidenceKind,
      providerStatusRaw: "FINALIZED",
      txReference: input.txReference ?? `0xmock_${randomBytes(12).toString("hex")}`,
    };
  }
}

export interface MockHspWalletAuthorizerOptions {
  approve?: boolean;
  rejectionCode?: "USER_REJECTED" | "MISSING_EXPLICIT_CONSENT" | "AUTHORIZER_UNAVAILABLE";
  rejectionReason?: string;
  nowSec?: () => number;
}

/**
 * Mock Wallet Authorization Provider — requires explicitUserConsent and never handles real keys.
 */
export class MockHspWalletAuthorizer implements HspWalletAuthorizationProvider {
  public authCalls = 0;
  private readonly opts: MockHspWalletAuthorizerOptions;
  private readonly nowSec: () => number;

  constructor(opts: MockHspWalletAuthorizerOptions = {}) {
    this.opts = opts;
    this.nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  }

  async requestAuthorization(
    request: HspWalletAuthorizationRequest,
  ): Promise<HspWalletAuthorizationOutcome> {
    this.authCalls += 1;
    if (!request.explicitUserConsent) {
      return {
        approved: false,
        rejectionCode: "MISSING_EXPLICIT_CONSENT",
        rejectionReason: "Explicit user consent is required",
      };
    }
    if (this.opts.approve === false) {
      return {
        approved: false,
        rejectionCode: this.opts.rejectionCode ?? "USER_REJECTED",
        rejectionReason: this.opts.rejectionReason ?? "User declined payment authorization",
      };
    }
    return {
      approved: true,
      authorizationRef: `mock_auth_${randomBytes(6).toString("hex")}`,
      authorizedAt: this.nowSec(),
    };
  }
}
