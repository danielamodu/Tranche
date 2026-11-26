# HSP Payment Integration Status & Foundation Architecture

**Status:** Foundation Implemented (Mock Simulation Only — Live HSP MCP Disconnected Pending EC2 IP Allowlisting & Live Tool Discovery)

---

## 1. Architectural Isolation

The HSP payment orchestration layer lives in a dedicated, isolated module at `agent/src/hsp-payments/` and is completely decoupled from Tranche trading execution:

- **Zero coupling to trading execution:** `HspPaymentOrchestrator` does not import or interact with `TrancheAutonomousAgent`, `AgentRuntime`, `TrancheExecutionAgent`, `HskSwapVenue`, `MarketIntelligence`, `RiskManager`, or `PositionStore`.
- **Separate persistence:** Payment records are stored in their own atomic JSON state file (`HspPaymentStore`), independent of `PositionStore`.
- **Explicit evidence boundary:** Every orchestrator status summary, payment record, and audit entry carries `evidenceKind: "MOCK_SIMULATION" | "LIVE_HSP_MCP"` and `isMockEvidence: boolean`. Mock results can never be misrepresented as live HSP payment evidence.
- **No fabricated wire schemas:** No live HSP MCP tool names, authentication headers, JSON-RPC request schemas, or live response payloads have been invented. All provider contracts expose discovery-driven opaque `rawSchema?: unknown` and `rawProviderPayload?: unknown` extension points to be bound strictly after live MCP tool discovery.

---

## 2. Interface Contracts (`agent/src/hsp-payments/types.ts`)

| Capability | Interface / Method | Responsibility |
| --- | --- | --- |
| **MCP Transport / Provider** | `HspMcpTransportProvider` | Transport-agnostic boundary carrying `providerKind`, `evidenceKind`, and `schemaDiscovered`. |
| **Payment Tool Discovery** | `discoverPaymentTools(): Promise<HspPaymentToolDiscoveryResult>` | Dynamically discovers live MCP tools and schemas after allowlisting (returns `schemaDiscovered: false` in mock mode). |
| **Payment Preparation** | `preparePayment(input): Promise<HspPaymentPreparationOutcome>` | Validates balance/terms, returns `preparationId`, `expiresAt`, and `attributedMerchant` for merchant verification. |
| **Wallet Authorization** | `HspWalletAuthorizationProvider.requestAuthorization(req)` | Enforces `explicitUserConsent: true` and returns an opaque non-secret `authorizationRef` (never raw keys or signing secrets). |
| **Payment Submission** | `submitAuthorizedPayment(input): Promise<HspPaymentSubmissionOutcome>` | Dispatches an explicitly authorized, non-expired payment once per idempotency key. |
| **Payment Status Queries** | `queryPaymentStatus(input): Promise<HspPaymentStatusQueryOutcome>` | Polls settlement status for post-submission reconciliation and timeout recovery without re-submitting. |

---

## 3. Persistent 9-State Machine (`agent/src/hsp-payments/state-machine.ts`)

```text
CREATED ──► PREPARED ──► AUTHORIZED ──► SUBMITTED ──► PROCESSING ──► SAFE ──► FINALIZED
   │           │             │              │             │           │
   └───────────┴─────────────┴──────────────┴─────────────┴───────────┴──► FAILED
                                            │             │           │
                                            └─────────────┴───────────┴──► TIMEOUT ──► (PROCESSING | SAFE | FINALIZED | FAILED)
```

### Enforced Invariants
1. **Valid Transitions Only:** Every state change is gated by `assertValidTransition(from, to)`. `FINALIZED` and `FAILED` are strictly terminal.
2. **Idempotent Creation:** `createPayment()` deduplicates identical intents by `idempotencyKey` and rejects conflicting payloads for an existing key (`IDEMPOTENCY_KEY_CONFLICT`).
3. **Explicit User Authorization Gate:** `authorizePayment()` requires `explicitUserConsent === true` and rejects expired preparations (`PREPARATION_EXPIRED`). `submitPayment()` rejects any payment not in `AUTHORIZED` state with recorded explicit consent.
4. **Merchant Attribution Verification:** Provider-attributed merchant identifiers on preparation, submission, and status responses are compared against the requested merchant; mismatches fail closed with `MERCHANT_ATTRIBUTION_MISMATCH`.
5. **No Duplicate Payment on Timeout:** `SUBMITTED` is persisted to disk **before** calling the provider, and `submittedIdempotencyKeys` is monotonic. `TIMEOUT` can only transition forward via `refreshPaymentStatus()` (`PROCESSING | SAFE | FINALIZED | FAILED`) — never back to `AUTHORIZED` or `SUBMITTED`. Any repeat `submitPayment()` call throws `DUPLICATE_SUBMISSION_BLOCKED`.
6. **Unrecognized Status Safety:** Unknown provider status strings are logged in the audit trail and raise `UNRECOGNIZED_PAYMENT_STATUS` without corrupting state or triggering re-submission.

---

## 4. Persistence & Restart Recovery (`agent/src/hsp-payments/store.ts`)

- **Atomic Writes:** `HspPaymentStore` writes to a process-scoped temporary file and atomically renames over the target JSON file (`version: 1`).
- **Monotonic Submission Registry:** `submittedIdempotencyKeys` is persisted alongside payment records so duplicate submission protection survives process restarts.
- **Post-Restart Reconciliation:** Calling `orchestrator.recoverInProgressPayments()` reloads all records in `SUBMITTED | PROCESSING | SAFE | TIMEOUT` and reconciles them exclusively via `queryPaymentStatus()` — never re-submitting.

---

## 5. Authenticated HTTP API (`agent/src/server.ts`)

All `/hsp/payments*` routes require `Authorization: Bearer <token>` or `X-Agent-Token` authentication (for both reads and writes) and expose zero signing credentials or secrets:

| Method & Path | Purpose |
| --- | --- |
| `GET /hsp/payments/status` | Orchestrator status summary (`providerKind`, `evidenceKind`, `isMockEvidence`, `schemaDiscovered`, `liveMcpConnected: false`, counts by state). |
| `GET /hsp/payments` | Full payment history and summary. |
| `GET /hsp/payments/:paymentId` | Single payment record and audit trail. |
| `POST /hsp/payments` | Create idempotent payment intent (`CREATED`). |
| `POST /hsp/payments/:paymentId/prepare` | Run preparation & merchant attribution check (`PREPARED` or `FAILED`). |
| `POST /hsp/payments/:paymentId/authorize` | Record explicit user consent & wallet authorization (`AUTHORIZED` or `FAILED`). |
| `POST /hsp/payments/:paymentId/submit` | Submit authorized payment once (`SUBMITTED -> PROCESSING/SAFE/TIMEOUT/FINALIZED/FAILED`). |
| `POST /hsp/payments/:paymentId/refresh` | Poll provider status and reconcile (`TIMEOUT`/in-progress recovery). |
| `POST /hsp/payments/recover` | Recover all persisted post-submission in-progress payments after restart. |

---

## 6. Frontend Section (`web/src/pages/HspPaymentsPage.tsx`)

- Mounted as an independent route (`/payments`) under a dedicated **Payments -> HSP Payments** sidebar group in `AppShell.tsx`.
- Displays a clear **Mock Simulation Mode** banner distinguishing simulated records from live HSP evidence.
- Shows lifecycle status, merchant, payer, recipient, token, amount, transaction reference, and full lifecycle audit trail, with gated operator actions and zero browser-side signing credentials.

---

## 7. Verification & Mock Test Coverage (`agent/test/hsp-payments.test.ts`)

All 11 test suites cover:
1. Successful end-to-end lifecycle (`CREATED -> PREPARED -> AUTHORIZED -> SUBMITTED -> PROCESSING -> SAFE -> FINALIZED`)
2. Insufficient balance failure (`INSUFFICIENT_BALANCE`)
3. Expired preparation rejection (`PREPARATION_EXPIRED`)
4. Authorization rejection (missing explicit consent + wallet rejection)
5. Submission failure (`SUBMISSION_FAILED`)
6. Timeout and non-duplicating recovery (`TIMEOUT -> PROCESSING -> FINALIZED`, `submitCalls === 1`)
7. Duplicate submission prevention & idempotency key conflict protection
8. Process restart during an in-progress payment (`recoverInProgressPayments()` with `0` re-submissions)
9. Unrecognized payment status fail-safe handling (`UNRECOGNIZED_PAYMENT_STATUS`)
10. Incorrect merchant attribution rejection (`MERCHANT_ATTRIBUTION_MISMATCH`)
11. Authenticated HTTP API enforcement (`401` without Bearer token, zero leaked secrets)

---

## 8. Outstanding Live-Integration Dependencies (Deliberately Deferred)

The following items are intentionally deferred until HSP Operations completes EC2 IP allowlisting:
1. **Live HSP MCP Endpoint Connection & Authentication:** Transport configuration, auth header format, and token/credential management after allowlisting is active.
2. **Live MCP Tool Discovery:** Inspecting actual tool names, input schemas, and response payloads from the live HSP MCP server to implement a `LiveHspMcpProvider` conforming to `HspMcpTransportProvider`.
3. **Live Wallet Authorization & Signing Adapter:** Wiring real user-interactive wallet signing into `HspWalletAuthorizationProvider` (never storing signing secrets in the frontend).
4. **Live End-to-End Settlement Evidence:** Collecting real `evidenceKind: "LIVE_HSP_MCP"` transaction references after allowlisting and live schema binding.
