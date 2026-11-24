# Experiment 1A — Historical HSKSwap vs. Tranche Segregated Vault Counterfactual

> **Verdict:** **`INCONCLUSIVE`** *(Conditional **PASS** on hypothetical `$5k–$25k` `FLOATING` block flow under `5 bps` fee with prompt LP hedging; **FAIL** on observed 14-day retail HSKSwap swap flow (`0–3` swaps `>= $1k`), **FAIL** under `3x` adverse selection / failed restocking, and wide `90%` bootstrap CIs spanning zero on `24h` `FIXED` WETH/WBTC.)*  
> **Architecture Evaluated:** Current remediated Solidity contracts (`CommitmentManager.sol`, `LiquidityVault.sol`, `ExecutionTicket.sol`, `ExecutionRouter.sol` — segregated 1:1 ERC-20 vault + reservation/execution tickets, **not** a JIT V3 liquidity overlay).  
> **Reproducible Backtest:** [`scripts/market-analysis/05_experiment1_backtest.mjs`](../scripts/market-analysis/05_experiment1_backtest.mjs)  
> **Independent Verifier & Regression Suite:** [`scripts/market-analysis/06_verify_experiment1.mjs`](../scripts/market-analysis/06_verify_experiment1.mjs) (`3/3` passing)  
> **Machine-Readable Results:** [`scripts/market-analysis/experiment1_results.json`](../scripts/market-analysis/experiment1_results.json)

---

## 1. Line-by-Line Protocol Fee & Two-Token Accounting Reconciliation (Solidity Source of Truth)

Verified directly against [`CommitmentManager.sol#L616-L654`](../contracts/src/CommitmentManager.sol#L616-L654) and [`LiquidityVault.sol#L259-L334`](../contracts/src/LiquidityVault.sol#L259-L334) (`protocolFeeBps = 5`, $f = 0.0005$, `PRICE_SCALE = 1e36`):

### 1.1 Exact Solidity Cash Flows (`$10,000` WETH/USDT `FLOATING`, `base=10, daily=10, duration=24h, spread=25 bps`)

| Step | Solidity Function | Formula | Exact `$` Value (`$10k` WETH) | Who Pays / Receives |
| --- | --- | --- | ---: | --- |
| **1. Reservation Quote** | `_quoteReservation` | `effPremBps = 10 + ceil(10 * 86400 / 86400) = 20 bps`; `refPrice = spot * (1 + 0.0025)` | `notionalPay = $10,025.00` | Quote basis |
| **2. Gross Premium** | `collectFeeAndProceeds` | `grossPremium = ceil(notionalPay * 20 / 10000)` | **`$20.0500`** | Pulled from **Trader** |
| **3. Reservation Fee** | `_computeFeeCeil` | `fee_res = ceil(grossPremium * 5 / 10000)` | `$0.0100` | Credited to **Treasury** (`protocolFees`) |
| **4. LP Net Premium** | `_creditPayment` | `lpNet_res = grossPremium - fee_res` | `$20.0400` | Credited to **LP** (`lpPendingProceeds`) |
| **5. Gross Exercise** | `_quoteExercise` | `grossPayment = ceil(q * P_ex * (1 + 0.0025))` | **`$10,025.0000`** | Pulled from **Trader** |
| **6. Exercise Fee** | `_computeFeeCeil` | `fee_ex = ceil(grossPayment * 5 / 10000)` | `$5.0125` | Credited to **Treasury** (`protocolFees`) |
| **7. LP Net Exercise** | `settleExercise` | `lpNet_ex = grossPayment - fee_ex` | `$10,019.9875` | Credited to **LP** (`lpPendingProceeds`) |
| **Conservation Check** | `LiquidityVault` | `Trader Paid ($10,045.05) == LP Receipts ($10,040.0275) + Treasury ($5.0225)` | **`$0.0000` drift** | Verified by `06_verify_experiment1.mjs` |

### 1.2 Audit of the Apparent Double Subtraction of `protocolFeeBps`
The shorthand expression `spreadBps * (1 - f) - protocolFeeBps` is **algebraically identical** to subtracting `protocolFeeBps` **once** from gross exercise notional `(1 + s) * (1 - f) - 1`:

$$(1 + s)(1 - f) - 1 = 1 + s - f - sf - 1 = s(1 - f) - f$$

For $s = 25\text{ bps}$ and $f = 5\text{ bps}$: `(1.0025 * 0.9995 - 1) * 10000 = +19.9875 bps`, matching `$10,019.9875 - $10,000 = +$19.9875`. **There is zero double subtraction.** However, to eliminate any ambiguity, `05_experiment1_backtest.mjs` now computes LP P&L directly from the **explicit two-token balance sheet** (`invToken` + `paymentToken` cash flows from $t_0$ to $t_{\text{end}}$) rather than a shorthand bps approximation, and also matches Solidity's exact `refPriceRes = spot * (1 + spread)` reservation basis.

---

## 2. Observed 14-Day Mainnet Data vs. Hypothetical Block Demand (`OBSERVED ON-CHAIN` vs. `ASSUMED`)

### 2.1 Observed 14-Day Retail HSKSwap Dataset (`2026-11-10 -> 2026-11-24`, `1,241` Swaps)

| Pool (`0.30%` fee) | TVL (`$`) | 14d Swaps | 14d Vol (`$`) | Max Swap (`$`) | Swaps `>= $1k` | Passive V3 Fee APR | 14d HODL Return | 14d Full-Range V3 IL |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **WHSK/USDT** | `$839,209` | `1,047` | `$20,689.88` | `$502.15` | `0` | `0.193%` | `-3.447%` | `-0.015%` |
| **WETH/USDT** | `$83,695` | `173` | `$13,650.69` | `$510.74` | `0` | `1.276%` | `-18.932%` | `-0.548%` |
| **WBTC/USDT** | `$90,721` | `21` | `$9,712.90` | `$1,026.64` | `3` | `0.837%` | `-16.538%` | `-0.407%` |

**Strict Demand Separation:** `99.76%` of observed swaps (`1,238 / 1,241`) were `< $1,000`. Observed AMM volume does **not** establish `25%` vault utilization at `$5k–$25k`; all `$1k–$25k` utilization scenarios below represent **hypothetical institutional / treasury / agentic block demand**.

---

## 3. Trader Savings & Two-Token LP P&L (`$10,000`, `Base`, `24h`, `5 bps` Fee, Hypothetical `25%` Utilization)

| Pool | HSKSwap V3 (`$10k`, Verified) | Tranche `FLOATING` All-In | **Trader Savings** | `FLOATING` LP Net / Cycle | `FLOATING` LP APR (`91.25` turns/yr) | `FIXED` LP Net vs HODL (`n=14` 90% CI) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **WHSK/USDT** | `268.46 bps` | `40.06 bps` | **`+228.40 bps`** | `+17.45 bps` | `15.93%` (`vs 0.193%` V3) | `+41.20 bps` (`[+33.39, +45.10]`) |
| **WETH/USDT** | `2,421.58 bps` | `45.07 bps` | **`+2,376.51 bps`** | `+22.56 bps` | `20.59%` (`vs 1.276%` V3) | `+33.38 bps` (`[-5.73, +65.96]`) |
| **WBTC/USDT** | `2,235.71 bps` | `45.07 bps` | **`+2,190.64 bps`** | `+22.56 bps` | `20.59%` (`vs 0.837%` V3) | `+18.50 bps` (`[-38.33, +62.21]`) |

*(All `12/12` V3 curve costs across `$1k`, `$5k`, `$10k`, `$25k` were independently reconstructed from raw `poolStates` in `market_data_14d.json` with `0.00 bps` error at `$10k`.)*

---

## 4. Hedging & Restocking Stress Matrix (`$10,000` `FLOATING`, Full Exercise, `5 bps` Fee)

Measured inputs: observed 14-day independent `6h` (`n = 56`) and `24h` (`n = 14`) price paths, gas (`$0.01036` LP cycle). Assumed inputs: prompt oracle-lag markout (`8 bps` WHSK / `12 bps` WETH & WBTC) and CEX/OTC restock cost (`10 bps` WHSK / `5 bps` WETH & WBTC at `1x`).

| Hedging Regime | WHSK/USDT LP P&L vs HODL | WETH/USDT LP P&L vs HODL | WBTC/USDT LP P&L vs HODL | Notes |
| --- | ---: | ---: | ---: | --- |
| **Prompt Hedge (`1x` restock)** | `+17.00 bps` (`15.51%` APR) | `+23.01 bps` (`21.00%` APR) | `+23.01 bps` (`21.00%` APR) | Assumes prompt CEX restock |
| **Prompt Hedge (`2x` restock)** | `+6.99 bps` (`6.38%` APR) | `+18.01 bps` (`16.43%` APR) | `+18.01 bps` (`16.43%` APR) | `20 bps` WHSK / `10 bps` WETH-WBTC |
| **Prompt Hedge (`3x` restock)** | **`-3.01 bps` (LOSS)** | `+13.00 bps` (`11.86%` APR) | `+13.00 bps` (`11.86%` APR) | WHSK breaks even at `27 bps` restock |
| **Delayed Hedge (`6h`, `n=56` 90% CI)** | `+31.31 bps` (`[+24.89, +38.20]`) | `+72.34 bps` (`[+36.87, +104.82]`) | `+66.56 bps` (`[+36.73, +101.92]`) | **Bear-sample artifact** (all 3 assets fell) |
| **Zero Hedge (`24h`, `n=14` 90% CI)** | `+58.93 bps` (`[+31.02, +100.51]`) | `+184.16 bps` (`[+59.75, +325.61]`) | `+156.15 bps` (`[+16.55, +335.09]`) | **Bear-sample artifact** (holding USDT beat HODL) |
| **Failed Restock (`p90` 24h Rally + `3x` Restock)** | **`-15.00 bps` (`-$15.00`)** | **`-139.93 bps` (`-$139.93`)** | **`-200.67 bps` (`-$200.67`)** | **Exposes unhedged upside tail risk** |

**Critical Warning on Delayed / Zero Hedging:** Because WHSK (`-3.45%`), WETH (`-18.93%`), and WBTC (`-16.54%`) declined during the 14-day sample, holding USDT unhedged mechanically outperformed HODL. In an upward rally (`p90` 24h move = `+164.7 bps` WETH, `+225.4 bps` WBTC), failed restocking inflicts **`-140` to `-201 bps`** single-cycle losses — proving prompt hedging is structurally required for `FLOATING` LPs.

---

## 5. Reservation Fill Behavior (`$10,000` `FLOATING`, `24h`, `5 bps` Fee, Prompt Hedge)

| Fill Outcome | WHSK LP P&L vs HODL (Treasury Fee) | WETH / WBTC LP P&L vs HODL (Treasury Fee) | Economic Mechanism |
| --- | ---: | ---: | --- |
| **`100%` Exercised** | `+17.00 bps` (`$5.0200`) | `+23.01 bps` (`$5.0225`) | LP earns premium + spread minus `5 bps` principal fee, lag, and restock |
| **`50%` Partial Fill** | `+18.51 bps` (`$2.5150`) | `+21.52 bps` (`$2.5163`) | Non-refundable premium covers full `$10k`; half inventory reclaimed at expiry |
| **`0%` Expired Unexercised** | **`+20.02 bps`** (`$0.0100`) | **`+20.03 bps`** (`$0.0100`) | LP keeps `$20.03–$20.04` net upfront premium + `100%` of inventory |

---

## 6. Block-Bootstrap Confidence Intervals & Turnover-Capped Duration Sensitivity (`$10,000`)

### 6.1 Independent-Window `90%` Block-Bootstrap (`1,000` Deterministic Resamples, `n = 14` Non-Overlapping 24h Windows)
| Pool | Empirical `24h` `FIXED` Call Cost (`median` / `90% CI`) | `24h` `FIXED` LP Net vs HODL (`median` / `90% CI`) | Statistical Takeaway |
| --- | --- | --- | --- |
| **WHSK/USDT** | `2.83 bps` (`[0.00, 8.48]`) | `+41.20 bps` (`[+33.39, +45.10]`) | Positive across entire `90%` CI in low-vol 14d sample |
| **WETH/USDT** | `31.85 bps` (`[3.62, 73.08]`) | `+37.68 bps` (`[-5.73, +65.96]`) | **Spans zero** — cannot claim positive `24h` `FIXED` alpha |
| **WBTC/USDT** | `50.32 bps` (`[12.40, 109.30]`) | `+18.68 bps` (`[-38.33, +62.21]`) | **Spans zero** with `-38.3 bps` lower `90%` bound |

### 6.2 Turnover-Capped Duration Sensitivity (`WETH/USDT`, `$10k`, Capped at `91.25` Annual Turns)
| Duration | Capped Annual Turns | `FLOATING` Trader Cost | `FLOATING` LP Net / Cycle | `FLOATING` Capped APR | `FIXED` LP Net / Cycle | `FIXED` Capped APR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **`1h`** | `91.25` | `36.05 bps` | `+13.54 bps` | `12.36%` | `+24.95 bps` | `22.77%` |
| **`6h`** | `91.25` | `38.05 bps` | `+15.55 bps` | `14.19%` | `+22.98 bps` | `20.97%` |
| **`24h`** | `91.25` | `45.07 bps` | `+22.56 bps` | `20.59%` | `+33.38 bps` | `30.46%` |
| **`72h`** | `30.42` | `65.12 bps` | `+42.60 bps` | `12.96%` | `+90.49 bps` | `27.52%` |

---

## 7. Honest Overall Verdict: **`INCONCLUSIVE`**

- **Proven:** Under exact Solidity `5 bps` fee accounting, Tranche `FLOATING` saves block traders **`+228` to `+2,377 bps`** vs. HSKSwap V3 at `$10k` and yields **`+17.4` to `+22.6 bps/cycle`** (`15.9%–20.6%` APR at hypothetical `25%` utilization) **when LPs hedge promptly**, with non-refundable reservation premiums protecting LP yield on partial (`50%`) and expired (`0%`) fills.
- **Unproven / Failing Criteria Keeping Verdict `INCONCLUSIVE`:**
  1. **Observed retail demand (`C4`) fails:** Only `3` swaps `>= $1,000` occurred across all 3 pools in 14 days (`0` WHSK, `0` WETH).
  2. **Prompt hedging is load-bearing:** Failed restocking during a `p90` 24h rally loses `-140` to `-201 bps/cycle`, and `3x` restock cost turns WHSK `FLOATING` negative (`-3.01 bps`).
  3. **Small sample (`n = 14` independent days, bear-only regime):** `90%` bootstrap CIs for `24h` `FIXED` WETH (`[-5.73, +65.96]`) and WBTC (`[-38.33, +62.21]`) span zero.

---

## 8. Reproduction Instructions

```bash
node scripts/market-analysis/05_experiment1_backtest.mjs
node --test scripts/market-analysis/06_verify_experiment1.mjs
```
