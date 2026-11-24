# Tranche — External Security Audit Engagement Brief

> **Status:** Draft ready for founder approval — **not yet sent to any auditor.**

---

## 1. Executive Brief

- **Protocol:** Tranche
- **Description:** A protocol that lets liquidity providers commit token inventory to time-bound offers, enabling traders and agents to reserve, transfer and execute guaranteed capacity on demand.
- **Network:** HashKey Chain, EVM-compatible (Mainnet Chain ID `177`, Testnet Chain ID `133`, OP Stack L2, `2.0s` blocks).
- **Current status:** Remediated Solidity codebase (`10` in-scope files, `2,248` total lines, `solc 0.8.24`), extensive Foundry regression/adversarial/invariant testing (`40` local tests including `5,120` stateful invariant calls with `0` reverts), HashKey Mainnet (`177`) V3 segregation fork testing (`1/1`), and HashKey Testnet (`133`) Safe v1.4.1 governance/oracle/lifecycle fork validation (`5/5`). **Live testnet deployment, 72-hour continuous soak, and independent external audit remain pending.** No contracts are deployed to mainnet.
- **Requested engagement:** Independent security audit of the frozen Solidity contracts (`53dcf859da10f4d22dcdd2afa48d9882378165b6` / production contracts frozen at `76a85882d04af446e3e82d8421641a3769467c6e`), including:
  1. Independent verification of all Phase 2 remediation fixes (`H-01..H-03`, `M-01..M-05`, `L-01..L-04`, economic/oracle fixes).
  2. Custody, rounding, cross-decimal (`6`/`8`/`18`), and economic attack-surface analysis.
  3. Oracle quorum (`2-of-3`/`3-of-5` EIP-712 `SignedPullOracle`), `OraclePriceAdapter` circuit breaker, and `TimelockController` + Safe governance review.
  4. Mandatory remediation-verification pass on a dedicated fix branch prior to final report sign-off.

---

## 2. Frozen Scope Summary

- **Repository:** `https://github.com/danielamodu/Tranche`
- **Frozen Commit:** `53dcf859da10f4d22dcdd2afa48d9882378165b6` (`testnet/phase3-validation`; zero production contract diff vs. `remediation/mainnet-readiness` `76a85882d04af446e3e82d8421641a3769467c6e`)
- **In-Scope Files (`10` files, `2,248` lines):**
  - Core: `LiquidityVault.sol`, `CommitmentManager.sol`, `ExecutionTicket.sol`, `ExecutionRouter.sol`, `interfaces/IProtocol.sol`
  - Adapters: `SignedPullOracle.sol`, `OraclePriceAdapter.sol`, `UniswapV3TwapOracle.sol`, `HSPComplianceHook.sol`, `V3PositionSegregator.sol`
- **Contextual Review:** `contracts/script/DeployTestnet.s.sol`
- **Auditor Package Included:** `research/audit/` (`AUDIT_BASELINE.md` with SHA-256 checksums, `AUDIT_SCOPE.md`, `THREAT_MODEL.md`, `KNOWN_FINDINGS.md`, `SECURITY_ASSUMPTIONS.md`, `DEPLOYMENT_ARCHITECTURE.md`, `TEST_COVERAGE.md`).

---

## 3. Proposed 7-Stage Audit Process

1. **Auditor Onboarding & Scope Agreement:**
   - Share `research/audit/` package with shortlisted firms under NDA (if required) and confirm exact file list, SHA-256 checksums, compiler settings (`solc 0.8.24`), severity rubric, deliverables, timeline, and bundled remediation review in the SOW.
2. **Frozen Source Delivery:**
   - Tag an immutable Git commit (`audit-freeze-v1` pointing to `53dcf859da10f4d22dcdd2afa48d9882378165b6` or the exact agreed commit) with verified SHA-256 manifest. No changes to `contracts/src/` during the audit window.
3. **Initial Findings & Severity Classification:**
   - Auditor delivers preliminary report with reproducible PoCs and severity ratings (`Critical`, `High`, `Medium`, `Low`, `Informational`), covering both new findings and verification of prior Phase 1/2 remediations.
4. **Reproduction & Triage:**
   - Tranche engineering reproduces every finding locally in Foundry, confirms root cause, and agrees on remediation vs. documented acceptance for each item.
5. **Remediation on a Separate Branch:**
   - Implement all agreed fixes on a dedicated `audit/remediation-v1` branch with targeted regression tests and full re-run of adversarial, invariant, fork, and SDK/agent suites. Do not merge to `main` prematurely.
6. **Auditor Verification of Fixes:**
   - Auditor reviews exact `git diff` between frozen commit and `audit/remediation-v1`, verifies all fixes and non-regression, and updates each finding status (`Fixed`, `Partially Fixed`, `Acknowledged`).
7. **Final Report & Publication Permissions:**
   - Auditor issues final signed report referencing both the initial frozen commit SHA and final verified remediation commit SHA. Publish report in `research/audit/` upon mutual publication agreement before any mainnet deployment.

---

## 4. Questions to Request in Auditor Proposals
1. Proposed start date, audit duration, and remediation-review turnaround?
2. Fixed fee vs. time-and-materials pricing, and whether one round of fix verification is included?
3. Number and seniority of lead/supporting security researchers assigned to the engagement?
4. Whether manual invariant/fuzzing review of `LiquidityVault` + `CommitmentManager` cross-decimal math is included?
