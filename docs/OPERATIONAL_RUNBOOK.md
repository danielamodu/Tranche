# Tranche Protocol & Agent — Operational & Incident Response Runbook

> **Status:** HashKey Chain Mainnet (`177`) execution is **disabled by default**. This runbook governs controlled testnet (`133`), local fork (`177`), and future authorized mainnet operations.

---

## 1. Signer Separation & Minimum Balances

| Role | Custody Model | Permissions | Never Shared With | Minimum Funding |
| --- | --- | --- | --- | --- |
| **Deployer EOA** | Temporary hot wallet | Deploys contracts; **renounces `DEFAULT_ADMIN_ROLE`** after 48h handover | Gov, Guardian, Treasury, Agent | `~15 HSK` (deployment + handover) |
| **Governance Safe (3/5)** | Hardware multisig | `PROPOSER_ROLE` & `EXECUTOR_ROLE` on `TimelockController` (48h delay) | Agent, Oracle | Gas sponsor only |
| **Guardian Safe (2/3)** | Hardware multisig | Emergency `setDepositsPaused`, `setNewReservationsPaused`, `setFloatingExercisePaused`, `revokePrice`, `TimelockController.cancel` | Agent | Gas sponsor only |
| **Treasury Safe (2/3)** | Hardware multisig | `feeCollector` (`withdrawProtocolFees`) | Agent | Gas sponsor only |
| **Oracle Signers (2/3)** | Isolated KMS / signers | EIP-712 `SignedPullOracle` price updates (bounded by 5% TWAP circuit breaker) | Agent, Gov | Zero gas required |
| **Agent Trader EOA** | Dedicated bounded key | Holds only capped trading capital + gas; **zero admin/governance rights** | All protocol roles | `~3–5 HSK` gas + capped USDT/WHSK |

---

## 2. RPC & Infrastructure Requirements

- **HashKey Chain Mainnet (`177`):** `https://mainnet.hsk.xyz` (2.0s block time).
  - `eth_getLogs` strictly rejects ranges `>= 10,000` blocks → frontend & agent clamp to `<= 5,000` blocks.
  - Rapid parallel `eth_call` bursts trigger HTTP `429` → all multi-reads batch through `Multicall3` (`0xcA11bde05977b3631167028862bE2a173976CA11`, `<= 30` calls/chunk).
- **No silent fallback:** If a live RPC fails beyond bounded retries (`transientRpcRetries`), `AgentRuntime` transitions to `RECOVERING` and auto-pauses at `maxConsecutiveErrors` (`PAUSED_CIRCUIT_BREAKER`). It **never** silently falls back to fixture data.

---

## 3. Startup, Shutdown & Control Procedures

```bash
# 1. Dry-run mode (DEFAULT — real read-only Chain 177 quotes, ZERO tx broadcasts):
cd agent
$env:AGENT_API_TOKEN="<strong-random-token>"
npm run api

# 2. Local Chain 177 Anvil fork mode:
# Terminal A: anvil --fork-url https://mainnet.hsk.xyz --port 8545
# Terminal B:
$env:AGENT_DATA_SOURCE="fork"
$env:AGENT_RPC_URL="http://127.0.0.1:8545"
$env:AGENT_API_TOKEN="<strong-random-token>"
npm run api

# 3. Health & Readiness probes:
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/ready
```

- **Single-instance lock:** `PositionStore.acquireLock()` creates an exclusive `.lock` file preventing two runtime instances from controlling the same state.
- **Graceful shutdown:** Send `SIGINT` / `SIGTERM`; `AgentRuntime.stop()` awaits any in-flight cycle, releases the `.lock` file, and closes the HTTP server cleanly.

---

## 4. Kill Switch, Backup & Incident Response

### Emergency Halt (Kill Switch)
```bash
curl -X POST http://127.0.0.1:8787/agent/kill \
  -H "Authorization: Bearer $AGENT_API_TOKEN"
```
- Immediately stops the runtime, sets `killSwitch = true` and `paused = true`, and **persists** both atomically to disk.
- Restarting the process **preserves** `killSwitch = true`. `POST /agent/resume` and `POST /agent/start` both return `409 KILL_SWITCH_ACTIVE`.

### Uncertain Pending Transaction Recovery
1. If an RPC timeout occurs mid-broadcast, the tx is persisted as `UNCERTAIN_TIMEOUT` and blocks all new entries (`no_pending_tx`).
2. `TransactionReconciler` automatically verifies receipt status and signer nonce (`latestNonce > tx.nonce` → `REPLACED`) on the next cycle.
3. If still uncertain, verify the signer's nonce and tx hash on Blockscout (`https://explorer.hsk.xyz`), then explicitly reconcile:
```bash
curl -X POST http://127.0.0.1:8787/agent/reconcile \
  -H "Authorization: Bearer $AGENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pendingTxId":"<id>","resolution":"CONFIRMED_FAILED"}'
```

### State Backup & Corruption Recovery
- Every `PositionStore.save()` writes to `<state>.tmp`, copies existing `<state>` to `<state>.bak`, and atomically renames `.tmp` → `<state>`.
- If `<state>` is corrupted on startup, the agent **fails closed** (`CORRUPTED_STATE`, `GET /ready` returns `503`, all entries blocked). Restore `<state>.bak` only after verifying balances and nonces on-chain.

### Policy Rollback
```bash
curl http://127.0.0.1:8787/agent/policy/history
curl -X POST http://127.0.0.1:8787/agent/policy/rollback \
  -H "Authorization: Bearer $AGENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"version":1}'
```

---

## 5. Pre-Deployment Checklist & Post-Deployment Smoke Tests

### Pre-Deployment
- [ ] `cd agent && npm run typecheck && npm test && npm run test:fork` — all passing.
- [ ] `cd web && npm run build && npm test` — all passing.
- [ ] `forge test --match-path contracts/test/MainnetFork.t.sol --fork-url https://mainnet.hsk.xyz` — 3/3 passing.
- [ ] All signer addresses verified distinct; deployer funded (`~15 HSK` on Chain 177).
- [ ] `AGENT_API_TOKEN` rotated and `127.0.0.1` binding verified.

### Post-Deployment Smoke Tests (Read-Only)
```bash
# Verify deployed contract bytecode & protocolFeeBps
cast call $TRANCHE_COMMITMENT_MANAGER "protocolFeeBps()(uint16)" --rpc-url $AGENT_RPC_URL
# Verify live HSKSwap V3 TWAP via OraclePriceAdapter
cast call $TRANCHE_ORACLE_ADAPTER "getPriceX36(address,address)((uint256,uint256,bool))" \
  0xB210D2120d57b758EE163cFfb43e73728c471Cf1 0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029 \
  --rpc-url $AGENT_RPC_URL
# Verify agent dry-run health & readiness
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/ready
```
