# Tranche — Mainnet Readiness Phase 1 Reconciliation & Assessment

> **Target Network:** HashKey Chain Mainnet (OP Stack L2, Chain ID `177`, RPC `https://mainnet.hsk.xyz`)  
> **Frozen Baseline Commit:** `f5d61e76134fd3badc831d10136318431aabd413` (`main`)  
> **Rule Zero Verification:** `git diff --name-only` is empty; zero modifications to `contracts/src/` or existing tests (`ForgeSmoke.t.sol`, `HashKeyForkPrototype.t.sol`, `ProtocolAdversarial.t.sol`, `ProtocolInvariant.t.sol`).  
> **Explicit Launch Recommendation:** **`NOT READY`** for HashKey Chain Mainnet (`177`). **`CONDITIONAL`** for Public Testnet (only after resolving `P0`/`P1` code and parameter blockers).

---

## 1. Frozen Baseline & Independent Verification Evidence

### 1.1 Exact Contract Baseline (`f5d61e76134fd3badc831d10136318431aabd413`)

| File (`contracts/src/`) | SHA-256 Hash (`VERIFIED`) |
| --- | --- |
| `contracts/src/LiquidityVault.sol` | `B156DC1B6E9618EA4A2EC225CC2A34F259DA72E48A00E1C396BED6F63753022E` |
| `contracts/src/CommitmentManager.sol` | `7A571B7EA542F8B18AA9EF97C600202921E49A4AFEEAA666B2B76581EB5C9FAC` |
| `contracts/src/ExecutionTicket.sol` | `D5CE366959CE44B3BC027E84512FB46AE942943ED323C78F932C39EEACC51227` |
| `contracts/src/ExecutionRouter.sol` | `8B6EC04184F25BCC6BB68B69DE406CF405F372B3DD5A99DC07650F5CC0C1AB7C` |
| `contracts/src/ForgeSmoke.sol` | `3992E13072A7A6CCF3E9537582A45B88BC1E21572C534094FF15B831397251E4` |
| `contracts/src/interfaces/IProtocol.sol` | `0ACC2E87FC70FD65A863EAE7C02A54F42F10EBBA8D5C9B97D17C8A5F15AF1873` |
| `contracts/src/adapters/V3PositionSegregator.sol` | `12E0620AF82C8D0BFF46D7E289121325C54144EAABE35B485597012171FA1508` |
| `contracts/src/adapters/SignedPullOracle.sol` | `2C3022DA8743A99BD9D2037015866330C40A90C4444FCDAF1A9BB0A5E0F480EC` |
| `contracts/src/adapters/UniswapV3TwapOracle.sol` | `1F29B8FE5DB7A96EA9C22763EBAF43C07167331F4D07EA633D0749314335513A` |
| `contracts/src/adapters/OraclePriceAdapter.sol` | `94E4629E37A47936A6CA03190A073B2D6DEA0727E5C1FD76D75D2EA10D7F663F` |
| `contracts/src/adapters/HSPComplianceHook.sol` | `8D9F75DE3B6244E0B2096AE6246DDA673F021E6B1E47DEE896CD9D19D9A00836` |

### 1.2 Independent Suite & PoC Reproduction Results
- **Baseline Foundry Suites (`forge test --no-match-contract "HashKeyForkPrototypeTest|SecurityAuditPoCTest" -vv`):** `25/25` passed (`ForgeSmokeTest` `1/1`, `ProtocolAdversarialTest` `21/21`, `ProtocolInvariantTest` `3/3` at `5,120` calls each).
- **Security Audit PoC Reproduction (`forge test --match-contract SecurityAuditPoCTest -vv`):** **`10/10` PoCs passed**, independently confirming `H-01`, `H-02`, `H-03`, `M-01`, `M-02`, `M-03`, `M-04`, `M-05`, `L-01`, and `L-02` in [`SecurityAuditPoC.t.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/test/SecurityAuditPoC.t.sol).

---

## 2. Workstream Summary & Cross-Workstream Reconciliation

| Workstream | Agent | Deliverables | Headline Finding |
| --- | --- | --- | --- |
| **A — Contract Security** | Independent Security Auditor | [SECURITY_AUDIT.md](file:///c:/Users/USER/Desktop/Tranche/research/SECURITY_AUDIT.md), [SECURITY_FINDINGS.md](file:///c:/Users/USER/Desktop/Tranche/research/SECURITY_FINDINGS.md), [SecurityAuditPoC.t.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/test/SecurityAuditPoC.t.sol) | Core `LiquidityVault` custody has **0 Critical** findings, but **3 High**, **5 Medium**, **4 Low**, and **4 Informational** vulnerabilities block mainnet custody/compliance/oracle safety. |
| **B — Oracle & Operations** | Oracle & Operations Engineer | [ORACLE_READINESS.md](file:///c:/Users/USER/Desktop/Tranche/research/ORACLE_READINESS.md), [OPERATIONS_ARCHITECTURE.md](file:///c:/Users/USER/Desktop/Tranche/research/OPERATIONS_ARCHITECTURE.md) | `SignedPullOracle` is a centralized single-signer feed; test hard bounds (`1e18..1e27`) break `WETH/USDT` & `WBTC/USDT`; Chainlink Data Streams & keeper/RPC/KMS infra are unprovisioned; `guardian` cannot halt compromised `FLOATING` exercises. |
| **C — Economic Validation** | Independent DeFi Market Analyst | [ECONOMIC_REVALIDATION.md](file:///c:/Users/USER/Desktop/Tranche/research/ECONOMIC_REVALIDATION.md) | Repo default `protocolFeeBps = 50` charges 50 bps on full exercise notional, creating `-5.2` to `-30.2 bps` LP losses; global `minTicketAmount` breaks non-WHSK decimals; organic non-bot DEX volume is only `$891.96/day`. |

### 2.1 Critical Cross-Workstream Contradictions & Amplified Risks

1. **Oracle Circuit-Breaker Bypass + Single-Signer Compromise (Workstream A `H-01` + Workstream B):**
   - Both Workstream A and Workstream B independently flagged `OraclePriceAdapter.sol#L67-L70`: `if (pOk && !sOk) return p;` silently disables `maxDeviationBps` whenever `secondaryFeed` (`UniswapV3TwapOracle`) fails, stales past the shared `30s` `maxStaleness`, or breaches hard bounds.
   - **Cross-workstream amplification:** Combined with Workstream B's finding that `SignedPullOracle` relies on a single `authorizedSigner`, `guardian` has zero pause control over `exercise()` or oracles, and `SignedPullOracle` lacks `revokePrice()` or per-update jump caps: a single `authorizedSigner` compromise + a `$15` TWAP skew (or TWAP revert) lets an attacker drain 100% of `FLOATING` inventory on offers without LP `minPriceX36` floors (`H-01` + `M-05`).
2. **`protocolFeeBps = 50` Trap + Retroactive Admin Mutation (Workstream C + Workstream A `M-03` & `M-04`):**
   - Workstream C proved `CommitmentManager` deducts `protocolFeeBps` on both `grossPremium` and 100% of `grossPayment`, making the repo default (`50 bps`) economically toxic (`-5.23` to `-30.18 bps/fill`) for LPs.
   - Even if deployed at `5 bps`, Workstream A (`M-03`) proved `setProtocolFeeBps(500)` retroactively cuts LP proceeds by `5%` on already-active tickets, while `M-04` showed `exercise()` allows micro-fills that truncate `protocolFee` to `0`.
3. **Cross-Decimal `minTicketAmount` Bug + Split Lockout (Workstream C + Workstream A `M-03` & `M-04`):**
   - Workstream C proved global `minTicketAmount = 100e18` (`$8.08` WHSK) equals `$170,404` on `WETH`, `$6.18e16` on `WBTC`, and `$1e14` on `USDT`—blocking multi-pair deployment unless lowered to near-zero, which strips dust-split protection on `WHSK`. Meanwhile `M-04` proved `exercise()` ignores `minTicketAmount`, leaving `1-wei` un-splittable dust.
4. **Compliance Bypass vs. Router & Split Integration (Workstream A `H-02`, `H-03`, `M-01` + Phase 5 SDK/Demo):**
   - `ExecutionRouter.batchExercise` either DoS's compliant users (`NotCompliant(router)`) or completely bypasses caller & receiver compliance if the router is allowlisted (`H-02`), while `splitTicket` checks `msg.sender` instead of `ownerOf(ticketId)` (`H-03`). Meanwhile, `createOffer` lets untrusted LPs deploy stateful honeypot hooks/oracles to steal taker premiums (`M-01`).
5. **Reconciling Earlier Economic Optimism (`ECONOMIC_MODEL.md` vs `ECONOMIC_REVALIDATION.md`):**
   - `ECONOMIC_MODEL.md` compared Tranche returns to `0.19%–1.28%` passive HSKSwap APR and treated `$3,147/day` DEX volume as organic retail baseline. `ECONOMIC_REVALIDATION.md` disproved both: `92.2%` of swaps (`$31,566/14d`) came from one HyperIndex contract loop (leaving `$891.96/day` organic), real LP hurdle rates are `4.5%–10%+`, and CEX/OTC (`6–25 bps`) beats Tranche on pure spot price above `$5k`. Tranche's genuine economic niche is **committed bilateral/agentic/RWA on-chain settlement**, not passive retail flow capture.

---

## 3. Launch Readiness Matrix

Every mainnet launch requirement is classified strictly as **`READY`**, **`BLOCKED`**, **`NEEDS REVIEW`**, or **`NOT IMPLEMENTED`**:

| # | Requirement / Subsystem | Status | Evidence & Impact | Recommended Fix | Verification Required to Close |
| --- | --- | --- | --- | --- | --- |
| **1** | **Vault Custody & Physical Solvency (`LiquidityVault.sol`)** | **`READY`** *(w/ `I-02` review)* | 0 Critical findings in Workstream A; `INV-1`–`INV-8` passed `5,120` invariant calls + live mainnet fork; `SafeERC20`, `nonReentrant`, pull proceeds, FoT delta guard verified. | Optional: make `setGuardian`/`setFeeCollector` two-step (`I-02`). | Re-run `ProtocolInvariantTest` & `HashKeyForkPrototypeTest` after any sibling contract edits. |
| **2** | **`FIXED` Strike Pricing & `reclaimExpired` Liveness** | **`READY`** *(after `L-01`/`L-02` review)* | Zero oracle dependency; unaffected by pauses or compliance outages (`INV-8`). | Add best-effort `reclaimExpiredBatch` (`L-01`) and clarify/cap `ticket.expiresAt <= offer.expiry` (`L-02`). | Unit + fuzz tests for partial/raced `reclaimExpiredBatch` & expiry cap. |
| **3** | **Cross-Feed Oracle Deviation Breaker (`OraclePriceAdapter.sol`)** | **`BLOCKED`** | **`H-01` + Workstream B:** `if (pOk && !sOk) return p;` silently bypasses `maxDeviationBps`; shared `30s` `maxStaleness` breaks secondary TWAP; `Math.mulDiv` missing on line 59 (`L-04`). | Add `requireSecondaryCheck` & independent `secondaryMaxStaleness`; fail closed when required secondary is stale/unhealthy; use `Math.mulDiv`. | Negative PoC (`H-01`) converted to passing regression test proving deviation breach/unhealthy required secondary reverts/returns `isValid=false`. |
| **4** | **Per-Pair `priceX36` Bounds & Thin-Pool TWAP Safety** | **`BLOCKED`** | **Workstream B:** Repo test bounds `1e18..1e27` reject all valid `WETH/USDT` (`1.704e27`) and `WBTC/USDT` (`6.183e38`) prices; `$83.7k–$90.7k` V3 TVL allows `~$13–$15` TWAP-skew DoS. | Compute explicit per-pair bounds (`WHSK`: `3e22..2.5e23`, `WETH`: `7e26..4.5e27`, `WBTC`: `2.5e38..1.6e39`); disable V3 TWAP deviation check on thin `WETH`/`WBTC` or widen tolerance + use off-chain CEX quorum. | Mainnet-fork tests verifying live `reserve()` & `exercise()` on `WHSK/USDT`, `WETH/USDT`, AND `WBTC/USDT` pools. |
| **5** | **Centralized `SignedPullOracle` Trust & Compromise Controls** | **`BLOCKED`** | **Workstream B + `L-04`:** Single `authorizedSigner` EOA risk, no `maxPriceJumpBps` per update, no `revokePrice()`, no `guardian` freeze on `FLOATING` exercises, and no internal TTL on direct `SignedPullOracle` reads. | Introduce M-of-N signer quorum (or Chainlink Data Streams adapter), per-update `maxJumpBps`, `guardian` emergency `freezePair` / `revokePrice`, and KMS/HSM signing + 2nd RPC. | Foundry tests for `authorizedSigner` compromise containment, `maxJumpBps` rejection, and `guardian` emergency freeze of active `FLOATING` exercises. |
| **6** | **Chainlink Data Streams Mainnet Integration (`0x3278...Cd54`)** | **`NOT IMPLEMENTED`** | `VerifierProxy 2.0.0` is live on chain `177`, but `IPriceOracle` is `view`-only, feed IDs (`HSK/USDT`) are unverified, and Chainlink API credentials are absent. | Deploy stateful `ChainlinkDataStreamsOracle` (`submitReport` calling `VerifierProxy.verify`) once feed IDs & API keys are provisioned. | Live testnet/mainnet-fork DON report verification test. |
| **7** | **Governance, Guardian Rotation & Retroactive Admin Immunity** | **`BLOCKED`** | **`M-03` + `M-05` + Workstream B:** `CommitmentManager` lacks `setGuardian()`; all 6 contracts use `immutable admin` with no `Ownable2Step`/timelock; `setProtocolFeeBps`, `setMinTicketAmount`, and `setPairConfig` mutate active tickets retroactively. | Replace `immutable admin` with `Ownable2Step` + timelocked multisig; add `CommitmentManager.setGuardian()`; snapshot `protocolFeeBps` & `minFillAmount` into `Offer`/`Ticket`. | `M-03` & `M-05` PoCs converted to regression tests verifying active tickets retain creation-time fee/split terms and compromised guardian rotation succeeds. |
| **8** | **Compliance Hook Enforcement (`ExecutionRouter` & `splitTicket`)** | **`BLOCKED`** | **`H-02` + `H-03` + `M-01`:** Router breaks/bypasses `HSPComplianceHook` (especially with native unwrap); `splitTicket` checks `msg.sender` instead of `ownerOf`; untrusted LPs can deploy honeypot `complianceHook`/`oracle` to rug taker premiums. | Enforce `beforeExercise(leg.ticketId, msg.sender, params.receiver)` in `ExecutionRouter` (or trusted-router forwarding); check `ownerOf(ticketId)` in `splitTicket`; enforce governance allowlist/registry for `oracle` & `complianceHook` on `createOffer`. | `H-02`, `H-03`, and `M-01` PoCs converted to passing regression tests. |
| **9** | **`ExecutionTicket.permit` Nonce Replay & Event Hygiene** | **`BLOCKED`** | **`M-02` + `I-03`:** `nonces[tokenId]` not incremented on `_update` transfer, allowing replay after ownership cycles; `_approve(..., false)` suppresses `Approval` event. | Increment `nonces[tokenId]++` on transfers in `_update`; emit `Approval` event (`true`). | `M-02` PoC converted to regression test proving old `permit` reverts after transfer-back. |
| **10** | **Cross-Decimal `minTicketAmount` & Partial-Fill Dust Hygiene** | **`BLOCKED`** | **Workstream C + `M-04`:** Global `minTicketAmount` (`100e18`) blocks `WETH`/`WBTC`/`USDT`; `exercise()` ignores `minFillAmount`, allowing `1-wei` dust remainders and `0`-fee micro-fills. | Replace global raw `minTicketAmount` with per-offer `o.minFillAmount` (or per-token minimum map) across `reserve`, `splitTicket`, and `exercise` (`newRem == 0 || newRem >= minFill`), and round non-zero fees `Ceil`. | Multi-decimal (`18/6`, `8/6`, `6/18`) Foundry tests + `M-04` regression test. |
| **11** | **Economic Parameterization (`protocolFeeBps`) & Market Demand** | **`BLOCKED`** | **Workstream C:** Default `protocolFeeBps = 50` yields `-5.2` to `-30.2 bps` LP losses per fill; organic DEX flow (`$892/d`) yields `<1%` LP APR. | Lower `protocolFeeBps` to `2–5 bps` (or charge fee on `premium + spread` rather than notional); secure committed institutional/treasury orderflow (`>= $50k/d`) prior to mainnet liquidity bootstrapping. | Economic simulation + deployment config review confirming positive LP net APR across `5%–25%` utilization. |
| **12** | **Production Operations (2nd RPC, KMS, Push Daemon, Expiry Keeper, Monitoring)** | **`NOT IMPLEMENTED`** | Public RPC rate-limits (`429`/`400`/`413`) and subgraph DNS fails; no production KMS signer, relayer, keeper, or `INV-1`/oracle alerting deployed. | Provision private OP Stack RPC + `mainnet.hsk.xyz` failover, KMS signer + redundant relayers, `reclaimExpiredBatch` keeper (`<=2k`-block log chunks), and Prometheus/PagerDuty alerts. | 72-hour staging soak test on HashKey Chain testnet with chaos injection (RPC drop, oracle lag, batch expiry). |
| **13** | **External Smart Contract Audit & Bug Bounty** | **`NOT IMPLEMENTED`** | Only internal AI-assisted review (`SECURITY_AUDIT.md`) completed; zero third-party human security audit performed. | Engage independent external auditors on post-remediation commit prior to un-capped mainnet TVL. | Signed external audit report + verified closure of all findings. |
| **14** | **Live HashKey HSP / CaaS Settlement Integration** | **`NEEDS REVIEW`** *(Optional Periphery)* | No canonical public HSP singleton on chain `177`; live CaaS APIs require partner KYB/KYC credentials (`HSP_VERIFICATION.md`). Not required for permissionless core, required only for institutional KYC tranches. | Keep `HSPComplianceHook` optional (`address(0)` permissionless default); complete partner onboarding if launching regulated institutional pools. | End-to-end CaaS sandbox attestation & receipt test (if institutional pools launch). |

---

## 4. Prioritized Remediation Plan (Do Not Execute Until Approved)

### P0 — Mandatory Before Any Mainnet Capital (Critical Security, Oracle & Economic Blockers)
1. **Fix `OraclePriceAdapter.sol` & `SignedPullOracle.sol` (`H-01`, `L-04`, Workstream B):**
   - Require explicit `requireSecondaryCheck` + independent `secondaryMaxStaleness` so `pOk && !sOk` fails closed when a breaker is required; fix `Math.mulDiv` overflow.
   - Add per-update `maxJumpBps`, internal `maxStaleness` check in `SignedPullOracle`, emergency `revokePrice()` / `guardian` pause on `FLOATING` exercises, and M-of-N signer quorum (or Chainlink Data Streams adapter).
   - Fix per-pair `priceX36` bounds for `WHSK/USDT`, `WETH/USDT`, and `WBTC/USDT` (and disable thin-pool V3 TWAP divergence gating on `WETH`/`WBTC`).
2. **Fix Compliance & Adapter Trust Boundaries (`H-02`, `H-03`, `M-01`):**
   - Forward/enforce `msg.sender` and `params.receiver` on `IComplianceHook.beforeExercise` in `ExecutionRouter.batchExercise`.
   - Pass `ticketNft.ownerOf(ticketId)` instead of `msg.sender` to `beforeTransfer` in `CommitmentManager.splitTicket`.
   - Gate `createOffer` `oracle` and `complianceHook` addresses against governance-approved registries/allowlists.
3. **Fix Governance & Immutability Hazards (`M-03`, `M-05`):**
   - Replace `immutable admin` with `Ownable2Step` + timelocked multisig across all contracts; add `CommitmentManager.setGuardian()`.
   - Snapshot `protocolFeeBps` and `minFillAmount` on `Offer`/`Ticket` at creation/reservation so admin updates are never retroactive.
4. **Fix Economic & Multi-Decimal Bugs (Workstream C + `M-04`):**
   - Lower `protocolFeeBps` from `50` to `2–5 bps` (or apply fee solely to `grossPremium + spread` rather than full exercise notional).
   - Replace global raw `minTicketAmount` with per-offer / per-token minimums enforced across `reserve()`, `splitTicket()`, and `exercise()` (preventing `1-wei` dust remainders and `0`-fee micro-fills).
5. **External Smart Contract Audit:** Complete independent third-party audit after P0/P1 contract patches stabilize.

### P1 — Mandatory Before Public Testnet Launch
1. **Fix `ExecutionTicket.permit` Nonce Replay & Event (`M-02`, `I-03`):** Increment `nonces[tokenId]++` on transfers in `_update` and emit `Approval` event (`true`).
2. **Fix Batch & Expiry Usability (`L-01`, `L-02`, `L-03`):** Add best-effort `reclaimExpiredBatch`, validate `address(ticketNft) != address(0)` in `ExecutionRouter` constructor, and bound `ticket.expiresAt <= offer.expiry` (or clarify lockup cap).
3. **Remove `ForgeSmoke.sol` from `contracts/src/` (`I-04`).**

### P2 — Operational & Go-to-Market Readiness Before Mainnet Liquidity Bootstrapping
1. **Provision Infrastructure (Workstream B):** Secondary dedicated HashKey Chain RPC, Cloud KMS/HSM for `authorizedSigner`, redundant gas relayers, `reclaimExpiredBatch` keeper (`<= 2k`-block log windows + `Multicall3`), and real-time `INV-1`/oracle/drain alerts, validated over a 72h testnet soak test.
2. **Bootstrap Bilateral Institutional Flow (Workstream C):** Secure `>= $50,000/day` committed institutional/treasury/agentic orderflow rather than relying on `$892/day` organic retail DEX flow.

---

## 5. Explicit Launch Recommendation

- **HashKey Chain Mainnet (`177`): `NOT READY`**
  - Deploying frozen commit `f5d61e76` to mainnet with real LP capital would expose LPs and takers to confirmed `High`/`Medium` contract flaws (`H-01`..`H-03`, `M-01`..`M-05`), broken `WETH`/`WBTC` oracle hard bounds, negative LP unit economics (`protocolFeeBps = 50`), cross-decimal `minTicketAmount` lockouts, and missing KMS/RPC/keeper/monitoring infrastructure.
- **HashKey Chain Testnet: `CONDITIONAL`**
  - Core 1:1 ERC-20 `LiquidityVault` solvency (`INV-1`) is sound and passed all audits with 0 Critical findings. Tranche can proceed to public testnet **only after** applying the contract patches for `H-01`..`H-03`, `M-01`..`M-05`, `L-01`..`L-03`, fixing cross-decimal `minTicketAmount` and `protocolFeeBps`, and configuring accurate per-pair oracle bounds.
