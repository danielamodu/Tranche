# Tranche — Phase 2 Controlled Remediation Specification (Workstream A & Primary Lead)

> **Frozen Baseline Preserved:** `main` @ `f5d61e76134fd3badc831d10136318431aabd413`  
> **Remediation Branch:** `remediation/mainnet-readiness`  
> **Companion Specs:** [ORACLE_DESIGN.md](file:///c:/Users/USER/Desktop/Tranche/research/ORACLE_DESIGN.md), [ECONOMIC_FIXES.md](file:///c:/Users/USER/Desktop/Tranche/research/ECONOMIC_FIXES.md), [GOVERNANCE_DESIGN.md](file:///c:/Users/USER/Desktop/Tranche/research/GOVERNANCE_DESIGN.md)

---

## 1. Baseline Defect Reproduction Ledger (Rule 2)

Every finding below was independently reproduced on the **unmodified frozen contracts** (`f5d61e76`) before any remediation code was written:
- `forge test --match-contract "SecurityAuditPoCTest|BaselineDefectPoCTest" -vv`: **`13 passed, 0 failed, 0 skipped`** (`3/3` in [`BaselineDefectPoC.t.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/test/BaselineDefectPoC.t.sol), `10/10` in [`SecurityAuditPoC.t.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/test/SecurityAuditPoC.t.sol)).

| ID | Exact Location (`f5d61e76`) | Preconditions & Impact | Baseline PoC Test (PASS = Defect Confirmed) |
| --- | --- | --- | --- |
| **`H-01`** | `OraclePriceAdapter.sol#L54-L72` | `if (pOk && !sOk) return p;` + shared `30s` `maxStaleness`: if `UniswapV3TwapOracle` is stale/unhealthy, `maxDeviationBps` is silently bypassed, allowing arbitrary `SignedPullOracle` prices within hard bounds. | `test_PoC_H1_OracleAdapterBypassesDeviationBreakerWhenSecondaryUnhealthy` |
| **`H-02`** | `ExecutionRouter.sol#L87-L102`, `CommitmentManager.sol#L318-L320` | `batchExercise` makes `CommitmentManager` see `msg.sender = router` (and `receiver = router` when unwrapping native `HSK`). Unlisted router DoS's compliant users; allowlisted router lets sanctioned callers/receivers bypass `HSPComplianceHook`. | `test_PoC_H2_ExecutionRouterBreaksHSPComplianceHook` |
| **`H-03`** | `CommitmentManager.sol#L374-L389` | `splitTicket` passes `msg.sender` to `beforeTransfer` instead of `ticketNft.ownerOf(ticketId)`, allowing a compliant approved spender to extract value from a sanctioned ticket owner. | `test_PoC_H3_SplitTicketBypassesComplianceCheckOnSanctionedOwner` |
| **`M-01`** | `CommitmentManager.sol#L156-L163`, `265-267`, `318-320` | Untrusted LPs can set arbitrary stateful `complianceHook` or `oracle` contracts on `createOffer`, collect taker premiums, then flip hooks to block `exercise()` and reclaim inventory post-expiry. | `test_PoC_M1_MaliciousLPHoneypotHookRugsTakerPremium` |
| **`M-02`** | `ExecutionTicket.sol#L64-L93` | `nonces[tokenId]` is not incremented on transfer (`_update`), allowing unused `permit` signatures to replay if the original signer reacquires the ticket; `permit` also omits `Approval` event (`I-03`). | `test_PoC_M2_ExecutionTicketPermitReplayAfterTransferCycle` |
| **`M-03`** | `CommitmentManager.sol#L124-L133`, `380-385`, `521`; `OraclePriceAdapter.sol#L31-L38` | `setProtocolFeeBps`, `setMinTicketAmount`, and `setPairConfig` retroactively alter active tickets (up to 5% LP revenue cut, split lockout, or oracle shift). | `test_PoC_M3_RetroactiveAdminFeeHikeAndMinTicketLockout` |
| **`M-04`** | `CommitmentManager.sol#L322-L335`, `520-521` | `exercise()` ignores `minFillAmount`/`minTicketAmount`, allowing `1-wei` un-splittable dust remainders and `0`-fee micro-fills via `Floor` rounding. | `test_PoC_M4_MicroFillZeroProtocolFeeAndDustRemainder` |
| **`M-05`** | `CommitmentManager.sol#L86-L87`, `135-139`; all `admin` contracts | `CommitmentManager` lacks `setGuardian()` (permanent pause griefing if guardian compromised); all 6 admin contracts use `immutable admin` with no ownership transfer. | `test_PoC_M5_UnrotatableCommitmentManagerGuardianPermanentPause` |
| **`L-01`** | `CommitmentManager.sol#L425-L451` | `reclaimExpiredBatch` reverts atomically if any 1 ticket in the array is inactive or unexpired. | `test_PoC_L1_ReclaimExpiredBatchAtomicDoSGrief` |
| **`L-02`** | `CommitmentManager.sol#L258-L259`, `273` | `reserve()` permits `ticket.expiresAt` to exceed `offer.expiry` by up to `maxDuration` (`30 days`). | `test_PoC_L2_TicketExpiryExceedsOfferExpiry` |
| **`L-03`** | `ExecutionRouter.sol#L53-L59`, `113-122` | `ExecutionRouter` constructor skips `address(ticketNft) != address(0)` check; native `unused` refund pushes to `msg.sender`. | Code inspection (`ExecutionRouter.sol#L53-L59`) |
| **`L-04`** | `UniswapV3TwapOracle.sol#L34-L44`, `97`; `SignedPullOracle.sol#L76-L88`; `OraclePriceAdapter.sol#L59` | Hardcoded `updatedAt: block.timestamp`, `minCardinality <= 1` allowed, no internal TTL on direct `SignedPullOracle`, unguarded `(diff * BPS_DENOMINATOR)` multiply. | Code inspection |
| **`Econ-1`** | `CommitmentManager.sol#L337`, `520-521`; `deploy.ts#L139` | Repo default `protocolFeeBps = 50` charges 50 bps on full `grossPayment` notional at `exercise()`, causing guaranteed LP loss (`lpNet < spot`) on `(10, 10, 25)` baseline. | `test_PoC_Econ1_ProtocolFee50BpsCreatesNegativeLPEconomics` |
| **`Econ-2`** | `CommitmentManager.sol#L93`, `151`, `261`, `380` | Global raw `minTicketAmount = 100e18` blocks `1 WBTC` (`1e8`) and `10,000 USDT` (`1e10`) offers and forces `$170k` minimum on `WETH`. | `test_PoC_Econ2_GlobalMinTicketAmountBlocksWBTCAndUSDT` |
| **`Oracle-1`** | `HashKeyForkPrototype.t.sol#L84-L85`, `OraclePriceAdapter.sol` | Test hard bounds `1e18..1e27` reject valid `WETH/USDT` (`1.704e27`) and `WBTC/USDT` (`6.183e38`) prices. | `test_PoC_Oracle1_TestHardBoundsRejectValidWETHAndWBTC` |

---

## 2. Contract-by-Contract Remediation Architecture

### 2.1 `LiquidityVault.sol`
- Replace `immutable admin` with OpenZeppelin `Ownable2Step` (`constructor(address _owner, address _guardian, address _feeCollector)` -> `_owner` initial owner).
- Add two-step `pendingFeeCollector` / `setPendingFeeCollector` / `acceptFeeCollector` (`I-02`).
- Preserve all 5 custody buckets and `INV-1`–`INV-8` unmodified (`withdrawFree` and `claimProceeds` remain strictly non-pausable and non-hooked).

### 2.2 `ExecutionTicket.sol`
- Increment `nonces[tokenId]++` inside `_update()` whenever `from != address(0) && to != address(0)` (`M-02`, EIP-4494 semantics).
- Pass `emitEvent = true` in `_approve(spender, tokenId, address(0), true)` inside `permit()` (`I-03`).

### 2.3 `CommitmentManager.sol` & `IProtocol.sol`
- **Governance & Emergency Controls (`M-05`, Workstream B):**
  - Replace `immutable admin` with `Ownable2Step`.
  - Add `setGuardian(address _guardian)` (`onlyOwner`).
  - Add `bool public floatingExercisePaused` + `setFloatingExercisePaused(bool)` (`guardian` or `owner`), enforced **only** when `t.priceMode == PriceMode.FLOATING` inside `exercise()` / `exerciseFor()`. `FIXED` exercises and `reclaimExpired()` remain 100% live (`INV-8`).
- **Adapter & Router Allowlists (`M-01`, `H-02`):**
  - Add `mapping(address => bool) public approvedOracles`, `approvedComplianceHooks`, `approvedRouters` with `onlyOwner` setters.
  - `createOffer()` requires `p.oracle == address(0) || approvedOracles[p.oracle]` (for `FLOATING`, `approvedOracles[p.oracle]` must be `true`) and `p.complianceHook == address(0) || approvedComplianceHooks[p.complianceHook]`.
- **Snapshot Economics & Cross-Decimal Minimums (`M-03`, `M-04`, Workstream C):**
  - Lower `MAX_PROTOCOL_FEE_BPS = 100` (1% hard cap) and default `protocolFeeBps = 5` (`0.05%`) in deployments.
  - Replace global `uint256 minTicketAmount` with `mapping(address => uint256) public tokenMinTicketAmount` + `setTokenMinTicketAmount(address token, uint256 minAmount)`.
  - Store `uint16 protocolFeeBps` on `Offer` (`createOffer` snapshots current `protocolFeeBps`) and snapshot `uint16 protocolFeeBps` + `uint256 minFillAmount` onto `Ticket` at `reserve()`.
  - `createOffer` requires `p.minFillAmount >= tokenMinTicketAmount[p.inventoryToken]` and `p.minFillAmount > 0`.
  - `splitTicket` validates `splitAmount >= t.minFillAmount && parentRem >= t.minFillAmount` AND passes `ticketNft.ownerOf(ticketId)` (not `msg.sender`) to `beforeTransfer` (`H-03`).
  - `exercise` / `exerciseFor` enforces `actualFill == t.remainingAmount || (actualFill >= t.minFillAmount && newRem >= t.minFillAmount)` (`M-04`), and rounds non-zero `protocolFee` UP (`Math.Rounding.Ceil` when `t.protocolFeeBps > 0`, capped at `gross`).
- **Router Attribution & Expiry Hygiene (`H-02`, `L-01`, `L-02`, `I-04`):**
  - Add `exerciseFor(uint256 ticketId, uint256 fillAmount, uint256 maxPaymentIn, address exerciser, address tokenReceiver, address finalReceiver)` restricted to `approvedRouters[msg.sender]`, verifying `ticketNft.isAuthorized(exerciser, ticketId)`, invoking `beforeExercise(ticketId, exerciser, finalReceiver)`, and pulling payment from `msg.sender` (the router) while sending inventory to `tokenReceiver`.
  - Enforce `block.timestamp + duration <= o.expiry` in `reserve()` (`L-02`) and `block.timestamp < o.expiry` in `topUpOffer()` (`I-04`).
  - Add `reclaimExpiredBatchBestEffort(uint256[] calldata ticketIds)` returning `uint256 reclaimedCount` (`L-01`).

### 2.4 `ExecutionRouter.sol`
- Validate `address(ticketNft) != address(0)` in constructor (`L-03`).
- Call `manager.exerciseFor(leg.ticketId, leg.fillAmount, leg.maxLegPaymentIn, msg.sender, legReceiver, params.receiver)` (`H-02`).

### 2.5 Adapters (`SignedPullOracle.sol`, `OraclePriceAdapter.sol`, `UniswapV3TwapOracle.sol`, `HSPComplianceHook.sol`, `V3PositionSegregator.sol`)
- **`SignedPullOracle`:** `Ownable2Step`, `guardian`, M-of-N signer set (`isSigner`, `signerCount`, `threshold`), `updatePrice(..., bytes[] calldata signatures)` with strictly ascending recovered signers `>= threshold`, `maxJumpBps[pairKey]`, internal `uint32 public maxPriceAge` enforced in `getPriceX36()`, and `revokePrice(inv, pay)` callable by `owner` or `guardian`.
- **`OraclePriceAdapter`:** `Ownable2Step`, `PairConfig` gains `bool requireSecondaryCheck` and `uint32 secondaryMaxStaleness`; fails closed if `requireSecondaryCheck && !sOk` (`H-01`); uses `Math.mulDiv(diff, BPS_DENOMINATOR, minP)` (`L-04`).
- **`UniswapV3TwapOracle`:** `Ownable2Step`, enforces `minCardinality >= 2` (`L-04`).
- **`HSPComplianceHook`:** `Ownable2Step`.
- **`V3PositionSegregator`:** Allows fee-only collection when `posLiquidity == 0 && p.liquidityToWithdraw == 0` (`I-01`).

---

## 3. Finding -> Fix -> Verification -> Residual Risk Mapping

| Finding | Implemented Fix | Regression Test (`RemediationRegressionTest`) | Residual Risk (Explicit) |
| --- | --- | --- | --- |
| **`H-01`** | `requireSecondaryCheck` fail-closed + `secondaryMaxStaleness` + `Math.mulDiv` | `test_Reg_H1_OracleAdapterFailsClosedWhenRequiredSecondaryUnhealthy` | If `requireSecondaryCheck == false` (e.g., thin `WETH`/`WBTC` pools), security relies on M-of-N `SignedPullOracle` quorum + `maxJumpBps` + `hardMin/Max`. |
| **`H-02`** | `approvedRouters` + `CommitmentManager.exerciseFor(..., exerciser, tokenReceiver, finalReceiver)` | `test_Reg_H2_ExecutionRouterEnforcesComplianceOnCallerAndReceiver` | Governance must approve only non-malicious `ExecutionRouter` contracts; `approvedRouters` is timelocked. |
| **`H-03`** | `splitTicket` passes `ticketNft.ownerOf(ticketId)` to `beforeTransfer` | `test_Reg_H3_SplitTicketChecksOwnerComplianceNotSpender` | Hook must still revert if `from` or `to` is non-compliant (view-only contract behavior). |
| **`M-01`** | `approvedOracles` & `approvedComplianceHooks` allowlists in `createOffer` | `test_Reg_M1_CreateOfferRejectsUnapprovedOracleAndHook` | Governance must vet approved adapters to verify they are immutable/non-honeypot before allowlisting. |
| **`M-02` / `I-03`** | `nonces[tokenId]++` on transfer in `_update` + `emitEvent = true` in `permit` | `test_Reg_M2_PermitNonceInvalidatedOnTransferAndEmitsApproval` | Off-chain permits remain valid until `deadline` if never transferred and never cancelled. |
| **`M-03`** | Snapshot `protocolFeeBps` & `minFillAmount` on `Offer`/`Ticket` | `test_Reg_M3_AdminFeeAndMinUpdatesDoNotMutateActiveTickets` | `OraclePriceAdapter.setPairConfig` remains mutable for emergency updates (timelocked in production; active `FLOATING` tickets are protected by `Ticket.fixedOrMinPriceX36` / `maxPriceX36`). |
| **`M-04`** | Partial `exercise` enforces `minFillAmount` on fill & remainder; non-zero `protocolFee` rounds `Ceil` | `test_Reg_M4_PartialExerciseEnforcesMinFillAndCeilFeeRounding` | Final full-remaining fill can be `< minFillAmount` only if `remainingAmount` was already reduced to `minFillAmount` (`>= minFillAmount` invariant holds). |
| **`M-05` / `I-02`** | `Ownable2Step` across all 6 contracts + `CommitmentManager.setGuardian` + 2-step `feeCollector` | `test_Reg_M5_OwnershipTransferAndGuardianRotationWork` | Governance multisig security still depends on signer key hygiene and timelock operational discipline. |
| **`L-01`** | `reclaimExpiredBatchBestEffort` skips inactive/unexpired tickets | `test_Reg_L1_ReclaimExpiredBatchBestEffortSkipsInactive` | Individual failed items emit no reclaim event; keeper reconciles via `nextTicketId`. |
| **`L-02` / `I-04`** | `reserve` requires `block.timestamp + duration <= o.expiry`; `topUpOffer` requires `block.timestamp < o.expiry` | `test_Reg_L2_ReserveBoundedByOfferExpiry` | None. |
| **`L-03`** | `ExecutionRouter` constructor checks `address(ticketNft) != address(0)` | `test_Reg_L3_ExecutionRouterRejectsUnsetTicketNft` | Native `unused` refund still pushes to `msg.sender`; smart-contract callers using native `HSK` must implement `receive()`. |
| **`L-04`** | `SignedPullOracle` internal `maxPriceAge` + `minCardinality >= 2` in TWAP | `test_Reg_L4_SignedPullOracleTTLAndTwapMinCardinality` | `UniswapV3TwapOracle.updatedAt` still stamps `block.timestamp`; mitigate via `minCardinality >= 100` on deep pools only. |
| **`Econ-1`** | Default `protocolFeeBps = 5` (`MAX_PROTOCOL_FEE_BPS = 100`) + snapshot | `test_Reg_Econ1_ProtocolFee5BpsYieldsPositiveLPEconomics` | Mainnet profitability still requires bilateral/agentic orderflow (`>= $50k/day`) rather than passive retail DEX flow. |
| **`Econ-2`** | `tokenMinTicketAmount[token]` + per-offer `minFillAmount` | `test_Reg_Econ2_CrossDecimalWBTCAndUSDTOffersSucceed` | Governance must configure `tokenMinTicketAmount[token]` accurately per token decimals before listing. |
| **`Oracle-1`** | M-of-N `SignedPullOracle` + `maxJumpBps` + `revokePrice` + `floatingExercisePaused` + per-pair `WHSK/WETH/WBTC` bounds | `test_Reg_Oracle1_MOfN_JumpCap_Revoke_And_WETH_WBTC_Bounds` | M-of-N quorum remains federated/permissioned until Chainlink Data Streams feed IDs & API access are provisioned on chain `177`. |

---

## 4. Post-Remediation Verification Results (`remediation/mainnet-readiness`)

All tests below ran after the final remediation edits across contracts and TypeScript packages:

| Verification Suite | Command | Result |
| --- | --- | --- |
| **Foundry Local (Smoke + Remediation Regression + Adversarial + Invariant)** | `forge test --no-match-contract HashKeyForkPrototypeTest -vv` | **40 passed, 0 failed, 0 skipped** (`ForgeSmokeTest` `1/1`, `RemediationRegressionTest` `15/15`, `ProtocolAdversarialTest` `21/21`, `ProtocolInvariantTest` `3/3` at `64 runs x 80 depth = 5,120` calls each, `0` handler reverts) |
| **Foundry Mainnet Fork (HashKey Chain Block `30583147`)** | `forge test --match-contract HashKeyForkPrototypeTest --fork-url https://mainnet.hsk.xyz --fork-block-number 30583147 -vv` | **1 passed, 0 failed, 0 skipped** (`test_Fork_FullLifecycle_V3WithdrawSegregateReserveTransferPartialExerciseReclaim`, gas `2,349,540`) |
| **SDK (`sdk/`)** | `npx tsc --noEmit && npm run build && npm test` | **2 passed, 0 failed** |
| **HSP Adapter (`hsp/`)** | `npx tsc --noEmit && npm test` | **5 passed, 0 failed** |
| **Execution Agent (`agent/`)** | `npx tsc --noEmit && npm test` | **3 passed, 0 failed** |
| **Demo Backend & UI (`demo/`)** | `npx tsc --noEmit && npm test` | **3 passed, 0 failed** |
