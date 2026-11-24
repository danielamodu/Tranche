# Tranche — Mainnet Economic Revalidation (Workstream C)

> **Baseline Commit:** `f5d61e76134fd3badc831d10136318431aabd413` (`main`) — read-only economic audit  
> **Target Network:** HashKey Chain Mainnet (Chain ID `177`, snapshot block `30583147`, 14d window `29978347 -> 30583147`)  
> **Scope:** Independent challenge and revalidation of [ECONOMIC_MODEL.md](file:///c:/Users/USER/Desktop/Tranche/research/ECONOMIC_MODEL.md) against [CommitmentManager.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol), [LiquidityVault.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/LiquidityVault.sol), [market_data_14d.json](file:///c:/Users/USER/Desktop/Tranche/scripts/market-analysis/market_data_14d.json), [analysis_summary.json](file:///c:/Users/USER/Desktop/Tranche/scripts/market-analysis/analysis_summary.json), and [model_evaluation.json](file:///c:/Users/USER/Desktop/Tranche/scripts/market-analysis/model_evaluation.json).

---

## 1. Evidence Classification & Executive Summary

Every quantitative value in this document is explicitly labeled using three strict provenance tags:

| Tag | Definition |
| --- | --- |
| `MEASURED (ON-CHAIN)` | Directly observed from HashKey Chain mainnet RPC logs/state (`market_data_14d.json`, `analysis_summary.json`, `INFRASTRUCTURE_AUDIT.md`) or directly read from frozen repository contract/SDK parameters (`CommitmentManager.sol`, `deploy.ts`, `engine.ts`). Gas unit counts from local Foundry suite are labeled `MEASURED (FOUNDRY)`. |
| `ESTIMATED (DERIVED)` | Deterministically computed from `MEASURED` inputs via exact contract accounting equations, Uniswap V3 tick math, Black-Scholes / Gaussian toxicity integrals, or Foundry gas $\times$ `500.001 gwei` $\times$ `$0.080808` WHSK conversion. |
| `ASSUMED` | External market benchmarks, behavioral parameters, or stress inputs not observable on HashKey Chain (`4.0%–5.0%` USD T-bills, `5%–10%` DeFi lending, `stHSK` yield, `5–10 bps` CEX/OTC spreads, `5–30 bps` adverse markout, `80%/120%` stressed vol, `5%–50%` utilization, `20%–100%` exercise rates). |

### Executive Revalidation Verdict

[ECONOMIC_MODEL.md](file:///c:/Users/USER/Desktop/Tranche/research/ECONOMIC_MODEL.md) accurately measured HSKSwap V3's shallow tick depth (`0.50%` of `$1.01M` TVL within `+/- 100 bps`) and low passive LP APR (`0.19%–1.28%`), **but its economic viability conclusions are overly optimistic and break under five real-world constraints:**

1. **Contract Accounting Bug / Fee Trap (`protocolFeeBps = 50` breaks LP unit economics):** In [CommitmentManager.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L484-L522), `protocolFeeBps` is charged **both** on `grossPremium` during `reserve()` **and** on `grossPayment` (100% of trade notional!) during `exercise()`, deducted from LP proceeds (`grossPay - fee`). Across [deploy.ts](file:///c:/Users/USER/Desktop/Tranche/sdk/src/deploy.ts#L139), [engine.ts](file:///c:/Users/USER/Desktop/Tranche/demo/src/engine.ts#L362), and Foundry tests, `protocolFeeBps` defaults to **`50 bps`** (`0.50%`). At `protocolFeeBps = 50`, the recommended baseline in `ECONOMIC_MODEL.md` (`base=10, daily=10, spread=15–25 bps`) yields **`-5.23` to `-30.18 bps` guaranteed LP loss per fill (`-4.8%` to `-27.5%` APR at `25%` utilization)** even at zero toxicity (`ESTIMATED (DERIVED)`).
2. **Observed Demand Is 92.2% Single-Flow Automated Activity:** Re-examining `market_data_14d.json` reveals that **`1,144` of `1,241` swaps (`92.2%` of count, `$31,566.05` / `71.7%` of volume)** come from a single contract-to-recipient pair (`0x56d15cf0... -> 0x11274593...` on `WHSK/USDT` and `WETH/USDT`). Excluding that flow, organic non-bot DEX volume across all three pools is **`$12,487.42` over 14 days (`$891.96/day`)** (`MEASURED (ON-CHAIN)`).
3. **"Suppressed Institutional Demand" vs. HashKey Exchange (CEX) & OTC:** Institutional users on HashKey Chain do not sit idle paying `268–2,422 bps` on HSKSwap V3; they route size through **HashKey Exchange (CEX) or off-chain OTC** (`5–10 bps` spread `ASSUMED`). Tranche loses on pure price-execution cost for any centralized-custody participant (`>= $5k`) and wins **only** where **on-chain atomic settlement, programmable custody, or composable ERC-721 reservation** is mandatory.
4. **Real LP Opportunity Cost Is `4.5%–10%+`, Not `0.19%–1.28%`:** Because [LiquidityVault.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/LiquidityVault.sol) pays **0% idle yield** (`ADR-001` `IYieldAdapter = address(0)`), LPs locking `USDT` forego `4.0%–5.0%` USD risk-free yield or `5%–10%` DeFi lending (`ASSUMED`); `WHSK` LPs forego `stHSK` staking; and delta-neutral market makers face `~5–10 bps` off-chain CEX rebalancing costs per fill (since rebalancing on HSKSwap V3 costs `149–2,422 bps`!) plus `5–15%` funding/basis drag (`ASSUMED`).
5. **Cross-Decimal `minTicketAmount` Bug Blocks Non-18-Decimal Pairs:** [CommitmentManager.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L93) stores a single global `minTicketAmount` (defaulted to `100e18` in `deploy.ts`/`engine.ts`) checked against raw `inventoryAmount` in `reserve()` and `splitTicket()`. That value equals `$8.08` on 18-decimal `WHSK`, **`$170,404` on 18-decimal `WETH`**, and **`$6.18e16` on 8-decimal `WBTC` / `$1e14` on 6-decimal `USDT`** (`ESTIMATED (DERIVED)`), blocking multi-pair deployment unless set near zero (which removes WHSK split-spam protection).

**Bottom Line:** At current HashKey Chain mainnet organic volume (`$892–$3,147/day`), a passive market-making vault cannot clear a `5%–8%` LP hurdle rate (implied utilization `< 1%–3%` on `$100k` TVL). Mainnet viability requires: (a) **lowering `protocolFeeBps` to `2–5 bps`** (or refactoring exercise fees onto `spread` rather than notional), (b) fixing `minTicketAmount` per token/offer, and (c) **securing committed bilateral institutional/treasury orderflow** (`>= $50k/day`) that specifically requires atomic on-chain settlement rather than CEX execution.

---

## 2. On-Chain Fee & Sizing Verification (`CommitmentManager.sol`)

Inspecting [CommitmentManager.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L246-L544) confirms two critical mechanics omitted from `ECONOMIC_MODEL.md`:

### 2.1 Double-Layer `protocolFeeBps` Mechanics (`MEASURED (ON-CHAIN)` code)

1. **At `reserve()` ([L269](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L269), [L484-L505](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L484-L505)):**
   - $\text{effPremiumBps} = \text{basePremiumBps} + \left\lceil \frac{\text{dailyPremiumBps} \times \text{duration}}{86{,}400} \right\rceil$
   - $\text{grossPremium} = \left\lceil \frac{\text{notionalPay} \times \text{effPremiumBps}}{10{,}000} \right\rceil$, where $\text{notionalPay} = \left\lceil \frac{\text{inventoryAmount} \times P_{\text{ref}}}{10^{36}} \right\rceil$
   - $\text{protocolFee}_{\text{res}} = \left\lfloor \frac{\text{grossPremium} \times \text{protocolFeeBps}}{10{,}000} \right\rfloor$
   - Taker pays `grossPremium`; LP receives `grossPremium - protocolFee_res`.
2. **At `exercise()` ([L325-L337](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L325-L337), [L507-L522](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L507-L522)):**
   - $\text{grossPayment} = \left\lceil \frac{\text{fillAmount} \times P_{\text{eff}}}{10^{36}} \right\rceil$, where $P_{\text{eff}} = \text{clamp}\!\left(\left\lceil P_{\text{oracle}} \cdot \frac{10{,}000 + \text{spreadBps}}{10{,}000} \right\rceil, P_{\min}, P_{\max}\right)$ in `FLOATING` mode.
   - $\text{protocolFee}_{\text{ex}} = \left\lfloor \frac{\text{grossPayment} \times \text{protocolFeeBps}}{10{,}000} \right\rfloor$
   - **Critical consequence:** `protocolFee_ex` is levied on **100% of `grossPayment` (full notional)** and subtracted directly from LP proceeds (`grossPay - fee` on [L337](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L337)).

Defining $f = \text{protocolFeeBps} / 10{,}000$, $p_{\text{ex}} \in [0, 1]$ as ticket exercise probability, and $M_{\text{tox}}$ (in bps) as adverse post-fill markout on exercised volume, exact expected LP net P&L per reserved notional dollar per cycle is (`ESTIMATED (DERIVED)`):

$$\text{LP Net}_{\text{bps}} = \text{effPremiumBps}(1 - f) + p_{\text{ex}}\Big[\text{spreadBps}(1 - f) - \text{protocolFeeBps} - M_{\text{tox}}\Big]$$

**Impact of Repo Default `protocolFeeBps = 50` ([deploy.ts:139](file:///c:/Users/USER/Desktop/Tranche/sdk/src/deploy.ts#L139), [engine.ts:362](file:///c:/Users/USER/Desktop/Tranche/demo/src/engine.ts#L362), [HashKeyForkPrototype.t.sol:56](file:///c:/Users/USER/Desktop/Tranche/contracts/test/HashKeyForkPrototype.t.sol#L56)):**

| Preset (`T = 24h`, `p_ex = 100%`) | `protocolFeeBps` | Trader Cost (ex-gas) | Protocol Revenue | LP Net (`M_tox = 0 bps`) | LP Net (`M_tox = 15 bps`) | LP APR @ `25%` Util (`M_tox = 15 bps`) |
| --- | --- | --- | --- | --- | --- | --- |
| `(10, 10, 15)` (`ECONOMIC_MODEL` min) | `50` (`MEASURED` default) | `35.0 bps` | `50.18 bps` | **`-15.18 bps`** | **`-30.18 bps`** | **`-27.53%`** |
| `(10, 10, 25)` (`ECONOMIC_MODEL` WETH/WBTC) | `50` (`MEASURED` default) | `45.0 bps` | `50.23 bps` | **`-5.23 bps`** | **`-20.23 bps`** | **`-18.46%`** |
| `(10, 10, 15)` (`ECONOMIC_MODEL` min) | `10` (hypothetical) | `35.0 bps` | `10.04 bps` | `+24.96 bps` | `+9.96 bps` | `+9.09%` |
| `(10, 10, 25)` (`ECONOMIC_MODEL` WETH/WBTC) | `5` (recommended fix) | `45.0 bps` | `5.02 bps` | **`+39.98 bps`** | **`+24.98 bps`** | **`+22.79%`** |
| `(15, 10, 65)` (Repriced for `pfee = 50`) | `50` (`MEASURED` default) | `90.0 bps` | `50.48 bps` | `+34.55 bps` | `+24.55 bps` | `+22.40%` |

*(All rows `ESTIMATED (DERIVED)` from `CommitmentManager.sol` equations; zero rebalancing cost assumed here — see Section 5 for hedging drag.)*

### 2.2 Global `minTicketAmount` Cross-Decimal Bottleneck (`MEASURED` + `ESTIMATED`)

In [CommitmentManager.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L93), `minTicketAmount` is a single raw `uint256` enforced in both `reserve()` ([L261](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L261)) and `splitTicket()` ([L380-L385](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L380-L385)). With the repo default `minTicketAmount = 100e18`:
- `WHSK` (18 dec, `$0.080808`): `100 WHSK = $8.08`.
- `WETH` (18 dec, `$1,704.04`): `100 WETH = $170,404` — locks out all `$1k–$100k` ETH offers.
- `WBTC` (8 dec, `$61,830.80`): `100e18` raw units = `10^12 WBTC` (`$6.18e16`) — **100% impossible to reserve or split**.
- `USDT` (6 dec, `$1.00`): `100e18` raw units = `10^14 USDT` — **100% impossible to offer USDT-side buy capacity**.

---

## 3. Real HSKSwap Market Activity & Demand Reality Check

### 3.1 Swap Concentration & Organic Demand Disaggregation (`MEASURED (ON-CHAIN)`)

Disaggregating the `1,241` swaps (`$44,053.47` over 14 days = `$3,146.68/day`) in [market_data_14d.json](file:///c:/Users/USER/Desktop/Tranche/scripts/market-analysis/market_data_14d.json) by `sender` and `recipient` exposes extreme flow concentration:

| Pool | Total 14d Swaps / Volume | Dominant Contract Flow (`0x56d15cf0... -> 0x11274593...`) | Remaining Router/Direct Flow (`SwapRouter02` / `UniversalRouter` / Other) | Inter-Block Swap Gaps (`min` / `p50` / `p90` / `max`) |
| --- | --- | --- | --- | --- |
| **WHSK/USDT** | `1,047` / `$20,689.88` (`$1,477.85/d`) | **`1,000` swaps (`95.5%`) / `$19,952.86` (`96.4%`)** (`309` buy / `691` sell) | **`47` swaps (`4.5%`) / `$737.02` (`$52.64/d`)** (`max` `$702.75` total via `UniversalRouter`) | `2s` / `12s` / `2,222s` (`37m`) / `22.04h` |
| **WETH/USDT** | `173` / `$13,650.69` (`$975.05/d`) | **`144` swaps (`83.2%`) / `$11,613.19` (`85.1%`)** (`41` buy / `103` sell) | **`29` swaps (`16.8%`) / `$2,037.50` (`$145.54/d`)** (`4` swaps `$2,016.25` via `UniversalRouter` to `0xa40a...`) | `2s` / `208s` (`3.5m`) / `16,900s` (`4.7h`) / `44.29h` |
| **WBTC/USDT** | `21` / `$9,712.90` (`$693.78/d`) | `0` (`0%`) | **`21` swaps / `$9,712.90` (`$693.78/d`)** (`17` via `UniversalRouter`, `13` to `0xa40a...` = `$7,604.04`) | `2s` / `27,970s` (`7.8h`) / `187,268s` (`52h`) / `119.34h` (`5.0d`) |
| **Combined** | **`1,241` / `$44,053.47`** (`$3,146.68/d`) | **`1,144` (`92.2%`) / `$31,566.05` (`71.7%`)** | **`97` (`7.8%`) / `$12,487.42` (`$891.96/d`)** | `WBTC` max gap = `5.0 days` |

**Key Empirical Findings (`MEASURED (ON-CHAIN)`):**
- **Single-bot / single-integrator dominance:** [INFRASTRUCTURE_AUDIT.md](file:///c:/Users/USER/Desktop/Tranche/research/INFRASTRUCTURE_AUDIT.md#L43) notes `0x56d15cf00b5d853d6ee4cbb1463e6dad2899fbf5` is associated with HyperIndex. That single sender-to-recipient loop (`-> 0x11274593...`) generated `96.4%` of WHSK/USDT volume and `85.1%` of WETH/USDT volume in fixed retail clips (`p50 = $15` WHSK, `$99.84` WETH).
- **True organic non-bot volume on WHSK and WETH is negligible:** Excluding `0x56d15cf0...`, WHSK/USDT saw only `$52.64/day` (`3.36 swaps/day`) and WETH/USDT saw `$145.54/day` (`2.07 swaps/day`).
- **WBTC/USDT activity is episodic:** Only `21` swaps in 14 days (`1.5/day`), with `5` zero-swap days and up to `119.3 hours` (`5.0 days`) between swaps; `78.3%` of volume went to a single recipient (`0xa40a...`).

### 3.2 Challenging the "Suppressed Institutional Demand" Hypothesis

`ECONOMIC_MODEL.md` argues that zero swaps `>= $5,000` implies *suppressed institutional demand* waiting for an on-chain block venue because HSKSwap V3 slippage is `149–2,422 bps`. That hypothesis fails a basic **outside-option test**:

- **HashKey Exchange (CEX) & Off-Chain OTC Exist as Direct Substitutes:** HashKey Chain is the L2 ecosystem of HashKey Group, whose primary liquidity hub is **HashKey Exchange (regulated CEX)** plus institutional OTC desks (`ASSUMED` `5–10 bps` institutional spread/fee, deep orderbooks, zero AMM curve slippage). Any HashKey-native whale, market maker, or treasury holding `USDT`, `WETH`, `WBTC`, or `HSK` who merely wants spot conversion can deposit to HashKey Exchange (or settle OTC) for `~5–25 bps` all-in rather than paying `35–90+ bps` on Tranche.
- **Why On-Chain Size Is Actually Absent:** The absence of `>= $5k` swaps reflects both (a) thin DEX depth pushing large traders to CEX/OTC, **and** (b) small active on-chain capital base (`~1.17M` bridged `USDT` total supply, `~33.33 WETH`, `~0.8094 WBTC` `MEASURED (ON-CHAIN)` in `INFRASTRUCTURE_AUDIT.md`). Note that `$1.01M` of that bridged supply is already sitting passively inside the three HSKSwap V3 pools (`$506.8k` USDT, `24.56 WETH`, `0.7338 WBTC`), leaving only `~$666k` USDT, `~8.77 WETH`, and `~0.0756 WBTC` circulating outside those pools on-chain!

| Dimension | HashKey Exchange (CEX) / OTC | Tranche Protocol | Winner & Structural Reason |
| --- | --- | --- | --- |
| **Pure spot cost (`>= $10k` size)** | `6–25 bps` (`ASSUMED` `5–10 bps` + bridge/withdrawal) | `45–90 bps` (`28 bps` for 6h if `pfee=5`) | **CEX/OTC wins** by `20–75 bps` on pure execution price. |
| **Atomic on-chain settlement / smart-contract composability** | Impossible (off-chain custody, withdrawal latency, KYC API) | **Native atomic `exercise()` / `ExecutionRouter.batchExercise()`** | **Tranche wins** — smart contracts, DAOs, and autonomous agents cannot hold CEX logins. |
| **Pre-funded capital efficiency (Taker)** | Must pre-deposit 100% notional to CEX before trading | **Taker posts only `15–40 bps` upfront premium**; retains `99.6%+` capital on-chain until `exercise()` | **Tranche wins** for conditional liquidity / standby credit lines. |
| **Transferable & splittable capacity (`ERC-721` + `splitTicket`)** | Non-transferable internal credit | **Permissionless ERC-721 ticket transfer & partial splitting** | **Tranche wins** for solver auctions, treasury sub-allocations, and secondary routing. |
| **Optional compliance gating (`HSPComplianceHook`)** | Mandatory centralized custody | **Self-custodial on-chain settlement with optional EIP-712 allowlist** | **Tranche wins** for regulated on-chain RWA/institutional rails (note 5 empty tokenized equity pools on HSKSwap). |

---

## 4. Trader Execution Cost Comparison (`$500` to `$50,000`)

### 4.1 Measured Gas Overhead (`MEASURED (FOUNDRY)` + `ESTIMATED (DERIVED)`)

Running `forge test --gas-report` on the frozen codebase yields exact median gas consumption (at `500.001 gwei` and `WHSK = $0.080808` `MEASURED (ON-CHAIN)` -> `$0.004040 / 100k gas`):

- **Taker execution path:** `reserve` (`407,215` gas) + `SignedPullOracle.updatePrice` (`77,777` gas) + `exercise` (`145,374` gas) = **`630,366` gas = `$0.02547`** (`MEASURED (FOUNDRY)` + `ESTIMATED`).
- **Full bilateral lifecycle (incl. LP `deposit` `76,564` + `createOffer` `203,797` + `claimProceeds` `60,824`):** **`971,551` gas = `$0.03925`**.
- **Taker upfront capital lockup:** Trader locks only `grossPremium` (e.g. `20 bps` = `$20` on `$10,000` for `24h`). At `5%–10%` annual cost of capital (`ASSUMED`), 24h lockup cost on the premium itself is `0.0003–0.0005 bps` of notional (negligible; the real cost is that `grossPremium` is **non-refundable** if unexercised).

### 4.2 All-In Trader Cost Matrix (bps vs. Spot / Oracle Midpoint)

Comparison assumes `24h` reservation (`base=10, daily=10, spread=25 -> 45 bps` under `protocolFeeBps=5`, or `base=15, daily=10, spread=65 -> 90 bps` repriced for LP viability under repo default `protocolFeeBps=50`), plus `6h` short execution (`base=5, daily=12 -> 3 bps, spread=20 -> 28 bps` under `protocolFeeBps=5`), vs. HSKSwap V3 AMM (`ESTIMATED` from `analysis_summary.json`) and CEX/OTC (`ASSUMED` `5–10 bps` + `$5–$15` withdrawal/bridge friction):

| Pair & Trade Size | HSKSwap V3 AMM (Buy / Sell) | Tranche `6h` (`pfee=5`) | Tranche `24h` (`pfee=5`) | Tranche `24h` (`pfee=50` Default, LP-Viable) | HashKey CEX / OTC (`ASSUMED`) |
| --- | --- | --- | --- | --- | --- |
| **WHSK/USDT — `$500`** | `42.0` / `41.8 bps` | `28.5 bps` | **`45.5 bps` (loses)** | **`90.5 bps` (loses)** | `105–310 bps` |
| **WHSK/USDT — `$1,000`** | `53.9` / `53.6 bps` | `28.3 bps` | `45.3 bps` | **`90.3 bps` (loses)** | `55–160 bps` |
| **WHSK/USDT — `$5,000`** | `149.3` / `147.1 bps` | `28.1 bps` | `45.1 bps` | `90.1 bps` | **`15–40 bps`** |
| **WHSK/USDT — `$10,000`** | `268.5` / `261.4 bps` | `28.0 bps` | `45.0 bps` | `90.0 bps` | **`10–25 bps`** |
| **WHSK/USDT — `$25,000`** | `626.0` / `589.1 bps` | `28.0 bps` | `45.0 bps` | `90.0 bps` | **`7–16 bps`** |
| **WHSK/USDT — `$50,000`** | `1,221.9` / `1,088.9 bps` | `28.0 bps` | `45.0 bps` | `90.0 bps` | **`6–13 bps`** |
| **WETH/USDT — `$500`** | `149.7` / `147.5 bps` | `28.5 bps` | `45.5 bps` | `90.5 bps` | `105–310 bps` |
| **WETH/USDT — `$1,000`** | `269.2` / `262.2 bps` | `28.3 bps` | `45.3 bps` | `90.3 bps` | `55–160 bps` |
| **WETH/USDT — `$5,000`** | `1,225.8` / `1,092.0 bps` | `28.1 bps` | `45.1 bps` | `90.1 bps` | **`15–40 bps`** |
| **WETH/USDT — `$10,000`** | `2,421.6` / `1,949.5 bps` | `28.0 bps` | `45.0 bps` | `90.0 bps` | **`10–25 bps`** |
| **WETH/USDT — `$25,000`** | `6,008.8` / `3,753.4 bps` | `28.0 bps` | `45.0 bps` | `90.0 bps` | **`7–16 bps`** |
| **WETH/USDT — `$50,000`** | `11,987.5` / `5,452.0 bps` | `28.0 bps` | `45.0 bps` | `90.0 bps` | **`6–13 bps`** |
| **WBTC/USDT — `$500`** | `140.4` / `138.4 bps` | `28.5 bps` | `45.5 bps` | `90.5 bps` | `105–310 bps` |
| **WBTC/USDT — `$1,000`** | `250.7` / `244.5 bps` | `28.3 bps` | `45.3 bps` | `90.3 bps` | `55–160 bps` |
| **WBTC/USDT — `$5,000`** | `1,132.9` / `1,017.6 bps` | `28.1 bps` | `45.1 bps` | `90.1 bps` | **`15–40 bps`** |
| **WBTC/USDT — `$10,000`** | `2,235.7` / `1,827.2 bps` | `28.0 bps` | `45.0 bps` | `90.0 bps` | **`10–25 bps`** |
| **WBTC/USDT — `$25,000`** | `5,544.1` / `3,566.7 bps` | `28.0 bps` | `45.0 bps` | `90.0 bps` | **`7–16 bps`** |
| **WBTC/USDT — `$50,000`** | `11,058.1` / `5,251.2 bps` | `28.0 bps` | `45.0 bps` | `90.0 bps` | **`6–13 bps`** |

**Key Observations:**
1. **Against HSKSwap V3:** Tranche crushes the AMM at `>= $5,000` on `WHSK` (saving `59–1,194 bps`) and `>= $500` on `WETH`/`WBTC` (saving `50–11,960 bps`). However, under the codebase default `protocolFeeBps = 50`, LP-viable Tranche (`90.3 bps`) is **more expensive than HSKSwap V3** on `WHSK/USDT` up to `$2,513`.
2. **Against CEX/OTC:** Above `$5,000`, CEX/OTC is strictly cheaper (`6–40 bps`) unless the trader values on-chain atomicity, zero custodial counterparty risk, or `ExecutionTicket` composability enough to pay a `15–75 bps` convenience premium.

---

## 5. LP Capital Opportunity Cost (Challenging the `0.19%–1.28%` Benchmark)

`ECONOMIC_MODEL.md` framed LP opportunity cost around `0.19%–1.28%` passive HSKSwap V3 APR (`KC-5 <= 10%`). That benchmark is **economically invalid** for attracting external liquidity because rational capital is **not trapped in HSKSwap V3**—if it were, those `21` V3 NFTs wouldn't have had `0` Mints/Burns in 14 days (`MEASURED (ON-CHAIN)`).

In [LiquidityVault.sol](file:///c:/Users/USER/Desktop/Tranche/contracts/src/LiquidityVault.sol), all idle (`lpFreeBalance`, `offerBalance`) and reserved (`ticketReserved`) collateral earns **`0.00%` base yield** (`ADR-001` disables `IYieldAdapter` in MVP). Real LP opportunity costs are (`ASSUMED` unless tagged):

| Asset Locked | Real Benchmark Opportunity Cost (`ASSUMED`) | Annualized Hurdle | Critical Friction Specific to HashKey Chain |
| --- | --- | --- | --- |
| **`USDT`** | USD T-bill / tokenized RWA (`4.0%–5.0%`); DeFi stablecoin lending (`5.0%–10.0%`) | **`5.0%–10.0%`** | Passive `USDT` holders can earn `4%–8%` delta-neutral yield off-chain/L1 without taking `WETH`/`WBTC`/`WHSK` spot depreciation risk on fills. |
| **`WHSK`** | Native `stHSK` liquid staking (`0xD2fd...b76`, `1.456M` supply `MEASURED`) | **`4.0%–12.0%`** | `stHSK` earns passive staking yield with no short-option risk; locking `WHSK` in Tranche forfeits staking yield and caps upside in `FIXED` mode. |
| **`WETH` / `WBTC`** | ETH staking/restaking (`2.5%–4.0%`); BTC lending (`0.5%–3.0%`) + CEX yield | **`3.0%–6.0%`** | Unhedged `WETH` dropped **`-18.93%`** and `WBTC` dropped **`-16.54%`** in the 14d window (`MEASURED`) — far exceeding `~1%` APR fee differences. |
| **Delta-Neutral MM** | Capital cost (`5.0%–8.0%`) + perp funding/basis (`5.0%–15.0%` on hedged leg) + CEX rebalance (`5–10 bps`/fill) | **`10.0%–23.0%+` + per-fill cost** | **LPs CANNOT rebalance on HSKSwap V3** (`$10k` costs `269–2,422 bps`!). Rebalancing off-chain at `7.5 bps`/fill (`ASSUMED`) adds **`4.56%` APR drag at `25%` utilization** (`2.74%` at `15%`, `9.13%` at `50%`). |

**Structural Implication:** Passive `WHSK` or `USDT` whales already sitting on HashKey Chain need **`>= 5.0%–8.0%` net incremental APR** to justify locking capital into `LiquidityVault` and absorbing asymmetric fill risk; professional delta-neutral market makers need **rebalancing costs (`~5–10 bps`/fill) + hedging carry (`5%–15%`) + capital hurdle (`5%–8%`)** covered on top of markout!

---

## 6. Adverse Selection, Markout Toxicity & Directional Skew Modeling

### 6.1 Why `ECONOMIC_MODEL.md`'s `KC-6` (`0.0000–0.0573 bps`) Understates Toxicity

`ECONOMIC_MODEL.md` modeled `FLOATING` toxicity purely as symmetric Gaussian drift over `30s` pull-oracle latency. That misses three first-order adverse selection channels:

1. **Non-Exercise / Walk-Away Optionality (`p_ex < 100%`):** A `24h` `FLOATING` ticket is **not** a spot swap; it is a `24h` **American execution option** on guaranteed depth at `P_oracle * (1 + spread)`. Traders pay `effPremiumBps` upfront and only exercise (`p_ex`) when they either (a) still want liquidity, or (b) spot/CEX moves favorably relative to the oracle update/deviation cadence.
2. **Adverse Post-Fill Markout (`M_tox`):** Even with `<= 30s` `SignedPullOracle` (`maxDeviationBps` + off-chain update trigger), informed aggregators and arbitrageurs only lift stale/lagging quotes. Realistic conditional markout ranges from `5 bps` (benign treasury/block flow) to `15–30+ bps` (mixed/toxic aggregator flow) (`ASSUMED`).
3. **One-Sided Directional Skew (`67.1%–74.1%` Sell-Base `MEASURED`):** Across all three pools in the 14d window, volume was overwhelmingly sell-base (`67.90%` WHSK, `67.12%` WETH, `74.14%` WBTC), accompanied by **`-3.45%` (WHSK), `-18.93%` (WETH), and `-16.54%` (WBTC)** spot drawdowns (`MEASURED`). Unhedged `USDT`-side LPs buying base at `P_oracle * (1 - spread)` absorb negative drift post-fill, while `WHSK`/`WETH`/`WBTC`-side LPs face non-exercise during selloffs.

### 6.2 Stressed Volatility (`80%` & `120%` Annualized) Sensitivity (`ESTIMATED (DERIVED)`)

Extending `model_evaluation.json` from `80%` to `120%` annualized volatility shows how quickly latency and `FIXED` option value escalate during crypto selloffs:

| Volatility Regime | `FLOATING` Latency `30s` (`@10 / @15 / @25 / @35 bps`) | `FLOATING` Latency `60s` (`@10 / @15 / @25 / @35 bps`) | `FLOATING` Latency `300s` (`@10 / @15 / @25 / @35 bps`) | `FIXED` ATM BS Fair Value (`1h / 6h / 24h / 72h / 7d`) |
| --- | --- | --- | --- | --- |
| **`80%` Annualized (`ASSUMED`)** | `0.37 / 0.08 / 0.00 / 0.00 bps` | `1.10 / 0.44 / 0.04 / 0.00 bps` | `5.64 / 4.11 / 2.00 / 0.87 bps` | `34.1 / 83.5 / 167.0 / 289.3 / 441.8 bps` |
| **`120%` Annualized (`ASSUMED`)** | `1.28 / 0.55 / 0.07 / 0.00 bps` | `2.77 / 1.64 / 0.47 / 0.10 bps` | `10.30 / 8.46 / 5.51 / 3.42 bps` | `51.2 / 125.3 / 250.5 / 433.8 / 662.2 bps` |

*(If `SignedPullOracle` ever misses a `30s` update or lags to `60s–300s` during a `120%` vol spike, `15 bps` spread suffers `1.64–8.46 bps` pure latency arb on top of normal markout.)*

### 6.3 Unfavorable LP P&L Scenarios (`T = 24h`, `25%` Utilization, Ex-Rebalancing)

Below are expected LP net returns per locked cycle (`bps`) and annualized LP APR (`%` at `u = 25%` and `u = 10%`) across the correlated adverse-selection spectrum (`ESTIMATED (DERIVED)` from `CommitmentManager.sol`):

| Flow Regime (`ASSUMED`) | Pricing Preset (`base, daily, spread`) | `protocolFeeBps` | LP Net / Cycle (`bps`) | LP APR @ `10%` Util | LP APR @ `25%` Util | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **Benign Block (`p_ex=90%, M_tox=5`)** | `(10, 10, 25)` (`45 bps` trader) | **`50` (Default)** | **`-7.21 bps`** | **`-2.63%`** | **`-6.58%`** | **Unviable (LP bleeds)** |
| **Benign Block (`p_ex=90%, M_tox=5`)** | `(10, 10, 25)` (`45 bps` trader) | `5` (Fixed) | `+33.48 bps` | `+12.22%` | `+30.55%` | Viable |
| **Mixed Flow (`p_ex=60%, M_tox=15`)** | `(10, 10, 25)` (`45 bps` trader) | **`50` (Default)** | **`-4.18 bps`** | **`-1.52%`** | **`-3.81%`** | **Unviable (LP bleeds)** |
| **Mixed Flow (`p_ex=60%, M_tox=15`)** | `(10, 10, 25)` (`45 bps` trader) | `5` (Fixed) | `+22.98 bps` | `+8.39%` | `+20.97%` | Viable (before MM hedge) |
| **Toxic Selective (`p_ex=30%, M_tox=30`)** | `(10, 10, 25)` (`45 bps` trader) | **`50` (Default)** | `+3.36 bps` | `+1.23%` | `+3.07%` | Fails `5%–8%` hurdle |
| **Toxic Selective (`p_ex=30%, M_tox=30`)** | `(10, 10, 25)` (`45 bps` trader) | `5` (Fixed) | `+16.99 bps` | `+6.20%` | `+15.50%` | Reservation fee shields LP |
| **Extreme Toxic (`p_ex=20%, M_tox=50`)** | `(10, 10, 25)` (`45 bps` trader) | `5` (Fixed) | `+13.99 bps` | `+5.11%` | `+12.76%` | Only reservation fee saves LP |
| **Toxic Selective (`p_ex=30%, M_tox=30`)** | `(15, 10, 65)` (`90 bps` trader) | **`50` (Default)** | `+20.28 bps` | `+7.40%` | `+18.50%` | Viable for LP, pricey for trader |

**Crucial Mechanism Insight:** In `FLOATING` mode, **higher `basePremiumBps + dailyPremiumBps` (non-refundable reservation fee) protects the LP against low-`p_ex` toxic selection**, whereas **`spreadBps` only protects on exercised volume** and gets **taxed heavily by `protocolFeeBps`** (at `50 bps`, `spreadBps <= 50` yields negative LP margin on every fill!).

---

## 7. Inventory Lockup & Utilization Sensitivity (`5%` to `50%`)

### 7.1 Net LP APR Across Utilization Rates (`T = 24h`, `p_ex = 100%` & `50%`, Ex-Rebalancing)

| Pricing Preset (`Trader Cost`) | `pfee` | `M_tox` | `p_ex` | Net/Cycle (`bps`) | APR @ `u=5%` | APR @ `u=10%` | APR @ `u=25%` | APR @ `u=50%` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **`(10, 10, 25)` (`45 bps`)** | `50` | `15` | `100%` | `-20.23` | `-3.69%` | `-7.38%` | `-18.46%` | `-36.91%` |
| **`(10, 10, 25)` (`45 bps`)** | `5` | `5` | `100%` | `+34.98` | `+6.38%` | `+12.77%` | `+31.92%` | `+63.83%` |
| **`(10, 10, 25)` (`45 bps`)** | `5` | `15` | `100%` | `+24.98` | `+4.56%` | `+9.12%` | `+22.79%` | `+45.58%` |
| **`(10, 10, 25)` (`45 bps`)** | `5` | `30` | `100%` | `+9.98` | `+1.82%` | `+3.64%` | `+9.10%` | `+18.21%` |
| **`(10, 10, 25)` (`45 bps`)** | `5` | `30` | `50%` | `+14.98` | `+2.73%` | `+5.47%` | `+13.67%` | `+27.35%` |
| **`(15, 15, 25)` (`55 bps`)** | `5` | `15` | `100%` | `+34.97` | `+6.38%` | `+12.76%` | `+31.91%` | `+63.82%` |
| **`(15, 10, 65)` (`90 bps`)** | `50` | `15` | `100%` | `+24.55` | `+4.48%` | `+8.96%` | `+22.40%` | `+44.80%` |
| **`(15, 10, 65)` (`90 bps`)** | `50` | `30` | `100%` | `+9.55` | `+1.74%` | `+3.49%` | `+8.71%` | `+17.43%` |
| **`(20, 20, 75)` (`115 bps`)** | `50` | `15` | `100%` | `+49.42` | `+9.02%` | `+18.04%` | `+45.10%` | `+90.20%` |
| **`(20, 20, 75)` (`115 bps`)** | `50` | `30` | `100%` | `+34.42` | `+6.28%` | `+12.57%` | `+31.41%` | `+62.83%` |

### 7.2 Exact Parameter Floors to Clear `5.0%` and `8.0%` LP Hurdle Rates (`T = 24h`)

Table shows the **minimum required total trader fee** (`effPrem + spread` at `p_ex = 100%`) and **illustrative `(base, daily, spread)` split** required to hit `5.0%` or `8.0%` net LP APR (`ESTIMATED (DERIVED)`):

| Utilization `u` | Req. Net Cycle (`5%` / `8%` Hurdle) | `pfee = 5`, `M_tox = 15 bps` (Natural LP, `0` rebal) | `pfee = 5`, `M_tox = 15 bps` + `7.5 bps` CEX Rebal (MM) | `pfee = 50`, `M_tox = 15 bps` (Natural LP, `0` rebal) | `pfee = 50`, `M_tox = 15 bps` + `7.5 bps` CEX Rebal (MM) |
| --- | --- | --- | --- | --- | --- |
| **`u = 5%`** | `27.40` / `43.84 bps` | **`42.4` / `58.9 bps`** e.g. `(15, 10, 20)` / `(15, 15, 30)` | **`49.9` / `66.4 bps`** e.g. `(15, 10, 25)` / `(15, 15, 37)` | **`87.8` / `104.4 bps`** e.g. `(15, 10, 65)` / `(15, 15, 75)` | **`95.4` / `111.9 bps`** e.g. `(15, 10, 72)` / `(20, 15, 78)` |
| **`u = 10%`** | `13.70` / `21.92 bps` | **`28.7` / `36.9 bps`** e.g. `(10, 10, 10)` / `(10, 10, 18)` | **`36.2` / `44.4 bps`** e.g. `(10, 10, 17)` / `(10, 10, 25)` | **`74.1` / `82.3 bps`** e.g. `(15, 10, 50)` / `(15, 10, 58)` | **`81.6` / `89.9 bps`** e.g. `(15, 10, 57)` / `(15, 10, 65)` |
| **`u = 25%`** | `5.48` / `8.77 bps` | **`20.5` / `23.8 bps`** e.g. `(10, 5, 10)` / `(10, 5, 10)` | **`28.0` / `31.3 bps`** e.g. `(10, 5, 15)` / `(10, 10, 15)` | **`65.8` / `69.1 bps`** e.g. `(10, 10, 46)` / `(10, 10, 50)` | **`73.4` / `76.7 bps`** e.g. `(10, 10, 55)` / `(15, 10, 52)` |
| **`u = 50%`** | `2.74` / `4.38 bps` | **`17.7` / `19.4 bps`** e.g. `(5, 5, 10)` / `(10, 5, 10)` | **`25.3` / `26.9 bps`** e.g. `(10, 5, 12)` / `(10, 5, 15)` | **`63.1` / `64.7 bps`** e.g. `(10, 10, 44)` / `(10, 10, 46)` | **`70.6` / `72.3 bps`** e.g. `(10, 10, 51)` / `(10, 10, 53)` |

*(Note: Under `M_tox = 30 bps`, add `+15.0 bps` to every `pfee = 5` row and `+15.1 bps` to every `pfee = 50` row above.)*

### 7.3 The Volume-to-Utilization Reality Check (`MEASURED` + `ESTIMATED`)

Even a modest **`$250,000` Tranche LP TVL** requires:
- At `u = 10%` (`T = 24h`): **`$25,000/day`** of reserved notional — **7.9x** total current HSKSwap V3 volume (`$3,146.68/day`) and **28.0x** non-bot organic DEX volume (`$891.96/day`)!
- At `u = 25%` (`T = 24h`): **`$62,500/day`** — **19.9x** total HSKSwap V3 volume and **70.1x** non-bot organic DEX volume!

If Tranche captures **100% of all non-bot HashKey Chain DEX volume (`$892/day`)** on `$250,000` LP TVL, utilization is **`u = 0.36%`**, yielding **`0.33%` APR** even at `+25 bps` net per trade!

---

## 8. Minimum Economically Viable Order Sizes & Honest Bilateral Verdict

### 8.1 Minimum Economically Viable Order Size (MEVOS) by Pair (`ESTIMATED (DERIVED)`)

Solving exact Uniswap V3 multi-tick slippage curves from `market_data_14d.json` (`BUY_BASE` side) yields two distinct thresholds:
1. **AMM Breakeven Notional:** Trade size where HSKSwap V3 all-in cost equals Tranche all-in cost (`45 bps + gas` if `pfee=5`, or `90 bps + gas` if `pfee=50`).
2. **Compelling Viable Order Size (`>= +50 bps` net savings over AMM):** Minimum size where switching from HSKSwap V3 to Tranche saves enough (`>= 50 bps`, i.e., `>= $5–$25+` absolute dollar savings) to justify two transactions, pull-oracle updates, and ticket management overhead:

| Pair | Gas Breakeven (`<1 bps` drag) | AMM Breakeven (`45 bps`, `pfee=5`) | AMM Breakeven (`90 bps`, `pfee=50`) | **`>= 50 bps` Net Savings (`pfee=5`, `95 bps` AMM)** | **`>= 50 bps` Net Savings (`pfee=50`, `140 bps` AMM)** | **`>= 100 bps` Net Savings (`pfee=5` / `pfee=50`)** |
| --- | --- | --- | --- | --- | --- | --- |
| **WHSK/USDT** | `~$255` (`1.0 bps`) | `$625.50` | `$2,513.37` | **`$2,723`** | **`$4,611`** | **`$4,821` / `$6,709`** |
| **WETH/USDT** | `~$255` (`1.0 bps`) | `$62.34` | `$250.51` | **`$271`** (`~$500` practical) | **`$460`** (`~$500–$1,000` practical) | **`$480` / `$669`** (`~$1,000` practical) |
| **WBTC/USDT** | `~$255` (`1.0 bps`) | `$67.60` | `$271.62` | **`$294`** (`~$500` practical) | **`$498`** (`~$500–$1,000` practical) | **`$521` / `$725`** (`~$1,000` practical) |

**Revalidated Minimum Order Floor:**
- **`WHSK/USDT`:** **`$3,000–$5,000`** (`~37,000–62,000 WHSK`) minimum viable ticket size (`$5,000+` if `protocolFeeBps = 50`). Below `$2,500`, HSKSwap V3 is cheaper or indistinguishable.
- **`WETH/USDT` & `WBTC/USDT`:** **`$500–$1,000`** minimum viable ticket size (`~0.3–0.6 WETH`, `~0.008–0.016 WBTC`).

---

### 8.2 Honest Bilateral Verdict

#### Do LPs Have a Compelling Reason to Supply Capital Today?
**NO — not under current mainnet volume and default `protocolFeeBps = 50`.**
1. **Default parameters lose money:** At `protocolFeeBps = 50`, `CommitmentManager.sol` taxes `50 bps` of notional on every `exercise()`, turning `ECONOMIC_MODEL.md`'s recommended `(10, 10, 15–25)` pricing into `-5` to `-30 bps` guaranteed losses per fill.
2. **Insufficient utilization:** Even after cutting `protocolFeeBps` to `2–5 bps`, current organic HashKey Chain DEX volume (`$892/day` ex-HyperIndex, `$3,147/day` total) produces `< 1%–3%` utilization on `$100k–$250k` TVL — yielding `~0.3%–1.5%` APR, far below `4.5%–10%` USD/stablecoin/staking hurdle rates (`ASSUMED`).
3. **Who CAN profitably LP even in early HashKey Chain:** Only **ecosystem treasuries, project foundations, or RWA issuers** who *already hold* single-sided `WHSK` or `USDT` inventory, want structured disposition/accumulation (`+2%` OTM covered calls / cash-secured puts or `FLOATING` disposition), and do **not** need to rebalance on HSKSwap V3.

#### Do Traders Have a Compelling Reason to Pay Today?
**ONLY FOR SPECIFIC ON-CHAIN CONSTRAINTS — NOT FOR GENERAL SPOT SWAPS.**
1. **Against HSKSwap V3:** Yes, overwhelmingly, for **any on-chain trade `>= $3,000–$5,000` on WHSK or `>= $500–$1,000` on WETH/WBTC** (`50–11,900+ bps` cheaper than V3!).
2. **Against HashKey Exchange (CEX) / OTC:** No, for ordinary traders willing to use centralized custody above `$5,000` (`CEX/OTC` at `6–40 bps` beats Tranche `45–90 bps`). Tranche wins **exclusively** for **smart-contract / DAO treasuries, autonomous execution agents, RWA settlement pipelines, and conditional standby liquidity buyers** who require atomic on-chain settlement, non-custodial custody, or transferable `ERC-721` commitments.

### 8.3 Mandatory Catalysts & Pre-Mainnet Fixes Required for Viability

1. **Reduce `protocolFeeBps` from `50` to `2–5 bps` (`0.02%–0.05%`) at deployment** (or in a v2 contract, apply `protocolFeeBps` solely to `grossPremium + spread`, never to full `grossPayment` notional).
2. **Fix global `minTicketAmount` cross-decimal coupling** (set global `minTicketAmount` safely low for `6`/`8`-decimal tokens or migrate to per-offer `o.minFillAmount` enforcement inside `splitTicket()` in a pre-mainnet patch).
3. **Bootstrap bilateral institutional/treasury supply & demand off-chain before launch:** Target **`>= $50,000/day`** committed flow (`10x`–`50x` current organic DEX volume) from ecosystem market makers, treasury dispositions, or RWA primary/secondary settlement (e.g., activating the 5 dormant tokenized-equity pools observed on HSKSwap Factory) — because passive interception of existing HSKSwap retail flow is mathematically dead on arrival.
