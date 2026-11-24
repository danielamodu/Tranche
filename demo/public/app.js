const STEPS = [
  {
    num: 1,
    title: "Step 1 — LP Supplies Inventory & Creates Offer",
    desc: "Attests LP via LOCAL_EIP712_COMPLIANCE (HSPComplianceHook), deposits 10,000 WHSK into LiquidityVault, and creates a 5,000 WHSK offer.",
    buttonLabel: "Execute Step 1: Attest, Deposit & Create Offer",
  },
  {
    num: 2,
    title: "Step 2 — Trader / Agent Discovers Offers",
    desc: "Calls discoverOffers(), evaluates available capacity, price mode, spread/strike, expiry, and quotes a 1,000 WHSK / 600s reservation.",
    buttonLabel: "Execute Step 2: Discover & Quote Offer",
  },
  {
    num: 3,
    title: "Step 3 — Trader Reserves Capacity & Receives Ticket",
    desc: "Attests Trader 1 via HSPComplianceHook, issues pre-trade HSPMandate, calls reserve(), mints ERC-721 ExecutionTicket, and shifts offerBalance -> ticketReserved.",
    buttonLabel: "Execute Step 3: Attest Trader 1 & Reserve Ticket",
  },
  {
    num: 4,
    title: "Step 4 — Ticket Transferred",
    desc: "Attests Trader 2 via HSPComplianceHook, transfers ERC-721 ExecutionTicket from Trader 1 to Trader 2 (transferFrom), and verifies new ownerOf(ticketId).",
    buttonLabel: "Execute Step 4: Attest Trader 2 & Transfer NFT",
  },
  {
    num: 5,
    title: "Step 5 — Ticket Exercised (Partial Fill)",
    desc: "Trader 2 exercises 60% (600 WHSK) of ticket capacity, receives WHSK, credits LP lpPendingProceeds + protocolFees in USDT, and records HSPSettlementReceipt.",
    buttonLabel: "Execute Step 5: Partial Exercise (60%)",
  },
  {
    num: 6,
    title: "Step 6 — Expiry & Reclaim",
    desc: "Warps Anvil chain time past expiresAt, permissionless keeper calls reclaimExpired(ticketId), burns NFT, returns unused 400 WHSK, LP claims USDT proceeds, and verifies INV-1.",
    buttonLabel: "Execute Step 6: Warp, Reclaim, Claim & Verify INV-1",
  },
];

let currentState = null;
let busy = false;

const els = {
  solvencyBadge: document.getElementById("solvencyBadge"),
  hspBadge: document.getElementById("hspBadge"),
  liveCaasNote: document.getElementById("liveCaasNote"),
  chainMeta: document.getElementById("chainMeta"),
  progressCaption: document.getElementById("progressCaption"),
  statusBanner: document.getElementById("statusBanner"),
  stepsGrid: document.getElementById("stepsGrid"),
  vaultPanel: document.getElementById("vaultPanel"),
  offersPanel: document.getElementById("offersPanel"),
  ticketsPanel: document.getElementById("ticketsPanel"),
  actorsPanel: document.getElementById("actorsPanel"),
  contractsPanel: document.getElementById("contractsPanel"),
  evidencePanel: document.getElementById("evidencePanel"),
  runAllBtn: document.getElementById("runAllBtn"),
  resetBtn: document.getElementById("resetBtn"),
  priceModeSelect: document.getElementById("priceModeSelect"),
};

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortAddr(addr) {
  if (!addr) return "—";
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function showBanner(message, kind = "info") {
  els.statusBanner.textContent = message;
  els.statusBanner.className = `status-banner ${kind}`;
}

function clearBanner() {
  els.statusBanner.className = "status-banner hidden";
  els.statusBanner.textContent = "";
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function renderHeaderAndMeta(state) {
  const inv1 = Boolean(state.vault?.inv1Verified);
  els.solvencyBadge.textContent = inv1 ? "INV-1 Solvency: VERIFIED" : "INV-1 Solvency: FAILED";
  els.solvencyBadge.className = `badge badge-solvency ${inv1 ? "verified" : "failed"}`;

  const hspMode = state.hspStatus?.activeMode || "LOCAL_EIP712_COMPLIANCE";
  els.hspBadge.textContent = hspMode;
  const liveNote = state.hspStatus?.liveCaasReport?.notes?.[0];
  if (liveNote) {
    els.liveCaasNote.textContent = liveNote;
  }

  els.chainMeta.textContent = `Chain ID: ${state.chainId} · Block: ${state.blockNumber} · Timestamp: ${state.blockTimestamp}`;
  els.progressCaption.textContent = `${state.completedSteps.length} / 6 completed`;

  els.runAllBtn.disabled = busy;
  els.resetBtn.disabled = busy;
  els.priceModeSelect.disabled = busy || state.completedSteps.includes(1);
}

function renderSteps(state) {
  const completed = new Set(state.completedSteps);
  els.stepsGrid.innerHTML = STEPS.map((step) => {
    const isDone = completed.has(step.num);
    const isReady = !isDone && state.nextStep === step.num;
    const cardClass = isDone ? "step-card done" : isReady ? "step-card active" : "step-card";
    const pillClass = isDone ? "done" : isReady ? "ready" : "waiting";
    const pillText = isDone ? "DONE" : isReady ? "NEXT" : "PENDING";
    const output = state.stepOutputs?.[step.num];

    return `
      <div class="${cardClass}">
        <div class="step-head">
          <div class="step-title">${esc(step.title)}</div>
          <span class="step-pill ${pillClass}">${pillText}</span>
        </div>
        <p class="step-desc">${esc(step.desc)}</p>
        <button
          class="btn btn-step"
          data-step="${step.num}"
          ${busy || !isReady ? "disabled" : ""}
        >
          ${isDone ? "Completed" : esc(step.buttonLabel)}
        </button>
        ${output ? `<div class="step-output">${esc(JSON.stringify(output, null, 2))}</div>` : ""}
      </div>
    `;
  }).join("");

  els.stepsGrid.querySelectorAll("button[data-step]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const num = Number(btn.getAttribute("data-step"));
      void runStep(num);
    });
  });
}

function renderVault(state) {
  const tokens = [state.vault.whsk, state.vault.usdt];
  els.vaultPanel.innerHTML = tokens
    .map(
      (t) => `
      <div class="vault-card">
        <div class="vault-card-head">
          <strong>${esc(t.symbol)} Vault Buckets</strong>
          <span class="tag ${t.inv1Solvent ? "tag-ok" : "tag-warn"}">
            ${t.inv1Solvent ? "INV-1 OK" : "INV-1 FAIL"}
          </span>
        </div>
        <div class="kv-row"><span class="kv-key">Physical balanceOf</span><span class="kv-val">${esc(t.physicalBalanceFormatted)} ${esc(t.symbol)}</span></div>
        <div class="kv-row"><span class="kv-key">Sum of Buckets</span><span class="kv-val">${esc(t.accountedSumFormatted)} ${esc(t.symbol)}</span></div>
        <div class="kv-row"><span class="kv-key">lpFree (total)</span><span class="kv-val">${esc(t.totalLpFreeFormatted)}</span></div>
        <div class="kv-row"><span class="kv-key">offerAvailable</span><span class="kv-val">${esc(t.totalOfferAvailableFormatted)}</span></div>
        <div class="kv-row"><span class="kv-key">ticketReserved</span><span class="kv-val">${esc(t.totalReservedFormatted)}</span></div>
        <div class="kv-row"><span class="kv-key">lpPendingProceeds</span><span class="kv-val">${esc(t.totalPendingProceedsFormatted)}</span></div>
        <div class="kv-row"><span class="kv-key">protocolFees</span><span class="kv-val">${esc(t.protocolFeesFormatted)}</span></div>
      </div>
    `,
    )
    .join("");
}

function renderOffers(state) {
  if (!state.offers.length) {
    els.offersPanel.innerHTML = `<div class="empty-state">No offers created yet. Run Step 1 to supply WHSK and create an offer.</div>`;
    return;
  }
  els.offersPanel.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Mode</th>
          <th>Status</th>
          <th>Available</th>
          <th>Min Fill</th>
          <th>Spread</th>
          <th>Expiry</th>
        </tr>
      </thead>
      <tbody>
        ${state.offers
          .map(
            (o) => `
          <tr>
            <td class="mono">#${esc(o.offerId)}</td>
            <td class="mono">${esc(o.priceMode)}</td>
            <td><span class="tag ${o.status === "ACTIVE" ? "tag-ok" : "tag-muted"}">${esc(o.status)}</span></td>
            <td class="mono">${esc(o.availableBalanceFormatted)} WHSK</td>
            <td class="mono">${esc(o.minFillAmountFormatted)} WHSK</td>
            <td class="mono">${esc(o.spreadBps)} bps</td>
            <td class="mono">${esc(o.expiry)}</td>
          </tr>
        `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderTickets(state) {
  if (!state.tickets.length) {
    els.ticketsPanel.innerHTML = `<div class="empty-state">No tickets reserved yet. Run Steps 1–3 to mint an ERC-721 ExecutionTicket.</div>`;
    return;
  }
  els.ticketsPanel.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Ticket</th>
          <th>Offer</th>
          <th>Status</th>
          <th>Owner</th>
          <th>Remaining / Initial</th>
          <th>Expires At</th>
        </tr>
      </thead>
      <tbody>
        ${state.tickets
          .map(
            (t) => `
          <tr>
            <td class="mono">#${esc(t.ticketId)}</td>
            <td class="mono">#${esc(t.offerId)}</td>
            <td><span class="tag ${t.status === "ACTIVE" ? "tag-ok" : "tag-muted"}">${esc(t.status)}</span></td>
            <td class="mono" title="${esc(t.owner || "BURNED")}">${t.owner ? esc(shortAddr(t.owner)) : "BURNED (null)"}</td>
            <td class="mono">${esc(t.remainingAmountFormatted)} / ${esc(t.initialAmountFormatted)} WHSK</td>
            <td class="mono">${esc(t.expiresAt)}</td>
          </tr>
        `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderActorsAndContracts(state) {
  els.actorsPanel.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Role</th>
          <th>Address</th>
          <th>WHSK</th>
          <th>USDT</th>
          <th>HSP Hook</th>
        </tr>
      </thead>
      <tbody>
        ${state.actors
          .map(
            (a) => `
          <tr>
            <td><strong>${esc(a.role)}</strong></td>
            <td class="mono" title="${esc(a.address)}">${esc(shortAddr(a.address))}</td>
            <td class="mono">${esc(a.whskFormatted)}</td>
            <td class="mono">${esc(a.usdtFormatted)}</td>
            <td>
              <span class="tag ${a.hspCompliant ? "tag-ok" : "tag-muted"}">
                ${a.hspCompliant ? "ATTESTED" : "UNATTESTED"}
              </span>
            </td>
          </tr>
        `,
          )
          .join("")}
      </tbody>
    </table>
  `;

  const entries = [
    ["LiquidityVault", state.contracts.liquidityVault],
    ["CommitmentManager", state.contracts.commitmentManager],
    ["ExecutionTicket", state.contracts.executionTicket],
    ["ExecutionRouter", state.contracts.executionRouter],
    ["HSPComplianceHook", state.contracts.hspComplianceHook],
    ["OraclePriceAdapter", state.contracts.oraclePriceAdapter],
    ["SignedPullOracle", state.contracts.signedPullOracle],
    ["MockWHSK", state.contracts.whsk],
    ["MockUSDT", state.contracts.usdt],
  ];

  els.contractsPanel.innerHTML = entries
    .map(
      ([name, addr]) => `
      <div class="contract-item">
        <div class="contract-name">${esc(name)}</div>
        <div class="contract-addr">${esc(addr)}</div>
      </div>
    `,
    )
    .join("");
}

function renderEvidence(state) {
  if (!state.evidenceLog.length) {
    els.evidencePanel.innerHTML = `<div class="empty-state">No step transactions executed yet. Click Step 1 or "Run Complete 6-Step Journey".</div>`;
    return;
  }
  els.evidencePanel.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Step</th>
          <th>Action</th>
          <th>Actor</th>
          <th>Tx Hash</th>
          <th>Block</th>
          <th>Gas Used</th>
          <th>Detail</th>
        </tr>
      </thead>
      <tbody>
        ${state.evidenceLog
          .map(
            (ev) => `
          <tr>
            <td class="mono">${esc(ev.id)}</td>
            <td class="mono">Step ${esc(ev.step)}</td>
            <td class="mono">${esc(ev.action)}</td>
            <td>${esc(ev.actor)}</td>
            <td class="mono" title="${esc(ev.txHash)}">${esc(ev.txHash)}</td>
            <td class="mono">${esc(ev.blockNumber)}</td>
            <td class="mono">${esc(ev.gasUsed)}</td>
            <td>${esc(ev.detail)}</td>
          </tr>
        `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function render(state) {
  currentState = state;
  renderHeaderAndMeta(state);
  renderSteps(state);
  renderVault(state);
  renderOffers(state);
  renderTickets(state);
  renderActorsAndContracts(state);
  renderEvidence(state);
}

async function refreshState() {
  const data = await apiFetch("/api/state");
  render(data.state);
}

async function runStep(num) {
  if (busy) return;
  busy = true;
  clearBanner();
  if (currentState) render(currentState);

  try {
    const body =
      num === 1
        ? JSON.stringify({ priceMode: els.priceModeSelect.value })
        : num === 5
          ? JSON.stringify({ fillPercent: 60 })
          : "{}";
    const data = await apiFetch(`/api/step/${num}`, { method: "POST", body });
    render(data.state);
    showBanner(`Step ${num} executed on local Anvil.`, "info");
  } catch (err) {
    showBanner(err instanceof Error ? err.message : String(err), "error");
  } finally {
    busy = false;
    if (currentState) render(currentState);
  }
}

async function runAll() {
  if (busy) return;
  busy = true;
  showBanner("Running full 6-step Tranche journey on local Anvil...", "info");
  if (currentState) render(currentState);

  try {
    const data = await apiFetch("/api/run-all", {
      method: "POST",
      body: JSON.stringify({
        priceMode: els.priceModeSelect.value,
        fillPercent: 60,
      }),
    });
    render(data.state);
    showBanner("All 6 steps completed and INV-1 physical vault solvency verified.", "info");
  } catch (err) {
    showBanner(err instanceof Error ? err.message : String(err), "error");
  } finally {
    busy = false;
    if (currentState) render(currentState);
  }
}

async function resetDemo() {
  if (busy) return;
  busy = true;
  showBanner("Resetting local Anvil and redeploying fresh Tranche stack...", "info");
  if (currentState) render(currentState);

  try {
    const data = await apiFetch("/api/reset", { method: "POST", body: "{}" });
    render(data.state);
    showBanner("Fresh local Tranche deployment ready.", "info");
  } catch (err) {
    showBanner(err instanceof Error ? err.message : String(err), "error");
  } finally {
    busy = false;
    if (currentState) render(currentState);
  }
}

els.runAllBtn.addEventListener("click", () => void runAll());
els.resetBtn.addEventListener("click", () => void resetDemo());

refreshState().catch((err) => {
  showBanner(err instanceof Error ? err.message : String(err), "error");
});
