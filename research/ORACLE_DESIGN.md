# Tranche — Production Oracle Remediation & Architecture Design (Phase 2, Workstream B)

> **Baseline Reference:** Frozen commit `f5d61e76134fd3badc831d10136318431aabd413` (`main`)  
> **Upstream Inputs:** [`ORACLE_READINESS.md`](file:///c:/Users/USER/Desktop/Tranche/research/ORACLE_READINESS.md), [`MAINNET_READINESS.md`](file:///c:/Users/USER/Desktop/Tranche/research/MAINNET_READINESS.md), [`SECURITY_FINDINGS.md`](file:///c:/Users/USER/Desktop/Tranche/research/SECURITY_FINDINGS.md), [`OPERATIONS_ARCHITECTURE.md`](file:///c:/Users/USER/Desktop/Tranche/research/OPERATIONS_ARCHITECTURE.md), [`deployments/hashkey-mainnet.json`](file:///c:/Users/USER/Desktop/Tranche/deployments/hashkey-mainnet.json)  
> **Target Network:** HashKey Chain Mainnet (OP Stack L2, Chain ID `177`, `2.0000s` block time)  
> **Scope:** Design-before-coding specification for Workstream B oracle, circuit-breaker, emergency pause, and Chainlink Data Streams evaluation. Zero code files modified in this step.

---

## 1. Design Objectives & Closed Findings

This design closes every oracle-related `P0`/`P1` blocker identified across Phase 1 Workstreams A, B, and C:

| ID / Source | Defect in Frozen Baseline (`f5d61e76`) | Remediation in This Design |
| --- | --- | --- |
| **WS-B §2.1 / §2.3** | Single `authorizedSigner` key controls `SignedPullOracle`; single-key compromise drains `FLOATING` offers without `minPriceX36`. | Replace single signer with **M-of-N threshold quorum** (`isSigner`, `signerCount`, `threshold`), strictly ascending signer recovery in $O(k)$ with zero storage writes for dedup. |
| **WS-A `L-04` (Direct Pull TTL)** | `SignedPullOracle.getPriceX36()` has no internal TTL (`isValid: true` indefinitely). | Add `uint32 public maxPriceAge` enforced inside `SignedPullOracle.getPriceX36()`. |
| **WS-B §2.3 (Jump Cap)** | `SignedPullOracle.updatePrice()` accepts `1000x` or `-99.99%` single-update jumps (`priceX36 > 0` only). | Add per-pair `mapping(bytes32 => uint16) public maxJumpBps` checked on-chain against previous non-zero `priceX36`. |
| **WS-B §2.3 / §6.1 (`revokePrice` + Guardian Pause)** | `SignedPullOracle` has no `revokePrice()`; `guardian` cannot halt active `FLOATING` `exercise()` calls; `CommitmentManager` lacks `setGuardian()`. | Add `SignedPullOracle.revokePrice()` (`owner` or `guardian`) and `CommitmentManager.setFloatingExercisePaused(bool)` (`guardian` or `owner`), preserving `FIXED` exercises and `reclaimExpired()` (`INV-8`). |
| **WS-A `H-01` + `L-04` (`OraclePriceAdapter`)** | `if (pOk && !sOk) return p;` silently disables `maxDeviationBps`; shared `maxStaleness`; unchecked `(diff * BPS_DENOMINATOR) / minP`. | Add `bool requireSecondaryCheck` and independent `uint32 secondaryMaxStaleness`; fail closed when required secondary is unhealthy; use `Math.mulDiv`. |
| **WS-B §6.2 / §6.3 (Mainnet Bounds & Thin V3 Pools)** | Test bounds `1e18..1e27` break `WETH/USDT` (`1.704e27`) and `WBTC/USDT` (`6.183e38`); `$83.7k–$90.7k` V3 pools allow `~$15` TWAP-skew DoS. | Specify exact decimal-aware bounds for `WHSK/USDT`, `WETH/USDT`, and `WBTC/USDT`; enforce V3 TWAP secondary check only on `WHSK/USDT` (`$839.2k` TVL). |
| **WS-A `M-05` (Governance)** | `immutable admin` on `SignedPullOracle`, `OraclePriceAdapter`, `UniswapV3TwapOracle`, `CommitmentManager`. | Migrate to OpenZeppelin `Ownable2Step` (`lib/openzeppelin-contracts` v5.x) owned by a Gnosis Safe multisig. |

---

## 2. M-of-N Threshold Quorum (`SignedPullOracle.sol`)

### 2.1 Inheritance, Storage Layout & Role Separation

Replace `address public immutable admin` and `address public authorizedSigner` ([`SignedPullOracle.sol#L30-L31`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/SignedPullOracle.sol#L30-L31)) with `Ownable2Step` (`@openzeppelin/contracts/access/Ownable2Step.sol`), a rotatable `guardian`, and an M-of-N signer set:

```solidity
// Inheritance: EIP712, Ownable2Step, IPriceOracle
// EIP712 Domain: ("ProtocolSignedPullOracle", "2") — version bumped from "1" to "2"
// because updatePrice() quorum semantics and signer set change (verifyingContract also changes).

bytes32 public constant PRICE_REPORT_TYPEHASH = keccak256(
    "PriceReport(address inventoryToken,address paymentToken,uint256 priceX36,uint256 reportTimestamp)"
);
uint256 public constant BPS_DENOMINATOR = 10_000;
uint16 public constant MAX_JUMP_BPS_LIMIT = 5_000; // 50% ceiling on configurable jump cap

address public guardian;
uint32 public maxPriceAge;                  // Internal TTL enforced in getPriceX36()
uint256 public signerCount;                 // Active authorized signers
uint256 public threshold;                   // Required M-of-N unique valid signatures

mapping(address => bool) public isSigner;
mapping(bytes32 => StoredPrice) internal _prices;
mapping(bytes32 => uint16) public maxJumpBps; // pairKey => max delta bps vs previous non-zero price
```

#### Exact Governance & Quorum Management Interface

| Function | Access | Validation & State Transition | Events / Errors |
| --- | --- | --- | --- |
| `constructor(address initialOwner, address _guardian, address[] memory initialSigners, uint256 _threshold, uint32 _maxPriceAge)` | Deployer | `Ownable(initialOwner)` reverts on `address(0)`. Require `_guardian != address(0)`, `_maxPriceAge > 0`, `initialSigners.length > 0`, `_threshold >= 1 && _threshold <= initialSigners.length`. Loop `initialSigners`: reject `address(0)` and duplicates (`AlreadySigner()`), set `isSigner[s] = true`, increment `signerCount`. | Emits `GuardianUpdated`, `MaxPriceAgeUpdated`, `SignerAdded` (per signer), `ThresholdUpdated`. |
| `addSigner(address signer)` | `onlyOwner` | Revert `ZeroAddress()` if `signer == address(0)`. Revert `AlreadySigner()` if `isSigner[signer]`. Set `isSigner[signer] = true`; `unchecked { ++signerCount; }`. | `event SignerAdded(address indexed signer);` |
| `removeSigner(address signer)` | `onlyOwner` | Revert `NotSigner()` if `!isSigner[signer]`. Revert `ThresholdExceedsSignerCount()` if `signerCount - 1 < threshold` (must lower `threshold` first or add replacement signer first — enforces invariant `1 <= threshold <= signerCount` at all times). Set `isSigner[signer] = false`; `--signerCount`. | `event SignerRemoved(address indexed signer);` |
| `setThreshold(uint256 newThreshold)` | `onlyOwner` | Revert `InvalidThreshold()` if `newThreshold == 0 \|\| newThreshold > signerCount`. Set `threshold = newThreshold`. | `event ThresholdUpdated(uint256 threshold);` |
| `setGuardian(address newGuardian)` | `onlyOwner` | Revert `ZeroAddress()` if `newGuardian == address(0)`. Set `guardian = newGuardian`. | `event GuardianUpdated(address indexed guardian);` |
| `setMaxPriceAge(uint32 newMaxPriceAge)` | `onlyOwner` | Revert `InvalidMaxPriceAge()` if `newMaxPriceAge == 0`. Set `maxPriceAge = newMaxPriceAge`. | `event MaxPriceAgeUpdated(uint32 maxPriceAge);` |
| `setMaxJumpBps(address inventoryToken, address paymentToken, uint16 _maxJumpBps)` | `onlyOwner` | Revert `ZeroAddress()` if either token is `0`. Revert `InvalidMaxJumpBps()` if `_maxJumpBps > MAX_JUMP_BPS_LIMIT`. Set `maxJumpBps[pairKey] = _maxJumpBps`. | `event MaxJumpBpsUpdated(address indexed inventoryToken, address indexed paymentToken, uint16 maxJumpBps);` |

### 2.2 $O(k)$ Duplicate-Free Quorum Verification in `updatePrice`

Signature verification processes `bytes[] calldata signatures` in a single linear pass with **zero storage writes** for duplicate tracking:

```solidity
function updatePrice(
    address inventoryToken,
    address paymentToken,
    uint256 priceX36,
    uint256 reportTimestamp,
    bytes[] calldata signatures
) external
```

Execution sequence:
1. **Input & Monotonicity Checks (Fail Fast Before `ecrecover`):**
   - `if (inventoryToken == address(0) || paymentToken == address(0)) revert ZeroAddress();`
   - `if (priceX36 == 0) revert ZeroPrice();`
   - `if (reportTimestamp > block.timestamp) revert FutureTimestamp();`
   - `bytes32 pairKey = keccak256(abi.encode(inventoryToken, paymentToken));` *(or `abi.encodePacked(inventoryToken, paymentToken)` to preserve exact frozen `pairKey` convention across `SignedPullOracle` and `OraclePriceAdapter`)*
   - `StoredPrice memory prev = _prices[pairKey];`
   - `if (reportTimestamp <= prev.updatedAt) revert StaleTimestamp();`
   - `uint256 required = threshold;`
   - `if (signatures.length < required) revert InsufficientSignatures();`
2. **Per-Pair Maximum Jump Check:**
   - See §3.2 below (checked before or after signature verification; checking jump before `ecrecover` saves gas on invalid updates, OR checking after `ecrecover` avoids leaking jump bounds if needed — checking after `ecrecover` ensures only quorum-authenticated reports trigger `MaxJumpExceeded` vs `InvalidSigner`, which is cleaner for incident forensics).
3. **EIP-712 Digest & Strictly Ascending Signer Recovery ($O(k)$):**
   ```solidity
   bytes32 structHash = keccak256(
       abi.encode(PRICE_REPORT_TYPEHASH, inventoryToken, paymentToken, priceX36, reportTimestamp)
   );
   bytes32 digest = _hashTypedDataV4(structHash);

   address prevSigner = address(0);
   uint256 len = signatures.length;
   for (uint256 i = 0; i < len; ++i) {
       address recovered = ECDSA.recover(digest, signatures[i]);
       if (!isSigner[recovered]) revert InvalidSigner();
       if (recovered <= prevSigner) revert UnsortedOrDuplicateSigner();
       prevSigner = recovered;
   }
   ```
   - **Why `recovered <= prevSigner` is sufficient:**
     - `prevSigner` starts at `address(0)`, so `recovered == address(0)` is rejected even before considering `ECDSA.recover`'s internal zero-address revert.
     - Strictly ascending Ethereum addresses (`s_0 < s_1 < ... < s_{k-1}`) guarantee uniqueness mathematically without allocating a memory bitmap, sorting in Solidity, or writing a `seen` mapping to storage.
     - Off-chain aggregator sorts `(signerAddress, signature)` pairs by ascending `uint160(signerAddress)` before submitting `signatures[]`.
     - Verifying all `signatures.length` entries (with `signatures.length >= required`) ensures every supplied signature is a distinct valid signer and rejects malformed trailing payloads.
4. **Commit & Emit:**
   - `_prices[pairKey] = StoredPrice({priceX36: priceX36, updatedAt: reportTimestamp});`
   - `emit PriceUpdated(inventoryToken, paymentToken, priceX36, reportTimestamp);`

#### Gas Overhead Estimate on HashKey Chain (`177`)
- Baseline single-signer `updatePrice`: `~65,000–80,000` gas (`$0.0026–$0.0032` at `500.001 gwei`, `$0.080808` WHSK).
- Each additional `ECDSA.recover` (`ecrecover` precompile `3,000` gas + calldata + loop overhead): `~4,000–4,500` gas (`~$0.00018/sig`).
- **2-of-3 quorum:** `~70,000–85,000` gas (`~$0.0028–$0.0034` per update).
- **3-of-5 quorum:** `~74,000–90,000` gas (`~$0.0030–$0.0036` per update).

### 2.3 Residual Risk Analysis of M-of-N Quorum

- **What M-of-N Eliminates:** Single-key compromise. If one operator KMS key (`ECC_SECG_P256K1`) or one signer host is compromised, the attacker cannot reach `threshold` (`>= 2`) to forge a `PriceReport`.
- **Residual Risks That Remain:**
  1. **Federated / Permissioned Trust:** M-of-N remains a permissioned quorum operated by Tranche and/or designated co-signers — NOT a cryptoeconomically bonded, permissionless DON like Chainlink Data Streams. Collusion of `threshold` signer operators can still forge reports within `[hardMinPriceX36, hardMaxPriceX36]` and `maxJumpBps` (and within `maxDeviationBps = 500` on `WHSK/USDT`).
  2. **Correlated Key / Cloud Compromise:** If all `N` KMS keys live in the same AWS/GCP account or same IAM role, M-of-N collapses to 1-of-1 blast radius. **Mandatory Operational Rule:** Each of the `N` signer keys MUST sit in an independent trust boundary (e.g., separate cloud accounts/providers or separate institutional co-signer HSMs, each independently fetching CEX/DEX quotes before signing).
  3. **`owner` Governance Key Risk:** `Ownable2Step` `owner` can call `addSigner` and `setThreshold`. Therefore `owner` **MUST** be a Gnosis Safe multisig (and ideally subject to a timelock for `addSigner` / `setThreshold`, while keeping `removeSigner`, `revokePrice`, and `setFloatingExercisePaused` un-timelocked for incident response).

---

## 3. Price Freshness, Monotonicity & Maximum Jump Protection

### 3.1 Internal Freshness TTL (`maxPriceAge` — Closes `L-04`)

In the frozen contract ([`SignedPullOracle.sol#L76-L88`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/SignedPullOracle.sol#L76-L88)), `getPriceX36` returns `isValid: true` forever once a non-zero price is written. Any offer pointing directly to `SignedPullOracle` (`offer.oracle == address(pullOracle)`) bypasses `OraclePriceAdapter.maxStaleness`.

Remediated `SignedPullOracle.getPriceX36()`:

```solidity
function getPriceX36(address inventoryToken, address paymentToken)
    external
    view
    override
    returns (PriceQuote memory)
{
    bytes32 pairKey = keccak256(abi.encodePacked(inventoryToken, paymentToken));
    StoredPrice memory p = _prices[pairKey];
    if (
        p.priceX36 == 0 ||
        p.updatedAt == 0 ||
        p.updatedAt > block.timestamp ||
        block.timestamp - p.updatedAt > maxPriceAge
    ) {
        return PriceQuote({priceX36: 0, updatedAt: 0, isValid: false});
    }
    return PriceQuote({priceX36: p.priceX36, updatedAt: p.updatedAt, isValid: true});
}
```

- **Production Default:** `maxPriceAge = 30` seconds (`15` blocks at `2.0000s/block`), matching `OraclePriceAdapter.PairConfig.maxStaleness = 30`.
- **Effect:** Both direct `SignedPullOracle` consumers and `OraclePriceAdapter` fail closed (`isValid = false`, causing `CommitmentManager` to revert `OracleUnavailable()`) whenever the latest price is `> 30s` old or revoked (`priceX36 == 0`).

### 3.2 Per-Pair Maximum Jump Guard (`maxJumpBps`)

To bound instantaneous price jumps even if `threshold` keys sign an erroneous spike/crash (or experience an upstream API bug):

```solidity
uint16 jumpCapBps = maxJumpBps[pairKey];
if (prev.priceX36 > 0 && jumpCapBps > 0) {
    uint256 diff = priceX36 > prev.priceX36 ? priceX36 - prev.priceX36 : prev.priceX36 - priceX36;
    if (Math.mulDiv(diff, BPS_DENOMINATOR, prev.priceX36) > jumpCapBps) {
        revert MaxJumpExceeded(prev.priceX36, priceX36, jumpCapBps);
    }
}
```

- **Why `prev.priceX36` as denominator:** Measuring `|P_new - P_prev| / P_prev` gives a symmetric allowable band `[P_prev * (1 - jumpCap), P_prev * (1 + jumpCap)]` around the existing on-chain anchor.
- **Recommended Initial `maxJumpBps` Values:**
  - `WHSK/USDT`: `500` bps (`5.0%` max single-update move; `WHSK` has thinner orderbooks and wider intraday spread).
  - `WETH/USDT`: `300` bps (`3.0%` max single-update move; compensates for disabling thin V3 TWAP secondary check).
  - `WBTC/USDT`: `300` bps (`3.0%` max single-update move; compensates for disabling thin V3 TWAP secondary check).
- **Legitimate Gap / Recovery Override:**
  - When `prev.priceX36 == 0` (initial bootstrap OR immediately after `revokePrice()`), the jump check is skipped so a clean quorum-signed report can re-anchor the pair.
  - Therefore, after a sequencer halt or legitimate >3–5% macro gap, `guardian` or `owner` calls `revokePrice(inv, pay)` (explicit on-chain audit event `PriceRevoked`) so the next quorum `updatePrice` re-anchors without disabling `maxJumpBps` permanently.
  - Note: Because a compromised quorum could theoretically submit multiple sequential updates across blocks (`+3%` every `2s`), `maxJumpBps` does **not** replace `guardian` pause or `OraclePriceAdapter` hard bounds; rather, it slows down drain velocity and keeps per-block jumps within detection/alerting latency (`4–6s` Watchdog polling).

### 3.3 Monotonicity & Discrete L2 Block Timestamp Stamping

- **On-chain Monotonicity:**
  - `reportTimestamp > prev.updatedAt` (strictly greater, preventing replay of any historical signature `<= prev.updatedAt`).
  - `reportTimestamp <= block.timestamp` (prevents pre-signed future-dated reports).
- **Off-chain Stamping Rule (Mandatory for Chain `177`):**
  - HashKey Chain produces blocks every `2.0000s` (`VERIFIED`). Signing with raw wall-clock `utcNow` fails with `FutureTimestamp()` whenever `latestBlock.timestamp` lags wall-clock by `1–2s`.
  - Signers MUST stamp `reportTimestamp = min(utcNow - 2, latestKnownBlock.timestamp)` (agreeing on a shared discrete bucket or coordinator-proposed `targetTimestamp` fetched from the latest block header before quorum signing).
- **Same-Block / Revocation Replay Hazard Prevented:**
  - If an invalid/compromised price was committed at `prev.updatedAt = T_bad`, calling `revokePrice()` sets `priceX36 = 0` while **preserving `updatedAt = T_bad`** (never resetting `updatedAt = 0`).
  - Result: Every prior signed report with `reportTimestamp <= T_bad` remains permanently un-replayable, while a clean post-incident report stamped at `T_bad + 2` (next block) succeeds immediately after `revokePrice()`.

---

## 4. Emergency Revocation & Guardian Pause of Floating Execution

### 4.1 `SignedPullOracle.revokePrice(address inventoryToken, address paymentToken)`

Closes the gap where a compromised or buggy price inside the `30s` `maxStaleness` window could still be exercised after rotating signers:

```solidity
function revokePrice(address inventoryToken, address paymentToken) external {
    if (msg.sender != owner() && msg.sender != guardian) revert Unauthorized();
    bytes32 pairKey = keccak256(abi.encodePacked(inventoryToken, paymentToken));
    _prices[pairKey].priceX36 = 0; // Preserve _prices[pairKey].updatedAt to block replay!
    emit PriceRevoked(inventoryToken, paymentToken, msg.sender, _prices[pairKey].updatedAt);
}
```

- **Immediate Effect:** `SignedPullOracle.getPriceX36()` returns `isValid: false` on the very same block, and `OraclePriceAdapter.getPriceX36()` returns `isValid: false` (since `allowSecondaryFallback = false`).

### 4.2 `CommitmentManager.setFloatingExercisePaused(bool paused)` & `setGuardian(address)`

Closes the critical Workstream B gap ([`OPERATIONS_ARCHITECTURE.md#L172-L173`](file:///c:/Users/USER/Desktop/Tranche/research/OPERATIONS_ARCHITECTURE.md#L172-L173)) and `M-05` ([`SECURITY_FINDINGS.md#L155-L167`](file:///c:/Users/USER/Desktop/Tranche/research/SECURITY_FINDINGS.md#L155-L167)):

- **Governance Migration on `CommitmentManager`:**
  - Inherit `Ownable2Step` (replacing `address public immutable admin` at [`CommitmentManager.sol#L86`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L86)).
  - Add `setGuardian(address _guardian)` (`onlyOwner`, rejecting `address(0)`, emitting `GuardianUpdated(_guardian)`).
- **Floating Exercise Pause State & Controls:**
  ```solidity
  error FloatingExercisePaused();
  event FloatingExercisePausedSet(bool paused);

  bool public floatingExercisePaused;

  function setFloatingExercisePaused(bool paused) external {
      if (msg.sender != guardian && msg.sender != owner()) revert Unauthorized();
      floatingExercisePaused = paused;
      emit FloatingExercisePausedSet(paused);
  }
  ```
- **Enforcement in `CommitmentManager.exercise()` ([`CommitmentManager.sol#L305-L320`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L305-L320)):**
  ```solidity
  Ticket storage t = _tickets[ticketId];
  if (t.status != TicketStatus.ACTIVE) revert TicketNotActive();
  if (block.timestamp > t.expiresAt) revert TicketExpired();
  if (t.priceMode == PriceMode.FLOATING && floatingExercisePaused) {
      revert FloatingExercisePaused();
  }
  ```
- **Note on `ExecutionRouter.batchExercise()`:** Because `ExecutionRouter.batchExercise()` calls `manager.exercise(...)` for each leg ([`ExecutionRouter.sol#L101`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/ExecutionRouter.sol#L101)), any batch containing a `FLOATING` leg automatically reverts with `FloatingExercisePaused()`, while pure `FIXED` batches continue executing normally.
- **Invariant `INV-8` Preservation Matrix:**

| Action | `floatingExercisePaused == true` | `newReservationsPaused == true` |
| --- | --- | --- |
| `FLOATING` `exercise()` / `batchExercise()` | **HALTED** (`FloatingExercisePaused()`) | Live (unless `floatingExercisePaused`) |
| `FIXED` `exercise()` / `batchExercise()` | **100% LIVE** | **100% LIVE** |
| `reclaimExpired()` / `reclaimExpiredBatch()` | **100% LIVE** (`INV-8`) | **100% LIVE** (`INV-8`) |
| `decreaseOffer()` / `cancelOffer()` | **100% LIVE** | **100% LIVE** |
| `LiquidityVault.withdrawFree()` / `claimProceeds()` | **100% LIVE** (`INV-8`) | **100% LIVE** (`INV-8`) |
| `createOffer()` / `topUpOffer()` / `reserve()` | Live (unless `newReservationsPaused`) | **HALTED** (`NewReservationsPaused()`) |

---

## 5. Per-Pair Decimal-Aware Bounds & Secondary-Source Failure (`OraclePriceAdapter.sol`)

### 5.1 Closing `H-01` & `L-04` in `OraclePriceAdapter.sol`

Source baseline: [`OraclePriceAdapter.sol#L14-L94`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/OraclePriceAdapter.sol#L14-L94).

#### Updated `PairConfig` & Inheritance
Migrate `immutable admin` to `Ownable2Step` and replace `PairConfig` with independent staleness and explicit fail-closed requirement flags:

```solidity
struct PairConfig {
    address primaryFeed;
    address secondaryFeed;
    uint32 maxStaleness;
    uint32 secondaryMaxStaleness;
    uint16 maxDeviationBps;
    bool requireSecondaryCheck;
    bool allowSecondaryFallback;
    uint256 hardMinPriceX36;
    uint256 hardMaxPriceX36;
}
```

#### Config Validation (`setPairConfig` — `onlyOwner`)
```solidity
if (cfg.primaryFeed == address(0) || cfg.maxStaleness == 0) revert InvalidConfig();
if (cfg.secondaryFeed != address(0) && cfg.secondaryMaxStaleness == 0) revert InvalidConfig();
if (cfg.requireSecondaryCheck && cfg.secondaryFeed == address(0)) revert InvalidConfig();
if (cfg.hardMaxPriceX36 > 0 && cfg.hardMinPriceX36 > cfg.hardMaxPriceX36) revert InvalidConfig();
```

#### Remediated Resolution & Deviation Math (`getPriceX36`)
```solidity
(bool pOk, PriceQuote memory p) =
    _readAndValidate(cfg.primaryFeed, inventoryToken, paymentToken, cfg.maxStaleness, cfg);

if (cfg.secondaryFeed != address(0)) {
    (bool sOk, PriceQuote memory s) =
        _readAndValidate(cfg.secondaryFeed, inventoryToken, paymentToken, cfg.secondaryMaxStaleness, cfg);

    if (pOk && sOk) {
        uint256 minP = p.priceX36 < s.priceX36 ? p.priceX36 : s.priceX36;
        uint256 diff = p.priceX36 > s.priceX36 ? p.priceX36 - s.priceX36 : s.priceX36 - p.priceX36;

        if (cfg.maxDeviationBps > 0) {
            // Guard extreme ratios where diff * BPS_DENOMINATOR / minP > uint256.max (if hardMax == 0)
            if (diff > Math.mulDiv(type(uint256).max, minP, BPS_DENOMINATOR)) {
                return PriceQuote({priceX36: 0, updatedAt: 0, isValid: false});
            }
            if (Math.mulDiv(diff, BPS_DENOMINATOR, minP) > cfg.maxDeviationBps) {
                return PriceQuote({priceX36: 0, updatedAt: 0, isValid: false});
            }
        }
        return p;
    }

    if (!pOk && cfg.allowSecondaryFallback && sOk) {
        return s;
    }

    // H-01 FIX: Fail closed when secondary check is required!
    if (pOk && !sOk) {
        if (cfg.requireSecondaryCheck) {
            return PriceQuote({priceX36: 0, updatedAt: 0, isValid: false});
        }
        return p;
    }

    return PriceQuote({priceX36: 0, updatedAt: 0, isValid: false});
}

if (pOk) return p;
return PriceQuote({priceX36: 0, updatedAt: 0, isValid: false});
```

- **Why this closes `H-01`:** When `requireSecondaryCheck == true`, **any** secondary failure (stale past `secondaryMaxStaleness`, `isValid == false`, `observe()` revert, `cardinality < minCardinality`, or secondary price outside `[hardMinPriceX36, hardMaxPriceX36]`) causes `getPriceX36` to return `isValid: false` (fail closed), completely closing the `if (pOk && !sOk) return p;` bypass.
- **Why this closes `L-04`:**
  1. `secondaryMaxStaleness` decouples slower secondary feeds (e.g., future Chainlink or 30m V3 TWAP) from the primary `30s` `maxStaleness`.
  2. `Math.mulDiv(diff, BPS_DENOMINATOR, minP)` eliminates 256-bit intermediate overflow (`diff * 10_000`), and the pre-check guarantees `getPriceX36` returns `isValid: false` instead of reverting on extreme values.
  3. Companion hardening in `UniswapV3TwapOracle.sol`: migrate `immutable admin` to `Ownable2Step` and require `minCardinality >= 2` in `setPoolConfig()` (closing `L-04` item #2).

### 5.2 Exact Decimal-Aware Mainnet Parameters (HashKey Chain `177`)

From [`CommitmentManager.sol#L520`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L520), `grossPayment = Math.mulDiv(fillAmount, effPriceX36, 1e36, Math.Rounding.Ceil)`. Therefore:

$$\text{priceX36} = P_{\text{human}} \times \frac{10^{\text{payDec}}}{10^{\text{invDec}}} \times 10^{36}$$

Verified mainnet tokens & HSKSwap V3 pools ([`deployments/hashkey-mainnet.json`](file:///c:/Users/USER/Desktop/Tranche/deployments/hashkey-mainnet.json)):

| Parameter | `WHSK / USDT` | `WETH / USDT` | `WBTC / USDT` |
| --- | --- | --- | --- |
| **Inventory Token (`invDec`)** | `0xB210D2120d57b758EE163cFfb43e73728c471Cf1` (`18`) | `0xefd4bC9afD210517803f293ABABd701CaeeCdfd0` (`18`) | `0x6119CA49a79f5825C8B345F8d7aC36B272565b14` (`8`) |
| **Payment Token (`payDec`)** | `0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029` (`6`) | `0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029` (`6`) | `0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029` (`6`) |
| **Scale Factor (`10^(36 + payDec - invDec)`)** | `1e24` | `1e24` | `1e34` |
| **Observed Mainnet Spot (`VERIFIED`)** | `$0.080808` (`8.0808e22`) | `$1,704.04` (`1.70404e27`) | `$61,830.80` (`6.18308e38`) |
| **`hardMinPriceX36`** | **`3.0e22`** (`$0.03`) | **`7.0e26`** (`$700`) | **`2.5e38`** (`$25,000`) |
| **`hardMaxPriceX36`** | **`2.5e23`** (`$0.25`) | **`4.5e27`** (`$4,500`) | **`1.6e39`** (`$160,000`) |
| **`maxStaleness` (`SignedPullOracle`)** | `30` sec | `30` sec | `30` sec |
| **`SignedPullOracle.maxJumpBps`** | `500` (`5%`) | `300` (`3%`) | `300` (`3%`) |
| **`secondaryFeed`** | `UniswapV3TwapOracle` (`0x4ff515761864e7838b0adb8b5b2b8b7a068905dc`) | `address(0)` | `address(0)` |
| **V3 TWAP Pool Config** | `twapWindow = 1800`, `minCardinality = 100` *(live cardinality `240`)* | Disabled (`$83.7k` TVL, `1.94h` gap -> `~$15` TWAP-skew DoS) | Disabled (`$90.7k` TVL, `16.0h` gap -> false-positive & `~$15` DoS) |
| **`requireSecondaryCheck`** | **`true`** | **`false`** | **`false`** |
| **`secondaryMaxStaleness`** | `3600` sec | `0` | `0` |
| **`maxDeviationBps`** | **`500`** (`5%`) | `0` | `0` |
| **`allowSecondaryFallback`** | **`false`** | **`false`** | **`false`** |

**Defense Compensation on `WETH/USDT` & `WBTC/USDT`:** Because `secondaryFeed = address(0)` avoids thin-pool V3 TWAP DoS vectors (`$41.8k–$45.4k` USDT pool reserves), integrity on `WETH/USDT` and `WBTC/USDT` relies on:
1. **2-of-3 / 3-of-5 independent signer quorum**, each running its own off-chain aggregation across `>= 4` Tier-1 CEX orderbooks (Binance, OKX, Coinbase, Kraken) with live `USDT/USD` cross-rate conversion (`P_ASSET/USDT = P_ASSET/USD / P_USDT/USD`) and weighted-median outlier rejection ([`ORACLE_READINESS.md` §4](file:///c:/Users/USER/Desktop/Tranche/research/ORACLE_READINESS.md#L84-L105));
2. **Tight on-chain `maxJumpBps = 300`** (`3%` per update) and tight `hardMinPriceX36` / `hardMaxPriceX36`;
3. **Protocol Watchdog + `guardian` fast circuit breaking** (`revokePrice` + `setFloatingExercisePaused(true)`).

---

## 6. Key Rotation & Chainlink Data Streams Evaluation

### 6.1 Zero-Downtime Signer Key Rotation (`addSigner` -> `removeSigner`)

#### Routine Key Rotation (Zero `FLOATING` Downtime)
Assume active `threshold = 2`, `signerCount = 3` (`{S_1, S_2, S_3}`), rotating `S_1 -> S_4`:
1. **Provision & Verify:** Create `S_4` in an isolated hardware KMS / co-signer boundary (`ECC_SECG_P256K1`, zero HSK gas balance). Verify its Ethereum address offline.
2. **Expand Quorum (`addSigner`):** `owner` multisig calls `SignedPullOracle.addSigner(S_4)`. State transitions cleanly to `threshold = 2, signerCount = 4` (`{S_1, S_2, S_3, S_4}`). Existing `{S_1, S_2, S_3}` continue pushing `PriceReport`s every `15s` with **zero interruption**.
3. **Cut Over Off-Chain Signing:** Enable `S_4` in the signing pipeline (sorting `signatures[]` by ascending signer address) and confirm `>= 10` consecutive `PriceUpdated` transactions succeed on-chain using `{S_2, S_4}` or `{S_3, S_4}`.
4. **Retire Old Key (`removeSigner`):** `owner` multisig calls `SignedPullOracle.removeSigner(S_1)`. Because `signerCount - 1 = 3 >= threshold (2)`, `removeSigner` succeeds cleanly, returning to `threshold = 2, signerCount = 3` (`{S_2, S_3, S_4}`).
5. **Decommission:** Revoke/schedule deletion on `S_1` KMS key.

#### Emergency Compromise Containment & Recovery
If `S_compromised` leaks (or anomalous prices appear on-chain):
1. **T+0 (`guardian` single-tx containment):** Call `CommitmentManager.setFloatingExercisePaused(true)` and `SignedPullOracle.revokePrice(inv, pay)` for affected pairs. Active `FLOATING` exercises halt immediately; `FIXED` exercises and `reclaimExpired()` remain 100% live (`INV-8`).
2. **T+1 (`owner` multisig):**
   - If `signerCount > threshold`: call `removeSigner(S_compromised)` directly.
   - If `signerCount == threshold`: call `addSigner(S_new)` (or temporarily `setThreshold(threshold - 1)` only if `threshold > 1` and healthy quorum remains), then `removeSigner(S_compromised)`.
3. **T+2 (Re-anchor & Resume):** Remaining healthy quorum signs a fresh `PriceReport` with `reportTimestamp = min(utcNow - 2, latestBlock.timestamp)` strictly `> prev.updatedAt` (waiting `2s` / 1 block if the compromised update landed in the current block). Submit `updatePrice(...)`; `maxJumpBps` allows clean re-anchoring because `revokePrice()` set `priceX36 = 0`. Verify `OraclePriceAdapter.getPriceX36()` returns `isValid = true`, then call `CommitmentManager.setFloatingExercisePaused(false)`.

### 6.2 Honest Evaluation of `ChainlinkDataStreamsVerifierProxy` (`0x3278...Cd54`)

#### Verified On-Chain Facts (`deployments/hashkey-mainnet.json` L413–425)
- **Address:** `0x3278e7a582B94d82487d4B99b31A511CbAe2Cd54` (`code_bytes = 7009`, `typeAndVersion() = "VerifierProxy 2.0.0"`).
- **Owner:** `0x322Bf463D776FF83e43fe5c281E619eFB9277719`.
- **Fee Manager:** `s_feeManager() = 0x0000000000000000000000000000000000000000` (no fee manager wired on chain `177` at inspection time).
- **Verifier Routing:** `s_verifier()` reverted (consistent with `VerifierProxy 2.0.0` routing by `configDigest`).

#### Unverified / Blocking Gaps on HashKey Chain (`177`)
1. **Credential Gating (`BLOCKED/UNVERIFIED`):** Chainlink Data Streams REST/WebSocket endpoints require partner-provisioned API keys and HMAC-SHA256 authentication. No credentials exist in this repository.
2. **Unverified Feed IDs (`BLOCKED/UNVERIFIED`):** No Chainlink Data Streams `feedId` (`bytes32`) has been verified on chain `177` for `WHSK/USDT` (or `HSK/USD`), `WETH/USDT`, or `WBTC/USDT`, and no `verify()` transaction has been executed against `0x3278...Cd54`.
3. **Interface Incompatibility (`VERIFIED`):**
   - `IPriceOracle.getPriceX36(address, address)` ([`IProtocol.sol#L191-L194`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/interfaces/IProtocol.sol#L191-L194)) and `CommitmentManager._resolveFloatingPrice()` ([`CommitmentManager.sol#L524-L544`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L524-L544)) are **`view`**.
   - `IVerifierProxy.verify(bytes calldata payload, bytes calldata parameterPayload)` is **non-`view`** (state-mutating: validates DON BLS/ECDSA signatures via the `configDigest`-mapped `Verifier` and interacts with `s_feeManager` if ever configured).

#### Target Adapter Design (`ChainlinkDataStreamsOracle.sol`) — Post-Provisioning Phase
Once Chainlink Labs provisions chain `177` feed IDs and API credentials, integration requires a dedicated caching adapter implementing `IPriceOracle`:
- **Storage:** `IVerifierProxy public immutable verifierProxy`, `Ownable2Step`, `guardian`, `uint32 public maxPriceAge`, `mapping(bytes32 => FeedConfig)` (`bytes32 feedId`, `uint8 reportDecimals`, `uint8 invDecimals`, `uint8 payDecimals`), `mapping(bytes32 => StoredPrice) internal _prices`, `mapping(bytes32 => uint16) public maxJumpBps`.
- **State-Mutating Ingestion (`submitReport`):**
  ```solidity
  function submitReport(
      address inventoryToken,
      address paymentToken,
      bytes calldata signedReport,
      bytes calldata parameterPayload
  ) external payable
  ```
  1. Calls `bytes memory verified = verifierProxy.verify{value: msg.value}(signedReport, parameterPayload);`.
  2. Decodes Chainlink `ReportV3` (`feedId`, `validFromTimestamp`, `observationsTimestamp`, `nativeFee`, `linkFee`, `expiresAt`, `price`, `bid`, `ask`).
  3. Validates `feedId == cfg.feedId`, `price > 0`, `observationsTimestamp <= block.timestamp`, `block.timestamp <= expiresAt`, `observationsTimestamp > prev.updatedAt`, and optional `maxJumpBps` (with `revokePrice` override).
  4. Converts `int192 price` (`18`-decimal Data Streams precision) to `priceX36` scaled by `invDecimals` and `payDecimals`:
     $$\text{priceX36} = \text{uint256}(\text{uint192}(\text{price})) \times \frac{10^{36 + \text{payDec}}}{10^{\text{reportDec} + \text{invDec}}}$$
  5. Stores `StoredPrice({priceX36: priceX36, updatedAt: observationsTimestamp})`.
- **`view` Consumption (`getPriceX36`):** Enforces `maxPriceAge` identically to `SignedPullOracle`, allowing `OraclePriceAdapter` and `CommitmentManager` to consume verified Data Streams reports with **zero changes to `CommitmentManager` or `LiquidityVault`**.
- **Gas & Fee Considerations:** `submitReport` incurs `VerifierProxy.verify()` cross-contract call + DON signature verification gas on every heartbeat (`~120k–200k+` gas vs `~70k–85k` for 2-of-3 `SignedPullOracle`), and if `VerifierProxy.s_feeManager` is later populated, `submitReport` must either forward `parameterPayload` / native `HSK` fees or approve `LINK` (`0x71052BAe71C25C78E37fD12E5ff1101A71d9018F`).

#### Phase 2 Production Verdict
`SignedPullOracle` with **M-of-N threshold quorum + `maxPriceAge` + `maxJumpBps` + `revokePrice`**, paired with the **`OraclePriceAdapter` (`H-01` + `L-04` fixes + exact mainnet bounds)** and **`CommitmentManager.setFloatingExercisePaused()`**, is the **only verified, deployable Phase 2 production path** for HashKey Chain (`177`). Once Chainlink provisions chain `177` feed IDs and API credentials, `OraclePriceAdapter.owner()` can deploy `ChainlinkDataStreamsOracle` and switch `primaryFeed` via `setPairConfig()` without migrating vault custody.

---

## 7. Downstream Phase 3 Implementation Surface (For Reference Only)

When Phase 3 implementation is authorized (not modified in this design step), the following files will be impacted by the interfaces above:
1. **Smart Contracts:** `contracts/src/adapters/SignedPullOracle.sol`, `contracts/src/adapters/OraclePriceAdapter.sol`, `contracts/src/adapters/UniswapV3TwapOracle.sol`, `contracts/src/CommitmentManager.sol`, `contracts/src/interfaces/IProtocol.sol` (if `setFloatingExercisePaused` / `setGuardian` exposed on `ICommitmentManager`).
2. **Tests:** Existing test suites constructing `SignedPullOracle` or calling `updatePrice(..., bytes)` / `setPairConfig(...)` (`ProtocolAdversarial.t.sol`, `HashKeyForkPrototype.t.sol`, `SecurityAuditPoC.t.sol`, `BaselineDefectPoC.t.sol`) plus new negative/adversarial tests for M-of-N quorum, unsorted/duplicate signer rejection, `maxPriceAge`, `maxJumpBps`, `revokePrice`, `setFloatingExercisePaused`, and `H-01` fail-closed behavior.
3. **TypeScript SDK & Demo:** `sdk/src/deploy.ts`, `sdk/src/client.ts` (`signAndUpdatePullOraclePrice` EIP-712 domain version & `bytes[]` signature array), `sdk/src/errors.ts`, and `demo/src/engine.ts`.
