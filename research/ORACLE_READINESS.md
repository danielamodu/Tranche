# Tranche — Oracle Readiness & Risk Analysis (Phase 1, Workstream B)

> **Baseline Commit:** `f5d61e76134fd3badc831d10136318431aabd413` (`main`) — Frozen read-only inspection  
> **Target Network:** HashKey Chain Mainnet (OP Stack L2, Chain ID `177`, RPC `https://mainnet.hsk.xyz`)  
> **Target Pairs:** `WHSK/USDT`, `WETH/USDT`, `WBTC/USDT`  
> **Companion Document:** [`OPERATIONS_ARCHITECTURE.md`](file:///c:/Users/USER/Desktop/Tranche/research/OPERATIONS_ARCHITECTURE.md)

### Evidence Classification Standard

Every claim in this document is explicitly tagged:
- **`VERIFIED`**: Directly observed in frozen repository contracts/tests/configs or live chain `177` RPC outputs recorded in [`INFRASTRUCTURE_AUDIT.md`](file:///c:/Users/USER/Desktop/Tranche/research/INFRASTRUCTURE_AUDIT.md) and [`deployments/hashkey-mainnet.json`](file:///c:/Users/USER/Desktop/Tranche/deployments/hashkey-mainnet.json).
- **`ESTIMATED`**: Derived mathematically from `VERIFIED` on-chain parameters (e.g., `priceX36` decimals, V3 swap/TWAP manipulation costs, gas USD costs).
- **`ASSUMED`**: Operational or off-chain assumptions not verified via on-chain RPC (e.g., CEX API liquidity/availability, private RPC vendor availability, KMS latency).
- **`BLOCKED/UNVERIFIED`**: External dependencies, credentials, or on-chain artifacts that are missing, unreachable, or unconfirmed for mainnet launch.

---

## 1. Executive Readiness Verdict

| Component / Mode | Readiness Classification | Summary |
| --- | --- | --- |
| **`FIXED` Strike Commitments** | **`VERIFIED` Ready** | `CommitmentManager` `FIXED` reservations and exercises (`_quoteReservation` L494, `_quoteExercise` L512) and `reclaimExpired` (L420–451) have **zero dependency** on `IPriceOracle`. |
| **`SignedPullOracle` (Primary `FLOATING` Feed)** | **Centralized Trusted Signer — Conditional** | **Not decentralized.** Single EOA/KMS `authorizedSigner` and immutable `admin`. Usable for controlled mainnet launch **only** with HSM/KMS key custody, tight per-pair `OraclePriceAdapter` hard bounds, multisig `admin` deployment, and active monitoring. |
| **`OraclePriceAdapter` + `UniswapV3TwapOracle`** | **`BLOCKED/UNVERIFIED` (Config Fixes Required)** | Frozen test config (`1e18..1e27`, `maxDeviationBps = 500`) **breaks `WETH/USDT` and `WBTC/USDT`**, `pOk && !sOk` silently bypasses secondary checks, and thin V3 pools (`$83.7k–$90.7k` TVL) expose `WETH/WBTC` to ~$15 TWAP-divergence DoS. |
| **Chainlink Data Streams (`VerifierProxy 2.0.0`)** | **`BLOCKED/UNVERIFIED`** | Contract `0x3278...Cd54` is `VERIFIED` live, but feed IDs (`WHSK`, `WETH`, `WBTC`), API credentials, and a stateful `IPriceOracle` adapter contract are absent in the frozen commit. |
| **Public Push Feeds (Chainlink Push / Pyth / RedStone / API3 / Chronicle)** | **`BLOCKED/UNVERIFIED` (`NOT_FOUND`)** | Zero bytecode (`0x`) at all checked deterministic addresses on chain `177` (`VERIFIED`). |

---

## 2. `SignedPullOracle` Design & Single-Signer Trust Model

Source inspected: [`SignedPullOracle.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/SignedPullOracle.sol) (`L1–L89`).

### 2.1 Exact Trust Model (`VERIFIED`)
- **Explicit Centralization:** `SignedPullOracle` is a **trusted single-signer oracle**, not a decentralized oracle network. Price integrity rests entirely on the off-chain aggregator and the private key corresponding to `authorizedSigner`.
- **Roles & Mutability:**
  - `address public immutable admin` (L30): Set once to `msg.sender` in constructor (L42). **Cannot be transferred or renounced.** If deployed from a personal EOA rather than a multisig, governance cannot be upgraded later.
  - `address public authorizedSigner` (L31): Single address checked via `ECDSA.recover` (L69–70). Updated in a single step by `admin` via `setAuthorizedSigner(address _signer)` (L46–51).
- **Signature Domain (`VERIFIED`):** Uses OpenZeppelin `EIP712("ProtocolSignedPullOracle", "1")` (L40) and `PRICE_REPORT_TYPEHASH = keccak256("PriceReport(address inventoryToken,address paymentToken,uint256 priceX36,uint256 reportTimestamp)")` (L26–28), binding signatures to `chainId = 177` and `verifyingContract = address(pullOracle)`.
- **Permissionless Submission:** `updatePrice(...)` (L53–74) has **no `msg.sender` restriction**; any caller holding a valid `authorizedSigner` signature can push the report on-chain.

### 2.2 Key Compromise Blast Radius (`VERIFIED`)
If `authorizedSigner` is compromised, the attacker can sign arbitrary `PriceReport` payloads for **any** `(inventoryToken, paymentToken)` pair with any `priceX36 > 0` and `reportTimestamp <= block.timestamp` strictly greater than `_prices[pairKey].updatedAt`.

| Deployment Topology | Attacker Capability Upon `authorizedSigner` Compromise | Financial / Liveness Impact |
| --- | --- | --- |
| **Direct `SignedPullOracle` (`offer.oracle == pullOracle`) or `OraclePriceAdapter` when `!sOk`** | Set any `priceX36` within `[hardMinPriceX36, hardMaxPriceX36]` (or `1 .. type(uint256).max` if direct/unbounded). | **Critical:** Attacker exercises active `FLOATING` tickets (or reserves + exercises new ones) at `hardMinPriceX36` (e.g., `$0.000001` if `1e18` is used on WHSK), draining 100% of LP `inventoryToken` for dust `USDT` unless LP set `Offer.minPriceX36 > 0`. |
| **`OraclePriceAdapter` with healthy `secondaryFeed` (`sOk == true`) and `maxDeviationBps = 500`** | Push `priceX36` skewed up to `-500 bps` (`-5%`) below secondary TWAP (if LP sold base), or `> 500 bps` away to fail `maxDeviationBps`. | **High:** Guaranteed `~4.76%–5.0%` mispriced extraction on all active `FLOATING` tickets with `minPriceX36 == 0`, OR complete DoS (`OracleUnavailable()`) of `FLOATING` reservations and exercises. |
| **Note on LP-level defense (`CommitmentManager.sol`)** | `Offer.minPriceX36` / `maxPriceX36` are snapshotted into `Ticket.fixedOrMinPriceX36` / `maxPriceX36` at `reserve()` (L290–291). | If an LP sets `minPriceX36 = 0` (as in [`HashKeyForkPrototype.t.sol#L188`](file:///c:/Users/USER/Desktop/Tranche/contracts/test/HashKeyForkPrototype.t.sol#L188)), the LP has **zero ticket-level floor protection**. |

### 2.3 Missing Defenses in `SignedPullOracle.sol` (`VERIFIED`)
1. **No M-of-N Threshold / Quorum:** Only one `authorizedSigner` exists (L31, L70). Compromising one key compromises the entire feed; there is no 2-of-3 / 3-of-5 signer set or MPC threshold enforcement on-chain.
2. **No Per-Update Max-Jump Guard:** `updatePrice` checks only `priceX36 == 0` (L60). A report can jump `1000x` or drop `99.99%` in a single update relative to `_prices[pairKey].priceX36`.
3. **Strict Timestamp Monotonicity & Mempool Front-Running Hazards:**
   - L61: `if (reportTimestamp > block.timestamp) revert FutureTimestamp();`
   - L64: `if (reportTimestamp <= _prices[pairKey].updatedAt) revert StaleTimestamp();`
   - **Concurrent / JIT Update Collision:** Because `updatePrice` is permissionless and strictly monotonic (`<=`), if an actor (or daemon) submits `updatePrice(..., ts = 102, sig2)` ahead of a user's/relayer's `updatePrice(..., ts = 100, sig1)`, the `ts = 100` call **reverts with `StaleTimestamp()`**. Any atomic bundle (e.g., smart-account `Multicall`) that does not allow `updatePrice` failure will abort the whole user transaction.
   - **Clock-Skew Revert (`FutureTimestamp`):** Because HashKey Chain advances `block.timestamp` in discrete `2.0s` increments (`VERIFIED`), signing with wall-clock `Date.now()` when local NTP is even `1s` ahead of the latest L2 block causes `reportTimestamp > block.timestamp` and reverts `FutureTimestamp()`.
   - **Latency Sandwich (`T1.3`):** An attacker observing a favorable pending `updatePrice` in the mempool (`ASSUMED` mempool visibility) can front-run it by calling `CommitmentManager.exercise()` against the pre-update `_prices[pairKey]` before the new price mines.
4. **No Pair-Level Circuit Breaker, Pause, or `revokePrice()`:** `SignedPullOracle` has no pause flag and no `revokePrice(inv, pay)` method. Rotating `authorizedSigner` via `setAuthorizedSigner` does **not** invalidate the last written `_prices[pairKey]`, which remains readable (`isValid: true`) in `SignedPullOracle` indefinitely and in `OraclePriceAdapter` for up to `maxStaleness`. Furthermore, if an attacker pushed a fraudulent price at `reportTimestamp = block.timestamp`, the legitimate operator **cannot overwrite it in the same block** because `reportTimestamp <= _prices[pairKey].updatedAt` reverts `StaleTimestamp()`; they must wait at least 1 block (`+2.0s`).

---

## 3. Chainlink Data Streams Readiness on HashKey Chain (`177`)

Sources inspected: [`INFRASTRUCTURE_AUDIT.md`](file:///c:/Users/USER/Desktop/Tranche/research/INFRASTRUCTURE_AUDIT.md) (§5), [`deployments/hashkey-mainnet.json`](file:///c:/Users/USER/Desktop/Tranche/deployments/hashkey-mainnet.json) (`L412–L458`), [`IProtocol.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/interfaces/IProtocol.sol) (`L184–L195`), [`CommitmentManager.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol) (`L524–L544`).

| Property | Status | Observed Evidence / Detail |
| --- | --- | --- |
| **`VerifierProxy` Deployment** | `VERIFIED` | Address `0x3278e7a582B94d82487d4B99b31A511CbAe2Cd54` on chain `177`; `code_bytes=7009`; `typeAndVersion() = "VerifierProxy 2.0.0"`. |
| **`VerifierProxy` Ownership & Fee Config** | `VERIFIED` | `owner() = 0x322Bf463D776FF83e43fe5c281E619eFB9277719`; `s_feeManager() = 0x0000000000000000000000000000000000000000` (no fee manager currently wired); `s_verifier()` reverted (`VerifierProxy 2.0.0` routes by `configDigest`). |
| **DON Report Payload Verification** | `VERIFIED` (architecture) / `BLOCKED/UNVERIFIED` (mainnet test) | Pull-based: off-chain caller must fetch a DON-signed report payload and call `VerifierProxy.verify(payload, parameterPayload)` on-chain. No end-to-end report verification has been executed on chain `177`. |
| **API Key / Credential Gating** | `BLOCKED/UNVERIFIED` | Chainlink Data Streams REST/WebSocket API requires provisioned enterprise/partner API keys and HMAC authentication. Not provisioned in this repository. |
| **Feed IDs (`WHSK/USDT`, `WETH/USDT`, `WBTC/USDT`)** | `BLOCKED/UNVERIFIED` | No Chainlink Data Streams feed IDs for chain `177` (especially `HSK/USDT` / `HSK/USD`) have been verified as live on Chainlink DONs. |
| **Other Push/Pull Oracles** | `VERIFIED` (`NOT_FOUND`) | Chainlink `AggregatorV3Interface` / `FeedRegistry`, Pyth (5 canonical addresses), RedStone, API3, and Chronicle all returned `0` bytes on chain `177`. |

### Architectural Incompatibility with Tranche's Current `IPriceOracle` (`VERIFIED`)
- `IPriceOracle.getPriceX36(address inventoryToken, address paymentToken)` ([`IProtocol.sol#L191-L194`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/interfaces/IProtocol.sol#L191-L194)) is declared **`external view`**, and `CommitmentManager._resolveFloatingPrice()` (`L531–532`) is `internal view`, making `quoteReservation`, `quoteExercise`, `reserve`, and `exercise` depend on a `view` state read.
- `VerifierProxy.verify(...)` is **state-mutating** (non-`view`, verifies DON signatures and may interact with `Verifier` / `FeeManager`) and requires an unverified `bytes` report argument not present in `getPriceX36(address, address)`.
- **Migration Path (Post-Frozen-Baseline):** Upgrading to Chainlink Data Streams requires deploying a new stateful periphery adapter (e.g., `ChainlinkDataStreamsOracle` implementing `IPriceOracle`) with a `submitReport(bytes calldata signedReport)` method that calls `VerifierProxy.verify(...)`, validates `feedId` and `observationsTimestamp`, converts 18-decimal report prices to `priceX36`, and caches the verified `StoredPrice` for `OraclePriceAdapter` to read via `getPriceX36()`. Because `OraclePriceAdapter` is stateless/swappable periphery (`ADR-011`) and `CommitmentManager` reads `Offer.oracle` / `Ticket.oracle`, **existing `Ticket`s already bound to the old `OraclePriceAdapter` address cannot migrate to a new `OraclePriceAdapter`**, though `OraclePriceAdapter.admin` *can* swap `primaryFeed` inside the existing `OraclePriceAdapter` via `setPairConfig()` once the new `ChainlinkDataStreamsOracle` is deployed!

---

## 4. Independent Price Sources & Off-Chain Aggregation Specification

Because `SignedPullOracle` is the active primary feed on frozen commit `f5d61e76`, off-chain price integrity must compensate for the lack of on-chain quorum.

### 4.1 Pair-Specific Venue & Liquidity Topology
- **`WETH/USDT` & `WBTC/USDT` (`ASSUMED` CEX depth; `VERIFIED` on-chain pool thinness):**
  - Target `>= 4` independent Tier-1 CEX orderbook WebSockets (e.g., Binance, OKX, Coinbase, Kraken — `[ASSUMED]` API access & pair availability).
  - **USDT Depeg Guard (`ESTIMATED`):** Venues quoting `/USD` (e.g., Coinbase, Kraken) must NOT assume `1 USDT = $1.00`. Convert via live `USDT/USD` reference:
    $$P_{\text{ASSET/USDT}} = \frac{P_{\text{ASSET/USD}}}{P_{\text{USDT/USD}}}$$
    This prevents mispricing Tranche `USDT` (`0xF1B5...9029`) settlements during stablecoin depeg events.
- **`WHSK/USDT` (`BLOCKED/UNVERIFIED` CEX orderbook depth):**
  - `HSK` has material **single-exchange concentration risk** (`HashKey Exchange` as primary venue `[ASSUMED]`, with secondary venues such as OKX/Gate/KuCoin `[UNVERIFIED]` pending live API depth audit).
  - Never rely on a single CEX API for `WHSK/USDT`. Require at least `>= 2` independent CEX feeds (or `1` primary CEX + `1` secondary CEX) **plus** an off-chain sanity check against HSKSwap V3 `WHSK/USDT` (`0x4ff5...`, `$839.2k` TVL `VERIFIED`).

### 4.2 Aggregation, Outlier Rejection & Fail-Closed Rules
1. **Quote Filtering:** Discard any venue quote whose exchange timestamp is `> 5s` old, whose bid-ask spread `(ask - bid) / mid` exceeds **`50 bps`** (`WETH`/`WBTC`) or **`150 bps`** (`WHSK`), or where `bid <= 0`.
2. **Weighted Median:** Compute mid-price $m_i = (b_i + a_i)/2$ (or top-of-book size-weighted micro-price) per healthy venue $i$, then take the **liquidity-tier-weighted median** $M$ (immune to single-venue flash wicks or API `0`/spike errors, unlike an arithmetic mean).
3. **Outlier Rejection:** Reject any venue $i$ with $|m_i - M| / M > 150\text{ bps}$ (`WETH`/`WBTC`) or $> 300\text{ bps}$ (`WHSK`), then recompute $M'$ from surviving venues.
4. **Quorum & Jump Gate (Fail-Closed Signing):**
   - **Minimum Quorum:** Halt signing (`do NOT call KMS`) if surviving venues `< 3` (`WETH`/`WBTC`) or `< 2` (`WHSK`).
   - **Off-Chain Max-Jump Circuit Breaker:** Because `SignedPullOracle.sol` lacks an on-chain per-update delta check, the aggregator/KMS policy MUST block or require manual/secondary-verifier confirmation if $|M' - P_{\text{prev}}| / P_{\text{prev}} > 300\text{ bps}$ within `30s` (or `> 1000 bps` overall).

---

## 5. Maximum Acceptable Price Age (`maxStaleness`) & L2 Sequencer Bounds

### 5.1 Evaluating `maxStaleness = 30s` Against HashKey Chain Timing
- **Block Cadence (`VERIFIED`):** Exact **`2.0000s`** per block across both 15-block (`30582904..30582918`) and 1,000,000-block (`29582918..30582918`) windows. Thus, `maxStaleness = 30s` equals **15 blocks**.
- **Latency & Clock-Skew Budget (`ESTIMATED`):**
  - Off-chain fetch + medianize + KMS sign: `~0.5–1.0s`
  - Safety backdate on `reportTimestamp`: **`-2s`** (or `min(utcNow - 2s, latestBlock.timestamp)`) to prevent `SignedPullOracle.FutureTimestamp()` reverts caused by discrete `2.0s` L2 block timestamps or sub-second NTP skew.
  - Transaction propagation + block inclusion: `2–4s` (`1–2` blocks).
  - Effective age upon inclusion: `~4.5–7.0s`.
  - With a **`15s` push heartbeat** (or `10s` when active `FLOATING` tickets exist), worst-case on-chain age right before refresh is **`~19.5–22.0s`**, leaving **`8–10.5s` (4–5 blocks)** of safety margin before `OraclePriceAdapter` (`block.timestamp - res.updatedAt > 30`) fails closed.

### 5.2 Adverse-Selection Toxicity Bounds (`VERIFIED` / `ESTIMATED` from [`ECONOMIC_MODEL.md`](file:///c:/Users/USER/Desktop/Tranche/research/ECONOMIC_MODEL.md) §8.1)
Expected toxic extraction per one-sided fill at `15 bps` spread (`KC-6` threshold `< 2.0 bps`):

| `maxStaleness` ($\tau$) | `WHSK` (`16.84%` RV) `@15 / @25 bps` | `WETH` (`61.09%` RV) `@15 / @25 bps` | `WBTC` (`75.65%` RV) `@15 / @25 bps` | Stressed `80%` Vol (`ASSUMED`) `@15 / @25 bps` | Verdict |
| --- | --- | --- | --- | --- | --- |
| **`10s`** | `0.00 / 0.00 bps` | `0.00 / 0.00 bps` | `0.00 / 0.00 bps` | `0.00 / 0.00 bps` | Ideal if RPC allows |
| **`30s` (Current)** | **`0.00 / 0.00 bps`** | **`0.01 / 0.00 bps`** | **`0.06 / 0.00 bps`** | **`0.08 / 0.00 bps`** | **Recommended (`<= 30s` + `>= 15–25 bps` spread)** |
| **`60s`** | `0.00 / 0.00 bps` | `0.13 / 0.00 bps` | `0.35 / 0.03 bps` | `0.44 / 0.04 bps` | Acceptable only as temporary RPC stress fallback |
| **`300s`** | `0.00 / 0.00 bps` | `2.28 / 0.81 bps` | `3.67 / 1.69 bps` | `4.11 / 2.00 bps` | **Unsafe** (breaches `KC-6`) |

**Recommendation:** Retain **`maxStaleness = 30s`** across all three pairs (paired with LP `spreadBps >= 15 bps` on `WHSK/USDT` and `>= 20–25 bps` on `WETH/USDT` and `WBTC/USDT`). Do **not** raise `maxStaleness` above `45s` on `WETH`/`WBTC`.

### 5.3 OP Stack L2 Sequencer Batching & Halting Risks
- **Missing Sequencer Uptime Feed (`VERIFIED` / `BLOCKED/UNVERIFIED`):** HashKey Chain is an OP Stack L2 (`L2StandardBridge` `0x4200...0010` `VERIFIED`), but **no L2 Sequencer Uptime Feed** (e.g., Chainlink `L2SequencerUptimeFeed`) is deployed or verified on chain `177`, and [`OraclePriceAdapter.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/OraclePriceAdapter.sol) contains no sequencer downtime grace period.
- **Behavior During Sequencer Halt & Restart (`VERIFIED` logic / `ESTIMATED` behavior):**
  1. **During Halt:** L2 block production freezes; no `reserve` or `exercise` transactions confirm.
  2. **At Restart:** L2 `block.timestamp` jumps to current wall-clock time. Pre-halt `SignedPullOracle` prices fail `block.timestamp - res.updatedAt > 30` in `OraclePriceAdapter._readAndValidate` (L87) and fail closed (`isValid = false`).
  3. **Restart Race Risk:** Because `OraclePriceAdapter` has no post-restart grace period, as soon as the daemon pushes a fresh post-restart `updatePrice` (or if an unmined signed report from `< 30s` ago exists), `FLOATING` execution resumes immediately into potentially dislocated post-outage orderbooks, while `UniswapV3TwapOracle.observe([1800, 0])` interpolates the frozen pre-halt tick across the outage window (which can falsely trip `maxDeviationBps` if CEX prices moved during the halt).
  4. **L1->L2 Forced Inclusion:** If an OP Stack `OptimismPortal` forced-inclusion tx were queued with stale expectations, `SignedPullOracle` `30s` staleness and `CommitmentManager` `maxPaymentIn` / `maxPremiumIn` protect against stale fills.

---

## 6. Deviation, Hard Bounds & Circuit-Breaker Analysis

Sources inspected: [`OraclePriceAdapter.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/OraclePriceAdapter.sol) (`L14–L94`), [`UniswapV3TwapOracle.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/UniswapV3TwapOracle.sol) (`L34–L101`).

### 6.1 Exact Code-Path Audit of `OraclePriceAdapter.sol` (`VERIFIED`)
In `getPriceX36` (L40–76):
1. Both `primaryFeed` and (if non-zero) `secondaryFeed` are checked via `_readAndValidate` (L78–94), which requires: `staticcall`/`view` does not revert, `res.isValid && res.priceX36 > 0`, `res.updatedAt <= block.timestamp`, `block.timestamp - res.updatedAt <= cfg.maxStaleness`, and `hardMinPriceX36 <= res.priceX36 <= hardMaxPriceX36` (when bounds > 0).
2. **If `pOk && sOk` (L56–63):** Computes `minP = min(p, s)`, `diff = |p - s|`. If `cfg.maxDeviationBps > 0 && (diff * 10_000) / minP > cfg.maxDeviationBps`, returns `isValid = false` (circuit breaker trips). Note the minor asymmetry of dividing by `minP` (`p=100, s=95` -> `526 bps` trips at `500`, whereas `p=100, s=105` -> `500 bps` passes).
3. **If `!pOk && cfg.allowSecondaryFallback && sOk` (L64–66):** Returns `s`.
   - **Mandatory Production Setting:** `allowSecondaryFallback` **MUST be `false`** for all three pairs when `secondaryFeed` is `UniswapV3TwapOracle`. Because `UniswapV3TwapOracle` returns `updatedAt: block.timestamp` (L97) regardless of when the last V3 swap occurred, `sOk` stays `true` even across `1.94h` (`WETH/USDT`) or `16.0h` (`WBTC/USDT`) zero-swap gaps (`VERIFIED` in `ECONOMIC_MODEL.md`), which would leak `12–25+ bps` staleness toxicity (`T1.2`) and expose thin pools to fallback manipulation.
4. **CRITICAL — Silent Bypass of Secondary Check (`if (pOk && !sOk) return p;`, L67–70):**
   - If `secondaryFeed` reverts, fails `cardinality < minCardinality` (`UniswapV3TwapOracle` L78), fails `observe()` (L98), OR returns a price **outside `[hardMinPriceX36, hardMaxPriceX36]`** (L88–89), then `sOk == false`, and `OraclePriceAdapter` **silently bypasses `maxDeviationBps` and returns `p` directly!**
   - **Dual Implication:**
     - *Good for liveness against TWAP DoS:* An attacker who pushes the thin V3 TWAP past `hardMaxPriceX36` cannot indefinitely DoS `p` via `maxDeviationBps` (though they can still push TWAP *just* `501 bps` within `[hardMin, hardMax]` to cause a DoS!).
     - *Severe security gap under `authorizedSigner` compromise:* If an attacker compromises `SignedPullOracle` **and** simultaneously breaks/skews `secondaryFeed` outside `[hardMin, hardMax]` (or if a newly listed pool has `observationCardinality < minCardinality`), the cross-feed deviation guard **vanishes silently**, leaving only `[hardMinPriceX36, hardMaxPriceX36]`.

### 6.2 CRITICAL BUG RISK: `hardMinPriceX36` / `hardMaxPriceX36` Bounds Must Be Tight Per Pair
In [`ProtocolAdversarial.t.sol#L214-L215`](file:///c:/Users/USER/Desktop/Tranche/contracts/test/ProtocolAdversarial.t.sol#L214-L215) and [`HashKeyForkPrototype.t.sol#L78-L79`](file:///c:/Users/USER/Desktop/Tranche/contracts/test/HashKeyForkPrototype.t.sol#L78-L79), tests used `hardMinPriceX36 = 1e18` and `hardMaxPriceX36 = 1e27`.

Using `priceX36 = (humanPrice * 10^payDec / 10^invDec) * 1e36` (`ESTIMATED` from `VERIFIED` token decimals and snapshot spot prices in `ECONOMIC_MODEL.md`):

| Pair (`invDec / payDec`) | Observed Mainnet Spot (`VERIFIED`) | Exact `priceX36` (`ESTIMATED`) | Result if Test Placeholder `1e18..1e27` Used | Recommended Tight Production Bounds (`[0.4x .. 2.5x]` Spot, `ESTIMATED`) |
| --- | --- | --- | --- | --- |
| **`WHSK/USDT`** (`18 / 6`) | `$0.080808` | `8.0808e22` | `$0.000001 .. $1,000` (**12,375x upside slack** — near-useless guard!) | `hardMin`: `3.0e22` (`$0.03`), `hardMax`: `2.5e23` (`$0.25`) |
| **`WETH/USDT`** (`18 / 6`) | `$1,704.04` | `1.70404e27` | **FAILS IMMEDIATELY (`1.704e27 > 1e27`)** — every valid WETH quote rejected! | `hardMin`: `7.0e26` (`$700`), `hardMax`: `4.5e27` (`$4,500`) |
| **`WBTC/USDT`** (`8 / 6`) | `$61,830.80` | `6.18308e38` | **FAILS IMMEDIATELY (`6.18e38 >> 1e27`)** — off by 11 orders of magnitude! | `hardMin`: `2.5e38` (`$25,000`), `hardMax`: `1.6e39` (`$160,000`) |

*(Note: Bounds should be reviewed weekly/monthly by multisig `admin` via `setPairConfig()` as spot regimes shift, keeping `[0.4x, 2.5x]` or tighter `[0.5x, 2.0x]` around prevailing spot.)*

### 6.3 `UniswapV3TwapOracle` Manipulation Cost & Secondary Feed Suitability (`$83.5k`–`$839k` Pools)
All three HSKSwap V3 pools hold **100.00% of active liquidity in full-range `[-887220, +887220]`** (`VERIFIED` in `ECONOMIC_MODEL.md` §4), which behaves as standard $x \cdot y = k$ constant-product liquidity. Pushing spot price up by factor $m$ requires net USDT input $\Delta Y = Y(\sqrt{m} - 1)$ (plus `0.30%` pool fee).

| Pool | Verified TVL / USDT Reserve | Mean Inter-Swap Gap (`VERIFIED`) | Spot `+10.25%` ($\sqrt{m}=1.05$) Capital + `0.30%` Fee (`ESTIMATED`) | 30-Min (`1800s`) TWAP `+500 bps` DoS Attack Feasibility (`ESTIMATED`) | Secondary Circuit-Breaker Recommendation |
| --- | --- | --- | --- | --- | --- |
| **`WHSK/USDT`** (`0x4ff5...`) | `$839.2k` TVL / `$419,573` USDT | `19.2 min` (`74.8` swaps/d) | `~$20,979` capital (`$62.94` 1-way fee) | Requires holding `+10.25%` skew for `~15 min` against arbitrageurs (or `~$419k+` single-block skew); moderately costly. | **Enable** as secondary breaker (`twapWindow = 1800`, `minCardinality = 100`, `maxDeviationBps = 500`, `allowSecondaryFallback = false`). |
| **`WETH/USDT`** (`0xb92b...`) | `$83.7k` TVL / `$41,838` USDT | **`1.94 hours`** (`12.4` swaps/d) | **`~$2,092`** capital (`$6.28` 1-way fee) | **Cheap DoS vector:** Because arb bots average `1.94h` between swaps, holding a `+$2.1k` skew for 15 min shifts 30m TWAP by `+500 bps` (`~$12.60` round-trip fee) and **DoS-es all `WETH/USDT` `FLOATING` tickets!** | **Do NOT use `maxDeviationBps = 500` against this pool** (`secondaryFeed = address(0)` or wide `maxDeviationBps >= 1500` cataclysmic guard only, while tightening `SignedPullOracle` KMS + off-chain quorum). |
| **`WBTC/USDT`** (`0xd9ea...`) | `$90.7k` TVL / `$45,352` USDT | **`16.0 hours`** (`1.5` swaps/d) | **`~$2,268`** capital (`$6.80` 1-way fee) | **Trivial DoS + False-Positive Vector:** `16h` mean gap means legitimate CEX moves of `> 5%` occur before any on-chain swap updates TWAP, falsely tripping `maxDeviationBps = 500`! | **Do NOT use `maxDeviationBps = 500` against this pool** (`secondaryFeed = address(0)` or `maxDeviationBps >= 1500` cataclysmic guard only). |

---

## 7. Signer Compromise, Key Rotation & Pre-Mainnet Readiness Checklist

### 7.1 Exact Contract Gaps on Key Rotation (`VERIFIED`)
1. **`immutable admin` on All Oracle Contracts:** `SignedPullOracle.admin` (L30), `UniswapV3TwapOracle.admin` (L27), and `OraclePriceAdapter.admin` (L24) are all `immutable` with zero ownership transfer. **Blocker if deployed by EOA:** Deploying with a hot EOA permanently locks protocol oracle governance to a single key. Must deploy via multisig (e.g., Gnosis Safe).
2. **Single-Step `setAuthorizedSigner` & Zero Timelock:** No two-step `acceptSigner` pattern; a typo breaks `SignedPullOracle` until `admin` calls `setAuthorizedSigner` again. Zero timelock enables fast incident rotation, but means a compromised `admin` multisig can instantaneously swap `authorizedSigner` or `primaryFeed`.
3. **No `revokePrice` / Emergency Pair Freeze on `SignedPullOracle`:** Must use `OraclePriceAdapter.setPairConfig()` as the emergency circuit-breaker (setting `hardMinPriceX36 = 1, hardMaxPriceX36 = 1`, which passes `hardMin <= hardMax` on L34 and rejects every realistic price on L89) — which only works if offers point to `OraclePriceAdapter` rather than `SignedPullOracle` directly.

### 7.2 Mandatory Pre-Mainnet Oracle Blockers & Checklist

| # | Requirement | Status on Frozen Commit | Owner / Action |
| --- | --- | --- | --- |
| **O-1** | Deploy `SignedPullOracle`, `UniswapV3TwapOracle`, `OraclePriceAdapter` from a **multisig** (`admin`), NOT a single EOA | `BLOCKED/UNVERIFIED` (no mainnet deployment yet) | Deployment Ops |
| **O-2** | Provision HSM / Cloud KMS (`ECC_SECG_P256K1`) for `authorizedSigner`, separated from hot relayer EOA | `BLOCKED/UNVERIFIED` | Infra / Security |
| **O-3** | Configure tight per-pair `hardMinPriceX36` / `hardMaxPriceX36` (fix `1e18..1e27` bug on `WETH`/`WBTC`) | `BLOCKED/UNVERIFIED` | Oracle Ops |
| **O-4** | Set `allowSecondaryFallback = false` on all pairs; disable tight (`500 bps`) V3 TWAP breaker on `WETH`/`WBTC` (`1.94h`/`16h` gaps) | `BLOCKED/UNVERIFIED` | Oracle Ops |
| **O-5** | Verify live `WHSK/USDT` CEX orderbook depth across `>= 2` exchanges + `USDT/USD` cross-rate feed | `BLOCKED/UNVERIFIED` | Quant / Oracle Ops |
| **O-6** | Enforce off-chain max-jump cap (`300 bps / 30s`) & `reportTimestamp = min(utcNow - 2s, latestBlock.ts)` | `BLOCKED/UNVERIFIED` | Oracle Daemon |
| **O-7** | (Post-MVP upgrade path) Build & audit `ChainlinkDataStreamsOracle` or M-of-N `SignedPullOracleV2` once Chainlink feed IDs & API keys are confirmed | `BLOCKED/UNVERIFIED` | Contracts + Chainlink |
