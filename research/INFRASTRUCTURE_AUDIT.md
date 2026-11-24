# HashKey Chain Mainnet (Chain ID 177) — Live Infrastructure Audit

**Scope:** Workstream A infrastructure verification for **the protocol** on HashKey Chain Mainnet (`https://mainnet.hsk.xyz`, Chain ID `177`).  
**Verification standard:** Every claim below is tagged `[VERIFIED]`, `[INFERRED]`, `[ASSUMED]`, or `[UNVERIFIED]` / `[NOT_FOUND]`. Addresses are marked `[VERIFIED]` **only** when non-empty bytecode (`cast code` / `eth_getCode`) and direct RPC view calls succeeded against `https://mainnet.hsk.xyz`.

---

## 1. Network, RPC, and Block Timing

| Parameter | Value | Status | Evidence |
| --- | --- | --- | --- |
| Network Name | HashKey Chain Mainnet (OP Stack L2) | `[VERIFIED]` | Official docs + OP Stack `L2StandardBridge` `0x4200...0010` referenced by bridged tokens |
| Chain ID | `177` (`0xb1`) | `[VERIFIED]` | `cast chain-id --rpc-url https://mainnet.hsk.xyz` returned `177` |
| Sampled Block Height | `30582918` (timestamp `1795512971`) | `[VERIFIED]` | `cast block-number` & `eth_getBlockByNumber` |
| Recent Block Cadence | Exact `2.0000s` per block | `[VERIFIED]` | Sampled 15 consecutive blocks `30582904..30582918` (`ts=1795512943..1795512971`, `+2s` every block) |
| Long-Window Block Cadence | Exact `2.0000s` per block | `[VERIFIED]` | `30572918` (`ts=1795492971`), `30482918` (`ts=1795312971`), `29582918` (`ts=1793512971`) -> `2.0000s` across 10k, 100k, and 1M blocks |

### RPC Operational Findings
- `[VERIFIED]` **Archive node support:** `eth_getCode` at historical blocks succeeds (`Factory` deployment binary-searched to block `17359296`).
- `[VERIFIED]` **`eth_getLogs` range cap:** `https://mainnet.hsk.xyz` rejects wide log queries with HTTP 400 (`query exceeds max block range 100000` / `block range too large` even at 10,000-block ranges). Multi-block log scans must use small windows (<= 2,000 blocks) or rely on `Factory.getPool()` / `NonfungiblePositionManager.tokenByIndex()`.
- `[VERIFIED]` **Rate limits & payload caps:** Rapid sequential RPC bursts trigger HTTP `429 Too Many Requests`, and oversized `Multicall3` payloads trigger HTTP `413 Payload Too Large`. Batching `<= 35` calls per `Multicall3.aggregate3()` with ~350 ms pacing succeeds reliably.
- `[VERIFIED]` **Subgraph DNS status:** `https://graphnode.hashkeychain.net/subgraphs/name/hskdex-subgraph` (configured in `@hskswap/smart-order-router@1.0.4`) failed DNS resolution (`getaddrinfo failed`) during this audit; do **not** depend on subgraph availability in production or scripts.

---

## 2. HSKSwap (Uniswap V3 Fork) & Core Infrastructure

All core HSKSwap addresses were sourced from the published `@hskswap/sdk-core@1.0.3` and `@hskswap/universal_router_sdk@1.0.4` npm packages and independently verified on-chain via `https://mainnet.hsk.xyz`.

| Contract | Address | Status | Source | On-Chain RPC / `cast` Evidence |
| --- | --- | --- | --- | --- |
| `UniswapV3Factory` | `0x972cA9D1662F5e029cD18327D29026532E84c742` | `[VERIFIED]` | `@hskswap/sdk-core@1.0.3` (`v3CoreFactoryAddress`) | `code_bytes=24535` (`cast code` len `49072`); deployed block `17359296`; `owner()=0xfbA0676Bbd968738e9AA1c7bDc8E2EF7d80E15dA`; `feeAmountTickSpacing`: `100->1`, `500->10`, `3000->60`, `10000->200` |
| `SwapRouter02` | `0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3` | `[VERIFIED]` | `@hskswap/sdk-core@1.0.3` (`swapRouter02Address`) | `code_bytes=24497` (`48996` hex); `factory()=0x972c...c742`; `WETH9()=0xB210...1Cf1`; `positionManager()=0xDF0A...cad5`; bytecode contains `0x04e45aaf`, `0xb858183f`, `0x5023b4df`, `0x09b81346`, `0xac9650d8`, `0x5ae401dc` |
| `QuoterV2` | `0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD` | `[VERIFIED]` | `@hskswap/sdk-core@1.0.3` (`quoterAddress`) | `cast code` len `16548`; `factory()=0x972c...c742`; `WETH9()=0xB210...1Cf1`; live `quoteExactInputSingle` succeeded on WHSK/USDT, WETH/USDT, WBTC/USDT, USDC.e/WHSK |
| `NonfungiblePositionManager` | `0xDF0A9b833Db0E4CeEa103A4408f3B68e7FC0cad5` | `[VERIFIED]` | `@hskswap/sdk-core@1.0.3` & `SwapRouter02.positionManager()` | `code_bytes=24384` (`48770` hex); `factory()=0x972c...c742`; `WETH9()=0xB210...1Cf1`; `name()="Uniswap V3 Positions NFT-V1"`; `symbol()="UNI-V3-POS"`; `totalSupply()=21` |
| `V3Migrator` | `0x4DaA3DaD4fe453767C5aeEFf2e2A15b0e85Fe62D` | `[VERIFIED]` | `@hskswap/sdk-core@1.0.3` (`v3MigratorAddress`) | `cast code` len `15402`; `factory()=0x972c...c742`; `nonfungiblePositionManager()=0xDF0A...cad5` |
| `TickLens` | `0x0BA7274A183d9f91a0387d45853613B2d626A590` | `[VERIFIED]` | `@hskswap/sdk-core@1.0.3` (`tickLensAddress`) | `cast code` len `2772`; `getPopulatedTicksInWord(WHSK/USDT, -20)` returned populated ticks `[-294420, -294600, -299340, -301440]` |
| `UniswapInterfaceMulticall` | `0x7D0CBa43EbDD69ec2CE3B5AeAD3b0FbC796c565B` | `[VERIFIED]` | `@hskswap/sdk-core@1.0.3` (`multicallAddress`) | `cast code` len `2768`; `getCurrentBlockTimestamp()=1795513225` |
| `UniversalRouter` | `0x76d86a6e224b19270c2cda31477a4c79b2d56918` | `[VERIFIED]` | `@hskswap/universal_router_sdk@1.0.4` (`_CHAIN_CONFIGS[177]`) | `cast code` len `43560`; deployed block `17363588`; contains `execute(bytes,bytes[],uint256)` & `execute(bytes,bytes[])` |
| `Permit2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | `[VERIFIED]` | Canonical Permit2 address | `cast code` len `18306`; `DOMAIN_SEPARATOR()=0x10622ef06267a8a28d3c5727faac63b08106009c62a10ea521ad32214ffc55a3` |
| `Multicall3` | `0xcA11bde05977b3631167028862be2a173976ca11` | `[VERIFIED]` | Canonical Multicall3 address | `code_bytes=3809` (`7618` hex); `getBlockNumber()=30582867` |

*(Note: HyperIndex [`hyperindex.trade`] also operates on HashKey Chain as a hybrid AMM/orderbook DEX `[UNVERIFIED on-chain]`; recent `WHSK/USDT` swap logs show swap sender contract `0x56d15cf00b5d853d6ee4cbb1463e6dad2899fbf5` [`cast code` hex len `24142`] executing swaps on the HSKSwap pool.)*

---

## 3. Verified V3 Pools & Target Pool Analysis

Out of 220 `(tokenA, tokenB, fee)` matrix queries + all 21 active LP NFT positions in `NonfungiblePositionManager`, **12 unique V3 pools** were found on `Factory` `0x972cA9D1662F5e029cD18327D29026532E84c742`. Only **3 pools** hold substantial real-asset liquidity and initialized multi-slot TWAP buffers (`observationCardinality = 240`), plus 1 micro-pool for `USDC.e/WHSK`:

### 3.1 Production & Real-Asset Pools (`[VERIFIED]`)

| Pool | Address | Fee / Spacing | `sqrtPriceX96` / `tick` | Active `liquidity()` | Reserves (`balanceOf(pool)`) | `obsCard` / TWAP Status |
| --- | --- | --- | --- | --- | --- | --- |
| **WHSK / USDT** | `0x4ff515761864e7838b0adb8b5b2b8b7a068905dc` | `3000` / `60` | `22521941300804983880140` / `-301483` | `1,475,813,786,831,558,685` | `5,193,022.60 WHSK`, `419,573.21 USDT` (~$838k TVL `[INFERRED]`) | `240` (`idx=210`), `observe([86400,3600,1800,0])` **SUCCEEDED** (oldest slot `211` ts=`1795193721`, ~3.7 days buffer) |
| **WETH / USDT** | `0xb92b79ed6b370d5cfee2e14b1d0983c258304c16` | `3000` / `60` | `3270543216138913567277812` / `-201913` | `1,012,957,283,335,421` | `24.563 WETH`, `41,838.05 USDT` (~$83.5k TVL `[INFERRED]`) | `240` (`idx=222`), `observe([86400,3600,1800,0])` **SUCCEEDED** (ring buffer not yet wrapped; slot `223` uninitialized) |
| **WBTC / USDT** | `0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a` | `3000` / `60` | `1970071585337036895447198882755` / `64273` | `1,823,343,427` | `0.73376434 WBTC`, `45,351.65 USDT` (~$90.5k TVL `[INFERRED]`) | `240` (`idx=50`), `observe([86400,3600,1800,0])` **SUCCEEDED** (ring buffer not yet wrapped; slot `51` uninitialized) |
| **USDC.e / WHSK** | `0xb580d654ce892181937aac80ea165950cb7d0e02` | `3000` / `60` | `257944478741664417464451675357173796` / `299933` | `249,999,999,999` | `0.076788 USDC.e`, `0.8145 WHSK` | `1` (`idx=0`), **NO TWAP** (`obs0_ts=1780649143`) |
| **USDC.e / WHSK** | `0x9861246b8bdf619cc0e8c0422e0a662b51a2c3f4` | `10000` / `200` | `258690224024130177430264637859036961` / `299991` | `0` | N/A | `1` (`idx=0`), empty active liquidity |

*(7 additional pools on `Factory` use test tokens `0xcf9b...a606` ["B Test Token"], `0xe457...cc4a` ["A Test Token"], and `0x5eda...8f6b` ["A"], all with `observationCardinality = 1`: `0x4e385f48d658906638029eaaa697022762f1d36b`, `0xf5cbc1af0ab6c1a5b24c0ced9da13bbc526a7c25`, `0x024fb33b16b668533664be2e0b79292f421a22cc`, `0x4adeba4ecec9585d4e213b051c161b3d8dce0aea`, `0x265aae477d9906f637b871986e5e8f05d3514800`, `0x9d5efe39d8f72af6289b912d5adefcb0d5adc2e6`, `0xe4badb6cd5116cdd8c7afd09a1d0b8f41573da0c`.)*

### 3.2 Live QuoterV2 & Swap Activity Verification (`[VERIFIED]`)
- `1 WHSK -> USDT` (fee `3000`): `80565` (`0.080565 USDT`, gasEstimate `73,916`, 1 tick crossed).
- `0.01 WETH -> USDT` (fee `3000`): `16982411` (`16.982411 USDT`, i.e., ~$1,698.24/WETH; note `1 WETH -> 1632.599015 USDT`, ~3.87% price impact due to ~$83.5k pool TVL).
- `0.001 WBTC -> USDT` (fee `3000`): `61561602` (`61.561602 USDT`, i.e., ~$61,561.60/WBTC; `0.01 WBTC -> 608.183839 USDT`, ~1.21% price impact).
- `100 USDC.e -> WHSK` (fee `3000`): `813302861728481137` (`0.8133 WHSK` — drains almost all `0.8145 WHSK` in the tiny `USDC.e/WHSK` micro-pool).
- Recent `Swap` events observed on `WHSK/USDT` (`0x4ff5...`) within the last 2,000 blocks: blocks `30581319`, `30581654`, `30582637`.

### 3.3 Token Metadata, Proxy Patterns, and Transfer-Restriction Audit (`[VERIFIED]`)

| Token | Address | `decimals` | `totalSupply` | Pattern / Proxy | Transfer Restrictions / Fee-on-Transfer Risk |
| --- | --- | --- | --- | --- | --- |
| **WHSK** | `0xB210D2120d57b758EE163cFfb43e73728c471Cf1` | `18` | `5264759224642236968649001` | Standard WETH9 (`code_bytes=3143`, non-proxy) | None observed (`owner()`, `paused()`, `isBlacklisted()` revert) |
| **USDT** | `0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029` | `6` | `1172801280616` (~1.17M) | OP Stack `OptimismMintableERC20` (`bridge=0x4200...0010`, `l1Token=0xdac1...1ec7`, non-proxy) | **No** blacklist, **no** pause, **no** fee-on-transfer (`basisPointsRate()`, `paused()`, `isBlacklisted()` revert). **Safest primary stablecoin for protocol settlement/LP.** |
| **USDC.e** | `0x054ed45810DbBAb8B27668922D110669c9D88D0a` | `6` | `1796543817` (~1,796.54) | ZeppelinOS Proxy (`impl=0x82f67bdea6cbcc6bd34526073300e619225b22de`, `admin=0x57d5e36804e46a6ed938aecb300dff222b92f324`, `owner=0x7bc3...68b1`) | **Has `paused()` (`false`) and `isBlacklisted(address)` (`false`)**; upgradeable + very low bridged supply (~1.8k USDC.e) |
| **oUSDT** | `0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189` | `6` | `746518` (~0.75) | EIP-1967 Proxy (`impl=0x2c04...3d50`, `admin=0x70e3...f1f3`, `owner=0x072d...77cc`) | Upgradeable proxy; negligible supply & no HSKSwap pool |
| **WETH** | `0xefd4bC9afD210517803f293ABABd701CaeeCdfd0` | `18` | `33333316536881291975` (~33.33) | OP Stack `OptimismMintableERC20` (`bridge=0x4200...0010`, `l1Token=0xc02a...6cc2`, non-proxy) | No pause/blacklist/fee observed |
| **WBTC** | `0x6119CA49a79f5825C8B345F8d7aC36B272565b14` | `8` | `80936599` (~0.8094) | OP Stack `OptimismMintableERC20` (`bridge=0x4200...0010`, `l1Token=0x2260...c599`, non-proxy) | No pause/blacklist/fee observed |
| **stHSK** | `0xD2fdDFf28A534300ae961c5435E16f9465253b76` | `18` | `1456244579286546116165988` | Non-EIP-1967 (`owner=0xd30a...e9b1`) | No HSKSwap pool discovered; `owner` exists `[UNVERIFIED rebase/transfer hooks]` |
| **LINK** | `0x71052BAe71C25C78E37fD12E5ff1101A71d9018F` | `18` | `1999970000` | Non-EIP-1967 (`owner=0x8fad...a45a`) | No HSKSwap pool discovered |

---

## 4. `NonfungiblePositionManager` Behavior (`0xDF0A9b833Db0E4CeEa103A4408f3B68e7FC0cad5`)

- `[VERIFIED]` **ERC-721 & Enumerable:** `supportsInterface(0x80ac58cd)` (ERC721) = `true`, `supportsInterface(0x780e9d63)` (ERC721Enumerable) = `true`. `totalSupply() = 21`, active tokenIds range from `1` to `36` (some earlier IDs were burned, e.g., 7, 9, 11, 13, 17, 19–22, 24–29).
- `[VERIFIED]` **Real Positions Sampled:**
  - `tokenId=33` (`owner=0x8fed6470991878e806bcb733ffb8392b5d07e95e`): `WHSK/USDT` full-range `[-887220, 887220]`, `liquidity=1,475,795,317,829,628,044`, `tokensOwed0=447,961,046,977,057,245,171` (~447.96 WHSK), `tokensOwed1=22,076,094` (~22.08 USDT).
  - `tokenId=14` (`owner=0xe4081d9b05513fdd6433eeef1601bdd24967599f`): `WHSK/USDT` concentrated `[-301440, -294600]`, `liquidity=17,219,076,875,308`.
  - `tokenId=34` (`owner=0xb3e909bfa3fed60c195ec7266d258e13e3e229b2`): `WBTC/USDT` full-range, `liquidity=1,823,343,427`.
  - `tokenId=35` (`owner=0xb3e909bfa3fed60c195ec7266d258e13e3e229b2`): `WETH/USDT` full-range, `liquidity=1,012,866,085,914,777`.
- `[VERIFIED]` **Custody, Approval, and Withdrawal Selectors Present in Bytecode:**
  - `approve(address,uint256)` [`0x095ea7b3`], `setApprovalForAll(address,bool)` [`0xa22cb465`], `getApproved(uint256)` [`0x081812fc`], `isApprovedForAll(address,address)` [`0xe985e9c5`], `transferFrom` [`0x23b872dd`], `safeTransferFrom` [`0x42842e0e`], `permit` [`0x7ac2ff7b`].
  - `decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))` [`0x0c49ccbe`] and `collect((uint256,address,uint128,uint128))` [`0xfc6f7865`] and `increaseLiquidity` [`0x219f5d17`].
  - **Architecture implication for the protocol:** `[INFERRED]`Standard Uniswap V3 `NonfungiblePositionManager` allows an approved operator or escrow owner (`ownerOf(tokenId)`) to call `decreaseLiquidity` and `collect` directly to any `recipient` without breaking NFT custody if escrowed inside a protocol vault, OR to unwind via `decreaseLiquidity -> collect -> SwapRouter02.exactInputSingle`. Note that `tokensOwed0/1` accrue independently of `liquidity` and must be explicitly swept via `collect` (with `amount0Max = type(uint128).max, amount1Max = type(uint128).max`).

---

## 5. Oracle Infrastructure Audit on Chain 177

| Oracle Provider | Status | Address / Details | Evidence & Trust Boundary |
| --- | --- | --- | --- |
| **Chainlink Data Streams** | `[VERIFIED]` (contract live, pull-gated) | `VerifierProxy`: `0x3278e7a582B94d82487d4B99b31A511CbAe2Cd54` | `code_bytes=7009`; `typeAndVersion()="VerifierProxy 2.0.0"`; `owner()=0x322Bf463D776FF83e43fe5c281E619eFB9277719`; `s_feeManager()=0x0000...0000`. **Constraint:** Pull-based — contracts cannot read a price on-chain without an off-chain caller submitting a Chainlink DON-signed report payload (requires Chainlink Data Streams API access/credentials, and mainnet feed ID availability for HSK/USDT is `[UNVERIFIED]`). |
| **Chainlink Push Price Feeds (`AggregatorV3Interface`)** | `[NOT_FOUND]` | None found; `FeedRegistry` `0x47Fb...eeDf` has `0` bytes | No Chainlink push price feeds are documented or verified on HashKey Chain mainnet (177). |
| **Pyth Network** | `[NOT_FOUND]` | Checked 5 standard EVM Pyth addresses (`0x4305...`, `0x2880...`, `0xA2aa...`, `0xDd24...`, `0x8250...`) | All returned `0` bytes (`0x`) via `eth_getCode` on chain 177. |
| **RedStone / API3 / Chronicle** | `[NOT_FOUND]` | Checked `0x76F4...46E6`, `0x3dEC...0D76`, `0x2771...05b6`, `0x0Dcc...A37d` + web search | All returned `0` bytes (`0x`) via `cast code`; no public push oracle deployments found on mainnet 177. |
| **HSKSwap V3 `observe()` TWAP** | `[VERIFIED]` (live on 3 pools) | `WHSK/USDT` (`0x4ff5...`), `WETH/USDT` (`0xb92b...`), `WBTC/USDT` (`0xd9ea...`) | All 3 pools have `observationCardinality=240` and `observe([86400, 3600, 1800, 0])` **succeeded** on-chain, returning consistent `tickCumulative` slopes matching `slot0().tick`. |

### Oracle Design Verdict for the Protocol
- `[VERIFIED]` Because **zero permissionless push-based oracles** (Chainlink `AggregatorV3Interface`, Pyth, API3, Chronicle) were found on HashKey Chain mainnet (`177`), **on-chain HSKSwap V3 TWAP (`pool.observe([twapWindow, 0])`) is the only trustless, zero-dependency, permissionless on-chain price oracle verified live on chain 177** for `WHSK/USDT`, `WETH/USDT`, and `WBTC/USDT`.
- `[INFERRED]` **TWAP caveat & risk boundary:** `USDC.e/WHSK` (`0xb580...`) and all test pools have `observationCardinality = 1` (TWAP reverts for any `secondsAgo > 0` prior to the last update). Furthermore, `WETH/USDT` (~$83.5k TVL) and `WBTC/USDT` (~$90.5k TVL) are thin enough that single-block or short-window spot prices can be moved cheaply, whereas `WHSK/USDT` (~$838k TVL, 3.7-day 240-slot ring buffer) provides a materially stronger manipulation-resistant TWAP surface if paired with a >= 15–30 minute window (`observe([1800, 0])`) and explicit cardinality check (`observationCardinality >= MIN_CARDINALITY`).

---

## 6. HSP (HashKey Settlement Platform / Protocol) Mainnet Audit

- **Status:** `[NOT_FOUND]` (no public permissionless HSP singleton/coordinator smart contract address on chain 177); `[VERIFIED via official docs & public ecosystem repos]` that HSP operates as an **off-chain + partner-gated CaaS/settlement layer** paired with app-specific smart contract adapters.
- **Observed Architecture & Trust Boundaries:**
  - **CaaS & Off-Chain Rails:** HashKey Settlement Platform (HSP) / HashKey CaaS relies on institutional onboarding, KYC/AML, IP & wallet address whitelisting (`GET /api/v1/whitelist/...`), HMAC-SHA256 / ES256K JWT API authentication, and EIP-712 signed payment mandates.
  - **On-Chain Ecosystem Adapters:** Hackathon and open-source integrations targeting chain `177` (e.g., `GearTechnologies/HashPoint`, `swiftbotlabs/hsk-meter`, `0xultravioleta/agentsettle-hsk`, `sumplus-real/sumplus-hsk-mandate`) deploy **their own** escrow/treasury/adapter contracts (`HSPAdapter.sol`, `MandatedTreasury.sol`) rather than calling a canonical HashKey-deployed mainnet singleton, and settle value in standard on-chain ERC-20s (predominantly `USDT` `0xF1B5...9029`).
  - **Implication for the protocol:** Do **not** hardcode an unverified HSP mainnet contract or assume on-chain HSP compliance checks are permissionlessly queryable on chain 177. Any compliance/settlement integration with HSP must treat HSP attestations or mandates as an **optional, modular adapter boundary** (e.g., EIP-712 / verifier hook) while keeping the protocol's core LP commitment, execution, and settlement fully self-contained and permissionless on-chain using verified HSKSwap V3 primitives and `USDT`/`WHSK`/`WETH`/`WBTC`.

---

## 7. Blockers & Gaps Identified

1. **No public push price feeds (`AggregatorV3Interface` / Pyth):** Protocols on chain 177 cannot rely on Chainlink push feeds or Pyth without custom off-chain relayers (or Chainlink Data Streams API credentials for `VerifierProxy 0x3278...Cd54`).
2. **Low `USDC.e` liquidity & upgradeability risk:** `USDC.e` total supply is only `1,796.54` tokens and its `USDC.e/WHSK` pool has ~$0.14 TVL and `observationCardinality = 1`, whereas `USDT` (`0xF1B5...9029`) has `~1.17M` total supply, no blacklist/pause/upgradeability, and ~`$1.01M` combined TVL across `WHSK/USDT`, `WETH/USDT`, and `WBTC/USDT`.
3. **Subgraph endpoint unreachable:** `graphnode.hashkeychain.net` does not resolve; on-chain Multicall3 + `Factory`/`NPM` enumeration is required.
4. **No canonical on-chain HSP singleton verified:** HSP mainnet integration requires HashKey partner/CaaS credentials or custom EIP-712 adapter contracts.
