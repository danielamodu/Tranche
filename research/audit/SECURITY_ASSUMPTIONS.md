# Tranche — Security Assumptions, Trust Boundaries & Known Limitations

> **Audit Baseline:** `53dcf859da10f4d22dcdd2afa48d9882378165b6` (`testnet/phase3-validation`)

---

## 1. ERC-20 & Token Compatibility Assumptions

1. **Standard Balance-Preserving ERC-20s Only:**
   - `LiquidityVault._pullExact()` measures `balanceOf(vault)` before and after `safeTransferFrom` and reverts with `UnsupportedTokenBalanceDelta()` if `received != amount`.
   - **Fee-on-transfer tokens are rejected.**
   - **Rebasing tokens (positive or negative rebase) are NOT supported** and must never be used as `inventoryToken` or `paymentToken`; negative rebases would violate `INV-1` (`balanceOf < trackedBuckets`), and positive rebases would strand surplus tokens in the vault.
   - **Tokens with transfer hooks (ERC-777 / ERC-1363):** Protected by OpenZeppelin `ReentrancyGuard` across all state-mutating vault, manager, router, and segregator entrypoints, and `ExecutionTicket.mint` uses `_mint` (not `_safeMint`) to eliminate `onERC721Received` callbacks.
   - **Blacklistable Tokens (e.g., USDC/USDT):** `LiquidityVault` uses pull-based `claimProceeds()` so a blacklisted LP cannot DoS a trader's `exercise()` (`test_BlacklistedLP_DoesNotBlockTakerExercise`). However, if a trader's `receiver` is blacklisted by the underlying token contract, `exercise` reverts safely without corrupting vault accounting.
2. **Decimal Normalization (`PRICE_SCALE = 1e36`):**
   - Prices are denominated in raw token units scaled by `1e36`: `priceX36 = (rawPaymentUnits * 1e36) / rawInventoryUnits`.
   - Governance MUST configure `tokenMinTicketAmount[token]` and `OraclePriceAdapter.PairConfig` (`hardMinPriceX36`, `hardMaxPriceX36`) with exact awareness of `(inventoryDecimals, paymentDecimals)`. Misconfigured bounds can cause DoS or ineffective hard caps.

---

## 2. Oracle Trust & Operational Assumptions

1. **M-of-N Signer Independence (`SignedPullOracle`):**
   - Quorum (`2-of-3` testnet / `3-of-5` mainnet target) eliminates single-key compromise ONLY if each signer key resides in an independent security boundary (separate cloud accounts/HSMs and independent market-data fetchers).
   - Collusion of `>= threshold` signers can push prices within `maxJumpBps` per update and within `[hardMinPriceX36, hardMaxPriceX36]` (and within `maxDeviationBps` against secondary TWAP where `requireSecondaryCheck == true`).
2. **Secondary TWAP Availability (`UniswapV3TwapOracle`):**
   - On HashKey Chain Mainnet (`177`), Phase 1 analysis (`research/ORACLE_READINESS.md`) confirmed only `WHSK/USDT` (`~$839k` TVL) has sufficient depth for a V3 TWAP secondary check; thinner pools (`WETH/USDT`, `WBTC/USDT`) are susceptible to low-cost TWAP-skew DoS if `requireSecondaryCheck == true`.
   - On HashKey Chain Testnet (`133`), `requireSecondaryCheck = false` due to absence of deep V3 pools.
3. **Emergency Containment:**
   - On suspected oracle compromise, the `2-of-3` Security Guardian Safe executes `CommitmentManager.setFloatingExercisePaused(true)` and `SignedPullOracle.revokePrice(inv, pay)` in `< 60s`. `revokePrice` zeroes `priceX36` while preserving `updatedAt` so previously signed reports cannot be replayed.
   - `FIXED` ticket exercises, LP withdrawals, and expired ticket reclaims remain completely unaffected (`INV-8`).

---

## 3. Governance & Timelock Assumptions

1. **No EOA Admin Backdoors Post-Bootstrap:**
   - After initial wiring, `owner()` of all 6 admin-gated contracts MUST be `TimelockController`, and `deployer` MUST renounce `DEFAULT_ADMIN_ROLE` on `TimelockController`.
2. **Multisig Separation:**
   - `3-of-5` Governance Safe signers, `2-of-3` Security Guardian Safe signers, and `2-of-3` Treasury Safe signers are assumed to be independent, hardware-backed keys.
   - `TimelockController` delay (`24h` launch -> `48h` steady-state on mainnet; `300s` on testnet) provides an on-chain exit window for LPs and takers to react to any proposed parameter, adapter, or oracle-signer change via `CallScheduled` events.
3. **Guardian Blast-Radius Bound:**
   - A compromised `2-of-3` Guardian Safe can cause a liveness pause on new deposits, new reservations, and `FLOATING` exercises, or veto pending governance proposals (`CANCELLER_ROLE`), but cannot steal funds, alter fees, inject signers, or block LP exits. `3-of-5` Governance Safe can evict and replace the Guardian atomically via `TimelockController.executeBatch`.

---

## 4. Compliance Hook Assumptions (`HSPComplianceHook`)

1. **View-Only & Exit-Isolated:**
   - `IComplianceHook` is invoked only on entry/transfer/exercise (`beforeCreateOffer`, `beforeReserve`, `beforeTransfer`, `beforeExercise`).
   - It is **never** called on `withdrawFree`, `claimProceeds`, `decreaseOffer`, `cancelOffer`, or `reclaimExpired*` (`INV-8`).
2. **Allowlisted Hooks Only:**
   - `CommitmentManager.createOffer` rejects any non-zero `complianceHook` not in `approvedComplianceHooks`, neutralizing malicious LP honeypot hooks (`M-01`).
3. **Out-of-Band Attestation Signer:**
   - `HSPComplianceHook.attestationSigner` is trusted to issue EIP-712 `ComplianceAttestation` signatures only for KYC-verified addresses. Governance can rotate `attestationSigner` and call `revoke(subject)` via Timelock.

---

## 5. Known Limitations & Unimplemented Integrations

| Area | Current State | Mainnet Prerequisite |
| --- | --- | --- |
| **Live Testnet Deployment & 72h Soak** | Fork-verified on Chain 133 (`DeployTestnet.s.sol` dry-run + `5/5` fork tests); live `--broadcast` and 72h soak are **pending** funded testnet HSK keys and a secondary RPC (`research/INCIDENT_LOG.md`). | Complete live Chain-133 broadcast + 72h continuous soak. |
| **Chainlink Data Streams** | **Not integrated.** Verifier proxy exists on Chain 177, but credentials, feed IDs, and adapter contract are unprovisioned. | Provision API credentials & feed IDs, implement & audit adapter separately if adopted. |
| **Live HSP CaaS Settlement** | `hsp/` implements `LOCAL_EIP712_COMPLIANCE`; `LIVE_HSP_CAAS` throws `HSP_LIVE_UNAVAILABLE` without partner credentials. | Obtain HashKey HSP partner API credentials (strictly out-of-band, outside atomic settlement). |
| **Upgradeability** | Core contracts are **non-upgradeable**. Protocol migrations require deploying new contracts and letting existing offers/tickets settle or expire. | Intentional immutability trade-off to minimize governance custody risk. |
