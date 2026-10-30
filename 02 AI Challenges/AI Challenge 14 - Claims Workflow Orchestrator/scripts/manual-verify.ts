import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { replayClaimHistory } from "../src/engine/audit-store.js";
import { loadWorkflowConfig } from "../src/engine/config-schema.js";
import { WorkflowOrchestrator } from "../src/engine/orchestrator.js";
import { ConsoleOutboxDispatcher } from "../src/engine/outbox-store.js";

// Universal ESM directory resolution (compatible across all TypeScript & Node versions)
const __dirname = dirname(fileURLToPath(import.meta.url));
const baseConfigPath = resolve(__dirname, "../config/claims-workflow.yaml");
const fraudConfigPath = resolve(__dirname, "../config/claims-workflow.fraud-check.yaml");

const baseConfig = loadWorkflowConfig(baseConfigPath);
const fraudConfig = loadWorkflowConfig(fraudConfigPath);

console.log("================================================================================");
console.log("   PART 1 — BASE WORKFLOW (claims-workflow.yaml v1.0.0: 8 States, 5 Roles)      ");
console.log("================================================================================\n");

// Controllable clock so we can also manually test the 30-day appeal window!
let simulatedNow = new Date("2026-10-01T09:00:00.000Z");
const advanceSimulatedDays = (days: number) => {
  simulatedNow = new Date(simulatedNow.getTime() + days * 24 * 60 * 60 * 1000);
};

const orchestrator = new WorkflowOrchestrator(baseConfig, {
  clock: { now: () => simulatedNow },
  outboxDispatcher: ConsoleOutboxDispatcher,
});

/* -------------------------------------------------------------------------- */
/* STEP 1: CREATE A NEW CLAIM                                                  */
/* -------------------------------------------------------------------------- */
console.log("--- [STEP 1] Creating Claim CLM-2026 ---");
const claim = orchestrator.createClaim({
  id: "CLM-2026",
  notes: "Initial claim submission for inpatient treatment",
  data: {
    amount: 7500,
    policyLimit: 10000,
    submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
  },
});
console.log("Claim Created:", {
  id: claim.id,
  state: claim.state,
  version: claim.version,
  workflowVersion: claim.workflowVersion,
  data: claim.data,
});

/* -------------------------------------------------------------------------- */
/* STEP 2: INSPECT AVAILABLE TRANSITIONS FROM CURRENT STATE                   */
/* -------------------------------------------------------------------------- */
console.log("\n--- [STEP 2] Inspecting Available Transitions from SUBMITTED ---");
const transitionsAtSubmitted = orchestrator.getAvailableTransitions("CLM-2026");
console.log("Available Transitions:", JSON.stringify(transitionsAtSubmitted, null, 2));

/* -------------------------------------------------------------------------- */
/* STEP 3: ADVANCE TO DOCUMENTS_VERIFIED (Role: document_clerk)               */
/* -------------------------------------------------------------------------- */
console.log("\n--- [STEP 3] Transition: SUBMITTED -> DOCUMENTS_VERIFIED ---");
const res1 = orchestrator.transition({
  claimId: "CLM-2026",
  toState: "DOCUMENTS_VERIFIED",
  actor: { userId: "clerk-bob", role: "document_clerk" },
  notes: "All 3 required documents verified and legible",
});
console.log("Transition Result:", {
  ok: res1.ok,
  currentState: res1.ok ? res1.claim.state : "FAILED",
  version: res1.ok ? res1.claim.version : null,
  delta: res1.ok ? res1.auditEntry.delta : null,
});

/* -------------------------------------------------------------------------- */
/* STEP 4: TEST PRECONDITION FAILURE (Assessor not assigned)                   */
/* -------------------------------------------------------------------------- */
console.log(
  "\n--- [STEP 4] Negative Test: Try DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT without Assessor ---"
);
const failedStep4 = orchestrator.transition({
  claimId: "CLM-2026",
  toState: "UNDER_ASSESSMENT",
  actor: { userId: "lead-sarah", role: "team_lead" },
  input: {}, // missing assessorId!
});
console.log("Expected Failure:", {
  ok: failedStep4.ok,
  errorCode: !failedStep4.ok ? failedStep4.error.code : null,
  message: !failedStep4.ok ? failedStep4.error.message : null,
});

/* -------------------------------------------------------------------------- */
/* STEP 5: ADVANCE TO UNDER_ASSESSMENT with Assigned Assessor                 */
/* -------------------------------------------------------------------------- */
console.log(
  "\n--- [STEP 5] Transition: DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT with Assessor Assigned ---"
);
const res2 = orchestrator.transition({
  claimId: "CLM-2026",
  toState: "UNDER_ASSESSMENT",
  actor: { userId: "lead-sarah", role: "team_lead" },
  notes: "Assigned claim to senior assessor Alice",
  input: {
    assessorId: "assessor-alice",
  },
});
console.log("Transition Result:", {
  ok: res2.ok,
  currentState: res2.ok ? res2.claim.state : "FAILED",
  assessmentStartedAt: res2.ok ? res2.claim.data.assessmentStartedAt : null,
});

/* -------------------------------------------------------------------------- */
/* STEP 6: TEST ROLE AUTHORIZATION VIOLATION (clerk tries to approve)         */
/* -------------------------------------------------------------------------- */
console.log("\n--- [STEP 6] Negative Test: Document clerk tries to APPROVE claim ---");
const unauthorizedRes = orchestrator.transition({
  claimId: "CLM-2026",
  toState: "APPROVED",
  actor: { userId: "clerk-bob", role: "document_clerk" }, // wrong role!
});
console.log("Expected Authorization Failure:", {
  ok: unauthorizedRes.ok,
  errorCode: !unauthorizedRes.ok ? unauthorizedRes.error.code : null,
  message: !unauthorizedRes.ok ? unauthorizedRes.error.message : null,
});

/* -------------------------------------------------------------------------- */
/* STEP 7: TEST PRECONDITION FAILURE (Amount exceeds policy limit)             */
/* -------------------------------------------------------------------------- */
console.log("\n--- [STEP 7] Negative Test: Approve with Amount (15000) > Policy Limit (10000) ---");
const overLimitRes = orchestrator.transition({
  claimId: "CLM-2026",
  toState: "APPROVED",
  actor: { userId: "assessor-alice", role: "assessor" },
  input: {
    amount: 15000, // exceeds policy limit!
    assessmentReportComplete: true,
  },
});
console.log("Expected Precondition Failure:", {
  ok: overLimitRes.ok,
  errorCode: !overLimitRes.ok ? overLimitRes.error.code : null,
  message: !overLimitRes.ok ? overLimitRes.error.message : null,
});

/* -------------------------------------------------------------------------- */
/* STEP 8: ADVANCE TO APPROVED (Valid assessor & report complete)              */
/* -------------------------------------------------------------------------- */
console.log("\n--- [STEP 8] Transition: UNDER_ASSESSMENT -> APPROVED ---");
const res3 = orchestrator.transition({
  claimId: "CLM-2026",
  toState: "APPROVED",
  actor: { userId: "assessor-alice", role: "assessor" },
  input: {
    assessmentReportComplete: true,
  },
  notes: "Assessment report complete. Claim validated within limits.",
});
console.log("Transition Result:", {
  ok: res3.ok,
  currentState: res3.ok ? res3.claim.state : "FAILED",
  paymentRequestId: res3.ok ? res3.claim.data.paymentRequestId : null,
  sideEffectsExecuted: res3.ok ? res3.sideEffects.map((s) => s.description) : [],
});

/* -------------------------------------------------------------------------- */
/* STEP 9: ADVANCE TO PAYMENT_INITIATED (Role: finance)                       */
/* -------------------------------------------------------------------------- */
console.log("\n--- [STEP 9] Transition: APPROVED -> PAYMENT_INITIATED ---");
const res4 = orchestrator.transition({
  claimId: "CLM-2026",
  toState: "PAYMENT_INITIATED",
  actor: { userId: "finance-frank", role: "finance" },
  notes: "Payment initiated with gateway",
});
console.log("Transition Result:", {
  ok: res4.ok,
  currentState: res4.ok ? res4.claim.state : "FAILED",
  paymentTransactionId: res4.ok ? res4.claim.data.paymentTransactionId : null,
});

/* -------------------------------------------------------------------------- */
/* STEP 10: ADVANCE TO CLOSED (Role: finance)                                 */
/* -------------------------------------------------------------------------- */
console.log("\n--- [STEP 10] Transition: PAYMENT_INITIATED -> CLOSED ---");
const res5 = orchestrator.transition({
  claimId: "CLM-2026",
  toState: "CLOSED",
  actor: { userId: "finance-frank", role: "finance" },
  input: {
    paymentConfirmed: true,
    paymentReference: "TXN-BANK-889900",
  },
  notes: "Wire transfer confirmed by clearinghouse",
});
console.log("Transition Result:", {
  ok: res5.ok,
  currentState: res5.ok ? res5.claim.state : "FAILED",
  version: res5.ok ? res5.claim.version : null,
});

/* -------------------------------------------------------------------------- */
/* STEP 11: TEST TERMINAL STATE IMMUTABILITY                                  */
/* -------------------------------------------------------------------------- */
console.log("\n--- [STEP 11] Negative Test: Try to move out of CLOSED ---");
const terminalRes = orchestrator.transition({
  claimId: "CLM-2026",
  toState: "SUBMITTED",
  actor: { userId: "clerk-bob", role: "document_clerk" },
});
console.log("Expected Terminal Failure:", {
  ok: terminalRes.ok,
  errorCode: !terminalRes.ok ? terminalRes.error.code : null,
  message: !terminalRes.ok ? terminalRes.error.message : null,
});

/* -------------------------------------------------------------------------- */
/* STEP 12: TEST CYCLE DETECTION (Loop limit of 3 cycles)                     */
/* -------------------------------------------------------------------------- */
console.log("\n--- [STEP 12] Testing Cycle Detection (Max 3 info loops, 4th rejected) ---");
orchestrator.createClaim({
  id: "CLM-LOOP",
  data: {
    submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
  },
});

orchestrator.transition({
  claimId: "CLM-LOOP",
  toState: "DOCUMENTS_VERIFIED",
  actor: { userId: "clerk-bob", role: "document_clerk" },
});
orchestrator.transition({
  claimId: "CLM-LOOP",
  toState: "UNDER_ASSESSMENT",
  actor: { userId: "lead-sarah", role: "team_lead" },
  input: { assessorId: "assessor-alice" },
});

for (let cycle = 1; cycle <= 3; cycle++) {
  const reqInfo = orchestrator.transition({
    claimId: "CLM-LOOP",
    toState: "PENDING_INFO",
    actor: { userId: "assessor-alice", role: "assessor" },
    input: { missingInfoDescription: `Need additional document iteration #${cycle}` },
  });

  const docRes = orchestrator.transition({
    claimId: "CLM-LOOP",
    toState: "DOCUMENTS_VERIFIED",
    actor: { userId: "clerk-bob", role: "document_clerk" },
    input: { newDocuments: [`doc_iteration_${cycle}.pdf`] },
  });

  const reassess = orchestrator.transition({
    claimId: "CLM-LOOP",
    toState: "UNDER_ASSESSMENT",
    actor: { userId: "lead-sarah", role: "team_lead" },
    input: { assessorId: "assessor-alice" },
  });

  console.log(
    `Cycle #${cycle}: PENDING_INFO (ok: ${reqInfo.ok}) -> DOCUMENTS_VERIFIED (ok: ${docRes.ok}) -> UNDER_ASSESSMENT (ok: ${reassess.ok})`
  );
}

const fourthAttempt = orchestrator.transition({
  claimId: "CLM-LOOP",
  toState: "PENDING_INFO",
  actor: { userId: "assessor-alice", role: "assessor" },
  input: { missingInfoDescription: "4th request should exceed limit" },
});
console.log("4th Cycle Request Result (Must be rejected):", {
  ok: fourthAttempt.ok,
  errorCode: !fourthAttempt.ok ? fourthAttempt.error.code : null,
  message: !fourthAttempt.ok ? fourthAttempt.error.message : null,
});

/* -------------------------------------------------------------------------- */
/* STEP 13: AUDIT TRAIL IMMUTABILITY & REPLAY VERIFICATION                    */
/* -------------------------------------------------------------------------- */
console.log("\n--- [STEP 13] Audit Trail Immutability & Replay for CLM-2026 ---");
const auditEntries = orchestrator.getAuditTrail("CLM-2026");
console.log(
  `Total Audit Entries for CLM-2026: ${auditEntries.length} (including SUCCESS & DENIED attempts)`
);

try {
  (auditEntries[0] as unknown as { reason: string }).reason = "TAMPERED_BY_ATTACKER";
  console.log("ERROR: Mutation succeeded (should not happen!)");
} catch (err) {
  console.log(
    "Tamper Protection Verified: Modifying audit entry threw TypeError ->",
    (err as Error).message
  );
}

const replayed = replayClaimHistory("CLM-2026", auditEntries);
console.log("\nReplayed Claim State from Audit Log:", {
  claimId: replayed.claimId,
  currentState: replayed.currentState,
  version: replayed.version,
  deniedAttempts: replayed.deniedAttempts,
  stateHistory: replayed.stateHistory,
  finalDataKeys: Object.keys(replayed.data),
});

/* -------------------------------------------------------------------------- */
/* STEP 14: REJECTION PATH & 30-DAY APPEAL WINDOW CLOCK CHECK                 */
/* -------------------------------------------------------------------------- */
console.log("\n--- [STEP 14] Rejection Path & 30-Day Appeal Period Expiry (CLM-APPEAL) ---");
orchestrator.createClaim({
  id: "CLM-APPEAL",
  data: {
    amount: 3200,
    policyLimit: 10000,
    submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
  },
});
orchestrator.transition({
  claimId: "CLM-APPEAL",
  toState: "DOCUMENTS_VERIFIED",
  actor: { userId: "clerk-bob", role: "document_clerk" },
});
orchestrator.transition({
  claimId: "CLM-APPEAL",
  toState: "UNDER_ASSESSMENT",
  actor: { userId: "lead-sarah", role: "team_lead" },
  input: { assessorId: "assessor-alice" },
});
orchestrator.transition({
  claimId: "CLM-APPEAL",
  toState: "REJECTED",
  actor: { userId: "assessor-alice", role: "assessor" },
  input: {
    assessmentReportComplete: true,
    rejectionReason: "Non-covered elective procedure",
  },
});

// Day 10: Too early to close without member acknowledgement
advanceSimulatedDays(10);
const earlyClose = orchestrator.transition({
  claimId: "CLM-APPEAL",
  toState: "CLOSED",
  actor: { userId: "sys-cron", role: "system" },
});
console.log("Close attempt on Day 10 (Must fail):", {
  ok: earlyClose.ok,
  message: !earlyClose.ok ? earlyClose.error.message : null,
});

// Day 31 (+21 more days): Appeal window expired -> closes cleanly
advanceSimulatedDays(21);
const expiredClose = orchestrator.transition({
  claimId: "CLM-APPEAL",
  toState: "CLOSED",
  actor: { userId: "sys-cron", role: "system" },
});
console.log("Close attempt on Day 31 (Must pass):", {
  ok: expiredClose.ok,
  currentState: expiredClose.ok ? expiredClose.claim.state : "FAILED",
  archived: expiredClose.ok ? expiredClose.claim.data.archived : false,
});

/* ========================================================================== */
/* PART 2 — EXTENDED FRAUD-CHECK WORKFLOW (claims-workflow.fraud-check.yaml)  */
/* ========================================================================== */
console.log("\n================================================================================");
console.log("   PART 2 — EXTENSIBILITY DEMO (claims-workflow.fraud-check.yaml v1.1.0)        ");
console.log("   Same WorkflowOrchestrator class, ZERO engine code changes!                   ");
console.log("================================================================================\n");

const fraudOrchestrator = new WorkflowOrchestrator(fraudConfig, {
  outboxDispatcher: ConsoleOutboxDispatcher,
});

/* -------------------------------------------------------------------------- */
/* STEP 15: LOW-RISK CLAIM PASSES FRAUD_CHECK -> UNDER_ASSESSMENT             */
/* -------------------------------------------------------------------------- */
console.log("--- [STEP 15] Low-Risk Claim (CLM-FRAUD-LOW, score = 18 <= 70) ---");
fraudOrchestrator.createClaim({
  id: "CLM-FRAUD-LOW",
  data: {
    amount: 4800,
    policyLimit: 10000,
    submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
  },
});

fraudOrchestrator.transition({
  claimId: "CLM-FRAUD-LOW",
  toState: "DOCUMENTS_VERIFIED",
  actor: { userId: "clerk-bob", role: "document_clerk" },
});

// Inspect available transitions at DOCUMENTS_VERIFIED in v1.1.0 -> routes to FRAUD_CHECK!
console.log(
  "Next state from DOCUMENTS_VERIFIED in v1.1.0:",
  fraudOrchestrator.getAvailableTransitions("CLM-FRAUD-LOW").map((t) => ({
    to: t.to,
    roles: t.roles,
  }))
);

const enterFraudLow = fraudOrchestrator.transition({
  claimId: "CLM-FRAUD-LOW",
  toState: "FRAUD_CHECK",
  actor: { userId: "clerk-bob", role: "document_clerk" },
});
console.log("Entered FRAUD_CHECK:", {
  ok: enterFraudLow.ok,
  state: enterFraudLow.ok ? enterFraudLow.claim.state : null,
  fraudCheckStartedAt: enterFraudLow.ok ? enterFraudLow.claim.data.fraudCheckStartedAt : null,
});

const clearFraudLow = fraudOrchestrator.transition({
  claimId: "CLM-FRAUD-LOW",
  toState: "UNDER_ASSESSMENT",
  actor: { userId: "fraud-diana", role: "fraud_analyst" },
  input: {
    fraudRiskScore: 18,
    assessorId: "assessor-alice",
  },
  notes: "Provider & invoice cross-checked; low fraud risk",
});
console.log("Cleared FRAUD_CHECK -> UNDER_ASSESSMENT:", {
  ok: clearFraudLow.ok,
  state: clearFraudLow.ok ? clearFraudLow.claim.state : null,
  workflowVersion: clearFraudLow.ok ? clearFraudLow.claim.workflowVersion : null,
  fraudCleared: clearFraudLow.ok ? clearFraudLow.claim.data.fraudCleared : null,
});

/* -------------------------------------------------------------------------- */
/* STEP 16: HIGH-RISK CLAIM BLOCKED FROM ASSESSMENT & FAST-FAIL REJECTED      */
/* -------------------------------------------------------------------------- */
console.log("\n--- [STEP 16] High-Risk Claim (CLM-FRAUD-HIGH, score = 92 > 70) ---");
fraudOrchestrator.createClaim({
  id: "CLM-FRAUD-HIGH",
  data: {
    amount: 9500,
    policyLimit: 10000,
    submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
  },
});
fraudOrchestrator.transition({
  claimId: "CLM-FRAUD-HIGH",
  toState: "DOCUMENTS_VERIFIED",
  actor: { userId: "clerk-bob", role: "document_clerk" },
});
fraudOrchestrator.transition({
  claimId: "CLM-FRAUD-HIGH",
  toState: "FRAUD_CHECK",
  actor: { userId: "clerk-bob", role: "document_clerk" },
});

// 16A: Fraud analyst tries to forward score 92 to UNDER_ASSESSMENT -> BLOCKED!
const blockedHighRisk = fraudOrchestrator.transition({
  claimId: "CLM-FRAUD-HIGH",
  toState: "UNDER_ASSESSMENT",
  actor: { userId: "fraud-diana", role: "fraud_analyst" },
  input: {
    fraudRiskScore: 92,
    assessorId: "assessor-alice",
  },
});
console.log("Attempt FRAUD_CHECK -> UNDER_ASSESSMENT with score 92 (Must fail):", {
  ok: blockedHighRisk.ok,
  errorCode: !blockedHighRisk.ok ? blockedHighRisk.error.code : null,
  message: !blockedHighRisk.ok ? blockedHighRisk.error.message : null,
});

// 16B: Fraud analyst fast-fails claim directly FRAUD_CHECK -> REJECTED!
const fastFailReject = fraudOrchestrator.transition({
  claimId: "CLM-FRAUD-HIGH",
  toState: "REJECTED",
  actor: { userId: "fraud-diana", role: "fraud_analyst" },
  input: {
    fraudRiskScore: 92,
    rejectionReason: "Altered hospital receipt metadata (fraud score 92)",
  },
});
console.log("Fast-Fail FRAUD_CHECK -> REJECTED:", {
  ok: fastFailReject.ok,
  state: fastFailReject.ok ? fastFailReject.claim.state : null,
  workflowVersion: fastFailReject.ok ? fastFailReject.auditEntry.workflowVersion : null,
  auditTrailStates: fraudOrchestrator
    .getAuditTrail("CLM-FRAUD-HIGH")
    .filter((e) => e.outcome === "SUCCESS")
    .map((e) => e.to_state),
});

console.log("\n================================================================================");
console.log("            ALL 16 MANUAL VERIFICATION STEPS (v1.0.0 + v1.1.0) COMPLETE!        ");
console.log("================================================================================\n");
