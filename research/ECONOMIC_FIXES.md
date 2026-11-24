# Tranche — Phase 2 Economic Remediation Specification (Workstream C)

> **Frozen Baseline Preserved:** `main` @ `f5d61e76134fd3badc831d10136318431aabd413`  
> **Scope:** Design-before-coding specification for economic & multi-decimal fixes in [`CommitmentManager.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol) and [`IProtocol.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/interfaces/IProtocol.sol) (companion to [`REMEDIATION_SPEC.md`](file:///c:/Users/USER/Desktop/Tranche/research/REMEDIATION_SPEC.md) and [`ECONOMIC_REVALIDATION.md`](file:///c:/Users/USER/Desktop/Tranche/research/ECONOMIC_REVALIDATION.md)).  
> **Provenance Tags:** Every quantitative claim uses the strict provenance definitions from [`ECONOMIC_REVALIDATION.md`](file:///c:/Users/USER/Desktop/Tranche/research/ECONOMIC_REVALIDATION.md#L11-L17): `MEASURED (ON-CHAIN)` (live HashKey Chain snapshot block `30583147` or frozen repo parameters), `MEASURED (FOUNDRY)` (local Foundry test measurements), `ESTIMATED (DERIVED)` (exact deterministic derivations from contract equations or measured on-chain/Foundry inputs), and `ASSUMED` (external benchmarks/stress inputs).

---

## 1. Exact Formula Reconstruction & Fee Attribution

### 1.1 Verbatim Reconstruction of `_quoteReservation` and `_quoteExercise`

In the frozen baseline [`CommitmentManager.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L23-L27), the protocol defines (`MEASURED (ON-CHAIN)`):

- `PRICE_SCALE = 1e36`
- `BPS_DENOMINATOR = 10_000`
- `MAX_PROTOCOL_FEE_BPS = 500` (`5.00%`)
- `MIN_OFFER_DURATION = 60` (`1 minute`)
- `MAX_OFFER_DURATION = 30 days`

#### A. Reservation Quoting (`_quoteReservation`, [`CommitmentManager.sol#L484-L505`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L484-L505))

```solidity
uint256 effPremiumBps =
    uint256(o.basePremiumBps) + Math.ceilDiv(uint256(o.dailyPremiumBps) * uint256(duration), 86_400);
if (effPremiumBps == 0) return (0, 0);

uint256 refPriceX36;
if (o.priceMode == PriceMode.FIXED) {
    refPriceX36 = o.fixedPriceX36;
} else {
    refPriceX36 = _resolveFloatingPrice(
        o.oracle, o.inventoryToken, o.paymentToken, o.spreadBps, o.minPriceX36, o.maxPriceX36
    );
}

uint256 notionalPay = Math.mulDiv(inventoryAmount, refPriceX36, PRICE_SCALE, Math.Rounding.Ceil);
grossPremium = Math.mulDiv(notionalPay, effPremiumBps, BPS_DENOMINATOR, Math.Rounding.Ceil);
protocolFee = Math.mulDiv(grossPremium, protocolFeeBps, BPS_DENOMINATOR, Math.Rounding.Floor);
```

Where `_resolveFloatingPrice` ([`CommitmentManager.sol#L524-L544`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L524-L544)) resolves:

```solidity
uint256 factor = uint256(int256(BPS_DENOMINATOR) + int256(spreadBps));
effPriceX36 = Math.mulDiv(q.priceX36, factor, BPS_DENOMINATOR, Math.Rounding.Ceil);
if (minPriceX36 > 0 && effPriceX36 < minPriceX36) effPriceX36 = minPriceX36;
if (maxPriceX36 > 0 && effPriceX36 > maxPriceX36) effPriceX36 = maxPriceX36;
```

Expressed algebraically:

$$\text{effPremiumBps} = \text{basePremiumBps} + \left\lceil \frac{\text{dailyPremiumBps} \times \text{duration}}{86{,}400} \right\rceil$$

$$\text{notionalPay} = \left\lceil \frac{\text{inventoryAmount} \times \text{priceX36}}{10^{36}} \right\rceil$$

$$\text{grossPremium} = \left\lceil \frac{\text{notionalPay} \times \text{effPremiumBps}}{10{,}000} \right\rceil$$

$$\text{protocolFee}_{\text{res}} = \left\lfloor \frac{\text{grossPremium} \times \text{protocolFeeBps}}{10{,}000} \right\rfloor, \qquad \text{lpNet}_{\text{res}} = \text{grossPremium} - \text{protocolFee}_{\text{res}}$$

#### B. Exercise Quoting (`_quoteExercise`, [`CommitmentManager.sol#L507-L522`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L507-L522))

```solidity
if (t.priceMode == PriceMode.FIXED) {
    effPriceX36 = t.fixedOrMinPriceX36;
} else {
    effPriceX36 = _resolveFloatingPrice(
        t.oracle, t.inventoryToken, t.paymentToken, t.spreadBps, t.fixedOrMinPriceX36, t.maxPriceX36
    );
}

grossPayment = Math.mulDiv(fillAmount, effPriceX36, PRICE_SCALE, Math.Rounding.Ceil);
protocolFee = Math.mulDiv(grossPayment, protocolFeeBps, BPS_DENOMINATOR, Math.Rounding.Floor);
```

Expressed algebraically:

$$\text{grossPayment} = \left\lceil \frac{\text{fillAmount} \times \text{effPriceX36}}{10^{36}} \right\rceil$$

$$\text{protocolFee}_{\text{ex}} = \left\lfloor \frac{\text{grossPayment} \times \text{protocolFeeBps}}{10{,}000} \right\rfloor, \qquad \text{lpNet}_{\text{ex}} = \text{grossPayment} - \text{protocolFee}_{\text{ex}}$$

### 1.2 Explicit Cash-Flow & Fee Attribution

Both [`reserve()`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L295-L297) and [`exercise()`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L337-L364) settle through [`LiquidityVault._creditPayment`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/LiquidityVault.sol#L317-L335), which pulls `total = lpNetProceeds + protocolFee` from `payer`:

| Lifecycle Step | Taker Pays (`_pullExact`) | LP Receives (`lpPendingProceeds`) | Protocol Receives (`protocolFees`) | Exact Accounting Identity |
| --- | --- | --- | --- | --- |
| **`reserve()`** | `grossPremium` (in `paymentToken`) | `lpNet_res = grossPremium - protocolFee_res` | `protocolFee_res` | `lpNet_res + protocolFee_res == grossPremium` |
| **`exercise()`** | `grossPayment` (in `paymentToken`) | `lpNet_ex = grossPayment - protocolFee_ex` | `protocolFee_ex` | `lpNet_ex + protocolFee_ex == grossPayment` |

**Key Structural Consequence:** Takers do **not** pay `protocolFee` on top of `grossPremium` or `grossPayment`. Takers pay strictly `grossPremium` + `grossPayment`, while **the protocol deducts `protocolFee` directly out of LP gross receipts (`lpNet = gross - protocolFee`)**. Because `grossPayment` is `100%` of the exercised principal notional (spot + spread), `protocolFee_ex` acts as a **gross notional turnover tax on the LP's principal**, not a fee on the LP's spread.

---

## 2. Correcting the Protocol Fee Base & Default Rate

### 2.1 Why `protocolFeeBps = 50` Breaks LP Unit Economics (`Econ-1`)

Across the frozen deployment and demo codebase ([`deploy.ts#L139`](file:///c:/Users/USER/Desktop/Tranche/sdk/src/deploy.ts#L139), [`engine.ts#L362`](file:///c:/Users/USER/Desktop/Tranche/demo/src/engine.ts#L362), [`HashKeyForkPrototype.t.sol#L56`](file:///c:/Users/USER/Desktop/Tranche/contracts/test/HashKeyForkPrototype.t.sol#L56)), `protocolFeeBps` defaults to **`50 bps` (`0.50%`)** (`MEASURED (ON-CHAIN)`).

Let $f = \text{protocolFeeBps} / 10{,}000$, $p_{\text{ex}} \in [0, 1]$ be exercise probability, $M_{\text{tox}}$ (bps) be adverse post-fill markout, and $C_{\text{rebal}}$ (bps) be per-fill rebalancing drag. Per unit of oracle notional reserved over a cycle of duration $T$, the LP's expected net P&L in bps (`ESTIMATED (DERIVED)`) is:

$$\text{LP Net}_{\text{bps}} = \text{effPremiumBps}(1 - f) + p_{\text{ex}}\Big[\text{spreadBps}(1 - f) - \text{protocolFeeBps} - M_{\text{tox}} - C_{\text{rebal}}\Big]$$

Notice the $-\text{protocolFeeBps}$ term inside the bracket: on every exercised dollar, the protocol takes `50 bps` of the **entire principal notional** (`grossPayment`), which dwarfs the `15–25 bps` `spreadBps` (`ESTIMATED (DERIVED)`):

- **Baseline `(base=10, daily=10, spread=15)` (`T=24h`, `p_ex=100%`, `protocolFeeBps=50`, `C_rebal=0`):**
  - Taker pays `20 bps` (`effPremiumBps`) + `15 bps` (`spreadBps`) = `35.00 bps` above spot.
  - Protocol collects `20 * 0.0050 + 1.0015 * 50 = 0.10 + 50.075 = 50.175 bps` (`50.18 bps`).
  - At `M_tox = 0 bps`: $\text{LP Net} = 20(0.995) + 15(0.995) - 50 = -15.175\text{ bps}$ (`-15.18 bps/fill`, `-13.85%` APR at `25%` utilization).
  - At `M_tox = 15 bps` (`ASSUMED` mixed flow): $\text{LP Net} = -30.175\text{ bps}$ (`-30.18 bps/fill`, `-27.53%` APR at `25%` utilization).
- **WETH/WBTC Preset `(base=10, daily=10, spread=25)` (`T=24h`, `p_ex=100%`, `protocolFeeBps=50`, `C_rebal=0`):**
  - Taker pays `20 + 25 = 45.00 bps` above spot; Protocol collects `0.10 + 50.125 = 50.225 bps` (`50.23 bps`).
  - At `M_tox = 0 bps`: $\text{LP Net} = 20(0.995) + 25(0.995) - 50 = -5.225\text{ bps}$ (`-5.23 bps/fill`, `-4.77%` APR at `25%` utilization).
  - At `M_tox = 15 bps`: $\text{LP Net} = -20.225\text{ bps}$ (`-20.23 bps/fill`, `-18.46%` APR at `25%` utilization).

Even with **zero toxicity and zero hedging cost**, an LP selling at `15–25 bps` over oracle spot under `protocolFeeBps = 50` receives **`99.50%` of `1.0015x–1.0025x` spot = `0.99649x–0.99749x` spot**, locking in a guaranteed principal loss (`lpNet_res + lpNet_ex < oracleNotional`) whenever `effPremiumBps + spreadBps < 50.25 bps`.

### 2.2 Remediation Options Comparison (Option A vs. Option B)

| Dimension | **Option A: Minimal Parameter + Cap + Snapshot + Ceil Fix (Recommended for Phase 2)** | **Option B: v2 Spread-Only Fee Accounting** |
| --- | --- | --- |
| **Fee Base** | Unchanged: `grossPremium` at `reserve()`, `grossPayment` at `exercise()`. | `grossPremium` at `reserve()`, and **only realized spread above oracle ref** (`max(0, grossPayment - oracleRefPayment)`) at `exercise()`. |
| **Default Rate & Cap** | `protocolFeeBps = 5` (`0.05%`, recommended operating band **`2–5 bps`**); hard cap lowered from `500` to **`MAX_PROTOCOL_FEE_BPS = 100` (`1.00%`)**. | Typically `500–1,000 bps` (`5%–10%`) of fee+spread revenue (`~2.25–4.50 bps` effective notional at `45 bps` total fee). |
| **Immutability (`M-03`)** | Snapshot `protocolFeeBps` onto `Offer` at `createOffer()` and onto `Ticket` at `reserve()`. Admin updates affect **only future offers**. | Same snapshot required on `Offer` / `Ticket`. |
| **Dust Rounding (`M-04`)** | When `feeBps > 0` and `gross > 0`, compute `Math.mulDiv(gross, feeBps, BPS_DENOMINATOR, Math.Rounding.Ceil)` capped at `gross` (`min(fee, gross)`). | Same `Ceil` rounding required on non-zero fee base. |
| **`LiquidityVault` Blast Radius** | **Zero changes** to `LiquidityVault.sol`. Strictly preserves `lpNet + protocolFee == gross` and `INV-1`–`INV-8`. | Requires new oracle-decomposition logic inside `CommitmentManager._quoteExercise` and edge-case rules for `FIXED` offers, clamped `minPriceX36`/`maxPriceX36`, and `spreadBps <= 0`. |
| **LP Net on `(10,10,25)` (`M_tox=15, p_ex=100%`)** | **`+24.98 bps/fill`** (`+22.79%` APR @ `25%` util) at `pfee = 5`; **`+27.99 bps/fill`** at `pfee = 2`. | `+25.50 bps/fill` at `10%` fee-on-spread (`4.5 bps` protocol cut). |
| **Low-Spread Competitiveness (`< 10 bps`)** | At `pfee = 5`, `5 bps` notional floor constrains ultra-tight `5 bps` MM spreads (`0 bps` margin before premium). | Scales cleanly down to `1–5 bps` spreads because protocol take scales proportionally with LP margin. |

#### Exact Phase 2 Recommendation: Adopt **Option A** Now, Defer **Option B** to v2

1. **Immediate Viability Without Accounting Risk:** Lowering default `protocolFeeBps` from `50` to **`5 bps`** (`0.05%`, operational target `2–5 bps`) instantly flips `(10, 10, 25)` LP unit economics from `-20.23 bps` loss to **`+24.98 bps` net gain** (`+22.79%` APR at `25%` util, `M_tox = 15 bps`) without modifying a single line of [`LiquidityVault.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/LiquidityVault.sol).
2. **Hard Cap (`MAX_PROTOCOL_FEE_BPS = 100`) + Per-Commitment Snapshot (`M-03`):**
   - Reducing `MAX_PROTOCOL_FEE_BPS` from `500` (`5%`) to **`100` (`1.00%`)** bounds worst-case governance misconfiguration to `<= 1%` on new offers while leaving headroom for future fee tiers.
   - Storing `uint16 protocolFeeBps` in `Offer` (snapshotted at `createOffer()`) and `Ticket` (snapshotted from `o.protocolFeeBps` at `reserve()`) guarantees that admin `setProtocolFeeBps()` calls **cannot retroactively tax active offers or live tickets**, eliminating the `M-03` `5%` LP revenue-cut vector.
3. **Ceiling Rounding for Non-Zero Fees (`M-04`):**
   - Replacing `Math.Rounding.Floor` with `Math.Rounding.Ceil` whenever `feeBps > 0 && gross > 0` (explicitly clamped to `fee > gross ? gross : fee`, though impossible when `feeBps <= 100 < 10_000`) ensures every non-zero fill pays at least `1` raw unit of fee. Together with token-aware `minFillAmount` enforcement, zero-fee micro-fill extraction (`M-04`) is closed cleanly.
4. **Why Option B Is Deferred to v2:** Option B introduces semantic ambiguity on `FIXED`-mode offers (where `fixedPriceX36` intentionally decouples from spot and may have no oracle configured) and on `FLOATING` offers when `spreadBps <= 0` or `minPriceX36`/`maxPriceX36` clamps trigger. Option A captures `98%+` of the LP economic upside immediately with minimal audit surface. If institutional competition later compresses `FLOATING` spreads below `10 bps`, Option B can be introduced in a v2 `CommitmentManager` upgrade.

---

## 3. Token-Aware & Offer-Specific Minimums (Cross-Decimal Fix + `M-04`)

### 3.1 Why Single Global `minTicketAmount` Fails (`Econ-2`)

In the frozen codebase ([`CommitmentManager.sol#L93`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L93)), `uint256 public minTicketAmount` is compared against raw `inventoryAmount` in `createOffer()` ([L151](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L151)), `reserve()` ([L261](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L261)), and `splitTicket()` ([L380-L385](file:///c:/Users/USER/Desktop/Tranche/contracts/src/CommitmentManager.sol#L380-L385)).

With the repo default `minTicketAmount = 100e18` (`MEASURED (ON-CHAIN)` in [`deploy.ts#L140`](file:///c:/Users/USER/Desktop/Tranche/sdk/src/deploy.ts#L140)) and HashKey Chain snapshot spot prices (`MEASURED (ON-CHAIN)` in [`ECONOMIC_REVALIDATION.md#L68-L71`](file:///c:/Users/USER/Desktop/Tranche/research/ECONOMIC_REVALIDATION.md#L68-L71)):

| Inventory Token | Decimals | Mainnet Price (`MEASURED`) | `100e18` Raw Units Dollar Value (`ESTIMATED`) | Outcome Under Frozen Design |
| --- | --- | --- | --- | --- |
| **`WHSK`** | `18` | `$0.080808` | `$8.08` | Too small for MEVOS (`~$3k–$5k`), permits cheap split spam if unraised |
| **`WETH`** | `18` | `$1,704.04` | **`$170,404`** | Locks out all `$1k–$100k` WETH offers |
| **`WBTC`** | `8` | `$61,830.80` | **`$6.18e16`** (`10^12 WBTC`) | **100% impossible** to create, reserve, or split any WBTC offer |
| **`USDT`** | `6` | `$1.00` | **`$1e14`** (`10^14 USDT`) | **100% impossible** to offer USDT-side buy capacity |

Lowering global `minTicketAmount` to e.g. `1e6` (`1 USDT`) unblocks `USDT` and `WBTC`, but reduces the `WHSK` split-spam floor to `10^-12 WHSK`, allowing dust NFT proliferation.

### 3.2 Remediation Design: Per-Token Floor + Offer/Ticket Snapshot

Replace `uint256 public minTicketAmount` with a two-tier, immutable-per-commitment minimum system aligned with [`REMEDIATION_SPEC.md#L55-L59`](file:///c:/Users/USER/Desktop/Tranche/research/REMEDIATION_SPEC.md#L55-L59):

1. **Governance Per-Token Floor (`mapping(address inventoryToken => uint256) public tokenMinTicketAmount`):**
   - Set via `setTokenMinTicketAmount(address token, uint256 minAmount)` (`onlyOwner`, validating `token != address(0)` and `minAmount > 0`).
   - Initial HashKey Chain mainnet configuration (`ESTIMATED (DERIVED)` from snapshot prices; calibrated to `~$50–$85` anti-spam/anti-dust floor so gas `$0.025` is `< 0.05%` while preserving composability):

| Token | Decimals | Recommended `tokenMinTicketAmount` | Raw Units | USD Equivalent at Snapshot Price (`ESTIMATED`) | `protocolFee_ex` at `5 bps` (Raw Payment Units) |
| --- | --- | --- | --- | --- | --- |
| **`WHSK`** | `18` | `1_000e18` | `1,000,000,000,000,000,000,000` | **`~$80.81`** (`~$80`) | `>= 40,404` USDT raw (`$0.0404`) |
| **`WETH`** | `18` | `0.05e18` (`5e16`) | `50,000,000,000,000,000` | **`~$85.20`** (`~$85`) | `>= 42,601` USDT raw (`$0.0426`) |
| **`WBTC`** | `8` | `0.001e8` (`1e5`) | `100,000` | **`~$61.83`** (`~$62`) | `>= 30,916` USDT raw (`$0.0309`) |
| **`USDT`** | `6` | `50e6` | `50,000,000` | **`$50.00`** (`$50`) | `>= 25,000`+ raw inv-side payment |

   *(Note: `tokenMinTicketAmount` serves as the protocol-level **anti-spam floor**; LPs wanting higher ticket sizes—such as `$3,000` on `WHSK` to match MEVOS—set a higher `o.minFillAmount` per offer.)*

2. **Offer Creation Validation (`createOffer`):**
   - Require `uint256 tokenMin = tokenMinTicketAmount[p.inventoryToken];`
   - Require `tokenMin > 0` (prevents unlisted/uncalibrated-decimal tokens from bypassing minimums) or explicit `p.minFillAmount > 0 && p.minFillAmount >= tokenMin`. Requiring `tokenMin > 0` is strictly safer for mainnet governance discipline; if permissionless token listing is desired later, a non-zero fallback cannot safely guess decimals without `IERC20Metadata.decimals()`, so explicit governance registration via `setTokenMinTicketAmount` is recommended.
   - Store `o.minFillAmount = p.minFillAmount`.

3. **Ticket Snapshot (`reserve`) & Uniform Lifecycle Enforcement (`M-03` + `M-04`):**
   - **Snapshot (`M-03`):** Add `uint256 minFillAmount;` (and `uint16 protocolFeeBps;`) to `Ticket` in [`IProtocol.sol`](file:///c:/Users/USER/Desktop/Tranche/contracts/src/interfaces/IProtocol.sol#L44-L60). At `reserve()`, set `t.minFillAmount = o.minFillAmount` (and `t.protocolFeeBps = o.protocolFeeBps`), and check `inventoryAmount >= o.minFillAmount`. Subsequent admin changes to `tokenMinTicketAmount` never mutate active offers or tickets (`M-03`).
   - **`splitTicket()`:** Enforce `splitAmount >= t.minFillAmount && parentRem >= t.minFillAmount` (where `parentRem = t.remainingAmount - splitAmount`), and copy `minFillAmount: t.minFillAmount` and `protocolFeeBps: t.protocolFeeBps` onto `newTicketId`.
   - **`exercise()` / `exerciseFor()` (`M-04`):** Compute `actualFill = fillAmount == 0 ? t.remainingAmount : fillAmount` and `newRem = t.remainingAmount - actualFill`. Enforce:
     ```solidity
     if (actualFill != t.remainingAmount) {
         if (actualFill < t.minFillAmount || newRem < t.minFillAmount) {
             revert InvalidFillAmount();
         }
     }
     ```
     **Invariant:** Because a ticket starts with `remainingAmount >= t.minFillAmount`, any split keeps both children `>= t.minFillAmount`, and any partial exercise leaves `newRem == 0` or `newRem >= t.minFillAmount`, **every active ticket always satisfies `t.remainingAmount >= t.minFillAmount`**—eliminating `1-wei` un-splittable dust remainders (`M-04`).

---

## 4. LP Returns & Sensitivity Analysis (Option A: `protocolFeeBps = 5`)

### 4.1 Baseline Fix Comparison (`T = 24h`, `p_ex = 100%`, `C_rebal = 0 bps`, `ESTIMATED (DERIVED)`)

Replacing `protocolFeeBps = 50` with **`protocolFeeBps = 5`** (and showing `2 bps` sensitivity) transforms LP P&L across the canonical presets from [`ECONOMIC_MODEL.md`](file:///c:/Users/USER/Desktop/Tranche/research/ECONOMIC_MODEL.md) and [`ECONOMIC_REVALIDATION.md#L55-L61`](file:///c:/Users/USER/Desktop/Tranche/research/ECONOMIC_REVALIDATION.md#L55-L61):

| Preset `(base, daily, spread)` (`T=24h`) | `protocolFeeBps` | Trader Cost (ex-gas) | Protocol Revenue / Fill | LP Net (`M_tox = 0`) | LP Net (`M_tox = 5`) | LP Net (`M_tox = 15`) | LP Net (`M_tox = 30`) | LP APR @ `25%` Util (`M_tox = 15`) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `(10, 10, 15)` (`ECONOMIC_MODEL` min) | `50` (Frozen Default) | `35.0 bps` | `50.18 bps` | `-15.18 bps` | `-20.18 bps` | `-30.18 bps` | `-45.18 bps` | **`-27.53%`** |
| `(10, 10, 15)` (`ECONOMIC_MODEL` min) | **`5` (Phase 2 Fix)** | `35.0 bps` | `5.02 bps` | **`+29.98 bps`** | **`+24.98 bps`** | **`+14.98 bps`** | `-0.02 bps` | **`+13.67%`** |
| `(10, 10, 15)` (`ECONOMIC_MODEL` min) | `2` (Low-Fee Bound) | `35.0 bps` | `2.01 bps` | `+32.99 bps` | `+27.99 bps` | `+17.99 bps` | `+2.99 bps` | `+16.42%` |
| `(10, 10, 25)` (`ECONOMIC_MODEL` WETH/WBTC) | `50` (Frozen Default) | `45.0 bps` | `50.23 bps` | `-5.23 bps` | `-10.23 bps` | `-20.23 bps` | `-35.23 bps` | **`-18.46%`** |
| `(10, 10, 25)` (`ECONOMIC_MODEL` WETH/WBTC) | **`5` (Phase 2 Fix)** | `45.0 bps` | `5.02 bps` | **`+39.98 bps`** | **`+34.98 bps`** | **`+24.98 bps`** | **`+9.98 bps`** | **`+22.79%`** |
| `(10, 10, 25)` (`ECONOMIC_MODEL` WETH/WBTC) | `2` (Low-Fee Bound) | `45.0 bps` | `2.01 bps` | `+42.99 bps` | `+37.99 bps` | `+27.99 bps` | `+12.99 bps` | `+25.54%` |
| `(15, 15, 25)` (Defensive `FLOATING`) | **`5` (Phase 2 Fix)** | `55.0 bps` | `5.03 bps` | **`+49.97 bps`** | **`+44.97 bps`** | **`+34.97 bps`** | **`+19.97 bps`** | **`+31.91%`** |
| `(15, 10, 65)` (Repriced for `pfee = 50`) | `50` (Frozen Default) | `90.0 bps` | `50.48 bps` | `+34.55 bps` | `+29.55 bps` | `+24.55 bps` | `+9.55 bps` | `+22.40%` |

*(All values `ESTIMATED (DERIVED)` from `CommitmentManager.sol` equations; gas overhead is `$0.02547` taker / `$0.03925` full cycle `ESTIMATED` from `630,366` / `971,551` gas `MEASURED (FOUNDRY)`.)*

### 4.2 Full Sensitivity Matrix at `protocolFeeBps = 5` (`(10, 10, 25)` Preset, `T = 24h`)

Annualized LP APR is computed as $\text{APR} = (\text{LP Net}_{\text{bps}} / 10{,}000) \times u \times 365$ (`ESTIMATED (DERIVED)` across `ASSUMED` utilization `u`, exercise probability `p_ex`, adverse markout `M_tox`, and rebalancing drag `C_rebal`):

#### A. Natural Treasury / Unhedged Inventory LP (`C_rebal = 0 bps`)

| `p_ex` | `M_tox` | Net / Cycle (`bps`) | APR @ `u = 5%` | APR @ `u = 10%` | APR @ `u = 25%` | APR @ `u = 50%` | Regime Assessment |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `25%` | `5 bps` | `+23.74 bps` | `4.33%` | `8.66%` | `21.66%` | `43.32%` | Low exercise + benign flow; reservation fee dominates |
| `25%` | `15 bps` | `+21.24 bps` | `3.88%` | `7.75%` | `19.38%` | `38.76%` | Mixed flow; clears `8%` hurdle at `u >= 10.3%` |
| `25%` | `30 bps` | `+17.49 bps` | `3.19%` | `6.38%` | `15.96%` | `31.91%` | Toxic selective; `20 bps` non-refundable premium shields LP |
| `25%` | `50 bps` | `+12.49 bps` | `2.28%` | `4.56%` | `11.39%` | `22.79%` | Extreme toxicity; still profitable because `75%` walk away |
| `50%` | `5 bps` | `+27.48 bps` | `5.02%` | `10.03%` | `25.08%` | `50.16%` | Clears `5%` hurdle even at `u = 5%` |
| `50%` | `15 bps` | `+22.48 bps` | `4.10%` | `8.21%` | `20.52%` | `41.03%` | Clears `8%` hurdle at `u >= 9.7%` |
| `50%` | `30 bps` | `+14.98 bps` | `2.73%` | `5.47%` | `13.67%` | `27.35%` | Clears `5%` hurdle at `u >= 9.1%`, `8%` at `u >= 14.6%` |
| `50%` | `50 bps` | `+4.98 bps` | `0.91%` | `1.82%` | `4.55%` | `9.10%` | Barely positive; fails `5%–8%` hurdle below `u = 27.5%` |
| `100%` | `5 bps` | `+34.98 bps` | `6.38%` | `12.77%` | `31.92%` | `63.83%` | Ideal institutional block flow |
| `100%` | `15 bps` | `+24.98 bps` | `4.56%` | `9.12%` | `22.79%` | `45.58%` | Baseline mixed flow; clears `8%` hurdle at `u >= 8.8%` |
| `100%` | `30 bps` | `+9.98 bps` | `1.82%` | `3.64%` | `9.10%` | `18.21%` | Stress toxic fill; requires `u >= 22.0%` for `8%` hurdle |
| `100%` | `50 bps` | **`-10.02 bps`** | **`-1.83%`** | **`-3.66%`** | **`-9.15%`** | **`-18.29%`** | **LP loses money** (`M_tox > spread + prem - pfee`) |

#### B. Delta-Neutral Market Maker LP (`C_rebal = 7.5 bps` Off-Chain CEX Hedge per Fill, `ASSUMED`)

Because LPs cannot rebalance on HSKSwap V3 (`149–2,422 bps` slippage at `$5k–$10k`, `ESTIMATED`), a hedged MM incurs `~5–10 bps` (`7.5 bps` midpoint) off-chain CEX/bridge rebalancing cost on every exercised fill (`ECONOMIC_REVALIDATION.md#L162`):

| `p_ex` | `M_tox` | Net / Cycle (`bps`) | APR @ `u = 5%` | APR @ `u = 10%` | APR @ `u = 25%` | APR @ `u = 50%` | Impact of `7.5 bps` Rebalance Drag |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `25%` | `5 bps` | `+21.86 bps` | `3.99%` | `7.98%` | `19.95%` | `39.90%` | `-1.88 bps/cycle` drag |
| `25%` | `15 bps` | `+19.36 bps` | `3.53%` | `7.07%` | `17.67%` | `35.34%` | Needs `u >= 11.3%` for `8%` hurdle (ex-funding carry) |
| `25%` | `30 bps` | `+15.61 bps` | `2.85%` | `5.70%` | `14.25%` | `28.49%` | Needs `u >= 14.0%` for `8%` hurdle |
| `25%` | `50 bps` | `+10.61 bps` | `1.94%` | `3.87%` | `9.68%` | `19.37%` | Needs `u >= 20.7%` for `8%` hurdle |
| `50%` | `5 bps` | `+23.73 bps` | `4.33%` | `8.66%` | `21.66%` | `43.31%` | `-3.75 bps/cycle` drag |
| `50%` | `15 bps` | `+18.73 bps` | `3.42%` | `6.84%` | `17.09%` | `34.19%` | Needs `u >= 11.7%` for `8%` hurdle |
| `50%` | `30 bps` | `+11.23 bps` | `2.05%` | `4.10%` | `10.25%` | `20.50%` | Needs `u >= 19.5%` for `8%` hurdle |
| `50%` | `50 bps` | `+1.23 bps` | `0.23%` | `0.45%` | `1.13%` | `2.25%` | Unviable vs MM `10%–23%` capital + carry cost |
| `100%` | `5 bps` | `+27.48 bps` | `5.01%` | `10.03%` | `25.07%` | `50.15%` | `-7.50 bps/cycle` drag (`-6.84%` APR @ `25%` util) |
| `100%` | `15 bps` | `+17.48 bps` | `3.19%` | `6.38%` | `15.95%` | `31.90%` | Clears `8%` at `u >= 12.5%`; tight vs `10%–23%` MM hurdle |
| `100%` | `30 bps` | `+2.48 bps` | `0.45%` | `0.90%` | `2.26%` | `4.52%` | Unviable unless spread raised above `40+ bps` |
| `100%` | `50 bps` | **`-17.52 bps`** | **`-3.20%`** | **`-6.40%`** | **`-15.99%`** | **`-31.98%`** | **Heavy MM loss** |

### 4.3 Fixed-Strike & Pull-Oracle Stressed Volatility (`80%` and `120%` RV, `ASSUMED` / `ESTIMATED`)

Pulling the exact Black-Scholes / Gaussian latency sensitivity from [`ECONOMIC_REVALIDATION.md#L182-L185`](file:///c:/Users/USER/Desktop/Tranche/research/ECONOMIC_REVALIDATION.md#L182-L185):

| Volatility Regime (`ASSUMED`) | `FLOATING` Latency `30s` (`@10 / @15 / @25 / @35 bps`) | `FLOATING` Latency `60s` (`@10 / @15 / @25 / @35 bps`) | `FLOATING` Latency `300s` (`@10 / @15 / @25 / @35 bps`) | `FIXED` ATM BS Fair Value (`1h / 6h / 24h / 72h / 7d`) |
| --- | --- | --- | --- | --- |
| **`80%` Annualized RV** | `0.37 / 0.08 / 0.00 / 0.00 bps` | `1.10 / 0.44 / 0.04 / 0.00 bps` | `5.64 / 4.11 / 2.00 / 0.87 bps` | `34.1 / 83.5 / 167.0 / 289.3 / 441.8 bps` |
| **`120%` Annualized RV** | `1.28 / 0.55 / 0.07 / 0.00 bps` | `2.77 / 1.64 / 0.47 / 0.10 bps` | `10.30 / 8.46 / 5.51 / 3.42 bps` | `51.2 / 125.3 / 250.5 / 433.8 / 662.2 bps` |

**Pricing Implications Under `protocolFeeBps = 5`:**
- **`FLOATING` Mode:** At `spreadBps >= 25` and `<= 30s` oracle cadence, pure latency-arb toxicity remains `<= 0.07 bps` even at `120%` RV (`ESTIMATED`). If oracle updates slip to `60s–300s` during a `120%` vol spike, latency toxicity rises to `0.47–5.51 bps` at `25 bps` spread (`1.64–8.46 bps` at `15 bps`), reinforcing the need for `>= 20–25 bps` spreads and `maxPriceAge <= 30s–60s` on volatile pairs.
- **`FIXED` Mode:** A `24h` ATM `FIXED` ticket has **`167.0 bps` (`80%` RV) to `250.5 bps` (`120%` RV)** theoretical option value (`ESTIMATED`). Under `protocolFeeBps = 5`, `FIXED` offers must either price `effPremiumBps >= 175–260 bps` (for ATM) or set `fixedPriceX36` **out-of-the-money** (`+2%` to `+5%` structured treasury disposition/accumulation). Reducing `protocolFeeBps` from `50` to `5` saves the LP `45 bps` of notional tax on every exercised `FIXED` ticket as well.

### 4.4 Minimum Viable Trader Pricing to Clear `5%` and `8%` LP Hurdle Rates (`protocolFeeBps = 5`, `T = 24h`, `p_ex = 100%`)

For `p_ex = 100%` and `protocolFeeBps = 5` ($f = 0.0005$), clearing a target annual LP APR $H$ at utilization $u$ requires:

$$\text{Required Net/Cycle} = \frac{H \times 10{,}000}{365 \cdot u}, \qquad \text{Min Total Trader Fee } (\text{effPrem} + \text{spread}) = \frac{\text{Required Net/Cycle} + 5 + M_{\text{tox}} + C_{\text{rebal}}}{1 - 0.0005}$$

Exact minimum viable total trader fee (`bps` above spot) and illustrative `(base, daily, spread)` presets (`ESTIMATED (DERIVED)`):

| Utilization `u` | Required Net (`5%` / `8%` Hurdle) | `M_tox = 5 bps`, Natural LP (`C_rebal = 0`) | `M_tox = 15 bps`, Natural LP (`C_rebal = 0`) | `M_tox = 15 bps`, Hedged MM (`C_rebal = 7.5`) | `M_tox = 30 bps`, Natural LP (`C_rebal = 0`) |
| --- | --- | --- | --- | --- | --- |
| **`u = 5%`** | `27.40` / `43.84 bps` | **`37.4` / `53.9 bps`** e.g. `(10,10,18)` / `(15,15,25)` | **`47.4` / `63.9 bps`** e.g. `(15,10,23)` / `(20,15,30)` | **`54.9` / `71.4 bps`** e.g. `(15,15,25)` / `(20,20,32)` | **`62.4` / `78.9 bps`** e.g. `(20,15,28)` / `(25,20,35)` |
| **`u = 10%`** | `13.70` / `21.92 bps` | **`23.7` / `31.9 bps`** e.g. `(10,5,10)` / `(10,10,12)` | **`33.7` / `41.9 bps`** e.g. `(10,10,15)` / `(10,10,22)` | **`41.2` / `49.4 bps`** e.g. `(10,10,22)` / `(15,10,25)` | **`48.7` / `57.0 bps`** e.g. `(15,10,25)` / `(15,15,28)` |
| **`u = 25%`** | `5.48` / `8.77 bps` | **`15.5` / `18.8 bps`** e.g. `(5,5,6)` / `(5,5,10)` | **`25.5` / `28.8 bps`** e.g. `(10,5,11)` / `(10,5,15)` | **`33.0` / `36.3 bps`** e.g. `(10,10,13)` / `(10,10,17)` | **`40.5` / `43.8 bps`** e.g. `(15,10,16)` / `(15,10,20)` |
| **`u = 50%`** | `2.74` / `4.38 bps` | **`12.8` / `14.4 bps`** e.g. `(5,3,5)` / `(5,5,5)` | **`22.8` / `24.4 bps`** e.g. `(10,5,8)` / `(10,5,10)` | **`30.3` / `31.9 bps`** e.g. `(10,5,16)` / `(10,10,12)` | **`37.8` / `39.4 bps`** e.g. `(15,10,13)` / `(15,10,15)` |

**Key Takeaways:**
1. At **`25%` utilization** and `M_tox = 15 bps`, `protocolFeeBps = 5` enables LPs to clear the **`8%` hurdle at just `28.8 bps` total trader fee** (`36.3 bps` with `7.5 bps` CEX hedge)—compared to **`69.1–76.7 bps`** required under the frozen `protocolFeeBps = 50` default (`ECONOMIC_REVALIDATION.md#L233`).
2. **At `u <= 10%` with `M_tox = 30 bps`, even `pfee = 5` requires `48.7–57.0 bps` trader fees**, and if `p_ex` drops below `100%`, **front-loading fees into `basePremiumBps + dailyPremiumBps` (`15–25 bps`) rather than `spreadBps`** is strictly superior for protecting LPs against selective walk-aways.

---

## 5. Honest Residual Economic Risk Statement

Fixing `protocolFeeBps = 5`, snapshotting fee/minimum terms (`M-03`), enforcing token-aware `minFillAmount` across `reserve`/`splitTicket`/`exercise` (`M-04`, `Econ-2`), and rounding non-zero fees `Ceil` **eliminates every protocol-induced economic defect**, turning unit economics strictly positive per filled dollar (`+24.98 bps` vs `-20.23 bps` on `(10, 10, 25)`).

**However, protocol fee fixes alone do NOT create mainnet demand or solve utilization risk:**
1. **Insufficient Organic HashKey Chain DEX Flow (`MEASURED (ON-CHAIN)`):** Total 14-day HSKSwap V3 volume across `WHSK/USDT`, `WETH/USDT`, and `WBTC/USDT` was `$44,053.47` (`$3,146.68/day`), of which **`92.2%` of swaps (`71.7%` of volume, `$31,566.05`)** came from a single automated contract pair (`0x56d15cf0... -> 0x11274593...`), leaving **`$891.96/day`** of organic non-bot DEX volume (`ECONOMIC_REVALIDATION.md#L79-L90`).
2. **Utilization Floor (`ESTIMATED (DERIVED)`):** Even if Tranche captured **100% of organic non-bot DEX flow (`$892/day`)** on a `$250,000` LP vault, realized utilization would be **`0.36%`** (`0.33%` APR at `+25 bps` net)—failing both the `5%–8%` natural LP hurdle (`ASSUMED`) and the `10%–23%+` delta-neutral MM hurdle (`ASSUMED`).
3. **Required Go-to-Market Condition:** Sustainable mainnet LP returns require **`>= $50,000/day` of bilateral institutional, DAO treasury, autonomous agent, or RWA settlement orderflow** (`u >= 20%` on `$250k` TVL, or `u >= 10%` on `$500k` TVL) that explicitly requires **atomic on-chain settlement, non-custodial custody, standby credit optionality, or composable `ERC-721` commitments** rather than off-chain HashKey Exchange (CEX) / OTC execution (`6–40 bps` `ASSUMED` above `$5k`).
