# Tranche — Independent Security Audit Scope

> **Frozen Baseline Commit:** `53dcf859da10f4d22dcdd2afa48d9882378165b6` (`testnet/phase3-validation`)  
> **Production Contract Freeze Commit:** `76a85882d04af446e3e82d8421641a3769467c6e` (`remediation/mainnet-readiness`)  
> **Target Network:** HashKey Chain (OP Stack L2, Mainnet Chain ID `177`, Testnet Chain ID `133`)

---

## 1. Primary Audit Scope (In-Scope Production Contracts)

Total scope: **10 Solidity files (`2,248` total lines)** compiled with `solc 0.8.24` (`optimizer = true`, `optimizer_runs = 200`, `via_ir = false`, `evm_version = "shanghai"`).

### 1.1 Core Protocol Contracts (4 files, `1,287` lines)
1. **`contracts/src/LiquidityVault.sol` (`334` lines)**
   - 1:1 ERC-20 custody vault with 5 segregated accounting buckets (`lpFreeBalance`, `offerBalance`, `ticketReserved`, `lpPendingProceeds`, `protocolFees`).
   - Exact balance-delta verification (`_pullExact`), pull-based LP proceeds, two-step `feeCollector` handover, `Ownable2Step`, guardian `depositsPaused` (never pauses withdrawals or claims).
2. **`contracts/src/CommitmentManager.sol` (`683` lines)**
   - Offer lifecycle (`createOffer`, `topUpOffer`, `decreaseOffer`, `pauseOffer`, `unpauseOffer`, `cancelOffer`).
   - Reservation & ticket lifecycle (`reserve`, `exercise`, `exerciseFor`, `splitTicket`, `reclaimExpired`, `reclaimExpiredBatch`, `reclaimExpiredBatchBestEffort`).
   - Governance allowlists (`approvedOracles`, `approvedComplianceHooks`, `approvedRouters`), per-token minimums (`tokenMinTicketAmount`), snapshotted offer/ticket fee & fill terms, `guardian` pause switches (`newReservationsPaused`, `floatingExercisePaused`), `Ownable2Step`.
3. **`contracts/src/ExecutionTicket.sol` (`120` lines)**
   - Transferable ERC-721 representing reserved execution capacity; EIP-712 `permit()` with transfer-triggered nonce invalidation (`_update`) and `IComplianceHook.beforeTransfer` enforcement.
4. **`contracts/src/ExecutionRouter.sol` (`150` lines)**
   - Stateless batch multi-ticket exercise router with native `HSK` <-> `WHSK` wrap/unwrap, slippage guards, and trusted-router `exerciseFor` compliance attribution.

### 1.2 Shared Interfaces & Types (1 file, `290` lines)
5. **`contracts/src/interfaces/IProtocol.sol` (`290` lines)**
   - Structs (`Offer`, `Ticket`, `CreateOfferParams`), enums (`PriceMode`, `OfferStatus`, `TicketStatus`), and core/adapter interfaces.

### 1.3 Periphery & Adapter Contracts (5 files, `671` lines)
6. **`contracts/src/adapters/SignedPullOracle.sol` (`204` lines)**
   - M-of-N EIP-712 (`ProtocolSignedPullOracle` v2) pull oracle with strictly ascending signer recovery, internal `maxPriceAge` TTL, per-pair `maxJumpBps` cap, `Ownable2Step`, and guardian `revokePrice` preserving replay-blocking `updatedAt`.
7. **`contracts/src/adapters/OraclePriceAdapter.sol` (`103` lines)**
   - Primary/secondary oracle aggregator enforcing staleness (`maxStaleness`, `secondaryMaxStaleness`), hard bounds (`hardMinPriceX36`, `hardMaxPriceX36`), fail-closed `requireSecondaryCheck`, optional fallback, and `Math.mulDiv` deviation circuit breaker.
8. **`contracts/src/adapters/UniswapV3TwapOracle.sol` (`151` lines)**
   - HSKSwap V3 `observe()` TWAP reader with `minCardinality >= 2` guard and Q36 price scaling.
9. **`contracts/src/adapters/HSPComplianceHook.sol` (`94` lines)**
   - Optional view-only allowlist & revocable EIP-712 compliance hook (`ProtocolHSPCompliance` v1). Isolated from LP exits, offer cancellations, and expiry reclaims.
10. **`contracts/src/adapters/V3PositionSegregator.sol` (`119` lines)**
    - Stateless periphery helper to withdraw liquidity and/or accrued fees from an HSKSwap V3 `NonfungiblePositionManager` NFT and deposit directly into `LiquidityVault`.

---

## 2. Recommended Contextual Review (Non-Custodial)
- `contracts/script/DeployTestnet.s.sol` — Review constructor arguments, deployment order, Safe v1.4.1 proxy initialization (`3-of-5` Governance, `2-of-3` Guardian, `2-of-3` Treasury), `TimelockController` wiring, and `Ownable2Step` ownership handover.

---

## 3. Explicitly Out of Scope
- `contracts/src/ForgeSmoke.sol` and `contracts/src/mocks/TestnetERC20.sol` (non-production).
- Off-chain TypeScript packages (`sdk/`, `hsp/`, `agent/`, `demo/`, `scripts/testnet-ops/`).
- Third-party canonical contracts on HashKey Chain (`WHSK`, `HSKSwap V3`, `SafeL2 v1.4.1`, `Multicall3`, OpenZeppelin v5 library source).
- Unimplemented external integrations: Chainlink Data Streams verifier adapter (credentials/feed IDs not yet provisioned) and live HSP CaaS API endpoints.

---

## 4. Specific Audit Focus Areas Requested
1. **Custody & Accounting Conservation:** Verify `INV-1` through `INV-8` across partial fills, splits, rounding (`Math.Rounding.Ceil`), fee-on-transfer / non-standard ERC-20s, and reentrancy.
2. **Authorization & Compliance Attribution:** Verify `ExecutionRouter.batchExercise` -> `CommitmentManager.exerciseFor`, `ExecutionTicket.permit` + transfer nonce invalidation, and `splitTicket` owner vs. spender checks.
3. **Oracle & Emergency Circuit Breakers:** Verify `SignedPullOracle` M-of-N signature recovery/dedup, `maxJumpBps` math (including overflow / zero-price edge cases), `revokePrice` replay resistance, and `OraclePriceAdapter` fail-closed semantics.
4. **Economic & Cross-Decimal Edge Cases:** Verify `PRICE_SCALE = 1e36` precision across 6-, 8-, and 18-decimal tokens (`USDT`, `WBTC`, `WETH`, `WHSK`), dust-remainder prevention (`M-04`), and offer/ticket parameter snapshotting (`M-03`).
5. **Governance & Emergency Containment:** Verify `Ownable2Step` + `TimelockController` + Guardian pause isolation (`FIXED` execution, `withdrawFree`, `claimProceeds`, `cancelOffer`, and `reclaimExpired` remain permanently unblocked).
