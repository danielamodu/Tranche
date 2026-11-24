# HashKey Chain Liquidity Commitment Protocol — Market & Economic Model

> **Internal Product Name:** `the protocol`  
> **Target Network:** HashKey Chain Mainnet (Chain ID `177`, RPC `https://mainnet.hsk.xyz`)  
> **Primary Snapshot Block:** `30583147` (`2026-11-24T09:43:49.000Z`)  
> **Historical Analysis Window:** Blocks `29978347` → `30583147` (`2026-11-10T09:43:49Z` to `2026-11-24T09:43:49Z`, exact `14.0000` days at `2.0s` block time)

---

## 1. Evidence Classification & Reproducibility

Every numerical claim in this document is explicitly tagged:

| Tag | Meaning |
| --- | --- |
| `VERIFIED` | Directly queried on-chain from HashKey Chain mainnet (`https://mainnet.hsk.xyz`) via JSON-RPC (`eth_call`, `eth_getLogs`, `eth_getBlockByNumber`, `eth_getTransactionReceipt`, `eth_gasPrice`). |
| `INFERRED` | Mathematically derived from `VERIFIED` on-chain data using exact deterministic formulas (e.g., Uniswap V3 multi-tick swap simulation, Black-Scholes pricing from realized volatility, annualized fee APR). |
| `ASSUMED` | Engineering or market-regime assumptions not directly observable on-chain (e.g., stressed 80% volatility, 1.25x implied-to-realized vol markup, 55,000 gas for standalone `collect()`, 25% inventory utilization). |
| `UNVERIFIED` | External or off-chain claims not verified via on-chain RPC (e.g., CEX orderbook depth on HashKey Exchange or off-chain OTC demand). |

All data collection and analysis scripts are zero-dependency Node.js v24 ES modules located in [`scripts/market-analysis/`](file:///c:/Users/USER/Desktop/Tranche/scripts/market-analysis):
1. [`rpc.mjs`](file:///c:/Users/USER/Desktop/Tranche/scripts/market-analysis/rpc.mjs) — JSON-RPC client, chunked `eth_getLogs` fetcher (`4999`-block chunks), and ABI encoders/decoders.
2. [`01_discover_pools.mjs`](file:///c:/Users/USER/Desktop/Tranche/scripts/market-analysis/01_discover_pools.mjs) → [`pools_discovered.json`](file:///c:/Users/USER/Desktop/Tranche/scripts/market-analysis/pools_discovered.json) — Chain-wide 7-day V3/V2 `Swap` scan + factory `PoolCreated`/`getPool` verification.
3. [`02_collect_pool_data.mjs`](file:///c:/Users/USER/Desktop/Tranche/scripts/market-analysis/02_collect_pool_data.mjs) → [`market_data_14d.json`](file:///c:/Users/USER/Desktop/Tranche/scripts/market-analysis/market_data_14d.json) — Full `tickBitmap` + `ticks()` scan, 14-day `Swap`/`Mint`/`Burn` logs, 15 daily block checkpoints, and real transaction receipt gas profiling.
4. [`03_analyze_market.mjs`](file:///c:/Users/USER/Desktop/Tranche/scripts/market-analysis/03_analyze_market.mjs) → [`analysis_summary.json`](file:///c:/Users/USER/Desktop/Tranche/scripts/market-analysis/analysis_summary.json) — Exact V3 depth bands, trade price impact curve, swap quantiles, fee APR/APY, realized volatility, and gas drag.
5. [`04_evaluate_models.mjs`](file:///c:/Users/USER/Desktop/Tranche/scripts/market-analysis/04_evaluate_models.mjs) → [`model_evaluation.json`](file:///c:/Users/USER/Desktop/Tranche/scripts/market-analysis/model_evaluation.json) — Numerical kill-criteria evaluation, Floating Strike oracle toxicity matrices, and Fixed Strike Black-Scholes pricing frontier.

---

## 2. Executive Summary & Honest Verdict

HashKey Chain mainnet exhibits a sharp **structural liquidity paradox**:

1. **Supply-side inefficiency is extreme (`VERIFIED`):** Across all three active HSKSwap V3 pools (`WHSK/USDT`, `WETH/USDT`, `WBTC/USDT`, combined TVL **`$1,013,625.13`**), **100.00% of current active liquidity** sits in passive full-range `[-887220, +887220]` positions, with **zero `Mint` or `Burn` events** in the last 14 days. Only **0.50% of TVL** lies within `+/- 100 bps` of spot (`$4,195` on WHSK/USDT; `$418` on WETH/USDT; `$453` on WBTC/USDT). As a result:
   - A `$10,000` buy suffers **`268.5 bps`** all-in execution cost on `WHSK/USDT`, **`2,421.6 bps` (`24.2%`)** on `WETH/USDT`, and **`2,235.7 bps` (`22.4%`)** on `WBTC/USDT` (`INFERRED` from `VERIFIED` tick state).
   - Meanwhile, passive LPs earn only **`0.19%` APR** (`WHSK/USDT`), **`1.28%` APR** (`WETH/USDT`), and **`0.84%` APR** (`WBTC/USDT`) (`INFERRED` from 14d fees).
   - Gas friction is near zero: observed `gasPrice` is `500.001 gwei`, `WHSK` spot is `$0.080808`, so a conservative full V3 exit + redeploy (`426,729.5` gas) costs **`$0.01724`** (`0.017 bps` on a `$10,000` commitment) (`VERIFIED` + `INFERRED`).

2. **Observed on-chain retail swap demand fails standalone volume kill criteria (`VERIFIED`):** Total 14-day volume across the three pools is **`$44,053.47`** (**`$3,146.68/day`**), with **0 swaps `>= $5,000`** in 14 days (`max` observed swap: `$502.15` on WHSK/USDT, `$510.74` on WETH/USDT, `$1,026.64` on WBTC/USDT). Under pre-committed numerical kill criteria, **all three pools FAIL `KC-1` (min `$10k/day` volume) and `KC-2` (min 14 large swaps `>= $5k` over 14d)**, while **PASSING `KC-3` through `KC-6`** (AMM slippage advantage, gas efficiency, LP opportunity cost, and oracle toxicity bounds).

3. **Strategic Implication for the protocol:**
   - **Do NOT market the protocol as a drop-in retail AMM router** for current `$15–$100` HashKey Chain swaps — retail AMM slippage on `$100` WHSK swaps is only `2.4 bps` (+30 bps fee).
   - **DO target latent block/institutional/treasury tickets (`>= $5,000` on WHSK; `>= $1,000` on WETH/WBTC)** that are currently priced off-chain by `244–2,422 bps` AMM slippage, and deploy **Floating Strike (`P_ref + spread`) as the primary default mode** (requiring a sub-30s pull oracle such as Pyth/RedStone, NOT HSKSwap TWAP) with **Fixed Strike** reserved for short-tenor (`1h–24h`) structured options priced explicitly via Black-Scholes short-gamma bounds.

---

## 3. HashKey Chain DEX Topology & Pool Discovery

A chain-wide `eth_getLogs` scan over 7 days (`302,400` blocks: `30280628` → `30583028`) plus factory `PoolCreated` / `getPool` probes across both deployed V3 factories (`0x972ca9d1662f5e029cd18327d29026532e84c742` and `0xd136e36610f35e0cc3cad40de858c151f2aa65d4`) identified **19 V3 pools** and **4 active V2 pools** (`VERIFIED`).

- **V2 activity (`VERIFIED`):** Only `16` swaps total in 7 days across 4 tiny pools (`0x711d...f8f2`, `0xf836...3ae4`, `0xa002...befd`, `0x340b...047b`), each holding `< $100` in reserves. Economically negligible.
- **V3 legacy factory `0xd136e36610f35e0cc3cad40de858c151f2aa65d4` (`VERIFIED`):** Two WHSK/USDT pools (`0xeb33...778a` at `0.05%` fee and `0x0767...ae62` at `0.30%` fee) with `< $1` TVL and `0` swaps in 7 days.
- **V3 primary factory `0x972ca9d1662f5e029cd18327d29026532e84c742` (`VERIFIED`):** Contains 17 pools, of which **14 had `0` swaps in 7 days** (test pairs `A/USDT`, `B/A`, `WHSK/A`, `WHSK/B`, `USDC.e/WHSK`, and empty tokenized-equity pools `CRCLs`, `TSLAs`, `QQQs`, `AAPLs`, `NVDAs`), and **exactly 3 pools account for 100% of active V3 DEX volume** (`763/763` swaps in 7d; `1,241` swaps in 14d):

| Pool | Address | Fee / TickSpacing | `token0` (Dec) | `token1` (Dec) | Balances (`VERIFIED`) | Spot Price (`VERIFIED`) | TVL USD (`INFERRED`) | Active Liquidity `L` (`VERIFIED`) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **WHSK/USDT** | `0x4ff515761864e7838b0adb8b5b2b8b7a068905dc` | `3000` (30 bps) / `60` | `WHSK` (`0xb210...1cf1`, 18) | `USDT` (`0xf1b5...9029`, 6) | `5,193,022.60` WHSK / `419,573.21` USDT | `$0.080808` | **`$839,209.16`** | `1,475,813,786,831,558,685` |
| **WETH/USDT** | `0xb92b79ed6b370d5cfee2e14b1d0983c258304c16` | `3000` (30 bps) / `60` | `WETH` (`0xefd4...dfd0`, 18) | `USDT` (`0xf1b5...9029`, 6) | `24.5634` WETH / `41,838.05` USDT | `$1,704.04` | **`$83,695.09`** | `1,012,957,283,335,421` |
| **WBTC/USDT** | `0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a` | `3000` (30 bps) / `60` | `WBTC` (`0x6119...5b14`, 8) | `USDT` (`0xf1b5...9029`, 6) | `0.7338` WBTC / `45,351.65` USDT | `$61,830.80` | **`$90,720.88`** | `1,823,343,427` |

> **Verification Note:** Notice that `USDT` (`0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029`, 6 decimals) is `token1` in all three pools, enabling exact USD valuation directly from on-chain pool states and `Swap` logs without external price assumptions.

---

## 4. Tick Liquidity Distribution & Market Depth

Scanning the entire `tickBitmap` (`wordPos` `-58..+58` at `tickSpacing = 60`, covering `[-887220, +887220]`) at block `30583147` reveals extreme LP passivity (`VERIFIED`):

- **WETH/USDT (`currentTick = -201913`):** Only **2 initialized ticks** (`-887220` and `+887220`). **100.0000%** of liquidity is full-range.
- **WBTC/USDT (`currentTick = 64273`):** Only **2 initialized ticks** (`-887220` and `+887220`). **100.0000%** of liquidity is full-range.
- **WHSK/USDT (`currentTick = -301483`):** Only **8 initialized ticks** (`-887220`, `-301440`, `-299340`, `-294600`, `-294420`, `-290460`, `-269400`, `+887220`). At current tick `-301483`, **100.0000%** of active liquidity (`1.4758e18`) is full-range; the three tiny concentrated bands lie strictly *above* current spot (`-301440` to `-269400`) and sum to `< 0.0012%` of active `L`.

For every pool, reconstructing `L(currentTick)` by summing `liquidityNet` from `-887220` matches `pool.liquidity()` to the exact unit (`L_match = true`, `VERIFIED`).

### Available Liquidity Depth Around Spot (`INFERRED` from `VERIFIED` ticks)

Because 100% of active liquidity is full-range, depth scales linearly with band width ($\approx \delta \times \text{TVL} / 2$ two-sided):

| Band Around Spot | WHSK/USDT Two-Sided Depth (% TVL) | WETH/USDT Two-Sided Depth (% TVL) | WBTC/USDT Two-Sided Depth (% TVL) |
| --- | --- | --- | --- |
| `+/- 10 bps` (`0.10%`) | `$419.53` (`0.05%`) | `$41.81` (`0.05%`) | `$45.34` (`0.05%`) |
| `+/- 50 bps` (`0.50%`) | `$2,097.63` (`0.25%`) | `$209.08` (`0.25%`) | `$226.70` (`0.25%`) |
| `+/- 100 bps` (`1.00%`) | `$4,195.32` (`0.50%`) | `$418.15` (`0.50%`) | `$453.39` (`0.50%`) |
| `+/- 500 bps` (`5.00%`) | `$20,982.92` (`2.50%`) | `$2,091.40` (`2.50%`) | `$2,267.65` (`2.50%`) |
| `+/- 1000 bps` (`10.00%`) | `$42,005.40` (`5.01%`) | `$4,186.74` (`5.00%`) | `$4,539.58` (`5.00%`) |
| `+/- 2000 bps` (`20.00%`) | `$84,332.49` (`10.05%`) | `$8,405.55` (`10.04%`) | `$9,113.93` (`10.05%`) |

**Key Structural Finding:** Over **97.5%** of the `$1.01M` TVL sits outside `+/- 500 bps` and contributes zero effective depth for institutional trade execution.

---

## 5. Historical 14-Day Activity, Swap Sizes & AMM Price Impact

### 5.1 Observed 14-Day Volume, Fees, Volatility & LP Churn (`VERIFIED` + `INFERRED`)

Window: Blocks `29978347` → `30583147` (`14.0000` days).

| Metric | WHSK/USDT | WETH/USDT | WBTC/USDT | Combined / Notes |
| --- | --- | --- | --- | --- |
| Swaps (14d / per day) (`VERIFIED`) | `1,047` (`74.8/d`) | `173` (`12.4/d`) | `21` (`1.5/d`) | `1,241` total (`88.6/d`) |
| 14d Volume (`VERIFIED`) | `$20,689.88` | `$13,650.69` | `$9,712.90` | `$44,053.47` |
| Avg Daily Volume (`INFERRED`) | `$1,477.85/d` | `$975.05/d` | `$693.78/d` | `$3,146.68/d` |
| Daily Vol Range (`min`–`max`) (`VERIFIED`) | `$12` – `$6,418` | `$0` – `$3,578` | `$0` – `$2,639` | Highly spiky; WETH/WBTC had 2–5 zero-swap days |
| Sell-Base Share of Volume (`VERIFIED`) | `67.90%` (`$14,049` sell / `$6,641` buy) | `67.12%` (`$9,162` sell / `$4,489` buy) | `74.14%` (`$7,201` sell / `$2,512` buy) | Persistent net sell skew across all 3 pools |
| 14d LP Fees at 30 bps (`INFERRED`) | `$62.07` | `$40.95` | `$29.14` | `$132.16` total |
| Annualized LP Fee APR / APY (`INFERRED`) | **`0.19%`** / `0.19%` | **`1.28%`** / `1.28%` | **`0.84%`** / `0.84%` | Far below DeFi risk-free yields |
| 14d `Mint` / `Burn` Events (`VERIFIED`) | `0` / `0` | `0` / `0` | `0` / `0` | Zero active LP rebalancing |
| Realized Price Range (`VERIFIED`) | `$0.08062` – `$0.08444` | `$1,549.20` – `$2,101.98` | `$56,511.44` – `$74,082.30` | Reflects Nov 2026 drawdown + arb lags |
| Realized Annualized Vol (`INFERRED`) | **`16.84%`** | **`61.09%`** | **`75.65%`** | Computed from 14 daily close log-returns |
| Oracle `observationCardinality` (`VERIFIED`) | `240` | `240` | `240` | Mean inter-swap gap: `19m` / `1.9h` / `16h` |

### 5.2 Historical Swap Size Distribution (`VERIFIED`)

| Pool | Min | p50 (Median) | p75 | p90 | p95 | Max | Swaps `>= $500` | Swaps `>= $1,000` | Swaps `>= $5,000` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **WHSK/USDT** | `$0.04` | `$15.00` | `$22.41` | `$25.01` | `$35.01` | `$502.15` | `1` (`2.4%` vol) | `0` (`0.0%` vol) | `0` (`0.0%` vol) |
| **WETH/USDT** | `$0.11` | `$99.84` | `$99.94` | `$99.98` | `$99.99` | `$510.74` | `4` (`14.8%` vol) | `0` (`0.0%` vol) | `0` (`0.0%` vol) |
| **WBTC/USDT** | `$0.13` | `$507.16` | `$510.71` | `$1,009.86` | `$1,012.67` | `$1,026.64` | `15` (`95.0%` vol) | `3` (`31.4%` vol) | `0` (`0.0%` vol) |

### 5.3 Estimated AMM Execution Cost vs. Trade Size (`INFERRED` from `VERIFIED` tick state)

Values show **pure price impact (slippage vs. spot)** and **all-in execution cost (slippage + 30 bps LP fee)** in basis points (`bps`):

| Trade Size (USD) | WHSK/USDT Buy (Pure / All-In) | WHSK/USDT Sell (Pure / All-In) | WETH/USDT Buy (Pure / All-In) | WETH/USDT Sell (Pure / All-In) | WBTC/USDT Buy (Pure / All-In) | WBTC/USDT Sell (Pure / All-In) |
| --- | --- | --- | --- | --- | --- | --- |
| `$100` | `2.4` / `32.5` | `2.4` / `32.4` | `23.8` / `54.0` | `23.8` / `53.7` | `22.0` / `52.1` | `21.9` / `51.9` |
| `$500` | `11.9` / `42.0` | `11.9` / `41.8` | `119.2` / `149.7` | `117.8` / `147.5` | `109.9` / `140.4` | `108.8` / `138.4` |
| `$1,000` | `23.8` / `53.9` | `23.7` / `53.6` | `238.4` / `269.2` | `232.9` / `262.2` | `219.9` / `250.7` | `215.2` / `244.5` |
| `$2,500` | `59.4` / `89.7` | `59.1` / `88.9` | `596.1` / `628.0` | `562.5` / `590.9` | `549.7` / `581.5` | `521.1` / `549.5` |
| `$5,000` | `118.8` / `149.3` | `117.4` / `147.1` | `1,192.2` / `1,225.8` | `1,065.2` / `1,092.0` | `1,099.5` / `1,132.9` | `990.6` / `1,017.6` |
| `$10,000` | `237.6` / `268.5` | `232.1` / `261.4` | `2,384.3` / `2,421.6` | `1,925.3` / `1,949.5` | `2,199.0` / `2,235.7` | `1,802.6` / `1,827.2` |
| `$25,000` | `594.1` / `626.0` | `560.8` / `589.1` | `5,960.8` / `6,008.8` | `3,734.6` / `3,753.4` | `5,497.5` / `5,544.1` | `3,547.3` / `3,566.7` |
| `$50,000` | `1,188.2` / `1,221.9` | `1,062.1` / `1,088.9` | `11,921.6` / `11,987.5` | `5,438.3` / `5,452.0` | `10,995.0` / `11,058.1` | `5,237.0` / `5,251.2` |
| `$100,000` | `2,376.5` / `2,413.7` | `1,920.2` / `1,944.4` | `23,843.2` / `23,945.0` | `7,045.2` / `7,054.1` | `21,990.0` / `22,086.2` | `6,874.0` / `6,883.4` |

**Demand-Suppression Insight (`INFERRED`):** Notice that observed max swap sizes (`$502` on WHSK, `$511` on WETH, `$1,027` on WBTC) align tightly with the exact threshold where AMM slippage hits ~140–250 bps (except WHSK where retail swaps dominate). Any block trade of `$10k–$50k` faces `2.7%–12.2%` execution loss on WHSK and `18%–120%` on WETH/WBTC, making on-chain AMM routing economically unusable for institutional size.

---

## 6. Gas Cost & Capital Opportunity Cost Analysis

### 6.1 Verified HashKey Chain Gas Economics

From `eth_gasPrice`, snapshot block `baseFeePerGas`, and real on-chain transaction receipts (`15` recent `Swap` receipts + `6` historical `Mint` receipts + `6` historical `Burn` receipts from blocks `28888180–28889246`, `VERIFIED`):

- **`gasPrice` / `baseFee` (`VERIFIED`):** `500.001 gwei` (`500,001,000,000 wei`) / `500.0 gwei`
- **`WHSK` spot price (`VERIFIED`):** `$0.080808` → **`$0.004040` per 100,000 gas**
- **Median `Swap` (`VERIFIED`):** `109,686` gas = **`$0.00443`** (`range: 95,627–118,348`)
- **Median `Mint` (`VERIFIED`):** `179,498.5` gas = **`$0.00725`**
- **Median `Burn` (`VERIFIED`):** `192,231` gas = **`$0.00777`**
- **V3 Withdrawal + Redeployment Round-Trip (`INFERRED` / `ASSUMED`):**
  - *Multicall (`Burn + Mint`):* `371,729.5` gas = **`$0.01502`**
  - *Conservative (separate `decreaseLiquidity` + `55,000` `ASSUMED` `collect` + `mint`):* `426,729.5` gas = **`$0.01724`**

### 6.2 Gas Drag & Capital Opportunity Cost by Reservation Size

| Reservation Notional | Conservative V3 Rebalance Gas (`$0.01724`) in `bps` | 1-Day Foregone Passive LP Yield (`0.19%`–`1.28%` APR) | 1-Day Risk-Free Benchmark (`ASSUMED` `4.5%` APY) |
| --- | --- | --- | --- |
| `$1,000` | `0.1724 bps` | `0.005–0.035 bps` | `0.123 bps` |
| `$5,000` | `0.0345 bps` | `0.005–0.035 bps` | `0.123 bps` |
| `$10,000` | `0.0172 bps` | `0.005–0.035 bps` | `0.123 bps` |
| `$25,000` | `0.0069 bps` | `0.005–0.035 bps` | `0.123 bps` |
| `$50,000` | `0.0034 bps` | `0.005–0.035 bps` | `0.123 bps` |
| `$100,000` | `0.0017 bps` | `0.005–0.035 bps` | `0.123 bps` |

**Conclusion:** Gas and V3 redeployment friction (`$0.01724`) are **not a binding constraint** on HashKey Chain for any commitment `>= $1,000` (`< 0.2 bps`), and current LP opportunity cost (`0.19%–1.28%` APR) is near zero. The *real* economic costs for an LP are **unhedged inventory exposure, directional skew, oracle toxicity, and short-gamma option risk** — NOT gas or foregone V3 fees.

---

## 7. Explicit Numerical Kill Criteria & Honest Evaluation

The following kill criteria were defined prior to evaluating the data (`model_evaluation.json`):

| ID | Criterion | Threshold | WHSK/USDT Observed | WETH/USDT Observed | WBTC/USDT Observed | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **KC-1** | Min daily observed DEX pool volume | `>= $10,000/day` | `$1,477.85/day` | `$975.05/day` | `$693.78/day` | **FAIL (All 3)** |
| **KC-2** | Min large-swap count (`>= $5,000` over 14d) | `>= 14` (`1/day`) | `0` (`max $502.15`) | `0` (`max $510.74`) | `0` (`max $1,026.64`) | **FAIL (All 3)** |
| **KC-3** | Min AMM all-in cost at `$10,000` trade | `>= 100 bps` | `268.5` buy / `261.4` sell | `2,421.6` buy / `1,949.5` sell | `2,235.7` buy / `1,827.2` sell | **PASS (All 3)** |
| **KC-4** | Max V3 exit+redeploy gas drag at `$10,000` (vs 20 bps fee) | `<= 5.0%` (`<= 1.0 bps`) | `0.086%` (`0.0172 bps`) | `0.086%` (`0.0172 bps`) | `0.086%` (`0.0172 bps`) | **PASS (All 3)** |
| **KC-5** | Max passive V3 LP fee APR (opportunity cost) | `<= 10.0% APR` | `0.19% APR` | `1.28% APR` | `0.84% APR` | **PASS (All 3)** |
| **KC-6** | Max Floating oracle toxicity (`30s` latency, `15 bps` spread, realized vol) | `< 2.0 bps` | `0.0000 bps` (`16.8%` RV) | `0.0113 bps` (`61.1%` RV) | `0.0573 bps` (`75.7%` RV) | **PASS (All 3)** |

### Honest Assessment of Kill Criteria Results

- **Why `KC-1` and `KC-2` FAIL:** Current organic on-chain DEX demand on HashKey Chain is small (`$3,147/day` combined) and heavily retail/arb-sized (`p50 = $15` on WHSK, `$100` on WETH, `$507` on WBTC). A protocol expecting passive fee revenue simply by intercepting *existing* HSKSwap retail router flow will **fail to generate meaningful fee volume**.
- **Why the thesis remains viable *only* under an explicit wedge:** Because `KC-3`, `KC-4`, `KC-5`, and `KC-6` pass decisively, **any ticket `>= $5,000` on WHSK (`149 bps` AMM cost) or `>= $1,000` on WETH/WBTC (`245–269 bps` AMM cost)** saves `100–2,300+ bps` by using inventory-backed commitments instead of the AMM. Therefore, the protocol's viable wedge is **institutional / treasury / OTC / aggregator-routed block execution and structured liquidity commitments**, NOT retail `$15–$100` swaps.

---

## 8. Execution Mode Analysis: Floating Strike vs. Fixed Strike

### 8.1 Mode A: FLOATING STRIKE (`P_exec = P_ref * (1 ± spread)`)

In Floating Strike mode, an LP locks inventory (either base token or `USDT`) for duration $T$, granting the taker the ability to execute up to notional $N$ against a verifiable reference price $P_{\text{ref}}$ plus a contracted spread $s$ (plus an optional upfront reservation fee $r$).

#### Risk 1: Residual Directional & Inventory Skew Risk (`VERIFIED` + `INFERRED`)
Floating Strike **does NOT eliminate directional market risk** for the LP:
- If an LP locks `WHSK` or `WETH` inventory to commit to selling base at $P_{\text{ref}}(1+s)$, the LP remains **100% long base delta** until execution and misses upside above $P_{\text{ref}}(1+s)$ only at execution; worse, if the LP locks `USDT` to buy base at $P_{\text{ref}}(1-s)$ and price drops post-fill, the LP absorbs full mark-to-market loss on the acquired asset.
- **Empirical Skew Risk:** Across all three pools in the last 14 days (`VERIFIED`), orderflow was strongly one-sided (`67.9%` sell-base on WHSK, `67.1%` on WETH, `74.1%` on WBTC). Unhedged LPs taking the opposite side of taker reservations accumulate concentrated directional inventory.
- **Mitigation:** Require **100% single-sided inventory collateralization** (no leveraged under-collateralization), dynamic spread skewing (`s_bid != s_ask`) when vault inventory skews, and short commitment windows (`1h–24h`) or upfront reservation fees (`r >= 5–10 bps`) to compensate inventory lockup.

#### Risk 2: Oracle Latency / Staleness Toxic-Flow Risk (`INFERRED` + `ASSUMED`)
If $P_{\text{ref}}$ lags true market price $P_{\text{true}}$ by latency $\tau$, an informed taker holds a **stale-quote free option** whenever $|\Delta P / P| > s$. Modeling log-price increments over $\tau$ as $\mathcal{N}(0, \sigma^2 \tau / 31536000)$, expected one-sided toxic extraction per fill is:

$$\mathbb{E}[\text{Toxicity}] = \sigma_\tau \phi\!\left(\frac{s}{\sigma_\tau}\right) - s\left(1 - \Phi\!\left(\frac{s}{\sigma_\tau}\right)\right), \quad \sigma_\tau = \sigma \sqrt{\frac{\tau}{31536000}}$$

Computed expected toxicity loss in **bps** (`INFERRED`, [`model_evaluation.json`](file:///c:/Users/USER/Desktop/Tranche/scripts/market-analysis/model_evaluation.json)):

| Latency $\tau$ | WHSK (`16.84%` RV) `@10 / @15 / @25 bps` | WETH (`61.09%` RV) `@10 / @15 / @25 bps` | WBTC (`75.65%` RV) `@10 / @15 / @25 bps` | Stressed (`80.0%` Vol `ASSUMED`) `@10 / @15 / @25 bps` |
| --- | --- | --- | --- | --- |
| `2s` (1 block) | `0.00 / 0.00 / 0.00` | `0.00 / 0.00 / 0.00` | `0.00 / 0.00 / 0.00` | `0.00 / 0.00 / 0.00` |
| `10s` | `0.00 / 0.00 / 0.00` | `0.00 / 0.00 / 0.00` | `0.01 / 0.00 / 0.00` | `0.02 / 0.00 / 0.00` |
| `30s` (Pull TTL) | `0.00 / 0.00 / 0.00` | `0.11 / 0.01 / 0.00` | `0.30 / 0.06 / 0.00` | `0.37 / 0.08 / 0.00` |
| `60s` | `0.00 / 0.00 / 0.00` | `0.49 / 0.13 / 0.00` | `0.94 / 0.35 / 0.03` | `1.10 / 0.44 / 0.04` |
| `300s` (5 min) | `0.05 / 0.00 / 0.00` | `3.55 / 2.28 / 0.81` | `5.15 / 3.67 / 1.69` | `5.64 / 4.11 / 2.00` |
| `1800s` (30 min) | `1.57 / 0.75 / 0.12` | `13.84 / 11.88 / 8.55` | `18.15 / 16.08 / 12.45` | `19.44 / 17.35 / 13.65` |
| `3600s` (1 hr) | `3.26 / 2.04 / 0.68` | `21.34 / 19.22 / 15.42` | `27.49 / 25.30 / 21.28` | `29.33 / 27.12 / 23.05` |

**Critical Architectural Result:**
1. **HSKSwap V3 TWAP is UNSAFE for Floating Strike on WETH and WBTC:** Observed mean inter-swap intervals are **`1.94 hours`** on WETH/USDT and **`16.0 hours`** on WBTC/USDT (`VERIFIED`), placing TWAP updates in the `> 1800s–3600s` toxicity regime (`12–25+ bps` toxic loss, completely wiping out a `15 bps` spread!). Even on WHSK/USDT (`19.2 min` average gap), a 30-min lag leaks `0.75–1.57 bps` and invites thin-pool spot manipulation.
2. **Pull Oracle + Hard Staleness Cap (`<= 30s`) Solves Toxicity:** With a fresh pull oracle (e.g., Pyth Hermes / RedStone or dual-signed EIP-712 price attestation) capped at **`maxStaleness <= 30s`** and minimum contracted spread **`s >= 15 bps`** (`25 bps` during high-vol regimes), expected staleness toxicity drops to **`0.00–0.08 bps`**, leaving **>99% of the spread as net LP return** while still beating HSKSwap AMM execution by `125–2,400+ bps` on block trades!

---

### 8.2 Mode B: FIXED STRIKE (`P_exec = K`, Predetermined Strike)

In Fixed Strike mode, an LP locks collateral to honor a predetermined price $K$ for tenor $T$. Economic payoff is identical to writing a **covered Call** (if LP locks base token to sell at $K$) or **cash-secured Put** (if LP locks USDT to buy at $K$). If the LP underprices this optionality—charging only a flat "swap-like" fee—the LP suffers guaranteed negative expected value from **short-gamma adverse selection** (takers only exercise when $K$ is in-the-money).

#### Black-Scholes Option Premium Floor (`INFERRED` from `VERIFIED` RV, `ASSUMED` `IV = 1.25 * RV`)

Table shows fair option cost in **bps of notional** using `IV = 1.25 * RV` (`21.05%` WHSK, `76.36%` WETH, `94.56%` WBTC) and the **AMM Breakeven Notional** where HSKSwap AMM all-in buy cost equals the option premium:

| Tenor $T$ | WHSK/USDT ATM (`+0%`) / `+2% OTM` | WETH/USDT ATM (`+0%`) / `+2% OTM` | WBTC/USDT ATM (`+0%`) / `+2% OTM` |
| --- | --- | --- | --- |
| `1h` | `8.97 bps` / `0.00 bps` | `32.55 bps` / `0.21 bps` | `40.31 bps` / `0.96 bps` |
| `6h` | `21.98 bps` / `0.00 bps` | `79.72 bps` (`BE ~$208`) / `17.11 bps` | `98.73 bps` (`BE ~$311`) / `30.04 bps` |
| `24h` | `43.96 bps` (`BE ~$582`) / `1.60 bps` | `159.44 bps` (`BE ~$541`) / `80.40 bps` (`BE ~$210`) | `197.45 bps` (`BE ~$759`) / `115.17 bps` (`BE ~$386`) |
| `72h` | `76.13 bps` (`BE ~$1,932`) / `14.94 bps` | `276.12 bps` (`BE ~$1,029`) / `190.20 bps` (`BE ~$670`) | `341.92 bps` (`BE ~$1,414`) / `254.50 bps` (`BE ~$1,017`) |
| `7d` (`168h`) | `116.29 bps` (`BE ~$3,616`) / `43.56 bps` (`BE ~$565`) | `421.66 bps` (`BE ~$1,637`) / `333.31 bps` (`BE ~$1,268`) | `522.07 bps` (`BE ~$2,231`) / `433.30 bps` (`BE ~$1,828`) |

**Key Fixed Strike Takeaways:**
1. **Must NOT be priced like a spot swap:** A 24-hour ATM Fixed Strike commitment on WETH (`76.4%` IV) or WBTC (`94.6%` IV) carries **`159–197 bps`** of pure option value—more than 5x the 30 bps AMM swap fee. Any LP quoting a naive `20–30 bps` fee on a 24h Fixed Strike loses `130–170 bps` expected value to arbitrageurs.
2. **Viable Niche for Fixed Strike:**
   - **Short-dated (`1h–6h`) execution price-locks** for large treasury/institutional trades (`>= $5,000` WHSK or `>= $1,000` WETH/WBTC), where option cost (`9–99 bps`) is dramatically lower than AMM slippage (`149–2,422 bps`).
   - **Out-of-the-money (`+2%` to `+5%` OTM) structured limit-fill / covered-yield commitments** (`24h–7d`), where LPs monetize passive idle inventory at `1.46%` (WHSK `+2%` OTM) to `73%–105%` gross option-premium APR (`ASSUMED` 25% utilization; note this is gross short-gamma premium, not risk-free yield!).

---

## 9. Protocol Design Recommendations

| Dimension | Recommended Specification | Quantitative Justification |
| --- | --- | --- |
| **Primary Mode** | **Floating Strike (`P_ref + spread`)** as default spot-execution primitive; **Fixed Strike** as explicit structured/short-tenor (`<= 24h`) option tranche. | Floating Strike decouples execution spread (`15–30 bps`) from multi-hour Black-Scholes gamma (`159–522 bps`), making it strictly cheaper than Fixed Strike for execution while protecting LPs from naive option mispricing. |
| **Oracle Architecture (Floating)** | **Pull oracle (Pyth / RedStone) or signed EIP-712 maker quote + on-chain circuit breaker**, `maxStaleness <= 30s`. **Reject HSKSwap V3 TWAP** as sole reference. | WETH (`1.9h`) & WBTC (`16h`) swap intervals cause `12–25+ bps` TWAP staleness toxicity vs. `0.00–0.08 bps` at `<= 30s` pull latency. |
| **Spread & Fee Bounds (Floating)** | `spread >= 15 bps` (WHSK) / `>= 20–25 bps` (WETH, WBTC) + `5–10 bps` non-refundable upfront reservation fee; minimum ticket `$1,000` (WETH/WBTC) / `$5,000` (WHSK). | Keeps staleness toxicity `< 0.1 bps`, gas drag `< 0.2 bps`, compensates inventory skew (`67–74%` sell-side), and guarantees `100–2,300+ bps` net savings vs. HSKSwap AMM. |
| **Pricing & Tenor Bounds (Fixed)** | Quote **upfront non-refundable premium `>= BS_IV(1.25 * RV)`** with `100%` collateral lock (`covered Call` / `cash-secured Put`) and max tenor `<= 24h` for ATM or `<= 7d` for `>= 2% OTM`. | Prevents LPs from bleeding short-gamma adverse selection; remains cheaper than AMM for `$1k+` WETH/WBTC and `$5k+` WHSK tickets. |
| **Target Customer Segment** | **HashKey Chain ecosystem treasuries, OTC desks, institutional market makers, and RWA issuers** (note 5 tokenized stock pools already deployed on HSKSwap with zero liquidity). | Retail swap flow (`$3.1k/day`, `$15–$100` median) fails `KC-1`/`KC-2`; true product-market fit is unlocking `$5k–$100k+` on-chain tickets currently blocked by `2.7%–120%` AMM slippage. |
