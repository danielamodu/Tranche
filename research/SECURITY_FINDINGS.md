# Tranche — Security Audit Findings (`contracts/src/`)

> **Audit Scope:** Frozen commit `f5d61e76134fd3badc831d10136318431aabd413` (`main`)  
> **Audited Files:** All 11 Solidity files in `contracts/src/`  
> **Verification Suite:** [SecurityAuditPoC.t.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/test/SecurityAuditPoC.t.sol)  
> **Status:** Independent Phase 1 Workstream A Audit (No fixes applied to frozen `contracts/src/`).

---

## Severity Summary

| Severity | Count | Findings |
| --- | --- | --- |
| **Critical** | 0 | — |
| **High** | 3 | `H-01`, `H-02`, `H-03` |
| **Medium** | 5 | `M-01`, `M-02`, `M-03`, `M-04`, `M-05` |
| **Low** | 4 | `L-01`, `L-02`, `L-03`, `L-04` |
| **Informational** | 4 | `I-01`, `I-02`, `I-03`, `I-04` |

---

## High Severity Findings

### [H-01] `OraclePriceAdapter` Silently Bypasses Cross-Feed Deviation Circuit Breaker When Secondary Feed Is Unhealthy (`pOk && !sOk`)

- **Location:** [OraclePriceAdapter.sol#L14-L22](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/OraclePriceAdapter.sol#L14-L22), [OraclePriceAdapter.sol#L54-L72](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/OraclePriceAdapter.sol#L54-L72)
- **Category:** Oracle Manipulation & Stale Prices
- **Root Cause:**
  In `OraclePriceAdapter.getPriceX36()`, when `cfg.secondaryFeed != address(0)` is configured as a deviation circuit breaker (`cfg.maxDeviationBps > 0`), the adapter validates both `primaryFeed` and `secondaryFeed` via `_readAndValidate()`. However, lines 67–70 execute:
  ```solidity
  if (pOk && !sOk) {
      // Primary is healthy while secondary (e.g. thin TWAP) is unavailable
      return p;
  }
  ```
  Whenever `sOk == false`—for any reason (`secondaryFeed` stale beyond `cfg.maxStaleness`, price outside `[hardMinPriceX36, hardMaxPriceX36]`, `isValid == false`, `priceX36 == 0`, `UniswapV3TwapOracle` insufficient `minCardinality`, or `observe()` reverting)—the cross-feed `maxDeviationBps` circuit breaker is silently skipped without any configuration flag (`requireSecondary` / `allowPrimaryOnly`).
- **Compounding Factors:**
  1. `PairConfig` shares a **single `maxStaleness`** across both `primaryFeed` and `secondaryFeed`. Setting `maxStaleness = 30` seconds for `SignedPullOracle` with any secondary feed whose heartbeat exceeds 30s causes `sOk == false` almost continuously, permanently disabling the deviation circuit breaker in production.
  2. If an attacker or market anomaly pushes a secondary AMM TWAP outside `[hardMinPriceX36, hardMaxPriceX36]`, `_readAndValidate()` returns `sOk = false`, causing the breaker to disengage instead of halting.
- **Impact:** A compromised, buggy, or manipulated `primaryFeed` can push arbitrary prices within `[hardMinPriceX36, hardMaxPriceX36]` (or unbounded if `hardMaxPriceX36 == 0`) for `FLOATING` reservations and exercises even when a healthy-priced secondary feed diverges by >`maxDeviationBps` (e.g., 50x deviation).
- **PoC Reference:** `test_PoC_H1_OracleAdapterBypassesDeviationBreakerWhenSecondaryUnhealthy` in [SecurityAuditPoC.t.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/test/SecurityAuditPoC.t.sol).
- **Recommended Fix:**
  1. Add explicit `bool requireSecondaryCheck` and independent `uint32 secondaryMaxStaleness` fields to `PairConfig`. When `requireSecondaryCheck == true` (or `maxDeviationBps > 0` without explicit opt-out), fail closed (`isValid: false`) if `sOk == false`.
  2. Never treat a secondary feed violating `hardMinPriceX36` / `hardMaxPriceX36` as "unavailable"; a hard-bounds breach on either feed should halt or require explicit operator override.

---

### [H-02] `ExecutionRouter.batchExercise` Breaks `IComplianceHook` Enforcement (DoS When Unlisted, Full Bypass When Allowlisted)

- **Location:** [ExecutionRouter.sol#L87-L102](file:///c:/Users/USER/Desktop/Tranche/contracts/src/ExecutionRouter.sol#L87-L102), [CommitmentManager.sol#L318-L320](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L318-L320)
- **Category:** Authorization, Role Boundaries & Compliance Hook Integration
- **Root Cause:**
  `CommitmentManager.exercise()` invokes:
  ```solidity
  IComplianceHook(t.complianceHook).beforeExercise(ticketId, msg.sender, receiver);
  ```
  When a taker calls `ExecutionRouter.batchExercise(params)`:
  - `CommitmentManager` observes `msg.sender = address(ExecutionRouter)`, NOT the caller (`router`'s `msg.sender`).
  - When `params.unwrapInventoryToNative == true`, `legReceiver = address(ExecutionRouter)`, so `CommitmentManager` also passes `receiver = address(ExecutionRouter)` instead of `params.receiver`.
- **Exploit / Failure Modes:**
  1. **DoS:** If `ExecutionRouter` is not allowlisted on `HSPComplianceHook`, every `batchExercise()` call on any compliance-gated ticket reverts with `NotCompliant(address(router))`, even when both caller and `params.receiver` are compliant.
  2. **Complete Compliance Bypass:** If an admin allowlists `ExecutionRouter` on `HSPComplianceHook` so batch exercises function, a **revoked or sanctioned ticket holder** (whose direct `CommitmentManager.exercise()` reverts `NotCompliant`) can call `ExecutionRouter.batchExercise()` because `CommitmentManager` checks `isCompliant(address(router))` instead of the caller. Worse, setting `unwrapInventoryToNative = true` causes `CommitmentManager` to check `beforeExercise(ticketId, address(router), address(router))`—bypassing compliance checks on **both** the caller and `params.receiver`, delivering unwrapped native `HSK` directly to a sanctioned `params.receiver`.
- **PoC Reference:** `test_PoC_H2_ExecutionRouterBreaksHSPComplianceHook` in [SecurityAuditPoC.t.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/test/SecurityAuditPoC.t.sol).
- **Recommended Fix:**
  Have `ExecutionRouter.batchExercise()` invoke `IComplianceHook(t.complianceHook).beforeExercise(leg.ticketId, msg.sender, params.receiver)` directly when `t.complianceHook != address(0)`, OR introduce a dedicated `exerciseFromRouter` / trusted-router pattern (with explicit `exerciser` and final `receiver` forwarded from `ExecutionRouter` to `CommitmentManager`).

---

### [H-03] `CommitmentManager.splitTicket` Passes `msg.sender` Instead of `ownerOf(ticketId)` to `IComplianceHook.beforeTransfer`

- **Location:** [CommitmentManager.sol#L374-L389](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L374-L389)
- **Category:** Authorization & Compliance Hook Enforcement
- **Root Cause:**
  `splitTicket()` checks `ticketNft.isAuthorized(msg.sender, ticketId)` (which grants access to approved spenders and `isApprovedForAll` operators, not only the owner) and then calls:
  ```solidity
  IComplianceHook(t.complianceHook).beforeTransfer(ticketId, msg.sender, recipient);
  ```
  passing `msg.sender` as the `from` argument instead of `ticketNft.ownerOf(ticketId)`.
- **Exploit Scenario / Impact:**
  1. **Compliance Bypass on Sanctioned Owners:** A compliant user (`Alice`) reserves a compliance-gated ticket and approves a compliant operator/spender (`Bob`). Later, `Alice` is sanctioned (`hspHook.revoke(Alice)`). Direct `transferFrom` (which calls `beforeTransfer(tokenId, Alice, Bob)` in `ExecutionTicket._update`) and `exercise` both revert with `NotCompliant(Alice)`. However, `Bob` can call `CommitmentManager.splitTicket(ticketId, remainingAmount - minTicketAmount, Bob)`, which passes `(ticketId, Bob, Bob)` to `beforeTransfer` and extracts nearly 100% of `Alice`'s restricted ticket into `Bob`'s new ticket.
  2. **False DoS on Compliant Owners:** Conversely, a compliant owner using a non-KYC'd relayer/operator contract to split their ticket to themselves (`recipient = owner`) is rejected with `NotCompliant(relayer)`.
- **PoC Reference:** `test_PoC_H3_SplitTicketBypassesComplianceCheckOnSanctionedOwner` in [SecurityAuditPoC.t.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/test/SecurityAuditPoC.t.sol).
- **Recommended Fix:**
  Query `address owner = ticketNft.ownerOf(ticketId);` and pass `(ticketId, owner, recipient)` to `IComplianceHook(t.complianceHook).beforeTransfer(...)`.

---

## Medium Severity Findings

### [M-01] Untrusted LPs Can Supply Malicious Stateful `complianceHook` or `oracle` Contracts in `createOffer` to Steal Taker Premiums

- **Location:** [CommitmentManager.sol#L156-L163](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L156-L163), [CommitmentManager.sol#L265-L267](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L265-L267), [CommitmentManager.sol#L318-L320](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L318-L320), [CommitmentManager.sol#L532-L533](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L532-L533), [ExecutionTicket.sol#L87-L90](file:///c:/Users/USER/Desktop/Tranche/contracts/src/ExecutionTicket.sol#L87-L90)
- **Category:** Trust Boundaries & Honeypot Adapter Risk
- **Root Cause:**
  `CommitmentManager.createOffer()` allows any untrusted LP to specify arbitrary addresses for `p.complianceHook` and `p.oracle` with no on-chain allowlist or registry. While `IComplianceHook` and `IPriceOracle` calls use `view` (`STATICCALL`) during protocol transitions, the LP can mutate the adapter's state in a separate transaction between `reserve()` and `exercise()`.
- **Exploit Scenario:**
  1. Malicious LP deploys a stateful `HoneypotComplianceHook` (or `HoneypotOracle`) that permits `beforeReserve` (or returns a normal spot price at `reserve()`).
  2. Taker reserves the offer and pays upfront `grossPremium` (which LP can immediately withdraw via `vault.claimProceeds()`).
  3. LP flips the hook to revert on `beforeExercise` / `beforeTransfer` (or flips `HoneypotOracle` to return `isValid = false` or `maxPriceX36`).
  4. Taker is permanently prevented from exercising or transferring the ticket, forfeits 100% of the premium, and LP reclaims 100% of the underlying inventory after `expiresAt`.
- **PoC Reference:** `test_PoC_M1_MaliciousLPHoneypotHookRugsTakerPremium` in [SecurityAuditPoC.t.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/test/SecurityAuditPoC.t.sol).
- **Recommended Fix:**
  Maintain governance-approved registries/allowlists for `oracle` and `complianceHook` addresses in `CommitmentManager` (or require `complianceHook` / `oracle` factory verification), and clearly surface/restrict unverified adapters in SDK/UI order routing.

---

### [M-02] `ExecutionTicket.permit` Nonce Is Not Invalidated on Transfer, Enabling Stale Signature Replay Across Ownership Cycles

- **Location:** [ExecutionTicket.sol#L64-L93](file:///c:/Users/USER/Desktop/Tranche/contracts/src/ExecutionTicket.sol#L64-L93)
- **Category:** EIP-712 Signatures, Nonces & ERC-721 Transfers
- **Root Cause:**
  `ExecutionTicket.permit()` increments `nonces[tokenId]++`, but `ExecutionTicket._update()` does not increment `nonces[tokenId]` when a ticket is transferred (`from != address(0) && to != address(0)`). Additionally, line 80 calls `_approve(spender, tokenId, address(0), false)`, suppressing the ERC-721 `Approval` event.
- **Exploit Scenario:**
  1. `Alice` owns `ticketId` (`nonces[ticketId] == 0`) and signs an off-chain `permit(attacker, ticketId, nonce=0, deadline)` that is not submitted (e.g., cancelled OTC deal or aborted router tx).
  2. `Alice` transfers `ticketId` to `Bob` (`nonces[ticketId]` remains `0`).
  3. Later, `Alice` reacquires `ticketId` from `Bob`.
  4. `attacker` replays the old unused `permit` signature—since `ownerOf(ticketId) == Alice` and `nonces[ticketId] == 0`, `permit()` succeeds and `attacker` transfers or exercises `Alice`'s ticket.
  *(The same vector applies if an `isApprovedForAll` operator signed an unused permit, was revoked, and was later re-approved.)*
- **PoC Reference:** `test_PoC_M2_ExecutionTicketPermitReplayAfterTransferCycle` in [SecurityAuditPoC.t.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/test/SecurityAuditPoC.t.sol).
- **Recommended Fix:**
  Increment `nonces[tokenId]++` inside `ExecutionTicket._update()` whenever `from != address(0) && to != address(0)` (per EIP-4494), and pass `true` for `emitEvent` in `_approve(spender, tokenId, address(0), true)`.

---

### [M-03] Retroactive Admin Parameter Changes (`setProtocolFeeBps`, `setMinTicketAmount`, `setPairConfig`) Alter Active Ticket Terms

- **Location:** [CommitmentManager.sol#L124-L133](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L124-L133), [CommitmentManager.sol#L380-L385](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L380-L385), [CommitmentManager.sol#L521](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L521), [OraclePriceAdapter.sol#L31-L38](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/OraclePriceAdapter.sol#L31-L38)
- **Category:** Privileged Operations & Commitment Integrity (`SO-2`)
- **Root Cause:**
  1. `CommitmentManager._quoteExercise()` reads live `protocolFeeBps` rather than snapshotting it per `Offer`/`Ticket` at creation/reservation. Admin calling `setProtocolFeeBps(500)` retroactively cuts LP net proceeds by up to 5% on already-minted tickets that LPs cannot cancel.
  2. `CommitmentManager.splitTicket()` reads live `minTicketAmount` instead of snapshotting it on the `Ticket` (or `Offer`). Raising `minTicketAmount` retroactively blocks holders of existing tickets from splitting; lowering `minTicketAmount` to `0` retroactively disables the `T4.2` dust-split spam guard across all active tickets.
  3. `OraclePriceAdapter.setPairConfig()` mutates feed addresses, staleness thresholds, and hard bounds immediately for all active `FLOATING` tickets pointing to that adapter.
- **PoC Reference:** `test_PoC_M3_RetroactiveAdminFeeHikeAndMinTicketLockout` in [SecurityAuditPoC.t.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/test/SecurityAuditPoC.t.sol).
- **Recommended Fix:**
  Snapshot `protocolFeeBps` and `minTicketAmount` in `Offer` / `Ticket` at `createOffer()` / `reserve()` time, and enforce timelocked or immutable-per-epoch oracle configs for `OraclePriceAdapter`.

---

### [M-04] `CommitmentManager.exercise` Ignores `minTicketAmount` / `offer.minFillAmount`, Allowing `1-wei` Dust Remainders & Zero-Fee Micro-Fills

- **Location:** [CommitmentManager.sol#L322-L335](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L322-L335), [CommitmentManager.sol#L520-L521](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L520-L521)
- **Category:** Partial Fills & Fee Rounding
- **Root Cause:**
  1. Unlike `reserve()` (which enforces `max(o.minFillAmount, minTicketAmount)`) and `splitTicket()` (which enforces `minTicketAmount` on both `splitAmount` and `parentRem`), `exercise()` enforces neither a minimum `actualFill` nor `newRem == 0 || newRem >= minTicketAmount`.
  2. `_quoteExercise()` computes `protocolFee = Math.mulDiv(grossPayment, protocolFeeBps, BPS_DENOMINATOR, Math.Rounding.Floor)`.
- **Impact:**
  1. A taker can call `exercise(ticketId, remainingAmount - 1, ...)` leaving `1 wei` un-splittable dust (`< minTicketAmount`) on the ticket until `expiresAt`, bypassing the minimum-size hygiene of the protocol.
  2. For any micro-fill where `grossPayment < BPS_DENOMINATOR / protocolFeeBps` (e.g., `grossPayment <= 199` raw units at `50 bps`, or `<= 999` raw units at `10 bps`), `protocolFee` truncates to `0`, enabling zero-fee execution across batched micro-fills (most practical on low-decimal payment tokens or low-fee configurations on cheap L2 gas).
- **PoC Reference:** `test_PoC_M4_MicroFillZeroProtocolFeeAndDustRemainder` in [SecurityAuditPoC.t.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/test/SecurityAuditPoC.t.sol).
- **Recommended Fix:**
  Enforce `actualFill >= minFill` (unless `actualFill == t.remainingAmount`) and `newRem == 0 || newRem >= minTicketAmount` in `exercise()`, and consider `Math.Rounding.Ceil` on `protocolFee` when `protocolFeeBps > 0` (consistent with `grossPayment`).

---

### [M-05] `CommitmentManager` Lacks `setGuardian` & All Contracts Use Immutable Single-EOA `admin` Without Ownership Transfer

- **Location:** [CommitmentManager.sol#L86-L87](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L86-L87), [CommitmentManager.sol#L135-L139](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L135-L139), [LiquidityVault.sol#L31](file:///c:/Users/USER/Desktop/Tranche/contracts/src/LiquidityVault.sol#L31), [SignedPullOracle.sol#L30](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/SignedPullOracle.sol#L30), [UniswapV3TwapOracle.sol#L27](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/UniswapV3TwapOracle.sol#L27), [OraclePriceAdapter.sol#L24](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/OraclePriceAdapter.sol#L24), [HSPComplianceHook.sol#L26](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/HSPComplianceHook.sol#L26)
- **Category:** Governance, Upgradeability & Privileged Operations
- **Root Cause:**
  1. `LiquidityVault` implements `setGuardian(address _guardian)`, but `CommitmentManager` defines `address public guardian;` with **no `setGuardian` function**.
  2. Every admin-gated contract (`LiquidityVault`, `CommitmentManager`, `SignedPullOracle`, `UniswapV3TwapOracle`, `OraclePriceAdapter`, `HSPComplianceHook`) sets `address public immutable admin = msg.sender;` with no `transferAdmin` / two-step `Ownable2Step` rotation.
- **Impact:**
  1. If `guardian` is compromised or rotated on `LiquidityVault`, `CommitmentManager.guardian` remains permanently active and can endlessly re-call `setNewReservationsPaused(true)` after `admin` unpauses, permanently DoS'ing new offers and reservations on the immutable `CommitmentManager`.
  2. If the deployer key is an EOA (or a multisig needing migration), `admin` can never be rotated to a timelock/DAO or new multisig without redeploying the entire system and migrating all LP capital.
- **PoC Reference:** `test_PoC_M5_UnrotatableCommitmentManagerGuardianPermanentPause` in [SecurityAuditPoC.t.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/test/SecurityAuditPoC.t.sol).
- **Recommended Fix:**
  Add `setGuardian(address _guardian)` (two-step or admin-gated) to `CommitmentManager`, and implement `Ownable2Step` (with timelock governance target) instead of `immutable admin`.

---

## Low Severity Findings

### [L-01] `reclaimExpiredBatch` Reverts Atomically If Any Single Ticket Is Non-Expired, Exercised, or Already Reclaimed

- **Location:** [CommitmentManager.sol#L425-L451](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L425-L451)
- **Impact:** If a keeper or LP submits `reclaimExpiredBatch` for 50 expired tickets and a third party front-runs `reclaimExpired()` on 1 ticket (or a taker exercises 1 ticket right before expiry), the entire batch reverts and wastes gas.
- **PoC Reference:** `test_PoC_L1_ReclaimExpiredBatchAtomicDoSGrief` in [SecurityAuditPoC.t.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/test/SecurityAuditPoC.t.sol).
- **Recommended Fix:** Add a best-effort batch variant (e.g., `reclaimExpiredBatchBestEffort` or `bool skipInactive`) that skips non-active or non-expired tickets instead of reverting the whole loop.

---

### [L-02] `reserve()` Allows Ticket `expiresAt` to Exceed `Offer.expiry` by Up to `maxDuration`

- **Location:** [CommitmentManager.sol#L258-L259](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L258-L259), [CommitmentManager.sol#L273](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L273)
- **Impact:** A taker calling `reserve()` 1 second before `o.expiry` with `duration = o.maxDuration` (up to 30 days) locks LP inventory for up to `30 days` past `o.expiry`. While `_reclaimExpired()` handles this safely without locking funds permanently (releasing to `lpFreeBalance`), it can surprise LPs who expect `offer.expiry` to bound maximum capital lockup.
- **PoC Reference:** `test_PoC_L2_TicketExpiryExceedsOfferExpiry` in [SecurityAuditPoC.t.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/test/SecurityAuditPoC.t.sol).
- **Recommended Fix:** Either enforce `block.timestamp + duration <= o.expiry` in `reserve()` (or add an explicit `maxTicketExpiry` / document `o.expiry` clearly as the *reservation deadline*, not lockup deadline).

---

### [L-03] `ExecutionRouter` Constructor Does Not Check `address(ticketNft) != address(0)` & Native Refund Uses Push Call to `msg.sender`

- **Location:** [ExecutionRouter.sol#L53-L59](file:///c:/Users/USER/Desktop/Tranche/contracts/src/ExecutionRouter.sol#L53-L59), [ExecutionRouter.sol#L113-L122](file:///c:/Users/USER/Desktop/Tranche/contracts/src/ExecutionRouter.sol#L113-L122)
- **Impact:**
  1. If `ExecutionRouter` is deployed before `CommitmentManager.setTicketNft()` is called, `ExecutionRouter.ticketNft` is permanently `immutable address(0)` without reverting in the constructor, bricking the deployed router.
  2. When `paidNative == true` and `unused > 0`, `ExecutionRouter` pushes native `HSK` back to `msg.sender`, reverting if `msg.sender` is a contract without `receive()`/`fallback()`.
- **Recommended Fix:** Check `if (address(ticketNft) == address(0)) revert ZeroAddress();` in `ExecutionRouter` constructor, and consider refunding unused native `HSK` to `params.receiver` or a specified refund address.

---

### [L-04] Oracle Adapter Edge Cases: Hardcoded `UniswapV3TwapOracle.updatedAt`, Unchecked `minCardinality`, Direct `SignedPullOracle` Staleness, and Multiplication Overflow

- **Location:** [UniswapV3TwapOracle.sol#L34-L44](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/UniswapV3TwapOracle.sol#L34-L44), [UniswapV3TwapOracle.sol#L97](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/UniswapV3TwapOracle.sol#L97), [SignedPullOracle.sol#L76-L88](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/SignedPullOracle.sol#L76-L88), [OraclePriceAdapter.sol#L59](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/OraclePriceAdapter.sol#L59)
- **Details:**
  1. `UniswapV3TwapOracle.getPriceX36()` always returns `updatedAt: block.timestamp`, so `OraclePriceAdapter` cannot detect an inactive/frozen V3 pool via `maxStaleness`.
  2. `UniswapV3TwapOracle.setPoolConfig()` allows `minCardinality <= 1`, permitting single-observation extrapolation.
  3. `SignedPullOracle.getPriceX36()` has no internal staleness TTL (`isValid: true` forever once set); any offer pointing directly to `SignedPullOracle` instead of `OraclePriceAdapter` accepts arbitrarily stale prices.
  4. `OraclePriceAdapter` line 59 computes `(diff * BPS_DENOMINATOR) / minP` instead of `Math.mulDiv(diff, BPS_DENOMINATOR, minP)`, which panics on extreme values (`> type(uint256).max / 10_000`) instead of returning `isValid: false`.
- **Recommended Fix:** Enforce `minCardinality >= 2` in `UniswapV3TwapOracle`, add an optional `maxAge` in `SignedPullOracle`, and use `Math.mulDiv` in `OraclePriceAdapter`.

---

## Informational Findings

### [I-01] `V3PositionSegregator.withdrawAndSegregate` Reverts When `posLiquidity == 0` (Blocks Fee-Only Collection)

- **Location:** [V3PositionSegregator.sol#L61-L63](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/V3PositionSegregator.sol#L61-L63)
- **Detail:** If a V3 LP previously decreased liquidity to `0` and only has uncollected fees (`tokensOwed0`/`tokensOwed1`), `withdrawAndSegregate` reverts with `ZeroLiquidity()`. Skipping `decreaseLiquidity` when `posLiquidity == 0 && p.liquidityToWithdraw == 0` would allow fee-only segregation.

### [I-02] `LiquidityVault.setGuardian` and `setFeeCollector` Are Single-Step Setters

- **Location:** [LiquidityVault.sol#L78-L88](file:///c:/Users/USER/Desktop/Tranche/contracts/src/LiquidityVault.sol#L78-L88)
- **Detail:** A typo in `setFeeCollector` permanently misroutes accumulated protocol fees until corrected, and any fees withdrawn in the interim cannot be recovered. Two-step acceptance (`pendingFeeCollector` / `acceptFeeCollector`) mitigates this.

### [I-03] `ExecutionTicket.permit` Suppresses `Approval` Event & Lacks ERC-1271 Support

- **Location:** [ExecutionTicket.sol#L77-L80](file:///c:/Users/USER/Desktop/Tranche/contracts/src/ExecutionTicket.sol#L77-L80)
- **Detail:** Calling `_approve(spender, tokenId, address(0), false)` omits the standard ERC-721 `Approval` event for off-chain indexers. Using `SignatureChecker.isValidSignatureNow` would also enable smart-account (Safe / ERC-4337) permit signing.

### [I-04] `ForgeSmoke.sol` Present in Production `contracts/src/` & `topUpOffer` Accepts Expired Offers

- **Location:** [ForgeSmoke.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/ForgeSmoke.sol), [CommitmentManager.sol#L194-L203](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L194-L203)
- **Detail:** `ForgeSmoke.sol` is a Phase 1 toolchain smoke artifact inside `contracts/src/` and should be removed or relocated to `contracts/test/` prior to mainnet deployment. Additionally, `CommitmentManager.topUpOffer` does not check `block.timestamp < o.expiry` (recoverable via `decreaseOffer`/`cancelOffer`, just wasted gas).
