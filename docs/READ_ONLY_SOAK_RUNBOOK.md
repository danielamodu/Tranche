# Tranche — Read-Only Continuous Soak-Test Runbook (Chain 177)

> **Purpose:** Operate the Tranche autonomous agent continuously against **live HashKey Chain Mainnet (Chain 177)** market data in strict `read_only` mode (24h, extendable to 48h–72h) to collect verifiable decision, regime, and reliability evidence with **zero transaction broadcasting**.

---

## 1. Environment Configuration

No private key or signer is required or loaded in `read_only` mode.

| Variable | Default | Description |
| --- | --- | --- |
| `AGENT_DATA_SOURCE` | `chain177_read_only` | **Required** for soak runner. Enforces live Chain 177 RPC reads (never fixtures). |
| `AGENT_EXECUTION_MODE` | `read_only` | **Required** for soak runner. Enforced fail-closed across `validateRuntimeSafety`, `TrancheAutonomousAgent`, `TrancheExecutionAgent`, and `HskSwapVenue`. |
| `AGENT_SOAK_DURATION_HOURS` | `24` | Planned soak duration (`24`, `48`, or `72`). Overridden by `--hours <N>`. |
| `AGENT_RPC_URL` | `https://mainnet.hsk.xyz` | HashKey Chain Mainnet (`177`) JSON-RPC endpoint. |
| `AGENT_POLL_MS` | `15000` | Polling interval in milliseconds (minimum `2000` ms). |
| `AGENT_SOAK_LOG_DIR` | `./soak-evidence` | Root directory for per-session JSONL evidence folders and `soak.pid`. |
| `AGENT_SOAK_MAX_SNAPSHOTS` | `0` (`unlimited`) | Optional retention cap on `snapshots.jsonl` lines (rotates atomically when exceeded). |
| `AGENT_SOAK_STATE_FILE` | `<logDir>/soak-state.json` | Persistent `PositionStore` ledger (policy versions, deduplication keys, lockfile). |
| `AGENT_API_HOST` | `127.0.0.1` | Localhost-only telemetry API bind address. |
| `AGENT_API_PORT` | `8787` | Telemetry API port. |
| `AGENT_API_TOKEN` | *(auto-generated)* | Strong random Bearer / `X-Agent-Token` for POST control routes. |
| `AGENT_SOAK_DISABLE_API` | `false` | Set `true` to run headless without the localhost HTTP API. |

---

## 2. RPC Requirements

- **Chain ID:** Strictly verified on startup via `eth_chainId` (`177`). Any mismatch fails closed before polling starts.
- **Endpoints:** `https://mainnet.hsk.xyz` (2.0s block time).
- **Read efficiency:** Pool state reads (`token0`, `token1`, `fee`, `liquidity`, `slot0`, `observe`) are batched via canonical `Multicall3` (`0xcA11bde05977b3631167028862bE2a173976CA11`), and swap quotes use live `QuoterV2` (`0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD`).
- **Backoff & Recovery:** Transient RPC failures (`429`, timeouts, socket resets) use bounded exponential backoff (`transientRpcRetries=3`, `retryBackoffMs=250`, `maxRetryBackoffMs=5000`). In `read_only` mode, the runner stays active across transient outages, marks `rpcHealthy=false` (`RECOVERING`), and automatically transitions back to `HEALTHY` (`RECOVERY` event) when the RPC responds again.

---

## 3. Startup Commands

Run from the `agent/` directory:

```powershell
cd agent

# 24-hour read-only soak (Chain 177)
npm run soak:24h

# 48-hour read-only soak (Chain 177)
npm run soak:48h

# 72-hour read-only soak (Chain 177)
npm run soak:72h
```

Custom configuration example (PowerShell):

```powershell
cd agent
$env:AGENT_DATA_SOURCE="chain177_read_only"
$env:AGENT_EXECUTION_MODE="read_only"
$env:AGENT_SOAK_DURATION_HOURS="24"
$env:AGENT_POLL_MS="15000"
$env:AGENT_SOAK_LOG_DIR="./soak-evidence"
$env:AGENT_API_TOKEN="replace-with-strong-local-token"
npm run soak:24h
```

---

## 4. Monitoring Commands

### Via Local Telemetry API (Read-Only GET)

```bash
# Soak session telemetry (sessionId, mode, uptime, RPC health, cycles, venues, regimes, evidenceDir)
curl -s http://127.0.0.1:8787/agent/soak

# Health & readiness probes
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/ready

# Latest market snapshot & recent decisions
curl -s http://127.0.0.1:8787/agent/markets
curl -s "http://127.0.0.1:8787/agent/decisions?limit=10"
```

### Via CLI Inspector

```powershell
cd agent
npm run soak:inspect
```

---

## 5. Graceful Shutdown

- **Interactive terminal:** Press `Ctrl+C` (`SIGINT`).
- **From another terminal:**
  ```powershell
  cd agent
  npm run soak:stop
  ```
- **What happens on shutdown:**
  1. `SoakRunner.stop()` cancels the duration timer and stops the polling interval.
  2. `AgentRuntime.stop()` waits for any in-flight observation cycle to complete.
  3. `PositionStore.releaseLock()` removes `soak-state.json.lock`.
  4. `SoakEvidenceStore` appends a `SHUTDOWN` event to `events.jsonl`, writes final metrics to `metrics.jsonl`, and atomically updates `session.json` (`status: "STOPPED"` or `"COMPLETED"`).
  5. `soak.pid` is removed and the HTTP API closes cleanly.

---

## 6. Restart, Session Resumption & 48–72h Extension Procedure

### Automatic Crash Recovery (Preserving Original 24h Session)
1. While a soak is `RUNNING`, `SoakEvidenceStore` tracks the active session in `<AGENT_SOAK_LOG_DIR>/active-session.json`.
2. On unexpected process termination, `systemd` (`Restart=on-failure`) restarts `start-soak.ts` with `AGENT_SOAK_RESUME=true` (default).
3. On startup, the runner:
   - Resumes the **original `sessionId`** and **original `startedAtSec`** (it does **not** reset the 24-hour clock).
   - Restores cumulative cycle, regime, venue, error, retry, and recovery counters from disk.
   - Records a `RESTART_RESUMED` event in `events.jsonl` and increments `restartsCount` in `session.json` so interruptions are never hidden.
   - Restores persisted policy version, risk limits, kill-switch/pause flags, and executed decision deduplication keys from `soak-state.json` (`STATE_RESTORE` event), preventing duplicate actionable decisions within the cooldown bucket (`SKIPPED_DUPLICATE`).
4. When the 24-hour window completes cleanly, `status` transitions to `COMPLETED`, `active-session.json` is cleared, and the process exits with code `0` so `systemd` does **not** restart a completed session.
5. **Corrupted state recovery:** If `soak-state.json` is corrupted on startup, the agent **fails closed** (`CORRUPTED_STATE` event, all actions blocked as `BLOCKED_RISK`, `GET /ready` returns `503`). Inspect `soak-state.json.bak` and restore it manually only after verifying integrity.

### Extending a Completed 24h Soak to 48h or 72h
Do not overwrite or delete the 24h session directory. To extend the same session to 48h or 72h after developer authorization:
```bash
# Set AGENT_SOAK_SESSION_ID to the completed 24h session ID and increase duration:
AGENT_SOAK_SESSION_ID="soak-..." AGENT_SOAK_DURATION_HOURS=48 npm run soak:48h
# Or for 72h:
AGENT_SOAK_SESSION_ID="soak-..." AGENT_SOAK_DURATION_HOURS=72 npm run soak:72h
```
Passing the same `sessionId` with `durationHours <= previousDurationHours` fails closed (`SOAK_SESSION_ALREADY_COMPLETED`). Passing a strictly larger duration (`48` or `72`) preserves the original `startedAt`, appends to the existing JSONL files, and runs strictly for the remaining window.

---

## 7. Evidence Directory Structure

Each soak session writes to `<AGENT_SOAK_LOG_DIR>/<sessionId>/`:

```text
soak-evidence/
├── soak.pid                          # Active runner PID metadata (removed on graceful stop)
├── soak-state.json                   # Persistent PositionStore ledger (atomic .tmp + .bak)
└── soak-2026-11-26T13-00-00-000Z-1234/
    ├── session.json                  # Session metadata, status, config, latest metrics snapshot
    ├── snapshots.jsonl               # Timestamped MarketSnapshot records (chainId, block, prices, oracle, regime, anomalies)
    ├── decisions.jsonl               # Timestamped AgentDecision records (decisionId, venue, action, cost, gas, codes, readOnlyBlocked)
    ├── events.jsonl                  # Operational events (STARTUP, SHUTDOWN, RPC_ERROR, RETRY, RECOVERY, STATE_RESTORE, HEALTH_TRANSITION, MISSED_CYCLE, CORRUPTED_STATE)
    └── metrics.jsonl                 # Periodic aggregated metrics (cycles, rpcSuccessRate, latency, venue distribution, regimes, txBroadcastCount)
```

All JSONL records pass through `redactSensitive()` before disk write so private keys, Bearer tokens, and secret fields are never persisted.

---

## 8. Interpreting Metrics

- **`rpcSuccessRate`:** `successfulCycles / totalCycles`. Target `>= 0.99` over a 24h soak.
- **`avgRpcLatencyMs` / `maxRpcLatencyMs`:** End-to-end RPC observation latency per cycle (`Multicall3` + `QuoterV2` + oracle read).
- **`decisionsByVenue`:** Distribution across `TRANCHE`, `HSKSWAP`, and `NONE`. Before Tranche contracts are deployed on Chain 177, `TRANCHE` offers are genuinely empty (never fabricated), so actionable entries route to `HSKSWAP` (blocked by `read_only`) or `NONE`.
- **`observedRegimes` / `unobservedRegimes`:** Actual counts of `CALM`, `TRENDING`, `VOLATILE`, and `DISLOCATED` observed from real Chain 177 market prices. Unobserved regimes are explicitly listed rather than fabricated.
- **`riskRejectionCount` / `duplicateDecisionCount`:** Confirms risk bounds and cooldown deduplication are actively enforced.
- **`txBroadcastCount`:** **Must be strictly `0`** for every read-only soak.

---

## 9. Failure Conditions That Invalidate a Soak

A soak run is **invalid** if any of the following occur:
1. `txBroadcastCount > 0` in `session.json`, `metrics.jsonl`, or `decisions.jsonl`.
2. `executionMode !== "read_only"` or `dataSource !== "chain177_read_only"` or `chainId !== 177`.
3. Sustained unrecovered RPC outage causing prolonged observation gaps without `RPC_ERROR` / `HEALTH_TRANSITION` telemetry.
4. `BLOCK_NUMBER_REGRESSION` or `STALE_POOL_TIMESTAMP` producing an actionable non-`WAIT` decision.
5. `CORRUPTED_STATE` failing open instead of blocking actions.
6. Any secret, private key, or API token appearing in JSONL evidence files.

---

## 10. Verifying Zero Transactions Were Broadcast

1. **No signer loaded:** `start-soak.ts` constructs only a viem `PublicClient` (no `WalletClient`, no `Account`, no `AGENT_TRADER_PRIVATE_KEY`).
2. **Backend fail-closed guards:** `HskSwapVenue({ readOnly: true })`, `TrancheExecutionAgent(client, { readOnly: true })`, and `TrancheAutonomousAgent({ executionMode: "read_only" })` all throw `READ_ONLY_MODE_BLOCKED` or suppress execution before any write path.
3. **Evidence audit:**
   ```powershell
   cd agent
   npm run soak:inspect
   ```
   Confirm `txBroadcastCount: 0` in the output and verify `decisions.jsonl` contains zero `txHashes` and `executionMode: "read_only"` on every line.

---

## 11. Simulated Failure Tests vs. Live Soak Observations

- **Simulated failure tests (`agent/test/soak.test.ts`):** Deliberately inject mocked RPC timeouts (`429`), stale oracles, extreme oracle deviation, block-number regression, corrupted JSON state, and restart deduplication to verify fail-closed and recovery code paths deterministically. These validate infrastructure correctness — they are **not** live Chain 177 failures.
- **Live Chain 177 integration (`agent/test/chain177.readonly.test.ts`):** Executes real read-only RPC cycles against `https://mainnet.hsk.xyz` to verify live connectivity, schema completeness, and zero broadcasts.
- **Actual 24h/48h/72h soak observations:** Recorded strictly in `soak-evidence/<sessionId>/` during continuous wall-clock runs. Any RPC errors, recoveries, or market regimes reported in a soak post-mortem must come solely from that session's JSONL evidence.
