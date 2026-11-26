import { useState } from "react";
import { Check, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProtocolActivitySnapshot, ProtocolProposalStatus } from "@/lib/agentApi";
import { cn } from "@/lib/utils";

interface ProtocolActivityPanelProps {
  activity: ProtocolActivitySnapshot | null;
  onApprove?: (proposalId: string, bindingHash: string) => Promise<void>;
  onReject?: (proposalId: string) => Promise<void>;
}

function statusPillClass(status: ProtocolProposalStatus): string {
  if (status === "CONFIRMED") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-500";
  if (status === "APPROVED" || status === "SUBMITTED") {
    return "border-blue-500/30 bg-blue-500/10 text-blue-500";
  }
  if (status === "REJECTED" || status === "FAILED" || status === "EXPIRED") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  return "border-amber-500/30 bg-amber-500/10 text-amber-500";
}

export function ProtocolActivityPanel({
  activity,
  onApprove,
  onReject,
}: ProtocolActivityPanelProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  if (!activity) return null;

  return (
    <section className="flex flex-col gap-4 rounded-[18px] border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            Protocol Activity &amp; User Approvals
          </h3>
          <p className="text-xs text-muted-foreground">
            Autonomous reads &amp; venue comparisons; explicit parameter-bound user approval
            required before any on-chain reservation, exercise, or reclaim.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="tabular-nums-mono rounded-full border border-border bg-background px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            {activity.chainId === 133
              ? "Chain 133 — Testnet"
              : activity.chainId === 177
                ? "Chain 177 — Mainnet (Read-Only)"
                : `Chain ${activity.chainId}`}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            <ShieldCheck className="size-3 text-emerald-500" />
            {activity.readOnlyPublicView ? "Read-Only Public View" : "Approval-Gated Signing"}
          </span>
          <span className="tabular-nums-mono rounded-full border border-border bg-background px-2.5 py-0.5 text-[11px] font-medium text-foreground">
            {activity.dataProvenance}
          </span>
        </div>
      </div>

      {/* Summary Counts */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-[12px] border border-border bg-background/60 p-3">
          <span className="text-[11px] text-muted-foreground">Offers Discovered</span>
          <div className="tabular-nums-mono mt-1 text-sm font-semibold text-foreground">
            {activity.offers.length}
          </div>
        </div>
        <div className="rounded-[12px] border border-border bg-background/60 p-3">
          <span className="text-[11px] text-muted-foreground">Active Tickets</span>
          <div className="tabular-nums-mono mt-1 text-sm font-semibold text-foreground">
            {activity.tickets.filter((t) => t.status === "ACTIVE").length}
          </div>
        </div>
        <div className="rounded-[12px] border border-border bg-background/60 p-3">
          <span className="text-[11px] text-muted-foreground">Pending Approvals</span>
          <div className="tabular-nums-mono mt-1 text-sm font-semibold text-foreground">
            {activity.proposals.filter((p) => p.status === "PROPOSED").length}
          </div>
        </div>
        <div className="rounded-[12px] border border-border bg-background/60 p-3">
          <span className="text-[11px] text-muted-foreground">Latest Venue Pick</span>
          <div className="mt-1 text-sm font-semibold text-foreground">
            {activity.latestVenueDecision?.selectedVenue ?? "NONE"}
          </div>
        </div>
      </div>

      {/* Proposals Queue (clearly distinguishing Proposed / Approved / Rejected / Submitted / Confirmed) */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-foreground">Protocol Action Proposals</span>
        {activity.proposals.length === 0 ? (
          <div className="rounded-[12px] border border-dashed border-border px-4 py-5 text-center text-xs text-muted-foreground">
            No protocol action proposals recorded yet. Discovered offers and venue comparisons run
            autonomously; fund-moving actions appear here for explicit approval.
          </div>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-[12px] border border-border bg-background/50">
            {activity.proposals.map((p) => (
              <div
                key={p.proposalId}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-foreground">{p.parameters.action}</span>
                    <span
                      className={cn(
                        "tabular-nums-mono rounded-full border px-2 py-0.5 text-[10px] font-medium",
                        statusPillClass(p.status),
                      )}
                    >
                      {p.status}
                    </span>
                  </div>
                  <span className="truncate text-muted-foreground">{p.rationale}</span>
                  <span className="tabular-nums-mono text-[11px] text-muted-foreground">
                    Chain {p.parameters.chainId} · Binding {p.bindingHash.slice(0, 12)}…
                    {p.txHash ? ` · Tx ${p.txHash.slice(0, 10)}…` : ""}
                  </span>
                </div>

                {p.status === "PROPOSED" && onApprove && onReject && (
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={busyId === p.proposalId}
                      onClick={async () => {
                        setBusyId(p.proposalId);
                        try {
                          await onApprove(p.proposalId, p.bindingHash);
                        } finally {
                          setBusyId(null);
                        }
                      }}
                      className="h-8 rounded-full px-3 text-xs cursor-pointer"
                    >
                      <Check className="size-3" data-icon="inline-start" />
                      Approve
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busyId === p.proposalId}
                      onClick={async () => {
                        setBusyId(p.proposalId);
                        try {
                          await onReject(p.proposalId);
                        } finally {
                          setBusyId(null);
                        }
                      }}
                      className="h-8 rounded-full px-3 text-xs cursor-pointer"
                    >
                      <X className="size-3" data-icon="inline-start" />
                      Reject
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
