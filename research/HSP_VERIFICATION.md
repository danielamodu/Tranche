# HSP (HashKey Settlement Platform / Protocol) Verification Report

**Project:** Tranche  
**Target Network:** HashKey Chain Mainnet (`chainId: 177`, RPC: `https://mainnet.hsk.xyz`)  
**Scope:** Workstream 3 — External verification of HashKey Settlement Platform / Protocol (HSP) interfaces, AP2/mandate/receipt architecture, CaaS gating boundaries, and strict separation from Tranche's atomic core (`INV-8`).

---

## 1. Executive Summary & Epistemic Classification

| Component / Claim | Status | Summary |
| --- | --- | --- |
| **Canonical public HSP mainnet singleton on chain `177`** | `[NOT_FOUND]` / `BLOCKED` | No public permissionless HSP coordinator or compliance registry smart contract address exists on HashKey Chain mainnet (`177`). |
| **HSP off-chain architecture & mandate/receipt model** | `VERIFIED` | Verified via HashKey official docs/announcements and public ecosystem implementations (`AP2`, `0xultravioleta/agentsettle-hsk`, `sumplus-real/sumplus-hsk-mandate`, `GearTechnologies/HashPoint`, `swiftbotlabs/hsk-meter`). HSP operates as an off-chain CaaS / facilitator rail paired with EIP-712 signed mandates, verifiable settlement receipts, and application-owned on-chain escrow/compliance adapters. |
| **Live HashKey CaaS / HSP API access** | `BLOCKED` | Production/sandbox CaaS & HSP settlement APIs require institutional KYC/KYB onboarding, API key provisioning (`X-CH-APIKEY` + HMAC-SHA256 or ES256K JWT signing), and explicit IP & deposit/withdrawal wallet address whitelisting. No institutional credentials exist in this environment. |
| **Tranche out-of-band compliance & receipt adapter (`hsp/`)** | `LOCAL_ADAPTER` | `HSPComplianceHook.sol` + `TrancheHSPAdapter` (`LOCAL_EIP712_COMPLIANCE` mode) implement verifiable EIP-712 `ComplianceAttestation` verification on-chain, pre-trade `HSPMandate` issuance, and deterministic `HSPSettlementReceipt` proofs bound to real EVM tx hashes/receipts, while `LIVE_HSP_CAAS` mode fails explicitly with `HSP_LIVE_UNAVAILABLE` when partner credentials/facilitator are absent. |

---

## 2. Verified HSP Architecture (External Research)

Based on official HashKey Group / HashKey Chain documentation (`docs.hsk.xyz`, HashKey CaaS & Exchange REST API references), Google AP2 (Agent Payments Protocol) collaboration materials, and open-source HashKey Chain ecosystem repositories:

1. **Off-Chain CaaS & Institutional Compliance Layer:**
   - HashKey CaaS (Crypto-as-a-Service) and HashKey's regulated settlement rails expose authenticated **REST, WebSocket, and FIX** endpoints rather than a single permissionless on-chain registry.
   - Authentication uses API keys (`X-CH-APIKEY`) paired with **HMAC-SHA256** request signatures (`totalParams` + timestamp/nonce) for Exchange/CaaS REST calls, and **ES256K** (`secp256k1`) asymmetric signatures / EIP-712 structured payloads for Web3-native vouchers and agent mandates.
   - Regulatory controls enforce **KYC/KYB onboarding**, **client IP whitelisting**, and **deposit/withdrawal wallet address whitelisting**.

2. **EIP-712 Mandates & Facilitator / Receipt Flow:**
   - **AP2 & HSP Mandates:** Agentic and institutional payment flows (`sumplus-real/sumplus-hsk-mandate`, `0xultravioleta/agentsettle-hsk`, Google AP2 + HSP) express spending and settlement permissions as signed structured mandates (authorizing subject/payer, asset, amount/budget limits, expiry, and nonce) using **EIP-712** typed data (`chainId` + `verifyingContract` domain separation) or EIP-3009 authorizations.
   - **Facilitator & Receipt Recording:** An off-chain facilitator or coordinator validates the mandate and compliance status, executes/relays settlement in standard ERC-20 assets (predominantly `USDT` `0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029` on chain `177`), and emits a verifiable **settlement receipt** (e.g., `AgentSettleReceipts.recordReceipt(...)` or off-chain signed receipt envelope linked to the on-chain `txHash`, `blockNumber`, and settlement amounts).

3. **Application-Specific On-Chain Adapters (No Public Singleton):**
   - Ecosystem integrations on HashKey Chain (`0xultravioleta/agentsettle-hsk`, `sumplus-real/sumplus-hsk-mandate`, `GearTechnologies/HashPoint`, `swiftbotlabs/hsk-meter`) each deploy **app-owned contracts** (custom mandates, treasuries, escrow adapters, or receipt registries) instead of calling a universal HashKey-deployed mainnet singleton.

---

## 3. Classification: `VERIFIED` vs `BLOCKED` vs `LOCAL_ADAPTER`

### `VERIFIED`
- HashKey Chain Mainnet is an OP Stack L2 (`chainId: 177`, `https://mainnet.hsk.xyz`, 2.0s block cadence) with verified HSKSwap V3 pools and `USDT` (`0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029`, 6 decimals, non-proxy, no blacklist/pause/FoT).
- HSP uses off-chain CaaS REST APIs + EIP-712 mandates + facilitator/receipt attestation + app-specific on-chain adapters.
- `HSPComplianceHook.sol` in Tranche implements EIP-712 domain `("ProtocolHSPCompliance", "1")` with `ATTESTATION_TYPEHASH = keccak256("ComplianceAttestation(address subject,uint256 nonce,uint256 expiry)")`, monotonic `nonces[subject]`, `validUntil[subject]`, and admin `setApproved` / `revoke`.

### `BLOCKED`
- **Live HashKey CaaS / HSP API calls (`LIVE_HSP_CAAS`):** Blocked without institutional KYC/KYB partner onboarding, API credentials (`apiBaseUrl`, `apiKey`, `apiSecret`), configured live facilitator endpoint, and IP/wallet whitelisting.
- **Permissionless on-chain HSP lookup on chain `177`:** Not possible because no canonical public HSP compliance/settlement contract exists on HashKey Chain mainnet.
- **Policy:** `TrancheHSPAdapter` in `LIVE_HSP_CAAS` mode MUST check for credentials/facilitator configuration and throw `HSP_LIVE_UNAVAILABLE` with explicit remediation guidance. It NEVER mocks or fabricates a live HSP settlement response.

### `LOCAL_ADAPTER`
- `TrancheHSPAdapter` in `LOCAL_EIP712_COMPLIANCE` mode provides an honest, self-contained local adapter:
  - Signs EIP-712 `ComplianceAttestation` messages matching `HSPComplianceHook.sol`.
  - Submits attestations on-chain via `HSPComplianceHook.submitAttestation(subject, nonce, expiry, signature)`.
  - Queries `isCompliant(subject)` before gated protocol actions.
  - Issues deterministic off-chain `HSPMandate` envelopes pre-trade and `HSPSettlementReceipt` proofs post-trade anchored to real EVM `txHash`, `blockNumber`, and decoded protocol events/state.

---

## 4. Non-Lockup Separation Architecture (`INV-8`)

Tranche strictly enforces **Non-Lockup Liveness (`INV-8`)**: HSP compliance and receipt generation are **out-of-band / opt-in pre-trade**, and **never** gate custody exits, LP proceeds, or expired collateral recovery.

| Tranche Operation | Contract | Invokes `IComplianceHook` (`HSPComplianceHook`)? | Invokes Off-Chain HSP API? | Impact if HSP Revokes Subject or Goes Offline |
| --- | --- | --- | --- | --- |
| **Pre-trade Attestation** | `HSPComplianceHook.submitAttestation` | N/A (writes `validUntil` & increments `nonce`) | Out-of-band / Optional (`LOCAL_ADAPTER`) | Only affects future gated `createOffer`, `reserve`, `transfer`, `exercise`. |
| **Create Gated Offer** | `CommitmentManager.createOffer` | Yes (`beforeCreateOffer(lp, ...)`) if `complianceHook != address(0)` | No (uses on-chain `validUntil` + optional off-chain `HSPMandate` log) | Unattested/revoked LP cannot create **new** hook-gated offers; permissionless offers (`address(0)`) unaffected. |
| **Reserve Ticket** | `CommitmentManager.reserve` | Yes (`beforeReserve(offerId, taker, recipient, amount)`) | No | Unattested/revoked taker or recipient cannot reserve on gated offers. |
| **Secondary Transfer / Split** | `ExecutionTicket._update` / `CommitmentManager.splitTicket` | Yes (`beforeTransfer(ticketId, from, to)`) | No | Unattested/revoked sender or recipient cannot transfer/split gated tickets. |
| **Exercise Ticket** | `CommitmentManager.exercise` | Yes (`beforeExercise(ticketId, exerciser, receiver)`) if `t.complianceHook != address(0)` | **NEVER** (no external HTTP/RPC HSP call inside atomic `exercise()`) | Only on-chain view check runs; off-chain `HSPSettlementReceipt` is logged **post-settlement** from tx receipt. |
| **Cancel Offer** | `CommitmentManager.cancelOffer` | **NEVER** | **NEVER** | **Always succeeds** even if LP was revoked (`revoke(lp)`). |
| **Decrease Offer** | `CommitmentManager.decreaseOffer` | **NEVER** | **NEVER** | **Always succeeds** even if LP was revoked. |
| **Withdraw Free Collateral** | `LiquidityVault.withdrawFree` | **NEVER** | **NEVER** | **Always succeeds** (`LiquidityVault` has zero hook references). |
| **Claim Proceeds** | `LiquidityVault.claimProceeds` | **NEVER** | **NEVER** | **Always succeeds** even if LP was revoked. |
| **Reclaim Expired Ticket** | `CommitmentManager.reclaimExpired` | **NEVER** | **NEVER** | **Always succeeds** permissionlessly after `expiresAt`, even if LP or Trader was revoked. |

### Key Guarantee
- `LiquidityVault.sol` has **zero** imports, storage slots, or external calls to `IComplianceHook` or any HSP adapter.
- Once an LP deposits collateral or earns premiums/exercise proceeds, **no HSP revocation, signer rotation, or CaaS outage can freeze LP funds** (`cancelOffer` -> `withdrawFree`, `claimProceeds`, `reclaimExpired`).
- Similarly, Tranche's atomic `exercise()` executes purely on-chain against ERC-20 balances and `ExecutionTicket` ownership; `HSPMandate` and `HSPSettlementReceipt` exist strictly as out-of-band coordination and auditability artifacts in the TypeScript adapter layer.
