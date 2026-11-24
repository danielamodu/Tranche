# Adversarial Security & Foundry Test Plan — the protocol

**Workstream:** D (Adversarial Security Engineering)  
**Target Chain:** HashKey Chain (`UNVERIFIED` Chain ID / RPC pending deployment registry)  
**Toolchain (`VERIFIED`):** Foundry `1.7.1` (`solc = "0.8.24"`, `evm_version = "shanghai"`, `via_ir = false`, `optimizer_runs = 200`)  
**Status:** Phase 1 Design Blueprint — **No `contracts/` files modified.** Tests are specified for immediate Phase 3/4 implementation once contract interfaces stabilize.

---

## 0. Epistemic Grounding & Architecture Assumptions

Every claim in this document is explicitly tagged:
- **`VERIFIED`**: Directly observed in repository files or tool output in this session.
- **`ASSUMED`**: Architectural component or interface assumed from the Workstream D specification for Phase 2/3 design.
- **`INFERRED`**: Derived from EVM, Solidity `0.8.24`, ERC-20/ERC-721, Uniswap V3, or L2/OP-Stack security mechanics.
- **`UNVERIFIED`**: External HashKey Chain addresses, feed configurations, or third-party contract behaviors not yet verified against live chain state.

### 0.1 Verified Workspace Baseline (`VERIFIED`)
- `foundry.toml` specifies `src = "contracts/src"`, `test = "contracts/test"`, `out = "out"`, `libs = ["lib"]`, `solc_version = "0.8.24"`, `optimizer = true`, `optimizer_runs = 200`, `via_ir = false`, `evm_version = "shanghai"`.
- `contracts/src/ForgeSmoke.sol` and `contracts/test/ForgeSmoke.t.sol` are minimal smoke-check files; no production protocol contracts exist yet.
- `lib/` (`forge-std`, OpenZeppelin, Uniswap V3 interfaces) is **not yet installed**; `forge-std` (`Test.sol`, `StdInvariant.sol`, `Vm.sol`) must be installed in Phase 3 before running the suite below.
- `deployments/` and `research/` contain no verified HashKey Chain contract addresses, token lists, oracle feeds, or HSP registry addresses yet (`UNVERIFIED`).

### 0.2 Assumed Protocol Architecture (`ASSUMED`)
This test plan targets the following core protocol components:
1. **`LiquidityVault`**: Custody layer holding LP inventory — either raw ERC-20 token balances (`available` vs `reserved`) and/or concentrated-liquidity V3 LP positions (e.g., HSKSwap V3 `NonfungiblePositionManager` ERC-721 NFTs or managed ticks). Tracks per-LP deposits, reservations, accrued premiums/settlements, and unencumbered withdrawable balances.
2. **`CommitmentManager`**: Core state machine managing LP commitments/offers (pair, strike/pricing mode — fixed or oracle-floating — size cap, expiry, min/max fill, fee/premium params), trader reservation creation, partial/full exercise accounting, and post-expiry inventory reclaim.
3. **`ExecutionTicket` (ERC-721)**: Transferable, enumerable/tracked NFT representing a trader's reserved right (option/commitment tranche) to exercise up to `notionalRemaining` against a specific commitment before `expiry`. May support splitting, merging/aggregation, or partial exercise.
4. **`ExecutionRouter`**: User-facing / batching periphery supporting atomic multi-ticket exercise, flash/swap-assisted settlement (e.g., routing via HSKSwap V3), fee collection, and slippage/min-out checks.
5. **Oracle Adapter**: Price normalization wrapper reading external price feeds (Chainlink-style `AggregatorV3Interface`, Pyth/Chronicle, or HSKSwap V3 TWAP/slot0) with staleness, sequencer-uptime, zero/negative, and decimal-scaling guards.
6. **HSP Compliance Hook**: On-chain verification gate checking HashKey Settlement Protocol / HashKey KYC attestation (`ecrecover` / EIP-712 / Merkle / Soulbound registry) for restricted LPs, traders, or settlement routes.

---

## 1. Global Formal Invariants & Stateful Fuzz Architecture

### 1.1 Top-Level Protocol Invariants (`ASSUMED` / `INFERRED`)
All stateful invariant campaigns (`invariant_*`) MUST run against a multi-actor `ProtocolHandler` over `>= 100,000` calls per CI run (and `>= 1,000,000` in deep fuzz) with the following invariants enforced after every transaction:

| ID | Invariant Name | Formal Mathematical Property | Target Components |
|---|---|---|---|
| **INV-1** | `invariant_VaultSolvency()` | $\forall t \in \text{SupportedTokens}:\ \text{IERC20}(t).\text{balanceOf}(\text{Vault}) \ge \sum_{\text{lp}} \text{available}[\text{lp}][t] + \sum_{\text{c}} \text{reserved}[\text{c}][t] + \text{protocolFees}[t] + \text{unclaimedSettlement}[t]$ | `LiquidityVault`, `CommitmentManager` |
| **INV-2** | `invariant_CommitmentReservationBound()` | $\forall c \in \text{Commitments}:\ \sum_{\text{ticket} \in \text{Active}(c)} \text{ticket.remainingNotional} \le c.\text{reservedInventory} \le c.\text{totalCommitted}$ | `CommitmentManager`, `ExecutionTicket` |
| **INV-3** | `invariant_ConservationOfNotionalAcrossTransfersAndSplits()` | $\forall \text{ticket } k:\ \text{exercised}[k] + \text{remaining}[k] + \text{reclaimed}[k] == \text{initialReserved}[k]$ (accounting for any split child tickets summing strictly to parent's pre-split `remaining`). | `ExecutionTicket`, `CommitmentManager` |
| **INV-4** | `invariant_NoNegativeOrOrphanedV3Collateral()` | For every V3-backed commitment $c$, if `c.reservedLiquidity > 0`, `NFPM.ownerOf(c.tokenId) == address(Vault)` and `position.liquidity >= c.requiredLiquidity`. | `LiquidityVault` |
| **INV-5** | `invariant_RoundingAlwaysFavorsVaultAndLP()` | Across all partial fills $i$ of ticket $k$: $\sum_i \text{quotePaid}_i \ge \lceil \frac{\sum_i \text{baseOut}_i \cdot \text{strike}}{\text{SCALE}} \rceil$ and $\text{protocolFee}_i == 0 \implies \text{baseOut}_i == 0$ (or minimum fee floor enforced). | `CommitmentManager`, `ExecutionRouter` |
| **INV-6** | `invariant_ExpiredTicketCannotExercise()` | $\forall k:\ \text{block.timestamp} > \text{ticket}[k].\text{expiry} \implies \text{remainingExercisable}[k] == 0$ (any `exercise` call reverts; only `reclaim` is valid). | `CommitmentManager` |
| **INV-7** | `invariant_ActiveReservationBlocksLPWithdrawal()` | $\forall \text{lp}, t:\ \text{withdrawable}[\text{lp}][t] \le \text{totalDeposited}[\text{lp}][t] - \text{sumActiveReservations}[\text{lp}][t]$. | `LiquidityVault` |
| **INV-8** | `invariant_ComplianceNonceMonotonicity()` | For every HSP attestation digest $h$ or `(user, chainId, verifyingContract, nonce)`, `usedAttestation[h]` transitions `false -> true` monotonically and never resets. | HSP Compliance Hook |

### 1.2 Stateful Handler Blueprint (`ProtocolHandler.sol`)
- **Actors (`ASSUMED`)**: 3 LPs (`lp1`, `lp2`, `lp3`), 3 Traders (`trader1`, `trader2`, `trader3`), 1 Keeper/Reclaimer, 1 Malicious Attacker (`attacker`), 1 Compliance Signer (`hspSigner`).
- **Ghost Variables**: Track `ghost_deposited[token]`, `ghost_withdrawn[token]`, `ghost_reserved[commitmentId]`, `ghost_exercisedBase[ticketId]`, `ghost_paidQuote[ticketId]`, `ghost_reclaimed[commitmentId]`, `ghost_fees[token]`, `ghost_activeTicketIds[]`.
- **Bounded Actions**:
  - `depositLiquidity`, `createCommitment`, `withdrawUnreserved`, `reserveTicket`, `transferTicket`, `splitTicket`, `exerciseTicket` (partial & full), `batchExercise`, `reclaimExpired`, `warpTime`, `setOraclePrice` (within & outside bounds), `revokeHSP`.
- **Critical Foundry Config (`INFERRED`)**: Exclude `ProtocolHandler` self-calls as `msg.sender` where `vm.prank` is used inside handler methods; enable `fail_on_revert = false` on fuzz handler calls so valid reverts are skipped while unexpected panics (overflow/underflow/out-of-gas) are caught or logged via ghost failure counters.

---

## 2. Adversarial Attack Matrix & Detailed Test Specifications (Vectors 1–13)

---

### Vector 1: Double Reservation
**Severity:** Critical  
**Epistemic Tags:** `ASSUMED` (component names & state vars), `INFERRED` (concurrency / stale capacity patterns)

#### Attacker Goal & Precondition
- **Goal:** Reserve more notional inventory than the LP actually committed or deposited, creating unbacked `ExecutionTicket` NFTs and making the vault insolvent upon exercise.
- **Precondition:** LP deposits `100 WETH` (`ASSUMED` `LiquidityVault`) and creates Commitment `#1` with `maxNotional = 100 WETH` (or LP creates two commitments `#1` and `#2` backed by the same unsegregated `100 WETH` vault balance).

#### Step-by-Step Exploit Call Sequence
1. **Same-Commitment Double Reserve:**
   - `attacker1` calls `CommitmentManager.reserve(commitmentId=1, notional=60e18)` -> receives `ticketId=1`.
   - `attacker2` (or `attacker1` in same tx / next block) calls `CommitmentManager.reserve(commitmentId=1, notional=60e18)`.
   - *Bug pattern:* If `CommitmentManager` checks `notional <= commitment.maxNotional` instead of `notional <= commitment.availableNotional`, both succeed (`120e18 > 100e18`).
2. **Cross-Commitment Shared-Balance Double Reserve:**
   - LP has `100e18 WETH` in `LiquidityVault` (`available[LP][WETH] = 100e18`).
   - LP calls `createCommitment(WETH, amount=100e18)` -> `commitmentId=1` (fails to decrement `available[LP][WETH]` or lock shares).
   - LP calls `createCommitment(WETH, amount=100e18)` -> `commitmentId=2` using the same `100e18`.
   - Trader A reserves `100e18` on `#1`; Trader B reserves `100e18` on `#2`. Both attempt `exercise` -> second caller reverts on vault insolvency or steals another LP's `WETH`!
3. **Reserve After Partial Exercise / Before Reclaim Accounting Reset:**
   - Trader reserves `100e18`, exercises `40e18`, ticket expires; LP reclaims `60e18` while `commitment.reserved` is decremented by `100e18` instead of `60e18`, leaving phantom capacity `40e18` available to re-reserve.

#### Foundry Test Function Names
- `test_RevertWhen_DoubleReservationExceedsCommitmentCapacity()`
- `test_RevertWhen_CrossCommitmentExceedsLPDepositedBalance()`
- `test_RevertWhen_ReReservedAfterExpiryUsesStaleAccounting()`
- `testFuzz_ConcurrentReservationsNeverExceedAvailableInventory(uint96 depositAmt, uint96[] calldata reqs)`
- `invariant_CommitmentReservationBound()`

#### Concrete Assertions & Invariants
- `vm.expectRevert(InsufficientAvailableInventory.selector)` on the second reservation that causes `sum(reserved) > commitment.available`.
- Assert `vault.availableBalance(lp, token) + vault.lockedBalance(lp, token) == depositAmt`.
- Assert `commitment.reservedNotional + commitment.exercisedNotional <= commitment.capNotional`.
- Assert in cross-LP setup (`lp1` deposits `100e18`, `lp2` deposits `100e18`) that exercising `lp1`'s commitments can **never** draw down `lp2`'s vault accounting balance.

#### Mainnet-Fork Validation Requirements (`UNVERIFIED`)
- If `LiquidityVault` backs commitments with live **HSKSwap V3 LP NFTs** (`NonfungiblePositionManager`), verify on fork that reserving against a V3 position computes `token0`/`token1` amounts at the *current* `slot0.sqrtPriceX96` (and worst-case strike tick) and locks the V3 `liquidity` delta so two commitments cannot reference the same `tokenId` liquidity units.

---

### Vector 2: Inventory Double Spending
**Severity:** Critical  
**Epistemic Tags:** `ASSUMED` (ticket split/merge/exercise flows), `INFERRED` (ERC-721 transfer / state sync bugs)

#### Attacker Goal & Precondition
- **Goal:** Exercise more base inventory than `ticket.notionalRemaining`, or spend the same ticket notional multiple times via transfer, split, batch aggregation, or vault-vs-manager accounting desync.
- **Precondition:** `attacker` holds `ExecutionTicket #1` with `notionalRemaining = 10e18` (backed by `10e18` in `LiquidityVault`).

#### Step-by-Step Exploit Call Sequence
1. **Split-Then-Exercise-Parent Desync:**
   - `attacker` calls `ExecutionTicket.split(ticketId=1, splitAmount=5e18)` -> mints `ticketId=2` (`5e18`).
   - *Bug pattern:* Parent `ticketId=1` fails to decrement `notionalRemaining` (still `10e18`) or forgets to update `CommitmentManager` mapping. `attacker` exercises `10e18` on `#1` and `5e18` on `#2` (`15e18` total).
2. **Aggregate/Merge-And-Double-Spend:**
   - `attacker` merges `#1` (`5e18`) and `#2` (`5e18`) into `#3` (`10e18`), and source ticket `#1` is not burned or marked `remaining = 0` before merge returns.
3. **Vault Balance vs Internal Accounting Desync (Direct Donation / Skim):**
   - `attacker` transfers `1e18` directly to `LiquidityVault` via `ERC20.transfer`.
   - *Bug pattern:* Vault uses `token.balanceOf(address(this))` instead of tracked `totalTrackedAssets` to compute free liquidity or exchange rate; `attacker` triggers `exercise` or `skim` to steal tracked reserves belonging to LPs.
4. **Sequential Partial Exercise Overflow/Underflow or Unupdated State:**
   - `attacker` exercises `6e18`, then `6e18` again via two different entrypoints (`CommitmentManager.exercise` vs `ExecutionRouter.executeTicket`) if one path doesn't decrement `ticket.notionalRemaining`.

#### Foundry Test Function Names
- `test_RevertWhen_ExerciseExceedsTicketRemainingNotional()`
- `test_RevertWhen_ParentTicketExercisedAfterSplit()`
- `test_RevertWhen_MergedSourceTicketReExercised()`
- `test_DirectTokenTransferDoesNotInflateVaultAccounting()`
- `testFuzz_SplitMergeAndPartialExerciseConservesNotional(uint96 initial, uint96 splitAmt, uint96 ex1, uint96 ex2)`
- `invariant_VaultSolvency()`
- `invariant_ConservationOfNotionalAcrossTransfersAndSplits()`

#### Concrete Assertions & Invariants
- After `split(1, s)`: assert `ticket[1].remaining + ticket[2].remaining == preSplitRemaining`, and `ticket[2].commitmentId == ticket[1].commitmentId`, `ticket[2].expiry == ticket[1].expiry`.
- After `merge([1, 2])`: assert `ownerOf(1)` and `ownerOf(2)` revert (`ERC721NonexistentToken`) or `remaining == 0`, and `ticket[3].remaining == rem1 + rem2`.
- After direct `token.transfer(address(vault), 1e18)`: assert `vault.totalAvailable(token)` and `commitment.available` are **unchanged** (`INV-1` holds strictly with `>=`).

#### Mainnet-Fork Validation Requirements (`UNVERIFIED`)
- Verify on fork with real HSKSwap V3 `collect()` fees: accrued swap fees inside an active V3 NFT must not be conflated with principal liquidity when calculating deliverable base inventory, or vice versa, causing vault-vs-commitment desync.

---

### Vector 3: Unauthorized Ticket Transfer / Exercise
**Severity:** High / Critical  
**Epistemic Tags:** `ASSUMED` (`ExecutionTicket` ERC-721 + `ExecutionRouter`), `INFERRED` (ERC-721 approval / router allowance bugs)

#### Attacker Goal & Precondition
- **Goal:** Exercise, split, or transfer another user's `ExecutionTicket` without ownership or approval, or hijack an open `setApprovalForAll(ExecutionRouter, true)` approval.
- **Precondition:** `victim` owns `ticketId=1` (`notional = 50e18`) and has previously called `ExecutionTicket.setApprovalForAll(address(ExecutionRouter), true)` for convenient batch execution.

#### Step-by-Step Exploit Call Sequence
1. **Non-Owner Direct Exercise:**
   - `attacker` calls `CommitmentManager.exercise(ticketId=1, amount=50e18)` directly.
   - *Bug pattern:* Missing `isApprovedOrOwner(msg.sender, ticketId)` check in `CommitmentManager`.
2. **Router Confused-Deputy Approval Hijack:**
   - `victim` granted `ExecutionRouter` ERC-721 approval (`setApprovalForAll` or `approve`).
   - `attacker` calls `ExecutionRouter.batchExercise([ticketId=1], recipient=attacker)`!
   - *Bug pattern:* `ExecutionRouter` checks `CommitmentManager` via its own `msg.sender` (which is approved!) without checking that `msg.sender` initiating the call to `ExecutionRouter` is the `ownerOf(ticketId)` or approved by `ownerOf(ticketId)`!
3. **Approval Persistence Across Transfer / Frontrun Transfer-During-Exercise:**
   - `victim` lists or transfers `ticketId=1` to `buyer`; if custom approval mapping is used instead of standard ERC-721 `_update`, stale approval allows previous `approved` operator (`attacker`) to exercise `buyer`'s ticket.
   - Or `victim` submits `ExecutionRouter.execute(ticketId=1)` while `attacker` (as approved operator or via transfer hook) transfers `ticketId=1` mid-execution to redirect settlement payout to `attacker`.

#### Foundry Test Function Names
- `test_RevertWhen_UnauthorizedCallerExercisesTicket()`
- `test_RevertWhen_RouterConfusedDeputyExercisesVictimsApprovedTicket()`
- `test_TransferClearsSingleTicketApproval()`
- `test_RevertWhen_TicketTransferredMidExerciseRedirectsPayout()`
- `testFuzz_OnlyOwnerOrExplicitCallerApprovedCanExercise(address caller, address recipient)`

#### Concrete Assertions & Invariants
- `vm.prank(attacker); vm.expectRevert(UnauthorizedTicketCaller.selector); manager.exercise(1, 1e18, attacker);`
- When `victim` sets `ticket.setApprovalForAll(address(router), true)`: `vm.prank(attacker); vm.expectRevert(...); router.exercise(1, ...)` MUST revert!
- After `victim` transfers `ticketId=1` to `buyer`: `ticket.getApproved(1) == address(0)`, and prior approved address cannot exercise or transfer.
- Exercise output (`baseToken`) MUST go to `recipient` only if `caller` is owner/approved AND `recipient` is explicitly authorized by `caller` (never silently to `ownerOf` after a mid-tx transfer unless validated pre- and post-transfer).

#### Mainnet-Fork Validation Requirements (`UNVERIFIED`)
- Verify on fork if any HSKSwap periphery / Permit2 contract is used for approvals that `Permit2` nonce/deadline/spender checks bind strictly to the original signer and cannot be replayed by `ExecutionRouter` on behalf of another user.

---

### Vector 4: Partial Fill & Rounding Errors
**Severity:** High  
**Epistemic Tags:** `ASSUMED` (fixed & floating pricing math), `INFERRED` (Solidity integer division truncation attacks)

#### Attacker Goal & Precondition
- **Goal:** Drain base tokens for `0` quote cost via dust fills, evade protocol fees by rounding fees to `0` across many tiny fills, or leave `1 wei` uncollectable/unreclaimable dust that locks commitments.
- **Precondition:** Commitment `#1` has `strikePrice` (e.g., `1e6` USDC per `1e18` WETH, or fractional `0.000333e6`), `protocolFeeBps = 30` (0.3%), and `ExecutionTicket #1` permits partial fills.

#### Step-by-Step Exploit Call Sequence
1. **Zero-Quote Dust Fill Drain:**
   - `strike = 1500e6` (USDC 6 decimals), `base = WETH` (18 decimals).
   - `attacker` computes `baseAmount = 1e8` wei (`0.0000000001 WETH`).
   - Exact quote cost = `(1e8 * 1500e6) / 1e18 = 0.15` -> truncates in Solidity division to **`0 USDC`**!
   - `attacker` loops `10,000` calls (or `1` batch call of `10,000` micro-fills) receiving `10,000 * 1e8 = 1e12` wei WETH while paying **`0 USDC`**.
2. **Fee Rounding to Zero:**
   - `quoteAmount = 100` (e.g. `0.0001 USDC`), `feeBps = 30`.
   - `fee = (100 * 30) / 10_000 = 0`.
   - `attacker` splits a `100e6 USDC` exercise into `1,000,000` tiny fills paying `0` protocol fee instead of `0.30 USDC`.
3. **Repeated Rounding Leak (Asymmetric Base vs Quote Direction):**
   - When computing `baseOut` from `quoteIn` vs `quoteIn` from `baseOut`: if `quoteIn` rounds **down** and `baseOut` rounds **up** (or `notionalRemaining` decrements by a rounded-down value while payout uses unrounded/rounded-up), repeated partial fills exceed `LP`'s deposited inventory by `N` wei -> causing final fill or LP reclaim to revert with `ERC20InsufficientBalance` / underflow (`INV-1` violation!).
4. **1-wei Dust Lockout:**
   - Ticket has `remaining = 1 wei`; `minFill` check blocks `1 wei` exercise, OR `remaining = 1 wei` rounds payout to `0` and leaves `commitment.reserved > 0` preventing LP full withdrawal until expiry.

#### Foundry Test Function Names
- `test_RevertWhen_DustFillRoundsQuotePaymentToZero()`
- `test_RevertWhen_FeeRoundsToZeroOnSmallFill()`
- `testFuzz_PartialFillRoundingFavorsLPAndVault(uint256 totalBase, uint256 strike, uint8 baseDec, uint8 quoteDec, uint8 numFills)`
- `testFuzz_MultiStepPartialFillsNeverUnderflowOrDrainExtraWei(uint96[16] calldata fillAmounts)`
- `invariant_RoundingAlwaysFavorsVaultAndLP()`

#### Concrete Assertions & Invariants
- **Strict Rounding Rule Assertions (`INFERRED`):**
  - When user specifies `baseOut`: `quoteIn = Math.mulDiv(baseOut, price, BASE_SCALE, Math.Rounding.Ceil)` -> assert `quoteIn > 0` for any `baseOut > 0` (or revert `ZeroQuoteAmount` / `DustFill`).
  - When user specifies `quoteIn`: `baseOut = Math.mulDiv(quoteIn, BASE_SCALE, price, Math.Rounding.Floor)` -> assert `baseOut > 0`.
  - Protocol fee: `fee = Math.mulDiv(amount, feeBps, 10_000, Math.Rounding.Ceil)` -> assert `fee >= 1` whenever `feeBps > 0 && amount > 0`.
- **1000-Fill Stress Fuzz Assertion:** Sum of `baseOut_i` across 16–1000 partial fills MUST be `<= initialNotional`, and total `quotePaid` MUST be `>= ceil(sum(baseOut_i) * strike / SCALE)`.
- **Decimal Extremes:** Test `(base=6 dec, quote=18 dec)`, `(base=18 dec, quote=6 dec)`, `(base=8 dec WBTC, quote=6 dec USDC)`, `(base=2 dec, quote=18 dec)`.

#### Mainnet-Fork Validation Requirements (`UNVERIFIED`)
- Test with actual HashKey Chain bridged **USDC/USDT (6 decimals)**, **WBTC (8 decimals)**, and **WHSK/WETH (18 decimals)** token contracts on fork to verify real decimal metadata (`decimals()`) matches oracle scaling assumptions.

---

### Vector 5: Oracle Manipulation & Stale Updates
**Severity:** Critical  
**Epistemic Tags:** `ASSUMED` (Oracle adapter), `INFERRED` (Chainlink / L2 sequencer / HSKSwap V3 spot-vs-TWAP pitfalls)

#### Attacker Goal & Precondition
- **Goal:** Exercise floating-strike commitments at an artificially depressed or inflated price (spot manipulation, stale feed, L2 sequencer outage lag, or decimal mismatch), or force `int256 -> uint256` wraparound / division-by-zero DoS.
- **Precondition:** Commitment `#1` uses floating/oracle-indexed pricing (or oracle-gated collar/bound) backed by the protocol's Oracle Adapter.

#### Step-by-Step Exploit Call Sequence
1. **L2 Sequencer Uptime Bypass / Post-Restart Grace Period:**
   - HashKey Chain L2 sequencer goes down for 2 hours, then comes back online (`startedAt = block.timestamp - 10s`).
   - Off-chain price has moved 15%, but oracle feed hasn't posted yet (`updatedAt` is stale or just refreshed within grace window).
   - `attacker` calls `exercise` in the first block after sequencer recovery before arbitrageurs/keepers update the price.
   - *Bug pattern:* Oracle Adapter omits `sequencerUptimeFeed` check + `GRACE_PERIOD_TIME` (e.g. `3600s`), OR only checks `answeredInRound >= roundId` (deprecated in Chainlink OCR2).
2. **Stale `updatedAt` / `price <= 0` / Negative Cast Overflow:**
   - Mock/fork feed returns `answer = 0` or `answer = -1` (int256).
   - *Bug pattern:* `uint256(answer)` casts `-1` to `type(uint256).max` (`~1.15e77`), letting `attacker` buy `100 WETH` for `0` or sell `1 wei` for the entire quote vault, or `answer = 0` triggers division-by-zero panic.
   - Or `block.timestamp - updatedAt > maxStaleness` is missing (`updatedAt == 0` incomplete round accepted).
3. **Single-Block HSKSwap V3 `slot0` Spot Manipulation:**
   - If Oracle Adapter reads HSKSwap V3 `pool.slot0().sqrtPriceX96` (spot) instead of a multi-block TWAP (`pool.observe([twapWindow, 0])`):
   - `attacker` takes a flash loan on HSKSwap V3, executes a massive single-block swap pushing `sqrtPriceX96` down 80%, calls `CommitmentManager.exercise()` at the manipulated spot price, and swaps back in the same tx.
4. **Decimal Scaling Mismatch:**
   - Feed reports 8 decimals (`1e8`), another feed reports 18 decimals (`1e18`), adapter hardcodes `1e8` -> price off by `10^10`!

#### Foundry Test Function Names
- `test_RevertWhen_OraclePriceIsStale()`
- `test_RevertWhen_OracleAnswerIsZeroOrNegative()`
- `test_RevertWhen_L2SequencerIsDownOrInGracePeriod()`
- `test_RevertWhen_OracleRoundIdIncompleteOrRolledBack()`
- `test_FlashLoanSpotManipulationDoesNotSkewTWAPOracle()`
- `testFuzz_OracleDecimalNormalizationAcrossTokenAndFeedDecimals(uint8 feedDec, uint8 baseDec, uint8 quoteDec, int256 rawPrice)`

#### Concrete Assertions & Invariants
- `vm.warp(updatedAt + maxStaleness + 1); vm.expectRevert(StaleOraclePrice.selector);`
- `mockFeed.setAnswer(0)` and `mockFeed.setAnswer(-100)`: MUST revert with `InvalidOraclePrice`, **never** cast to `uint256` or panic with `0x12` (div by zero).
- `sequencerFeed.setAnswer(1)` (down) or `block.timestamp - startedAt < GRACE_PERIOD`: MUST revert with `SequencerDown` / `GracePeriodNotOver`.
- In flash-loan fork simulation: before vs after single-block 90% pool skew, `TWAP` deviation over `>= 15–30 min` stays bounded while `slot0` moves wildly; protocol exercise uses TWAP / bounded deviation check (`|spot - twap| <= maxDeviationBps`) and reverts when spot diverges beyond threshold.

#### Mainnet-Fork Validation Requirements (`UNVERIFIED`)
- **Critical `UNVERIFIED` dependency:** Confirm which oracle provider is live on HashKey Chain (Chainlink, Pyth, Chronicle, RedStone, or HSKSwap V3 TWAP), its exact feed addresses, heartbeat intervals, and whether an L2 Sequencer Uptime Feed exists on HashKey Chain.
- On fork, test `pool.observe([1800, 0])` on real HSKSwap V3 pools to verify `observationCardinality` is initialized (`>= 2` and deep enough for the TWAP window; low-cardinality pools revert with `OLD`!).

---

### Vector 6: LP Inventory Withdrawal
**Severity:** Critical  
**Epistemic Tags:** `ASSUMED` (`LiquidityVault`, `CommitmentManager`), `INFERRED` (frontrunning / V3 NFPM custody escapes)

#### Attacker Goal & Precondition
- **Goal:** Malicious LP pulls liquidity immediately before a trader's `reserve` or `exercise` lands (frontrunning), withdraws tokens already backing active `ExecutionTicket`s, or recalls/transfers the underlying HSKSwap V3 LP NFT out from under the vault.
- **Precondition:** LP has deposited `100 WETH` (or a V3 NFT `tokenId=42`) into `LiquidityVault` and created active Commitment `#1`.

#### Step-by-Step Exploit Call Sequence
1. **Withdrawing Reserved Inventory:**
   - Trader reserves `80 WETH` against Commitment `#1`.
   - Malicious LP calls `LiquidityVault.withdraw(WETH, 100e18)` (or `cancelCommitment(1)`).
   - *Bug pattern:* `withdraw` checks `LP.deposited >= amount` instead of `LP.deposited - LP.reserved >= amount`, leaving Trader's ticket unbacked.
2. **Frontrunning `reserve()` (Expected Behavior vs Unsafe State):**
   - Trader sends `reserve(commitmentId=1, notional=50e18, maxStrike=...)`.
   - Malicious LP sees tx in mempool/sequencer and frontruns with `cancelCommitment(1)` + `withdraw(100e18)`.
   - *Result:* Trader's `reserve()` MUST revert cleanly (never succeed with `0` backing or worse strike), and any premium paid by Trader must not be taken if reservation fails.
3. **Frontrunning `exercise()` (IL / Adverse-Selection Escape):**
   - Trader holds an active `ExecutionTicket #1` (`50e18`, `expiry = T+7d`) and calls `exercise(1, 50e18)`.
   - Malicious LP tries to frontrun `exercise()` with `withdraw()` or `decreaseV3Liquidity()` or `emergencyWithdraw()`.
   - *Required security property:* LP **cannot** withdraw, cancel, or decrease liquidity backing an active, unexpired reservation (`INV-7`).
4. **V3 NFT Custody / Approval Escape:**
   - LP deposits HSKSwap V3 NFT `tokenId=42` into `LiquidityVault`, but retains `approve` / `operator` or `Vault` leaves `NFPM.setApprovalForAll` or allows LP to call `NFPM.decreaseLiquidity` directly because `Vault` delegated operator rights, OR `Vault` fails to verify `NFPM.ownerOf(42) == address(Vault)` and clears `getApproved(42)` on deposit.

#### Foundry Test Function Names
- `test_RevertWhen_LPWithdrawsReservedERC20Inventory()`
- `test_RevertWhen_LPFrontrunsExerciseWithWithdrawOrCancel()`
- `test_FrontrunReserveByLPRevertsCleanlyWithoutTakingTraderFunds()`
- `test_RevertWhen_LPTransfersOrDecreasesV3NFTDepositedInVault()`
- `testFuzz_LPMaxWithdrawableNeverImpairsActiveReservations(uint96 depositAmt, uint96 reserveAmt, uint96 withdrawAttempt)`
- `invariant_ActiveReservationBlocksLPWithdrawal()`
- `invariant_NoNegativeOrOrphanedV3Collateral()`

#### Concrete Assertions & Invariants
- `withdrawAttempt > depositAmt - activeReserved`: MUST revert (`InsufficientUnencumberedBalance`).
- On `V3 NFT` deposit into `LiquidityVault`: assert `nfpm.ownerOf(tokenId) == address(vault)` AND `nfpm.getApproved(tokenId) == address(0)`.
- Calling `nfpm.decreaseLiquidity(...)` or `nfpm.safeTransferFrom(...)` as the original LP MUST revert (`Not approved`).
- If LP cancels commitment *before* reservation (`frontrun reserve`), Trader's `reserve` reverts and Trader's quote/premium balance is unchanged.

#### Mainnet-Fork Validation Requirements (`UNVERIFIED`)
- On HashKey Chain fork, deposit a real **HSKSwap V3 `NonfungiblePositionManager`** position NFT into `LiquidityVault`, verify `safeTransferFrom` clears single-token approval per Uniswap V3 NFPM spec, and test `decreaseLiquidity` + `collect` under real pool fee/tick math.

---

### Vector 7: Malicious ERC-20 Behavior
**Severity:** High  
**Epistemic Tags:** `ASSUMED` (multi-token support), `INFERRED` (weird-ERC20 / USDC blacklist patterns)

#### Attacker Goal & Precondition
- **Goal:** Break vault solvency accounting, bypass transfers, DoS `reclaim`/`exercise`, or steal LP balances using non-standard ERC-20 tokens.
- **Precondition:** Protocol permits commitments denominated in arbitrary or bridged ERC-20 tokens (or uses real USDC/USDT-style tokens).

#### Step-by-Step Exploit Call Sequence
1. **Fee-on-Transfer (FoT) Token Inflation:**
   - Token charges 5% transfer fee. LP calls `deposit(FoT, 100e18)` -> vault receives `95e18`, credits `100e18`!
   - Trader exercises `100e18` -> steals `5e18` from other LPs or bricks final `5e18` settlement.
2. **Rebasing Token (Negative & Positive Rebase):**
   - Token rebases `-10%` while sitting in `LiquidityVault` (`100e18 -> 90e18`), breaking `INV-1` (`balanceOf < tracked`). Positive rebase traps extra tokens permanently.
3. **Missing Return Value (`USDT`-style `transfer` returning `void`) & `return false`:**
   - Raw `IERC20.transfer(...)` reverts on USDT-style `void` return (ABI decoding failure) OR silently succeeds when a broken token returns `false` without reverting!
4. **Revert-on-Zero Transfer:**
   - Token reverts if `amount == 0`. A `0`-fee or `0`-dust settlement/refund calls `token.transfer(feeRecipient, 0)` -> bricks `exercise()` or `reclaim()`!
5. **ERC-777 / ERC-1363 Hook Callback:**
   - Token invokes `tokensReceived` / `onTransferReceived` during `safeTransferFrom` before vault updates state -> enables reentrancy (see Vector 8).
6. **Blacklist / Pause Freeze (`USDC`-style) Blocking Settlement or Reclaim:**
   - LP or Trader gets blacklisted by USDC *after* reserving a ticket.
   - *Bug pattern:* `exercise()` tries to `push` quote tokens directly to blacklisted LP -> `USDC.transfer(blacklistedLP, quote)` reverts -> **Trader's paid option/ticket is permanently bricked!** Or `batchExercise` pushes to a blacklisted LP and bricks the entire batch.

#### Foundry Test Function Names
- `test_FeeOnTransferTokenCreditsExactBalanceReceivedOrReverts()`
- `test_NonStandardNoReturnTokenTransferSucceedsViaSafeERC20()`
- `test_RevertWhen_TokenReturnsFalseOnTransfer()`
- `test_ZeroAmountTransferSkippedToPreventRevertOnZeroDoS()`
- `test_BlacklistedLPUsesPullSettlementWithoutBrickingTraderExercise()`
- `test_RebasingTokenInvariantCheckOrRejection()`

#### Concrete Assertions & Invariants
- **FoT Check:** Either measure `balAfter - balBefore` and credit only `received` (or explicitly revert `FeeOnTransferNotSupported` if `received != expectedAmount`). Assert `INV-1` still holds after FoT deposit!
- **SafeERC20:** Deploy `MockNoReturnERC20` (`transfer` returns nothing) and `MockReturnFalseERC20` (`transfer` returns `false`): `MockNoReturnERC20` MUST succeed; `MockReturnFalseERC20` MUST revert (`SafeERC20FailedOperation`).
- **Revert-on-Zero:** Deploy `MockRevertOnZeroERC20`; exercise with `fee == 0` MUST NOT call `transfer(..., 0)` and MUST succeed.
- **Blacklist / Pull Pattern:** Blacklist `lp1` on `MockBlacklistERC20`; `trader1` calls `exercise(ticketId)` -> MUST succeed using **pull-claimable credit** (`claimableQuote[lp1] += netQuote`) rather than pushing directly to `lp1` inside `exercise()`.

#### Mainnet-Fork Validation Requirements (`UNVERIFIED`)
- Inspect real **HashKey Chain bridged USDC / USDT / WHSK** implementations on fork for: (a) missing `bool` return on `transfer`/`transferFrom`, (b) `blacklist`/`isFrozen` modifiers, (c) upgradable proxy hooks.

---

### Vector 8: Reentrancy & Callback Spoofing
**Severity:** Critical  
**Epistemic Tags:** `ASSUMED` (`ExecutionTicket` ERC-721, `ExecutionRouter`, HSKSwap V3 callbacks), `INFERRED` (CEI & cross-contract reentrancy)

#### Attacker Goal & Precondition
- **Goal:** Reenter `CommitmentManager`, `LiquidityVault`, or `ExecutionRouter` mid-execution to double-exercise, double-reserve, withdraw unencumbered balance before reservation commits, or spoof a Uniswap/HSKSwap V3 `swapCallback` / `mintCallback`.
- **Precondition:** `attacker` deploys a malicious contract implementing `IERC721Receiver.onERC721Received`, ERC-777 `tokensReceived`, or custom flash-exercise receiver.

#### Step-by-Step Exploit Call Sequence
1. **`onERC721Received` Reentrancy During `reserve()` / `split()`:**
   - `CommitmentManager.reserve()` calls `ExecutionTicket._safeMint(attacker, ticketId)` **before** updating `commitment.reservedNotional` or `vault.lockInventory()`.
   - Inside `onERC721Received`, `attacker` calls `CommitmentManager.reserve()` a second time (reserving the same inventory twice) OR `lp` calls `LiquidityVault.withdraw()` before lock is recorded!
2. **Cross-Contract / Cross-Function Vault Reentrancy During `exercise()`:**
   - `exercise()` sends `baseToken` (an ERC-777 / hook-enabled token or native WHSK unwrap) to `attacker` *before* burning/decrementing `ticket.notionalRemaining`, OR before updating `commitment.available`.
   - `attacker` reenters `ExecutionRouter.exercise()` or `CommitmentManager.split()` or `LiquidityVault.getAvailableBalance()` (read-only reentrancy!).
3. **Read-Only Reentrancy on `LiquidityVault` Valuation / `reserve()`:**
   - During native ETH/HSK `call{value}` or ERC-777 transfer in `withdraw()`/`exercise()`, `Vault` has already sent ETH/tokens out (reducing `balanceOf`), **before** reducing internal `totalShares` / `reserved` state. External contract or `ExecutionRouter` reads `vault.utilization()` / `vault.available()` mid-callback and prices or reserves wrongly.
4. **HSKSwap V3 Callback Spoofing (`uniswapV3SwapCallback` / `hskSwapV3MintCallback`):**
   - `ExecutionRouter` or `LiquidityVault` implements `uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data)`.
   - `attacker` directly calls `ExecutionRouter.uniswapV3SwapCallback(1000e18, 0, craftedData)` pretending to be an HSKSwap V3 pool!
   - *Bug pattern:* Callback fails to verify `msg.sender == expectedPool` (derived deterministically from `factory` + `(token0, token1, fee)` or stored transient state `activePool`). `ExecutionRouter` transfers `1000e18` tokens to `attacker`!

#### Foundry Test Function Names
- `test_RevertWhen_OnERC721ReceivedReentersReserveOrWithdraw()`
- `test_RevertWhen_CrossContractReentrancyDuringExerciseWithCallbackToken()`
- `test_RevertWhen_ReadOnlyReentrancyDuringVaultWithdrawal()`
- `test_RevertWhen_SpoofedV3SwapCallbackFromNonPoolAddress()`
- `test_RevertWhen_SpoofedV3MintCallbackWithArbitraryPoolParams()`

#### Concrete Assertions & Invariants
- All state-mutating functions across `LiquidityVault`, `CommitmentManager`, and `ExecutionRouter` MUST enforce **CEI (Checks-Effects-Interactions)** AND `nonReentrant` (with shared or cross-contract reentrancy lock if vault & manager split state).
- `onERC721Received` reentrancy attempt: MUST revert with `ReentrancyGuardReentrantCall` (and even without guard, CEI ensures second call sees updated `reserved` and reverts cleanly).
- `ExecutionRouter.uniswapV3SwapCallback` called by EOA or fake pool: MUST revert (`InvalidCallbackCaller` / `UnauthorizedPool`) and `vault.balanceOf` remains unchanged.

#### Mainnet-Fork Validation Requirements (`UNVERIFIED`)
- Verify the **exact callback function name and `POOL_INIT_CODE_HASH`** of HSKSwap V3 on HashKey Chain! (Some V3 forks rename `uniswapV3SwapCallback` to `pancakeV3SwapCallback` / `algebraSwapCallback` / `hskSwapV3SwapCallback` and change `POOL_INIT_CODE_HASH`, which breaks `PoolAddress.computeAddress`!).

---

### Vector 9: Reservation Griefing
**Severity:** Medium / High  
**Epistemic Tags:** `ASSUMED` (reservation premium / min-size / storage patterns), `INFERRED` (economic & gas DoS)

#### Attacker Goal & Precondition
- **Goal:** Lock up 100% of an LP's inventory indefinitely or at near-zero cost, or spam thousands of `1 wei` tickets into an unbounded array so `reclaim()` / `withdraw()` / `getActiveTickets()` exceeds the block gas limit (`30M` gas DoS).
- **Precondition:** `CommitmentManager` allows reservations with low/zero upfront premium or no minimum ticket size, or tracks `commitment.ticketIds[]` in an unbounded dynamic array iterated during `reclaim()` or `withdraw()`.

#### Step-by-Step Exploit Call Sequence
1. **Zero-Cost / Cheap Long-Duration Inventory Lock:**
   - LP posts `100 WETH` commitment with `expiry = 30 days`.
   - If reservation requires `0` upfront premium (or `1 wei` fee), `attacker` reserves all `100 WETH`, never exercises, and ties up LP capital for 30 days at `~0` cost.
2. **Dust Ticket Spam -> Unbounded Array Gas DoS:**
   - `attacker` calls `reserve(commitmentId=1, notional=1 wei)` `2,000` times (or via `split()` `2,000` times).
   - *Bug pattern:* `CommitmentManager` pushes each `ticketId` onto `commitment.activeTickets[]` and `reclaimExpired(1)` or `withdraw()` loops over `for (uint i = 0; i < activeTickets.length; i++)`.
   - At expiry, LP calls `reclaimExpired(1)` -> runs out of gas (`OutOfGas`), permanently freezing LP's `100 WETH` inside `LiquidityVault`!
3. **Self-Extend / Rollover Griefing:**
   - If ticket transfer/split resets `expiry` or `lastAction` timestamp, `attacker` keeps rolling over reservations forever.

#### Foundry Test Function Names
- `test_RevertWhen_ReservationBelowMinNotionalOrZeroPremium()`
- `test_DustSpamDoesNotCauseOutOfGasOnExpiryReclaim()`
- `test_SplitSpamDoesNotExceedBlockGasLimitForLPWithdrawal()`
- `test_SplitPreservesOriginalParentExpiry()`
- `testFuzz_GasBoundOnReclaimRegardlessOfTicketCount(uint16 ticketCount)`

#### Concrete Assertions & Invariants
- Minimum reservation notional (`minNotional`) and upfront reservation premium (`premium > 0` when configured) MUST be enforced; `reserve(1 wei)` reverts (`BelowMinNotional`).
- **O(1) Reclaim Architecture Assertion:** `reclaimExpired(commitmentId)` MUST run in **O(1) gas** (track aggregate `commitment.reservedNotional` & `commitment.exercisedNotional` and reclaim `reserved - exercised` directly at `block.timestamp > commitment.expiry`, rather than iterating `ticketIds[]`).
- Gas benchmark test: even after `1,000` `reserve` or `split` operations on a commitment, `reclaimExpired(commitmentId)` consumes `< 150,000` gas (`<< 30,000,000` block limit).
- Assert `ticket[child].expiry == ticket[parent].expiry` strictly after `split()`.

#### Mainnet-Fork Validation Requirements (`UNVERIFIED`)
- Confirm HashKey Chain's actual block gas limit and L1-data-fee / calldata gas economics on fork to calibrate `minNotional` and `maxBatchSize` thresholds against real gas prices.

---

### Vector 10: Expiry & Reclaim Races
**Severity:** High  
**Epistemic Tags:** `ASSUMED` (`expiry`, `exercise`, `reclaim` semantics), `INFERRED` (boundary conditions & L2 timestamp drift)

#### Attacker Goal & Precondition
- **Goal:** Exercise an expired ticket at the boundary `block.timestamp == expiry`, race LP's `reclaim()` in the same block to double-spend inventory, or exploit a partial fill seconds before `expiry` to leave uncollectable dust or double-count reclaimed inventory.
- **Precondition:** Commitment `#1` and `ExecutionTicket #1` have `expiry = T`; `notional = 100e18`.

#### Step-by-Step Exploit Call Sequence
1. **Boundary Inequality Off-by-One (`<=` vs `<`):**
   - `exercise()` checks `block.timestamp <= expiry` (inclusive at `T`), while `reclaim()` checks `block.timestamp >= expiry` (also inclusive at `T`)!
   - At `block.timestamp == T`:
     - Tx 1: `LP` calls `reclaim(1)` -> returns `100e18` to `LP`!
     - Tx 2 (same block `T`): `attacker` calls `exercise(1, 100e18)` -> **also succeeds** because `block.timestamp <= expiry` is true and `reclaim()` only cleared vault state without invalidating `ticket` (or vice versa)!
2. **Partial Fill Before Expiry -> Double Reclaim / Stuck Dust:**
   - At `T - 1`: Trader exercises `60e18` (`40e18` remaining).
   - At `T + 1`: LP calls `reclaim(1)` -> reclaims `40e18`.
   - LP calls `reclaim(1)` a **second time**! If `commitment.reclaimed` flag isn't set, LP steals another `40e18` from the vault.
3. **Sequencer Timestamp Drift / Backdated L2 Timestamp:**
   - On OP-Stack L2s (like HashKey Chain, `INFERRED`), L2 `block.timestamp` advances in fixed block intervals (e.g., 2s) and is constrained by L1 sequencer rules, or short-expiry commitments (`expiry - now = 10s`) can be affected by L1-origin timestamp lag.

#### Foundry Test Function Names
- `test_BoundaryTimestampExerciseAndReclaimMutuallyExclusive()`
- `test_RevertWhen_ExerciseAtExactExpiryIfReclaimWindowStartsAtExpiry()`
- `test_RevertWhen_DoubleReclaimAfterPartialFill()`
- `test_PartialFillRightBeforeExpiryAllowsCleanRemainingReclaim()`
- `testFuzz_ExerciseVsReclaimOrderAtBoundaryTimestamp(uint64 expiry, uint64 tsOffset, bool reclaimFirst)`
- `invariant_ExpiredTicketCannotExercise()`

#### Concrete Assertions & Invariants
- **Strict Disjoint Windows:** Either `exercise` valid for `block.timestamp <= expiry` and `reclaim` valid for `block.timestamp > expiry` (preferred), OR `exercise` `< expiry` and `reclaim` `>= expiry` — **never overlapping at `== expiry`**.
- `reclaim(commitmentId)` sets `commitment.reclaimed = true` (and `reclaimable = 0`) so a second `reclaim` reverts (`AlreadyReclaimed`) or transfers `0`.
- At `block.timestamp == expiry` and `expiry + 1`: test **both** tx orderings (`exercise` then `reclaim`, and `reclaim` then `exercise`). Assert `totalBaseOutToTrader + totalBaseReclaimedToLP == totalCommittedBase` strictly (`INV-1`, `INV-2`).

#### Mainnet-Fork Validation Requirements (`UNVERIFIED`)
- Verify HashKey Chain block time (e.g. `2s` OP-Stack cadence) and `block.timestamp` behavior on fork; enforce a sensible `MIN_COMMITMENT_DURATION` (e.g., `>= 60s` or `>= 5 minutes`) so sequencer jitter cannot invalidate freshly created commitments.

---

### Vector 11: Batch Execution Failure
**Severity:** Medium / High  
**Epistemic Tags:** `ASSUMED` (`ExecutionRouter.batchExercise`), `INFERRED` (DoS / partial revert / gas griefing in batch aggregators)

#### Attacker Goal & Precondition
- **Goal:** Poison a shared batch/aggregation queue with one expired, blacklisted, or gas-griefing ticket so the whole `ExecutionRouter` batch reverts, or exploit partial-success `try/catch` handling to mismatch aggregated quote payment vs delivered base tokens.
- **Precondition:** `ExecutionRouter` executes a batch of `ExecutionTicket`s `[t1, t2, t3]` in one transaction (e.g., for solver execution or user multi-tranche exercise).

#### Step-by-Step Exploit Call Sequence
1. **Single Poisoned Ticket Reverts Entire Atomic Batch:**
   - Solver/User submits `batchExercise([t1, t2, t3])` where `t2` just expired or `t2`'s underlying token reverts on transfer (paused/blacklisted).
   - If `batchExercise` has no `allowPartial` / `try-catch` mode when executing multi-LP solver batches, one poisoned LP token DoSes all honest settlements in the batch.
2. **Unsafe `try/catch` Partial Batch Accounting Desync:**
   - Conversely, if `batchExercise` uses `try manager.exercise(...) catch {}` **and** pre-pulls `totalQuoteIn` from caller before the loop, a failed sub-call leaves caller's unspent `quoteIn` trapped in `ExecutionRouter` (stolen by the next caller via `skim` or swap)!
3. **Gas Griefing via Malicious Token / Receiver (`63/64` Rule):**
   - `t2` points to a malicious ERC-20 or callback receiver that consumes `99%` of forwarded gas and reverts (or returns a 10MB revert string / returnbomb!), causing `ExecutionRouter`'s outer transaction to run out of gas or pay massive memory-expansion gas (`returnbomb`).

#### Foundry Test Function Names
- `test_BatchExerciseAtomicModeRevertsAllOnSingleInvalidTicket()`
- `test_BatchExercisePartialModeRefundsUnspentQuoteOnFailedTicket()`
- `test_RevertWhen_ReturnBombOrGasGriefingInBatchDoesNotStealFunds()`
- `test_BatchExerciseWithBlacklistedTokenInOneLegDoesNotLockOtherLegs()`
- `testFuzz_BatchExerciseConservationOfQuoteRefund(uint8 numTickets, uint8 failMask)`

#### Concrete Assertions & Invariants
- **Atomic Mode:** If `allowPartial == false`, assert **zero** state changes across all `t1..tN` if any leg fails.
- **Partial Mode (`try/catch`):** If `allowPartial == true`, assert:
  - `callerQuoteAfter == callerQuoteBefore - sum(successfulLegs.quotePaid)` (unspent quote is **refunded or never pulled**!).
  - `router.balanceOf(quoteToken)` and `router.balanceOf(baseToken)` return to `0` at end of tx (router holds zero residual user dust).
- **Returnbomb / Gas Griefing Protection:** Use bounded-returndata low-level call or `ExcessivelySafeCall`-style pattern if calling untrusted receivers, and assert `ExecutionRouter` gas overhead on a malicious `100KB` revert payload does not trap funds.

#### Mainnet-Fork Validation Requirements (`UNVERIFIED`)
- Test `ExecutionRouter` batching against real HSKSwap V3 multi-hop swaps on fork when settling multiple tickets into a single output token.

---

### Vector 12: MEV & Adverse Selection
**Severity:** High  
**Epistemic Tags:** `ASSUMED` (fixed strike vs floating strike, V3 redeployment), `INFERRED` (L2 MEV / sequencer ordering / oracle latency arbitrage)

#### Attacker Goal & Precondition
- **Goal:** Extract risk-free arbitrage from LPs via (a) JIT exercise on fixed-strike commitments the instant spot crosses strike, (b) oracle latency arbitrage on floating-strike commitments right before a stale/pending oracle update lands, or (c) sandwiching Vault's HSKSwap V3 `decreaseLiquidity` + `collect` / swap rebalancing.
- **Precondition:** LP creates a fixed-strike or floating-strike commitment; HSKSwap V3 pool moves in real time.

#### Step-by-Step Exploit Call Sequence
1. **Oracle Latency Arbitrage (Floating Strike / Oracle-Indexed Pricing):**
   - Spot price on CEX / HSKSwap V3 drops 5% (`$2000 -> $1900`), while on-chain oracle still reports `$2000` (within heartbeat, e.g., `0.4%` below deviation trigger or waiting for next push).
   - `attacker` exercises `ExecutionTicket` at the stale `$2000` oracle price (or buys/sells against LP at `$2000` and immediately hedges on HSKSwap V3 at `$1900`), extracting guaranteed 5% adverse selection profit directly from the LP.
2. **JIT Reserve-And-Exercise on Fixed Strike (Zero-Duration Free Option):**
   - LP has an unreserved fixed-strike offer at `strike = $2000` with `0` or near-`0` reservation premium.
   - Spot jumps to `$2050`. In the same block, `attacker` backruns the price move with `reserve(100 WETH)` + `exercise(100 WETH)` in one tx (`0` risk, instant `$50/WETH` profit)!
3. **Sandwiching Vault's V3 `decreaseLiquidity` + Rebalance Swap:**
   - When `LiquidityVault` exercises or rebalances a V3 position and swaps `token0 -> token1` via HSKSwap V3 (`amountOutMinimum = 0` or loose slippage), MEV searcher sandwiches the rebalance tx:
     1. Front-run swap moves pool price unfavorably.
     2. Vault tx executes rebalance swap at terrible price.
     3. Back-run swap captures the slippage loss from Vault/LP.

#### Foundry Test Function Names
- `test_OracleDeviationGuardRevertsWhenSpotDivergesFromOracle()`
- `test_SameBlockReserveAndExercisePreventedOrPricedWithMinimumPremium()`
- `test_RevertWhen_VaultV3RebalanceSwapHasZeroSlippageProtection()`
- `testFork_SandwichSimulationAgainstVaultV3RebalanceEnforcesMinOut()`

#### Concrete Assertions & Invariants
- **Deviation Circuit Breaker:** When `|spotTWAP - oraclePrice| > maxDeviationBps`, floating-strike `exercise()` MUST revert (`OracleSpotDivergence`) or use the conservative bound (`max`/`min` favoring LP) per protocol economics design.
- **Anti-JIT / Reserve Cooldown or Premium:** Verify either `reserve()` charges the full option/commitment premium regardless of instant exercise, OR enforce `block.number > ticket.reservedBlock` / `block.timestamp >= ticket.reservedAt + minHoldTime` if configured.
- **Zero-Slippage Ban:** Any internal V3 swap inside `LiquidityVault` / `ExecutionRouter` MUST enforce a caller-supplied or TWAP-derived `amountOutMinimum` (`>= twapExpected * (1 - maxSlippageBps)`), reverting on simulated sandwich (`TooLittleReceived`).

#### Mainnet-Fork Validation Requirements (`UNVERIFIED`)
- Execute a full **sandwich attack test on HashKey Chain mainnet fork** against a real HSKSwap V3 pool: simulate an attacker swapping `100k USDC` before Vault's `decreaseLiquidity` + swap and swapping back after, asserting the Vault's TWAP-anchored `amountOutMinimum` reverts the sandwiched tx rather than leaking LP value.

---

### Vector 13: Compliance Attestation Replay
**Severity:** Critical  
**Epistemic Tags:** `ASSUMED` (HSP compliance hook, EIP-712 / ECDSA signatures), `INFERRED` (signature replay / malleability / frontrunning)

#### Attacker Goal & Precondition
- **Goal:** Reuse an expired, revoked, cross-chain, or another user's HSP KYC/compliance attestation to bypass compliance checks on `deposit`, `reserve`, `exercise`, or `transfer`.
- **Precondition:** HSP Compliance Hook verifies signed attestations from an authorized `hspSigner` (or checks an on-chain HSP registry).

#### Step-by-Step Exploit Call Sequence
1. **Cross-Chain Signature Replay:**
   - User obtains a valid HSP attestation on HashKey Testnet (or another EVM chain) where `domainSeparator` omitted `block.chainid` (or hardcoded `chainId`).
   - `attacker` submits the exact same `(v, r, s)` signature on HashKey Mainnet -> bypasses mainnet KYC!
2. **Cross-Contract / Cross-Action / Same-Chain Nonce Replay:**
   - User uses attestation `sig` (with `nonce = 1`) for `reserve()`.
   - *Bug pattern:* Compliance hook doesn't increment `nonces[user]++` or mark `attestationHash` as spent, OR `CommitmentManager` and `LiquidityVault` share a signer without `verifyingContract` in EIP-712 domain. `attacker` (or banned user post-revocation) replays `sig` endlessly!
3. **Frontrunning Another User's Attestation / Unbound Subject:**
   - Attestation signs `(action, expiry, nonce)` without binding `subject == msg.sender` (or `recipient`), OR uses a global nonce instead of per-user `nonces[user]`.
   - `attacker` intercepts `victim`'s mempool tx, extracts `sig`, and frontruns with `attacker` as `msg.sender` -> either steals KYC clearance or consumes `victim`'s nonce (DoS).
4. **Signature Malleability (`s`-value flip / `ecrecover == address(0)`):**
   - `attacker` flips `s -> secp256k1n - s` and `v -> 27/28` to produce a second valid signature for the same digest (bypassing `usedSignatures[keccak256(sig)]` deduplication!).
   - Or `signer == address(0)` + malformed signature makes `ecrecover` return `address(0)` and pass `recovered == trustedSigner`!
5. **Expired or Revoked HSP Attestation:**
   - `hspSigner` revokes `victim`'s KYC on-chain (`revoked[victim] = true` or `epoch[hspSigner]++`), or `attestation.deadline < block.timestamp`.
   - `victim` submits a previously issued off-chain signature -> must be rejected immediately!

#### Foundry Test Function Names
- `test_RevertWhen_ComplianceSignatureReplayedAcrossChainId()`
- `test_RevertWhen_ComplianceSignatureReplayedAcrossContractAddress()`
- `test_RevertWhen_ComplianceSignatureReplayedWithSameOrMalleableSig()`
- `test_RevertWhen_AttestationFrontrunByDifferentSubjectAddress()`
- `test_RevertWhen_ComplianceAttestationExpiredOrSignerRevoked()`
- `test_RevertWhen_ZeroSignerOrMalformedSignaturePassesEcrecover()`
- `invariant_ComplianceNonceMonotonicity()`

#### Concrete Assertions & Invariants
- **EIP-712 Domain Binding:** Use `vm.chainId(otherChainId)` -> compute signature -> `vm.chainId(hashkeyChainId)` -> `vm.expectRevert(InvalidComplianceSignature.selector)`.
- **Contract Binding:** Deploy a second instance of the hook/manager; signature signed for instance A MUST revert on instance B.
- **Malleability Immunity:** Deduplicate by **`digest` or `nonces[subject]++`**, **never** `keccak256(signature)`! Test flipping `(v, s)` via `SECP256K1_N - uint256(s)` and assert replay reverts (`InvalidNonce` / `AttestationAlreadyUsed`).
- **OpenZeppelin `ECDSA.tryRecover` / `SignatureChecker`:** Ensure `recovered == address(0)` always reverts (`InvalidSignature`), even if `trustedSigner` is uninitialized (`address(0)`).
- **Revocation / Expiry:** Set `block.timestamp = deadline + 1` -> revert (`AttestationExpired`); call `revokeUser(victim)` or `bumpSignerEpoch()` -> old signature reverts (`AttestationRevoked`).

#### Mainnet-Fork Validation Requirements (`UNVERIFIED`)
- **Critical `UNVERIFIED` dependency:** Confirm whether HSP on HashKey Chain uses an **on-chain registry contract** (e.g., ERC-3643 / EAS / custom HashKey DID/KYC SBT), off-chain EIP-712 attestations, or both — and pull the real mainnet registry ABI/address into fork tests.

---

## 3. HashKey Chain Mainnet-Fork Test Matrix (`Phase 3/4`)

> **Status (`UNVERIFIED`):** No HashKey Chain RPC URL, chain ID, HSKSwap V3 addresses, token addresses, oracle addresses, or HSP registry addresses are present in `deployments/` yet. **Resolving this checklist is a hard prerequisite before `test/fork/` can execute.**

### 3.1 Pre-Flight Registry Checklist (`UNVERIFIED` -> Must Populate in `deployments/`)
1. `HASHKEY_RPC_URL` & exact `CHAIN_ID` (Mainnet & Testnet).
2. `HSKSWAP_V3_FACTORY`, `HSKSWAP_V3_NFPM` (`NonfungiblePositionManager`), `HSKSWAP_V3_ROUTER`, and exact `POOL_INIT_CODE_HASH` + callback interface name.
3. Canonical token addresses & decimals: `WHSK`, `USDC`, `USDT`, `WETH`, `WBTC` (check if USDT returns `void`, if USDC has `blacklist()`).
4. Live Oracle addresses: Chainlink / Pyth / Chronicle feeds and/or whether an OP-Stack L2 Sequencer Uptime Feed is deployed.
5. HSP Compliance Registry / Verifier contract address and attestation schema.

### 3.2 Planned Fork Test Suite (`contracts/test/fork/HashKeyForkSecurity.t.sol`)
| Fork Test Name | Target Vector(s) | Live State Validated |
|---|---|---|
| `testFork_HSKSwapV3_DepositCustodyAndNoLPRecall()` | Vectors 1, 6 | Real `NFPM.safeTransferFrom`, approval clearing, `decreaseLiquidity` blocked for LP |
| `testFork_HSKSwapV3_CallbackVerificationAgainstRealPool()` | Vector 8 | Exact `POOL_INIT_CODE_HASH` & real pool `swap()` callback passes while spoof reverts |
| `testFork_HSKSwapV3_TWAPCardinalityAndFlashSkewResistance()` | Vectors 5, 12 | Real pool `observe()` cardinality check + single-block flash swap resistance |
| `testFork_HSKSwapV3_SandwichProtectionOnVaultRebalance()` | Vector 12 | Live pool swap sandwich fails due to TWAP-bounded `amountOutMinimum` |
| `testFork_RealTokens_USDCDecimalsAndBlacklistPullPattern()` | Vectors 4, 7 | Real 6-dec vs 18-dec scaling + `vm.prank(usdcMasterMinter)` blacklist resilience |
| `testFork_RealOracle_StalenessAndSequencerGracePeriod()` | Vector 5 | Live feed heartbeat & decimal check + forked `vm.warp` staleness revert |
| `testFork_HSPRegistry_LiveAttestationAndRevocation()` | Vector 13 | Real HSP contract check + cross-chain `vm.chainId` replay failure |

---

## 4. Foundry Execution & CI Harness Plan (Phase 3/4 Readiness)

### 4.1 Directory Layout (Do Not Create Until Phase 3)
```text
contracts/test/
├── ForgeSmoke.t.sol              # VERIFIED existing smoke test (keep untouched)
├── unit/
│   ├── DoubleReservation.t.sol   # Vector 1
│   ├── InventorySpend.t.sol      # Vector 2
│   ├── TicketAuth.t.sol          # Vector 3
│   ├── RoundingDust.t.sol        # Vector 4
│   ├── OracleGuards.t.sol        # Vector 5
│   ├── LPWithdrawal.t.sol        # Vector 6
│   ├── WeirdERC20.t.sol          # Vector 7
│   ├── ReentrancyCallbacks.t.sol # Vector 8
│   ├── GriefingDoS.t.sol         # Vector 9
│   ├── ExpiryReclaim.t.sol       # Vector 10
│   ├── BatchRouter.t.sol         # Vector 11
│   ├── MEVAdverseSelection.t.sol # Vector 12
│   └── ComplianceReplay.t.sol    # Vector 13
├── invariant/
│   ├── handlers/ProtocolHandler.sol
│   └── ProtocolInvariants.t.sol  # INV-1 through INV-8
├── fork/
│   └── HashKeyForkSecurity.t.sol # Section 3.2
└── mocks/
    ├── MockFeeOnTransferERC20.sol
    ├── MockRebasingERC20.sol
    ├── MockNoReturnERC20.sol
    ├── MockReturnFalseERC20.sol
    ├── MockRevertOnZeroERC20.sol
    ├── MockBlacklistERC20.sol
    ├── MockERC777CallbackToken.sol
    ├── MockAggregatorV3.sol
    └── MaliciousReceiver.sol
```

### 4.2 Recommended `foundry.toml` Profiles for Phase 3 (`INFERRED`)
- **`[profile.default]` (`VERIFIED`):** Keep existing `solc_version = "0.8.24"`, `evm_version = "shanghai"`. Install `forge-std` into `lib/forge-std` first.
- **`[profile.ci.fuzz]`:** `runs = 1000`, `max_test_rejects = 100000`.
- **`[profile.ci.invariant]`:** `runs = 256`, `depth = 250` (`64,000` calls per invariant check).
- **`[profile.deep.invariant]`:** `runs = 1000`, `depth = 500` (`500,000` calls, run pre-submission).
- **`[profile.fork]`:** `fork_url = "${HASHKEY_RPC_URL}"` with pinned `fork_block_number` for deterministic CI reproduction.

### 4.3 Severity-Prioritized Phase 3 Implementation Order
1. **Tier 0 (Must pass on first compile):** `ProtocolInvariants.t.sol` (`INV-1`–`INV-8`), Vectors **1** (Double Reservation), **2** (Double Spending), **6** (LP Withdrawal), **8** (Reentrancy/Callbacks).
2. **Tier 1 (Core financial & compliance safety):** Vectors **4** (Rounding), **5** (Oracle), **10** (Expiry/Reclaim Races), **13** (HSP Replay).
3. **Tier 2 (Token edge cases, DoS & execution quality):** Vectors **3** (Auth/Router Deputy), **7** (Weird ERC-20s), **9** (Griefing/O(1) Reclaim), **11** (Batch Partial/Atomic), **12** (MEV/Sandwich).
4. **Tier 3 (Live environment proof):** `HashKeyForkSecurity.t.sol` once `deployments/` is populated.
