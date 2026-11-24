# Tranche — Post-Remediation Threat Model & Permission Matrix

> **Audit Baseline:** `53dcf859da10f4d22dcdd2afa48d9882378165b6` (`testnet/phase3-validation`)  
> **Companion Docs:** [AUDIT_SCOPE.md](AUDIT_SCOPE.md), [SECURITY_ASSUMPTIONS.md](SECURITY_ASSUMPTIONS.md), [KNOWN_FINDINGS.md](KNOWN_FINDINGS.md)

---

## 1. Assets at Risk & Core Invariants

### Assets Under Custody / Control
1. **Vault ERC-20 Inventory (`inventoryToken`):** Partitioned into `lpFreeBalance`, `offerBalance`, and `ticketReserved`.
2. **Vault ERC-20 Settlement Funds (`paymentToken`):** Partitioned into `lpPendingProceeds` (LP premiums + exercise proceeds) and `protocolFees` (Treasury revenue).
3. **ERC-721 Execution Rights (`ExecutionTicket`):** Transferable option/depth-commitment NFTs carrying snapshotted price mode, strike/bounds, spread, fee bps, `minFillAmount`, and `expiresAt`.
4. **Transient Router Allowances & Native `HSK`:** ERC-20/ERC-721 approvals to `ExecutionRouter` and transient `WHSK` wrap/unwrap balances.

### Mandatory Protocol Invariants (`INV-1` – `INV-8`)
- **`INV-1` (Physical Solvency):** For every token `T`, `IERC20(T).balanceOf(vault) >= totalLpFree[T] + totalOfferAvailable[T] + totalReserved[T] + totalPendingProceeds[T] + protocolFees[T]`.
- **`INV-2` (Bucket Conservation):** Every state transition conserves total allocated tokens; direct donations to `vault` cannot inflate tracked LP balances.
- **`INV-3` (1:1 Ticket Backing):** For every `ACTIVE` ticket `id`, `vault.ticketReserved(id) == manager.getTicket(id).remainingAmount > 0`.
- **`INV-4` (Immutable Ticket Terms):** Once reserved, `Offer` or global governance mutations cannot retroactively alter a ticket's `protocolFeeBps`, `minFillAmount`, `spreadBps`, `oracle`, `complianceHook`, `fixedOrMinPriceX36`, `maxPriceX36`, or `expiresAt`.
- **`INV-5` (Zero Router Residue):** `ExecutionRouter` holds zero persistent ERC-20, ERC-721, or native `HSK` balances at the end of every transaction.
- **`INV-6` (Rounding Favors LP & Protocol):** Payment and protocol fee calculations round `Ceil`; inventory delivery never exceeds `remainingAmount`.
- **`INV-7` (Authorized Exercise & Transfer Only):** Only `ticketNft.ownerOf(id)` or an approved spender/operator (or an allowlisted `ExecutionRouter` acting for an authorized caller) may exercise or split a ticket.
- **`INV-8` (Unstoppable Exits & Recovery):** `LiquidityVault.withdrawFree`, `LiquidityVault.claimProceeds`, `CommitmentManager.decreaseOffer`, `CommitmentManager.cancelOffer`, `CommitmentManager.reclaimExpired*`, and `PriceMode.FIXED` `exercise`/`exerciseFor` are **never** blocked by `depositsPaused`, `newReservationsPaused`, `floatingExercisePaused`, oracle outages/revocations, or `IComplianceHook` reverts/revocations.

---

## 2. Role & Permission Matrix

| Actor / Role | Authorized Actions | Explicitly Prohibited Actions |
| --- | --- | --- |
| **LP** | `deposit`, `withdrawFree`, `claimProceeds`, `createOffer` (using governance-approved adapters), `topUpOffer`, `decreaseOffer`, `pauseOffer`, `unpauseOffer`, `cancelOffer`, `V3PositionSegregator.withdrawAndSegregate` | Cannot withdraw `ticketReserved` inventory before expiry; cannot mutate active tickets; cannot supply unapproved oracles or compliance hooks |
| **Trader / Taker** | `reserve` (pays upfront premium), `exercise` / `ExecutionRouter.batchExercise` (if ticket owner/authorized) | Cannot exercise expired tickets (`block.timestamp > expiresAt`), exceed `remainingAmount`, or leave dust `< minFillAmount` |
| **Ticket Owner (`ownerOf`)** | `transferFrom` / `safeTransferFrom`, `approve`, `setApprovalForAll`, EIP-712 `permit`, `splitTicket`, `exercise` | Transfers & splits subject to `IComplianceHook.beforeTransfer(id, owner, to)` if hook set |
| **Approved Operator / Spender** | `transferFrom`, `splitTicket` (checked against `ownerOf(id)` compliance, not spender), `exercise`, `ExecutionRouter.batchExercise` | Cannot bypass `ownerOf` compliance checks; `permit` nonces invalidate automatically on transfer |
| **Approved Router (`ExecutionRouter`)** | Calls `CommitmentManager.exerciseFor(..., exerciser, tokenReceiver, finalReceiver)` | Cannot spend arbitrary tickets without `ticketNft.isAuthorized(msg.sender, id)`; cannot bypass caller or `finalReceiver` compliance |
| **Security Guardian (`2-of-3` Safe)** | Instant (`0s`) `LiquidityVault.setDepositsPaused`, `CommitmentManager.setNewReservationsPaused`, `CommitmentManager.setFloatingExercisePaused`, `SignedPullOracle.revokePrice`, and `TimelockController.cancel` | **Zero custody access.** Cannot withdraw funds, change fees, add signers, allowlist adapters, or block `FIXED` exercises, LP withdrawals, or expiry reclaims (`INV-8`) |
| **Governance (`3-of-5` Safe -> `TimelockController`)** | Timelocked `owner()` of all 6 admin contracts: `setProtocolFeeBps` (`<= 100` bps), `setTokenMinTicketAmount`, `setApprovedOracle/ComplianceHook/Router`, `setGuardian`, `setPendingFeeCollector`, `SignedPullOracle.addSigner/removeSigner/setThreshold/setMaxJumpBps/setMaxPriceAge`, `OraclePriceAdapter.setPairConfig`, `UniswapV3TwapOracle.setPoolConfig`, `HSPComplianceHook.setAttestationSigner/setApproved/revoke` | Cannot seize LP inventory or proceeds, bypass `MAX_PROTOCOL_FEE_BPS = 100`, or mutate active tickets (`INV-4`); all changes wait `minDelay` |
| **Treasury (`2-of-3` Safe)** | `acceptFeeCollector()` and `withdrawProtocolFees(token, to)` | Zero parameter, pause, or LP-fund authority |
| **Oracle Signers (`M-of-N` quorum)** | Sign off-chain EIP-712 `PriceReport` digests (`ProtocolSignedPullOracle` v2) submitted permissionlessly via `updatePrice` | Single compromised signer cannot meet `threshold >= 2`; updates bounded by monotonic `reportTimestamp <= block.timestamp`, `maxJumpBps`, `OraclePriceAdapter` hard bounds, and secondary deviation breaker |
| **Permissionless Keeper / Anyone** | `reclaimExpired`, `reclaimExpiredBatch`, `reclaimExpiredBatchBestEffort`, `SignedPullOracle.updatePrice` (with valid M-of-N sigs), `HSPComplianceHook.submitAttestation` (with valid signer sig) | Cannot reclaim unexpired tickets (`block.timestamp <= expiresAt`) |

---

## 3. Primary Attack Surfaces for Independent Auditors

1. **Cross-Decimal & Rounding Math (`CommitmentManager`):** `PRICE_SCALE = 1e36` scaling between 6-, 8-, and 18-decimal tokens; `Math.mulDiv(..., Ceil)` on premiums, exercise payments, and protocol fees; zero-payment or sub-minimum remainder edge cases.
2. **Oracle Quorum & Circuit Breakers (`SignedPullOracle`, `OraclePriceAdapter`, `UniswapV3TwapOracle`):** Ascending-order ECDSA recovery in `updatePrice`; `maxJumpBps` integer math `(diff * BPS_DENOMINATOR) / prev.priceX36` (note: check large-`priceX36` multiplication overflow vs. `Math.mulDiv`); `revokePrice` replay guard; `OraclePriceAdapter` fail-closed `requireSecondaryCheck` logic; V3 TWAP `observe()` tick arithmetic and cardinality checks.
3. **Router & Ticket Permit Composition (`ExecutionRouter`, `ExecutionTicket`):** Native `HSK` refund push to `msg.sender`; `unwrapInventoryToNative` flow; `permit()` + `transferFrom` nonce invalidation; `isApprovedForAll` signer edge cases.
4. **Compliance Isolation (`HSPComplianceHook`, `CommitmentManager`, `ExecutionTicket`):** Confirm no path lets a sanctioned party bypass `beforeCreateOffer`, `beforeReserve`, `beforeTransfer`, or `beforeExercise`, while confirming no hook revert can trap LP capital (`INV-8`).
5. **Malicious / Non-Standard ERC-20 Tokens (`LiquidityVault`, `V3PositionSegregator`):** Fee-on-transfer tokens (`UnsupportedTokenBalanceDelta`), rebasing tokens, ERC-777 callbacks (`nonReentrant`), non-standard `approve`/`transfer` returns (`SafeERC20` / `forceApprove`).
