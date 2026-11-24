# Tranche — Test Coverage & Reproduction Guide

> **Audit Baseline:** `53dcf859da10f4d22dcdd2afa48d9882378165b6` (`testnet/phase3-validation`)  
> **Toolchain:** Foundry (`forge 1.7.1`, `solc 0.8.24`), Node.js (`v22+`), `tsx`

---

## 1. Test Suite Summary (`61 / 61` Passing Across All Suites)

| Suite | File / Package | Tests | Focus |
| --- | --- | ---: | --- |
| **Toolchain Smoke** | `contracts/test/ForgeSmoke.t.sol` | `1` | Build sanity |
| **Remediation Regression** | `contracts/test/RemediationRegression.t.sol` | `15` | Proves closure of `H-01..H-03`, `M-01..M-05`, `L-01..L-04`, `Econ-1`, `Econ-2`, `Oracle-1` |
| **Adversarial & Fuzz** | `contracts/test/ProtocolAdversarial.t.sol` | `21` | Reentrancy, fee-on-transfer, router confused-deputy, dust splits, partial-fill rounding fuzz (`256` runs), compliance hook isolation, expiry boundaries |
| **Stateful Invariants** | `contracts/test/ProtocolInvariant.t.sol` | `3` | `INV-1` physical solvency, `INV-2/3` bucket conservation & ticket mirror, `INV-5` router zero residue (`64` runs x `80` depth = `5,120` handler calls each, `0` reverts) |
| **Mainnet Fork (`177`)** | `contracts/test/HashKeyForkPrototype.t.sol` | `1` | End-to-end V3 NFT liquidity segregation -> Vault -> Offer -> Reserve -> Transfer -> Partial Exercise -> Expiry Reclaim on HashKey Chain Mainnet (`https://mainnet.hsk.xyz`) |
| **Testnet Fork (`133`)** | `contracts/test/TestnetOperationalValidation.t.sol` | `5` | Live Chain-133 Safe v1.4.1 (`3/5` Gov, `2/3` Guardian, `2/3` Treasury) + `TimelockController` handover/veto/rotation, M-of-N oracle signer rotation/revoke/bounds, native `HSK`/`WHSK` + router batch unwrap, adversarial compliance & duplicate keeper |
| **TypeScript SDK** | `sdk/test/sdk.integration.test.ts` | `2` | Full contract lifecycle + custom error decoding |
| **HSP Adapter** | `hsp/test/hsp-adapter.test.ts` | `5` | EIP-712 compliance attestations, non-compliant reverts, replay rejection, `INV-8` revoked LP exit, live-mode guard |
| **Execution Agent** | `agent/test/agent.integration.test.ts` | `3` | Deterministic offer scoring, partial/full fills, stale oracle & slippage handling |
| **Demo E2E** | `demo/test/demo.integration.test.ts` | `3` | 6-step HTTP API & UI journey in `FIXED` and `FLOATING` modes |
| **Testnet Ops** | `scripts/testnet-ops/test/ops.test.ts` | `2` | Multi-RPC failover/recovery (`503`/`429`), M-of-N EIP-712 quorum sorting, 2-cycle soak + keeper reclaim |
| **Total** | | **61** | **61 passed, 0 failed, 0 skipped** |

---

## 2. Exact Reproduction Commands

### Foundry Suites (Primary Audit Verification)
```bash
# 1. Local Foundry suites (40 tests: Smoke + Regression + Adversarial + Stateful Invariants)
forge test --no-match-path "contracts/test/{HashKeyForkPrototype,TestnetOperationalValidation}.t.sol" -vv

# 2. HashKey Chain Testnet (Chain ID 133) operational & Safe governance fork suite (5 tests)
forge test --match-path contracts/test/TestnetOperationalValidation.t.sol --fork-url https://testnet.hsk.xyz -vv

# 3. HashKey Chain Mainnet (Chain ID 177) V3 segregation fork test (1 test)
forge test --match-path contracts/test/HashKeyForkPrototype.t.sol --fork-url https://mainnet.hsk.xyz -vv

# 4. Deployment script dry-run against Chain 133 fork (no broadcast)
forge script contracts/script/DeployTestnet.s.sol --fork-url https://testnet.hsk.xyz
```

### TypeScript Integration & Operational Suites
```bash
cd sdk && npm test
cd ../hsp && npm test
cd ../agent && npm test
cd ../demo && npm test
cd ../scripts/testnet-ops && npm run typecheck && npm test
```

---

## 3. Preserved Baseline PoCs (Pre-Remediation Evidence)
The original Phase 1 exploit proofs targeting frozen `main` (`f5d61e76134fd3badc831d10136318431aabd413`) are archived intact under [`research/pocs/`](../pocs/):
- `research/pocs/SecurityAuditPoC.t.sol` (`10` PoCs for `H-01..H-03`, `M-01..M-05`, `L-01`, `L-02`)
- `research/pocs/BaselineDefectPoC.t.sol` (`3` PoCs for `Econ-1`, `Econ-2`, `Oracle-1`)

Auditors can check out `f5d61e76134fd3badc831d10136318431aabd413` to reproduce all 13 pre-remediation defects directly against `main`, then verify closure at `53dcf859da10f4d22dcdd2afa48d9882378165b6`.
