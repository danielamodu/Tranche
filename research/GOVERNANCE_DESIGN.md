# Tranche — Governance, Emergency Controls & Operations Design (Phase 2, Workstream D)

> **Baseline Commit Preserved:** `f5d61e76134fd3badc831d10136318431aabd413` (`main`)  
> **Target Network:** HashKey Chain Mainnet (OP Stack L2, Chain ID `177`, `2.0000s` block time, `500.001 gwei` observed gas price)  
> **Companion Specs:** [OPERATIONS_ARCHITECTURE.md](file:///c:/Users/USER/Desktop/Tranche/research/OPERATIONS_ARCHITECTURE.md), [SECURITY_FINDINGS.md](file:///c:/Users/USER/Desktop/Tranche/research/SECURITY_FINDINGS.md), [MAINNET_READINESS.md](file:///c:/Users/USER/Desktop/Tranche/research/MAINNET_READINESS.md), [REMEDIATION_SPEC.md](file:///c:/Users/USER/Desktop/Tranche/research/REMEDIATION_SPEC.md)

---

## 1. Executive Summary & Remediation Scope

On frozen baseline `f5d61e76`, all six admin-gated contracts rely on `address public immutable admin = msg.sender` with no ownership transfer, `LiquidityVault.setFeeCollector()` uses a single-step setter (`I-02`), `CommitmentManager` lacks `setGuardian()` (`M-05`), `guardian` cannot pause active `FLOATING` exercises or invalidate compromised `SignedPullOracle` quotes, and protocol parameters (`protocolFeeBps`, `minTicketAmount`, `PairConfig`) mutate active tickets retroactively (`M-03`).

This specification defines the complete Phase 2 governance, emergency-control, monitoring, keeper, and LP self-recovery architecture for Tranche on HashKey Chain (`177`).

### Design Goals
1. **Eliminate Single-Key & Immutable-EOA Governance (`M-05`, `I-02`):** Migrate all 6 admin-gated contracts to OpenZeppelin v5.1 `Ownable2Step` owned by a `TimelockController`, plus two-step `feeCollector` acceptance on `LiquidityVault`.
2. **Enforce Timelocked Configuration + Snapshot Isolation (`M-03`):** Put all economic, adapter-registry, and oracle-configuration changes behind a `TimelockController` (`24h` initial launch ramp -> `>= 48h` steady-state), paired with per-`Offer`/per-`Ticket` snapshotting so LPs and takers always receive an exit window and active tickets never suffer retroactive term changes.
3. **Close the `FLOATING` Compromise Containment Gap (Workstream B + `M-05`):** Add `CommitmentManager.setGuardian()`, `CommitmentManager.setFloatingExercisePaused(bool)`, and `SignedPullOracle.revokePrice(address,address)` under a fast-path `2-of-3` Security Guardian Safe so compromised `FLOATING` fills are halted in `< 60s` while preserving `INV-8` (`FIXED` exercises, `withdrawFree`, `claimProceeds`, `cancelOffer`, and `reclaimExpired` remain 100% live).
4. **Operationalize Redundant Watchdogs, Keepers (`L-01`), & LP Self-Recovery:** Specify concrete `Multicall3` (`0xcA11bde05977b3631167028862be2a173976ca11`) polling thresholds, primary + shadow `reclaimExpiredBatchBestEffort` keepers operating within HashKey public RPC limits (`<= 2,000`-block log windows, `<= 35` calls/batch, `>= 350 ms` pacing), and permissionless LP exit runbooks.

---

## 2. Multisig Administration & `Ownable2Step` Ownership Transfer (`M-05`, `I-02`)

### 2.1 Replacing `immutable admin` with `Ownable2Step` Across All 6 Contracts

Every admin-gated contract replaces `address public immutable admin` and custom `onlyAdmin` checks with `@openzeppelin/contracts/access/Ownable2Step.sol` (OpenZeppelin v5.1.0, where `Ownable(initialOwner)` reverts with `OwnableInvalidOwner(address(0))` if `initialOwner == address(0)`):

| Contract | Frozen `f5d61e76` Admin Pattern | Phase 2 Remediated Pattern | Constructor Owner Initialization |
| --- | --- | --- | --- |
| [`LiquidityVault.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/LiquidityVault.sol) | `address public immutable admin` (`L31`) | `Ownable2Step` (`onlyOwner` on `setManager`, `setGuardian`, `setPendingFeeCollector`, `setDepositsPaused` alongside `guardian`) | `Ownable(initialOwner)` |
| [`CommitmentManager.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol) | `address public immutable admin` (`L86`) | `Ownable2Step` (`onlyOwner` on `setTicketNft`, `setProtocolFeeBps`, `setTokenMinTicketAmount`, `setApprovedOracle`, `setApprovedComplianceHook`, `setApprovedRouter`, `setGuardian`, and pause setters alongside `guardian`) | `Ownable(initialOwner)` |
| [`SignedPullOracle.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/SignedPullOracle.sol) | `address public immutable admin` (`L30`) | `Ownable2Step` (`onlyOwner` on `addSigner`, `removeSigner`, `setThreshold`, `setMaxJumpBps`, `setMaxPriceAge`, `setGuardian`, and `revokePrice` alongside `guardian`) | `Ownable(initialOwner)` |
| [`OraclePriceAdapter.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/OraclePriceAdapter.sol) | `address public immutable admin` (`L24`) | `Ownable2Step` (`onlyOwner` on `setPairConfig`) | `Ownable(initialOwner)` |
| [`UniswapV3TwapOracle.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/UniswapV3TwapOracle.sol) | `address public immutable admin` (`L27`) | `Ownable2Step` (`onlyOwner` on `setPoolConfig`) | `Ownable(initialOwner)` |
| [`HSPComplianceHook.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/HSPComplianceHook.sol) | `address public immutable admin` (`L26`) | `Ownable2Step` (`onlyOwner` on `setAttestationSigner`, `setApproved`, `revoke`) | `Ownable(initialOwner)` |

*(Note: `ExecutionTicket.sol` is governed exclusively by `manager` (`CommitmentManager`) with no admin role; `ExecutionRouter.sol` and `V3PositionSegregator.sol` are stateless/ownerless.)*

**Two-Step Handover Guarantee:**
- Calling `transferOwnership(newOwner)` sets `pendingOwner` without revoking the current `owner()` until the target address explicitly calls `acceptOwnership()`.
- A mistyped `transferOwnership(wrongAddress)` cannot brick protocol governance; the current `owner()` simply calls `transferOwnership(correctAddress)` to overwrite `pendingOwner`.

### 2.2 Two-Step `feeCollector` Transfer on `LiquidityVault` (`I-02`)

On [`LiquidityVault.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/LiquidityVault.sol#L84-L88), `setFeeCollector(address)` is replaced with a two-step handover to prevent accidental fee loss to a typo or dead address:

1. **State & Events:**
   - `address public feeCollector;` (immutable-free mutable recipient, initialized in constructor after `!= address(0)` check)
   - `address public pendingFeeCollector;`
   - `event PendingFeeCollectorSet(address indexed pendingFeeCollector);`
   - `event FeeCollectorUpdated(address indexed previousFeeCollector, address indexed newFeeCollector);`
2. **Functions:**
   - `setPendingFeeCollector(address _pendingFeeCollector) external onlyOwner`: reverts `ZeroAddress()` if `_pendingFeeCollector == address(0)`; sets `pendingFeeCollector = _pendingFeeCollector`; emits `PendingFeeCollectorSet(_pendingFeeCollector)`.
   - `acceptFeeCollector() external`: reverts `Unauthorized()` if `msg.sender != pendingFeeCollector` (or `msg.sender == address(0)`); updates `feeCollector = msg.sender`; clears `delete pendingFeeCollector`; emits `FeeCollectorUpdated(oldCollector, msg.sender)`.
3. **Operational Guarantee:** Because the incoming Treasury Safe must actively execute `acceptFeeCollector()`, protocol fees (`protocolFees[token]`) can never be routed to an address unable to sign transactions on chain `177`.

### 2.3 Recommended Multisig & Timelock Topology on HashKey Chain (`177`)

```text
  [3-of-5 Governance Safe] ──(PROPOSER / EXECUTOR / CANCELLER)──► [TimelockController]
    (Hardware wallets, geo-distributed)                              │ (minDelay: 24h launch -> 48h steady)
                                                                     │
                                                                     ▼ owner() via Ownable2Step
                                             ┌───────────────────────┼───────────────────────┐
                                             ▼                       ▼                       ▼
                                     [LiquidityVault]       [CommitmentManager]     [Oracle & Hook Adapters]
                                             ▲                       ▲                       ▲
                                             │                       │                       │
  [2-of-3 Security Guardian Safe] ───────────┴───────────────────────┴───────────────────────┘
    (24/7 Ops fast-path: pause deposits, pause reservations, pause FLOATING exercise, revokePrice)

  [2-of-3 / 3-of-5 Treasury Safe] ──(acceptFeeCollector / withdrawProtocolFees)──► [LiquidityVault]
```

| Entity | Threshold & Signer Profile | Assigned Roles & Scope | Timelock Bypass? |
| --- | --- | --- | --- |
| **Governance Safe** | `3-of-5` (hardware keys, multi-party separation) | `PROPOSER_ROLE`, `EXECUTOR_ROLE`, `CANCELLER_ROLE` on `TimelockController`. Never holds direct `owner()` on mainnet after bootstrap. | **No** (all mutations wait `minDelay`) |
| **TimelockController** | OpenZeppelin v5 `TimelockController` | `owner()` of all 6 protocol contracts. Holds `DEFAULT_ADMIN_ROLE` only on itself (deployer renounces `DEFAULT_ADMIN_ROLE` post-deploy). | N/A (enforces delay) |
| **Security Guardian Safe** | `2-of-3` (on-call security/engineering keys, separate from Governance Safe signers) | `guardian` on `LiquidityVault`, `CommitmentManager`, and `SignedPullOracle`. Optionally holds `CANCELLER_ROLE` on `TimelockController` to veto compromised Governance proposals during `minDelay`. | **Yes — Pause & Price Revoke Only** |
| **Treasury Safe** | `2-of-3` or `3-of-5` | `feeCollector` on `LiquidityVault` (`acceptFeeCollector()` + `withdrawProtocolFees()`). Zero parameter/pause authority. | N/A (claim fees only) |

### 2.4 Deployment & Ownership Handover Sequence (Zero Un-Timelocked Backdoor)

1. Deploy `Governance Safe` (`3-of-5`), `Security Guardian Safe` (`2-of-3`), and `Treasury Safe`.
2. Deploy `TimelockController(minDelay, proposers=[GovernanceSafe], executors=[GovernanceSafe], admin=deployer)` (or `executors=[address(0)]` if open post-delay execution is desired; keep `GovernanceSafe` as `CANCELLER_ROLE` and optionally grant `CANCELLER_ROLE` to `GuardianSafe`).
3. Deploy all 6 protocol contracts with `initialOwner = deployer` **only** to run atomic one-time wiring (`vault.setManager(manager)`, `manager.setTicketNft(ticketNft)`, initial `setPairConfig`, `setPoolConfig`, `setApprovedOracle`, `setApprovedComplianceHook`, `setApprovedRouter`, `setTokenMinTicketAmount`, `setProtocolFeeBps(5)`), then immediately call `transferOwnership(address(timelock))` on all 6 contracts.
4. Execute `TimelockController` batch calling `acceptOwnership()` on all 6 contracts, and have `deployer` call `renounceRole(DEFAULT_ADMIN_ROLE, deployer)` on `TimelockController`.
5. Verify on-chain before any LP deposit: `owner() == address(timelock)` on all 6 contracts, `TimelockController.hasRole(DEFAULT_ADMIN_ROLE, deployer) == false`, `vault.feeCollector() == address(treasurySafe)`, and `guardian == address(guardianSafe)` on `LiquidityVault`, `CommitmentManager`, and `SignedPullOracle`.

---

## 3. Timelocked Configuration Changes vs. Instant Emergency Controls

### 3.1 Action Classification Matrix

| Contract & Function | Authority | Timelock Delay | Rationale |
| --- | --- | --- | --- |
| `CommitmentManager.setProtocolFeeBps(uint16)` | `onlyOwner` (`TimelockController`) | **`48h`** (`24h` launch) | Economic parameter; capped at `MAX_PROTOCOL_FEE_BPS = 100` (`1%`). Gives LPs exit window before new offers snapshot updated fee. |
| `CommitmentManager.setTokenMinTicketAmount(address, uint256)` | `onlyOwner` (`TimelockController`) | **`48h`** (`24h` launch) | Affects minimum offer/fill thresholds for new offers (`M-03`, `Econ-2`). |
| `CommitmentManager.setApprovedOracle(address, bool)` | `onlyOwner` (`TimelockController`) | **`48h`** (`24h` launch) | Prevents malicious/honeypot oracle injection (`M-01`); allows public verification of new oracle bytecode before allowlisting. |
| `CommitmentManager.setApprovedComplianceHook(address, bool)` | `onlyOwner` (`TimelockController`) | **`48h`** (`24h` launch) | Prevents malicious/honeypot hook injection (`M-01`). |
| `CommitmentManager.setApprovedRouter(address, bool)` | `onlyOwner` (`TimelockController`) | **`48h`** (`24h` launch) | `approvedRouters` are trusted to forward `exerciser` and `finalReceiver` to `exerciseFor` (`H-02`); must be publicly audited before delay expires. |
| `OraclePriceAdapter.setPairConfig(address, address, PairConfig)` | `onlyOwner` (`TimelockController`) | **`48h`** (`24h` launch) | Prevents instant swap of feed addresses, staleness bounds, or hard price bounds against active `FLOATING` tickets (`M-03`, `H-01`). |
| `UniswapV3TwapOracle.setPoolConfig(...)` | `onlyOwner` (`TimelockController`) | **`48h`** (`24h` launch) | Prevents silent pool/window redirection. |
| `SignedPullOracle.addSigner(address)` | `onlyOwner` (`TimelockController`) | **`48h`** (`24h` launch) | Prevents Governance key compromise from silently injecting an attacker oracle signer without `48h` visibility. |
| `SignedPullOracle.removeSigner(address)` | `onlyOwner` (`TimelockController`) | **`48h`** (`24h` launch) | Safe to timelock because Guardian can immediately call `setFloatingExercisePaused(true)` + `revokePrice(...)` in `< 60s` while removal matures! |
| `SignedPullOracle.setThreshold(uint8)` / `setMaxJumpBps(...)` / `setMaxPriceAge(uint32)` | `onlyOwner` (`TimelockController`) | **`48h`** (`24h` launch) | Quorum and circuit-breaker parameters must not be weakened without notice. |
| `LiquidityVault.setPendingFeeCollector(address)` | `onlyOwner` (`TimelockController`) | **`48h`** (`24h` launch) | Plus mandatory `acceptFeeCollector()` by the new Treasury Safe (`I-02`). |
| `LiquidityVault.setGuardian(address)` / `CommitmentManager.setGuardian(address)` / `SignedPullOracle.setGuardian(address)` | `onlyOwner` (`TimelockController`) | **`48h`** (`24h` launch) | Prevents sudden removal of pause protection or replacement with an unvetted guardian. |
| `HSPComplianceHook.setAttestationSigner(address)` | `onlyOwner` (`TimelockController`) | **`48h`** (`24h` launch) | Prevents unilateral KYC signer swap on regulated pools. |
| `LiquidityVault.setManager(address)` / `CommitmentManager.setTicketNft(address)` | `onlyOwner` (One-time init) | Bootstrapped pre-timelock | Reverts with `ManagerAlreadySet()` / `TicketNftAlreadySet()` after initial wiring (`L17`, `L118`). |
| `Ownable2Step.transferOwnership` / `acceptOwnership` | `onlyOwner` (`TimelockController`) | **`48h`** (`24h` launch) | Governance migration requires full delay + two-step acceptance. |
| **`LiquidityVault.setDepositsPaused(true)`** | `guardian` or `owner` | **Instant (`0s`)** | Stops new LP inflows immediately during token/vault anomaly (`INV-1`). |
| **`CommitmentManager.setNewReservationsPaused(true)`** | `guardian` or `owner` | **Instant (`0s`)** | Stops new `createOffer`, `topUpOffer`, and `reserve` calls during oracle or market dislocation. |
| **`CommitmentManager.setFloatingExercisePaused(true)`** | `guardian` or `owner` | **Instant (`0s`)** | **New (`Workstream B`):** Halts active `FLOATING` ticket exercises immediately on oracle compromise without halting `FIXED` tickets (`INV-8`). |
| **`SignedPullOracle.revokePrice(inv, pay)`** | `guardian` or `owner` | **Instant (`0s`)** | **New (`Workstream B`):** Immediately invalidates compromised/stale stored quote (`priceX36 = 0`) while keeping `updatedAt` intact to block signature replay. |
| **Unpausing (`set*Paused(false)`)** | `guardian` or `owner` | **Instant (`0s`) by Guardian OR `48h` by Owner** | Guardian may unpause only after verifying clean recovery metrics (Section 5.3); if Guardian is compromised/stuck, `TimelockController` (`owner`) can both rotate `guardian` and unpause. |

> **Why `24h` Launch -> `48h` Steady-State Delay?**  
> During the first 30 days on HashKey Chain mainnet (with capped initial liquidity), a `24h` `TimelockController` delay (`updateDelay(48 hours)` scheduled once parameters stabilize) enables faster operational tuning (e.g., `tokenMinTicketAmount` or `maxJumpBps` calibration) while still giving every LP and taker a full `24h` on-chain warning and exit window before execution.

### 3.2 Why Timelock + Snapshot Isolation Together Guarantee an Exit Window (`M-03`)

Neither control alone is sufficient; together they provide defense-in-depth across both **existing positions** and **unreserved liquidity**:

1. **Snapshot Isolation Protects Already-Committed Capital (`M-03`):**
   - `createOffer()` snapshots `protocolFeeBps` onto `Offer` and locks `o.minFillAmount >= tokenMinTicketAmount[p.inventoryToken]`.
   - `reserve()` snapshots `protocolFeeBps`, `minFillAmount`, `spreadBps`, `oracle`, `complianceHook`, `fixedOrMinPriceX36`, and `maxPriceX36` onto `Ticket`.
   - Consequently, a governance call to `setProtocolFeeBps` or `setTokenMinTicketAmount` **cannot retroactively tax existing LP offers/tickets or lock holders out of `splitTicket` / partial `exercise`**.
2. **Timelock Protects Uncommitted Offers & Shared Periphery (`OraclePriceAdapter` / `approvedRouters`):**
   - Because `Offer` and `Ticket` store the address of `OraclePriceAdapter` (whose `PairConfig` is mutable via `setPairConfig`), snapshotting scalar numbers on `CommitmentManager` alone cannot freeze `PairConfig` changes inside an external adapter.
   - Placing `setPairConfig`, `addSigner`, `removeSigner`, `setApprovedOracle`, and `setApprovedRouter` behind a **`24h–48h` `TimelockController`** guarantees that any proposed change is publicly visible via `CallScheduled` events at least `24h–48h` before `execute()` can mutate on-chain state.
   - During that window, any LP who disagrees with an upcoming `PairConfig` or fee change can permissionlessly call `cancelOffer(offerId)` / `decreaseOffer(offerId, ...)` + `withdrawFree(...)`, and any `FLOATING` ticket holder can exercise or exit under existing terms before the new configuration activates.

---

## 4. Guardian Emergency Powers & `setGuardian` Rotation (`M-05` + Workstream B)

### 4.1 Contract Changes Required for Unified Guardian Control

1. **`CommitmentManager.sol`:**
   - Add `function setGuardian(address _guardian) external onlyOwner` (`if (_guardian == address(0)) revert ZeroAddress(); guardian = _guardian; emit GuardianUpdated(_guardian);`), closing `M-05` (`test_PoC_M5_UnrotatableCommitmentManagerGuardianPermanentPause`).
   - Add `bool public floatingExercisePaused;` and `event FloatingExercisePausedSet(bool paused);`.
   - Add `function setFloatingExercisePaused(bool paused) external` (`if (msg.sender != guardian && msg.sender != owner()) revert Unauthorized(); floatingExercisePaused = paused; emit FloatingExercisePausedSet(paused);`).
   - Enforce `if (floatingExercisePaused && t.priceMode == PriceMode.FLOATING) revert FloatingExercisePaused();` inside `exercise()` and `exerciseFor()` **only when `t.priceMode == PriceMode.FLOATING`**. `PriceMode.FIXED` tickets must never revert due to `floatingExercisePaused`.
2. **`SignedPullOracle.sol`:**
   - Add `address public guardian;` + `event GuardianUpdated(address indexed guardian);` + `setGuardian(address _guardian) external onlyOwner`.
   - Add `event PriceRevoked(address indexed inventoryToken, address indexed paymentToken, uint256 lastUpdatedAt);`.
   - Add `function revokePrice(address inventoryToken, address paymentToken) external` (`if (msg.sender != guardian && msg.sender != owner()) revert Unauthorized();`): sets `_prices[pairKey].priceX36 = 0` while **preserving `_prices[pairKey].updatedAt`**.
     - *Critical Replay Guard:* Preserving `updatedAt` guarantees that `getPriceX36()` returns `{priceX36: 0, updatedAt: prev, isValid: false}` (immediate fail-closed halt) **and** prevents any attacker from replaying an already-signed `PriceReport` with `reportTimestamp <= prevUpdatedAt` (`StaleTimestamp()`).

### 4.2 Complete Guardian vs. Owner Authority Matrix & `INV-8` Guarantee

| Contract | `guardian` (`2-of-3` Safe) Can Call | `owner` (`TimelockController`) Can Call | **Strictly Unpausable & Unhooked (`INV-8`)** |
| --- | --- | --- | --- |
| **`LiquidityVault`** | `setDepositsPaused(bool)` | `setDepositsPaused(bool)`, `setGuardian(address)`, `setPendingFeeCollector(address)` | `withdrawFree`, `claimProceeds`, `settleExercise` (`FIXED` or non-paused), `releaseTicketToOffer`, `releaseTicketToFree` |
| **`CommitmentManager`** | `setNewReservationsPaused(bool)`, `setFloatingExercisePaused(bool)` | All `guardian` calls + `setGuardian(address)`, `setProtocolFeeBps(uint16)`, `setTokenMinTicketAmount`, `setApproved*` | `exercise` / `exerciseFor` for `PriceMode.FIXED`, `decreaseOffer`, `pauseOffer`, `unpauseOffer`, `cancelOffer`, `reclaimExpired`, `reclaimExpiredBatch`, `reclaimExpiredBatchBestEffort`, `quote*` |
| **`SignedPullOracle`** | `revokePrice(inv, pay)` | `revokePrice(inv, pay)`, `setGuardian(address)`, `addSigner`, `removeSigner`, `setThreshold`, `setMaxJumpBps`, `setMaxPriceAge` | `getPriceX36` (view), `updatePrice` (permissionless M-of-N submission) |
| **`OraclePriceAdapter` / `UniswapV3TwapOracle` / `HSPComplianceHook`** | *(None — zero blast radius if Guardian compromised)* | `setPairConfig`, `setPoolConfig`, `setAttestationSigner`, `setApproved`, `revoke` | Read-only `view` queries |

> **Guardian Compromise Blast-Radius Bound:** If the `2-of-3` Guardian Safe is compromised, the attacker **cannot** steal funds, alter fees, inject oracle signers, freeze `FIXED` exercises, or block LP withdrawals (`INV-8`). They can only pause new deposits/reservations/floating exercises or revoke cached prices, and `TimelockController` (`3-of-5` Governance Safe) can atomically evict and replace `guardian` across all 3 contracts via `scheduleBatch` / `executeBatch`.

### 4.3 Atomic Guardian Rotation Procedure (`M-05`)

To prevent split-brain `guardian` state across `LiquidityVault`, `CommitmentManager`, and `SignedPullOracle`:
1. Governance Safe prepares a single `TimelockController.scheduleBatch(...)` targeting all three contracts in one atomic batch:
   - `LiquidityVault.setGuardian(newGuardianSafe)`
   - `CommitmentManager.setGuardian(newGuardianSafe)`
   - `SignedPullOracle.setGuardian(newGuardianSafe)`
2. After `minDelay` (`24h` / `48h`), Governance Safe calls `TimelockController.executeBatch(...)`.
3. Immediately after execution, verify all three `guardian()` views equal `newGuardianSafe` and test a non-destructive read/dry-run signature from `newGuardianSafe`.

---

## 5. Oracle Signer Rotation & Compromise Playbook

### 5.1 M-of-N `SignedPullOracle` Architecture Alignment

Per [`REMEDIATION_SPEC.md`](file:///c:/Users/USER/Desktop/Tranche/research/REMEDIATION_SPEC.md) (§2.5), `SignedPullOracle` enforces:
- `mapping(address => bool) public isSigner;`, `uint256 public signerCount;`, `uint8 public threshold;` (recommended launch config: **`2-of-3`**, scaling to **`3-of-5`** as independent signer operators onboard).
- `updatePrice(inv, pay, priceX36, reportTimestamp, bytes[] calldata signatures)` verifies `signatures.length >= threshold` with strictly ascending recovered signer addresses (`recovered > lastSigner`) and `isSigner[recovered] == true` (preventing duplicate signature reuse).
- `maxJumpBps[pairKey]` rejects single-update jumps exceeding configured bps relative to non-zero prior `priceX36` (suggested initial caps: `300 bps` for `WETH/USDT` & `WBTC/USDT`, `500 bps` for `WHSK/USDT`; bypassed only when prior `priceX36 == 0`, e.g., initial seed or post-`revokePrice`).
- `maxPriceAge` (e.g., `30s`) enforced directly inside `SignedPullOracle.getPriceX36()` (`L-04`) as defense-in-depth even if queried outside `OraclePriceAdapter`.

### 5.2 Zero-Downtime Routine Signer Rotation (`addSigner` -> Verify -> `removeSigner`)

Rotate one signer at a time without halting `FLOATING` execution:

1. **Provision & Dry-Run (`T-48h`):** Provision `S_new` in an isolated Cloud KMS/HSM (`ECC_SECG_P256K1`, zero HSK balance). Verify off-chain EIP-712 digest signing against domain `("ProtocolSignedPullOracle", "1", chainId=177, verifyingContract=SignedPullOracle)`.
2. **Schedule Addition:** `3-of-5` Governance Safe schedules `SignedPullOracle.addSigner(S_new)` in `TimelockController`. (While waiting `24h–48h`, existing `M`-of-`N` signers operate uninterrupted.)
3. **Execute Addition:** Execute `addSigner(S_new)` -> pool becomes `M`-of-`(N+1)`. Quorum continues uninterrupted.
4. **Canary & Health Verification (`>= 15 min`):** Enable `S_new` in the aggregator signer mesh; confirm `PriceUpdated` events include `S_new` signatures on `WHSK/USDT`, `WETH/USDT`, and `WBTC/USDT`, `OraclePriceAdapter.getPriceX36()` reports `isValid == true`, and deviation vs CEX median is `< 25 bps`.
5. **Schedule & Execute Removal:** Governance Safe schedules and executes `SignedPullOracle.removeSigner(S_old)` (contract enforces `signerCount - 1 >= threshold` so quorum can never be accidentally bricked). If changing quorum size (e.g., `2-of-3` -> `3-of-5`), adjust `setThreshold` only after all new signers are verified live.
6. **Key Destruction:** Revoke/schedule deletion of `S_old` in Cloud KMS only after `isSigner(S_old) == false` is confirmed on chain `177`.

### 5.3 Active Signer Compromise Playbook (`< 60s` Containment)

**Trigger:** Watchdog fires `CRITICAL` on `|pullPrice - independentCexMid| > 200 bps`, unauthorized `PriceUpdated` signature from unknown aggregator host, or abnormal `FLOATING` exercise drain (`> 50%` pool in `2 min`).

| Step | SLA | Actor | Exact On-Chain / Off-Chain Actions | Expected State |
| --- | --- | --- | --- | --- |
| **1. Fast-Path Containment** | **`< 60s`** (`T+0`) | `2-of-3` Security Guardian Safe | Submit single multicall tx via Safe:<br>1. `CommitmentManager.setFloatingExercisePaused(true)`<br>2. `CommitmentManager.setNewReservationsPaused(true)`<br>3. `SignedPullOracle.revokePrice(WHSK, USDT)`<br>4. `SignedPullOracle.revokePrice(WETH, USDT)`<br>5. `SignedPullOracle.revokePrice(WBTC, USDT)`<br>*(Optional if vault token anomaly suspected: `LiquidityVault.setDepositsPaused(true)`)* | All active `FLOATING` exercises & new reservations **immediately revert**; stored quotes return `isValid=false`; `updatedAt` preserved so attacker cannot replay old signatures; `FIXED` + `withdrawFree` + `claimProceeds` + `reclaimExpired` stay **100% live (`INV-8`)**. |
| **2. Off-Chain Eradication** | **`T+2m`** | On-Call Infra | Disable compromised KMS key(s) via IAM emergency deny policy; halt submitter relayers; rotate KMS credentials and aggregator API tokens. | Compromised key cannot produce new signatures; relayers idle. |
| **3. Timelocked Signer Replacement** | **`T+15m`** (executes at `T+24h/48h`) | `3-of-5` Governance Safe -> `TimelockController` | Propose `scheduleBatch`:<br>1. `SignedPullOracle.removeSigner(S_compromised)` *(if `signerCount - 1 < threshold`, call `addSigner(S_new)` first in the same batch before `removeSigner`)*<br>2. `SignedPullOracle.addSigner(S_new)` *(if replacing)*<br>3. Update `OraclePriceAdapter.setPairConfig` if bounds/staleness need tightening. | Compromised signer queued for permanent on-chain removal while `floatingExercisePaused == true` holds the perimeter safely. |
| **4. Forensic Audit** | **During Delay** | Security & Ops | Audit all `PriceUpdated` and `TicketExercised` logs during incident window; verify `INV-1` vault solvency across `WHSK`, `WETH`, `WBTC`, `USDT`. Run `reclaimExpiredBatchBestEffort` for any `FLOATING` tickets expiring during outage. | Full loss/exposure accounting published; LPs recover expired collateral automatically. |
| **5. Clean Recovery & Unpause** | **`T+Delay`** | Governance Safe + Guardian Safe | 1. Execute `TimelockController.executeBatch(...)`.<br>2. Verify `isSigner(S_compromised) == false` and `isSigner(S_new) == true`.<br>3. Start clean M-of-N aggregator + push fresh `PriceReport` for all 3 pairs (`reportTimestamp = min(utcNow - 2, latestBlock.timestamp)` — strictly `> preserved updatedAt`).<br>4. Confirm `SignedPullOracle.getPriceX36` and `OraclePriceAdapter.getPriceX36` return `isValid == true` within `< 50 bps` of live CEX median.<br>5. Unpause `setFloatingExercisePaused(false)`, `setNewReservationsPaused(false)`, and `setDepositsPaused(false)`. | Normal `FLOATING` and `FIXED` operations resumed with zero stale quote carryover. |

---

## 6. Monitoring, Alerting, Keeper Redundancy & LP Recovery Procedures

### 6.1 Concrete Production Alerting Matrix

All on-chain checks run via a dedicated read-only **Protocol Watchdog** polling every **`4–6s` (`2–3` blocks)** through `Multicall3` (`0xcA11bde05977b3631167028862be2a173976ca11`) in batches of **`<= 35` calls** spaced **`>= 350 ms`** across dual RPC endpoints (dedicated private OP Stack node + `https://mainnet.hsk.xyz` failover):

| Signal | Query / Metric Source | `WARN` Threshold | `CRITICAL` (Page + Runbook) | Automated / Operator Action |
| --- | --- | --- | --- | --- |
| **`INV-1` Physical Vault Solvency** | `IERC20(t).balanceOf(vault) >= totalLpFree(t) + totalOfferAvailable(t) + totalReserved(t) + totalPendingProceeds(t) + protocolFees(t)` | N/A (exact invariant) | **Any `<` deficit (`> 0 wei`)** | Page immediately; Guardian calls `setDepositsPaused(true)` + `setNewReservationsPaused(true)`; halt and audit token transfer accounting. |
| **`INV-7` Router Zero-Residue** | `IERC20(t).balanceOf(router)` & `IERC20(t).allowance(router, vault)` | N/A | **Any value `> 0`** | Page immediately; inspect tx trace for failed/leaked transfer or residual approval. |
| **Oracle Staleness (`SignedPullOracle`)** | `latestBlock.timestamp - pullOracle.getPriceX36(inv, pay).updatedAt` | **`> 20s` (`10` blocks)** | **`> 25s`** (`> 30s` `maxPriceAge` / `maxStaleness` = `FLOATING` halted) | Auto-failover to Backup Relayer B & Secondary RPC; verify KMS + aggregator health. |
| **M-of-N Signer & CEX Quorum** | Healthy CEX venues (`WETH`/`WBTC` target `>=4`, `WHSK` `>=2`) & live KMS signers | **Online signers `== threshold`** (0 redundancy) or `1` CEX down | **Online signers `< threshold`** or CEX `< minQuorum` (signing halted) | Fail closed (halt signing); page on-call to restore degraded KMS signer or exchange feed. |
| **Single-Update Price Jump** | `\|P_new - P_prev\| / P_prev` on `PriceUpdated` (or off-chain pre-sign check) | **`> 150 bps`** | **`> 200 bps`** (`> maxJumpBps` on-chain reject or anomalous jump) | Block automatic signing above cap; verify multi-CEX orderbooks for flash crash vs compromised signer -> run Compromise Playbook (§5.3) if unexplained. |
| **Cross-Feed Deviation (`Adapter`)** | `\|pullPrice - twapPrice\| / min` (on `WHSK/USDT` where `requireSecondaryCheck = true`) | **`> 250 bps`** | **`> 400 bps`** (`> 500 bps` trips `OraclePriceAdapter` breaker) | Cross-check CEX median vs HSKSwap V3 pool (`0x4ff5...`); diagnose TWAP skew vs primary feed compromise. |
| **Active-Ticket Reserve / Exercise Spike** | Delta of `totalReserved(t)` / `TicketExercised` vs `totalOfferAvailable(t)` | **`> 25%` pool reserved in `5 min`** | **`> 50%` pool exercised in `2 min`** or `effPriceX36` diverges `> 200 bps` from CEX mid | Immediate suspected oracle mispricing/compromise -> trigger Guardian `setFloatingExercisePaused(true)` + `revokePrice`. |
| **Relayer Gas Balance & Stuck Nonce** | `eth_getBalance(relayer)` & oldest pending tx age | **`< 250 HSK`** or pending `> 4s` (`2` blocks) | **`< 75 HSK`** or stuck `> 12s` (`6` blocks) | Auto-bump fee `+20%` on same nonce; top up to `1,000 HSK` cap; promote Backup Relayer B. |
| **RPC Rate-Limit & Block Lag** | `eth_blockNumber` timestamp vs UTC; `429`/`5xx` ratio | Lag `> 6s` or `429 > 2%` | Lag `> 16s` (`8` blocks) or primary RPC unreachable | Shift watchdog & keeper traffic to Secondary RPC; throttle non-critical log scans. |
| **Expired Unreclaimed Tickets** | Active tickets with `block.timestamp > expiresAt + 60s` | **`> 5` tickets** or `> 60s` lag | **`> 20` tickets** or `> 300s` lag | Fail over to Shadow Keeper; inspect keeper RPC & gas balance. |

### 6.2 Keeper Redundancy & RPC-Compliant Batch Recovery (`L-01`)

Because `graphnode.hashkeychain.net` DNS fails (`VERIFIED` in [`OPERATIONS_ARCHITECTURE.md`](file:///c:/Users/USER/Desktop/Tranche/research/OPERATIONS_ARCHITECTURE.md) §1) and `https://mainnet.hsk.xyz` enforces strict limits (`eth_getLogs >= 10,000` blocks returns HTTP `400`; sequential calls trigger HTTP `429`; oversized `Multicall3` returns HTTP `413`), the keeper tier operates as follows:

1. **Active-Passive / Staggered Primary + Shadow Keepers:**
   - **Primary Keeper:** Uses Dedicated Private RPC, targets expired tickets as soon as `latestBlock.timestamp > t.expiresAt + 2` (`1`-block grace against discrete `2.0s` block timestamps).
   - **Shadow Keeper:** Independent EOA key, independent host, connected to Secondary RPC (`https://mainnet.hsk.xyz` fallback), triggers at `latestBlock.timestamp > t.expiresAt + 8` (`4`-block stagger). If Primary stalls, Shadow automatically clears the backlog within `8s`.
2. **Subgraph-Free Dual Indexing (`<= 2,000`-Block Log Windows + `nextTicketId()` Reconciliation):**
   - **Incremental Event Cursor:** Poll `eth_getLogs` for `TicketReserved`, `TicketSplit`, `TicketExercised`, and `TicketReclaimed` in **`<= 2,000`-block chunks** (5x safety margin under the `10,000`-block cap).
   - **Full-State Reconciliation:** Periodically scan `[lastReconciledId .. CommitmentManager.nextTicketId() - 1]` via `Multicall3.aggregate3()` calling `CommitmentManager.getTicket(id)` in batches of **`<= 35` calls** spaced **`>= 350 ms`**. This guarantees zero missed tickets even across RPC drops or node re-orgs.
3. **Race-Proof Execution via `reclaimExpiredBatchBestEffort` (`L-01`):**
   - Submit batches of at most `20` expired `ticketIds` to **`CommitmentManager.reclaimExpiredBatchBestEffort(uint256[] calldata ticketIds)`** (never the all-or-nothing `reclaimExpiredBatch`).
   - Simulate with `eth_call` immediately prior to signing to skip already-reclaimed items and avoid wasted gas.
   - If a competing LP or Shadow Keeper races and reclaims/exercises 1 ticket in the same block, `reclaimExpiredBatchBestEffort` skips that ticket cleanly and reclaims the remaining `19`, eliminating atomic batch DoS (`L-01`).

### 6.3 Step-by-Step LP Self-Recovery Procedures (`INV-8`)

If **Governance**, **Oracles**, **Compliance Hooks**, or **Keepers** are completely offline or paused, LPs never depend on any privileged role or external service to exit their unreserved capital, earned proceeds, or expired collateral (`INV-8`).

| Step | Scenario / Goal | Exact Contract Call | Dependency Check | Outcome |
| --- | --- | --- | --- | --- |
| **1. Halt New Fills on Existing Offer** | Stop new taker reservations immediately without waiting for governance | `CommitmentManager.pauseOffer(offerId)` *(temporary)* **OR** `CommitmentManager.cancelOffer(offerId)` *(permanent)* | **Unpausable.** Ignores `newReservationsPaused`, `floatingExercisePaused`, oracles, and compliance hooks. | `cancelOffer` sets `status = CANCELLED` and automatically moves 100% of `vault.offerBalance(offerId)` to `vault.lpFreeBalance[lp][inventoryToken]`. |
| **2. Partial Capital Pullback** | Reduce offer size while keeping offer active | `CommitmentManager.decreaseOffer(offerId, removeAmount)` | **Unpausable.** Zero oracle/hook calls. | Moves `removeAmount` from `offerBalance[offerId]` to `lpFreeBalance[lp][inventoryToken]`. |
| **3. Self-Reclaim Expired Tickets (Keeper Offline)** | Recover inventory from expired tickets (`block.timestamp > t.expiresAt`) | `CommitmentManager.reclaimExpired(ticketId)` **OR** `CommitmentManager.reclaimExpiredBatchBestEffort(ticketIds)` | **Permissionless & Unpausable.** Zero oracle/hook calls. | Burns expired NFT. If `offer` is still `ACTIVE` and `< o.expiry`, inventory returns to `offerBalance` (call `cancelOffer` to move to `lpFreeBalance`); otherwise returns **directly to `lpFreeBalance`**. |
| **4. Withdraw Free Inventory** | Pull inventory tokens out of `LiquidityVault` to external wallet | `LiquidityVault.withdrawFree(inventoryToken, amount, toAddress)` | **Unpausable.** Never gated by `depositsPaused` or compliance hooks. | Transfers exact `amount` of `inventoryToken` directly to `toAddress`. |
| **5. Claim Earned Premiums & Exercise Payments** | Pull accumulated `USDT` / `paymentToken` proceeds | `LiquidityVault.claimProceeds(paymentToken, 0, toAddress)` *(passing `0` claims full `lpPendingProceeds`)* | **Unpausable.** Never gated by `depositsPaused` or compliance hooks. | Transfers 100% of `lpPendingProceeds[lp][paymentToken]` directly to `toAddress`. |

> **Important Edge Case — Active Unexpired Tickets:**  
> Inventory backing an active, unexpired ticket (`t.status == TicketStatus.ACTIVE && block.timestamp <= t.expiresAt`) is **contractually locked in `ticketReserved[ticketId]`** until either the taker exercises (crediting `lpPendingProceeds` for Step 5) or `block.timestamp > t.expiresAt` (unlocking permissionless `reclaimExpired` in Step 3). With the `L-02` remediation (`block.timestamp + duration <= o.expiry`), maximum lockup is strictly bounded by `Offer.expiry`.

---

## 7. Verification & Acceptance Criteria (Pre-Implementation Gate)

Before Phase 2 governance changes are accepted onto `remediation/mainnet-readiness`, Foundry tests and deployment checks must verify:
1. **`Ownable2Step` Across All 6 Contracts (`M-05`):** Non-owners cannot mutate admin state; `transferOwnership` alone does not grant control until `acceptOwnership()` succeeds; `constructor(..., address(0))` reverts.
2. **Two-Step `feeCollector` (`I-02`):** `setPendingFeeCollector` does not change `feeCollector` or allow `withdrawProtocolFees` until `acceptFeeCollector()` is called by `pendingFeeCollector`.
3. **Atomic Guardian Rotation & `FLOATING` Pause (`M-05` + Workstream B):** `CommitmentManager.setGuardian` revokes compromised guardian's ability to pause; `setFloatingExercisePaused(true)` reverts `FLOATING` `exercise()` / `exerciseFor()` while `FIXED` `exercise()` / `exerciseFor()`, `withdrawFree()`, `claimProceeds()`, `cancelOffer()`, and `reclaimExpired()` all succeed (`INV-8`).
4. **`SignedPullOracle.revokePrice` Replay Immunity:** `revokePrice` makes `getPriceX36()` return `isValid == false` immediately while rejecting replay of any prior `reportTimestamp <= preserved updatedAt`.
5. **Best-Effort Batch Reclaim (`L-01`):** `reclaimExpiredBatchBestEffort([expired1, alreadyReclaimed, unexpired, expired2])` skips the 2 invalid items and reclaims `expired1` & `expired2` (`reclaimedCount == 2`) without reverting.
6. **Timelock + Snapshot Isolation (`M-03`):** `TimelockController` rejects execution before `minDelay`; post-delay `setProtocolFeeBps` / `setTokenMinTicketAmount` leave existing `Offer` / `Ticket` economics untouched.
