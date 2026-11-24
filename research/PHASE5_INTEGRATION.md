# Tranche — Phase 5 Integration Architecture & Verification Report

> **Project Name:** **Tranche**  
> **Target Network:** HashKey Chain Mainnet (Chain ID `177`, RPC `https://mainnet.hsk.xyz`)  
> **Execution Environment for Phase 5 Demos/Tests:** Isolated local `anvil` + HashKey Chain mainnet-fork read-only verification (`block 30583147`). No mainnet deployments or real fund transfers were performed.

---

## 1. End-to-End Architecture & Package Graph

Phase 5 connects the validated Phase 3/4 Solidity contracts (frozen and unmodified in [`contracts/src/`](file:///c:/Users/USER/Desktop/Tranche/contracts/src)) to four modular TypeScript ESM packages:

```text
  [demo/ (HTTP Server + 6-Step Dashboard)]
         │                 │
         ▼                 ▼
  [sdk/ (@tranche/sdk)]  [hsp/ (@tranche/hsp-adapter)]
         ▲                 │ (out-of-band EIP-712 attestations,
         │                 │  mandates & post-tx settlement receipts)
  [agent/ (@tranche/agent)]│
         │                 │
         └────────┬────────┘
                  ▼
     [Compiled Artifacts: out/*.json]
                  │
                  ▼
  [Tranche Core & Adapters (contracts/src/)]
   - LiquidityVault        - ExecutionTicket (ERC-721 + Permit)
   - CommitmentManager     - ExecutionRouter
   - V3PositionSegregator  - OraclePriceAdapter (SignedPullOracle + UniswapV3TwapOracle)
   - HSPComplianceHook (optional, isolated from exits/reclaims)
```

### Package Inventory
1. **`sdk/` (`@tranche/sdk`)** — [`sdk/src/`](file:///c:/Users/USER/Desktop/Tranche/sdk/src)
   - Loads ABIs and bytecodes directly from Foundry outputs in `out/` ([`abis.ts`](file:///c:/Users/USER/Desktop/Tranche/sdk/src/abis.ts)) so contract interfaces never drift.
   - `TrancheClient` ([`client.ts`](file:///c:/Users/USER/Desktop/Tranche/sdk/src/client.ts)): offer discovery (`discoverOffers`), ticket inspection (`discoverTickets`, `getTicket`), vault accounting (`getVaultState`), quoting (`quoteReservation`, `quoteExercise`), LP operations (`deposit`, `withdrawFree`, `claimProceeds`, `createOffer`, `topUpOffer`, `decreaseOffer`, `pauseOffer`, `unpauseOffer`, `cancelOffer`), trader operations (`reserve`, `transferTicket`, `splitTicket`, `exercise`, `batchExercise`, `reclaimExpired`, `reclaimExpiredBatch`), and EIP-712 pull-oracle signing (`signAndUpdatePullOraclePrice`).
   - `decodeTrancheError` ([`errors.ts`](file:///c:/Users/USER/Desktop/Tranche/sdk/src/errors.ts)): decodes custom Solidity errors across all Tranche contracts and standard ERC-20/ERC-721 reverts.
   - `deployLocalTrancheStack` ([`deploy.ts`](file:///c:/Users/USER/Desktop/Tranche/sdk/src/deploy.ts)): deploys the full protocol stack plus test `MockWHSK` and `MockERC20` (`USDT`, 6 decimals) onto a local `anvil` instance.
2. **`hsp/` (`@tranche/hsp-adapter`)** — [`hsp/src/`](file:///c:/Users/USER/Desktop/Tranche/hsp/src)
   - Detailed endpoint/spec audit in [`research/HSP_VERIFICATION.md`](file:///c:/Users/USER/Desktop/Tranche/research/HSP_VERIFICATION.md).
   - `TrancheHSPAdapter` ([`hsp-adapter.ts`](file:///c:/Users/USER/Desktop/Tranche/hsp/src/hsp-adapter.ts)) enforces strict separation between `LOCAL_EIP712_COMPLIANCE` and `LIVE_HSP_CAAS`:
     - **`LOCAL_EIP712_COMPLIANCE`:** Signs EIP-712 `ComplianceAttestation(address subject,uint256 nonce,uint256 expiry)` matching `HSPComplianceHook.sol` (`ProtocolHSPCompliance` v1), submits on-chain `submitAttestation(...)`, generates pre-trade `HSPMandate` envelopes, and produces verifiable `HSPSettlementReceipt` records bound to real EVM tx hashes.
     - **`LIVE_HSP_CAAS`:** Requires partner-provisioned CaaS credentials (`apiBaseUrl`, `apiKey`, `apiSecret`). Without credentials, fails explicitly with `HSP_LIVE_UNAVAILABLE` rather than fabricating a live settlement.
     - **Atomic Isolation (`INV-8`):** HSP is never invoked inside `LiquidityVault` or on `withdrawFree`, `claimProceeds`, `cancelOffer`, or `reclaimExpired`.
3. **`agent/` (`@tranche/agent`)** — [`agent/src/`](file:///c:/Users/USER/Desktop/Tranche/agent/src)
   - `TrancheExecutionAgent` ([`agent.ts`](file:///c:/Users/USER/Desktop/Tranche/agent/src/agent.ts)): deterministic policy-driven execution engine (no uncontrolled autonomous trading).
   - Discovers offers via `TrancheClient`, filters by pair, mode, expiry, capacity, minimum fill size, duration bounds, and oracle health (`quoteReservation` error decoding), ranks eligible offers by lowest effective all-in unit cost (`(grossPremium + exerciseGrossPayment) / targetAmount`), reserves tickets, performs partial/full exercises, handles expiry/error recovery, and records an auditable `AgentDecisionTrace`.
4. **`demo/` (`@tranche/demo`)** — [`demo/src/`](file:///c:/Users/USER/Desktop/Tranche/demo/src) & [`demo/public/`](file:///c:/Users/USER/Desktop/Tranche/demo/public)
   - `TrancheDemoSession` ([`engine.ts`](file:///c:/Users/USER/Desktop/Tranche/demo/src/engine.ts)) + zero-dependency `node:http` server ([`server.ts`](file:///c:/Users/USER/Desktop/Tranche/demo/src/server.ts)) + dark-slate dashboard ([`index.html`](file:///c:/Users/USER/Desktop/Tranche/demo/public/index.html)).
   - Demonstrates the complete 6-step lifecycle interactively or in one click (`POST /api/run-all`), rendering real tx hashes, block numbers, gas used, Vault bucket accounting (`lpFree`, `offerAvailable`, `ticketReserved`, `lpPendingProceeds`, `protocolFees`, `balanceOf`), Ticket states, `LOCAL_EIP712_COMPLIANCE` HSP status, and live `INV-1` Physical Vault Solvency checks.

---

## 2. Production Readiness & Honest Boundaries

| Component | Status in Phase 5 | Production / Mainnet Requirement |
| --- | --- | --- |
| **Core Smart Contracts (`contracts/src/`)** | `VERIFIED` (25 local tests + mainnet-fork prototype) | Audited & unchanged from Phase 4; ready for testnet/mainnet deployment only upon explicit human approval. |
| **HSKSwap V3 Onboarding (`V3PositionSegregator`)** | `VERIFIED` (mainnet fork block `30583147`) | Tested against live `NFPM` (`0xDF0A...cad5`) & real LP NFT `tokenId = 33`. |
| **Oracle Stack (`SignedPullOracle` + `UniswapV3TwapOracle`)** | `VERIFIED` locally & on fork (`WHSK/USDT` TWAP live; pull oracle signed locally) | Chainlink Data Streams `VerifierProxy` (`0x3278...Cd54`) is live on chain `177` (`VERIFIED`), but production DON report streaming requires Chainlink Data Streams API credentials & feed ID provisioning (`UNVERIFIED`). |
| **HSP Compliance & Settlement (`TrancheHSPAdapter`)** | `LOCAL_EIP712_COMPLIANCE` verified end-to-end; `LIVE_HSP_CAAS` explicitly `BLOCKED` | Live HashKey CaaS / HSP endpoints require institutional KYB/KYC onboarding, IP/wallet whitelisting, and HMAC/ES256K credentials. |

---

## 3. Verified Regression Suite Summary

All checks below ran after the final Phase 5 code changes:

- **Foundry Local Unit, Adversarial & Invariant Suite (`forge test --no-match-contract HashKeyForkPrototypeTest -vv`):** `25/25` passed (`1` smoke, `21` adversarial tests covering all 13 threat vectors, `3` stateful invariants across `64 runs x 80 depth = 5,120` calls each).
- **Foundry HashKey Chain Mainnet-Fork Prototype (`forge test --match-contract HashKeyForkPrototypeTest --fork-url https://mainnet.hsk.xyz --fork-block-number 30583147 -vv`):** `1/1` passed (`test_Fork_FullLifecycle_V3WithdrawSegregateReserveTransferPartialExerciseReclaim`).
- **SDK (`sdk/`):** `npx tsc --noEmit` exited `0`; `npm run build` exited `0`; `npm test` (`2/2` passed); `npm run example` exited `0`.
- **HSP Adapter (`hsp/`):** `npx tsc --noEmit` exited `0`; `npm test` (`5/5` passed).
- **Agent (`agent/`):** `npx tsc --noEmit` exited `0`; `npm test` (`3/3` passed); `npm run demo` exited `0`.
- **Demo Backend & UI (`demo/`):** `npx tsc --noEmit` exited `0`; `npm test` (`3/3` passed).
