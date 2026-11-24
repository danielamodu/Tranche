import { ArrowLeft } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { TrancheLogo } from "@/components/TrancheLogo";
import { ACTIVE_NETWORK } from "@/config/networks";

interface PrivacyPageProps {
  onNavigate: (path: "/" | "/docs" | "/privacy" | "/terms") => void;
}

const SECTIONS = [
  {
    num: "01",
    title: "Non-Custodial Protocol Interface",
    body: "Tranche is a static client-side web interface that reads from and submits signed transactions to immutable smart contracts deployed on HashKey Chain. We never take custody of your funds, never receive or store your private keys or seed phrases, and cannot reverse, freeze, or alter confirmed on-chain transactions.",
  },
  {
    num: "02",
    title: "Data We Do Not Collect",
    body: "This interface does not require accounts, email addresses, passwords, or personal profiles. We do not embed third-party advertising trackers, behavioral analytics scripts, session-replay SDKs, or cross-site tracking cookies.",
  },
  {
    num: "03",
    title: "Public Blockchain Data",
    body: "When you interact with Tranche smart contracts (depositing inventory, creating offers, reserving or exercising ERC-721 Execution Tickets, or claiming proceeds), your wallet address, transaction payloads, and token amounts are broadcast permanently to the public HashKey Chain ledger. Blockchain data is public by design and cannot be deleted or modified by Tranche.",
  },
  {
    num: "04",
    title: "Local Browser Storage",
    body: "We store minimal, non-identifying interface preferences locally in your browser's localStorage (such as your chosen onboarding role — Trader or Liquidity Provider — so returning visits skip the role picker). This data never leaves your device and can be cleared anytime through your browser settings.",
  },
  {
    num: "05",
    title: "Third-Party RPC, Explorer & Wallet Providers",
    body: `To display live block height, vault balances, and contract state, your browser sends standard JSON-RPC read requests directly to HashKey Chain RPC endpoints (${ACTIVE_NETWORK.rpcUrls.join(", ")}). When you connect a wallet (such as MetaMask, Rabby, or OKX Wallet) or open links to Blockscout (${ACTIVE_NETWORK.explorerUrl}), those providers operate under their own privacy policies and may log IP addresses or request metadata.`,
  },
  {
    num: "06",
    title: "Optional Compliance Attestations",
    body: "Certain liquidity offers may opt into an on-chain compliance hook (HSPComplianceHook) that checks revocable EIP-712 attestations. Attestation status is stored on-chain strictly as a boolean expiry timestamp per wallet address; no personal identity documents are transmitted through or stored by this interface.",
  },
  {
    num: "07",
    title: "Updates to This Policy",
    body: "As Tranche transitions from HashKey Chain Testnet (Chain ID 133) to HashKey Chain Mainnet (Chain ID 177), we may update this policy to reflect new RPC endpoints or interface capabilities. Material changes will be reflected in the revision date at the top of this page.",
  },
] as const;

export function PrivacyPage({ onNavigate }: PrivacyPageProps) {
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
            <span className="tabular-nums-mono text-xs text-foreground">Privacy</span>
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
            Privacy Policy · Last Updated November 2026
          </span>
          <h1 className="font-display text-4xl font-semibold leading-[1.02] tracking-[-0.04em] sm:text-5xl">
            Minimal footprint. Non-custodial by design.
          </h1>
          <p className="text-base leading-relaxed text-muted-foreground">
            Tranche is a direct interface to on-chain smart contracts. Here is a plain-English
            accounting of what stays on your device, what goes on-chain, and what we never collect.
          </p>
        </header>

        <div className="mt-12 flex flex-col">
          {SECTIONS.map((sec, idx) => (
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
