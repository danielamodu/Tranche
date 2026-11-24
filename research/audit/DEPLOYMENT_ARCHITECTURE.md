# Tranche — Deployment & Governance Architecture

> **Audit Baseline:** `53dcf859da10f4d22dcdd2afa48d9882378165b6` (`testnet/phase3-validation`)  
> **Reference Script:** [`contracts/script/DeployTestnet.s.sol`](../../contracts/script/DeployTestnet.s.sol)  
> **Manifests:** [`deployments/hashkey-mainnet.json`](../../deployments/hashkey-mainnet.json) (external infra only) · [`deployments/hashkey-testnet.json`](../../deployments/hashkey-testnet.json) (fork-verified, pending live broadcast)

---

## 1. Contract Topology & Dependency Graph

```text
  [3-of-5 Governance Safe (SafeL2 v1.4.1)]
        │  PROPOSER_ROLE / EXECUTOR_ROLE
        ▼
  [TimelockController] ◄──── CANCELLER_ROLE ──── [2-of-3 Security Guardian Safe (SafeL2 v1.4.1)]
        │  owner() via Ownable2Step                     │  guardian (pause / revokePrice only)
        ├──────────────────────────┬────────────────────┼───────────────────┐
        ▼                          ▼                    ▼                   ▼
  [LiquidityVault] ◄──────► [CommitmentManager] ◄── [OraclePriceAdapter]  [HSPComplianceHook]
    ▲           ▲                  │   ▲                │          │
    │           │                  ▼   │                ▼          ▼
    │    [2-of-3 Treasury]  [ExecutionTicket]    [SignedPullOracle] [UniswapV3TwapOracle]
    │     (feeCollector)     (ERC-721+Permit)      (2-of-3 / 3-of-5)
    │                              ▲
  [V3PositionSegregator]    [ExecutionRouter] (stateless batchExercise + WHSK wrap/unwrap)
```

---

## 2. Deployment & Initialization Sequence

1. **Governance & Role Safes (Canonical `SafeProxyFactory v1.4.1` + `SafeL2 v1.4.1`):**
   - `govSafe`: 5 distinct owners, threshold `3`.
   - `guardianSafe`: 3 distinct owners, threshold `2`.
   - `treasurySafe`: 3 distinct owners, threshold `2`.
2. **Timelock:**
   - `TimelockController(minDelay, [govSafe], [govSafe], deployer)` (`minDelay = 300s` on testnet; `86,400s -> 172,800s` on mainnet).
   - `timelock.grantRole(CANCELLER_ROLE, guardianSafe)`.
3. **Core Protocol Contracts (Exact Dependency Order):**
   1. `LiquidityVault(deployer, guardianSafe, treasurySafe)`
   2. `CommitmentManager(deployer, vault, guardianSafe, 5)` (`protocolFeeBps = 5`, `0.05%`)
   3. `ExecutionTicket(manager)`
   4. One-time immutable wiring: `vault.setManager(manager)` and `manager.setTicketNft(ticketNft)` (both revert on second call).
   5. `ExecutionRouter(manager, WHSK)` (constructor verifies `address(manager.ticketNft()) != address(0)` and `address(manager.vault()) != address(0)`).
4. **Oracle & Compliance Adapters:**
   6. `SignedPullOracle(deployer, guardianSafe, initialSigners, threshold, maxPriceAge=30)`
   7. `OraclePriceAdapter(deployer)`
   8. `UniswapV3TwapOracle(deployer)`
   9. `HSPComplianceHook(deployer, hspAttestationSigner)`
5. **Initial Allowlists & Decimal-Aware Parameters:**
   - `manager.setApprovedOracle(oracleAdapter, true)`
   - `manager.setApprovedComplianceHook(complianceHook, true)`
   - `manager.setApprovedRouter(router, true)`
   - `manager.setTokenMinTicketAmount(token, minAmount)` per token decimals.
   - `pullOracle.setMaxJumpBps(inv, pay, maxJumpBps)` and `oracleAdapter.setPairConfig(inv, pay, cfg)`.
6. **Zero-Backdoor Ownership Handover (`Ownable2Step`):**
   - `deployer` calls `transferOwnership(address(timelock))` on all 6 admin contracts (`LiquidityVault`, `CommitmentManager`, `SignedPullOracle`, `OraclePriceAdapter`, `UniswapV3TwapOracle`, `HSPComplianceHook`).
   - `govSafe` (`3-of-5`) schedules and executes a single `TimelockController.executeBatch` calling `acceptOwnership()` on all 6 contracts.
   - `deployer` calls `timelock.renounceRole(DEFAULT_ADMIN_ROLE, deployer)`.
   - Post-handover invariants verified on-chain: `owner() == address(timelock)` across all 6 contracts, `timelock.hasRole(DEFAULT_ADMIN_ROLE, deployer) == false`, `guardian == guardianSafe` across Vault/Manager/PullOracle, and `feeCollector == treasurySafe`.

---

## 3. Verified External Infrastructure Addresses

### HashKey Chain Mainnet (`Chain ID 177`) — No Tranche Contracts Deployed
- `WHSK` (18 dec): `0xB210D2120d57b758EE163cFfb43e73728c471Cf1`
- `USDT` (6 dec): `0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029`
- `Multicall3`: `0xcA11bde05977b3631167028862be2a173976CA11`
- `HSKSwap V3 Factory`: `0x972cA9D1662F5e029cD18327D29026532E84c742`
- `HSKSwap V3 NonfungiblePositionManager`: `0xDF0A9b833Db0E4CeEa103A4408f3B68e7FC0cad5`
- `WHSK/USDT` V3 Pool (`3000`): `0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC`

### HashKey Chain Testnet (`Chain ID 133`) — Fork-Verified, Live Broadcast Pending
- `WHSK` (18 dec): `0x4200000000000000000000000000000000000006`
- `Multicall3`: `0xcA11bde05977b3631167028862be2a173976CA11`
- `SafeL2 v1.4.1`: `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`
- `SafeProxyFactory v1.4.1`: `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`
- `SafeFallbackHandler v1.4.1`: `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99`
