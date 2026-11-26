# Controlled Chain 177 Fork Execution Regression Report

**Machine-Readable Source:** [raw/fork-regression-report.json](./raw/fork-regression-report.json)  
**Test Suite:** `cd agent && npm run test:fork:regression` (`agent/test/fork.regression.test.ts`)  
**Network:** Local Anvil fork of HashKey Chain Mainnet (`chainId: 177`, forked at block `30687643`, `gasPriceWei: 439320812500`)  
**Public Network Broadcasts:** **0** (all transactions executed strictly on ephemeral `127.0.0.1` Anvil fork)

---

## 1. Scenario Results (10 / 10 Passed)

| # | Scenario | Result | Key Observed Outcome |
| --- | --- | --- | --- |
| 1 | Tranche offer discovery, reservation & exercise | **PASS** | Selected `TRANCHE` Offer #1 (`RESERVE_TRANCHE`), reserved Ticket #1 (`0x8f37b4...`, block `30687662`), exercised full `100 WHSK` (`0x39f080...`, block `30687663`), exact `0` USDT cost discrepancy |
| 2 | HSKSwap quote & SwapRouter02 execution | **PASS** | Selected `HSKSWAP` (`SWAP_HSKSWAP`), swapped `7,945,804` USDT for `100.000000002621021293 WHSK` (`0x4bc029...`, block `30687665`), `0` USDT cost discrepancy, `0 bps` output shortfall |
| 3 | No-trade decision | **PASS** | `selectedVenue: NONE`, `selectedAction: WAIT` (`INSUFFICIENT_NET_EDGE`), `0` txs |
| 4 | Risk-limit rejection | **PASS** | `selectedAction: BLOCKED_RISK` (`max_position_size`: target `100 WHSK` > cap `50 WHSK`), `0` txs |
| 5 | Slippage / liquidity rejection | **PASS** | `selectedVenue: NONE`, `selectedAction: WAIT` (`SLIPPAGE_EXCEEDED:30bps>1bps`), `0` txs |
| 6 | Failed transaction handling | **PASS** | Revert (`SwapRouter02: Too little received`) caught as `EXECUTION_FAILED`, `pendingTxsRemaining: 0`, `stateCorrupted: false` |
| 7 | Uncertain transaction handling | **PASS** | RPC timeout persisted `UNCERTAIN_TIMEOUT` pending tx (`tx-dex-1-1795722452`) |
| 8 | Restart with pending transaction | **PASS** | Fresh `PositionStore` + agent instance restored pending tx and blocked entry (`BLOCKED_RISK` via `no_pending_tx`) |
| 9 | Reconciliation after restart | **PASS** | `TransactionReconciler` confirmed fork receipt `0x4bc029...` (`status: CONFIRMED`, `canClearPending: true`), and pending queue cleared cleanly (`remainingPendingTxs: 0`) |
| 10 | Duplicate execution prevention | **PASS** | Repeat cycle in cooldown bucket `29928707` returned `SKIPPED_DUPLICATE` with `0` txs |

---

## 2. Expected vs. Actual Execution Cost Comparison (100 WHSK Target)

| Metric | Venue 1: Tranche (Reserve + Exercise) | Venue 2: HSKSwap V3 (SwapRouter02) |
| --- | --- | --- |
| **Snapshot Block** | `30687661` | `30687663` |
| **Pool Spot (`spotPriceX36`)** | `79218147100067574508514` (`~$0.079218`) | `79218147100067574508514` (`~$0.079218`) |
| **Pool 30m TWAP (`twapPriceX36`)** | `79240274371236763540964` (`~$0.079240`) | `79240274371236763540964` (`~$0.079240`) |
| **Market Regime** | `CALM` | `CALM` |
| **Expected All-In Cost (incl. gas est.)** | `7,773,131` USDT (`$7.773131`) | `7,946,303` USDT (`$7.946303`) |
| **Expected Token Payment (ex-gas)** | `7,771,919` USDT (`$7.771919`: `$0.008540` prem + `$7.763379` ex) | `7,945,804` USDT (`$7.945804`) |
| **Actual On-Chain USDT Spent** | **`7,771,919` USDT** (`$7.771919`) | **`7,945,804` USDT** (`$7.945804`) |
| **Quoted vs. Actual Token Discrepancy** | **`0` USDT (`0 bps`)** | **`0` USDT (`0 bps`)** |
| **Quoted Price Impact / Realized Shortfall** | `0 bps` / `0 bps` | `30 bps` (0.30% pool fee) / `0 bps` |
| **Actual Inventory Received** | `100.000000000000000000 WHSK` | `100.000000002621021293 WHSK` |
| **Gas Consumed** | `468,253` (reserve) + `125,188` (exercise) = **`593,441`** | **`103,631`** |
| **Fork Receipt Hash(es)** | `0x8f37b4f6...7056ef`, `0x39f0802b...feb6ed4` | `0x4bc0297d...7459ee11` |
| **Risk Evaluation** | `allowed: true` (`0` failed checks) | `allowed: true` (`0` failed checks) |

**Economic Routing Proof:** When an LP posted a Tranche offer 2% below spot, `VenueSelector` deterministically chose `TRANCHE`, saving **`173,172` raw USDT (`$0.173172`, or `2.18%`)** all-in (after gas) versus HSKSwap V3. When no eligible Tranche offer was available, `VenueSelector` deterministically routed to `HSKSWAP` with zero token-cost discrepancy against `QuoterV2`.
