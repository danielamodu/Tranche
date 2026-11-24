# Tranche — Operations, Keeper & Incident Architecture (Phase 1, Workstream B)

> **Baseline Commit:** `f5d61e76134fd3badc831d10136318431aabd413` (`main`) — Frozen read-only inspection  
> **Target Network:** HashKey Chain Mainnet (OP Stack L2, Chain ID `177`, `2.0000s` block time, `500.001 gwei` observed gas price)  
> **Companion Document:** [`ORACLE_READINESS.md`](file:///c:/Users/USER/Desktop/Tranche/research/ORACLE_READINESS.md)

### Evidence Classification Standard
- **`VERIFIED`**: Directly observed in frozen repository contracts/tests/configs or live chain `177` RPC outputs in [`INFRASTRUCTURE_AUDIT.md`](file:///c:/Users/USER/Desktop/Tranche/research/INFRASTRUCTURE_AUDIT.md) and [`deployments/hashkey-mainnet.json`](file:///c:/Users/USER/Desktop/Tranche/deployments/hashkey-mainnet.json).
- **`ESTIMATED`**: Derived mathematically from `VERIFIED` parameters (e.g., gas USD cost at `500.001 gwei` and `$0.080808` WHSK, keeper batch sizing).
- **`ASSUMED`**: Infrastructure/vendor assumptions not yet provisioned or verified on chain `177` (e.g., AWS/GCP KMS, private RPC failover node, PagerDuty/Slack alerting).
- **`BLOCKED/UNVERIFIED`**: Missing operational infrastructure, credentials, or external endpoints required before mainnet launch.

---

## 1. Operational Readiness Summary

| Subsystem | Status | Key Constraint / Blocker |
| --- | --- | --- |
| **RPC Connectivity** | `BLOCKED/UNVERIFIED` | Public `https://mainnet.hsk.xyz` triggers **HTTP `429` on bursts**, rejects `eth_getLogs >= 10,000` blocks (`HTTP 400`), rejects large `Multicall3` payloads (`HTTP 413`), and HSKSwap subgraph DNS fails (`VERIFIED`). Dedicated secondary RPC not yet provisioned (`ASSUMED`). |
| **Oracle Push Daemon** | `BLOCKED/UNVERIFIED` | No production daemon deployed yet; requires Cloud KMS/HSM (`authorizedSigner`), separate gas relayers, and CEX WebSocket aggregators (`ORACLE_READINESS.md` §4). |
| **Expiry Keeper (`reclaimExpired`)** | `BLOCKED/UNVERIFIED` | Permissionless on-chain (`VERIFIED`), but production keeper service + event/ID indexer (`<= 2,000`-block log windows + `Multicall3`) not yet deployed. |
| **Emergency Pause & Governance** | **Critical Architectural Gap** | `guardian` can pause deposits (`LiquidityVault.setDepositsPaused`) and new reservations (`CommitmentManager.setNewReservationsPaused`), but **cannot pause `exercise()` on active `FLOATING` tickets** and has **zero control over `SignedPullOracle` / `OraclePriceAdapter`**. `CommitmentManager` also lacks a `setGuardian()` setter (`VERIFIED`). |

---

## 2. Price Update Submission Infrastructure

### 2.1 Push Daemon vs. JIT Pull-in-Transaction (`VERIFIED` Contract Constraints)
We evaluated two submission models against the frozen contracts ([`SignedPullOracle.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/adapters/SignedPullOracle.sol), [`ExecutionRouter.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/ExecutionRouter.sol), [`CommitmentManager.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol)):

1. **Why Pure JIT Pull via `ExecutionRouter` or `Multicall3` Does NOT Work Out-of-the-Box on Frozen Commit `f5d61e76` (`VERIFIED`):**
   - [`ExecutionRouter.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/ExecutionRouter.sol) (`L65–L131`) has **no `updatePrice` hook** in `batchExercise()`; it only calls `manager.exercise(...)`.
   - Canonical [`Multicall3`](file:///c:/Users/USER/Desktop/Tranche/deployments/hashkey-mainnet.json#L28-L38) (`0xcA11bde05977b3631167028862be2a173976ca11`) changes `msg.sender` to `Multicall3`! Because `CommitmentManager.reserve()` pulls reservation premiums from `msg.sender` (`L296`) and `CommitmentManager.exercise()` verifies `ticketNft.isAuthorized(msg.sender, ticketId)` (`L312`) and pulls `paymentToken` from `msg.sender` (`L357`), users **cannot** safely batch `[pullOracle.updatePrice, manager.reserve/exercise]` through shared `Multicall3` without pre-funding/approving a permissionless shared contract (unsafe!).
   - **Timestamp Collision Hazard:** Because `SignedPullOracle.updatePrice()` rejects `reportTimestamp <= _prices[pairKey].updatedAt` with `StaleTimestamp()` (`L64`), two concurrent JIT bundles (or a push daemon + JIT user tx) carrying timestamps `ts1 <= ts2` will cause the second-mined tx to **revert**, unless `updatePrice` is separated into an independent prior tx or wrapped with `allowFailure = true` inside a user-owned smart account.

2. **Recommended Hybrid Architecture (Primary Push Daemon + Optional Pre-Tx Relay):**
   - **Primary Mechanism — Push Daemon:** Maintains warm on-chain prices in `SignedPullOracle` for `WHSK/USDT`, `WETH/USDT`, and `WBTC/USDT` so `CommitmentManager.quoteReservation()` / `quoteExercise()` (`view`) and standard EOA `reserve()` / `exercise()` / `ExecutionRouter.batchExercise()` succeed in 1 transaction.
     - **Cadence:** Push whenever **either** `|P_cex - P_onchain| >= 10 bps` (subject to `>= 4s` cooldown) **or** heartbeat age reaches **`15s`** (`10s` when `vault.totalReserved(invToken) > 0` or active `FLOATING` tickets exist; `20s` keepalive when zero `FLOATING` offers/tickets are active, still comfortably inside `maxStaleness = 30s`).
     - **Timestamp Safety:** Stamp `reportTimestamp = min(utcNow - 2, latestKnownBlockTs)` to eliminate `FutureTimestamp()` reverts against `2.0s` discrete L2 block timestamps.
   - **Optional Secondary Mechanism — Quote-Relay Pre-Push:** For large institutional `reserve()` / `exercise()` via SDK/UI, an API endpoint can trigger an immediate daemon `updatePrice` push `1–2` blocks ahead of the user's tx (non-atomic, zero shared-custody risk).

### 2.2 HSM / KMS Signing & Key Separation (`ASSUMED` Infrastructure)
```text
[CEX WebSockets (Binance/OKX/Coinbase/Kraken/HashKey)]
        │
        ▼ (Medianize + Outlier Reject + Jump Cap)
[Price Aggregator Service] ──(EIP-712 Digest)──► [AWS KMS / GCP KMS / HSM (authorizedSigner)]
        │                                                 │ (zero HSK gas balance!)
        ◄──────────────(ECDSA Signature r,s,v)────────────┘
        │
        ▼
[Stateless Submitter Relayer Pool (Relayer A / Backup Relayer B)]
        │  (pays HSK gas; permissionless SignedPullOracle.updatePrice)
        ▼
[RPC Router: Private Node Primary + https://mainnet.hsk.xyz Fallback] ──► Chain 177
```
- **Strict Key Separation:** `authorizedSigner` lives exclusively inside hardware-backed KMS (`ECC_SECG_P256K1`) with IAM policy restricting `Sign` calls to the aggregator VPC and enforcing rate limits; `authorizedSigner` holds **0 HSK** and never signs transactions directly.
- **Replaceable Submitter Relayers:** Because `SignedPullOracle.updatePrice()` is permissionless (`L53–L74`), gas-paying relayer EOAs are completely untrusted for price integrity—if a relayer key leaks or stalls on a stuck nonce, rotate to Relayer B immediately without touching on-chain `authorizedSigner`.

### 2.3 Gas Budget & Funding (`VERIFIED` Unit Gas Price / `ESTIMATED` Cost)
- `VERIFIED` chain parameters ([`ECONOMIC_MODEL.md`](file:///c:/Users/USER/Desktop/Tranche/research/ECONOMIC_MODEL.md) §6.1): `gasPrice = 500.001 gwei`, `WHSK = $0.080808` -> **`$0.004040` per 100,000 gas** (`~0.05 HSK` per 100k gas).
- Estimated `SignedPullOracle.updatePrice()` gas: `~65,000–80,000` gas (`$0.0026–$0.0032` per tx, `ESTIMATED`).
- At `15s` average heartbeat across 3 pairs (`17,280` txs/day): **`~562–691 HSK/day` (`~$45.4–$55.8/day`, `~$1,360–$1,675/month`, `ESTIMATED`)**.
- **Relayer Gas Policy:** Maintain `1,000 HSK` (`~$80.80`) per active relayer (capped blast radius), auto-alert `WARN` at `< 250 HSK` and `CRITICAL` at `< 75 HSK`.

### 2.4 RPC Failover, Batching & Nonce Management
- **Observed Public RPC Limits (`VERIFIED` in [`deployments/hashkey-mainnet.json`](file:///c:/Users/USER/Desktop/Tranche/deployments/hashkey-mainnet.json#L20-L24)):**
  - `https://mainnet.hsk.xyz` returns **HTTP `429`** on rapid sequential bursts.
  - `eth_getLogs` rejects ranges `>= 10,000` blocks (`HTTP 400`).
  - Large `Multicall3` payloads return `HTTP 413`; `<= 35` calls per `Multicall3.aggregate3()` with `~350 ms` pacing succeeds reliably.
- **Required Production Topology:**
  1. Provision at least **2 independent RPC endpoints** (e.g., dedicated self-hosted OP Stack `op-geth`/`op-reth` node or commercial RPC provider `[ASSUMED]` + `https://mainnet.hsk.xyz` as read/broadcast failover). **Blocker:** Currently only `https://mainnet.hsk.xyz` is verified.
  2. Route all state polling (`getPriceX36`, `offerBalance`, `ticketReserved`, `vault` buckets) through `Multicall3` (`0xcA11...ca11`) in batches of `<= 35` calls spaced `>= 350 ms`.
  3. **Nonce & Replacement Policy:** Maintain monotonic local nonce tracking per relayer; if an `updatePrice` tx is unconfirmed after **`4s` (`2` blocks)**, re-broadcast with `+20%` `maxPriorityFeePerGas` (same nonce) or skip stale report if a newer CEX tick supersedes it (`same nonce`, newer `reportTimestamp`).

---

## 3. Keeper Reliability (`reclaimExpired` & `reclaimExpiredBatch`)

Source inspected: [`CommitmentManager.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol) (`L418–L451`).

### 3.1 Mechanics & Why an Automated Keeper Is Required (`VERIFIED`)
- `reclaimExpired(uint256 ticketId)` and `reclaimExpiredBatch(uint256[] calldata ticketIds)` are **permissionless**, unpausable, and have **zero oracle or compliance-hook dependencies** (`INV-8`).
- Upon `block.timestamp > t.expiresAt`, `_reclaimExpired` sets `t.status = TicketStatus.RECLAIMED`, `t.remainingAmount = 0`, burns the ERC-721 ticket, and:
  - If `o.status == OfferStatus.ACTIVE && block.timestamp < o.expiry`: calls `vault.releaseTicketToOffer(...)`, **automatically restoring LP offer liquidity** (`returnToOffer = true`, `L442–L444`).
  - Otherwise: calls `vault.releaseTicketToFree(...)`, moving inventory to `lpFreeBalance` (`returnToOffer = false`, `L446`).
- **Operational Impact:** Without a reliable keeper, expired ticket collateral remains locked in `ticketReserved` until an LP manually intervenes, reducing active offer fill capacity and degrading LP capital efficiency.

### 3.2 Gas Costs & Batch Failure Hazard (`ESTIMATED` / `VERIFIED`)
- **Estimated Gas (`ESTIMATED`):** Single `reclaimExpired(id)` `~85,000–120,000` gas (`$0.0034–$0.0048`); `reclaimExpiredBatch` `~60,000–85,000` gas per ticket (`$0.0024–$0.0034` per ticket).
- **Batch All-or-Nothing Revert Hazard (`VERIFIED`):** `reclaimExpiredBatch` (`L425–L430`) loops directly into `_reclaimExpired` without `try/catch`. If **even one** `ticketId` in `ticketIds[]` was already reclaimed by an LP or competing keeper (`TicketNotActive`) or has not yet passed `expiresAt` (`TicketNotExpired`), the **entire batch reverts**!
- **Keeper Execution Algorithm:**
  1. **No Subgraph Dependency (`VERIFIED`):** `graphnode.hashkeychain.net` DNS failed during audit (`INFRASTRUCTURE_AUDIT.md` L22). Index active tickets via:
     - Incremental `eth_getLogs` for `TicketReserved`, `TicketSplit`, `TicketExercised`, `TicketReclaimed` in **`<= 2,000`-block chunks** (well below the `10,000`-block HTTP `400` cap), **plus**
     - Direct state reconciliation using `CommitmentManager.nextTicketId()` and `Multicall3.aggregate3` (`<= 35` `getTicket(id)` calls/request) to guarantee zero missed events across RPC drops.
  2. **Pre-Flight Check & Cap:** Trigger reclaim when `latestBlock.timestamp > t.expiresAt + 2` (1 block grace to avoid `TicketNotExpired` due to timestamp lag). Batch at most `20` tickets per `reclaimExpiredBatch` tx, simulate via `eth_call` immediately before signing, and on race revert fall back to binary-splitting the batch or per-ticket `reclaimExpired`.
  3. **Dust DoS Bound (`VERIFIED`):** `CommitmentManager` enforces `minTicketAmount` on both `reserve()` (`L261–262`) and both halves of `splitTicket()` (`L380–385`), preventing attackers from splitting a ticket into `1 wei` dust tickets to grief keeper gas (`T4.2`).

---

## 4. Monitoring, Telemetry & Alerting Matrix

Every production deployment must run a dedicated read-only **Protocol Watchdog** polling via `Multicall3` (`<= 35` calls/batch, `>= 350 ms` spacing) every `4–6s` (`2–3` blocks):

| Signal / Invariant | Verification Source | `WARN` Threshold | `CRITICAL` / Page Threshold | Automated / Operator Response |
| --- | --- | --- | --- | --- |
| **`INV-1` Vault Physical Solvency** | `IERC20(t).balanceOf(vault) >= totalLpFree + totalOfferAvailable + totalReserved + totalPendingProceeds + protocolFees` (`LiquidityVault.sol`) | N/A (exact invariant) | **Any `<` deficit (`> 0 wei`)** | Immediately trigger `guardian` pause (`setDepositsPaused(true)` + `setNewReservationsPaused(true)`) & investigate token contract. |
| **`INV-7` Router Zero-Residue** | `balanceOf(router, token) == 0 && allowance(router, vault) == 0` (`ExecutionRouter.sol`) | N/A | **Any non-zero residual** | Investigate tx trace for unexpected transfer/approval leak. |
| **Oracle Age (`SignedPullOracle`)** | `latestBlock.timestamp - pullOracle.getPriceX36(inv, pay).updatedAt` | `> 18s` (`9` blocks) | `> 25s` (`> 30s` = `FLOATING` halted!) | Switch to Backup Relayer / Backup RPC; verify KMS & CEX aggregator health. |
| **Oracle Deviation (`Primary` vs `TWAP` vs `CEX`)** | `|pullPrice - twapPrice| / min` and `|pullPrice - independentCexCheck| / min` | `> 250 bps` | `> 400 bps` (`> 500 bps` = breaker trips on WHSK) | Inspect CEX orderbooks vs HSKSwap pool for manipulation or `authorizedSigner` compromise. |
| **CEX Venue Quorum** | Off-chain aggregator metrics | `== 3` (`WETH`/`WBTC`) or `== 2` (`WHSK`) | `< minQuorum` (signing halted!) | Fail closed (stop signing); notify on-call to inspect exchange APIs. |
| **RPC Health & Block Lag** | `eth_blockNumber` timestamp vs UTC wall-clock; HTTP `429`/`5xx` rate | Lag `> 6s` (`3` blocks) or `429 > 2%` | Lag `> 16s` (`8` blocks) or primary down | Fail over to secondary RPC; throttle non-critical indexers. |
| **Relayer HSK & Nonce Age** | `eth_getBalance(relayer)` & pending tx age | `< 250 HSK` or pending `> 4s` | `< 75 HSK` or stuck `> 12s` | Fee-bump replacement (`+20%`); top up HSK; fail over to Relayer B. |
| **Abnormal Reserve / Exercise Velocity** | `TicketReserved` / `TicketExercised` deltas vs `totalOfferAvailable` | `> 25%` pool reserved in `5 min` | `> 50%` pool exercised in `2 min` or `effPriceX36` diverges `> 200 bps` from off-chain CEX mid | **Suspected oracle compromise or mispriced offer:** verify oracle quotes immediately; run Emergency Oracle Freeze Runbook (§6.2). |
| **Expired Unreclaimed Backlog** | Active tickets with `block.timestamp > expiresAt + 60s` | `> 5` tickets or `> 60s` lag | `> 20` tickets or `> 300s` lag | Restart keeper / inspect RPC tx submission. |

---

## 5. Feed Outages & Sequencer Downtime Recovery Runbooks

### 5.1 Protocol Liveness Matrix During Outages (`VERIFIED` in [`CommitmentManager.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol))

| Action | `FLOATING` Mode (Oracle Down / Breached) | `FIXED` Mode (Oracle Down / Breached) | Sequencer Down (`177` Halted) |
| --- | --- | --- | --- |
| `createOffer` / `pauseOffer` / `unpauseOffer` / `cancelOffer` / `decreaseOffer` | **LIVE** (oracle not queried) | **LIVE** | Halted (chain down) |
| `reserve` / `quoteReservation` (`effPremiumBps > 0`) | **HALTED** (`OracleUnavailable()`) | **LIVE** | Halted |
| `exercise` / `quoteExercise` / `batchExercise` | **HALTED** (`OracleUnavailable()`) — **Note:** expires at `expiresAt` if outage persists! | **LIVE** | Halted |
| `splitTicket` | **LIVE** | **LIVE** | Halted |
| `reclaimExpired` / `reclaimExpiredBatch` | **LIVE** (`INV-8`) | **LIVE** (`INV-8`) | Resumes immediately on restart |
| `LiquidityVault.withdrawFree` / `claimProceeds` | **LIVE** (`INV-8`) | **LIVE** (`INV-8`) | Resumes immediately on restart |

### 5.2 Outage Recovery Procedures

1. **Runbook A — Upstream CEX Feed / Quorum Loss:**
   - Aggregator automatically halts signing (`fail-closed`); after `30s`, `OraclePriceAdapter` returns `isValid = false` for affected pair(s), halting `FLOATING` reservations/exercises while keeping `FIXED` and `reclaimExpired` live.
   - Operator verifies whether outage is exchange-specific (API key/rate limit/maintenance) or market-wide.
   - Restore `>= minQuorum` healthy venues, verify spread/deviation vs external reference, resume signing -> relayer pushes fresh `updatePrice`, automatically restoring `FLOATING` execution.
   - **Post-Incident:** Audit any `FLOATING` tickets that expired (`TicketExpired`) while holders were blocked from exercising during the outage; publish transparent incident log.

2. **Runbook B — Relayer / RPC Outage (`SignedPullOracle` Stale `> 30s`):**
   - Switch relayer traffic to Secondary RPC endpoint; if Primary Relayer nonce is wedged, promote Backup Relayer B (separate EOA address, zero shared nonce) and push fresh KMS-signed `PriceReport`.
   - Confirm `OraclePriceAdapter.getPriceX36()` returns `isValid = true` and monitor `TicketExercised` for any backlog rush.

3. **Runbook C — HashKey Chain Sequencer Halt & Restart (`OP Stack L2`):**
   - **During Halt:** Halt signing loop cleanly (`pause` daemon submission to avoid queuing stale signed reports or filling nonces); alert LPs and takers on status page.
   - **On Sequencer Restart:**
     1. **Do NOT blindly auto-push on block #1** if CEX markets gapped severely during downtime; first confirm block production cadence has stabilized (`>= 3` consecutive `2.0s` blocks) and check whether `UniswapV3TwapOracle` (`observe([1800, 0])`) on `WHSK/USDT` is stale/lagging post-halt (since V3 TWAP interpolates the pre-halt tick across the outage, CEX vs TWAP may diverge `> 500 bps` and trip `maxDeviationBps`).
     2. Check expired tickets (`block.timestamp > expiresAt`) and immediately run `reclaimExpiredBatch` so LPs recover collateral before stale quotes accumulate.
     3. Wait for `WHSK/USDT` V3 arb swap(s) (or `OraclePriceAdapter.admin` temporarily widens/adjusts `maxDeviationBps` if TWAP interpolation causes false-positive DoS) before resuming `FLOATING` liquidity.
     4. Resume push daemon and verify `getPriceX36()` health.

4. **Runbook D — HSKSwap V3 TWAP Manipulation / Divergence Trips `maxDeviationBps`:**
   - Watchdog alerts `CRITICAL` when `|SignedPullOracle - UniswapV3TwapOracle| > 500 bps`.
   - Operator cross-checks `SignedPullOracle` against CEX median:
     - **If CEX median matches `SignedPullOracle` (meaning V3 TWAP is manipulated or stale):** Keep `allowSecondaryFallback = false`. `OraclePriceAdapter.admin` multisig may temporarily detach `secondaryFeed` (`address(0)`) or raise `maxDeviationBps` via `setPairConfig()` ONLY after confirming KMS & CEX quorum integrity, restoring `FLOATING` liveness until V3 TWAP recovers.
     - **If `SignedPullOracle` diverges from CEX median:** Immediately execute **Key Compromise Runbook (§6.2)**!

---

## 6. Emergency Pause, Key Compromise & Recovery Procedures

### 6.1 Exact `guardian` vs. `admin` Authority Matrix (`VERIFIED`)

| Contract | Role | Mutable? | Exact Capability | What It **CANNOT** Do (`INV-8` & Gaps) |
| --- | --- | --- | --- | --- |
| **`LiquidityVault`** | `guardian` | Yes (`vault.setGuardian` by `admin`, `L78–L82`) | `setDepositsPaused(bool)` (`L90–L94`): blocks `deposit` & `depositFor`. | **Cannot** pause `withdrawFree`, `claimProceeds`, `settleExercise`, or sweep any user/LP tokens. |
| **`CommitmentManager`** | `guardian` | **NO setter** (`L87`, set once in constructor `L113`) | `setNewReservationsPaused(bool)` (`L135–L139`): blocks `createOffer`, `topUpOffer`, & `reserve`. | **Cannot** pause `exercise`, `batchExercise`, `splitTicket`, `decreaseOffer`, `cancelOffer`, or `reclaimExpired`. **Cannot be rotated if `guardian` key is lost/compromised!** |
| **`SignedPullOracle`** | `admin` | **Immutable** (`L30`) | `setAuthorizedSigner(address)` (`L46–L51`). | **No `guardian` role.** **No pause or `revokePrice()`**. Cannot overwrite a fraudulent price in the same `block.timestamp` second (`L64`). |
| **`OraclePriceAdapter`** | `admin` | **Immutable** (`L24`) | `setPairConfig(inv, pay, PairConfig)` (`L31–L38`). | **No `guardian` role.** Can immediately freeze any pair by setting `hardMinPriceX36 = 1, hardMaxPriceX36 = 1` (or bad `primaryFeed`). |
| **`UniswapV3TwapOracle`** | `admin` | **Immutable** (`L27`) | `setPoolConfig(...)` (`L34–L63`). | **No `guardian` role.** |

> **CRITICAL OPERATIONAL FINDING (`VERIFIED`):**
> `guardian` **CANNOT stop an attacker from exercising already-minted active `FLOATING` tickets against a compromised `SignedPullOracle`!** `guardian` can only stop *new* deposits and *new* reservations (`setDepositsPaused(true)` + `setNewReservationsPaused(true)`), and `guardian` has **zero permissions** on `SignedPullOracle` or `OraclePriceAdapter`. Stopping an active oracle exploit on existing `FLOATING` tickets requires **`OraclePriceAdapter.admin`** (to freeze the pair config) or **`SignedPullOracle.admin`** (to rotate `authorizedSigner` and push a clean price after `>= 2s`).
>
> **Mandatory Deployment Rule:** All five `immutable admin` addresses (`LiquidityVault`, `CommitmentManager`, `SignedPullOracle`, `UniswapV3TwapOracle`, `OraclePriceAdapter`) **MUST** be deployed by a **Gnosis Safe multisig** (or fast-path multisig for `OraclePriceAdapter` + `SignedPullOracle` so incident response does not stall waiting on cold-storage signers), and `CommitmentManager`'s `guardian` **MUST** be a multisig because it has no `setGuardian()` rotation path!

### 6.2 Step-by-Step Incident Runbook: `authorizedSigner` Key Compromise

1. **T+0 (Contain Active Ticket Drain — `OraclePriceAdapter.admin` Multisig):**
   - Immediately call `OraclePriceAdapter.setPairConfig(inv, pay, cfg)` for every `FLOATING` pair (`WHSK/USDT`, `WETH/USDT`, `WBTC/USDT`) with **`hardMinPriceX36 = 1, hardMaxPriceX36 = 1`** (passes `hardMin <= hardMax` check on L34; causes `_readAndValidate` L89 to reject every realistic price `> 1`, returning `isValid = false` and halting all `FLOATING` `reserve()` and `exercise()` calls immediately).
2. **T+1 (Contain New Inflows — `guardian` Multisig):**
   - Call `CommitmentManager.setNewReservationsPaused(true)` and `LiquidityVault.setDepositsPaused(true)` if broader protocol anomalies are suspected. (Note: `FIXED` exercises, `withdrawFree`, `claimProceeds`, `cancelOffer`, and `reclaimExpired` remain 100% live per `INV-8`.)
3. **T+2 (Eradicate & Rotate Signer — `SignedPullOracle.admin` Multisig):**
   - Provision a brand-new KMS key `newSigner` in an isolated IAM boundary; revoke the compromised KMS key.
   - Call `SignedPullOracle.setAuthorizedSigner(newSigner)`.
   - Push a verified `PriceReport` for each pair using `newSigner` with `reportTimestamp = latestBlock.timestamp` (note: if the attacker just wrote a report at `t_attack`, wait 1 block `+2s` so `reportTimestamp > _prices[pairKey].updatedAt` passes L64!).
4. **T+3 (Verify & Recover):**
   - Verify `SignedPullOracle.getPriceX36(inv, pay)` reflects clean CEX prices on all pairs and `INV-1` vault solvency holds.
   - Restore tight per-pair `PairConfig` (`hardMinPriceX36`, `hardMaxPriceX36`, `maxStaleness = 30`, `allowSecondaryFallback = false`) on `OraclePriceAdapter`.
   - Unpause `CommitmentManager.setNewReservationsPaused(false)` and `LiquidityVault.setDepositsPaused(false)`.
   - Monitor for 30 minutes at `WARN` sensitivity; publish post-mortem.
