# Tranche — Demonstration & Verification Runbook

This runbook provides exact, deterministic commands to reproduce every Tranche demonstration and verification suite locally (zero mainnet deployments, zero real funds moved).

---

## 1. Prerequisites

- **Foundry** (`forge`, `cast`, `anvil` — verified with `1.7.1`)
- **Node.js** (verified with `v24.12.0`) & `npm`
- Contracts compiled into `out/`:
  ```powershell
  forge build
  ```

---

## 2. Interactive 6-Step Web Demo (`demo/`)

### Start the Demo Server
```powershell
cd c:\Users\USER\Desktop\Tranche\demo
npm start
```
- Starts a zero-dependency Node HTTP server on `http://localhost:3177` (override via `$env:PORT`) backed by an isolated local `anvil` instance deploying the compiled Tranche contracts from `out/`.
- Press `Ctrl+C` to cleanly stop both the HTTP server and its isolated `anvil` child process.

### Demo Walkthrough (UI or `curl` / HTTP API)
Open `http://localhost:3177` in a browser, click **Run Complete 6-Step Journey** (or click Steps 1–6 individually):

1. **Step 1 — LP Supplies Inventory & Creates Offer (`POST /api/step/1`)**
   - Attests LP via `HSPComplianceHook` (`LOCAL_EIP712_COMPLIANCE`), deposits `10,000 WHSK` into `LiquidityVault`, and creates Offer `#1` (`FIXED` at `0.080808 USDT/WHSK`, or `FLOATING` with `SignedPullOracle` + `25 bps` spread).
   - Expected evidence: 3 real tx hashes (`submitAttestation`, `deposit`, `createOffer`), `offerBalance(1) == 10,000 WHSK`.
2. **Step 2 — Trader / Agent Discovers Offers (`POST /api/step/2`)**
   - Queries `discoverOffers()` and `quoteReservation(1, 1000 WHSK, 3600s)`, returning capacity, pricing mode, expiry, and upfront premium.
3. **Step 3 — Trader Reserves Capacity & Receives Ticket (`POST /api/step/3`)**
   - Attests Trader 1, calls `reserve(...)` for `1,000 WHSK`, mints ERC-721 `ExecutionTicket #1` to Trader 1, and shifts `1,000 WHSK` from `offerBalance` to `ticketReserved`.
4. **Step 4 — Ticket Transferred (`POST /api/step/4`)**
   - Attests Trader 2 and calls `transferFrom(trader1, trader2, 1)`.
   - Expected evidence: `ExecutionTicket.ownerOf(1) == trader2`.
5. **Step 5 — Ticket Exercised with Partial Fill (`POST /api/step/5`)**
   - Trader 2 exercises `60%` (`600 WHSK`) of Ticket `#1`.
   - Expected evidence: `600 WHSK` delivered to Trader 2, `USDT` payment split into `lpPendingProceeds` + `protocolFees`, `remainingAmount == 400 WHSK`, and an `HSPSettlementReceipt` generated from the EVM tx receipt.
6. **Step 6 — Expiry & Inventory Reclaim (`POST /api/step/6`)**
   - Advances Anvil time past `expiresAt` (`evm_increaseTime` + `evm_mine`), keeper calls `reclaimExpired(1)` (burning Ticket `#1` and returning `400 WHSK` to Offer `#1`), LP claims earned `USDT` proceeds (`claimProceeds`), and `INV-1` Physical Vault Solvency asserts `true`.

---

## 3. Deterministic Execution Agent Demo (`agent/`)

Run the reproducible CLI agent demonstration (spawns an ephemeral `anvil`, evaluates 4 competing/ineligible offers, picks the cheapest eligible offer, reserves, executes a 60% partial fill, demonstrates `TicketExpired` error handling, and reclaims remaining inventory):

```powershell
cd c:\Users\USER\Desktop\Tranche\agent
npm run demo
```

Expected console sections:
- `Offer Evaluations` (Offer `#2` `FLOATING` selected over Offer `#1` `FIXED`; Offer `#3` rejected for `InsufficientOfferBalance`; Offer `#4` rejected for `OfferExpired`).
- `Reservation` (`ticketId: 1`, real `0x...` txHash).
- `Partial Exercise (600 WHSK)` (`grossPayment: 48.048000 USDT`, `remainingAmount: 400 WHSK`).
- `Expected Expiry Failure & Recovery` (`CommitmentManager.TicketExpired` caught & decoded -> `reclaimExpired(1)` succeeds -> Offer `#2` capacity restored to `4,400 WHSK`).

---

## 4. SDK Standalone Example (`sdk/`)

```powershell
cd c:\Users\USER\Desktop\Tranche\sdk
npm run example
```

---

## 5. Full Regression Verification Commands

Run all 6 verification commands from `c:\Users\USER\Desktop\Tranche`:

```powershell
# 1. Foundry local unit, adversarial (13 vectors), and stateful invariant suites (25 tests)
forge test --no-match-contract HashKeyForkPrototypeTest -vv

# 2. Foundry HashKey Chain mainnet-fork mechanical prototype at block 30583147 (1 test)
forge test --match-contract HashKeyForkPrototypeTest --fork-url https://mainnet.hsk.xyz --fork-block-number 30583147 -vv

# 3. SDK typecheck + integration tests (2 tests)
cd sdk; npx tsc --noEmit; npm test; cd ..

# 4. HSP Adapter typecheck + integration tests (5 tests)
cd hsp; npx tsc --noEmit; npm test; cd ..

# 5. Agent typecheck + integration tests (3 tests)
cd agent; npx tsc --noEmit; npm test; cd ..

# 6. Demo Backend + UI typecheck + HTTP end-to-end integration tests (3 tests)
cd demo; npx tsc --noEmit; npm test; cd ..
```
