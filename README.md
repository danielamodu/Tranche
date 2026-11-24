<p align="center">
  <img src="assets/tranche-logo.png" alt="Tranche" width="220" />
</p>

<h1 align="center">TRANCHE</h1>

---

<p align="center">
  <strong>Inventory-backed, time-bounded execution commitments on HashKey Chain</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/solidity-0.8.24-363636?style=flat-square" alt="Solidity 0.8.24" />
  <img src="https://img.shields.io/badge/tests-61%20passing-4c1?style=flat-square" alt="61 Tests Passing" />
  <img src="https://img.shields.io/badge/license-MIT-007ec6?style=flat-square" alt="License MIT" />
  <img src="https://img.shields.io/badge/status-audit--ready-fe7d37?style=flat-square" alt="Status Audit-Ready" />
</p>

---

## What It Does

Passive AMM pools on HashKey Chain leave large trades facing steep slippage (`2.7%–24%` on `$10k` orders) while passive LPs earn minimal fees.

**Tranche** lets LPs deposit ERC-20 inventory into a 1:1 custody vault and publish time-bounded execution commitments — either **Fixed Strike** or **Floating** (`oracle + spread`). Traders and execution agents pay a small upfront premium to mint a transferable ERC-721 `ExecutionTicket`, which they can hold, transfer, split, or batch-exercise with zero price impact up to the reserved amount. Unused inventory is reclaimed permissionlessly after expiry.

## Lifecycle

```text
1. Deposit      LP deposits ERC-20 (or segregates HSKSwap V3 LP NFT) into LiquidityVault
2. Offer        LP creates a FIXED or FLOATING commitment in CommitmentManager
3. Reserve      Trader pays upfront premium and receives an ERC-721 ExecutionTicket
4. Transfer     Ticket can be transferred, permitted (EIP-712), or split into child tickets
5. Exercise     Holder fills partially or fully via CommitmentManager or ExecutionRouter
6. Reclaim      Expired capacity returns to the LP; LP claims proceeds anytime
```

## Components

| Package | Path | Description |
| --- | --- | --- |
| **Core Contracts** | [`contracts/src/`](contracts/src/) | `LiquidityVault`, `CommitmentManager`, `ExecutionTicket`, `ExecutionRouter`, and oracle/compliance/V3 adapters |
| **TypeScript SDK** | [`sdk/`](sdk/) | Typed `viem` client (`TrancheClient`), custom error decoder, and local Anvil deployer |
| **Execution Agent** | [`agent/`](agent/) | Deterministic offer discovery, scoring, reservation, partial fills, and expiry recovery |
| **HSP Adapter** | [`hsp/`](hsp/) | Out-of-band EIP-712 compliance attestation, mandate, and settlement receipt adapter |
| **Demo Dashboard** | [`demo/`](demo/) | Local 6-step interactive web demo and HTTP API running on Anvil |
| **Testnet Ops** | [`scripts/testnet-ops/`](scripts/testnet-ops/) | Multi-RPC failover transport, M-of-N oracle signer aggregator, keeper, and 72h soak runner |

## Quickstart

```bash
# Run core Foundry test suite (unit, regression, adversarial, invariant)
forge test --no-match-path "contracts/test/{HashKeyForkPrototype,TestnetOperationalValidation}.t.sol"

# Run HashKey Chain Testnet (133) governance, oracle & lifecycle fork validation
forge test --match-path contracts/test/TestnetOperationalValidation.t.sol --fork-url https://testnet.hsk.xyz -vv

# Run HashKey Chain Mainnet (177) V3 segregation fork test
forge test --match-path contracts/test/HashKeyForkPrototype.t.sol --fork-url https://mainnet.hsk.xyz -vv

# Launch the interactive local demo (http://localhost:3177)
cd demo && npm install && npm start
```

## Security & Verification

- **Custody & Invariants:** Strict 1:1 ERC-20 bucket accounting (`totalLpFree + totalOfferAvailable + totalReserved + totalPendingProceeds + protocolFees <= balanceOf(vault)`), verified across 5,120 stateful fuzz calls with zero reverts.
- **Governance & Emergency Controls:** `Ownable2Step` ownership transferred to `TimelockController` (`3-of-5` Governance Safe); `2-of-3` Guardian Safe can pause deposits/reservations/floating fills and revoke oracle quotes without ever blocking `FIXED` exercises, LP withdrawals, or expiry reclaims (`INV-8`).
- **Oracle Safeguards:** `2-of-3` M-of-N EIP-712 `SignedPullOracle` with internal TTL, per-pair max-jump caps, decimal-aware hard bounds, and fail-closed secondary deviation checks (`OraclePriceAdapter`).
- **Test Coverage (61 passing):** `40` local Foundry · `1` Mainnet (`177`) fork · `5` Testnet (`133`) fork · `2` SDK · `5` HSP · `3` Agent · `3` Demo · `2` Testnet Ops.
- **Deployment Status:** No contracts are deployed to mainnet or live testnet yet (`deployments/hashkey-testnet.json` is fork-verified and pending funded testnet broadcast).

## Documentation

- **Architecture & Threat Model:** [`research/PROTOCOL_ARCHITECTURE.md`](research/PROTOCOL_ARCHITECTURE.md) · [`research/THREAT_MODEL.md`](research/THREAT_MODEL.md)
- **Audit & Remediation:** [`research/SECURITY_AUDIT.md`](research/SECURITY_AUDIT.md) · [`research/REMEDIATION_SPEC.md`](research/REMEDIATION_SPEC.md)
- **Oracle, Economics & Governance:** [`research/ORACLE_DESIGN.md`](research/ORACLE_DESIGN.md) · [`research/ECONOMIC_FIXES.md`](research/ECONOMIC_FIXES.md) · [`research/GOVERNANCE_DESIGN.md`](research/GOVERNANCE_DESIGN.md)
- **Testnet Validation & Manifest:** [`research/TESTNET_DEPLOYMENT.md`](research/TESTNET_DEPLOYMENT.md) · [`deployments/hashkey-testnet.json`](deployments/hashkey-testnet.json) · [`research/INCIDENT_LOG.md`](research/INCIDENT_LOG.md)
