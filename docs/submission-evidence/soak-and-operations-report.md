# Chain 177 Soak, Hosted API Security & Chain 133 Testnet Readiness Report

**Machine-Readable Soak Snapshot:** [raw/soak-snapshot/ec2-soak-live-snapshot.json](./raw/soak-snapshot/ec2-soak-live-snapshot.json)  
**Host:** AWS EC2 `i-00d8f8645b94cfbed` (`t3.micro`, Ubuntu `24.04.5 LTS`, `eu-north-1`, Elastic IP `13.60.129.92`)

---

## 1. Live Chain 177 Read-Only Soak Status (`tranche-soak.service`)

> **Status:** `RUNNING` — **24-hour soak is actively accumulating evidence and has NOT yet completed.**

- **Session ID:** `soak-2026-11-26T16-43-03-222Z-20555`
- **Started At:** `2026-11-26T16:43:03.222Z`
- **Snapshot Captured At:** `2026-11-26T19:47:24.051Z`
- **Accumulated Healthy Observation Time:** **`10,939s` (~3h 02m at metric #73; ~3h 04m at cycle 738)**
- **Process Restarts:** `0` (`MainPID=20527`, uninterrupted since launch)
- **Observation Cycles:** **`738 / 738` successful** (`0` failed, `0` missed, `rpcSuccessRate: 1.0`)
- **RPC Latency:** `avg: 859.98 ms`, `max: 1420 ms`, `last: 805 ms`, `latestSnapshotAgeSec: 1`
- **Decision Distribution:** `READ_ONLY_SWAP_HSKSWAP: 185`, `SKIPPED_DUPLICATE: 553` (expected 3-of-4 suppression per 60s cooldown bucket at 15s polling; zero duplicate actionable decisions)
- **Observed Market Regimes (actual Chain 177 data only):** `{ CALM: 738, TRENDING: 0, VOLATILE: 0, DISLOCATED: 0 }` — `TRENDING`, `VOLATILE`, and `DISLOCATED` have not occurred on Chain 177 `WHSK/USDT` during this window and are not fabricated.
- **Anomalous Snapshots / Errors / Retries / Recoveries:** `0`
- **Transaction Broadcast Count:** **`0`** (verified across all 738 records in `decisions.jsonl` and all 73 records in `metrics.jsonl`)
- **Evidence Location on EC2:** `/var/lib/tranche-soak/soak-2026-11-26T16-43-03-222Z-20555/`

### Safe 48–72h Extension Procedure (After 24h Completes)
When `session.json` transitions to `status: "COMPLETED"` and `tranche-soak.service` exits cleanly with code `0`, preserve `/var/lib/tranche-soak/soak-2026-11-26T16-43-03-222Z-20555` intact. To launch a separate 48h or 72h session without overlapping runtimes or deleting prior evidence:
1. Confirm `systemctl is-active tranche-soak.service` is `inactive` and `/var/lib/tranche-soak/soak-state.json.lock` is absent.
2. Update `AGENT_SOAK_DURATION_HOURS=48` (or `72`) in `/etc/tranche-soak/soak.env` and `--hours 48` (or `72`) in `/etc/systemd/system/tranche-soak.service`.
3. Run `sudo systemctl daemon-reload && sudo systemctl start tranche-soak.service` — a fresh `soak-<timestamp>-<pid>` directory is created while all 24h evidence remains preserved.

---

## 2. Hosted Agent API & Security Verification (`tranche-api.service`)

- **Service:** `tranche-api.service` (`active (running)`, dedicated unprivileged user `tranche-api`, supplementary group `tranche-soak` for read-only `/var/lib/tranche-soak` visibility)
- **Bind Address:** **`127.0.0.1:8789`** *(Note: `127.0.0.1:8787` is occupied by co-hosted `plumb.service` and `127.0.0.1:8788` by `tranche-soak.service`; neither co-hosted service was interrupted.)*
- **Caddy Reverse Proxy:** Configured in `/etc/caddy/Caddyfile` (`api.tranche.space -> reverse_proxy 127.0.0.1:8789`), validated (`Valid configuration`), and reloaded gracefully without disrupting `primary.service` or `plumb.service`.
- **Mode & Signer Isolation:** `AGENT_DATA_SOURCE=chain177_read_only`, `AGENT_EXECUTION_MODE=read_only`, `chainId: 177`, `quotesAreReal: true`, zero private keys or `WalletClient` loaded, separate state file `/var/lib/tranche-api/api-state.json` (zero lock conflict with soak).
- **Verified Security Checks (on EC2 loopback `127.0.0.1:8789`):**
  - `GET /health` → `200` (`ok: true`, `mode: "read_only"`, `chainId: 177`, `quotesAreReal: true`)
  - `GET /ready` → `200` (`ready: true`)
  - `Origin: https://app.tranche.space` → `Access-Control-Allow-Origin: https://app.tranche.space`
  - `Origin: https://evil.example` → **`403 CORS_ORIGIN_FORBIDDEN`**
  - Unauthenticated `POST /agent/pause` → **`401 UNAUTHORIZED`**
  - Bearer-authenticated `POST /agent/policy/propose` → **`200 OK`**
  - `GET /agent/soak` → **`200 OK`** (reads live soak telemetry from `/var/lib/tranche-soak` read-only)

- **External HTTPS & Frontend Connectivity (LIVE & EXTERNALLY VERIFIED):**
  - DNS: `api.tranche.space` → `A 13.60.129.92`
  - TLS: Let's Encrypt certificate obtained and served by Caddy (`acme-v02.api.letsencrypt.org-directory`)
  - `GET https://api.tranche.space/health` (`Origin: https://app.tranche.space`) → `200 OK`, `Access-Control-Allow-Origin: https://app.tranche.space`, `mode: "read_only"`, `chainId: 177`, `quotesAreReal: true`
  - `Origin: https://evil.example` → **`403`**
  - Unauthenticated `POST https://api.tranche.space/agent/pause` → **`401`**
  - Deployed `https://app.tranche.space` JS bundle verified to contain `https://api.tranche.space` (`foundApiUrl: true`) with zero `AGENT_API_TOKEN` exposure (`foundToken: false`).

---

## 3. Chain 133 Testnet Readiness (`tranche-testnet-observer.service`)

- **Live Chain 133 RPC Verified:** `https://testnet.hsk.xyz` (`chainId: 133`, live block `36262970`).
- **Live Tranche Contracts Verified on Chain 133 (`deployments/hashkey-testnet.json`):**
  - `CommitmentManager`: `0xBF79786d5B86D10616E31A40a867eA27bbbbFA3c` (`18,974 bytes`)
  - `LiquidityVault`: `0xC2E5d68cd030677CB8f851b66ee370B304504cE1` (`7,452 bytes`)
  - `ExecutionTicket`: `0x05d966961AE75505f15883ddD2715e1D7c1752c1` (`8,383 bytes`)
  - `ExecutionRouter`: `0x471221ea2cAEFD3f17f5c55dE74B3e2876E14aAb` (`4,115 bytes`)
  - `OraclePriceAdapter`: `0x83E27a6B5e038D75A5ee76195668c2ad09c37FCA` (`3,566 bytes`)
  - `SignedPullOracle`: `0xADA5C8289Ca509723302Aad31B6EE5d13e013104` (`5,887 bytes`)
- **HSKSwap V3 Liquidity Finding on Chain 133:** Canonical HSKSwap V3 `Factory`, `QuoterV2`, and `SwapRouter02` have **`0 bytes`** on Chain 133. Dual-venue HSKSwap AMM routing is therefore **not supported on Chain 133**; only Tranche protocol offer discovery & lifecycle can execute on Chain 133.
- **Persistent EC2 Testnet Service:** `tranche-testnet-observer.service` is `active (running)` on `127.0.0.1:8790` (`mode: read_only`, **execution disabled**, zero signer loaded), connected to live Chain 133 contracts and honestly reporting `HSKSwapV3-Unavailable-Chain133` (`liquidity: 0`).
- **Signer Isolation Architecture:** As documented in [../OPERATIONAL_RUNBOOK.md](../OPERATIONAL_RUNBOOK.md), Governance (`3/5` Safe), Guardian (`2/3` Safe), Treasury (`2/3` Safe), and Oracle (`2/3` EIP-712 signers) remain strictly offline/isolated and are never loaded into any agent process.

### Proposed Optional Chain 133 Tranche-Only Lifecycle Test (Awaiting Developer Approval)
No public testnet transactions were broadcast. If you wish to authorize a bounded live Chain 133 Tranche-only lifecycle proof (reserve → exercise → reclaim):
- **Required Signers:** Dedicated testnet LP EOA + dedicated testnet Trader EOA (zero admin/governance/oracle rights).
- **Required Assets & Estimated Cost:** `~0.05 HSK` gas per EOA on Chain 133 + testnet `tWETH` (`0xaEa8...10Ba`) and `tUSDT` (`0x7099...8F27`) minted/transferred to LP & Trader.
- **Scope:** 1 bounded `createOffer` + 1 `reserve` + 1 `exercise` on `CommitmentManager` (`0xBF79...FA3c`), recording Blockscout tx hashes under `docs/submission-evidence/raw/`.
