import { ArrowLeft } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { TrancheLogo } from "@/components/TrancheLogo";
import { ACTIVE_NETWORK } from "@/config/networks";

interface TermsPageProps {
  onNavigate: (path: "/" | "/docs" | "/privacy" | "/terms") => void;
}

const TERMS_SECTIONS = [
  {
    num: "01",
    title: "Interface Access & Non-Custodial Scope",
    body: "Tranche provides a client-side web interface for interacting with autonomous smart contracts deployed on HashKey Chain. Tranche is not a broker, exchange, custodian, fiduciary, or counterparty to any reservation, offer, or settlement executed on-chain. You retain sole control and responsibility over your wallet, private keys, and signed transactions.",
  },
  {
    num: "02",
    title: "Non-Refundable Reservation Premiums & Expiry",
    body: "Reserving liquidity on Tranche requires paying an upfront reservation premium in the offer's payment token. All reservation premiums are final and non-refundable regardless of whether you exercise the resulting ERC-721 Execution Ticket before expiry. Unexercised tickets expire automatically and reserved inventory becomes reclaimable by the liquidity provider or any keeper.",
  },
  {
    num: "03",
    title: "Pricing Modes, Oracles & Market Risk",
    body: "Offers execute under either FIXED pricing (locked strike at creation) or FLOATING pricing (derived from an approved on-chain oracle plus LP spread, bounded by configured min/max guardrails). Oracle staleness, price jump limits, or emergency guardian pauses may temporarily prevent floating-price exercises while leaving fixed-price settlements, LP withdrawals, and expired ticket reclaims unaffected.",
  },
  {
    num: "04",
    title: "Testnet & Experimental Deployment Notice",
    body: `The current live deployment operates on ${ACTIVE_NETWORK.name} (Chain ID ${ACTIVE_NETWORK.chainId}) using testnet tokens (tWETH, tUSDT, tWBTC, WHSK) intended for operational validation and testing. Smart contracts involve inherent technical risks, including potential vulnerabilities, RPC downtime, or network congestion. Never commit funds you cannot afford to lose.`,
  },
  {
    num: "05",
    title: "Protocol Fees & Immutable On-Chain Governance",
    body: "Confirmed reservations and exercises accrue a protocol fee (currently 0.05% / 5 bps, hard-capped on-chain at 1.00% / 100 bps) routed to the segregated protocolFees bucket. Administrative parameters are governed exclusively by TimelockController and multi-signature Safes; no single EOA holds administrative privileges.",
  },
  {
    num: "06",
    title: "Eligibility & Compliance",
    body: "You represent that you are legally permitted to access decentralized smart contract interfaces in your jurisdiction and are not subject to applicable sanctions or restricted-party lists. Individual liquidity offers may enforce an optional on-chain HSPComplianceHook requiring a valid EIP-712 compliance attestation.",
  },
  {
    num: "07",
    title: "No Warranties & Limitation of Liability",
    body: "The interface and underlying open-source smart contracts are provided \"as is\" and \"as available\" without warranties of any kind, express or implied. To the maximum extent permitted by law, contributors to Tranche Protocol shall not be liable for any direct, indirect, incidental, or consequential damages arising from your use of the interface or smart contracts.",
  },
] as const;

export function TermsPage({ onNavigate }: TermsPageProps) {
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
            <span className="tabular-nums-mono text-xs text-foreground">Terms of Use</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onNavigate("/docs")}
              className="rounded-full px-3.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground cursor-pointer"
            >
              Docs
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

      <main className="mx-auto max-w-[780px] px-6 pt-36 pb-32">
        <header className="flex flex-col gap-5 border-b border-border pb-12">
          <span className="tabular-nums-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
            Terms of Use · Last Updated November 2026
          </span>
          <h1 className="font-display text-4xl font-semibold leading-[1.02] tracking-[-0.04em] sm:text-5xl">
            Plain terms for an on-chain protocol.
          </h1>
          <p className="text-base leading-relaxed text-muted-foreground">
            By accessing this interface or signing transactions against Tranche smart contracts,
            you agree to the terms and risk disclosures below.
          </p>
        </header>

        <div className="mt-12 flex flex-col">
          {TERMS_SECTIONS.map((sec, idx) => (
            <section
              key={sec.num}
              className={idx > 0 ? "border-t border-border py-10" : "pb-10"}
            >
              <div className="flex flex-col gap-3">
                <span className="tabular-nums-mono text-xs text-muted-foreground">{sec.num}</span>
                <h2 className="font-display text-xl font-semibold text-foreground sm:text-2xl">
                  {sec.title}
                </h2>
                <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">
                  {sec.body}
                </p>
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
