# Architectural Decision Records (Workstream C)

> **Scope:** Documents every architectural reconciliation, trade-off, and design decision for **the protocol**.  
> **Companion Documents:** [PROTOCOL_ARCHITECTURE.md](file:///c:/Users/USER/Desktop/Tranche/research/PROTOCOL_ARCHITECTURE.md), [THREAT_MODEL.md](file:///c:/Users/USER/Desktop/Tranche/research/THREAT_MODEL.md).

---

## Summary Table

| ID | Decision | Status | Primary Trade-off |
| --- | --- | --- | --- |
| **ADR-001** | Modular ERC-20 Segregated Vault + Optional `IYieldAdapter` (`address(0)` MVP) | Accepted | Sacrifices passive V3 swap-fee yield on idle inventory in MVP to guarantee 100% deterministic reservation & zero tick-shift insolvency. |
| **ADR-002** | Singleton `LiquidityVault` with Per-`(lp, token)` & Explicit Per-Offer Allocation | Accepted | Prevents capital reuse across multiple simultaneous quotes by one LP, in exchange for zero phantom liquidity & clean accounting. |
| **ADR-003** | Dual-Mode (`FIXED` + `FLOATING`) Commitments with Immutable Ticket Snapshot | Accepted | Slightly larger `Ticket` struct (~10 storage slots) in exchange for complete immunity to post-reservation LP term tampering. |
| **ADR-004** | ERC-721 `ExecutionTicket` + `splitTicket` + `ExecutionRouter` Batch Aggregation | Accepted | Adds `minTicketAmount` dust guard complexity, enabling full transferability, secondary splitting, and multi-LP atomic routing. |
| **ADR-005** | Raw-Ratio `priceX36` + Asymmetric Rounding (`Ceil` Pay, `Floor` Protocol Fee) | Accepted | Less human-readable raw numbers off-chain (needs SDK formatting), eliminating runtime `.decimals()` calls & 1-wei rounding leaks. |
| **ADR-006** | Pull-Based LP Proceeds (`lpPendingProceeds`) & Non-Blocking Exits/Reclaims | Accepted | LPs make one `claimProceeds()` call instead of automatic push, preventing blacklisted/reverting LPs from DoS-ing Taker exercises. |
| **ADR-007** | Stateless `ExecutionRouter` with Mandatory `isAuthorized(msg.sender, ticketId)` | Accepted | Requires 1-time `setApprovalForAll(router, true)` or `permit`, preventing confused-deputy ticket theft and isolating native `WHSK` wrapping. |
| **ADR-008** | Abstracted `IPriceOracle` with Staleness, Hard Bounds & Cross-Feed Breaker | Accepted | `FLOATING` pauses fail-closed during total oracle outage; `FIXED` and `reclaimExpired` remain 100% live. |
| **ADR-009** | Isolated Optional `IComplianceHook` (HSP) Never Called on Withdrawals/Reclaims | Accepted | Compliance gating only applies to opt-in offers (`complianceHook != address(0)`) and never puts vault custody at risk. |
| **ADR-010** | Reject Fee-on-Transfer & Rebasing Tokens via Balance-Delta Verification | Accepted | Excludes exotic FoT/rebasing tokens to preserve exact 1:1 bucket solvency (`INV-1`). |
| **ADR-011** | Non-Upgradeable Core (`Vault`, `Manager`, `Ticket`) & Upgradeable/Swappable Periphery | Accepted | Core cannot be patched in-place post-deploy; guarantees immutability against governance rug pulls. |
| **ADR-012** | Pin `solc 0.8.24` / `shanghai` (`VERIFIED`) Pending HashKey Chain `PUSH0` Check (`UNVERIFIED`) | Provisional | Requires Workstream A confirmation; trivially switches to `paris` in `foundry.toml` if HashKey Chain lacks `PUSH0`. |

---

## Detailed Decisions

### ADR-001: Modular ERC-20 Segregated Vault + Optional `IYieldAdapter` (`address(0)` MVP)
- **Context:** We reconciled four candidate architectures: (1) Dedicated Depth Tranche, (2) JIT-Segregated HSKSwap V3 Vault with Dual-Mode Tickets, (3) Pure ERC-20 Segregated Vault, and (4) Modular ERC-20 Segregated Vault with an optional `IYieldAdapter` for unallocated `lpFreeBalance` (`address(0)` in MVP).
- **Alternatives Considered:**
  - *JIT V3 Vault (Arch 2):* Maximizes idle yield via HSKSwap V3 LP positions (`UNVERIFIED`), but couples reservation solvency to V3 token-ratio drift. When spot price moves, a V3 position converts `inventoryToken` into `paymentToken`, causing `reserve()` to fail or forcing unfavorable swaps/IL at reservation time. It also introduces tick math, `NonfungiblePositionManager` (`UNVERIFIED`), callback reentrancy, and LP share drift.
  - *Dedicated Tranche Vaults (Arch 1):* Deploys separate vaults per tranche, fragmenting liquidity and duplicating custody logic.
  - *Pure ERC-20 Vault without extension seam (Arch 3):* Cleanest, but offers no architectural path to idle yield post-MVP without a full rewrite.
- **Decision:** Adopt **Arch 4** (`LiquidityVault` with 100% liquid ERC-20 custody for `offerBalance` and `ticketReserved`, plus a disabled `IYieldAdapter` hook strictly scoped to a capped slice of `lpFreeBalance`).
- **Consequences:** Core solvency (`INV-1`) is 100% independent of HSKSwap V3 (`UNVERIFIED`). LPs earn reservation premiums + spreads in MVP, and if Workstream A/B later proves a safe single-sided yield primitive on HashKey Chain, it can plug into `IYieldAdapter` without altering `CommitmentManager` or active tickets.

### ADR-002: Singleton `LiquidityVault` with Explicit Per-Offer Allocation
- **Context:** Should LPs pool funds fungibly (ERC-4626 style) or retain individual `(lp, token)` and `offerId` accounting? And should creating an offer lock `lpFreeBalance` into `offerBalance`, or let multiple offers share one `lpFreeBalance`?
- **Alternatives Considered:**
  - *Pooled ERC-4626 Vault:* Impossible when LPs customize strike, spread, duration, and compliance hooks—pooled LPs cannot have heterogeneous payoffs.
  - *Shared `lpFreeBalance` across offers:* Allows capital reuse across quotes, but creates "phantom liquidity" where 5 offers each display 100k depth backed by only 100k total, breaking off-chain aggregation and causing race reverts.
- **Decision:** Use a single `LiquidityVault` with per-`(lp, token)` custody (`lpFreeBalance`) and **explicit allocation** (`offerBalance[offerId]`) upon `createOffer`/`topUpOffer`, reversible anytime via `decreaseOffer`/`cancelOffer`.
- **Consequences:** Every on-chain offer quote represents real, unencumbered inventory unless explicitly cancelled by the LP.

### ADR-003: Dual-Mode (`FIXED` + `FLOATING`) Commitments with Immutable Ticket Snapshot
- **Context:** Should `ExecutionTicket` reference live `Offer` storage fields or snapshot pricing/oracle/compliance parameters at `reserve()`?
- **Decision:** Support both `PriceMode.FIXED` and `PriceMode.FLOATING` in one unified `CommitmentManager`, and **snapshot** `lp`, tokens, `oracle`, `complianceHook`, `spreadBps`, `fixedOrMinPriceX36`, and `maxPriceX36` into `Ticket` at reservation time.
- **Consequences:** Costs extra gas on `reserve()` (~5–6 additional `SSTORE`s), but guarantees LPs can pause, cancel, or adjust offers freely without ever mutating or rugging active ticket holders.

### ADR-004: ERC-721 `ExecutionTicket` + `splitTicket` + `ExecutionRouter` Batch Aggregation
- **Context:** Tickets must be transferable, partially exercisable, and aggregatable across multiple LPs/offers.
- **Alternatives Considered:**
  - *Non-transferable internal struct:* Breaks secondary markets and composability.
  - *ERC-1155:* Only works if tickets are fungible; because tickets have distinct `(offerId, expiresAt, terms)`, ERC-721 is the exact semantic match.
  - *No `splitTicket`:* Forces a holder who wants to sell half of a large ticket to either exercise first or transfer the whole right.
- **Decision:** Standard OpenZeppelin `ERC721` + `EIP712` permit, backed by `remainingAmount` in `CommitmentManager` for partial fills, `splitTicket` (guarded by `minTicketAmount` on both halves), and `ExecutionRouter.batchExercise` for multi-ticket atomic settlement.
- **Consequences:** Enables secondary transfer, partial splitting without vault reserve drift (`INV-5`), and single-tx multi-LP execution aggregation.

### ADR-005: Raw-Ratio `priceX36` & Asymmetric Rounding (`Ceil` Payments, `Floor` Fees)
- **Context:** Pairs like `USDC` (6 dec) / `WHSK` (18 dec) or `WBTC` (8 dec) / `USDC` (6 dec) suffer catastrophic bugs when human decimals and raw wei are mixed, and truncation on micro-fills can leak vault dust.
- **Decision:** Express all prices as `priceX36 = rawPaymentPerRawInventory * 1e36`, computed with 512-bit `Math.mulDiv`. Round `grossPremium` and `grossPayment` **UP (`Ceil`)**; round `protocolFee` **DOWN (`Floor`)** and set `lpNet = gross - protocolFee`.
- **Consequences:** Eliminates runtime `.decimals()` calls, handles arbitrary token decimal pairs uniformly, prevents 1-wei micro-fill extraction, and ensures `lpNet + protocolFee == gross` exactly (`INV-6`).

### ADR-006: Pull-Based LP Proceeds & Non-Blocking Exits/Reclaims
- **Context:** Pushing `paymentToken` directly to LPs inside `reserve()` or `exercise()` exposes Takers to LP contract revert DoS or stablecoin blacklist reverts (`USDC`/`USDT` `ASSUMED`).
- **Decision:** Credit earned premiums and exercise proceeds to `lpPendingProceeds[lp][paymentToken]` inside `LiquidityVault` (pull via `claimProceeds`), and never gate `withdrawFree`, `claimProceeds`, `decreaseOffer`, `cancelOffer`, or `reclaimExpired` behind pause flags or hooks.
- **Consequences:** Blacklisted or contract LPs cannot block Taker exercises, and emergency pauses can never trap user funds (`INV-8`).

### ADR-007: Stateless `ExecutionRouter` with Mandatory `isAuthorized` & Native Wrapping
- **Context:** Batch execution requires `ExecutionRouter` to act on multiple `ExecutionTicket`s owned by a user, and users may want to pay/receive native `HSK` (`UNVERIFIED` `WHSK` wrapper).
- **Decision:** Keep core (`LiquidityVault`, `CommitmentManager`) strictly ERC-20-only. Place native `WHSK` wrap/unwrap and multi-leg batching in stateless `ExecutionRouter`. Enforce `ticketNft.isAuthorized(msg.sender, leg.ticketId)` on **every leg** inside `batchExercise`.
- **Consequences:** Prevents the classic `setApprovalForAll(router)` confused-deputy exploit (`T2.1`) and keeps `payable` attack surfaces completely outside `LiquidityVault`.

### ADR-008: Abstracted `IPriceOracle` with Staleness, Bounds & Circuit Breaker
- **Context:** HashKey Chain oracle infrastructure (Pyth, Chainlink, RedStone, HSKSwap V3 TWAP) is currently `UNVERIFIED` pending Workstream A.
- **Decision:** Define a single minimal `IPriceOracle.getPriceX36()` interface consumed by `CommitmentManager`, implemented by `OraclePriceAdapter` enforcing `maxStaleness`, `hardMin/MaxPriceX36`, optional secondary cross-check (`maxDeviationBps`), and **zero use of AMM `slot0` spot prices**. Fail closed on `FLOATING` during total oracle outage while keeping `FIXED` and `reclaimExpired` live.
- **Consequences:** Phase 2 contract development can proceed immediately with a clean `IPriceOracle` mock and swap in the verified HashKey Chain feed adapter once Workstream A reports back.

### ADR-009: Isolated Optional `IComplianceHook` (HSP) Never Invoked on Exits/Reclaims
- **Context:** HashKey Chain's ecosystem emphasizes institutional compliance (HSP `UNVERIFIED`), yet hard-coupling core vault custody to an external attestation contract creates severe lockup and availability risks.
- **Decision:** Make `complianceHook` an optional per-offer `view` (`staticcall`) hook (`address(0)` for permissionless offers). Invoke only on `createOffer`, `reserve`, non-mint/non-burn `ExecutionTicket` transfers, and `exercise`. **Never** invoke on `withdrawFree`, `claimProceeds`, `decreaseOffer`, `cancelOffer`, or `reclaimExpired`.
- **Consequences:** Supports compliance-gated institutional tranches for judges/ecosystem alignment while preserving absolute vault solvency and non-lockup guarantees.

### ADR-010: Strict ERC-20 Custody (Reject Fee-on-Transfer / Rebasing Tokens)
- **Context:** Supporting FoT or rebasing tokens inside multi-bucket accounting requires per-LP share indices across every bucket and breaks 1:1 `ExecutionTicket` notional guarantees.
- **Decision:** Verify `balAfter - balBefore == expectedAmount` on every inbound transfer in `LiquidityVault`, reverting on mismatch (`UnsupportedTokenBalanceDelta`), and exclude rebasing tokens by policy.
- **Consequences:** Preserves exact 1:1 physical token backing (`INV-1`) with minimal gas and zero share-inflation bugs.

### ADR-011: Non-Upgradeable Core & Swappable Periphery
- **Context:** Upgradeable proxies on custody vaults introduce admin rug risk and storage-collision surfaces.
- **Decision:** Deploy `LiquidityVault`, `CommitmentManager`, and `ExecutionTicket` as **immutable (non-upgradeable)** contracts. `ExecutionRouter`, `OraclePriceAdapter`, and `IComplianceHook` implementations are stateless/pluggable periphery that can be replaced without migrating user custody.
- **Consequences:** Maximizes user and judge trust in vault custody guarantees while keeping oracle/router integrations adaptable.

### ADR-012: Provisional `solc 0.8.24` / `shanghai` Target Pending Workstream A
- **Context:** `foundry.toml` (`VERIFIED`) targets `solc_version = "0.8.24"` and `evm_version = "shanghai"` (which emits `PUSH0`), whereas HashKey Chain's EVM opcode support is `UNVERIFIED`.
- **Decision:** Design all structs and specs for `0.8.24`, flagged as provisional until Workstream A verifies `PUSH0` support on HashKey Chain RPC. If `PUSH0` is unsupported, switch `evm_version = "paris"` in `foundry.toml` (zero source code impact).

---

## Workstream A & B Blocking Questions Before Phase 2 Coding

1. **Workstream A (Chain & Infra):**
   - Does HashKey Chain support `shanghai` (`PUSH0`) or require `paris`?
   - What is the canonical `WHSK` address and canonical `USDC`/`USDT` addresses & decimals?
   - Which push/pull oracles (Pyth, Chainlink, RedStone, etc.) are deployed and actively updated on HashKey Chain? What are their update heartbeats and deviation thresholds?
   - What is the exact HSKSwap V3 Factory/Pool deployment and does `observe()` work reliably as a secondary TWAP check?
   - What is the exact HSP contract address, ABI, and whether attestations are revocable/expirable?
2. **Workstream B (Economics & Market Calibration):**
   - Which token pairs have the worst AMM depth/slippage on HashKey Chain (target launch pairs for **the protocol**)?
   - Recommended default bounds for `minTicketAmount`, `MAX_PROTOCOL_FEE_BPS`, `maxStaleness`, `maxDeviationBps`, and `basePremiumBps` / `dailyPremiumBps` calibration?
