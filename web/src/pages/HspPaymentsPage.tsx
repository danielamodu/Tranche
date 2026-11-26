import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Clock,
  CreditCard,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  WifiOff,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_HSP_API_URL,
  HspPaymentsApiClient,
  HspPaymentsApiError,
  type HspOrchestratorStatusSummary,
  type HspPaymentLifecycleState,
  type HspPaymentRecord,
} from "@/lib/hspPaymentsApi";
import { normalizeAgentApiUrl } from "@/lib/agentApi";
import { cn } from "@/lib/utils";
import type { AppRoute } from "@/App";

interface HspPaymentsPageProps {
  onNavigate: (path: AppRoute) => void;
}

const API_URL_STORAGE_KEY = "tranche-agent-api-url";
const TOKEN_STORAGE_KEY = "tranche-agent-token";

function stateBadgeClass(state: HspPaymentLifecycleState): string {
  if (state === "FINALIZED") return "bg-emerald-500/15 text-emerald-500 border-emerald-500/30";
  if (state === "FAILED") return "bg-destructive/15 text-destructive border-destructive/30";
  if (state === "TIMEOUT") return "bg-amber-500/15 text-amber-500 border-amber-500/30";
  if (state === "SAFE" || state === "PROCESSING" || state === "SUBMITTED") {
    return "bg-blue-500/15 text-blue-500 border-blue-500/30";
  }
  return "bg-muted text-foreground border-border";
}

function humanPaymentState(state: HspPaymentLifecycleState): string {
  switch (state) {
    case "CREATED":
      return "Draft";
    case "PREPARED":
      return "Ready to Approve";
    case "AUTHORIZED":
      return "Approved";
    case "SUBMITTED":
      return "Submitted";
    case "PROCESSING":
      return "Processing";
    case "SAFE":
      return "Confirming";
    case "TIMEOUT":
      return "Delayed";
    case "FINALIZED":
      return "Paid";
    case "FAILED":
      return "Failed";
  }
}

function shortRef(val?: string): string {
  if (!val) return "—";
  if (val.length <= 18) return val;
  return `${val.slice(0, 10)}…${val.slice(-6)}`;
}

export function HspPaymentsPage({ onNavigate }: HspPaymentsPageProps) {
  const [apiUrlInput, setApiUrlInput] = useState<string>(() => {
    const saved = sessionStorage.getItem(API_URL_STORAGE_KEY);
    return saved ? normalizeAgentApiUrl(saved) : normalizeAgentApiUrl(DEFAULT_HSP_API_URL);
  });
  const [tokenInput, setTokenInput] = useState<string>(
    () => sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "",
  );
  const [connOpen, setConnOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const client = useMemo(
    () => new HspPaymentsApiClient({ baseUrl: apiUrlInput, token: tokenInput }),
    [apiUrlInput, tokenInput],
  );

  const [summary, setSummary] = useState<HspOrchestratorStatusSummary | null>(null);
  const [payments, setPayments] = useState<HspPaymentRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Create payment form state (no secrets or signing keys)
  const [merchant, setMerchant] = useState("merchant_hashkey_demo");
  const [payer, setPayer] = useState("0x1111111111111111111111111111111111111111");
  const [recipient, setRecipient] = useState("0x2222222222222222222222222222222222222222");
  const [token, setToken] = useState("USDT");
  const [amount, setAmount] = useState("25.00");
  const [memo, setMemo] = useState("");
  const [consentChecked, setConsentChecked] = useState(false);
  const [authorizedBy, setAuthorizedBy] = useState("operator");

  const loadData = useCallback(
    async (isManual = false) => {
      if (!tokenInput.trim()) {
        setSummary(null);
        setPayments([]);
        setLoading(false);
        setErrorMsg("Enter your operator API token to view or manage HSP payments.");
        return;
      }
      if (isManual) setRefreshing(true);
      try {
        const res = await client.listPayments();
        setSummary(res.summary);
        setPayments(res.payments);
        setErrorMsg(null);
        if (res.payments.length > 0 && !selectedId) {
          setSelectedId(res.payments[0]!.paymentId);
        }
      } catch (err) {
        const msg =
          err instanceof HspPaymentsApiError
            ? err.status === 401
              ? "Authentication required — provide a valid operator Bearer token."
              : err.message
            : "Unable to reach HSP Payments API.";
        setErrorMsg(msg);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [client, tokenInput, selectedId],
  );

  useEffect(() => {
    loadData();
  }, [loadData]);

  const selected = useMemo(
    () => payments.find((p) => p.paymentId === selectedId) ?? payments[0] ?? null,
    [payments, selectedId],
  );

  function saveConnection() {
    const clean = normalizeAgentApiUrl(apiUrlInput);
    setApiUrlInput(clean);
    sessionStorage.setItem(API_URL_STORAGE_KEY, clean);
    sessionStorage.setItem(TOKEN_STORAGE_KEY, tokenInput.trim());
    setConnOpen(false);
    void loadData(true);
  }

  async function runAction(label: string, fn: () => Promise<HspPaymentRecord | void>) {
    setActionBusy(true);
    setFeedback(null);
    try {
      const updated = await fn();
      if (updated) setSelectedId(updated.paymentId);
      setFeedback({ kind: "ok", text: label });
      setConsentChecked(false);
      await loadData(true);
    } catch (err) {
      setFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : "Action failed",
      });
    } finally {
      setActionBusy(false);
    }
  }

  async function handleCreate() {
    const idempotencyKey = `hsp-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await runAction("Payment intent created", async () => {
      const res = await client.createPayment({
        idempotencyKey,
        merchant,
        payer,
        recipient,
        token,
        amount,
        memo: memo.trim() || undefined,
      });
      return res.payment;
    });
    setCreateOpen(false);
  }

  const canRefresh =
    selected &&
    (selected.state === "SUBMITTED" ||
      selected.state === "PROCESSING" ||
      selected.state === "SAFE" ||
      selected.state === "TIMEOUT");

  return (
    <AppShell
      activeRoute="/payments"
      title="HSP Payments"
      subtitle="Human-approved merchant payments"
      onNavigate={onNavigate}
      onRefresh={() => loadData(true)}
      refreshing={refreshing}
      headerActions={
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setConnOpen(true)}
            className="h-8 rounded-full px-3 text-xs cursor-pointer"
          >
            <Settings2 className="size-3.5" data-icon="inline-start" />
            Connect
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => setCreateOpen(true)}
            className="h-8 rounded-full px-3.5 text-xs cursor-pointer"
          >
            <Plus className="size-3.5" data-icon="inline-start" />
            New Payment
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5 lg:h-[calc(100svh-120px)] lg:overflow-hidden">
        {/* Clean Plain-English Header Strip */}
        <section className="flex shrink-0 flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h2 className="font-display text-xl font-semibold tracking-[-0.02em] text-foreground">
                Approve &amp; track merchant payments
              </h2>
              <span className="rounded-full border border-amber-500/35 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                {summary?.isMockEvidence === false ? "Live HSP" : "Simulation Mode"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Every payment requires your explicit approval before sending — completely separate
              from autonomous trading.
            </p>
          </div>
          <div className="flex items-center gap-5 text-xs text-muted-foreground">
            <span>
              Total:{" "}
              <strong className="tabular-nums-mono font-semibold text-foreground">
                {summary?.totalPayments ?? 0}
              </strong>
            </span>
            <span>
              In progress:{" "}
              <strong className="tabular-nums-mono font-semibold text-foreground">
                {summary?.inProgressCount ?? 0}
              </strong>
            </span>
            <span>
              Paid:{" "}
              <strong className="tabular-nums-mono font-semibold text-foreground">
                {summary?.countsByState.FINALIZED ?? 0}
              </strong>
            </span>
          </div>
        </section>

        {errorMsg && (
          <div className="flex shrink-0 items-center justify-between gap-3 rounded-[16px] border border-border bg-card px-5 py-3.5 text-xs text-muted-foreground">
            <div className="flex items-center gap-2.5">
              <WifiOff className="size-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConnOpen(true)}
              className="h-8 rounded-full text-xs cursor-pointer"
            >
              Connect API
            </Button>
          </div>
        )}

        {feedback && (
          <div
            className={cn(
              "shrink-0 rounded-[14px] border px-4 py-2.5 text-xs",
              feedback.kind === "ok"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-destructive/30 bg-destructive/10 text-destructive",
            )}
          >
            {feedback.text}
          </div>
        )}

        {/* Main 12-Col Spacious Split: Payment List (5) + Selected Payment & Next Step (7) */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Left 5 Cols: Payment History (internal scroll) */}
          <section className="flex min-h-0 flex-col overflow-hidden rounded-[20px] border border-border bg-card lg:col-span-5">
            <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
              <span className="text-sm font-semibold text-foreground">Payments</span>
              {summary && summary.inProgressCount > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={actionBusy}
                  onClick={() =>
                    runAction("Recovered in-progress payments", async () => {
                      await client.recoverInProgress();
                    })
                  }
                  className="h-7 rounded-full px-3 text-[11px] cursor-pointer"
                >
                  <RefreshCw className="size-3" data-icon="inline-start" />
                  Recover
                </Button>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading ? (
                <div className="p-8 text-center text-xs text-muted-foreground">
                  Loading payments…
                </div>
              ) : payments.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
                  <p className="text-sm font-medium text-foreground">No payments yet</p>
                  <p className="max-w-xs text-xs text-muted-foreground">
                    Create a draft payment to walk through preparation, explicit approval, and
                    settlement.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => setCreateOpen(true)}
                    className="mt-1 h-9 rounded-full px-4 text-xs cursor-pointer"
                  >
                    <Plus className="size-3.5" data-icon="inline-start" />
                    New Payment
                  </Button>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {payments.map((p) => {
                    const isSelected = selected?.paymentId === p.paymentId;
                    return (
                      <button
                        key={p.paymentId}
                        type="button"
                        onClick={() => setSelectedId(p.paymentId)}
                        className={cn(
                          "flex w-full items-center justify-between gap-4 px-5 py-3.5 text-left transition-colors cursor-pointer",
                          isSelected ? "bg-accent/70" : "hover:bg-accent/40",
                        )}
                      >
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="truncate text-sm font-semibold text-foreground">
                            {p.merchant}
                          </span>
                          <span className="tabular-nums-mono truncate text-xs text-muted-foreground">
                            {p.amount} {p.token} · {shortRef(p.recipient)}
                          </span>
                        </div>
                        <span
                          className={cn(
                            "shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
                            stateBadgeClass(p.state),
                          )}
                        >
                          {humanPaymentState(p.state)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          {/* Right 7 Cols: Selected Payment Detail & Next Step */}
          <aside className="flex min-h-0 flex-col overflow-y-auto rounded-[20px] border border-border bg-card p-6 lg:col-span-7">
            {selected ? (
              <div className="flex flex-col gap-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold text-foreground">{selected.merchant}</h3>
                    <p className="tabular-nums-mono text-xs text-muted-foreground">
                      {selected.paymentId}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs font-semibold",
                      stateBadgeClass(selected.state),
                    )}
                  >
                    {humanPaymentState(selected.state)}
                  </span>
                </div>

                {/* Clean Payment Summary */}
                <div className="grid grid-cols-1 gap-3 rounded-[14px] border border-border bg-background/60 p-4 text-xs sm:grid-cols-2">
                  <div>
                    <span className="text-muted-foreground">Amount</span>
                    <div className="tabular-nums-mono mt-0.5 text-sm font-semibold text-foreground">
                      {selected.amount} {selected.token}
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Settlement Ref</span>
                    <div className="tabular-nums-mono mt-0.5 truncate text-foreground">
                      {selected.txReference ?? "Pending settlement"}
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Payer</span>
                    <div className="tabular-nums-mono mt-0.5 truncate text-foreground">
                      {shortRef(selected.payer)}
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Recipient</span>
                    <div className="tabular-nums-mono mt-0.5 truncate text-foreground">
                      {shortRef(selected.recipient)}
                    </div>
                  </div>
                </div>

                {selected.failureReason && (
                  <div className="rounded-[12px] border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive">
                    <strong>{selected.failureCode}:</strong> {selected.failureReason}
                  </div>
                )}

                {/* Next Step Action */}
                <div className="flex flex-col gap-3 border-t border-border pt-4">
                  {selected.state === "CREATED" && (
                    <Button
                      type="button"
                      disabled={actionBusy}
                      onClick={() =>
                        runAction("Payment prepared", async () => {
                          const r = await client.preparePayment(selected.paymentId);
                          return r.payment;
                        })
                      }
                      className="h-10 rounded-full text-xs cursor-pointer"
                    >
                      {actionBusy && <Loader2 className="size-3.5 animate-spin" />}
                      Step 1: Prepare Payment
                    </Button>
                  )}

                  {selected.state === "PREPARED" && (
                    <div className="flex flex-col gap-3 rounded-[14px] border border-border bg-background/60 p-4">
                      <label className="flex items-start gap-2.5 text-xs text-foreground cursor-pointer">
                        <input
                          type="checkbox"
                          checked={consentChecked}
                          onChange={(e) => setConsentChecked(e.target.checked)}
                          className="mt-0.5"
                        />
                        <span>
                          I explicitly approve paying{" "}
                          <strong>
                            {selected.amount} {selected.token}
                          </strong>{" "}
                          to <strong>{selected.merchant}</strong> ({shortRef(selected.recipient)}).
                        </span>
                      </label>
                      <Input
                        value={authorizedBy}
                        onChange={(e) => setAuthorizedBy(e.target.value)}
                        placeholder="Your name or operator ID"
                        className="h-9 text-xs"
                      />
                      <Button
                        type="button"
                        disabled={actionBusy || !consentChecked || !authorizedBy.trim()}
                        onClick={() =>
                          runAction("Payment explicitly authorized", async () => {
                            const r = await client.authorizePayment(selected.paymentId, {
                              explicitUserConsent: true,
                              authorizedBy: authorizedBy.trim(),
                            });
                            return r.payment;
                          })
                        }
                        className="h-10 rounded-full text-xs cursor-pointer"
                      >
                        <ShieldCheck className="size-3.5" data-icon="inline-start" />
                        Step 2: Confirm Approval
                      </Button>
                    </div>
                  )}

                  {selected.state === "AUTHORIZED" && (
                    <Button
                      type="button"
                      disabled={actionBusy}
                      onClick={() =>
                        runAction("Authorized payment submitted", async () => {
                          const r = await client.submitPayment(selected.paymentId);
                          return r.payment;
                        })
                      }
                      className="h-10 rounded-full text-xs cursor-pointer"
                    >
                      <CreditCard className="size-3.5" data-icon="inline-start" />
                      Step 3: Send Approved Payment
                    </Button>
                  )}

                  {canRefresh && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={actionBusy}
                      onClick={() =>
                        runAction("Payment status refreshed", async () => {
                          const r = await client.refreshPayment(selected.paymentId);
                          return r.payment;
                        })
                      }
                      className="h-10 rounded-full text-xs cursor-pointer"
                    >
                      <RefreshCw className="size-3.5" data-icon="inline-start" />
                      Check Settlement Status
                    </Button>
                  )}

                  {selected.state === "FINALIZED" && (
                    <div className="inline-flex items-center gap-2 text-xs font-medium text-emerald-500">
                      <CheckCircle2 className="size-4" />
                      Payment settled and finalized
                    </div>
                  )}
                </div>

                {/* Compact Audit Trail */}
                <div className="border-t border-border pt-4">
                  <span className="text-xs font-medium text-muted-foreground">History</span>
                  <div className="mt-2 flex flex-col gap-2">
                    {selected.history.map((h, i) => (
                      <div
                        key={`${h.timestamp}-${i}`}
                        className="flex items-start justify-between gap-3 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <Clock className="size-3 shrink-0 text-muted-foreground" />
                          <span className="font-medium text-foreground">
                            {humanPaymentState(h.toState)}
                          </span>
                          {h.detail && (
                            <span className="text-muted-foreground">— {h.detail}</span>
                          )}
                        </div>
                        <span className="tabular-nums-mono shrink-0 text-[11px] text-muted-foreground">
                          {new Date(h.timestamp * 1000).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <p className="text-sm font-medium text-foreground">Select a payment</p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  Choose a payment on the left to inspect its details and take the next step, or
                  click New Payment to create one.
                </p>
              </div>
            )}
          </aside>
        </div>
      </div>

      {/* New Payment Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="rounded-[20px] border-border bg-card sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">New Payment Draft</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Creates a draft payment record. Nothing is sent until you explicitly approve it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 pt-2">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Merchant</label>
              <Input value={merchant} onChange={(e) => setMerchant(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Token</label>
                <Input value={token} onChange={(e) => setToken(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Amount</label>
                <Input value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Payer</label>
              <Input value={payer} onChange={(e) => setPayer(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Recipient</label>
              <Input value={recipient} onChange={(e) => setRecipient(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Memo (optional)</label>
              <Input
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="Invoice or reference"
              />
            </div>
            <Button
              type="button"
              disabled={actionBusy || !tokenInput.trim()}
              onClick={handleCreate}
              className="mt-1 h-10 w-full rounded-full text-xs font-medium cursor-pointer"
            >
              {actionBusy && <Loader2 className="size-3.5 animate-spin" />}
              Create Draft Payment
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* API Connection Dialog */}
      <Dialog open={connOpen} onOpenChange={setConnOpen}>
        <DialogContent className="rounded-[20px] border-border bg-card sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Payments API Connection</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Enter your operator API URL and Bearer token (kept in session storage only).
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 pt-2">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">API URL</label>
              <Input
                value={apiUrlInput}
                onChange={(e) => setApiUrlInput(e.target.value)}
                placeholder="https://api.tranche.space"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Operator Bearer Token</label>
              <Input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Paste API token"
              />
            </div>
            <Button
              type="button"
              onClick={saveConnection}
              className="mt-1 h-10 w-full rounded-full text-xs cursor-pointer"
            >
              Save Connection
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
