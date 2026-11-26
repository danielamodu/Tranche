# Tranche Agent — Protocol-Native Architecture & Deployment Audit

**Phase 1 Deliverable**

---

## 1. Ground-Truth Deployment State (Chain 133 vs. Chain 177)

| Network | Chain ID | Tranche Protocol Contracts | Canonical Assets & Spot DEX | Execution Status |
| --- | ---: | --- | --- | --- |
| **HashKey Chain Testnet** | `133` | **LIVE DEPLOYED (15 contracts + 3 Safe v1.4.1 proxies)** (`deployments/hashkey-testnet.json`). `LiquidityVault`: `0xC2E5...4cE1`, `CommitmentManager`: `0xBF79...FA3c`, `ExecutionTicket`: `0x05d9...52c1`, `ExecutionRouter`: `0x4712...4aAb`, `TimelockController`: `0x1bD3...eE31`. Live exercise proof tx: `0x8f98a0f7...`. | `tUSDT`, `tWETH`, `tWBTC`, canonical `WHSK` (`0x4200...0006`). No deployed HSKSwap V3 liquidity. | Live on testnet (`app.tranche.space` defaults to Chain 133). |
| **HashKey Chain Mainnet** | `177` | **NOT DEPLOYED YET** (`isLive: false`, all protocol addresses `0x0000...0000`). Fork-verified via `DeployMainnet.s.sol` & `MainnetFork.t.sol` (`16,023,889 gas`) only — **never confused with live mainnet deployment**. | **LIVE**: Canonical `WHSK`, `USDT`, `WETH`, `WBTC`, `Multicall3`, `Safe v1.4.1`, and live `HSKSwap V3` pools (`WHSK/USDT`, `WETH/USDT`, `WBTC/USDT`) + `QuoterV2` + `SwapRouter02`. | EC2 `tranche-api.service` runs strictly `chain177_read_only` (`mode: "read_only"`, 0 broadcasts, no signer). |

---

## 2. Deployed Contract ABI Truth (`CommitmentManager.sol` & `@tranche/sdk`)

Verified directly against `contracts/src/CommitmentManager.sol` and `sdk/src/client.ts`:
- **Autonomous Read Capabilities:** `nextOfferId()`, `getOffer(uint64)`, `LiquidityVault.offerBalance(uint64)`, `nextTicketId()`, `getTicket(uint256)`, `ExecutionTicket.ownerOf(uint256)`, `quoteReservation(uint64,uint256,uint32)`, `quoteExercise(uint256,uint256)`, `LiquidityVault` bucket getters, and `publicClient.simulateContract(...)`.
- **Approval-Required Trader Writes:**
  - `CommitmentManager.reserve(uint64 offerId, uint256 amount, uint32 duration, uint256 maxPremium, address recipient)` (requires ERC-20 payment token approval to `LiquidityVault`).
  - `CommitmentManager.exercise(uint256 ticketId, uint256 fillAmount, uint256 maxPayment, address receiver)` (requires ERC-20 payment token approval to `LiquidityVault`).
  - `CommitmentManager.reclaimExpired(uint256 ticketId)` (callable only once `block.timestamp >= ticket.expiresAt`).
- **Important ABI Boundary:** `CommitmentManager` does **not** expose a trader-side `cancelReservation()` for active unexpired tickets (reservation premiums are non-refundable; unexercised tickets expire cleanly and release capacity via `reclaimExpired(ticketId)`). `cancelOffer(uint64)`, `deposit`, `withdrawFree`, and `claimProceeds` are LP-only administrative operations and remain strictly **outside** the trading agent's permission scope.

---

## 3. Reusable vs. Newly Implemented Components

| Area | Existing & Reused | Newly Implemented |
| --- | --- | --- |
| **SDK & On-Chain Reads** | `@tranche/sdk` (`TrancheClient`, `ABIS`), `TrancheExecutionAgent` (`agent/src/agent.ts`), `HskSwapVenue` (`agent/src/hskswap.ts`) | `TrancheProtocolActionLayer` (`agent/src/protocol-actions/layer.ts`): typed offer/ticket discovery, quoting, portfolio pre-check, `simulateContract` preflight, and post-tx on-chain state verification. |
| **Intelligence & Venue Selection** | `PortfolioIntelligenceEngine`, `AdaptiveStrategyEngine`, `VenueSelector`, `PositionLifecycleManager`, `RiskManager` | Integrated protocol action proposals into venue selection & evaluation; abstains (`NONE`) when neither venue satisfies policy. |
| **Permissions & Wallet Signing** | Browser EIP-1193 `WalletContext` (non-custodial), `AgentApiServer` Bearer auth, `TransactionReconciler`, `PositionStore` kill switch | `ProtocolApprovalManager` & `ProtocolApprovalStore` (`agent/src/protocol-actions/permissions.ts`): SHA-256 parameter-bound proposals, spending caps, expiry, replay protection, pending-tx gate, atomic restart persistence, zero unrestricted private-key access. |
| **Frontend Dashboard** | `AgentPage.tsx`, `AgentIntelligencePanel.tsx`, `TradePage.tsx`, `TicketsPage.tsx` | Dedicated **Protocol Activity & Approvals** experience (`ProtocolActivityPanel.tsx` + `/agent/protocol/*` authenticated API) distinguishing `PROPOSED`, `APPROVED`, `REJECTED`, `SUBMITTED`, `CONFIRMED`, `FAILED`, and `EXPIRED` with `LIVE / FORK / REPLAY / MOCK` badges. |
| **HSP Payments** | `agent/src/hsp-payments/` (mock-only, isolated) | **Unchanged & strictly isolated** — trading decisions can never initiate HSP payments. |
