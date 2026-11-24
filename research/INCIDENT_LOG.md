# Tranche — Phase 3 Testnet Incident & Blocker Log

> **Environment:** HashKey Chain Testnet (`Chain ID 133`)  
> **Branch:** `testnet/phase3-validation`

---

## Active Pre-Deployment Blockers & Architectural Deviations

### INC-001 — Missing Funded Testnet Deployer & Role Keys (Blocker for Live `--broadcast` & 72h Soak)
- **Severity:** Blocker (Execution Halted Before Live Broadcast)
- **Detected At:** 2026-11-24T12:17Z
- **Observation:** Environment inspection (`cast wallet list`, `.env*` scan, `Env:` scan) found zero Foundry keystores, zero deployer/keeper/oracle private keys, and zero funded Chain-133 accounts. Estimated live deployment cost on Chain 133 from `DeployTestnet.s.sol` dry-run is `0.05060176002530088 HSK` (`25,300,880` gas at `2.000000001 gwei`) plus Safe execution & keeper gas.
- **Mitigation / Action Required:** Provision `DEPLOYER_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`, distinct `GOV_OWNER_1..5`, `GUARDIAN_OWNER_1..3`, `TREASURY_OWNER_1..3`, `ORACLE_SIGNER_1..3`, and fund deployer/keeper/LP/trader accounts with testnet `HSK`, then run `forge script contracts/script/DeployTestnet.s.sol --rpc-url https://testnet.hsk.xyz --broadcast`.

### INC-002 — Secondary Public RPC Endpoints Unavailable on Chain 133
- **Severity:** Operational Risk (Single-RPC Dependency on Free Tier)
- **Detected At:** 2026-11-24T12:17Z
- **Observation:** Probed three Chain-133 RPC endpoints via `cast chain-id`:
  - `https://testnet.hsk.xyz` — **LIVE** (`chainId = 133`, sampled block `36166196`, gas price `1.001 gwei`).
  - `https://hashkeychain-testnet.alt.technology` — **FAILED** (DNS resolution `NXDOMAIN`, `os error 11001`).
  - `https://hashkey-testnet.drpc.org` — **BLOCKED** (`HTTP 400`, JSON-RPC `code 35`: `"chain is not available on free plan, please upgrade to paid plan"`).
- **Mitigation:** [`scripts/testnet-ops/src/rpc-failover.ts`](file:///c:/Users/USER/Desktop/Tranche/scripts/testnet-ops/src/rpc-failover.ts) implements multi-endpoint failover, cooldown, and automatic recovery (tested against simulated `429`/`503` outages + unreachable primary fallback). Before launching the live 72h soak, configure at least one paid/private backup RPC URL in `HASHKEY_TESTNET_RPCS`.

### INC-003 — Absence of Canonical Bridged Stablecoins / Deep V3 Pools / Chainlink Data Streams on Chain 133
- **Severity:** Documented Testnet Topology Deviation
- **Detected At:** 2026-11-24T12:18Z – 12:30Z
- **Observation:**
  - Canonical `WHSK` (`0x4200000000000000000000000000000000000006`, `2,865` bytes, `18` decimals) and Safe v1.4.1 / Multicall3 predeploys are live on Chain 133.
  - Canonical bridged `USDT`/`WETH`/`WBTC` and deep HSKSwap V3 TWAP pools present on Mainnet (`177`) do not have canonical Chain-133 parity; Chainlink Data Streams credentials/feed IDs are likewise unprovisioned.
- **Mitigation (Non-Silent Deviation):**
  - `DeployTestnet.s.sol` deploys clearly labeled `TestnetERC20` contracts (`tUSDT` 6 dec, `tWBTC` 8 dec, `tWETH` 18 dec) alongside live canonical `WHSK`.
  - Testnet `OraclePriceAdapter` pair configs intentionally set `requireSecondaryCheck = false` on Chain 133 while enforcing full `SignedPullOracle` `2-of-3` M-of-N EIP-712 quorum, `30s` max staleness, per-pair `maxJumpBps` (`300–500` bps), and decimal-aware `hardMinPriceX36` / `hardMaxPriceX36` bounds.
  - Mainnet (`177`) retains `requireSecondaryCheck = true` for `WHSK/USDT` backed by HSKSwap V3 TWAP.

---

## Automated Soak Alerts

*(Appended automatically by [`scripts/testnet-ops/src/soak-runner.ts`](file:///c:/Users/USER/Desktop/Tranche/scripts/testnet-ops/src/soak-runner.ts) when `LIVE_DEPLOYED` monitoring is active.)*
