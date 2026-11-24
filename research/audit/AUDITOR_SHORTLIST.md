# Tranche — Independent Auditor Shortlist

> **Prepared:** 2026-11-24  
> **Scope Size:** 10 Solidity files (`2,248` total lines; vault custody, ERC-721 + EIP-712 permit, M-of-N pull oracle + TWAP circuit breaker, timelocked Safe governance)  
> **Constraint:** Zero outreach or commitment has been made. No pricing, availability, or endorsements have been fabricated; all pricing/turnaround items not publicly published are marked as requiring direct quote.

---

## Evaluation Criteria
Candidates were evaluated against Tranche's exact risk surface:
1. Proven Solidity DeFi track record in **vault custody/accounting**, **ERC-721/permit permissions**, **oracle/TWAP manipulation**, and **timelocked Safe governance**.
2. Public, verifiable audit report archives (not opaque marketing claims).
3. Independent security engineering depth (preferred over generic pay-for-badge marketplaces).
4. Standard support for **remediation / fix verification** before final report publication.

---

## Shortlisted Independent Candidates (6)

### 1. Spearbit (via Cantina)
- **Official Website:** https://www.cantina.security (Spearbit operates within the Cantina security ecosystem)
- **Public Track Record / Audit Examples:** Peer-reviewed DeFi security engagements across Uniswap, Aave, and EigenLayer; GitHub organizations at https://github.com/spearbit and https://github.com/spearbit-audits.
- **Engagement / Contact Route:** https://www.cantina.security/ (private expert review / managed Spearbit engagement request).
- **Estimated Cost & Turnaround:** Not publicly listed (custom quote based on scope and researcher staffing).
- **Fix Verification:** Standard part of private Spearbit/Cantina engagements (confirm explicitly in SOW).
- **Why Recommended for Tranche:** Strong match for novel DeFi market microstructure (option-like execution tickets, Uniswap V3 segregation, cross-decimal rounding, and oracle lag economics).

### 2. ChainSecurity
- **Official Website:** https://www.chainsecurity.com
- **Public Track Record / Audit Examples:** Public archive at https://www.chainsecurity.com/audits including MakerDAO (*Liquidations 2.0*), Compound (*Compound III*), Euler (*Ethereum Vault Connector*), Curve (*ETH/sETH pool*), and Yearn (*Yearn v3.0.0* vaults).
- **Engagement / Contact Route:** https://www.chainsecurity.com/request-audit · `contact@chainsecurity.com`
- **Estimated Cost & Turnaround:** Not publicly listed (custom quote).
- **Fix Verification:** Standard mitigation review stage in ChainSecurity audit reports (confirm in SOW).
- **Why Recommended for Tranche:** Deep formal-reasoning and vault-accounting rigor (Yearn v3, Euler EVC, Compound III) directly aligned with `LiquidityVault` bucket invariants and `CommitmentManager` rounding/economic soundness.

### 3. Trail of Bits
- **Official Website:** https://www.trailofbits.com
- **Public Track Record / Audit Examples:** Public archive at https://github.com/trailofbits/publications covering smart contracts, cryptography, DeFi protocols, and invariant/fuzzing methodologies.
- **Engagement / Contact Route:** https://www.trailofbits.com/contact (select *Blockchain Security / Smart Contracts*) · `info@trailofbits.com`
- **Estimated Cost & Turnaround:** Not publicly listed (custom quote).
- **Fix Verification:** Offers fix-review engagements (confirm whether bundled or separate in SOW).
- **Why Recommended for Tranche:** Industry-leading depth on EIP-712 signature schemes, ERC-721 permit edge cases, governance/timelock trust boundaries, and property-based invariant testing.

### 4. OpenZeppelin Security
- **Official Website:** https://openzeppelin.com/security-audits
- **Public Track Record / Audit Examples:** Author of the OpenZeppelin Contracts v5 library (`Ownable2Step`, `TimelockController`, `ERC721`, `EIP712`, `SafeERC20`, `ReentrancyGuard`) used directly by Tranche; public audit summaries published via OpenZeppelin's security research blog and GitHub (https://github.com/OpenZeppelin).
- **Engagement / Contact Route:** https://openzeppelin.com/security-audits
- **Estimated Cost & Turnaround:** Not publicly listed (custom quote).
- **Fix Verification:** Standard fix-review phase included in audit lifecycle (confirm in SOW).
- **Why Recommended for Tranche:** Unmatched familiarity with OZ v5 `Ownable2Step`, `TimelockController`, `ERC721._update`, and `Math.mulDiv` edge cases used throughout Tranche's core contracts.

### 5. Pashov Audit Group
- **Official Website:** https://www.pashov.com
- **Public Track Record / Audit Examples:** Public GitHub archive at https://github.com/pashov/audits containing hundreds of Markdown/PDF DeFi security reviews, including Uniswap periphery/V3 vault integrations (e.g., Bunni, Saffron Finance), Aave V3.2, LayerZero, and Ethena.
- **Engagement / Contact Route:** `partnerships@pashov.com` · Telegram `@pashovkrum`
- **Estimated Cost & Turnaround:** Not publicly listed (custom quote; typically well-suited to focused ~2k-line Solidity scopes).
- **Fix Verification:** Standard remediation review included in published reports (confirm in SOW).
- **Why Recommended for Tranche:** High-signal, fast-moving independent DeFi researcher group with extensive public precedent auditing Uniswap V3 vault integrations, oracle adapters, and custom DeFi routers.

### 6. yAudit
- **Official Website:** https://yaudit.dev
- **Public Track Record / Audit Examples:** Public archive at https://yaudit.dev/reports including Yearn *yVaults v3* (`v3.0.1`, `v3.1.0`) and Euler *Ethereum Vault Connector (EVC), EVK, and Price Oracles*.
- **Engagement / Contact Route:** https://yaudit.dev/contact
- **Estimated Cost & Turnaround:** Not publicly listed (custom quote).
- **Fix Verification:** Standard mitigation review in published reports (confirm in SOW).
- **Why Recommended for Tranche:** Boutique DeFi-native collective with direct, verifiable expertise in vault accounting and custom price-oracle architectures.

---

## Recommended Dual-Track Selection Strategy
Given Tranche's compact scope (`2,248` lines across `10` files):
- **Option A (Fast & Focused Primary Audit):** Request quotes from **Pashov Audit Group**, **yAudit**, and **Spearbit (Cantina)** first for rapid turnaround and deep DeFi vault/oracle specialization.
- **Option B (Institutional / Mainnet TVL Scale):** Pair or lead with **ChainSecurity**, **Trail of Bits**, or **OpenZeppelin Security** if targeting institutional HashKey Chain LPs requiring an institutional audit brand.
- **Explicitly Avoid:** Generic low-cost automated-scanner "audit" badges that do not perform manual economic, cross-decimal, and governance invariant review.
