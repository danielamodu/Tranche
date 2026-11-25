import { ArrowLeft, ArrowUpRight, CheckCircle2, ShieldCheck } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { TrancheLogo } from "@/components/TrancheLogo";
import { ACTIVE_NETWORK, explorerAddressUrl } from "@/config/networks";
import type { AppRoute } from "@/App";

interface DocsPageProps {
  onNavigate: (path: AppRoute) => void;
}

const TOC = [
  { id: "agent", label: "01 · Tranche Agent" },
  { id: "overview", label: "02 · Protocol Overview" },
  { id: "lifecycle", label: "03 · Execution Lifecycle" },
  { id: "pricing", label: "04 · Pricing & Fee Math" },
  { id: "invariants", label: "05 · Vault Invariants" },
  { id: "governance", label: "06 · Governance & Roles" },
  { id: "deployments", label: "07 · Contract Addresses" },
] as const;

const DEPLOYED_ROWS = [
  { name: "LiquidityVault", role: "Segregated ERC-20 vault (Verified)", addr: ACTIVE_NETWORK.contracts.liquidityVault },
  { name: "CommitmentManager", role: "Offers, reservations, exercise & reclaim", addr: ACTIVE_NETWORK.contracts.commitmentManager },
  { name: "ExecutionTicket", role: "ERC-721 bearer ticket + EIP-712 permit", addr: ACTIVE_NETWORK.contracts.executionTicket },
  { name: "ExecutionRouter", role: "Batch multi-ticket exercise & WHSK unwrap", addr: ACTIVE_NETWORK.contracts.executionRouter },
  { name: "SignedPullOracle", role: "2-of-3 quorum EIP-712 price oracle", addr: ACTIVE_NETWORK.contracts.signedPullOracle },
  { name: "OraclePriceAdapter", role: "Staleness, jump & hard price bounds", addr: ACTIVE_NETWORK.contracts.oraclePriceAdapter },
  { name: "UniswapV3TwapOracle", role: "HSKSwap V3 30-minute TWAP oracle adapter", addr: ACTIVE_NETWORK.contracts.uniswapV3TwapOracle },
  { name: "HSPComplianceHook", role: "Optional view-only EIP-712 compliance hook", addr: ACTIVE_NETWORK.contracts.hspComplianceHook },
  { name: "TimelockController", role: "Sole owner of all 6 admin contracts", addr: ACTIVE_NETWORK.contracts.timelock },
  { name: "Governance Safe (3/5)", role: "Timelock proposer & executor", addr: ACTIVE_NETWORK.contracts.govSafe },
  { name: "Guardian Safe (2/3)", role: "Emergency pause & timelock veto only", addr: ACTIVE_NETWORK.contracts.guardianSafe },
  { name: "Treasury Safe (2/3)", role: "Protocol fee collector", addr: ACTIVE_NETWORK.contracts.treasurySafe },
] as const;

export function DocsPage({ onNavigate }: DocsPageProps) {
  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
      {/* Floating Apple Glass Topbar */}
      <header className="fixed inset-x-0 top-5 z-40 px-4">
        <nav className="glass-pill mx-auto flex h-14 max-w-[1080px] items-center justify-between rounded-full px-4">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => onNavigate("/")}
              aria-label="Tranche home"
              className="inline-flex items-center rounded-full py-1 transition-opacity hover:opacity-80 cursor-pointer"
            >
              <TrancheLogo />
            </button>
            <Separator orientation="vertical" className="h-4" />
            <span className="tabular-nums-mono text-xs text-foreground">Documentation</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onNavigate("/agent")}
              className="rounded-full px-3.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground cursor-pointer"
            >
              Agent Console
            </button>
            <button
              type="button"
              onClick={() => onNavigate("/privacy")}
              className="rounded-full px-3.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground cursor-pointer"
            >
              Privacy
            </button>
            <button
              type="button"
              onClick={() => onNavigate("/")}
              className="glass-pill glass-pill-interactive inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-xs font-medium text-foreground cursor-pointer"
            >
              <ArrowLeft className="size-3.5" />
              Back to Home
            </button>
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-[1080px] px-6 pt-36 pb-32">
        <div className="grid grid-cols-1 gap-14 lg:grid-cols-12">
          {/* Sticky Left TOC */}
          <aside className="hidden lg:col-span-3 lg:block">
            <div className="sticky top-28 flex flex-col gap-2">
              <span className="tabular-nums-mono mb-2 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                On this page
              </span>
              {TOC.map((item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  className="rounded-lg px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                >
                  {item.label}
                </a>
              ))}
            </div>
          </aside>

          {/* Main Technical Documentation */}
          <article className="flex flex-col gap-20 lg:col-span-9">
            {/* Title */}
            <header className="flex flex-col gap-5 border-b border-border pb-12">
              <span className="tabular-nums-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
                Tranche · Technical Reference
              </span>
              <h1 className="font-display text-4xl font-semibold leading-[1.02] tracking-[-0.04em] sm:text-5xl">
                Programmable Execution Infrastructure &amp; Tranche Agent
              </h1>
              <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
                Tranche is programmable execution infrastructure for autonomous trading on{" "}
                {ACTIVE_NETWORK.name} (Chain ID {ACTIVE_NETWORK.chainId}). Its first application,{" "}
                <strong className="font-medium text-foreground">Tranche Agent</strong>, routes
                deterministically across inventory-backed Tranche Protocol offers and HSKSwap V3
                pools under code-enforced risk controls.
              </p>
            </header>

            {/* 01 Tranche Agent */}
            <section id="agent" className="scroll-mt-28 flex flex-col gap-5">
              <span className="tabular-nums-mono text-xs text-muted-foreground">
                01 · TRANCHE AGENT ARCHITECTURE
              </span>
              <h2 className="font-display text-2xl font-semibold sm:text-3xl">
                Dual-venue autonomous routing with deterministic risk enforcement
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">
                Tranche Agent runs a continuous decision loop that reads live HSKSwap V3 quotes,
                30-minute TWAP prices, oracle freshness, and available LiquidityVault offers. On
                every cycle, it compares gas-adjusted execution economics and selects{" "}
                <code className="tabular-nums-mono text-xs text-foreground">TRANCHE</code>,{" "}
                <code className="tabular-nums-mono text-xs text-foreground">HSKSWAP</code>, or{" "}
                <code className="tabular-nums-mono text-xs text-foreground">NONE</code>.
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="rounded-[18px] border border-border bg-card p-6">
                  <h3 className="text-sm font-semibold text-foreground">
                    Deterministic RiskManager &amp; Kill Switch
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    Position size caps, total exposure ceilings, daily realized loss limits,
                    oracle staleness/deviation checks, and an authoritative kill switch are
                    enforced in TypeScript before any transaction is prepared. Corrupted persisted
                    state or unresolved pending transactions fail closed.
                  </p>
                </div>
                <div className="rounded-[18px] border border-border bg-card p-6">
                  <h3 className="text-sm font-semibold text-foreground">
                    Bounded LLM Policy Translation &amp; Operating Modes
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    Optional natural-language instructions only produce validated policy patches
                    checked against hard ceilings, persisted with versioned history and rollback.
                    The LLM can never sign transactions, bypass RiskManager, or clear the kill
                    switch. The runtime supports <code className="font-mono text-xs">fixture</code>,{" "}
                    <code className="font-mono text-xs">dry_run</code> (default), and local Chain
                    177 <code className="font-mono text-xs">fork</code> modes.
                  </p>
                </div>
              </div>
            </section>

            {/* 02 Overview */}
            <section id="overview" className="scroll-mt-28 flex flex-col gap-5">
              <span className="tabular-nums-mono text-xs text-muted-foreground">02 · OVERVIEW</span>
              <h2 className="font-display text-2xl font-semibold sm:text-3xl">
                Why reservation tickets instead of an AMM curve
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">
                Automated market makers price every trade along a bonding curve at broadcast time,
                exposing larger fills to price impact and MEV. Tranche separates{" "}
                <strong className="font-medium text-foreground">inventory commitment</strong> from{" "}
                <strong className="font-medium text-foreground">final settlement</strong>:
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="rounded-[18px] border border-border bg-card p-6">
                  <h3 className="text-sm font-semibold text-foreground">For Traders</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    Pay a small upfront premium to exclusively lock exact token inventory for a
                    defined window. Exercise partially or in full at the agreed price — zero curve
                    slippage.
                  </p>
                </div>
                <div className="rounded-[18px] border border-border bg-card p-6">
                  <h3 className="text-sm font-semibold text-foreground">For LPs</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    Quote inventory at fixed strikes or oracle-bounded spreads. Collect upfront
                    non-refundable premiums immediately and withdraw uncommitted inventory anytime.
                  </p>
                </div>
              </div>
            </section>

            {/* 03 Lifecycle */}
            <section id="lifecycle" className="scroll-mt-28 flex flex-col gap-5">
              <span className="tabular-nums-mono text-xs text-muted-foreground">
                03 · EXECUTION LIFECYCLE
              </span>
              <h2 className="font-display text-2xl font-semibold sm:text-3xl">
                End-to-end state transitions
              </h2>
              <div className="overflow-hidden rounded-[20px] border border-border bg-card">
                {[
                  {
                    step: "1. Deposit",
                    fn: "LiquidityVault.deposit(token, amount)",
                    desc: "Transfers ERC-20 tokens into the vault and credits the LP's free balance (rejects fee-on-transfer tokens).",
                  },
                  {
                    step: "2. Create Offer",
                    fn: "CommitmentManager.createOffer(params)",
                    desc: "Moves inventory from lpFreeBalance to offerBalance with minFillAmount, duration bounds, premium bps, and FIXED or FLOATING pricing.",
                  },
                  {
                    step: "3. Reserve",
                    fn: "CommitmentManager.reserve(offerId, amount, duration, maxPremium, recipient)",
                    desc: "Collects upfront premium (minus protocol fee), locks inventory into ticketReserved, and mints an ERC-721 ExecutionTicket.",
                  },
                  {
                    step: "4. Exercise",
                    fn: "CommitmentManager.exercise(ticketId, fillAmount, maxPayment, receiver)",
                    desc: "Settles payment token to LP pending proceeds (minus protocol fee) and delivers exact reserved inventory. Supports partial fills and ExecutionRouter batching.",
                  },
                  {
                    step: "5. Reclaim / Claim",
                    fn: "reclaimExpired(ticketId) · claimProceeds(token, amount, to)",
                    desc: "Expired tickets release inventory back to the LP; LPs pull earned proceeds and free inventory directly at any time.",
                  },
                ].map((row, idx) => (
                  <div key={row.step}>
                    {idx > 0 && <Separator />}
                    <div className="flex flex-col gap-1.5 px-6 py-5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-foreground">{row.step}</span>
                        <code className="tabular-nums-mono rounded-md bg-accent/70 px-2 py-0.5 text-[11px] text-foreground">
                          {row.fn}
                        </code>
                      </div>
                      <p className="text-sm leading-relaxed text-muted-foreground">{row.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* 04 Pricing & Fees */}
            <section id="pricing" className="scroll-mt-28 flex flex-col gap-5">
              <span className="tabular-nums-mono text-xs text-muted-foreground">
                04 · PRICING &amp; FEE MATH
              </span>
              <h2 className="font-display text-2xl font-semibold sm:text-3xl">
                Fixed strike, floating oracle, and 5 bps fee accounting
              </h2>
              <div className="flex flex-col gap-4 rounded-[20px] border border-border bg-card p-6">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Gross Exercise Payment (1e36 Fixed-Point Scaling)
                  </span>
                  <code className="tabular-nums-mono text-xs leading-relaxed text-foreground sm:text-sm">
                    grossPayment = ceil(fillAmount × effectivePriceX36 / 1e36)
                  </code>
                </div>
                <Separator />
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Floating Price Mode
                  </span>
                  <code className="tabular-nums-mono text-xs leading-relaxed text-foreground sm:text-sm">
                    effectivePriceX36 = clamp(ceil(oraclePriceX36 × (10000 + spreadBps) / 10000),
                    minPriceX36, maxPriceX36)
                  </code>
                </div>
                <Separator />
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Protocol Fee (5 bps = 0.05%, hard-capped at 100 bps)
                  </span>
                  <code className="tabular-nums-mono text-xs leading-relaxed text-foreground sm:text-sm">
                    protocolFee = floor(grossAmount × protocolFeeBps / 10000) · lpNet = grossAmount
                    − protocolFee
                  </code>
                </div>
              </div>
            </section>

            {/* 05 Invariants */}
            <section id="invariants" className="scroll-mt-28 flex flex-col gap-5">
              <span className="tabular-nums-mono text-xs text-muted-foreground">
                05 · VAULT INVARIANTS
              </span>
              <h2 className="font-display text-2xl font-semibold sm:text-3xl">
                Enforced on-chain guarantees
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2 rounded-[18px] border border-border bg-card p-6">
                  <span className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
                    <CheckCircle2 className="size-4 text-status-live" />
                    INV-1 · Physical Solvency
                  </span>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    For every token, physical ERC-20 balance in LiquidityVault is always greater
                    than or equal to the sum of all five segregated buckets.
                  </p>
                </div>
                <div className="flex flex-col gap-2 rounded-[18px] border border-border bg-card p-6">
                  <span className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
                    <ShieldCheck className="size-4 text-status-live" />
                    INV-8 · Exit Liveness
                  </span>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Optional compliance hooks are never invoked on LP withdrawals, proceeds claims,
                    offer cancellations, or expired ticket reclaims.
                  </p>
                </div>
              </div>
            </section>

            {/* 06 Governance */}
            <section id="governance" className="scroll-mt-28 flex flex-col gap-5">
              <span className="tabular-nums-mono text-xs text-muted-foreground">
                06 · GOVERNANCE &amp; ROLES
              </span>
              <h2 className="font-display text-2xl font-semibold sm:text-3xl">
                Zero EOA admin keys
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">
                All six admin-gated contracts (LiquidityVault, CommitmentManager, SignedPullOracle,
                OraclePriceAdapter, UniswapV3TwapOracle, and HSPComplianceHook) are owned solely by{" "}
                <strong className="font-medium text-foreground">TimelockController</strong>. The
                deployer&apos;s <code className="tabular-nums-mono text-xs">DEFAULT_ADMIN_ROLE</code>{" "}
                has been renounced on-chain. Proposals require a 3-of-5 Governance Safe quorum and
                can be vetoed during the timelock window by the 2-of-3 Guardian Safe.
              </p>
            </section>

            {/* 07 Deployments */}
            <section id="deployments" className="scroll-mt-28 flex flex-col gap-5">
              <span className="tabular-nums-mono text-xs text-muted-foreground">
                07 · CONTRACT ADDRESSES ({ACTIVE_NETWORK.name.toUpperCase()})
              </span>
              <h2 className="font-display text-2xl font-semibold sm:text-3xl">
                {ACTIVE_NETWORK.isLive
                  ? `Live Chain ${ACTIVE_NETWORK.chainId} manifest`
                  : `Chain ${ACTIVE_NETWORK.chainId} manifest (deployment pending)`}
              </h2>
              <div className="overflow-hidden rounded-[20px] border border-border bg-card">
                {DEPLOYED_ROWS.map((row, idx) => (
                  <div key={row.name}>
                    {idx > 0 && <Separator />}
                    {ACTIVE_NETWORK.isLive ? (
                      <a
                        href={explorerAddressUrl(row.addr)}
                        target="_blank"
                        rel="noreferrer"
                        className="group flex flex-col justify-between gap-1.5 px-6 py-4 transition-colors hover:bg-accent/50 sm:flex-row sm:items-center"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-sm font-medium text-foreground">{row.name}</span>
                          <span className="text-xs text-muted-foreground">{row.role}</span>
                        </div>
                        <span className="tabular-nums-mono inline-flex items-center gap-1.5 text-xs text-muted-foreground group-hover:text-foreground">
                          {row.addr.slice(0, 10)}…{row.addr.slice(-6)}
                          <ArrowUpRight className="size-3.5" />
                        </span>
                      </a>
                    ) : (
                      <div className="flex flex-col justify-between gap-1.5 px-6 py-4 sm:flex-row sm:items-center">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-sm font-medium text-foreground">{row.name}</span>
                          <span className="text-xs text-muted-foreground">{row.role}</span>
                        </div>
                        <span className="tabular-nums-mono text-xs text-muted-foreground">
                          Pending deployment
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </article>
        </div>
      </main>
    </div>
  );
}
