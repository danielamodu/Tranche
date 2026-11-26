# Tranche Protocol — HashKey Chain Mainnet (Chain 177) Readiness Assessment

**Phase 7 Deliverable — Assessment Only (Zero Contracts Deployed, Zero Funds Moved, Zero Live Signing Enabled)**

---

## 1. Current State Distinction

- **Chain 133 (HashKey Chain Testnet):** All 15 Tranche contracts + 3 Safe v1.4.1 multisigs are **LIVE** (`deployments/hashkey-testnet.json`).
- **Chain 177 (HashKey Chain Mainnet):** **ZERO Tranche Protocol contracts are deployed.** Canonical tokens (`WHSK`, `USDT`, `WETH`, `WBTC`), `Multicall3`, `Safe v1.4.1`, and `HSKSwap V3` pools are live and verified; `DeployMainnet.s.sol` has been validated on a Chain 177 Anvil fork (`MainnetFork.t.sol`, `16,023,889 gas`).

---

## 2. Strict Contract Dependency Order (`DeployMainnet.s.sol`)

1. **Canonical Chain 177 Bytecode Verification:** `SafeL2 v1.4.1`, `SafeProxyFactory`, `SafeFallbackHandler`, `Multicall3`, `WHSK` (`0xB210...1Cf1`), `USDT` (`0xF1B5...9029`), `WETH` (`0xefd4...dfd0`), `WBTC` (`0x6119...5b14`), and 3 live `HSKSwap V3` 0.30% pools (`WHSK/USDT`, `WETH/USDT`, `WBTC/USDT`).
2. **Governance Safes & Timelock:**
   - `govSafe` (`3-of-5`), `guardianSafe` (`2-of-3`), `treasurySafe` (`2-of-3`).
   - `TimelockController` (`minDelay = 48 hours` steady-state; `PROPOSER_ROLE` & `EXECUTOR_ROLE` = `govSafe`; `CANCELLER_ROLE` = `guardianSafe`; deployer temp admin renounced).
3. **Core Protocol Stack:**
   - `LiquidityVault(deployer, guardianSafe, treasurySafe)`
   - `CommitmentManager(deployer, vault, guardianSafe, 5 bps)`
   - `ExecutionTicket(manager)`
   - `vault.setManager(manager)` & `manager.setTicketNft(ticketNft)`
   - `ExecutionRouter(manager, MAINNET_WHSK)`
4. **Oracle & Compliance Adapters:**
   - `SignedPullOracle(deployer, guardianSafe, 3 oracleSigners, threshold=2, maxPriceAge=30s)`
   - `OraclePriceAdapter(deployer)`
   - `UniswapV3TwapOracle(deployer)` wired to live Chain 177 pools (`window=1800s`, `minCardinality=2`)
   - `HSPComplianceHook(deployer, hspAttestationSigner)`
5. **Allowlists, Bounds & `Ownable2Step` Handover:**
   - Approve `oracleAdapter`, `twapOracle`, `complianceHook`, `router`.
   - Set decimal-aware `tokenMinTicketAmount` (`10 WHSK`, `1 USDT`, `0.0001 WBTC`, `0.001 WETH`), `maxJumpBps` (`500` WHSK, `300` WETH/WBTC), and dual-feed `OraclePriceAdapter` configs (`500 bps` pull-vs-TWAP circuit breaker).
   - Initiate `transferOwnership(timelock)` on all 6 admin-gated contracts, execute `acceptOwnership()` via `govSafe -> TimelockController`, and renounce deployer `DEFAULT_ADMIN_ROLE` on `TimelockController`.

---

## 3. Pre-Launch Deployment Checklist

- [ ] Fund deployer EOA with sufficient native HSK (`>= 10 HSK`; fork broadcast measured `16,023,889 gas`).
- [ ] Provision hardware-backed distinct signers: 5 Governance, 3 Guardian, 3 Treasury, 3 Oracle, 1 HSP Attestation (zero address reuse).
- [ ] Run dry-run fork simulation (`forge test --match-path contracts/test/MainnetFork.t.sol --fork-url https://mainnet.hsk.xyz -vv`).
- [ ] Broadcast `DeployMainnet.s.sol` with `WRITE_MAINNET_MANIFEST=true` and verify all contract sources on `https://explorer.hsk.xyz`.
- [ ] Complete `Ownable2Step.acceptOwnership()` on all 6 contracts via `govSafe` and confirm `deployer` holds zero admin/owner roles.
- [ ] Stand up 3 independent `SignedPullOracle` signer daemons (`2-of-3` quorum) + keeper for `reclaimExpired`.
- [ ] Seed initial LP inventory in `LiquidityVault` (recommended minimum: `>= $25k` per active pair on `WHSK/USDT`, `WETH/USDT`, `WBTC/USDT`) so Tranche beats HSKSwap V3 slippage at `$5k–$25k+` sizes.
- [ ] Update `web/src/config/networks.ts` (`NETWORKS.mainnet.isLive = true` + verified addresses) and EC2 `/etc/tranche-api/api.env` (`TRANCHE_*` addresses) only AFTER on-chain verification passes.
- [ ] Keep `autonomousMainnetSigningEnabled: false` until an independent audit of scoped session-key / smart-account delegation is complete.

---

## 4. Security, Emergency & Rollback Procedures

- **Emergency Pause (`2-of-3` Guardian Safe):** Can immediately pause new deposits, new reservations, and floating exercises without ever blocking `FIXED` ticket exercises, LP free withdrawals, or expiry reclaims (`INV-8`).
- **Oracle Circuit Breaker:** Guardian Safe can revoke compromised pull quotes; `OraclePriceAdapter` fails closed if pull vs. 30m V3 TWAP deviates `> 500 bps`.
- **Agent Kill Switch:** Persisted in `PositionStore` (`killSwitch: true`), immediately halting all agent proposals, approvals, and submissions; cannot be cleared via LLM or rollback.
- **Frontend / API Rollback:** Revert `NETWORKS.mainnet.isLive = false` in `web/src/config/networks.ts` and restore EC2 `/opt/tranche` from `/var/backups/tranche-deploy-*` without disturbing `tranche-soak.service` or persistence files.
