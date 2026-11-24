# Tranche — Independent Smart Contract Security Audit (Phase 1, Workstream A)

> **Audit Target:** Tranche Protocol (`contracts/src/`)  
> **Frozen Git Commit:** `f5d61e76134fd3badc831d10136318431aabd413` (`main`)  
> **Toolchain:** Solidity `0.8.24`, Foundry (`evm_version = "shanghai"`, `optimizer = true`, `runs = 200`)  
> **Deliverables:** [SECURITY_AUDIT.md](file:///c:/Users/USER/Desktop/Tranche/research/SECURITY_AUDIT.md), [SECURITY_FINDINGS.md](file:///c:/Users/USER/Desktop/Tranche/research/SECURITY_FINDINGS.md), [SecurityAuditPoC.t.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/test/SecurityAuditPoC.t.sol)  
> **Rule Zero Compliance:** Zero modifications to `contracts/src/`, existing test suites, `sdk/`, `hsp/`, `agent/`, `demo/`, `README.md`, or `foundry.toml`.

---

## 1. Audit Methodology

This independent security audit combined:
1. **Manual Line-by-Line Source Review:** Exhaustive inspection of all 11 Solidity files in `contracts/src/` (`2,000+` lines across core custody, commitment lifecycle, ERC-721 ticket permit/transfer, batch routing, V3 position segregation, signed/TWAP oracles, and HSP compliance hooks).
2. **Adversarial Focus-Area Evaluation:** Systematic verification against all 10 mainnet-readiness focus areas (custody solvency, role boundaries, EIP-712 replay, ERC-721 transfer/exercise semantics, partial-fill rounding, reentrancy/callbacks, oracle manipulation/circuit breakers, LP recovery, weird ERC-20 compatibility, and governance/upgradeability).
3. **Executable PoC Verification:** Authoring and running independent Foundry exploit/invariant tests in [SecurityAuditPoC.t.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/test/SecurityAuditPoC.t.sol) against the unmodified frozen contracts.

---

## 2. File-by-File Inspection Matrix

| File | LOC | Responsibility | Key Audit Observations | Findings |
| --- | --- | --- | --- | --- |
| [IProtocol.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/interfaces/IProtocol.sol) | 277 | Shared structs, enums, and core/adapter interfaces | Clean type definitions; `IComplianceHook` & `IPriceOracle` methods are `view` (`STATICCALL`) | — |
| [LiquidityVault.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/LiquidityVault.sol) | 345 | 5-bucket 1:1 ERC-20 custody, `_pullExact` FoT defense, pull-based proceeds | Strict CEI + `nonReentrant`, `_pullExact` rejects FoT/rebasing deltas; `admin` immutable; `setGuardian`/`setFeeCollector` single-step | `M-05`, `I-02` |
| [ExecutionTicket.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/ExecutionTicket.sol) | 117 | ERC-721 ticket NFT, EIP-712 `permit`, secondary transfer compliance hook | Uses `_mint` (no `onERC721Received` reentrancy); `permit` nonces not incremented on transfer; suppresses `Approval` event | `M-02`, `I-03` |
| [CommitmentManager.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol) | 545 | Offer lifecycle, reservation, exercise, split, expiry reclaim, pricing/fees | Core solvency sound; `splitTicket` passes `msg.sender` to `beforeTransfer`; `exercise` ignores `minFillAmount` & floors fees to 0; mutable `protocolFeeBps`/`minTicketAmount`; missing `setGuardian`; untrusted `oracle`/`complianceHook`; atomic `reclaimExpiredBatch`; ticket expiry > offer expiry | `H-02`, `H-03`, `M-01`, `M-03`, `M-04`, `M-05`, `L-01`, `L-02`, `I-04` |
| [ExecutionRouter.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/ExecutionRouter.sol) | 132 | Multi-leg `batchExercise`, native `HSK`/`WHSK` wrap/unwrap | Confused-deputy guard (`isAuthorized`) present; breaks `IComplianceHook` on `beforeExercise`; constructor lacks `address(ticketNft) != 0` check; push native refund | `H-02`, `L-03` |
| [ForgeSmoke.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/ForgeSmoke.sol) | 10 | Phase 1 toolchain smoke contract | Non-production test artifact left inside `contracts/src/` | `I-04` |
| [V3PositionSegregator.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/V3PositionSegregator.sol) | 118 | HSKSwap V3 liquidity withdrawal & vault deposit periphery | Checks `nfpm.ownerOf(tokenId) == msg.sender`; resets ERC-20 allowances; rejects fee-only collect when `posLiquidity == 0` | `I-01` |
| [SignedPullOracle.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/SignedPullOracle.sol) | 89 | EIP-712 signed price feed | Monotonic `reportTimestamp > updatedAt`; single EOA signer; no internal staleness TTL in `getPriceX36`; immutable `admin` | `M-05`, `L-04` |
| [UniswapV3TwapOracle.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/UniswapV3TwapOracle.sol) | 153 | V3 `observe()` TWAP adapter | Tick math & `_sqrtPriceToPriceX36` accurate; hardcodes `updatedAt: block.timestamp`; allows `minCardinality <= 1`; immutable `admin` | `M-05`, `L-04` |
| [OraclePriceAdapter.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/OraclePriceAdapter.sol) | 95 | Staleness, hard bounds, and cross-feed deviation circuit breaker | **Silently bypasses `maxDeviationBps` when `pOk && !sOk`**; shared `maxStaleness`; retroactive `setPairConfig`; `(diff * 10_000)` unchecked mul; immutable `admin` | `H-01`, `M-03`, `M-05`, `L-04` |
| [HSPComplianceHook.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/HSPComplianceHook.sol) | 96 | Optional allowlist & revocable EIP-712 KYC attestations | Proper nonce increment on `revoke` & `submitAttestation`; immutable `admin` | `M-05` |

---

## 3. Assessment Across the 10 Focus Areas

1. **Custody & Physical Solvency (`LiquidityVault`):**
   - **Verified Sound:** All 5 buckets (`lpFreeBalance`, `offerBalance`, `ticketReserved`, `lpPendingProceeds`, `protocolFees`) and their `total*` mirrors maintain strict conservation. Direct token transfers do not inflate internal buckets, outbound transfers never exceed accounted obligations, and `invToken == payToken` is blocked at `createOffer`.
2. **Authorization & Role Boundaries:**
   - **Weaknesses Found:** `ExecutionRouter` -> `CommitmentManager` breaks `IComplianceHook.beforeExercise` caller/receiver attribution (`H-02`); `CommitmentManager.splitTicket` passes `msg.sender` instead of `ownerOf(ticketId)` to `beforeTransfer` (`H-03`); `CommitmentManager` lacks `setGuardian` (`M-05`).
   - **Verified Sound:** `ExecutionRouter` checks `ticketNft.isAuthorized(msg.sender, leg.ticketId)` on every leg; `V3PositionSegregator` checks `nfpm.ownerOf(p.tokenId) == msg.sender`; `LiquidityVault.setManager` and `CommitmentManager.setTicketNft` are single-assignment.
3. **EIP-712 Signatures, Nonces & Replay:**
   - **Weakness Found:** `ExecutionTicket.permit()` does not invalidate `nonces[tokenId]` on transfer, allowing replay if the original signer reacquires the ticket (`M-02`), and suppresses `Approval` events (`I-03`).
   - **Verified Sound:** `SignedPullOracle` enforces monotonic `reportTimestamp > updatedAt` and `reportTimestamp <= block.timestamp`; `HSPComplianceHook` binds `(chainId, verifyingContract, subject, nonce, expiry)` and increments `nonces[subject]` on both `submitAttestation` and `revoke`.
4. **ERC-721 Transfers & Exercise Permissions:**
   - OpenZeppelin v5 `ERC721._update` clears single-token `getApproved` on transfer/burn.
   - `ExecutionRouter` wraps/unwraps `WHSK` safely under `nonReentrant` and resets `forceApprove(vault, 0)` after the loop, though constructor fails to validate `address(ticketNft) != address(0)` (`L-03`).
5. **Partial Fills, Rounding & Split Operations:**
   - **Weakness Found:** `CommitmentManager.exercise()` does not enforce `minFillAmount` or `minTicketAmount` on `actualFill` or `newRem`, permitting `1-wei` dust remainders and `0`-fee micro-fills via `Math.Rounding.Floor` (`M-04`).
   - **Verified Sound:** `grossPremium` and `grossPayment` use `Math.Rounding.Ceil` (`ZeroPaymentCalculated` blocks `0`-payment fills); `_resolveFloatingPrice` clamps cleanly to `[minPriceX36, maxPriceX36]` with `spreadBps > -10_000`.
6. **Reentrancy & Callback Safety:**
   - **Verified Sound:** All state-mutating functions across `LiquidityVault`, `CommitmentManager`, `ExecutionRouter`, and `V3PositionSegregator` use `nonReentrant` and follow CEI. `ExecutionTicket.mint` uses `_mint` (not `_safeMint`), preventing `onERC721Received` callbacks. External `IComplianceHook` / `IPriceOracle` calls use `view` (`STATICCALL`).
   - **Trust Gap Found:** Untrusted LPs can supply stateful `complianceHook` / `oracle` contracts that flip post-reservation (`M-01`).
7. **Oracle Manipulation & Stale Prices:**
   - **Critical Gap Found (High):** `OraclePriceAdapter` silently bypasses `maxDeviationBps` whenever `sOk == false` (`pOk && !sOk`) and couples fast/slow feeds under a single `maxStaleness` (`H-01`). `UniswapV3TwapOracle` hardcodes `updatedAt: block.timestamp` and allows `minCardinality <= 1`, while `SignedPullOracle.getPriceX36` has no internal TTL (`L-04`).
8. **LP Withdrawals & Emergency Recovery:**
   - **Verified Sound:** `withdrawFree`, `claimProceeds`, `decreaseOffer`, `cancelOffer`, `exercise`, and `reclaimExpired` are all unpausable and free of compliance/oracle dependencies (except `FLOATING` `exercise`, which inherently requires price).
   - **Friction Found:** `reclaimExpiredBatch` reverts atomically on any already-reclaimed/non-expired ticket (`L-01`), and `reserve()` allows ticket `expiresAt` to exceed `offer.expiry` (`L-02`).
9. **Token Compatibility & Malicious Token Behavior:**
   - **Verified Sound:** `_pullExact` rejects fee-on-transfer and downward-rebasing tokens (`UnsupportedTokenBalanceDelta`); `ExecutionRouter` uses `SafeERC20.forceApprove`; `LiquidityVault` never calls `transfer(0)` or `transferFrom(0)`.
10. **Upgradeability, Ownership & Privileged Operations:**
    - **Weaknesses Found:** Core and adapter contracts use `immutable admin` with no transfer/timelock mechanism and `CommitmentManager` omits `setGuardian` (`M-05`); `setProtocolFeeBps`, `setMinTicketAmount`, and `OraclePriceAdapter.setPairConfig` mutate active commitments retroactively (`M-03`).

---

## 4. Trust & Privilege Matrix

| Role | Contract(s) | Capabilities | Risks / Constraints |
| --- | --- | --- | --- |
| **`admin` (immutable EOA/multisig)** | `Vault`, `Manager`, `Oracles`, `OracleAdapter`, `HSPHook` | One-time `setManager`/`setTicketNft`; `setGuardian` (Vault only); `setFeeCollector`; `setProtocolFeeBps` (≤ 500 bps); `setMinTicketAmount`; `setPairConfig`; `setAuthorizedSigner`; `setAttestationSigner`; `setApproved`/`revoke` | **No `transferAdmin`** anywhere; retroactive changes to `protocolFeeBps`, `minTicketAmount`, `setPairConfig`, and `setAuthorizedSigner` impact live tickets/offers (`M-03`, `M-05`). Cannot sweep user custody. |
| **`guardian`** | `Vault`, `Manager` | `setDepositsPaused`, `setNewReservationsPaused` | Cannot block withdrawals, claims, cancellations, exercises, or reclaims. **Cannot be rotated on `CommitmentManager`** (`M-05`). |
| **`feeCollector`** | `Vault` | `withdrawProtocolFees` | Single-step setter by `admin` (`I-02`). |
| **LP (Untrusted)** | `Vault`, `Manager` | Deposit/withdraw free funds; create/manage offers; choose `oracle` & `complianceHook`; claim proceeds | Can supply malicious stateful `complianceHook`/`oracle` (`M-01`) unless UI/SDK/registry filters offers. Cannot cancel or drain reserved tickets. |
| **`authorizedSigner` / `attestationSigner`** | `SignedPullOracle`, `HSPComplianceHook` | Sign off-chain price updates / KYC attestations | Single-signer EOA key compromise risk; `SignedPullOracle` has no max-jump bound (relies on `OraclePriceAdapter` breaker, which has bypass `H-01`). |

---

## 5. PoC Verification Summary

- **Existing Suite (`forge test`):** Ran all 4 pre-existing test suites (`ForgeSmokeTest`, `HashKeyForkPrototypeTest`, `ProtocolAdversarialTest`, `ProtocolInvariantTest`) — **26 / 26 tests passed**.
- **Audit PoC Suite (`forge test --match-contract SecurityAuditPoCTest -vv`):** **10 / 10 tests passed** in [SecurityAuditPoC.t.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/test/SecurityAuditPoC.t.sol):
  - `[PASS] test_PoC_H1_OracleAdapterBypassesDeviationBreakerWhenSecondaryUnhealthy`
  - `[PASS] test_PoC_H2_ExecutionRouterBreaksHSPComplianceHook`
  - `[PASS] test_PoC_H3_SplitTicketBypassesComplianceCheckOnSanctionedOwner`
  - `[PASS] test_PoC_M1_MaliciousLPHoneypotHookRugsTakerPremium`
  - `[PASS] test_PoC_M2_ExecutionTicketPermitReplayAfterTransferCycle`
  - `[PASS] test_PoC_M3_RetroactiveAdminFeeHikeAndMinTicketLockout`
  - `[PASS] test_PoC_M4_MicroFillZeroProtocolFeeAndDustRemainder`
  - `[PASS] test_PoC_M5_UnrotatableCommitmentManagerGuardianPermanentPause`
  - `[PASS] test_PoC_L1_ReclaimExpiredBatchAtomicDoSGrief`
  - `[PASS] test_PoC_L2_TicketExpiryExceedsOfferExpiry`
