# Tranche — Frontend Design System & Product Specification (`design.md`)

> **Source of Truth:** Read this file before writing or editing any frontend component, page, token, or copy.
> **Build Rule:** Build **one screen/section at a time**. Never scaffold or ship 15 screens in one pass.
> **Brand Anchor:** Built directly around the official serrated ticket-stub logos in `assets/brand/tranche-logo-dark.png` (warm cream `#F8F7EE` stub on pure black `#000000`) and `assets/brand/tranche-logo-light.png` (jet black `#000000` stub on pure white `#FFFFFF`).

---

## 1. Product Identity

- **What is this?**
  Tranche lets traders lock on-chain token inventory at a fixed or bounded price via an ERC-721 execution ticket, while LPs earn upfront reservation premiums and settlement proceeds on segregated vault inventory.
- **What should it FEEL like?**
  **Architectural, tactile, and dead-serious.** Like an institutional execution desk fused with a physical bearer ticket stub — quiet confidence, razor-sharp typography, zero noise, zero neon crypto gimmicks.
- **Who is it for?**
  - **Traders** who want guaranteed token fill size and price certainty before committing capital, without fighting AMM slippage or MEV.
  - **Liquidity Providers (LPs)** who want to put idle ERC-20 inventory to work at their own price and earn non-refundable upfront reservation premiums.
- **What emotion should it trigger on first load?**
  *Clarity and conviction.* Within 3 seconds the user should feel: *"This isn't a toy or a template — this is real financial infrastructure, and I immediately understand what to click next."*

---

## 2. Visual Language

### Aesthetic Direction
**Apple Liquid Glass × Tranche Monochrome** — Apple's signature calm whitespace, floating translucent glass pills, optical specular highlights, and effortless spatial depth paired with Tranche's high-contrast obsidian/cream/white ticket-stub brand (`tranche-logo-dark.png` & `tranche-logo-light.png`).

- **Dark mode is the default** (deep obsidian `#050505` canvas + warm cream `#F8F7EE` accents + frosted dark glass pills), with a full-parity **Light mode** (clean `#F7F7F5` / `#FFFFFF` canvas + jet-black `#090908` accents + frosted white glass pills).
- **Zero neon crypto glows, zero cluttered dashboards.** Calm negative space, soft optical glass pills for floating navigation and controls, and razor-sharp matte surfaces for financial numbers.

### Typography
*(Strict rule: **NO Inter, NO Roboto, NO Arial — ever.**)*

| Role | Font Family | Weights | Usage |
| --- | --- | --- | --- |
| **Display / Headings** | `Archivo` | `600`, `700`, `800` | Hero headlines, section titles, card headers, wordmark alignment (`tracking: -0.03em`) |
| **Body / UI Copy** | `DM Sans` | `400`, `500`, `600` | Labels, descriptions, buttons, navigation, helper text |
| **Data / Numerals / Ledger** | `JetBrains Mono` | `400`, `500`, `600` | Prices, balances, amounts, bps, ticket IDs, countdown timers, wallet addresses, tx hashes (`font-variant-numeric: tabular-nums`) |

**Hierarchy Law (`Money -> Action -> Context`):**
1. **Primary Tier:** Key figures (price, size, balance, countdown) and H1 headlines — largest scale, highest contrast.
2. **Action Tier:** Primary CTAs (`Reserve`, `Exercise`, `Deposit`, `Launch App`) — stark inverted fill (cream on black in dark mode; black on white in light mode).
3. **Context Tier:** Token symbols, helper labels, timestamps, muted metadata — small, calm, recessed.

### Color System

#### Dark Mode (Default — Anchored to `tranche-logo-dark.png`)
| Token | Hex | Role |
| --- | --- | --- |
| `--bg-canvas` | `#050505` | Page canvas (near-true obsidian) |
| `--bg-surface` | `#0C0C0B` | Primary cards, sidebars, panels |
| `--bg-elevated` | `#141412` | Hover surfaces, inputs, dropdowns, modals |
| `--bg-subtle` | `#1C1C19` | Active pills, segmented controls, subtle fills |
| `--border-hairline` | `#1F1F1C` | Default 1px structural dividers & card strokes |
| `--border-strong` | `#32322D` | Focused inputs, interactive hover borders |
| `--fg-primary` | `#F8F7EE` | Primary text & primary button fill (warm ticket-paper cream) |
| `--fg-secondary` | `#A3A299` | Secondary copy, table labels |
| `--fg-muted` | `#66655E` | Placeholders, disabled labels, timestamps |
| `--accent-paper` | `#F8F7EE` | Signature Tranche cream (CTAs, active indicators, ticket stubs) |
| `--accent-ink` | `#050505` | Text on `--accent-paper` buttons & badges |

#### Light Mode (Parity — Anchored to `tranche-logo-light.png`)
| Token | Hex | Role |
| --- | --- | --- |
| `--bg-canvas` | `#FFFFFF` | Page canvas |
| `--bg-surface` | `#FAF9F5` | Warm paper cards & sidebars |
| `--bg-elevated` | `#F2F1EA` | Inputs, hover states |
| `--border-hairline` | `#E6E5DC` | Structural 1px borders |
| `--border-strong` | `#C7C6BC` | Hover / focus borders |
| `--fg-primary` | `#090908` | Jet-black primary ink |
| `--fg-secondary` | `#57564F` | Secondary text |
| `--fg-muted` | `#8F8E85` | Muted metadata |
| `--accent-paper` | `#090908` | Stark black primary CTA fill |
| `--accent-ink` | `#FFFFFF` | White text on black buttons |

#### Semantic Colors (Used Sparingly — Strictly for State, Never Decoration)
| Token | Dark Hex | Light Hex | Meaning |
| --- | --- | --- | --- |
| `--status-live` | `#4ADE80` | `#15803D` | Active offer, confirmed tx, `INV-1` solvent, live network |
| `--status-warn` | `#FBBF24` | `#B45309` | Expiring soon (< 5m), pending approval, testnet indicator |
| `--status-danger` | `#F87171` | `#B91C1C` | Expired, reverted tx, wrong network, cancel/revoke |

### Motion Grammar
*(Extracted from Aristide Benoist & `transitions.dev`: compositor-only properties `transform` & `opacity`, zero `transition: all`, strict `prefers-reduced-motion` compliance.)*

- **Enter (`--ease-out-expo`):** `cubic-bezier(0.22, 1, 0.36, 1)` — crisp arrival with settled weight (`280ms`–`420ms`).
- **Drawer / Dialog / Sheet (`--ease-drawer`):** `cubic-bezier(0.32, 0.72, 0, 1)` — smooth, physical slide (`300ms`).
- **Micro-interaction (`--ease-snap`):** `cubic-bezier(0.2, 0, 0, 1)` — instant hover/focus response (`120ms`–`160ms`), tactile press `active:scale-[0.985]`.
- **Stagger:** Sequential list/card reveal capped at `40ms` per item (max `240ms` total) so it never feels sluggish.
- **Numbers:** Tabular numerals only; live quote updates cross-fade opacity (`150ms`) instead of jumping layout.

### Texture & Material Language (Apple Liquid Glass Discipline)
- **Floating Glass Pills & Chrome Layer:**
  - Floating top navbar, segmented nav pill (`Trade · Tickets · Vault`), pair filter pills, network pill, wallet pill, and slide-over **Sheets** use Apple-style frosted glass:
    - **Dark glass:** `background: rgba(20, 20, 19, 0.68)`, `backdrop-filter: blur(22px) saturate(160%)`, `border: 1px solid rgba(248, 247, 238, 0.11)`, `box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.10), 0 8px 32px rgba(0, 0, 0, 0.45)`.
    - **Light glass:** `background: rgba(255, 255, 255, 0.72)`, `backdrop-filter: blur(22px) saturate(160%)`, `border: 1px solid rgba(9, 9, 8, 0.08)`, `box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 8px 28px rgba(0, 0, 0, 0.06)`.
  - Active segmented pill slides smoothly with a tactile spring-like highlight (`--ease-drawer`).
- **Content Layer (Clean Matte Surfaces):** Offers tables, vault balance cards, and forms sit on crisp, calm matte containers (`--bg-surface`, `rounded-2xl`) so financial numbers stay 100% sharp and legible while scrolling softly beneath the floating glass chrome.
- **Signature Ticket Motif (Used With Restraint):**
  - The serrated zigzag bottom edge from the Tranche logo + horizontal perforated dashed divider (`border-dashed`) is used **specifically** on `ExecutionTicket` cards and post-reservation confirmation stubs.

### Apple HIG Interaction & Disclosure Rules
- **Deference & Progressive Disclosure:** Never dump every contract parameter on screen at once.
  - On `/trade`, each offer row displays only the 5 scannable essentials: **Pair**, **Available Size**, **Price**, **Premium**, **Max Lock**. Secondary contract details (min fill, offer expiry, oracle adapter, compliance hook) reveal inside the **Reserve Sheet** on selection.
  - On `/vault` (`Create Offer`), default to a clean **Fixed Price** form; reveal **Floating (Oracle + Spread + Min/Max Bounds)** progressively only when the user selects `Floating`.
- **Sheets vs. Dialogs (Spatial Continuity):**
  - Use **Sheets** (side drawer on desktop, bottom sheet on mobile) for task-focused sub-flows (`Reserve Offer`, `Exercise Ticket`, `Deposit / Withdraw`) so the parent table remains visible behind the scrim and users never lose orientation.
  - Reserve **Dialogs** strictly for high-commitment or destructive confirmations (`Cancel Offer`, `Transfer Ticket`, `Wrong Network` gate).
- **Onboarding Restraint:** Zero forced carousels or tutorial walls. Never auto-trigger a wallet popup on `/`; request wallet connection only on `/connect` after an explicit `Launch App` click. `/start` (Role Picker) is fast, skippable, and never forced on returning sessions.
- **Legibility & Target Ergonomics:**
  - Never use font weights lighter than `400` at small sizes (`< 16px`).
  - All interactive controls (buttons, tabs, wallet/theme toggles, row triggers) maintain a minimum `40px–44px` hit target (`min-h-10` / `min-h-11`), visible keyboard focus rings, and strict `prefers-reduced-motion` fallbacks.

---

## 3. Design Tokens

### Spacing Scale (`4px` base)
- `--space-1`: `4px` | `--space-2`: `8px` | `--space-3`: `12px` | `--space-4`: `16px`
- `--space-5`: `20px` | `--space-6`: `24px` | `--space-8`: `32px` | `--space-10`: `40px`
- `--space-12`: `48px` | `--space-16`: `64px` | `--space-24`: `96px`
- **Container max-width:** `1200px` (app workspace), `1080px` (landing editorial grid), `460px` (connect wallet card), `760px` (role picker).

### Border Radius (Apple Continuous Curve Feel)
- `--radius-none`: `0px` (serrated ticket bottom edge)
- `--radius-sm`: `8px` (compact tags, mono chips)
- `--radius-md`: `12px` (inputs, secondary buttons, inner rows)
- `--radius-lg`: `18px` (standard cards, dialogs, role picker cards)
- `--radius-xl`: `24px` (hero containers, floating sheets)
- `--radius-pill`: `9999px` (glass nav bar, segmented tabs, primary pill CTAs, wallet/network/filter pills)

### Shadows
- Dark mode relies on **1px hairline borders + surface contrast**, not muddy drop shadows.
- `--shadow-dialog`: `0 24px 64px -16px rgba(0, 0, 0, 0.75)` (modals/drawers only)
- `--shadow-subtle-light`: `0 1px 2px rgba(0, 0, 0, 0.05)` (light mode cards)

### Durations
- `--dur-fast`: `140ms` (hovers, button press, focus ring)
- `--dur-base`: `240ms` (tabs, tooltips, dropdowns)
- `--dur-slow`: `380ms` (page/view entrances, drawers)

---

## 4. Copy Voice

- **Tone:** Direct, calm, precise, human. Written like a sharp trader or engineer explaining a tool to a peer — not a marketing intern.
- **Rules:**
  - Lead with the concrete action and numbers (`Lock 0.01 tWETH at $3,000 for 10m`).
  - Every irreversible cost is stated plainly before signing (`Upfront premium is non-refundable if the ticket expires`).
  - Error messages tell the user exactly what happened and how to fix it (`Switch to HashKey Chain Testnet (133) to continue`).
- **What Tranche NEVER says:**
  - No hype words: *"revolutionary"*, *"next-gen"*, *"paradigm shift"*, *"democratizing"*, *"unlock the power of"*, *"institutional-grade"* (show it via craft, don't claim it), *"seamless"*, *"supercharge"*, *"LFG"*, *"wagmi"*.
  - No fake urgency or artificial APY banners.
  - No exclamation marks in buttons or headings.

---

## 5. User Flow

### Exact Navigation & Onboarding Path
```text
Landing (/)
   │  [Launch App]
   ▼
Connect Wallet (/connect)   ◄── Auto-skipped if already connected on active chain
   │  1. Connect EIP-1193 wallet (MetaMask / Rabby / OKX)
   │  2. Auto-prompt switch/add HashKey Chain (133 testnet / 177 mainnet)
   ▼
Choose Your Role (/start)   ◄── Shown once for first-time users (saved in localStorage)
   ├── "Trade & Reserve"    ──► App Workspace: /trade  (default Trader view)
   └── "Provide Liquidity"  ──► App Workspace: /vault  (default LP view)
```

### App Workspace Shell (Persistent Top Bar / Sidebar)
- **Brand mark** (`tranche` ticket logo, links to `/`)
- **3 Primary Views:**
  1. **`Trade`** (`/trade`) — Browse live on-chain offers, pick one, quote reservation, `Approve & Reserve` → mints `ExecutionTicket`.
  2. **`Tickets`** (`/tickets`) — Shows active count badge (e.g., `1`). View owned ERC-721 tickets with live countdowns → `Approve & Exercise` (partial or full), `Split`, `Transfer`, or `Reclaim Expired`.
  3. **`Vault`** (`/vault`) — LP balance breakdown (`Free`, `In Offers`, `Pending Proceeds`) → `Deposit`, `Withdraw`, `Create Offer` (`FIXED` / `FLOATING`), `Cancel Offer`, `Claim Proceeds`.
- **Right Utility Cluster:** Network pill (`HashKey Testnet 133` / `Mainnet 177`), Theme toggle (Dark / Light), Connected wallet pill (address, HSK balance, disconnect/switch).

### Critical Paths & Key Decision Points
1. **Network gate:** User on wrong chain → single-click `Switch to HashKey Chain` button before any write action.
2. **Allowance gate:** Every write (`Deposit`, `Reserve`, `Exercise`) checks ERC-20 allowance live and cleanly sequences `1. Approve token` → `2. Confirm transaction` with Explorer tx link.
3. **Expiry clarity:** Every ticket card displays exact time remaining (`mm:ss`) in tabular monospace and clearly switches from `Exercise` to `Expired — Reclaim` once elapsed.

---

## 6. Screen Inventory (Strict One-at-a-Time Build Order)

Build, verify visually, and approve each screen before starting the next:

| Priority | Screen / Unit | Scope |
| --- | --- | --- |
| **0** | **Foundation (`web/` + shadcn/ui + tokens + network config)** | Vite + React + TS + Tailwind v4, `Archivo` + `DM Sans` + `JetBrains Mono`, shadcn/ui primitives (`button`, `card`, `badge`, `dialog`, `sidebar`, `input`, `label`, `select`, `tabs`, `table`, `separator`, `sheet`, `tooltip`, `skeleton`), Dark/Light theme provider, single manifest-driven `networks.ts` (`hashkey-testnet.json` → `hashkey-mainnet.json`), EIP-1193 wallet provider. |
| **1** | **Screen 1 — Landing (`/`)** | Minimal top bar (`tranche` logo + Theme toggle + `Launch App`), editorial hero with live on-chain protocol strip (active offers, vault depth, solvency status), 3-step visual (`Reserve` → `Hold Ticket` → `Exercise`), footer with live contract links. |
| **2** | **Screen 2 — Connect Wallet (`/connect`)** | Centered high-contrast card for first-time users, wallet connector buttons (MetaMask / Rabby / OKX / Injected), chain switch prompt (`133` testnet / `177` mainnet), clean auto-advance once ready. |
| **3** | **Screen 3 — Role Picker (`/start`)** | Two large tactile cards (`Trade & Reserve` vs. `Provide Liquidity`), remembers preference in `localStorage`, lets returning users bypass straight into the app. |
| **4** | **Screen 4 — App Shell + `Trade` (`/trade`)** | Persistent navigation + live offers table (pair filter, FIXED/FLOATING badges, available size, price, premium bps) + slide-over/side reservation panel (`quoteReservation` → `Approve` → `Reserve` → ticket confirmation stub). |
| **5** | **Screen 5 — `Tickets` (`/tickets`)** | Serrated ticket-stub cards for owned ERC-721 `ExecutionTicket`s, live tabular countdowns, `quoteExercise`, partial/full `Exercise` dialog, `Split` & `Transfer` dialogs, `Reclaim Expired`. |
| **6** | **Screen 6 — `Vault` (`/vault`)** | LP balance strip (`Free`, `Committed`, `Proceeds`), `Deposit` / `Withdraw` modals, `Create Offer` flow (`FIXED` & `FLOATING`), active offers table with `Cancel`, `Claim Proceeds`. |

---

## 7. Mainnet Swap Architecture (Zero UI Code Changes)

- All contract addresses, token lists, RPC URLs, chain IDs, and explorer base URLs live strictly in `web/src/config/networks.ts`, imported from:
  - `deployments/hashkey-testnet.json` (`Chain ID 133` — live today)
  - `deployments/hashkey-mainnet.json` (`Chain ID 177` — drop-in swap)
- Switching from testnet to mainnet requires **only** populating mainnet addresses in `deployments/hashkey-mainnet.json` and setting `VITE_DEFAULT_NETWORK=mainnet`. No component, hook, or screen code changes.
