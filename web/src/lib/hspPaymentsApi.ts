import { DEFAULT_AGENT_API_URL, normalizeAgentApiUrl } from "@/lib/agentApi";

export type HspPaymentLifecycleState =
  | "CREATED"
  | "PREPARED"
  | "AUTHORIZED"
  | "SUBMITTED"
  | "PROCESSING"
  | "SAFE"
  | "TIMEOUT"
  | "FINALIZED"
  | "FAILED";

export type HspPaymentEvidenceKind = "MOCK_SIMULATION" | "LIVE_HSP_MCP";

export interface HspPaymentAuditEntry {
  timestamp: number;
  fromState: HspPaymentLifecycleState | null;
  toState: HspPaymentLifecycleState;
  event: string;
  detail?: string;
  evidenceKind: HspPaymentEvidenceKind;
}

export interface HspPaymentRecord {
  paymentId: string;
  idempotencyKey: string;
  state: HspPaymentLifecycleState;
  evidenceKind: HspPaymentEvidenceKind;
  isMockEvidence: boolean;
  merchant: string;
  payer: string;
  recipient: string;
  token: string;
  amount: string;
  memo?: string;
  preparationId?: string;
  preparationExpiresAt?: number;
  authorization?: {
    explicitUserConsent: true;
    authorizedBy: string;
    authorizationRef: string;
    authorizedAt: number;
  };
  submissionRef?: string;
  txReference?: string;
  providerStatusRaw?: string;
  submissionAttempts: number;
  failureCode?: string;
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
  history: HspPaymentAuditEntry[];
}

export interface HspOrchestratorStatusSummary {
  providerKind: "mock" | "live_unconfigured";
  evidenceKind: HspPaymentEvidenceKind;
  isMockEvidence: boolean;
  schemaDiscovered: boolean;
  liveMcpConnected: false;
  totalPayments: number;
  inProgressCount: number;
  countsByState: Record<HspPaymentLifecycleState, number>;
  stateCorrupted: boolean;
}

export interface CreateHspPaymentPayload {
  idempotencyKey: string;
  merchant: string;
  payer: string;
  recipient: string;
  token: string;
  amount: string;
  memo?: string;
}

export class HspPaymentsApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HspPaymentsApiError";
    this.status = status;
    this.code = code;
  }
}

export const DEFAULT_HSP_API_URL = DEFAULT_AGENT_API_URL;

export class HspPaymentsApiClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: { baseUrl?: string; token: string }) {
    this.baseUrl = normalizeAgentApiUrl(config.baseUrl ?? DEFAULT_HSP_API_URL);
    this.token = config.token.trim();
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (init?.body) {
      headers["Content-Type"] = "application/json";
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
      });
    } catch {
      throw new HspPaymentsApiError(0, "API_UNREACHABLE", "HSP Payments API is unreachable");
    }

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new HspPaymentsApiError(
        res.status,
        typeof data.error === "string" ? data.error : `HTTP_${res.status}`,
        typeof data.message === "string" ? data.message : `Request failed (${res.status})`,
      );
    }
    return data as T;
  }

  getStatus(): Promise<HspOrchestratorStatusSummary> {
    return this.request<HspOrchestratorStatusSummary>("/hsp/payments/status");
  }

  listPayments(): Promise<{ summary: HspOrchestratorStatusSummary; payments: HspPaymentRecord[] }> {
    return this.request("/hsp/payments");
  }

  getPayment(paymentId: string): Promise<{ payment: HspPaymentRecord }> {
    return this.request(`/hsp/payments/${encodeURIComponent(paymentId)}`);
  }

  createPayment(payload: CreateHspPaymentPayload): Promise<{ ok: true; payment: HspPaymentRecord }> {
    return this.request("/hsp/payments", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  preparePayment(paymentId: string): Promise<{ ok: true; payment: HspPaymentRecord }> {
    return this.request(`/hsp/payments/${encodeURIComponent(paymentId)}/prepare`, {
      method: "POST",
    });
  }

  authorizePayment(
    paymentId: string,
    payload: { explicitUserConsent: boolean; authorizedBy: string },
  ): Promise<{ ok: true; payment: HspPaymentRecord }> {
    return this.request(`/hsp/payments/${encodeURIComponent(paymentId)}/authorize`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  submitPayment(paymentId: string): Promise<{ ok: true; payment: HspPaymentRecord }> {
    return this.request(`/hsp/payments/${encodeURIComponent(paymentId)}/submit`, {
      method: "POST",
    });
  }

  refreshPayment(paymentId: string): Promise<{ ok: true; payment: HspPaymentRecord }> {
    return this.request(`/hsp/payments/${encodeURIComponent(paymentId)}/refresh`, {
      method: "POST",
    });
  }

  recoverInProgress(): Promise<{
    ok: true;
    checked: number;
    reconciled: HspPaymentRecord[];
    errors: Array<{ paymentId: string; code: string; message: string }>;
  }> {
    return this.request("/hsp/payments/recover", { method: "POST" });
  }
}
