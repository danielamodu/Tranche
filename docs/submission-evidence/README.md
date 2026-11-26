# Tranche — Consolidated Submission Evidence Package

**Track:** HSK Chain Horizon Hackathon — Track 1: AI Agent Trading  
**Network:** HashKey Chain Mainnet (`177`, read-only observation & local Anvil fork execution) & HashKey Chain Testnet (`133`, live contracts deployed, execution disabled)

> **Evidence Integrity Policy:** All metrics below come directly from verified test runs, local Chain 177 Anvil fork receipts, and live EC2 JSONL evidence. Local fork transactions are explicitly labeled as fork-only (zero public broadcasts). The 24-hour EC2 read-only soak is reported with its exact accumulated healthy observation time and is **not** claimed complete until 24 hours have elapsed.

---

## 1. Architecture Overview

Tranche is a dual-venue autonomous trading & inventory-commitment agent built natively for HashKey Chain:

1. **On-Chain Commitment Protocol (`contracts/`, `sdk/`):** `LiquidityVault`, `CommitmentManager`, `ExecutionTicket` (ERC-721), `ExecutionRouter`, `SignedPullOracle`, `OraclePriceAdapter`, `UniswapV3TwapOracle`, and `HSPComplianceHook`. Enables LPs to post inventory-backed, time-bounded option-like reservation offers alongside immediate AMM liquidity.
2. **Market Intelligence (`agent/src/market.ts`):** Combines live HSKSwap V3 pool state (`Multicall3` batched reads + 30m TWAP), `QuoterV2` buy/sell quotes, oracle freshness/deviation checks, block/timestamp monotonicity guards, and rolling volatility/momentum/dislocation regime classification (`CALM | TRENDING | VOLATILE | DISLOCATED`).
3. **Deterministic Strategy & Dual-Venue Selector (`agent/src/strategy.ts`, `agent/src/venue.ts`):** Compares all-in gas-adjusted acquisition cost between **Tranche** (reservation premium + exercise payment + 2-tx gas) and **HSKSwap V3** (immediate swap + price impact + 1-tx gas) in consistent payment-token units. Never delegates signal generation or risk overrides to an LLM.
4. **Code-Enforced Risk & Reliability Layer (`agent/src/risk.ts`, `agent/src/positions.ts`, `agent/src/reconciler.ts`, `agent/src/runtime.ts`):** Enforces exposure caps, non-refundable premium budgets, slippage caps, oracle staleness/deviation bounds, single-instance lockfiles, atomic state persistence (`.tmp` + `.bak`), fail-closed state corruption handling, cooldown deduplication across restarts, pending-transaction reconciliation, and backend-enforced `read_only` mode.
5. **Continuous Read-Only Soak & Telemetry (`agent/src/soak-evidence.ts`, `agent/src/soak-runner.ts`, `agent/src/server.ts`):** Append-only secret-redacted JSONL evidence (`snapshots.jsonl`, `decisions.jsonl`, `events.jsonl`, `metrics.jsonl`, `session.json`) with crash-safe session resumption (`active-session.json`) and a localhost-bound, Bearer-authenticated HTTP control/telemetry API.

---

## 2. Package Contents

| # | Evidence Item | File |
| --- | --- | --- |
| 1 | Architecture & Submission Index | [README.md](./README.md) *(this file)* |
| 2 | Controlled Chain 177 Fork Execution Regression (10/10 scenarios, venue examples, expected vs. actual cost comparison, risk & recovery evidence) | [fork-execution-regression-report.md](./fork-execution-regression-report.md) |
| 3 | Chain 177 Read-Only Soak, Hosted API Security, & Chain 133 Testnet Readiness Report | [soak-and-operations-report.md](./soak-and-operations-report.md) |
| 4 | Machine-Readable Fork Regression Evidence (JSON) | [raw/fork-regression-report.json](./raw/fork-regression-report.json) |
| 5 | Machine-Readable Live EC2 Soak Snapshot (JSON) | [raw/soak-snapshot/ec2-soak-live-snapshot.json](./raw/soak-snapshot/ec2-soak-live-snapshot.json) |
| 6 | Operational & Soak Runbooks | [../OPERATIONAL_RUNBOOK.md](../OPERATIONAL_RUNBOOK.md), [../READ_ONLY_SOAK_RUNBOOK.md](../READ_ONLY_SOAK_RUNBOOK.md) |

---

## 3. Automated Verification Summary

| Suite | Environment | Result |
| --- | --- | --- |
| `cd agent && npm run typecheck` | Local & EC2 | **PASS** (0 errors) |
| `cd agent && npm test` (35 tests: agent, autonomous, server, operations, soak 1–9) | Local | **PASS** (`35/35`) |
| `autonomous` + `server` + `operations` + `soak` (33 non-Anvil tests) | EC2 (`13.60.129.92`) | **PASS** (`33/33`) |
| `cd agent && npm run test:chain177` (live Chain 177 read-only integration) | Local & EC2 | **PASS** (`1/1`, zero tx broadcast) |
| `cd agent && npm run test:fork` (existing Chain 177 Anvil fork integration) | Local | **PASS** (`2/2`, fork-only) |
| `cd agent && npm run test:fork:regression` (10-scenario regression + cost audit) | Local | **PASS** (`10/10`, fork-only) |

---

## 4. Known Limitations & Deployment Status

1. **Mainnet (`177`) execution intentionally disabled:** No Tranche contracts are deployed on Chain 177 mainnet and no production signer is configured. Live EC2 services operate strictly in `read_only` mode (`txBroadcastCount: 0`).
2. **Chain 133 testnet has no HSKSwap V3 liquidity:** All 15 Tranche contracts and 3 Safe proxies are deployed and verified on Chain 133 (`deployments/hashkey-testnet.json`), but canonical HSKSwap V3 factory/quoter/router addresses have `0 bytes` on Chain 133. `tranche-testnet-observer.service` reports `HSKSwapV3-Unavailable-Chain133` honestly without fabricating quotes.
3. **Hosted API & Frontend LIVE:** `https://api.tranche.space` (`A 13.60.129.92`, Let's Encrypt TLS via Caddy, strict CORS for `https://app.tranche.space`, Bearer auth on `POST` routes) and `https://app.tranche.space` (`VITE_AGENT_API_URL=https://api.tranche.space`, zero `AGENT_API_TOKEN` in bundle) are both externally verified live.
4. **24-hour soak in progress:** `soak-2026-11-26T16-43-03-222Z-20555` has accumulated **~3h 04m (`738/738` cycles, 100% RPC success, `0` broadcasts)** as of `2026-11-26T19:47:24Z` and continues running uninterrupted toward 24 hours.
