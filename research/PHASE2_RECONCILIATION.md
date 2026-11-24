# Phase 2 Cross-Workstream Reconciliation & Architecture Selection

> **Internal Product Name:** **the protocol**  
> **Target Network:** HashKey Chain Mainnet (Chain ID `177`, RPC `https://mainnet.hsk.xyz`)  
> **Verification Standard:** Every claim below is tagged `[VERIFIED]`, `[INFERRED]`, `[ASSUMED]`, or `[UNVERIFIED]`.

---

## 1. Executive Summary

Phase 1 executed four parallel workstreams against live HashKey Chain mainnet state and formal protocol security criteria. Cross-checking Workstreams A, B, C, and D resolved **three material contradictions** and verified `PUSH0` (`shanghai`) EVM support on chain `177`:

1. **Custody vs. V3 Integration Reconciliation:** Keeping active/reserved commitment inventory inside Uniswap/HSKSwap V3 ticks (Arch 2) fails under price drift and fails economically (`0.19%–1.28%` passive LP APR `[INFERRED]` vs `$0.01724` exit+redeploy gas `[VERIFIED]`/`[INFERRED]`). However, LPs on HashKey Chain already hold liquidity in HSKSwap V3 NFTs (`totalSupply = 21`, e.g. `tokenId = 33, 34, 35` `[VERIFIED]`). We therefore keep `LiquidityVault` **100% 1:1 ERC-20 segregated** (Arch 4) and add a stateless **`V3PositionSegregator` periphery adapter** that atomically calls `decreaseLiquidity` + `collect` on `NonfungiblePositionManager` (`0xDF0A9b833Db0E4CeEa103A4408f3B68e7FC0cad5` `[VERIFIED]`) and deposits resulting tokens into `LiquidityVault`.
2. **Oracle Reconciliation (Workstream A vs. Workstream B):** Workstream A verified that **zero permissionless push price feeds** (Chainlink `AggregatorV3Interface`, Pyth, RedStone, API3, Chronicle) exist on chain `177` (`[NOT_FOUND]`), leaving only `ChainlinkDataStreamsVerifierProxy` (`0x3278...Cd54`, pull-based `[VERIFIED]`) and HSKSwap V3 `observe()` TWAP (`observationCardinality = 240` on `WHSK/USDT`, `WETH/USDT`, `WBTC/USDT` `[VERIFIED]`). Workstream B proved that `WETH/USDT` (`1.94h` mean inter-swap gap) and `WBTC/USDT` (`16.0h` mean inter-swap gap) make **sole reliance on HSKSwap V3 TWAP unsafe for Floating Strike** (`12–25+ bps` staleness toxicity `[INFERRED]`). We reconcile this with `OraclePriceAdapter`: a `<= 30s` EIP-712 pull oracle (`SignedPullOracle`, interface-compatible with upgrading to Chainlink Data Streams reports) as **primary**, paired with `UniswapV3TwapOracle` (`observe([1800, 0])`) as an **optional deviation circuit breaker** on deep pools (`WHSK/USDT`).
3. **Token, EVM & HSP Reconciliation:** `USDT` (`0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029`, 6 dec, non-proxy OP Stack `OptimismMintableERC20`, no blacklist/pause/FoT `[VERIFIED]`) is adopted as canonical quote/settlement token—**not** `USDC.e` (`1,796.54` total supply, ZeppelinOS upgradeable proxy with `paused()`/`isBlacklisted()`, `$0.14` pool `[VERIFIED]`). No canonical on-chain HSP singleton exists on chain `177` (`[NOT_FOUND]`), validating Workstream C's optional `IComplianceHook` (`HSPComplianceHook`) boundary.

---

## 2. Contradiction & Blocker Resolution Matrix

| # | Cross-Workstream Contradiction / Gap | Source Evidence | Resolution Adopted for Phase 3 & 4 |
| --- | --- | --- | --- |
| **C-1** | **V3 NFT Custody vs. Segregated ERC-20 Solvency:** Phase 3 requires withdrawing liquidity from a real HSKSwap V3 NFT (`tokenId = 33`), whereas Workstream C rejected holding V3 NFTs inside `LiquidityVault` (`ADR-001`, `T5.1`). | `[VERIFIED]` `NFPM` (`0xDF0A...cad5`) holds 21 active positions; `[INFERRED]` passive V3 APR is only `0.19%–1.28%` while V3 exit+redeploy gas is `$0.01724`. | Core `LiquidityVault` holds **strictly 1:1 ERC-20 segregated inventory** (`INV-1`). Stateless `V3PositionSegregator` executes `decreaseLiquidity` + `collect` on real HSKSwap V3 NFTs and deposits resulting `token0`/`token1` via `vault.depositFor(msg.sender, ...)`. |
| **C-2** | **On-Chain Oracle Availability vs. Staleness Toxicity:** Workstream A found only `ChainlinkDataStreamsVerifierProxy` (pull, API-gated) + V3 TWAP (`obsCard = 240`), whereas Workstream B showed V3 TWAP leaks `12–25+ bps` on `WETH/USDT` (`1.94h` swap gap) and `WBTC/USDT` (`16h` swap gap). | `[VERIFIED]` `0x3278...Cd54` live; `0` bytes at Chainlink push/Pyth/RedStone/API3/Chronicle; `[VERIFIED]` 14d swap timestamps; `[INFERRED]` latency toxicity model. | Implement `SignedPullOracle` (`<= 30s` `maxStaleness`, EIP-712 domain-bound, monotonic timestamp) as primary `IPriceOracle` for `FLOATING`, plus `UniswapV3TwapOracle` (`observe()`, cardinality guard) as secondary circuit breaker (`maxDeviationBps`) on `WHSK/USDT`. |
| **C-3** | **Quote Token Selection (`USDT` vs `USDC.e`):** Specs often assume `USDC`, but `USDC.e` on chain `177` is illiquid and upgradeable/blacklistable. | `[VERIFIED]` `USDT` (`0xF1B5...9029`) has `~1.17M` supply, non-proxy `OptimismMintableERC20`, no pause/blacklist, and `$1.01M` pool TVL across `WHSK/USDT`, `WETH/USDT`, `WBTC/USDT`. `USDC.e` (`0x054e...8D0a`) has `1,796` supply and ZeppelinOS proxy with `paused()` + `isBlacklisted()`. | Target **`USDT`** (`0xF1B5...9029`) as canonical quote token for all launch pairs (`WHSK/USDT`, `WETH/USDT`, `WBTC/USDT`), while still retaining `lpPendingProceeds` pull settlement & `UnsupportedTokenBalanceDelta` checks against exotic tokens. |
| **C-4** | **HSP Compliance Singleton Missing On-Chain:** Workstream C assumed an HSP registry may exist; Workstream A found `NOT_FOUND` on chain `177`. | `[NOT_FOUND]` No canonical HSP contract on chain `177`; `[VERIFIED via docs/repos]` HSP uses off-chain CaaS + EIP-712 mandates + app-specific adapters. | Implement `HSPComplianceHook` as an optional `view` `IComplianceHook` supporting allowlist + revocable EIP-712 attestations (`chainId`, `verifyingContract`, `subject`, monotonic `nonce`, `expiry`). Core exits/reclaims never call it (`INV-8`). |
| **C-5** | **Retail DEX Volume Kill Criteria (`KC-1`/`KC-2` Fail):** 14d DEX volume is `$3,146.68/day` with `0` swaps `>= $5,000`. | `[VERIFIED]` 1,241 swaps in 14d (`p50=$15` WHSK, `$100` WETH, `$507` WBTC); `[INFERRED]` `$10k` AMM cost = `268.5` bps (WHSK), `2,421.6` bps (WETH), `2,235.7` bps (WBTC). | Narrow product wedge explicitly to **institutional / treasury / OTC block tickets (`>= $1k` WETH/WBTC, `>= $5k` WHSK)** with `FLOATING` (`spread >= 15–25 bps`) as primary spot execution mode and `FIXED` (`upfront BS premium`) for short-tenor (`1h–24h`) or OTM structured commitments. |
| **C-6** | **`PUSH0` (`shanghai`) Support (`ADR-012`):** Needed verification before compiling `0.8.24` (`shanghai`) for HashKey Chain. | `[VERIFIED]` `cast call --rpc-url https://mainnet.hsk.xyz --create 0x5f60005260206000f3` executed `PUSH0` and returned `0x000...000` with exit code `0`. | Keep `solc_version = "0.8.24"` and `evm_version = "shanghai"` in `foundry.toml`. |

---

## 3. Verified Deployment & Target Parameter Baseline (`Chain ID 177`)

| Component | Address (`[VERIFIED]`) | Protocol Role |
| --- | --- | --- |
| `UniswapV3Factory` | `0x972cA9D1662F5e029cD18327D29026532E84c742` | Pool discovery verification |
| `NonfungiblePositionManager` | `0xDF0A9b833Db0E4CeEa103A4408f3B68e7FC0cad5` | Source of LP V3 NFTs for `V3PositionSegregator` (e.g. `tokenId = 33`) |
| `SwapRouter02` / `QuoterV2` | `0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3` / `0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD` | Reference AMM routing / slippage benchmark |
| `WHSK` (18 dec) | `0xB210D2120d57b758EE163cFfb43e73728c471Cf1` | Base inventory token & native `HSK` wrapper in `ExecutionRouter` |
| `USDT` (6 dec) | `0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029` | Primary quote/payment token |
| `WETH` (18 dec) / `WBTC` (8 dec) | `0xefd4bC9afD210517803f293ABABd701CaeeCdfd0` / `0x6119CA49a79f5825C8B345F8d7aC36B272565b14` | Institutional base inventory tokens |
| `WHSK/USDT` V3 Pool (`3000`) | `0x4ff515761864e7838b0adb8b5b2b8b7a068905dc` | Secondary TWAP sanity check (`observationCardinality = 240`) |
| `ChainlinkDataStreamsVerifierProxy` | `0x3278e7a582B94d82487d4B99b31A511CbAe2Cd54` | Future production pull-report upgrade target |

---

## 4. Recommended Final Architecture (Phase 3 & 4 Build Target)

```text
[HSKSwap V3 LP NFT (NFPM)]
          │  (1-tx withdraw & segregate via V3PositionSegregator)
          ▼
   [LiquidityVault]  ◄── 1:1 ERC-20 Segregated Custody (5 buckets, pull proceeds, FoT guard)
          ▲
          │  (allocate / reserve / split / settle / release)
  [CommitmentManager] ◄── Dual-Mode (FIXED & FLOATING), immutable ticket snapshot, asymmetric rounding
     │           │
     │           ├──► [OraclePriceAdapter] ──► [SignedPullOracle (<=30s)] + [UniswapV3TwapOracle breaker]
     │           └──► [HSPComplianceHook]  ──► Optional view-only attestations (never on exits/reclaims)
     ▼
[ExecutionTicket (ERC-721 + EIP-712 Permit + dynamic tokenURI)]
     ▲
     │  (isAuthorized check on EVERY leg + WHSK wrap/unwrap)
[ExecutionRouter] ──► Atomic multi-ticket batchExercise()
```

### Hard Security & Invariant Commitments Carried into Phase 3/4
- `INV-1` Physical Vault Solvency (`balanceOf >= sum of all accounted buckets`)
- `INV-2` Bucket Sum Consistency (`lpFree + offerAvailable + ticketReserved + lpPendingProceeds + protocolFees`)
- `INV-3` Cross-Contract Ticket Reservation Mirror (`ACTIVE => remainingAmount == vault.ticketReserved[id] > 0`)
- `INV-4` ERC-721 Existence Equivalence (`ownerOf(id)` exists iff `status == ACTIVE`)
- `INV-5` Split Notional & Expiry Conservation
- `INV-6` Fee Conservation (`lpNet + protocolFee == gross` with `Ceil` payment / `Floor` fee)
- `INV-7` Router Zero-Residue & Mandatory `isAuthorized(msg.sender, ticketId)` per leg
- `INV-8` Non-Lockup Liveness (`withdrawFree`, `claimProceeds`, `decreaseOffer`, `cancelOffer`, `reclaimExpired` never blocked by pause, oracle outage, or compliance hook revert)
