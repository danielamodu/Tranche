# Tranche — HashKey Chain Liquidity Commitment Protocol

**Tranche** enables Liquidity Providers (LPs) on HashKey Chain to publish **inventory-backed, time-bounded execution commitments** that traders and execution agents can price, reserve upfront as transferable ERC-721 `ExecutionTicket`s, split, aggregate atomically, and exercise in **Floating Strike** (`oracle + spread`) or **Fixed Strike** (`K`) mode—with zero V3 tick-shift insolvency and zero price impact up to reserved depth.

---

## Problem & Wedge (Empirically Verified on HashKey Chain Mainnet `177`)

Direct on-chain analysis of HSKSwap V3 (`WHSK/USDT`, `WETH/USDT`, `WBTC/USDT`) over 14 days (blocks `29978347 -> 30583147`) shows:
- **100.00% of active V3 liquidity** sits in passive full-range `[-887220, +887220]` bands (`0.50%` of TVL within `±100 bps`).
- A `$10,000` buy suffers **`268.5 bps`** all-in cost on `WHSK/USDT`, **`2,421.6 bps` (`24.2%`)** on `WETH/USDT`, and **`2,235.7 bps` (`22.4%`)** on `WBTC/USDT`, while passive LPs earn only `0.19%–1.28%` APR.
- Existing retail DEX volume (`$3,146.68/day`) is small, so **Tranche** specifically targets **institutional, treasury, OTC, and agentic block tickets (`>= $1k` WETH/WBTC, `>= $5k` WHSK)**—turning passive inventory into verifiable, zero-impact execution capacity.

---

## Architecture Overview

```text
[HSKSwap V3 LP NFT] ──► [V3PositionSegregator] (optional 1-tx NFPM decreaseLiquidity + collect)
                              │
                              ▼
                      [LiquidityVault] (1:1 ERC-20 custody: free / offer / reserved / proceeds / fees)
                              ▲
                              │
                    [CommitmentManager] ◄──► [OraclePriceAdapter] (SignedPullOracle + V3 TWAP breaker)
                      │              ▲
                      ▼              │ (batchExercise + WHSK wrap/unwrap)
            [ExecutionTicket] ◄── [ExecutionRouter]
            (ERC-721 + Permit)
```

- **Core Contracts ([`contracts/src/`](file:///c:/Users/USER/Desktop/Tranche/contracts/src)):** `LiquidityVault`, `CommitmentManager`, `ExecutionTicket`, `ExecutionRouter`, plus periphery adapters `V3PositionSegregator`, `SignedPullOracle`, `UniswapV3TwapOracle`, `OraclePriceAdapter`, and optional `HSPComplianceHook` (never called on exits or expired reclaims).
- **TypeScript SDK ([`sdk/`](file:///c:/Users/USER/Desktop/Tranche/sdk)):** `@tranche/sdk` — artifact-backed `viem` client (`TrancheClient`), custom error decoder, and local Anvil deployer.
- **HSP Adapter ([`hsp/`](file:///c:/Users/USER/Desktop/Tranche/hsp)):** `@tranche/hsp-adapter` — explicit `LOCAL_EIP712_COMPLIANCE` attestations/mandates/receipts vs. `LIVE_HSP_CAAS` (`BLOCKED` without partner CaaS credentials; see [HSP_VERIFICATION.md](file:///c:/Users/USER/Desktop/Tranche/research/HSP_VERIFICATION.md)).
- **Execution Agent ([`agent/`](file:///c:/Users/USER/Desktop/Tranche/agent)):** `@tranche/agent` — deterministic offer discovery, scoring, reservation, partial/full exercise, and expiry recovery (`TrancheExecutionAgent`).
- **Demo UI & API ([`demo/`](file:///c:/Users/USER/Desktop/Tranche/demo)):** `@tranche/demo` — interactive 6-step web dashboard & Node HTTP backend running on local `anvil`.

---

## Verified HashKey Chain Mainnet Registry (Chain ID `177`)

No Tranche contracts are deployed to mainnet yet. Verified external infrastructure in [deployments/hashkey-mainnet.json](file:///c:/Users/USER/Desktop/Tranche/deployments/hashkey-mainnet.json):

| Contract | Address | Status |
| --- | --- | --- |
| `UniswapV3Factory` | `0x972cA9D1662F5e029cD18327D29026532E84c742` | `VERIFIED` |
| `SwapRouter02` | `0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3` | `VERIFIED` |
| `QuoterV2` | `0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD` | `VERIFIED` |
| `NonfungiblePositionManager` | `0xDF0A9b833Db0E4CeEa103A4408f3B68e7FC0cad5` | `VERIFIED` |
| `WHSK` (18 dec) | `0xB210D2120d57b758EE163cFfb43e73728c471Cf1` | `VERIFIED` |
| `USDT` (6 dec, non-proxy) | `0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029` | `VERIFIED` |
| `WHSK/USDT` Pool (`3000`) | `0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC` | `VERIFIED` |
| `ChainlinkDataStreamsVerifierProxy` | `0x3278e7a582B94d82487d4B99b31A511CbAe2Cd54` | `VERIFIED` (pull/API-gated) |

---

## Quickstart & Verification

See [DEMO_RUNBOOK.md](file:///c:/Users/USER/Desktop/Tranche/research/DEMO_RUNBOOK.md) for full details.

```powershell
# Smart contracts & adversarial/invariant suite (25 local tests)
forge test --no-match-contract HashKeyForkPrototypeTest -vv

# Mainnet-fork mechanical prototype against live HSKSwap V3 NFT #33 (1 test)
forge test --match-contract HashKeyForkPrototypeTest --fork-url https://mainnet.hsk.xyz --fork-block-number 30583147 -vv

# Launch the interactive 6-step Tranche web demo (http://localhost:3177)
cd demo; npm start
```

---

## Research & Evidence Archive

- [INFRASTRUCTURE_AUDIT.md](file:///c:/Users/USER/Desktop/Tranche/research/INFRASTRUCTURE_AUDIT.md) & [hashkey-mainnet.json](file:///c:/Users/USER/Desktop/Tranche/deployments/hashkey-mainnet.json)
- [ECONOMIC_MODEL.md](file:///c:/Users/USER/Desktop/Tranche/research/ECONOMIC_MODEL.md) & [scripts/market-analysis/](file:///c:/Users/USER/Desktop/Tranche/scripts/market-analysis)
- [PROTOCOL_ARCHITECTURE.md](file:///c:/Users/USER/Desktop/Tranche/research/PROTOCOL_ARCHITECTURE.md), [DECISIONS.md](file:///c:/Users/USER/Desktop/Tranche/research/DECISIONS.md), [THREAT_MODEL.md](file:///c:/Users/USER/Desktop/Tranche/research/THREAT_MODEL.md)
- [SECURITY_TEST_PLAN.md](file:///c:/Users/USER/Desktop/Tranche/research/SECURITY_TEST_PLAN.md)
- [PHASE2_RECONCILIATION.md](file:///c:/Users/USER/Desktop/Tranche/research/PHASE2_RECONCILIATION.md)
- [HSP_VERIFICATION.md](file:///c:/Users/USER/Desktop/Tranche/research/HSP_VERIFICATION.md)
- [PHASE5_INTEGRATION.md](file:///c:/Users/USER/Desktop/Tranche/research/PHASE5_INTEGRATION.md) & [DEMO_RUNBOOK.md](file:///c:/Users/USER/Desktop/Tranche/research/DEMO_RUNBOOK.md)
