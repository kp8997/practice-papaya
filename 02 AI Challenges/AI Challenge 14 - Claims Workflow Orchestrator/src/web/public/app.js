let currentWorkflow = null;
let claims = [];
let selectedClaimId = null;
let selectedClaimDetail = null;

// Declarative transition input schemas (Open/Closed: add new state inputs here)
const TRANSITION_FIELDS = {
  "FRAUD_CHECK->UNDER_ASSESSMENT": [
    { key: "fraudRiskScore", label: "Fraud Risk Score (0-70)", type: "number", defaultVal: 15 },
    { key: "assessorId", label: "Assign Assessor ID", type: "text", defaultVal: "assessor-alice" },
  ],
  "FRAUD_CHECK->REJECTED": [
    { key: "fraudRiskScore", label: "Fraud Risk Score (>70)", type: "number", defaultVal: 88 },
    { key: "rejectionReason", label: "Fraud Rejection Reason", type: "text", defaultVal: "Duplicate invoice detected" },
  ],
  UNDER_ASSESSMENT: [
    { key: "assessorId", label: "Assign Assessor ID", type: "text", defaultVal: "assessor-alice" },
  ],
  APPROVED: [
    { key: "assessmentReportComplete", label: "assessmentReportComplete", type: "checkbox", defaultVal: true },
  ],
  REJECTED: [
    { key: "rejectionReason", label: "Rejection Reason", type: "text", defaultVal: "Non-covered cosmetic treatment" },
    { key: "assessmentReportComplete", label: "assessmentReportComplete", type: "checkbox", defaultVal: true },
  ],
  PENDING_INFO: [
    { key: "missingInfoDescription", label: "Missing Info Description", type: "text", defaultVal: "Need itemized pharmacy receipt" },
  ],
  "PENDING_INFO->DOCUMENTS_VERIFIED": [
    { key: "newDocuments", label: "New Documents (comma separated)", type: "array", defaultVal: "pharmacy_receipt.pdf" },
  ],
  "PAYMENT_INITIATED->CLOSED": [
    { key: "paymentReference", label: "Payment Reference", type: "text", defaultVal: "PAY-TX-9001" },
    { key: "paymentConfirmed", label: "paymentConfirmed", type: "checkbox", defaultVal: true },
  ],
  "REJECTED->CLOSED": [
    { key: "memberAcknowledged", label: "memberAcknowledged (or use +31d clock)", type: "checkbox", defaultVal: false },
  ],
};

const $ = (id) => document.getElementById(id);
const fmtTime = (iso) => new Date(iso).toISOString().replace("T", " ").slice(0, 19);

function showToast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = isError ? "toast-error" : "toast-success";
  t.style.display = "block";
  setTimeout(() => { t.style.display = "none"; }, 4000);
}

function toggleModal(open) { $("create-modal").style.display = open ? "flex" : "none"; }

function switchLedgerTab(tab) {
  $("tab-audit-btn").className = tab === "audit" ? "tab-btn active" : "tab-btn";
  $("tab-outbox-btn").className = tab === "outbox" ? "tab-btn active" : "tab-btn";
  $("tab-audit-pane").style.display = tab === "audit" ? "block" : "none";
  $("tab-outbox-pane").style.display = tab === "outbox" ? "block" : "none";
}

async function api(url, method = "GET", body) {
  const res = await fetch(url, {
    method,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

async function init() {
  const wf = await api("/api/workflow");
  if (wf.ok) {
    currentWorkflow = wf.config;
    $("workflow-title").textContent = currentWorkflow.name;
    $("workflow-version").textContent = "v" + currentWorkflow.version;
    $("simulated-clock").textContent = fmtTime(wf.clock.iso);
    renderStepper();
  }
  await fetchClaims();
}

async function advanceClock(days) {
  const json = await api("/api/clock", "POST", { days });
  if (json.ok) {
    $("simulated-clock").textContent = fmtTime(json.clock.iso);
    showToast(`Clock advanced by ${days} day(s).`);
    if (selectedClaimId) await selectClaim(selectedClaimId);
  }
}

async function seedSampleClaims() {
  const json = await api("/api/seed", "POST");
  showToast(json.message);
  await fetchClaims();
}

async function resetDatabase() {
  if (!confirm("Reset in-memory database?")) return;
  const json = await api("/api/reset", "POST");
  selectedClaimId = null;
  selectedClaimDetail = null;
  showToast(json.message);
  await fetchClaims();
}

async function fetchClaims() {
  const json = await api("/api/claims");
  if (!json.ok) return;
  claims = json.claims;
  $("claim-count").textContent = claims.length;
  renderClaimList();
  const target = selectedClaimId || claims[0]?.id;
  if (target) await selectClaim(target);
}

function renderClaimList() {
  $("claim-list").innerHTML = claims.length === 0
    ? '<p style="color:var(--text-muted);font-size:0.8rem;text-align:center;padding:16px;">No claims yet. Click "Seed Demo Claims".</p>'
    : claims.map((c) => `
      <div class="claim-card ${c.id === selectedClaimId ? "active" : ""}" onclick="selectClaim('${c.id}')">
        <div class="claim-card-top"><span>${c.id}</span><span class="pill pill-${c.state}">${c.state}</span></div>
        <div class="claim-card-meta"><span>$${Number(c.data?.amount ?? 0).toLocaleString()}</span><span>v${c.version}</span></div>
      </div>`).join("");
}

function renderStepper() {
  if (!currentWorkflow) return;
  $("workflow-stepper").innerHTML = Object.entries(currentWorkflow.states).map(([s, def]) => `
    <div class="step-node ${selectedClaimDetail?.claim?.state === s ? "active" : ""} ${def.terminal ? "terminal" : ""}" title="${def.description}">
      <span class="step-name">${s}</span>
      ${def.terminal ? '<small style="color:#a1a1aa">TERMINAL</small>' : ""}
    </div>`).join("");
}

async function selectClaim(id) {
  selectedClaimId = id;
  renderClaimList();
  const detail = await api(`/api/claims/${encodeURIComponent(id)}`);
  if (!detail.ok) return;
  selectedClaimDetail = detail;
  renderWorkbench();
  const [audit, outbox] = await Promise.all([
    api(`/api/claims/${encodeURIComponent(id)}/audit`),
    api(`/api/claims/${encodeURIComponent(id)}/outbox`),
  ]);
  if (audit.ok) renderAudit(audit);
  if (outbox.ok) renderOutbox(outbox);
}

function getFieldsForEdge(fromState, toState) {
  return TRANSITION_FIELDS[`${fromState}->${toState}`] || TRANSITION_FIELDS[toState] || [];
}

function renderWorkbench() {
  const { claim, availableTransitions } = selectedClaimDetail;
  renderStepper();
  $("view-claim-id").textContent = claim.id;
  $("view-claim-state-pill").textContent = claim.state;
  $("view-claim-state-pill").className = `pill pill-${claim.state}`;
  $("view-amount").textContent = "$" + Number(claim.data?.amount ?? 0).toLocaleString();
  $("view-limit").textContent = "$" + Number(claim.data?.policyLimit ?? 0).toLocaleString();
  $("view-version").textContent = `v${claim.version}`;
  $("view-assessor").textContent = claim.data?.assessorId || "Unassigned";
  $("view-docs").textContent = (claim.data?.submittedDocuments || []).join(", ") || "none";

  const cycleCount = availableTransitions.find((t) => t.cycleStatus)?.cycleStatus?.currentCount ?? 0;
  $("cycle-detail-text").textContent = `Current count: ${cycleCount} of 3 cycles used.`;
  for (let i = 1; i <= 3; i++) {
    $(`cycle-bar-${i}`).className = "cycle-block" + (i <= cycleCount ? (cycleCount >= 3 ? " limit" : " filled") : "");
  }

  $("transitions-grid").innerHTML = availableTransitions.length === 0
    ? '<p style="color:var(--text-muted);font-size:0.85rem;">No outgoing transitions (terminal state).</p>'
    : availableTransitions.map((t) => {
      const defaultRole = t.roles[0];
      const defaultUser = defaultRole === "assessor" && claim.data?.assessorId ? claim.data.assessorId : `u-${defaultRole}`;
      const fields = getFieldsForEdge(claim.state, t.to);
      const inputsHtml = fields.map((f) => f.type === "checkbox"
        ? `<label style="font-size:0.8rem;"><input type="checkbox" id="f-${t.to}-${f.key}" ${f.defaultVal ? "checked" : ""}> ${f.label}</label>`
        : `<div class="form-group"><label>${f.label}</label><input type="${f.type === "number" ? "number" : "text"}" id="f-${t.to}-${f.key}" class="form-control" value="${claim.data?.[f.key] ?? f.defaultVal}"></div>`
      ).join("");

      return `
        <div class="transition-card ${t.allPreconditionsMet ? "ready" : "blocked"}">
          <div class="transition-header">
            <div><span class="transition-title">-> ${t.to}</span> <span>${t.roles.map((r) => `<span class="pill">${r}</span>`).join(" ")}</span></div>
            <span class="badge ${t.allPreconditionsMet ? "badge-ready" : "badge-blocked"}">${t.allPreconditionsMet ? "READY" : "UNMET GUARDS"}</span>
          </div>
          <div class="preconditions-box">
            ${t.preconditions.map((p) => `<div><span class="${p.passed ? "check-pass" : "check-fail"}">${p.passed ? "PASS" : "UNMET"}</span>${p.description}${!p.passed && p.failureReason ? ` <small style="color:#f87171">(${p.failureReason})</small>` : ""}</div>`).join("")}
          </div>
          <div class="form-row">
            <div class="form-group"><label>Actor Role</label><select id="role-${t.to}" class="form-control">${currentWorkflow.roles.map((r) => `<option value="${r}" ${r === defaultRole ? "selected" : ""}>${r}</option>`).join("")}</select></div>
            <div class="form-group"><label>Actor User ID</label><input id="user-${t.to}" class="form-control" value="${defaultUser}"></div>
          </div>
          ${inputsHtml}
          <div style="display:flex;justify-content:flex-end;"><button class="btn btn-primary" onclick="executeTransition('${t.to}')">Execute -> ${t.to}</button></div>
        </div>`;
    }).join("");
}

async function executeTransition(toState) {
  const claim = selectedClaimDetail.claim;
  const input = {};
  for (const f of getFieldsForEdge(claim.state, toState)) {
    const el = $(`f-${toState}-${f.key}`);
    if (!el) continue;
    if (f.type === "checkbox") {
      if (f.key !== "memberAcknowledged" || el.checked) input[f.key] = el.checked;
    } else if (f.type === "number") input[f.key] = Number(el.value);
    else if (f.type === "array") input[f.key] = el.value.split(",").map((s) => s.trim()).filter(Boolean);
    else input[f.key] = el.value;
  }

  const json = await api(`/api/claims/${encodeURIComponent(selectedClaimId)}/advance`, "POST", {
    toState,
    actor: { role: $(`role-${toState}`).value, userId: $(`user-${toState}`).value },
    input,
  });

  if (json.ok) {
    showToast(`Transitioned -> ${toState}`);
    await fetchClaims();
  } else {
    showToast(`[${json.error?.code}] ${json.error?.message}`, true);
    await selectClaim(selectedClaimId);
  }
}

function renderAudit(audit) {
  $("audit-count").textContent = audit.count;
  $("replay-badge").textContent = `Replay Check: OK (v${audit.replay.version}, ${audit.replay.deniedAttempts} denied)`;
  $("audit-list").innerHTML = audit.entries.map((e) => `
    <div class="audit-entry ${e.outcome}">
      <div class="audit-header"><span>${e.id} • ${fmtTime(e.timestamp)}</span><span>${e.outcome}${e.errorCode ? ` (${e.errorCode})` : ""}</span></div>
      <strong>${e.from_state || "INITIAL"} -> ${e.to_state}</strong>
      <small style="color:var(--text-muted)">By: ${e.triggered_by.userId} (${e.triggered_by.role}) — ${e.reason}</small>
      ${Object.keys(e.delta || {}).length ? `<div class="delta-viewer">delta: ${JSON.stringify(e.delta)}</div>` : ""}
    </div>`).join("");
}

function renderOutbox(outbox) {
  $("outbox-count").textContent = outbox.count;
  $("outbox-list").innerHTML = outbox.events.map((e) => `
    <div class="audit-entry SUCCESS">
      <div class="audit-header"><span>${e.id} • ${fmtTime(e.createdAt)}</span><span>[${e.status}]</span></div>
      <strong>${e.type}${e.target ? ` -> ${e.target}` : ""}</strong>
      <div>${e.message}</div>
    </div>`).join("");
}

async function handleCreateSubmit(e) {
  e.preventDefault();
  const docs = [["doc-form", "claim_form"], ["doc-report", "medical_report"], ["doc-receipt", "itemized_receipt"]]
    .filter(([id]) => $(id).checked).map(([, name]) => name);
  const json = await api("/api/claims", "POST", {
    id: $("new-id").value.trim() || undefined,
    notes: $("new-notes").value.trim() || undefined,
    data: { amount: Number($("new-amount").value), policyLimit: Number($("new-limit").value), submittedDocuments: docs },
  });
  if (json.ok) {
    toggleModal(false);
    selectedClaimId = json.claim.id;
    showToast(`Created ${json.claim.id}`);
    await fetchClaims();
  } else showToast(json.error?.message || "Failed", true);
}

window.onload = init;

