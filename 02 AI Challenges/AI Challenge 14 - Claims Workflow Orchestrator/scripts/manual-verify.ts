import { resolve } from "node:path";
import { loadWorkflowConfig } from "../src/engine/config-schema.js";
import { WorkflowOrchestrator } from "../src/engine/orchestrator.js";
import { ConsoleOutboxDispatcher } from "../src/engine/outbox-store.js";
import { replayClaimHistory } from "../src/engine/audit-store.js";

// Load the declarative workflow configuration
const configPath = resolve(import.meta.dirname, "../config/claims-workflow.yaml");
const config = loadWorkflowConfig(configPath);

console.log("================================================================================");
console.log("          CLAIMS WORKFLOW ORCHESTRATOR — INTERACTIVE MANUAL VERIFICATION        ");
console.log("================================================================================\n");

// Initialize orchestrator with console dispatcher so you can see side effects live!
const orchestrator = new WorkflowOrchestrator(config, {
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
console.log("\n--- [STEP 4] Negative Test: Try DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT without Assessor ---");
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
console.log("\n--- [STEP 5] Transition: DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT with Assessor Assigned ---");
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
const loopClaim = orchestrator.createClaim({
  id: "CLM-LOOP",
  data: {
    submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
  },
});

// Setup claim in UNDER_ASSESSMENT
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

// Run 3 cycles of requesting more info and receiving it
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

  console.log(`Cycle #${cycle}: PENDING_INFO (ok: ${reqInfo.ok}) -> DOCUMENTS_VERIFIED (ok: ${docRes.ok}) -> UNDER_ASSESSMENT (ok: ${reassess.ok})`);
}

// 4th Attempt to request info: MUST FAIL WITH EXACT SPEC MESSAGE
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
console.log(`Total Audit Entries for CLM-2026: ${auditEntries.length} (including SUCCESS & DENIED attempts)`);

// Test Object.freeze tamper protection
try {
  (auditEntries[0] as any).reason = "TAMPERED_BY_ATTACKER";
  console.log("ERROR: Mutation succeeded (should not happen!)");
} catch (err) {
  console.log("Tamper Protection Verified: Modifying audit entry threw TypeError ->", (err as Error).message);
}

// Replay history purely from audit log
const replayed = replayClaimHistory("CLM-2026", auditEntries);
console.log("\nReplayed Claim State from Audit Log:", {
  claimId: replayed.claimId,
  currentState: replayed.currentState,
  version: replayed.version,
  deniedAttempts: replayed.deniedAttempts,
  stateHistory: replayed.stateHistory,
  finalDataKeys: Object.keys(replayed.data),
});

console.log("\n================================================================================");
console.log("                   ALL MANUAL VERIFICATION STEPS COMPLETE!                     ");
console.log("================================================================================\n");
