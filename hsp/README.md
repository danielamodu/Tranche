# `@tranche/hsp-adapter`

Out-of-band HashKey Settlement Platform / Protocol (HSP) compliance attestation, pre-trade mandate, and post-trade settlement receipt adapter for **Tranche**.

## Architecture & Epistemic Boundaries

- **`LOCAL_EIP712_COMPLIANCE` (`LOCAL_ADAPTER`):**
  - Signs EIP-712 `ComplianceAttestation(address subject,uint256 nonce,uint256 expiry)` payloads matching `HSPComplianceHook.sol` (domain `"ProtocolHSPCompliance"`, version `"1"`).
  - Submits attestations via `HSPComplianceHook.submitAttestation(...)` and checks `isCompliant(subject)`.
  - Issues deterministic off-chain `HSPMandate` envelopes pre-trade and `HSPSettlementReceipt` proofs post-trade bound to real EVM transaction hashes and `TicketExercised` logs.
- **`LIVE_HSP_CAAS` (`BLOCKED` without partner onboarding):**
  - Requires configured `apiBaseUrl`, `apiKey`, `apiSecret`, and a live `facilitatorUrl` provisioned through HashKey institutional KYC/KYB onboarding and IP/wallet whitelisting.
  - Explicitly throws `HSP_LIVE_UNAVAILABLE` with remediation instructions if credentials or a live facilitator are absent — never fabricates a live HSP settlement success.
- **Non-Lockup Liveness (`INV-8`):**
  - HSP hooks are strictly out-of-band / opt-in on `createOffer`, `reserve`, secondary `transfer`/`splitTicket`, and gated `exercise`.
  - LP exit and recovery paths (`cancelOffer`, `decreaseOffer`, `withdrawFree`, `claimProceeds`, `reclaimExpired`) never call `HSPComplianceHook` or any external HSP endpoint.

## Scripts

```bash
npm install
npm run typecheck
npm test
```
