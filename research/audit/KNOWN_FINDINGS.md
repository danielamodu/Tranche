# Tranche — Known Prior Findings & Remediation Ledger

> **Purpose:** Full disclosure to independent auditors of every security, economic, and oracle defect identified during Phase 1 (against frozen `main` commit `f5d61e76134fd3badc831d10136318431aabd413`) and how each was remediated in Phase 2 (`remediation/mainnet-readiness` commit `76a85882d04af446e3e82d8421641a3769467c6e`).  
> **Original Baseline PoCs Preserved:** [`research/pocs/SecurityAuditPoC.t.sol`](../pocs/SecurityAuditPoC.t.sol) and [`research/pocs/BaselineDefectPoC.t.sol`](../pocs/BaselineDefectPoC.t.sol)  
> **Regression Suite:** [`contracts/test/RemediationRegression.t.sol`](../../contracts/test/RemediationRegression.t.sol) (`15/15` passing)

Passing internal regression tests are **not** a substitute for independent review; auditors are explicitly requested to re-verify every fix below for completeness and edge-case regressions.

---

## 1. High-Severity Findings (3)

| ID | Original Finding (`main` `f5d61e76`) | Implemented Remediation (`76a85882`) | Regression Test | Residual Risk / Auditor Check |
| --- | --- | --- | --- | --- |
| **`H-01`** | `OraclePriceAdapter` silently bypassed `maxDeviationBps` whenever secondary feed was unhealthy (`if (pOk && !sOk) return p;`) and shared one `maxStaleness` across both feeds. | Added `bool requireSecondaryCheck` and independent `uint32 secondaryMaxStaleness` to `PairConfig`; fails closed (`isValid: false`) if `requireSecondaryCheck && !sOk`; switched deviation math to `Math.mulDiv`. | `test_Reg_H1_OracleAdapterFailsClosedWhenRequiredSecondaryUnhealthy` | On pairs where `requireSecondaryCheck == false` (thin V3 pools / testnet), safety relies on M-of-N `SignedPullOracle` quorum, `maxJumpBps`, and `hardMin/Max`. |
| **`H-02`** | `ExecutionRouter.batchExercise` caused `CommitmentManager.exercise` to check `IComplianceHook` against `address(router)` instead of caller and `params.receiver` (DoS if unlisted; full sanctions bypass if allowlisted). | Added `approvedRouters` registry and `CommitmentManager.exerciseFor(..., exerciser, tokenReceiver, finalReceiver)` enforcing `beforeExercise(ticketId, exerciser, finalReceiver)` while pulling payment from the router. | `test_Reg_H2_ExecutionRouterEnforcesComplianceOnCallerAndReceiver` | Only audited, non-malicious routers may be allowlisted via timelocked `setApprovedRouter`. |
| **`H-03`** | `CommitmentManager.splitTicket` passed `msg.sender` instead of `ticketNft.ownerOf(ticketId)` to `beforeTransfer`, letting an approved compliant operator extract a sanctioned owner's ticket. | `splitTicket` now queries `address owner = ticketNft.ownerOf(ticketId)` and passes `(ticketId, owner, recipient)` to `beforeTransfer`. | `test_Reg_H3_SplitTicketChecksOwnerComplianceNotSpender` | Verify whether operator/spender compliance should also be checked or if owner+recipient is sufficient. |

---

## 2. Medium-Severity Findings (5)

| ID | Original Finding (`main` `f5d61e76`) | Implemented Remediation (`76a85882`) | Regression Test | Residual Risk / Auditor Check |
| --- | --- | --- | --- | --- |
| **`M-01`** | Untrusted LPs could pass malicious stateful `complianceHook` or `oracle` contracts to `createOffer`, collect taker premiums, then flip hooks to block `exercise()` and reclaim inventory. | Added governance-controlled `approvedOracles` and `approvedComplianceHooks` allowlists checked in `createOffer()`. | `test_Reg_M1_CreateOfferRejectsUnapprovedOracleAndHook` | Governance must verify any allowlisted adapter is non-honeypot before approval. |
| **`M-02`** | `ExecutionTicket._update()` did not increment `nonces[tokenId]` on transfer, allowing unused EIP-712 `permit` signatures to replay if the original owner reacquired the ticket. | `ExecutionTicket._update()` increments `nonces[tokenId]++` on every transfer (`from != address(0) && to != address(0)`). | `test_Reg_M2_PermitNonceInvalidatedOnTransferAndEmitsApproval` | Unused permits remain valid until `deadline` if the ticket is never transferred and nonce is not manually bumped. |
| **`M-03`** | `setProtocolFeeBps`, `setMinTicketAmount`, and `setPairConfig` retroactively mutated active offers/tickets. | Snapshotted `protocolFeeBps` onto `Offer` and snapshotted `protocolFeeBps`, `minFillAmount`, `spreadBps`, `oracle`, `complianceHook`, and price bounds onto `Ticket` at `reserve()`. Placed `setPairConfig` behind `TimelockController`. | `test_Reg_M3_AdminFeeAndMinUpdatesDoNotMutateActiveTickets` | `OraclePriceAdapter.setPairConfig` remains mutable via timelock; active `FLOATING` tickets are still bounded by snapshotted `fixedOrMinPriceX36` / `maxPriceX36`. |
| **`M-04`** | `exercise()` did not enforce `minFillAmount`, allowing `1-wei` un-splittable dust remainders and `0`-fee micro-fills via `Floor` rounding. | Partial `exercise`/`exerciseFor` enforces `actualFill == t.remainingAmount \|\| (actualFill >= t.minFillAmount && newRem >= t.minFillAmount)`; non-zero `protocolFee` rounds `Ceil` (`_computeFeeCeil`). | `test_Reg_M4_PartialExerciseEnforcesMinFillAndCeilFeeRounding` | Verify boundary arithmetic when `t.remainingAmount` is close to `2 * minFillAmount`. |
| **`M-05`** | `CommitmentManager` lacked `setGuardian()` (permanent pause griefing if guardian compromised), and all 6 admin contracts used `immutable admin` with no ownership transfer. | Migrated all 6 admin-gated contracts to OZ `Ownable2Step`; added `CommitmentManager.setGuardian` and `SignedPullOracle.setGuardian`. | `test_Reg_M5_OwnershipTransferAndGuardianRotationWork` | Security depends on multisig + timelock operational discipline. |

---

## 3. Low & Informational Findings (8)

| ID | Original Finding (`main` `f5d61e76`) | Implemented Remediation (`76a85882`) | Regression / Check |
| --- | --- | --- | --- |
| **`L-01`** | `reclaimExpiredBatch` reverted atomically if any 1 ticket in the array was inactive/unexpired. | Added `reclaimExpiredBatchBestEffort(uint256[]) returns (uint256 reclaimedCount)`. | `test_Reg_L1_ReclaimExpiredBatchBestEffortSkipsInactive` |
| **`L-02`** | `reserve()` allowed `ticket.expiresAt` to exceed `offer.expiry` by up to `30 days`. | Enforced `block.timestamp + duration <= o.expiry` in `reserve()`. | `test_Reg_L2_ReserveBoundedByOfferExpiry` |
| **`L-03`** | `ExecutionRouter` constructor did not check `address(ticketNft) != address(0)`. | Added `if (address(ticketNft) == address(0) \|\| vault == address(0)) revert ZeroAddress();`. | `test_Reg_L3_ExecutionRouterRejectsUnsetTicketNft` |
| **`L-04`** | `SignedPullOracle.getPriceX36()` had no internal TTL; `UniswapV3TwapOracle` allowed `minCardinality <= 1`; `OraclePriceAdapter` used raw `(diff * BPS_DENOMINATOR)`. | Added `maxPriceAge` TTL in `SignedPullOracle`, `minCardinality >= 2` in `UniswapV3TwapOracle`, and `Math.mulDiv` in `OraclePriceAdapter`. | `test_Reg_L4_SignedPullOracleTTLAndTwapMinCardinality` |
| **`I-01`** | `V3PositionSegregator` reverted `ZeroLiquidity()` on fee-only collection (`posLiquidity == 0`). | Allowed `liq == 0` when `posLiquidity == 0` and reverts only if `collected0 == 0 && collected1 == 0`. | Verified in `V3PositionSegregator.sol#L60-L85` |
| **`I-02`** | `LiquidityVault.setFeeCollector` was single-step (risk of typo losing fees). | Replaced with two-step `setPendingFeeCollector` + `acceptFeeCollector`. | Verified in `TestnetOperationalValidation.t.sol` |
| **`I-03`** | `ExecutionTicket.permit` passed `emitEvent = false` to `_approve`. | Changed to `_approve(spender, tokenId, address(0), true)`. | `test_Reg_M2_PermitNonceInvalidatedOnTransferAndEmitsApproval` |
| **`I-04`** | `CommitmentManager.topUpOffer` allowed topping up an already-expired offer. | Added `if (block.timestamp >= o.expiry) revert OfferExpired();`. | Verified in `CommitmentManager.sol#L251` |

---

## 4. Economic & Oracle Configuration Defects Remediated

| ID | Defect (`main` `f5d61e76`) | Remediation (`76a85882`) | Regression Test |
| --- | --- | --- | --- |
| **`Econ-1`** | Default `protocolFeeBps = 50` (0.50% on full exercise notional) caused guaranteed LP loss on baseline spreads. | Lowered `MAX_PROTOCOL_FEE_BPS = 100` (1.00% cap) and default deployment fee to `5` bps (`0.05%`), snapshotted per offer/ticket. | `test_Reg_Econ1_ProtocolFee5BpsYieldsPositiveLPEconomics` |
| **`Econ-2`** | Single global `minTicketAmount = 100e18` broke 8-decimal `WBTC` and 6-decimal `USDT` offers. | Replaced with per-token `tokenMinTicketAmount[token]` + per-offer `minFillAmount >= tokenMinTicketAmount[invToken]`. | `test_Reg_Econ2_CrossDecimalWBTCAndUSDTOffersSucceed` |
| **`Oracle-1`** | Single-signer `SignedPullOracle`, no jump cap, no `revokePrice`, no guardian floating pause, and narrow `1e18..1e27` test bounds broke `WETH/USDT` & `WBTC/USDT`. | Upgraded to M-of-N `SignedPullOracle` (`2-of-3`+) + `maxJumpBps` + `revokePrice` + `CommitmentManager.setFloatingExercisePaused` + decimal-aware pair bounds. | `test_Reg_Oracle1_MOfN_JumpCap_Revoke_And_WETH_WBTC_Bounds` |

---

## 5. Known Open / Intentional Design Trade-Offs (Not Yet Changed)
1. **Unchecked Multiplication in `SignedPullOracle.updatePrice` Jump Cap (`SignedPullOracle.sol#L182`):** Uses `(diff * BPS_DENOMINATOR) / prev.priceX36 > jumpCap`. For realistic X36 token prices (`<= 1e45`), `diff * 10_000` is far below `type(uint256).max` (`~1.15e77`), but switching to `Math.mulDiv` would harden extreme-scale edge cases.
2. **Native Refund Push in `ExecutionRouter.sol#L101-L103`:** Unused `msg.value` is unwrapped and pushed to `msg.sender`; smart-contract callers paying native `HSK` must implement `receive()`.
3. **`UniswapV3TwapOracle.getPriceX36()` Timestamp:** Stamps `updatedAt = block.timestamp` upon reading `observe()`; mitigates thin-pool manipulation only when paired with `minCardinality >= 100` on deep pools.
4. **Federated M-of-N Pull Oracle Trust:** Until Chainlink Data Streams credentials/feed IDs are provisioned on HashKey Chain, `SignedPullOracle` relies on a federated M-of-N signer set.
