# Tranche — Frozen Audit Baseline Manifest

> **Prepared:** 2026-11-24  
> **Audit Target Commit (HEAD):** `53dcf859da10f4d22dcdd2afa48d9882378165b6` (`testnet/phase3-validation`)  
> **Code-Freeze Commit (Phase 2 Remediation):** `76a85882d04af446e3e82d8421641a3769467c6e` (`remediation/mainnet-readiness`)  
> **Solidity Compiler:** `solc 0.8.24` (`optimizer = true`, `optimizer_runs = 200`, `via_ir = false`, `evm_version = "shanghai"`)  
> **Working Tree Status at Freeze:** Clean (`git status --short` empty prior to authoring `research/audit/`)

---

## 1. Git Branch & Commit Ancestry Verification

Earlier internal documents referenced abbreviated hashes or pre-rebatch commits. The exact verified Git relationships are:

| Reference | Full 40-Hex Commit SHA | Relationship & Status |
| --- | --- | --- |
| **`main`** | `f5d61e76134fd3badc831d10136318431aabd413` | Preserved Phase 1 pre-remediation baseline (`git merge-base --is-ancestor main remediation/mainnet-readiness == true`). Contains the original H-01..H-03, M-01..M-05, L-01..L-04, and economic/oracle defects. **Do not audit `main`.** |
| **`1f77502f` (pre-rebatch local commit)** | `1f77502ff2171fae6d7489c57c67dbb6a8fdc3de` | Unpushed pre-rebatch commit from Phase 2 remediation. Verified via `git diff --stat 1f77502ff2171fae6d7489c57c67dbb6a8fdc3de 76a85882d04af446e3e82d8421641a3769467c6e` -> **empty diff (bit-for-bit identical repository tree)** to `76a85882d04af446e3e82d8421641a3769467c6e`. |
| **`remediation/mainnet-readiness`** | `76a85882d04af446e3e82d8421641a3769467c6e` | Pushed 8-commit rebatched Phase 2 remediation branch (`origin/remediation/mainnet-readiness`). Ancestor of `testnet/phase3-validation`. **Exact commit where all 10 in-scope production Solidity files were finalized.** |
| **`testnet/phase3-validation`** | `53dcf859da10f4d22dcdd2afa48d9882378165b6` | Current pushed HEAD (`origin/testnet/phase3-validation`). Adds Phase 3 deployment script (`DeployTestnet.s.sol`), Chain-133 fork validation tests (`TestnetOperationalValidation.t.sol`), operational tooling (`scripts/testnet-ops/`), and docs. |

### Zero-Diff Proof for Production `contracts/src/` Between Remediation & Testnet Branch
```text
$ git diff --stat remediation/mainnet-readiness..testnet/phase3-validation -- contracts/src/
 contracts/src/mocks/TestnetERC20.sol | 29 +++++++++++++++++++++++++++++
 1 file changed, 29 insertions(+)
```
Every single one of the **10 in-scope production Solidity contracts** has identical bytecode and SHA-256 digests at both `76a85882d04af446e3e82d8421641a3769467c6e` and `53dcf859da10f4d22dcdd2afa48d9882378165b6`.

---

## 2. In-Scope Production Solidity Files (SHA-256 Checksums)

All hashes were computed via `Get-FileHash -Algorithm SHA256` on the clean working tree at `53dcf859da10f4d22dcdd2afa48d9882378165b6`:

| # | File Path | Total Lines | SHA-256 Digest |
| --- | --- | ---: | --- |
| 1 | `contracts/src/LiquidityVault.sol` | 334 | `71411b3c36bfa34f36738c1c658b524aed9aa11aa92832f97472309bf46facfe` |
| 2 | `contracts/src/CommitmentManager.sol` | 683 | `f0ccd59ee208c31c9bd6d7b06c87d7a55d2eac6e7c3b81bea180aac694617a72` |
| 3 | `contracts/src/ExecutionTicket.sol` | 120 | `de74fe3daf63620235132cc10bb90f9db2b51143e3a2bd1acd14e07e98f39e7c` |
| 4 | `contracts/src/ExecutionRouter.sol` | 150 | `fd37f3c1b129f6b5ab67cfebed637ca0d98b77c6fd3d3f68e704670b549a27a5` |
| 5 | `contracts/src/interfaces/IProtocol.sol` | 290 | `04803a267a16d33b5d511922dd6cc41aa49378a4ed2b08ac0183b709addeddda` |
| 6 | `contracts/src/adapters/SignedPullOracle.sol` | 204 | `cddfef6defa07270707f8cb4114803114bacc982bd86eb273577ad1414c589cd` |
| 7 | `contracts/src/adapters/OraclePriceAdapter.sol` | 103 | `0923ff3e6649729c347986a1fda637becebc59f8762ae370171f76244912f93a` |
| 8 | `contracts/src/adapters/UniswapV3TwapOracle.sol` | 151 | `8548207abc947ff418a521d0700050aa4731ae20a053386ae43eb75f6cb2ad49` |
| 9 | `contracts/src/adapters/HSPComplianceHook.sol` | 94 | `8d200e1697d1d8a2ea8a09462d25dbb031b1e218ea29d8c73543a33f023bf27b` |
| 10 | `contracts/src/adapters/V3PositionSegregator.sol` | 119 | `2b2f171a725d9755e94f3d44adc57f99307441606e77ba686288b688a210c099` |
| | **Total In-Scope Production Contracts** | **2,248** | **10 files** |

---

## 3. Out-of-Scope Files Inside `contracts/src/`

These two files exist under `contracts/src/` for toolchain/testnet testing only and are **explicitly excluded** from production mainnet deployment:

| File Path | Total Lines | SHA-256 Digest | Reason Excluded |
| --- | ---: | --- | --- |
| `contracts/src/ForgeSmoke.sol` | 10 | `3992e13072a7a6ccf3e9537582a45b88bc1e21572c534094ff15b831397251e4` | Foundry compiler smoke test contract |
| `contracts/src/mocks/TestnetERC20.sol` | 29 | `32a5c2b45e2b51ae40537570406e21aac7b3b5ca4b909c8d15a846f2c316c283` | Testnet-only mintable quote token (`tUSDT`/`tWBTC`/`tWETH`) |

---

## 4. External Dependencies (Pinned via `lib/`)

- **OpenZeppelin Contracts:** `lib/openzeppelin-contracts` (v5.x — `Ownable2Step`, `ReentrancyGuard`, `ERC721`, `EIP712`, `ECDSA`, `SafeERC20`, `Math`, `Base64`, `Strings`, `TimelockController`).
- **Forge Standard Library:** `lib/forge-std` (tests and scripts only).
