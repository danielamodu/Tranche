# Protocol Threat Model (Workstream C)

> **Scope:** Security analysis of **the protocol** (`LiquidityVault`, `CommitmentManager`, `ExecutionTicket`, `ExecutionRouter`, `OraclePriceAdapter`, and optional `IComplianceHook` / `IYieldAdapter`).  
> **Companion Documents:** [PROTOCOL_ARCHITECTURE.md](file:///c:/Users/USER/Desktop/Tranche/research/PROTOCOL_ARCHITECTURE.md), [DECISIONS.md](file:///c:/Users/USER/Desktop/Tranche/research/DECISIONS.md).

---

## 1. Assets at Risk & Security Objectives

### 1.1 Assets Held or Controlled by the Protocol
1. **`inventoryToken` in `LiquidityVault`:**
   - `lpFreeBalance` (unallocated LP deposits)
   - `offerBalance` (unreserved LP offer capacity)
   - `ticketReserved` (1:1 inventory backing active `ExecutionTicket`s)
2. **`paymentToken` in `LiquidityVault`:**
   - `lpPendingProceeds` (earned reservation premiums + exercise settlement proceeds)
   - `protocolFees` (treasury revenue)
3. **Execution Rights (`ExecutionTicket` ERC-721):**
   - Intrinsic option/execution value of in-the-money `FIXED` tickets and guaranteed-depth `FLOATING` tickets.
4. **Transient Tokens & Allowances in `ExecutionRouter`:**
   - User ERC-20 allowances (`approve` on `ExecutionRouter` / `LiquidityVault`) and ERC-721 `setApprovalForAll(executionRouter, true)` approvals.

### 1.2 Core Security Objectives
- **SO-1 (Solvency):** `LiquidityVault` ALWAYS holds liquid ERC-20 balances sufficient to cover 100% of `ticketReserved`, `lpPendingProceeds`, `protocolFees`, and (in MVP) `lpFreeBalance` + `offerBalance`.
- **SO-2 (Commitment Integrity):** Once a ticket is minted, neither the LP nor governance can revoke, alter price terms, shorten `expiresAt`, or front-run-drain the underlying `ticketReserved` before `expiresAt`.
- **SO-3 (Non-Lockup Liveness):** Unreserved LP inventory (`lpFreeBalance`, `offerBalance`), earned proceeds (`lpPendingProceeds`), and expired ticket inventory (`block.timestamp > expiresAt`) can ALWAYS be withdrawn/reclaimed regardless of pause state, oracle outages, or external `IComplianceHook` failures.
- **SO-4 (Fair Pricing & Conservation):** Rounding never leaks vault dust to attackers; fees and LP proceeds sum strictly to gross payments.

---

## 2. Trust Boundaries & Adversary Model

```
+-------------------------------------------------------------------------+
| UNTRUSTED / ADVERSARIAL BOUNDARY                                        |
|  - Arbitrary Takers, MEV Searchers, Flash-Loan Arbitrageurs             |
|  - Malicious LPs (griefing, front-running, toxic ERC-20 tokens)         |
|  - Untrusted ERC-20 tokens (if permissionlessly listed)                 |
|  - External V3 / Yield Protocols & External HSP Contracts (UNVERIFIED)  |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
| SEMI-TRUSTED / BOUNDED ADAPTERS                                         |
|  - IPriceOracle / OraclePriceAdapter (bounded by staleness + breaker)   |
|  - IComplianceHook (view-only staticcall; isolated from exits/reclaims) |
|  - Guardian (can pause NEW inflows only; zero sweep/withdrawal rights)  |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
| TRUSTED IMMUTABLE CORE                                                  |
|  - ExecutionRouter (stateless; checks ticketNft.isAuthorized(msg.sender))|
|  - CommitmentManager <-> ExecutionTicket <-> LiquidityVault             |
+-------------------------------------------------------------------------+
```

**Adversary Capabilities Considered:**
- Atomic flash loans (`HSK`, stablecoins, LP tokens) to manipulate spot AMM pools within a single block (`INFERRED` EVM capability).
- Mempool visibility / transaction ordering / sandwiching (`ASSUMED` on HashKey Chain pending Workstream A sequencer/mempool confirmation).
- Calling any public/external function in arbitrary order across reentrant hooks (`ERC-777`, `ERC-721` `onERC721Received`, malicious fallback contracts).
- Compromised or malfunctioning external adapters (`Oracle` outage/bad tick, `HSP` reverting/upgraded, `IYieldAdapter` illiquid).

---

## 3. Threat Catalog & Concrete Architectural Mitigations

### Category T1: Oracle Manipulation & Stale-Feed Exploitation

| ID | Threat & Attack Vector | Severity | Preconditions | Impact | Concrete Architectural Mitigation | Phase 2 Verification |
| --- | --- | --- | --- | --- | --- | --- |
| **T1.1** | **Flash-Loan / Spot-Pool Price Manipulation** — Attacker manipulates an AMM pool (e.g., HSKSwap V3 `slot0` `UNVERIFIED`) in a single tx, then reserves or exercises a `FLOATING` ticket at distorted price. | **Critical** | `FLOATING` offer uses spot AMM price (`slot0`) as oracle. | Drains LP inventory below fair market value (100% theft of spread/mispricing). | `OraclePriceAdapter` **forbids AMM spot (`slot0`) feeds**. Only push/pull signed feeds (Pyth/Chainlink/RedStone `UNVERIFIED`) or long-window TWAP (`>= 30m` `observe()` `UNVERIFIED`) with secondary cross-check are permitted. | Unit test rejecting spot/instantaneous price feeds; simulation of single-block pool skew against TWAP. |
| **T1.2** | **Stale Oracle / L2 Sequencer Lag Arbitrage** — Oracle stops updating during volatility or sequencer downtime; attacker exercises `FLOATING` ticket at stale pre-crash price. | **High** | `maxStaleness` too loose or unchecked; `updatedAt` unvalidated. | LP forced to sell inventory at stale off-market price. | `OraclePriceAdapter` enforces strict per-pair `maxStaleness` (`block.timestamp - updatedAt <= maxStaleness`), `updatedAt <= block.timestamp`, `price > 0`, and fails closed (`isValid = false`). Pair with `minPriceX36` LP floor on offers. | Fuzz test across stale timestamps (`updatedAt + maxStaleness + 1` must revert). |
| **T1.3** | **Oracle Latency Front-Running ("Toxic Flow")** — Taker observes a CEX price jump or pending oracle update tx in mempool (`ASSUMED`) and exercises `FLOATING` ticket at old oracle price right before update lands. | **Medium–High** | Mempool visibility or predictable oracle heartbeat; `spreadBps` too small. | LP loses oracle-lag edge on `FLOATING` fills. | 1) LPs configure `spreadBps > 0` + `minPriceX36` floor; 2) Minimum ticket duration + non-zero `basePremiumBps` taxes rapid reserve-and-exercise latency arb; 3) Optional fast pull-oracle update in `ExecutionRouter` (if Pyth `UNVERIFIED` is confirmed by Workstream A). | Economic backtest (Workstream B) sizing `spreadBps` vs. oracle update frequency. |
| **T1.4** | **Corrupted / Fat-Fingered Oracle Feed** — Primary feed reports `0`, `1 wei`, or `1000x` spike due to upstream feed bug. | **High** | Single unguarded oracle source. | Mispriced `FLOATING` fills or invalid reservation pricing. | `OraclePriceAdapter` enforces `hardMinPriceX36 <= price <= hardMaxPriceX36` AND cross-feed deviation circuit breaker (`maxDeviationBps`) against secondary feed when configured. | Unit tests for `price == 0`, out-of-bounds, and `> maxDeviationBps` divergence. |
| **T1.5** | **Oracle Outage Blocking Recovery** — Oracle goes offline past a `FLOATING` ticket's `expiresAt`. | **Medium** | Recovery path queries oracle. | LP inventory permanently locked if `reclaimExpired` needs oracle. | `reclaimExpired()` and `FIXED` exercises have **zero dependency** on `IPriceOracle`. | Integration test: broken/reverting oracle still allows `reclaimExpired()` and `FIXED` `exercise()`. |

---

### Category T2: Router, Authorization & Reentrancy Exploits

| ID | Threat & Attack Vector | Severity | Preconditions | Impact | Concrete Architectural Mitigation | Phase 2 Verification |
| --- | --- | --- | --- | --- | --- | --- |
| **T2.1** | **Confused-Deputy Ticket Theft via `ExecutionRouter`** — Victim calls `executionTicket.setApprovalForAll(router, true)` for batching. Attacker calls `router.batchExercise()` passing Victim's `ticketId`. | **Critical** | Router relies solely on `CommitmentManager` checking `msg.sender == Router` without checking `msg.sender` of Router! | Attacker exercises Victim's profitable ticket using Victim's router approval. | `ExecutionRouter.batchExercise` **MUST enforce `ticketNft.isAuthorized(msg.sender, leg.ticketId)` on every leg** before invoking `CommitmentManager.exercise`. | Adversarial test: Attacker calls `batchExercise` on Victim's ticket when Victim approved Router -> MUST revert `NotTicketAuthorized`. |
| **T2.2** | **Arbitrary `payer` Approval Drain on `LiquidityVault`** — Attacker tricks `CommitmentManager` into pulling `paymentToken` from a third party who approved `LiquidityVault`. | **Critical** | `CommitmentManager` forwards a user-supplied `payer` address to `vault.settleExercise`. | Drains arbitrary user ERC-20 balances approved to `LiquidityVault`. | `CommitmentManager` **never** accepts a `payer` parameter; it ALWAYS passes `msg.sender` to `LiquidityVault` (`payer = msg.sender`). | Static analysis / interface check + test verifying only `msg.sender` funds can be pulled. |
| **T2.3** | **Cross-Contract Reentrancy via Callback Tokens (`ERC-721` `onERC721Received` / `ERC-777`)** — Attacker uses `safeMint` callback in `reserve()` or `splitTicket()` (if `safeMint` used) or malicious token hook in `deposit()`/`exercise()` to reenter `CommitmentManager` or `LiquidityVault` mid-state-update. | **High** | External calls before state updates; missing `nonReentrant`. | Double-reservation, double-exercise, or accounting bucket desync. | 1) Strict Checks-Effects-Interactions (CEI) across all state transitions; 2) `ReentrancyGuard` (`nonReentrant`) on EVERY state-mutating external function in `LiquidityVault`, `CommitmentManager`, and `ExecutionRouter`; 3) Use `_mint` (not `_safeMint`) or mint only AFTER all state updates + `nonReentrant`. | Adversarial reentrant ERC-20 / ERC-721 receiver test suite. |
| **T2.4** | **Double-Exercise / Double-Reclaim Race** — Ticket holder exercises a ticket in full and simultaneously calls `splitTicket` or `reclaimExpired`, or repeats `ticketId` inside `batchExercise` legs. | **Critical** | Missing `status == ACTIVE` check or `remainingAmount` not updated before external calls. | Drains `LiquidityVault` beyond reserved inventory. | `exercise` decrements `ticket.remainingAmount` first (transitioning to `EXERCISED` and burning NFT at `0`); `reclaimExpired` requires `status == ACTIVE && block.timestamp > expiresAt`, sets `RECLAIMED` + `remainingAmount = 0`, burns NFT. Duplicate legs in `batchExercise` cleanly fail or consume remaining balance only once. | Foundry invariant tests (`INV-3`, `INV-4`) + duplicate-leg batch test. |
| **T2.5** | **Split-Ticket Expiry Extension / Term Mutation** — Holder splits ticket hoping to reset `expiresAt` or bypass `complianceHook`. | **High** | `splitTicket` copies wrong fields or skips `IComplianceHook`. | Free option extension or compliance bypass. | `splitTicket` strictly copies `offerId`, `reservedAt`, `expiresAt`, `priceMode`, `spreadBps`, `lp`, tokens, `oracle`, `complianceHook`, and price bounds; checks `complianceHook.beforeTransfer(ticketId, msg.sender, recipient)` before minting `newTicketId`. | Unit test verifying identical terms + `INV-5` conservation. |

---

### Category T3: Accounting, Precision & ERC-20 Edge-Case Attacks

| ID | Threat & Attack Vector | Severity | Preconditions | Impact | Concrete Architectural Mitigation | Phase 2 Verification |
| --- | --- | --- | --- | --- | --- | --- |
| **T3.1** | **Fee-on-Transfer (FoT) / Rebasing Token Insolvency** — Token deducts 1% on transfer or rebases downward while sitting in `LiquidityVault`. | **Critical** | `LiquidityVault` assumes `received == amount` or fixed balances. | `IERC20.balanceOf(vault)` drops below sum of accounted buckets -> later withdrawers/exercisers suffer bank-run insolvency. | Every inbound transfer in `LiquidityVault` checks `balAfter - balBefore == expectedAmount` (`UnsupportedTokenBalanceDelta`). Governance/LP documentation explicitly excludes rebasing tokens; optional token allowlist or pair validation. | Test with mock 1% FoT token -> `deposit()` and `settleExercise()` MUST revert. |
| **T3.2** | **1-Wei Micro-Fill Rounding Drain** — Attacker splits or partially exercises `1 wei` repeatedly so `paymentAmount` truncates to `0`, extracting free `inventoryToken`. | **High** | Floor rounding on `paymentAmount` or `grossPremium`. | Free drainage of LP inventory over repeated micro-calls. | `grossPayment` and `grossPremium` ALWAYS use `Math.Rounding.Ceil`. Even `1 wei` fill charges `>= 1 wei` if `effPriceX36 > 0`. Additionally, `minTicketAmount` prevents sub-threshold ticket creation/splitting. | Fuzz test across small `fillAmount` (1..1000 wei) verifying `grossPayment > 0` and LP never underpaid. |
| **T3.3** | **Decimal Mismatch / `priceX36` Scaling Bug** — 6-dec `USDC` vs 18-dec `WHSK` mis-scaled by `10^12`, causing 1,000,000,000,000x over/underpayment. | **Critical** | Mixing human prices with raw token amounts. | Total loss of LP inventory or unusable quotes. | Standardize strictly on `priceX36` (raw-to-raw ratio $\times 10^{36}$) with 512-bit `Math.mulDiv`. Include explicit human-to-`priceX36` test vectors for `6 vs 18`, `18 vs 6`, `8 vs 18`, `18 vs 18`. | Cross-decimal Foundry differential tests (`USDC/WHSK`, `WBTC/USDC`, `WHSK/USDC`). |
| **T3.4** | **Blacklisted / Pausable Stablecoin Blocking Settlement (`USDC`/`USDT` `ASSUMED`)** — If an LP or Taker address is blacklisted by `USDC` (`ASSUMED`), `settleExercise` pushing directly to LP would revert and block Taker's rightful exercise! | **Medium–High** | Push-based settlement directly to LP address. | Malicious or blacklisted LP blocks Taker from exercising a paid-for ticket! | **Pull-based `lpPendingProceeds`** in `LiquidityVault`! `settleExercise` only transfers `paymentToken` from `payer` -> `LiquidityVault` (updating an internal storage balance for `lp`) and `inventoryToken` from `LiquidityVault` -> `receiver`. LP's blacklist status cannot DoS Taker exercise! | Test with mock blacklistable token where LP is blacklisted: Taker `exercise()` still succeeds! |

---

### Category T4: Liquidity & Economic Griefing

| ID | Threat & Attack Vector | Severity | Preconditions | Impact | Concrete Architectural Mitigation | Phase 2 Verification |
| --- | --- | --- | --- | --- | --- | --- |
| **T4.1** | **LP Front-Running `reserve()` via `decreaseOffer` / `cancelOffer`** — LP sees Taker's `reserve()` tx in mempool (`ASSUMED`) and cancels/reduces offer before it lands. | **Low–Medium** | Public mempool ordering (`ASSUMED`). | Taker tx reverts (`InsufficientOfferBalance`); Taker loses only gas, no funds stolen. | Standard maker cancellation semantics (LP is allowed to adjust unreserved quotes). `reserve()` checks `maxPremiumIn` and exact `offerBalance >= inventoryAmount`. | Unit test for clean revert when offer cancelled/reduced. |
| **T4.2** | **Dust Ticket Split Spam (DoS on LP Reclaim)** — Taker reserves 10,000 USDC and splits into 10,000 tickets of 1 USDC, forcing LP to pay high gas to reclaim all expired tickets. | **Medium** | Unrestricted `splitTicket` with tiny amounts. | High gas cost for LP/keeper calling `reclaimExpiredBatch`. | Enforce `minTicketAmount` on **both** `splitAmount` and `remainingAmount - splitAmount` inside `splitTicket()` (and `minFillAmount >= minTicketAmount` on `reserve()`). Provide gas-efficient `reclaimExpiredBatch(uint256[] ticketIds)`. | Gas benchmark test for `reclaimExpiredBatch` + test reverting dust splits below `minTicketAmount`. |
| **T4.3** | **Underpriced Fixed-Price Offer ("Free Option" Mistake)** — LP sets `fixedPriceX36` at spot with `basePremiumBps = 0, dailyPremiumBps = 0` and `maxDuration = 30 days`. | **Medium (LP User Error)** | Naive LP misconfigures parameters. | Taker gets a free 30-day American option at LP's expense. | UI/SDK warnings + sensible protocol minimum/recommended bounds; protocol optionally enforces `minDuration >= 60s` and `maxDuration <= MAX_OFFER_DURATION` (e.g., 30d), while allowing LPs full pricing freedom (with `quoteReservation` transparency). | Integration scenario demonstrating Black-Scholes / premium calibration (Workstream B). |

---

### Category T5: External Integration Risks (V3 / `IYieldAdapter` & HSP)

| ID | Threat & Attack Vector | Severity | Preconditions | Impact | Concrete Architectural Mitigation | Phase 2 Verification |
| --- | --- | --- | --- | --- | --- | --- |
| **T5.1** | **V3 Tick-Shift / Conversion Insolvency (Why Arch 2 was Rejected)** — If reserved or offer inventory lived inside an HSKSwap V3 LP NFT (`UNVERIFIED`), price movement converts `inventoryToken` into `paymentToken`, making reservation/exercise impossible without swapping at IL loss. | **Critical** | V3 position used to back active commitments. | Protocol insolvency or forced unfavorable swaps on exercise. | **Eliminated by architecture**: `offerBalance` and `ticketReserved` are **never** deployed to V3 (`totalDeployedIdle == 0` in MVP). Even if post-MVP `IYieldAdapter` is enabled, it may ONLY touch a capped slice of `lpFreeBalance` (`INV-1`). | Architectural invariant `INV-1` enforced in `LiquidityVault`. |
| **T5.2** | **HSP / `IComplianceHook` Brick or Freeze** — External HSP registry (`UNVERIFIED`) pauses, changes ABI, or reverts, or revokes LP/Taker attestation mid-ticket. | **High** | Withdrawal or expiry reclaim calls HSP hook. | LP funds permanently trapped in vault. | **`IComplianceHook` is view-only (`staticcall`) and NEVER called on `withdrawFree`, `claimProceeds`, `decreaseOffer`, `cancelOffer`, or `reclaimExpired`.** | Adversarial test with a permanently reverting `MockRevertingHook`: LP withdraws free balance, cancels offer, and reclaims expired tickets with 0 errors. |
| **T5.3** | **Compliance Bypass via Secondary Ticket Transfer** — Restricted address uses KYC'd sybil to `reserve()`, then transfers ERC-721 `ExecutionTicket` to sanctioned address to `exercise()`. | **Medium (Compliance)** | `IComplianceHook` checked only at `reserve()`, not `transfer`/`exercise`. | Regulatory/compliance policy on gated offer circumvented. | Both `ExecutionTicket._update` (`beforeTransfer` on non-mint/non-burn) AND `CommitmentManager.exercise` (`beforeExercise`) invoke `ticket.complianceHook` when non-zero. | Unit test verifying non-compliant recipient fails both transfer and exercise when hook enforces restriction. |

---

### Category T6: Governance, Upgradeability & Emergency Pause Risks

| ID | Threat & Attack Vector | Severity | Preconditions | Impact | Concrete Architectural Mitigation | Phase 2 Verification |
| --- | --- | --- | --- | --- | --- | --- |
| **T6.1** | **Admin/Governance Rug Pull** — Compromised admin drains `LiquidityVault` or hikes `protocolFeeBps` to 100% (`10_000 bps`) to steal active ticket settlements. | **Critical** | Admin sweep function or uncapped fee setter. | Total theft of user funds or settlement proceeds. | 1) **Zero admin sweep functions** for user funds in `LiquidityVault`; 2) Hardcoded `MAX_PROTOCOL_FEE_BPS = 500` (5%); 3) **Immutable core contracts** (`LiquidityVault`, `CommitmentManager`, `ExecutionTicket` non-upgradeable!). | Code review + unit tests asserting `setProtocolFeeBps(501)` reverts and no sweep path exists. |
| **T6.2** | **Guardian Pause Traps User Funds** — Guardian pauses protocol during incident, freezing LP withdrawals and expired ticket reclaims. | **High** | Global `whenNotPaused` modifier on all functions. | Funds locked indefinitely during pause. | Granular pause flags (`depositsPaused`, `newReservationsPaused`) block **only new inflows** (`deposit`, `createOffer`, `topUpOffer`, `reserve`). `withdrawFree`, `claimProceeds`, `decreaseOffer`, `cancelOffer`, `exercise` (of existing active tickets), and `reclaimExpired` are **unpausable** (`INV-8`). | Foundry test pausing everything and asserting all exit/exercise/reclaim paths still succeed. |

---

## 4. Residual Risks & Explicit Non-Goals

1. **LP Directional Inventory Risk:** Holding single-sided `inventoryToken` exposes the LP to price depreciation of `inventoryToken` relative to `paymentToken`. This is inherent to single-sided inventory custody (the LP is expected to price this via `spreadBps`, `minPriceX36`, `fixedPriceX36`, and reservation premiums).
2. **Intra-HeartBeat Oracle Latency (`FLOATING` Mode):** Within any oracle's legitimate `maxStaleness` / deviation threshold (e.g., 30–60s or 0.5% price trigger), fast arbitrageurs may capture small edge if `spreadBps` is set below oracle deviation tolerance. Workstream B must calibrate recommended `spreadBps` and `basePremiumBps` for HashKey Chain's actual oracle cadence (`UNVERIFIED`).
3. **Non-Standard / Rebasing / Fee-on-Transfer Tokens:** Explicitly unsupported by design and rejected via balance-delta verification (`UnsupportedTokenBalanceDelta`).
4. **Native Gas Token Fee Sponsorship / Account Abstraction:** Out of scope for Phase 1 core contracts; `ExecutionRouter` handles basic `WHSK` wrapping only (`UNVERIFIED` address).
