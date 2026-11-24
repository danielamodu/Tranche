# Experiment 1 — Historical HSKSwap vs. Tranche Economic Backtest

> **Verdict:** **`INCONCLUSIVE`** *(Conditional **PASS** on block-size `FLOATING` unit economics at `$1k–$25k` under `5 bps` protocol fee; **FAIL** on observed 14-day retail HSKSwap swap flow, **FAIL** on underpriced 24h `FIXED` tickets for volatile WETH/WBTC, and **FAIL** under `3x` adverse selection unless LP spreads widen dynamically.)*  
> **Reproducible Script:** [`scripts/market-analysis/05_experiment1_backtest.mjs`](../scripts/market-analysis/05_experiment1_backtest.mjs)  
> **Machine-Readable Results:** [`scripts/market-analysis/experiment1_results.json`](../scripts/market-analysis/experiment1_results.json)  
> **Observed Dataset:** [`scripts/market-analysis/market_data_14d.json`](../scripts/market-analysis/market_data_14d.json) & [`scripts/market-analysis/analysis_summary.json`](../scripts/market-analysis/analysis_summary.json) (HashKey Chain Mainnet `177`, blocks `29,978,347 -> 30,583,147`, `2026-11-10T09:43:49Z -> 2026-11-24T09:43:49Z`, `1,241` swaps across 3 pools)

---

## 1. Pre-Registered Economic Pass / Fail Criteria

Defined prior to inspecting backtest outputs. For an unconditional **`PASS`**, ALL FOUR criteria must hold simultaneously under the **Base** scenario:

| Criterion | Threshold | Result |
| --- | --- | --- |
| **`C1` (Trader Advantage)** | Tranche all-in execution cost beats HSKSwap V3 by **`>= 25 bps`** on `$5k` and `$10k` trades | **PASS** (all 3 pools, `+109` to `+2,377 bps`) |
| **`C2` (LP Positive Unit Margin)** | LP net margin per cycle **`> 0 bps`** after `5 bps` protocol fee, CEX/OTC restock cost (`C_rebal`), adverse markout (`M_tox`), and gas | **PASS** on Base `FLOATING` (`+17.4` to `+22.5 bps`); **FAIL** on Base `FIXED` WETH/WBTC (`-17.1` / `-3.3 bps`) and Adverse `FLOATING` (`-7.6` / `-4.7 bps`) |
| **`C3` (Beats Passive V3 APR)** | Annualized LP return exceeds observed 14-day passive HSKSwap V3 fee APR (`0.193%` / `1.276%` / `0.837%`) | **PASS** on Base `FLOATING` (`15.9%` / `20.6%` / `20.6%` APR at `25%` utilization) |
| **`C4` (Empirical Retail Demand)** | Observed 14-day HSKSwap swaps contain **`>= 14`** swaps `>= $1,000` (`>= 1/day`) in at least one pool | **FAIL** (`0` WHSK, `0` WETH, `3` WBTC across 14 days) |

---

## 2. Dataset Audit & Provenance Separation

### 2.1 Observed 14-Day Mainnet Data (`OBSERVED ON-CHAIN`)
Extracted directly from `https://mainnet.hsk.xyz` (`Chain ID 177`, `500.001 gwei` gas price, `WHSK = $0.080808`, `2.0000s` block time) via [`02_collect_pool_data.mjs`](../scripts/market-analysis/02_collect_pool_data.mjs):

| Pool (`0.30%` fee) | TVL (`$`) | 14d Swaps | 14d Vol (`$`) | Max Swap (`$`) | Swaps `>= $1k` | Realized Median V3 Cost | Passive V3 Fee APR | 14d HODL Return | 14d Full-Range V3 IL |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **WHSK/USDT** | `$839,209` | `1,047` | `$20,689.88` | `$502.15` | `0` | `30.36 bps` | `0.193%` | `-3.447%` | `-0.015%` |
| **WETH/USDT** | `$83,695` | `173` | `$13,650.69` | `$510.74` | `0` | `52.89 bps` | `1.276%` | `-18.932%` | `-0.548%` |
| **WBTC/USDT** | `$90,721` | `21` | `$9,712.90` | `$1,026.64` | `3` | `140.18 bps` | `0.837%` | `-16.538%` | `-0.407%` |

**Key Empirical Finding:** `99.76%` of observed historical HSKSwap swaps (`1,238 / 1,241`) were `< $1,000`. Even at the contract's low remediated `tokenMinTicketAmount` floors (`1,000 WHSK ≈ $80.81`, `0.05 WETH ≈ $85.20`, `0.001 WBTC ≈ $61.83`), only `15` WHSK swaps (`$2,403.78`), `93` WETH swaps (`$11,047.90`), and `17` WBTC swaps (`$9,711.67`) qualified over 14 days.

### 2.2 Simulated / Assumed Parameters (`SIMULATED / ASSUMED`)
- **Tranche Accounting (Exact Remediated Contract Formula):** `effPremiumBps = basePremiumBps + ceil(dailyPremiumBps * duration / 86400)`; `protocolFeeBps = 5` deducted from LP gross receipts (`grossPremium` + `grossPayment`), **never double-counted** on top of trader cost.
- **HSKSwap V3 All-In Cost:** Taken from the exact on-chain V3 tick curve (`analysis_summary.json` `priceImpactTable`, which already incorporates the `30 bps` pool fee + curve slippage) plus `medianSwapCostUsd` (`$0.00443`) gas — zero double-counting.
- **Tranche Gas (Measured on Chain-133 Fork, Priced at Mainnet `500.001 gwei`):** Trader `reserve + exercise` = `466,590` gas (`$0.01885`); LP `createOffer + claimProceeds` = `256,456` gas (`$0.01036`).
- **LP Restock / Hedging Cost (`C_rebal`):** LPs do **not** restock at oracle mid for free. Modeled at `10 bps` (WHSK) and `5 bps` (WETH/WBTC) in Base, doubled (`20 bps` / `10 bps`) in Adverse Selection.
- **Adverse Selection (`M_tox`):**
  - `FLOATING`: Oracle-lag markout modeled at `8 bps` (WHSK) and `12 bps` (WETH/WBTC) in Base (`1.2x` in High Utilization; `3.0x` = `24 bps` / `36 bps` in Adverse Selection).
  - `FIXED`: Covered-call upside forgone measured directly from **empirical rolling 24-hour price paths** in `market_data_14d.json`: `2.87 bps` (WHSK, `19.0%` ITM), `98.92 bps` (WETH, `29.7%` ITM), and `90.52 bps` (WBTC, `30.8%` ITM) above `+30/+50 bps` strike offsets.

---

## 3. Trader Savings & LP Returns Across `$1k`, `$5k`, `$10k`, `$25k` (`Base`, `24h`, `5 bps` Fee, `25%` Utilization)

### 3.1 `FLOATING` Mode (`base=10, daily=10, spread=20 bps WHSK / 25 bps WETH & WBTC`)

| Pool | Size (`$`) | HSKSwap V3 All-In | Tranche All-In | **Trader Savings** | LP Net / Cycle | **LP Annualized APR** | Beats V3 Fee APR? |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| **WHSK/USDT** | `$1,000` | `53.97 bps` | `40.19 bps` | `+13.78 bps` | `+17.33 bps` | `15.81%` | Yes (`vs 0.193%`) |
| **WHSK/USDT** | `$5,000` | `149.28 bps` | `40.04 bps` | **`+109.24 bps`** | `+17.41 bps` | `15.89%` | Yes |
| **WHSK/USDT** | `$10,000` | `268.46 bps` | `40.02 bps` | **`+228.44 bps`** | `+17.42 bps` | `15.90%` | Yes |
| **WHSK/USDT** | `$25,000` | `626.00 bps` | `40.01 bps` | **`+585.99 bps`** | `+17.43 bps` | `15.90%` | Yes |
| **WETH/USDT** | `$1,000` | `269.28 bps` | `45.19 bps` | **`+224.10 bps`** | `+22.43 bps` | `20.46%` | Yes (`vs 1.276%`) |
| **WETH/USDT** | `$5,000` | `1,225.84 bps` | `45.04 bps` | **`+1,180.81 bps`** | `+22.51 bps` | `20.54%` | Yes |
| **WETH/USDT** | `$10,000` | `2,421.58 bps` | `45.02 bps` | **`+2,376.57 bps`** | `+22.52 bps` | `20.55%` | Yes |
| **WETH/USDT** | `$25,000` | `6,008.82 bps` | `45.01 bps` | **`+5,963.81 bps`** | `+22.53 bps` | `20.55%` | Yes |
| **WBTC/USDT** | `$1,000` | `250.70 bps` | `45.19 bps` | **`+205.51 bps`** | `+22.43 bps` | `20.46%` | Yes (`vs 0.837%`) |
| **WBTC/USDT** | `$5,000` | `1,132.91 bps` | `45.04 bps` | **`+1,087.87 bps`** | `+22.51 bps` | `20.54%` | Yes |
| **WBTC/USDT** | `$10,000` | `2,235.71 bps` | `45.02 bps` | **`+2,190.69 bps`** | `+22.52 bps` | `20.55%` | Yes |
| **WBTC/USDT** | `$25,000` | `5,544.12 bps` | `45.01 bps` | **`+5,499.11 bps`** | `+22.53 bps` | `20.55%` | Yes |

### 3.2 `FIXED` Mode (`24h`, Empirical Rolling-Window Option Cost Included — Unprofitable Cases Exposed)

| Pool | Size (`$10k`) | HSKSwap V3 | Tranche All-In | Trader Savings | Empirical 24h Call Cost | **LP Net vs HODL / Cycle** | **LP APR vs HODL** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **WHSK/USDT** | `$10,000` | `268.46 bps` | `75.02 bps` | `+193.44 bps` | `2.87 bps` | **`+44.95 bps`** | **`+41.01%`** |
| **WETH/USDT** | `$10,000` | `2,421.58 bps` | `120.02 bps` | `+2,301.57 bps` | **`98.92 bps`** | **`-17.10 bps` (LOSS)** | **`-15.60%` (FAIL)** |
| **WBTC/USDT** | `$10,000` | `2,235.71 bps` | `125.02 bps` | `+2,110.69 bps` | **`90.52 bps`** | **`-3.27 bps` (LOSS)** | **`-2.98%` (FAIL)** |

**Why `FIXED` Fails on WETH & WBTC at 24h:** Even during a 14-day drawdown (`-18.9%` WETH, `-16.5%` WBTC), sharp intraday/24h bounce rallies created `90–99 bps` of realized call-option payoff. Selling 24h `FIXED` tickets at `70–75 bps` total premium underprices realized volatility (`61%–76%` annualized). Shortening `FIXED` duration to **`1h`** flips WETH (`+12.78 bps/cycle`) and WBTC (`+15.49 bps/cycle`) back to profitable.

---

## 4. Scenario Stress Comparison (`$10,000` `FLOATING`, `24h`, `5 bps` Fee)

| Pool | Base (`25%` util, `1x` tox/rebal) | High Utilization (`65%` util, `1.2x` tox) | **Adverse Selection (`25%` util, `3x` tox, `2x` rebal)** |
| --- | ---: | ---: | ---: |
| **WHSK/USDT** | `+17.42 bps` (`+15.90%` APR) | `+15.83 bps` (`+37.56%` APR) | **`-7.58 bps` (`-6.92%` APR — FAIL)** |
| **WETH/USDT** | `+22.52 bps` (`+20.55%` APR) | `+20.51 bps` (`+48.66%` APR) | **`-4.73 bps` (`-4.32%` APR — FAIL)** |
| **WBTC/USDT** | `+22.52 bps` (`+20.55%` APR) | `+20.51 bps` (`+48.66%` APR) | **`-4.73 bps` (`-4.32%` APR — FAIL)** |

**Takeaway:** Under `3x` adverse markout (`24–36 bps`) and `2x` restock cost (`10–20 bps`), static `20–25 bps` spreads lose money. However, because HSKSwap V3 costs `268–2,422 bps` on `$10k`, LPs have wide pricing headroom to raise `spreadBps` to `40–60 bps` in volatile regimes and stay both LP-profitable and `>200–2,300 bps` cheaper than HSKSwap V3.

---

## 5. Sensitivity Analysis (`$10,000` Ticket, Base Scenario)

### 5.1 Protocol Fee Sensitivity (`protocolFeeBps` — Proves Phase 2 `5 bps` Remediation Was Essential)
| `protocolFeeBps` | WHSK `FLOATING` LP Net (APR) | WETH `FLOATING` LP Net (APR) | WBTC `FLOATING` LP Net (APR) |
| ---: | ---: | ---: | ---: |
| **`0 bps`** | `+21.69 bps` (`+19.79%`) | `+26.79 bps` (`+24.45%`) | `+26.79 bps` (`+24.45%`) |
| **`5 bps` (Remediated)** | **`+17.42 bps` (`+15.90%`)** | **`+22.52 bps` (`+20.55%`)** | **`+22.52 bps` (`+20.55%`)** |
| **`10 bps`** | `+13.15 bps` (`+12.00%`) | `+18.25 bps` (`+16.65%`) | `+18.25 bps` (`+16.65%`) |
| **`25 bps`** | `+0.35 bps` (`+0.32%`) | `+5.44 bps` (`+4.96%`) | `+5.44 bps` (`+4.96%`) |
| **`50 bps` (Pre-Rem. `main`)** | **`-21.00 bps` (`-19.16%`)** | **`-15.92 bps` (`-14.52%`)** | **`-15.92 bps` (`-14.52%`)** |

### 5.2 Commitment Duration Sensitivity (`WETH/USDT` `$10k`, `25%` Utilization)
| Duration | `FLOATING` Trader Cost | `FLOATING` LP Net / Cycle | `FIXED` Trader Cost | `FIXED` LP Net vs HODL / Cycle |
| ---: | ---: | ---: | ---: | ---: |
| **`1h`** | `36.02 bps` | `+13.52 bps` | `77.02 bps` | **`+12.78 bps`** |
| **`6h`** | `38.02 bps` | `+15.52 bps` | `87.02 bps` | `-6.49 bps` |
| **`24h`** | `45.02 bps` | `+22.52 bps` | `120.02 bps` | `-17.10 bps` |
| **`72h`** | `65.02 bps` | `+42.51 bps` | `210.02 bps` | `+9.13 bps` |

### 5.3 Capital Utilization Sensitivity (`$10k` `FLOATING`, `24h`, `5 bps` Fee)
| Utilization | WHSK LP APR (`vs 0.193%` V3) | WETH LP APR (`vs 1.276%` V3) | WBTC LP APR (`vs 0.837%` V3) |
| ---: | ---: | ---: | ---: |
| **`10%`** | `6.36%` | `8.22%` | `8.22%` |
| **`25%` (Base)** | `15.90%` | `20.55%` | `20.55%` |
| **`50%`** | `31.79%` | `41.10%` | `41.10%` |
| **`75%`** | `47.69%` | `61.65%` | `61.65%` |

---

## 6. Explicit Limitations of the 14-Day Sample
1. **Short & One-Sided Regime:** All 3 assets declined over `2026-11-10 -> 2026-11-24` (`-3.4%` WHSK, `-18.9%` WETH, `-16.5%` WBTC). A bull rally would increase `FIXED` call-exercise losses further while leaving `FLOATING` unaffected except for oracle-lag toxicity.
2. **Sparse WBTC Prints (`21` swaps / 14 days):** Only `13` rolling 24h windows exist on WBTC/USDT; empirical option payoff estimates on WBTC have high variance.
3. **Selection Bias on Observed Sizes:** Traders currently avoid `$5k–$25k` swaps on HSKSwap because slippage is `12%–60%`. Absent off-chain OTC/institutional orderflow logs, latent demand at `$5k–$25k` cannot be proved from AMM logs alone.
4. **Static Rebalancing Cost Assumption:** Real LP restocking depends on CEX liquidity, bridge latency, and funding rates not captured in on-chain DEX logs.

---

## 7. Honest Final Verdict: `INCONCLUSIVE`

- **Where Tranche Clearly Wins (Defensible Wedge):** On **`$5k–$25k` institutional / treasury / agentic block tickets in `FLOATING` mode (`protocolFeeBps = 5`)**, Tranche cuts trader execution costs by **`109–5,964 bps`** vs. HSKSwap V3 while generating **`15.9%–20.6%` annualized LP APR at `25%` utilization** (`15x–82x` observed passive HSKSwap V3 fee APR) without exposing LPs to `FIXED`-strike option convexity.
- **Why the Overall Verdict Is `INCONCLUSIVE` (Not Unconditional `PASS`):**
  1. **No Observed Retail Block Flow (`C4` Failed):** `99.76%` of observed 14-day HSKSwap swaps are `< $1,000`. Tranche's economic advantage requires attracting institutional/OTC/agentic block demand that currently routes off-chain.
  2. **`FIXED` Mode Requires Short Durations (`<= 1h`) or Vol-Adjusted Premiums on WETH/WBTC:** Naive 24h `FIXED` pricing loses `-3.3` to `-17.1 bps/cycle` vs. HODL.
  3. **Adverse-Selection Sensitivity:** Static `20–25 bps` `FLOATING` spreads turn negative (`-4.7` to `-7.6 bps`) under `3x` oracle-lag markout; LPs must price spreads dynamically in volatile regimes.

---

## 8. Reproduction Instructions

```bash
node scripts/market-analysis/05_experiment1_backtest.mjs
# Outputs: scripts/market-analysis/experiment1_results.json

node --test scripts/market-analysis/06_verify_experiment1.mjs
# Independent zero-shared-code verification suite (3/3 tests)
```

---

## 9. Independent Quantitative Verification & Assumption Audit

An independent verification suite ([`06_verify_experiment1.mjs`](../scripts/market-analysis/06_verify_experiment1.mjs), `3/3` passing, zero shared math with `03_analyze_market.mjs` or `05_experiment1_backtest.mjs`) reconstructed all benchmark figures directly from raw `poolStates` and `events.swaps` in `market_data_14d.json` and compared them against exact Solidity `BigInt` `CommitmentManager.sol` equations.

### 9.1 Raw On-Chain V3 Execution Cost Reconstruction (`$10,000` Buy Base)

| Pool | Decimals / Fee | Independent Tick-Step (`+Gas`) | Closed-Form Full-Range `x*y=k` Cross-Check | Reported in Experiment 1 | Delta |
| --- | --- | ---: | ---: | ---: | ---: |
| **WHSK/USDT** | `18 / 6`, `0.30%` | `268.46 bps` (`268.45` ex-gas) | `266.89 bps` | `268.46 bps` | **`0.00 bps`** |
| **WETH/USDT** | `18 / 6`, `0.30%` | **`2,421.58 bps`** (`2,421.58` ex-gas) | `2,414.62 bps` | `2,421.58 bps` | **`0.00 bps`** |
| **WBTC/USDT** | `8 / 6`, `0.30%` | **`2,235.71 bps`** (`2,235.70` ex-gas) | `2,230.34 bps` | `2,235.71 bps` | **`0.00 bps`** |

- All `12/12` pool-size points (`$1k`, `$5k`, `$10k`, `$25k` across 3 pools) matched within `< 0.05 bps`, and reconstructed active tick liquidity `L` matched on-chain `pool.liquidity()` within `< 1e-12` relative error.
- *(Note: The small `~5–7 bps` gap between exact tick-step `L` and raw `bal0Raw`/`bal1Raw` `x*y=k` is expected because pool token balances include uncollected V3 fees outside active `L`.)*

### 9.2 Exact Solidity `BigInt` Contract Arithmetic Check
- Reconstructed `_quoteReservation` and `_quoteExercise` with exact `Math.Rounding.Ceil` integer math (`PRICE_SCALE = 1e36`, `protocolFeeBps = 5`).
- **Minor Approximation Identified (`0.05 bps`):** In `CommitmentManager.sol`, `FLOATING` `_quoteReservation` computes `grossPremium` on `effPriceX36 = spot * (1 + spreadBps/10000)` rather than `1.0 * spot` (`20 * 1.0025 + 25 = 45.05 bps` vs. `45.00 bps` in `05_experiment1_backtest.mjs`). This `0.05 bps` second-order term does not affect any conclusion. Zero fee double-counting was found.

### 9.3 Material Assumptions Driving Positive `FLOATING` Results (Disclosed Explicitly)
1. **Prompt LP Hedging vs. 24h Unhedged Markout:** Base `FLOATING` break-even markout is **`28.51 bps`** (WHSK) and **`38.51 bps`** (WETH/WBTC). Observed **unhedged 24h** post-buy markout in the 14-day dataset was `73.0 bps` (WETH) and `114.63 bps` (WBTC). Positive `FLOATING` LP returns therefore **require LPs to hedge/restock promptly upon fill** (incurring `8–12 bps` short-horizon oracle-lag markout rather than 24h unhedged drift).
2. **`1h` Duration APR Turnover Artifact:** At `24h` duration and `25%` utilization, implied annual turnover is `91.25x`. At `1h` duration and `25%` utilization, the sensitivity sweep assumes `2,190x` annual turnover (`8,760 * 0.25`), making the `184.5%–296.2%` `1h` APRs theoretical upper bounds rather than realistic steady-state yields.
3. **Latent Block Demand Assumption:** `1,241` observed swaps were independently recounted (`1,047` WHSK, `173` WETH, `21` WBTC). Sustaining `25%` vault utilization requires institutional/OTC/agentic block demand (`$5k–$25k`) beyond observed retail HSKSwap flow.

### 9.4 Verification Verdict
**REPRODUCIBLE & DEFENSIBLE FOR HACKATHON SUBMISSION** — Provided the submission quotes the **`24h` Base `FLOATING`** numbers alongside the honest **`INCONCLUSIVE`** overall verdict, explicitly cites the prompt-hedging assumption, and does **not** headline the `1h` turnover-inflated APRs or claim observed retail demand at `$10k`.
