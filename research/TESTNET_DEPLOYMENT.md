# Tranche — Phase 3: HashKey Testnet Preparation, Governance & Validation Report

> **Branch:** `testnet/phase3-validation` (derived from `remediation/mainnet-readiness` commit `76a85882d04af446e3e82d8421641a3769467c6e`)  
> **Preserved `main` Baseline:** `f5d61e76134fd3badc831d10136318431aabd413` (untouched)  
> **Deployment Status:** **`FORK_DRY_RUN_VERIFIED_PENDING_LIVE_BROADCAST`** *(Live Chain-133 broadcast and 72-hour soak are blocked pending funded deployer HSK keys and independent signer/RPC provisioning; see [INCIDENT_LOG.md](file:///c:/Users/USER/Desktop/Tranche/research/INCIDENT_LOG.md)).*

---

## 1. Pre-Deployment Verification

### 1.1 Commit & Repository Integrity
- Verified starting commit on `remediation/mainnet-readiness`: `76a85882d04af446e3e82d8421641a3769467c6e`, working tree clean prior to creating branch `testnet/phase3-validation`.
- Preserved `main` baseline at `f5d61e76134fd3badc831d10136318431aabd413`.

### 1.2 Pre-Deployment Full Test Suite Re-Run (`76a8588`)
All existing protocol and integration suites passed with zero modifications:

| Suite | Command | Result |
| --- | --- | --- |
| Local Foundry (`ForgeSmoke`, `RemediationRegression`, `ProtocolAdversarial`, `ProtocolInvariant`) | `forge test --no-match-path contracts/test/HashKeyForkPrototype.t.sol` | **40 / 40 passed** (`64` invariant runs x `80` depth, `0` reverts) |
| HashKey Mainnet Fork Lifecycle (`Chain ID 177`) | `forge test --match-path contracts/test/HashKeyForkPrototype.t.sol --fork-url https://mainnet.hsk.xyz` | **1 / 1 passed** (`2,332,194` gas) |
| TypeScript SDK (`@tranche/sdk`) | `cd sdk && npm test` | **2 / 2 passed** |
| HSP Adapter (`@tranche/hsp-adapter`) | `cd hsp && npm test` | **5 / 5 passed** |
| Execution Agent (`@tranche/agent`) | `cd agent && npm test` | **3 / 3 passed** |
| Demo E2E (`@tranche/demo`) | `cd demo && npm test` | **3 / 3 passed** |

### 1.3 Constructor, Initialization & Configuration Review
All Phase 2 constructor signatures, initialization wiring, and parameter snapshots were verified directly against the Solidity source in `contracts/src/` and automated in [`DeployTestnet.s.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/script/DeployTestnet.s.sol):

1. **Governance & Role Safes (Chain-133 canonical `SafeL2 v1.4.1` via `SafeProxyFactory v1.4.1`):**
   - **Governance Safe:** `3-of-5` threshold (`PROPOSER_ROLE` + `EXECUTOR_ROLE` on `TimelockController`).
   - **Security Guardian Safe:** `2-of-3` threshold (`CANCELLER_ROLE` on `TimelockController`; `guardian` on `LiquidityVault`, `CommitmentManager`, and `SignedPullOracle`).
   - **Treasury Safe:** `2-of-3` threshold (`feeCollector` on `LiquidityVault`).
   - **TimelockController:** OpenZeppelin v5 `TimelockController` (`minDelay = 300s` on testnet for operational exercise; `24h -> 48h` specified for mainnet).
2. **Contract Dependency & Wiring Order:**
   1. `LiquidityVault(deployer, guardianSafe, treasurySafe)`
   2. `CommitmentManager(deployer, vault, guardianSafe, 5)` (`protocolFeeBps = 5`, `0.05%`)
   3. `ExecutionTicket(manager)` -> `vault.setManager(manager)` & `manager.setTicketNft(ticketNft)`
   4. `ExecutionRouter(manager, 0x4200000000000000000000000000000000000006)`
   5. `SignedPullOracle(deployer, guardianSafe, [signer1, signer2, signer3], 2, 30)` (`2-of-3` quorum, `30s` TTL)
   6. `OraclePriceAdapter(deployer)`, `UniswapV3TwapOracle(deployer)`, `HSPComplianceHook(deployer, hspAttestationSigner)`
3. **Token Decimals, Minimums, Jumps & Oracle Hard Bounds:**

| Token / Pair | Decimals | `tokenMinTicketAmount` | `maxJumpBps` | `hardMinPriceX36` .. `hardMaxPriceX36` |
| --- | --- | --- | --- | --- |
| `WHSK` (`0x4200...0006`) | `18` | `10e18` (`10 WHSK`) | `500` (`WHSK/tUSDT`) | `1e21` .. `1e26` (`$0.001` .. `$100`) |
| `tUSDT` (`TestnetERC20`) | `6` | `1e6` (`1 tUSDT`) | N/A | Quote currency |
| `tWETH` (`TestnetERC20`) | `18` | `1e15` (`0.001 tWETH`) | `300` (`tWETH/tUSDT`) | `1e26` .. `1e29` (`$100` .. `$100,000`) |
| `tWBTC` (`TestnetERC20`) | `8` | `1e4` (`0.0001 tWBTC`) | `300` (`tWBTC/tUSDT`) | `1e37` .. `1e40` (`$1,000` .. `$1,000,000`) |

4. **Ownable2Step Handover Sequence:**
   - `DeployTestnet` calls `transferOwnership(timelock)` on all 6 admin-gated contracts (`LiquidityVault`, `CommitmentManager`, `SignedPullOracle`, `OraclePriceAdapter`, `UniswapV3TwapOracle`, `HSPComplianceHook`).
   - The `3-of-5` Governance Safe executes `TimelockController.scheduleBatch` + (after `minDelay`) `executeBatch` invoking `acceptOwnership()` across all 6 contracts, followed by `deployer.renounceRole(DEFAULT_ADMIN_ROLE, deployer)`.

---

## 2. Live Chain-133 Infrastructure Verification & Script Dry-Run

### 2.1 Chain-133 RPC Probe (`https://testnet.hsk.xyz`)
- Verified `cast chain-id` = **`133`**, sampled block = **`36166196`**, observed `cast gas-price` = **`1001000000` wei** (`1.001 gwei`).
- Verified deployed canonical bytecodes on Chain 133:
  - `WHSK` (`0x4200000000000000000000000000000000000006`): `2,865` bytes, `name()="Wrapped HashKey EcoPoints"`, `symbol()="WHSK"`, `decimals()=18`
  - `Multicall3` (`0xcA11bde05977b3631167028862be2a173976CA11`): `3,808` bytes
  - `SafeL2 v1.4.1` (`0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`): `24,421` bytes, `VERSION()="1.4.1"`
  - `SafeProxyFactory v1.4.1` (`0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`): `3,054` bytes
  - `SafeFallbackHandler v1.4.1` (`0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99`): `5,637` bytes

### 2.2 `DeployTestnet.s.sol` Chain-133 Fork Dry-Run
Executed without `--broadcast`:
```powershell
forge script contracts/script/DeployTestnet.s.sol --fork-url https://testnet.hsk.xyz
```
- **Result:** `Script ran successfully!`
- **Estimated Total Gas:** `25,300,880` gas (`0.05060176002530088 HSK` at `2.000000001 gwei`).
- **Predicted Dry-Run Manifest:** Stored in [deployments/hashkey-testnet.json](file:///c:/Users/USER/Desktop/Tranche/deployments/hashkey-testnet.json) under `forkDryRunAddresses`. Live `contracts` fields remain `null` until `--broadcast` runs.

---

## 3. Chain-133 Fork Validation Results (`TestnetOperationalValidation.t.sol`)

Executed directly against a live Chain-133 fork (`--fork-url https://testnet.hsk.xyz`):
```powershell
forge test --match-path contracts/test/TestnetOperationalValidation.t.sol --fork-url https://testnet.hsk.xyz -vv
```
**Result:** **5 / 5 passed** (`0` failed, `0` skipped)

| Test Case | Coverage Validated Against Chain-133 Safe v1.4.1 / WHSK / Multicall3 | Gas Used |
| --- | --- | --- |
| `test_Governance_TopologyHandoverRotationVetoAndTreasuryClaim` | `3-of-5` Governance Safe `execTransaction` -> `TimelockController` batch `acceptOwnership()` across all 6 contracts; `DEFAULT_ADMIN_ROLE` renounced; unauthorized EOA/deployer reverts; `2-of-3` Guardian `cancel()` veto of pending fee bump; atomic `3-contract` timelocked `setGuardian` rotation; `2-of-3` Treasury `acceptFeeCollector()` | `734,782` |
| `test_Oracle_MOfN_SignerRotationAndBounds` | Decimal-aware quotes on `WHSK/tUSDT` (`18/6`), `tWETH/tUSDT` (`18/6`), `tWBTC/tUSDT` (`8/6`); `1-of-3` `InsufficientSignatures` rejection; `>5%` `MaxJumpExceeded` rejection; `>30s` TTL expiration; timelocked `addSigner`/`removeSigner` rotation & removed-signer `InvalidSigner` rejection | `433,433` |
| `test_Oracle_GuardianRevokeAndFixedLiveness` | `2-of-3` Guardian `setFloatingExercisePaused(true)` + `revokePrice()`; `StaleTimestamp` replay protection on revoked quote; `FLOATING` exercise reverts `FloatingExercisePaused` while `FIXED` exercise & permissionless `reclaimExpired` remain 100% live (`INV-8`) | `1,396,306` |
| `test_Lifecycle_NativeWHSK_Permit_Split_PartialExercise_RouterBatch_TreasuryClaim` | Full LP & dual-Trader lifecycle: native `HSK -> WHSK` wrap, Vault deposit, `FIXED` + `FLOATING` offers, reservations, ERC-721 transfers + permit nonce increment on transfer, `splitTicket`, partial fill, EIP-712 `permit` + `ExecutionRouter.batchExercise` with native `HSK` unwrap, `reclaimExpiredBatchBestEffort` (`2/3`), Treasury Safe `withdrawProtocolFees`, LP `claimProceeds` + `withdrawFree`, vault solvency invariants | `1,959,840` |
| `test_Adversarial_Compliance_DuplicateKeeper_FeeToken_UnapprovedAdapters` | `HSPComplianceHook` rejections (unattested LP `createOffer`, unattested trader `reserve`, unattested `transferFrom` target, unattested `ExecutionRouter` `receiver`), revoked LP `INV-8` self-exit, duplicate keeper `reclaimExpiredBatchBestEffort` idempotency (`1` then `0`), fee-on-transfer `UnsupportedTokenBalanceDelta`, unapproved oracle `UnapprovedAdapter`, `Multicall3.aggregate3` accounting reconciliation | `1,902,850` |

### 3.1 Observed Lifecycle Gas Breakdown (`Chain 133 Fork`)
Measured via `gasleft()` inside `test_Lifecycle_NativeWHSK_Permit_Split_PartialExercise_RouterBatch_TreasuryClaim`:

| Operation | Measured Gas (`Chain 133 Fork`) |
| --- | --- |
| Canonical `WHSK.deposit{value}` (`HSK -> WHSK`) | `33,424` |
| `LiquidityVault.deposit` | `86,233` |
| `CommitmentManager.createOffer` | `201,456` |
| `CommitmentManager.reserve` | `409,915` |
| `CommitmentManager.splitTicket` | `249,042` |
| `CommitmentManager.exercise` (partial fill) | `56,675` |
| `ExecutionRouter.batchExercise` (`2` legs + native `HSK` unwrap) | `202,524` |
| `CommitmentManager.reclaimExpiredBatchBestEffort` (`2` reclaimed of `3` IDs) | `35,693` |

*Note:* Chainlink Data Streams is **not** integrated on Chain 133; credentials, feed IDs, and verification adapter remain unprovisioned (Section 3 constraint honored).

---

## 4. Exact Live Broadcast Procedure (Once Funded Testnet Keys & Secondary RPC Are Provisioned)

```powershell
# 1. Populate funded DEPLOYER_PRIVATE_KEY, independent Safe owner addresses (GOV_OWNER_1..5,
#    GUARDIAN_OWNER_1..3, TREASURY_OWNER_1..3), ORACLE_SIGNER_1..3, HSP_ATTESTATION_SIGNER
# 2. Deploy Safe proxies, TimelockController, core contracts, adapters, and testnet quote tokens:
forge script contracts/script/DeployTestnet.s.sol --rpc-url https://testnet.hsk.xyz --broadcast -vvvv

# 3. Execute 3-of-5 Governance Safe Timelock batch calling acceptOwnership() on all 6 admin contracts
#    and renounce deployer DEFAULT_ADMIN_ROLE on TimelockController.
# 4. Populate deployments/hashkey-testnet.json `contracts` map and set `"deploymentStatus": "LIVE_DEPLOYED"`.
# 5. Start continuous 72h soak & keeper runner:
cd scripts/testnet-ops
$env:KEEPER_PRIVATE_KEY="0x..."
$env:HASHKEY_TESTNET_RPCS="https://testnet.hsk.xyz,<SECONDARY_RPC_URL>"
npm run soak
```
