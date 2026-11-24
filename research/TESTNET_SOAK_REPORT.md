# Tranche — Phase 3: 72-Hour Testnet Soak & Keeper Operations Report

> **Status:** **`LIVE 72-HOUR SOAK NOT YET STARTED — BLOCKED ON TESTNET HSK FUNDING`**  
> **Branch:** `testnet/phase3-validation` (remediation base: `76a85882d04af446e3e82d8421641a3769467c6e`)  
> **Tooling Location:** [`scripts/testnet-ops/`](file:///c:/Users/USER/Desktop/Tranche/scripts/testnet-ops/package.json)

---

## 1. Current Soak Status (Honest Assessment)

No live HashKey Chain Testnet (`133`) 72-hour continuous soak has occurred yet because:
1. No funded testnet deployer EOA or keeper/oracle private keys exist in the environment ([`INC-001`](file:///c:/Users/USER/Desktop/Tranche/research/INCIDENT_LOG.md)).
2. Only a single free public RPC (`https://testnet.hsk.xyz`) responds on Chain 133; backup public endpoints returned `NXDOMAIN` or HTTP 400 paid-plan gates ([`INC-002`](file:///c:/Users/USER/Desktop/Tranche/research/INCIDENT_LOG.md)).

The full soak, keeper, M-of-N oracle signing, and multi-RPC failover harness has been implemented and verified locally (`@tranche/testnet-ops`: `tsc --noEmit` + `2/2` integration tests passing).

---

## 2. Implemented Operational Harness (`scripts/testnet-ops/`)

| Module | Purpose | Verification Status |
| --- | --- | --- |
| [`src/rpc-failover.ts`](file:///c:/Users/USER/Desktop/Tranche/scripts/testnet-ops/src/rpc-failover.ts) | Multi-RPC EIP-1193 `FailoverRpcPool` with per-endpoint request timeout (`8s`), HTTP `429`/`5xx`/RPC error tracking, `30s` cooldown, automatic failover, and health recovery telemetry (`viem` custom transport) | **Verified** via simulated `503`/`429` outages + live unreachable-endpoint Anvil fallback (`2/2` tests) |
| [`src/oracle-quorum.ts`](file:///c:/Users/USER/Desktop/Tranche/scripts/testnet-ops/src/oracle-quorum.ts) | M-of-N `ProtocolSignedPullOracle` (`v2`) EIP-712 `PriceReport` collector; sorts signer addresses strictly ascending, runs preflight checks for `threshold`, monotonic `reportTimestamp`, and per-pair `maxJumpBps` before `updatePrice` | **Verified** against live compiled `SignedPullOracle` (`2-of-3` out-of-order key sorting + `1-of-3` preflight rejection) |
| [`src/soak-runner.ts`](file:///c:/Users/USER/Desktop/Tranche/scripts/testnet-ops/src/soak-runner.ts) | Continuous 72h monitoring + keeper loop: verifies `INV-1` physical solvency across all tracked tokens (`vaultBalance >= totalLpFree + totalOfferAvailable + totalReserved + totalPendingProceeds + protocolFees`), polls oracle freshness & quorum, executes `reclaimExpiredBatchBestEffort` in `<=35`-ID batches, logs JSONL telemetry, and appends automated alerts to `INCIDENT_LOG.md` | **Verified** via 2-cycle local Anvil soak run reclaiming an expired ticket cleanly (`invariantsPassed: true`, `reclaimedCount: 1`, `TicketStatus.RECLAIMED`) |

---

## 3. Verification Output (`@tranche/testnet-ops`)

```text
> @tranche/testnet-ops@0.1.0 typecheck
> tsc --noEmit

> @tranche/testnet-ops@0.1.0 test
> node --import tsx --test test/ops.test.ts

✔ 1. FailoverRpcPool switches on HTTP 503/429 outages and recovers after cooldown (3.8562ms)
✔ 2. M-of-N oracle quorum signing (out-of-order keys) & 2-cycle soak runner with keeper reclaim (5580.9695ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

---

## 4. Guardrails Enforced Before Starting Live 72h Soak

`scripts/testnet-ops/src/soak-runner.ts` explicitly inspects `deployments/hashkey-testnet.json` and refuses to run in CLI mode unless `"deploymentStatus": "LIVE_DEPLOYED"` is present, preventing any accidental launch against dry-run placeholder addresses.
