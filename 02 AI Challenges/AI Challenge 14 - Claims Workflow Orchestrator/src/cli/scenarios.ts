import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaimsSession } from "../app/claims-session.js";
import type { ScenarioRunSummary, ScenarioSpec, ScenarioStepRecord } from "./types.js";

export type { ScenarioRunSummary, ScenarioStepRecord } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_PATH = resolve(__dirname, "../../docs/scenario-results.md");

const CLERK = { userId: "clerk-bob", role: "document_clerk" } as const;
const LEAD = { userId: "lead-sarah", role: "team_lead" } as const;
const ASSESSOR = { userId: "assessor-alice", role: "assessor" } as const;
const FINANCE = { userId: "finance-frank", role: "finance" } as const;
const SYSTEM_BOT = { userId: "workflow-bot", role: "system" } as const;

const SCENARIOS: readonly ScenarioSpec[] = [
  {
    id: "Scenario 1",
    title: "Happy Path",
    objective: "SUBMITTED -> DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT -> APPROVED -> PAYMENT_INITIATED -> CLOSED",
    claim: {
      id: "CLM-001",
      actor: { userId: "member-anna", role: "system" },
      notes: "Submitted inpatient hospitalization claim",
      createDetail: "Claim created with all 3 required documents ($6,800 / $10,000 limit)",
      amount: 6800,
      policyLimit: 10000,
    },
    steps: [
      { action: "SUBMITTED -> DOCUMENTS_VERIFIED", advanceMinutes: 15, toState: "DOCUMENTS_VERIFIED", actor: CLERK, notes: "Confirmed claim_form, medical_report, and itemized_receipt are valid" },
      { action: "DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT", advanceMinutes: 20, toState: "UNDER_ASSESSMENT", actor: LEAD, input: { assessorId: "assessor-alice" }, notes: "Assigned claim to assessor-alice" },
      { action: "UNDER_ASSESSMENT -> APPROVED", advanceMinutes: 45, toState: "APPROVED", actor: ASSESSOR, input: { assessmentReportComplete: true }, notes: "Assessment report completed; approved $6,800 within $10,000 policy limit" },
      { action: "APPROVED -> PAYMENT_INITIATED", advanceMinutes: 10, toState: "PAYMENT_INITIATED", actor: FINANCE, notes: "Initiated bank transfer against generated payment request" },
      { action: "PAYMENT_INITIATED -> CLOSED", advanceMinutes: 30, toState: "CLOSED", actor: FINANCE, input: { paymentConfirmed: true, paymentReference: "PAY-REF-20261015-01" }, notes: "Bank settlement confirmed; claim closed" },
    ],
    verify: ({ finalState, steps }) => finalState === "CLOSED" && steps.every((s) => s.outcome === "SUCCESS"),
  },
  {
    id: "Scenario 2",
    title: "Rejection Path",
    objective: "SUBMITTED -> DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT -> REJECTED -> CLOSED",
    claim: {
      id: "CLM-002",
      actor: { userId: "member-ben", role: "system" },
      notes: "Submitted outpatient cosmetic dental claim",
      createDetail: "Claim submitted with required documents",
      amount: 3400,
      policyLimit: 10000,
    },
    steps: [
      { action: "SUBMITTED -> DOCUMENTS_VERIFIED", advanceMinutes: 10, toState: "DOCUMENTS_VERIFIED", actor: CLERK, notes: "Documents verified present" },
      { action: "DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT", advanceMinutes: 15, toState: "UNDER_ASSESSMENT", actor: LEAD, input: { assessorId: "assessor-alice" }, notes: "Assigned to assessor-alice" },
      { action: "UNDER_ASSESSMENT -> REJECTED", advanceMinutes: 30, toState: "REJECTED", actor: ASSESSOR, input: { assessmentReportComplete: true, rejectionReason: "Elective cosmetic procedure excluded under Policy Clause 7.3" }, notes: "Denied per policy exclusion Clause 7.3" },
      { action: "REJECTED -> CLOSED", advanceMinutes: 120, toState: "CLOSED", actor: SYSTEM_BOT, input: { memberAcknowledged: true }, notes: "Member acknowledged rejection notice; claim archived" },
    ],
    verify: ({ finalState, finalData }) => finalState === "CLOSED" && Boolean(finalData.archived),
  },
  {
    id: "Scenario 3",
    title: "Request More Info Loop",
    objective: "SUBMITTED -> DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT -> PENDING_INFO -> DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT -> APPROVED -> PAYMENT_INITIATED -> CLOSED",
    claim: {
      id: "CLM-003",
      actor: { userId: "member-claire", role: "system" },
      notes: "Submitted surgical claim",
      createDetail: "Claim submitted",
      amount: 9100,
      policyLimit: 10000,
    },
    steps: [
      { action: "SUBMITTED -> DOCUMENTS_VERIFIED", advanceMinutes: 10, toState: "DOCUMENTS_VERIFIED", actor: CLERK, notes: "Initial documents verified" },
      { action: "DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT", advanceMinutes: 15, toState: "UNDER_ASSESSMENT", actor: LEAD, input: { assessorId: "assessor-alice" }, notes: "Assigned to assessor-alice" },
      { action: "UNDER_ASSESSMENT -> PENDING_INFO", advanceMinutes: 25, toState: "PENDING_INFO", actor: ASSESSOR, input: { missingInfoDescription: "Pre-operative pathology report required" }, notes: "Requested missing pathology report from member" },
      { action: "PENDING_INFO -> DOCUMENTS_VERIFIED", advanceMinutes: 60, toState: "DOCUMENTS_VERIFIED", actor: CLERK, input: { newDocuments: ["pathology_report.pdf"] }, notes: "Member uploaded pathology_report.pdf; verified valid" },
      { action: "DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT", advanceMinutes: 15, toState: "UNDER_ASSESSMENT", actor: LEAD, input: { assessorId: "assessor-alice" }, notes: "Returned to assessor-alice for reassessment" },
      { action: "UNDER_ASSESSMENT -> APPROVED", advanceMinutes: 30, toState: "APPROVED", actor: ASSESSOR, input: { assessmentReportComplete: true }, notes: "Pathology confirmed medical necessity; approved" },
      { action: "APPROVED -> PAYMENT_INITIATED", advanceMinutes: 10, toState: "PAYMENT_INITIATED", actor: FINANCE, notes: "Payment initiated" },
      { action: "PAYMENT_INITIATED -> CLOSED", advanceMinutes: 20, toState: "CLOSED", actor: FINANCE, input: { paymentConfirmed: true, paymentReference: "PAY-REF-20261015-03" }, notes: "Payment confirmed; claim closed" },
    ],
    verify: ({ finalState, finalVersion }) => finalState === "CLOSED" && finalVersion === 9,
  },
  {
    id: "Scenario 4",
    title: "Invalid Transition",
    objective: "Attempt SUBMITTED -> APPROVED (must fail with specific non-generic error)",
    claim: {
      id: "CLM-004",
      actor: { userId: "member-dan", role: "system" },
      notes: "Submitted claim",
      createDetail: "Claim created in SUBMITTED",
      amount: 5000,
      policyLimit: 10000,
    },
    steps: [
      { action: "Attempt SUBMITTED -> APPROVED (Illegal Jump)", advanceMinutes: 5, toState: "APPROVED", actor: ASSESSOR, notes: "Attempted direct jump to APPROVED before document verification" },
    ],
    verify: ({ finalState, steps }) =>
      finalState === "SUBMITTED" && Boolean(steps.at(-1)?.detail.includes("[INVALID_TRANSITION]")),
  },
  {
    id: "Scenario 5",
    title: "Unauthorized Role",
    objective: "Attempt transition with unauthorized role (must fail with role error)",
    claim: {
      id: "CLM-005",
      actor: { userId: "member-eva", role: "system" },
      notes: "Submitted claim",
      createDetail: "Claim created in SUBMITTED",
      amount: 4500,
      policyLimit: 10000,
    },
    steps: [
      { action: "Attempt SUBMITTED -> DOCUMENTS_VERIFIED with wrong role (finance)", advanceMinutes: 5, toState: "DOCUMENTS_VERIFIED", actor: FINANCE, notes: "Finance user attempting document verification" },
    ],
    verify: ({ finalState, steps }) =>
      finalState === "SUBMITTED" && Boolean(steps.at(-1)?.detail.includes("[UNAUTHORIZED_ROLE]")),
  },
  {
    id: "Scenario 6",
    title: "Precondition Enforcement Demo",
    objective: "Demonstrate precondition failure when claim amount exceeds policy limit",
    claim: {
      id: "CLM-006",
      actor: { userId: "member-gina", role: "system" },
      notes: "Submitted high-value surgery claim exceeding policy cap",
      createDetail: "Claim created with amount $14,500 > policy limit $10,000",
      amount: 14500,
      policyLimit: 10000,
    },
    steps: [
      { action: "SUBMITTED -> DOCUMENTS_VERIFIED", advanceMinutes: 10, toState: "DOCUMENTS_VERIFIED", actor: CLERK },
      { action: "DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT", advanceMinutes: 10, toState: "UNDER_ASSESSMENT", actor: LEAD, input: { assessorId: "assessor-alice" } },
      { action: "Attempt UNDER_ASSESSMENT -> APPROVED ($14,500 > $10,000 cap)", advanceMinutes: 15, toState: "APPROVED", actor: ASSESSOR, input: { assessmentReportComplete: true }, notes: "Attempted approval despite amount exceeding policy limit" },
    ],
    verify: ({ finalState, steps }) =>
      finalState === "UNDER_ASSESSMENT" && Boolean(steps.at(-1)?.detail.includes("[PRECONDITION_FAILED]")),
  },
  {
    id: "Scenario 7",
    title: "Cycle Detection Limit (Max 3 Cycles)",
    objective: 'Allow 3 info-request loops and block the 4th with "Maximum information requests exceeded — escalate to team lead"',
    claim: {
      id: "CLM-007",
      actor: { userId: "member-hank", role: "system" },
      notes: "Submitted claim requiring repeated info follow-ups",
      createDetail: "Claim created in SUBMITTED",
      amount: 5200,
      policyLimit: 10000,
    },
    steps: [
      { action: "SUBMITTED -> DOCUMENTS_VERIFIED", advanceMinutes: 10, toState: "DOCUMENTS_VERIFIED", actor: CLERK },
      { action: "DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT", advanceMinutes: 10, toState: "UNDER_ASSESSMENT", actor: LEAD, input: { assessorId: "assessor-alice" } },
      ...[1, 2, 3].flatMap((loop) => [
        { action: `Loop #${loop}: UNDER_ASSESSMENT -> PENDING_INFO`, advanceMinutes: 15, toState: "PENDING_INFO", actor: ASSESSOR, input: { missingInfoDescription: `Missing clinical attachment #${loop}` }, notes: `Information request #${loop}` },
        { action: `Loop #${loop}: PENDING_INFO -> DOCUMENTS_VERIFIED`, advanceMinutes: 30, toState: "DOCUMENTS_VERIFIED", actor: CLERK, input: { newDocuments: [`attachment_${loop}.pdf`] }, notes: `Received attachment_${loop}.pdf` },
        { action: `Loop #${loop}: DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT`, advanceMinutes: 10, toState: "UNDER_ASSESSMENT", actor: LEAD, input: { assessorId: "assessor-alice" }, notes: `Re-assigned after attachment #${loop}` },
      ]),
      { action: "Attempt #4: UNDER_ASSESSMENT -> PENDING_INFO (Exceeds Max 3 Cycles)", advanceMinutes: 15, toState: "PENDING_INFO", actor: ASSESSOR, input: { missingInfoDescription: "4th request" }, notes: "4th info request attempt" },
    ],
    verify: ({ finalState, steps }) =>
      finalState === "UNDER_ASSESSMENT" &&
      steps.at(-1)?.detail ===
        "[CYCLE_LIMIT_EXCEEDED] Maximum information requests exceeded — escalate to team lead",
  },
];

function runScenario(spec: ScenarioSpec): ScenarioRunSummary {
  const session = new ClaimsSession({ initialClockIso: "2026-10-15T08:00:00.000Z" });
  const orchestrator = session.getOrchestrator();
  const defaultDocs = session.getWorkflow().defaults.requiredDocuments;

  const created = orchestrator.createClaim({
    id: spec.claim.id,
    actor: spec.claim.actor,
    notes: spec.claim.notes,
    data: {
      amount: spec.claim.amount,
      policyLimit: spec.claim.policyLimit,
      submittedDocuments: spec.claim.submittedDocuments
        ? [...spec.claim.submittedDocuments]
        : [...defaultDocs],
    },
  });

  const steps: ScenarioStepRecord[] = [
    {
      stepNumber: 1,
      action: "Create Claim (-> SUBMITTED)",
      actor: `${spec.claim.actor.userId} (${spec.claim.actor.role})`,
      outcome: "SUCCESS",
      resultingState: created.state,
      detail: spec.claim.createDetail,
      sideEffects: [],
    },
  ];

  for (const step of spec.steps) {
    if (step.advanceMinutes) session.advanceClock({ minutes: step.advanceMinutes });
    const currentState = orchestrator.getClaim(created.id)?.state ?? created.state;
    const result = orchestrator.transition({
      claimId: created.id,
      toState: step.toState,
      actor: step.actor,
      ...(step.input ? { input: step.input } : {}),
      ...(step.notes ? { notes: step.notes } : {}),
    });

    const actorLabel = `${step.actor.userId} (${step.actor.role})`;
    steps.push(
      result.ok
        ? {
            stepNumber: steps.length + 1,
            action: step.action,
            actor: actorLabel,
            outcome: "SUCCESS",
            resultingState: result.claim.state,
            detail: result.auditEntry.reason,
            sideEffects: result.sideEffects.map((s) =>
              s.target ? `[${s.type} -> ${s.target}] ${s.description}` : `[${s.type}] ${s.description}`
            ),
          }
        : {
            stepNumber: steps.length + 1,
            action: step.action,
            actor: actorLabel,
            outcome: "REJECTED",
            resultingState: result.claim?.state ?? currentState,
            detail: `[${result.error.code}] ${result.error.message}`,
            sideEffects: [],
          }
    );
  }

  const finalClaim = orchestrator.getClaim(created.id)!;
  return {
    id: spec.id,
    title: spec.title,
    objective: spec.objective,
    claimId: created.id,
    finalState: finalClaim.state,
    finalVersion: finalClaim.version,
    passedExpectation: spec.verify({
      finalState: finalClaim.state,
      finalVersion: finalClaim.version,
      finalData: finalClaim.data,
      steps,
    }),
    steps,
    auditTrail: orchestrator.getAuditTrail(created.id),
  };
}

export function executeAllScenarios(): readonly ScenarioRunSummary[] {
  return SCENARIOS.map(runScenario);
}

const escapeMd = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderScenariosMarkdown(summaries: readonly ScenarioRunSummary[]): string {
  const lines = [
    "# Claims Workflow Orchestrator — Scenario Results & Audit Trails",
    "",
    "Generated by `npm run scenarios` against `config/claims-workflow.yaml`.",
    "",
    "## Summary Matrix",
    "",
    "| Scenario | Claim ID | Final State | Claim Version | Audit Entries | Status |",
    "| :--- | :--- | :--- | :---: | :---: | :---: |",
    ...summaries.map(
      (s) =>
        `| **${s.id}: ${s.title}** | \`${s.claimId}\` | \`${s.finalState}\` | \`v${s.finalVersion}\` | ${s.auditTrail.length} | ${s.passedExpectation ? "PASS" : "FAIL"} |`
    ),
  ];

  for (const s of summaries) {
    lines.push(
      "",
      "---",
      "",
      `## ${s.id} — ${s.title} (\`${s.claimId}\`)`,
      "",
      `- **Objective:** ${s.objective}`,
      `- **Final State:** \`${s.finalState}\` (version \`v${s.finalVersion}\`)`,
      `- **Expectation Met:** \`${s.passedExpectation}\``,
      "",
      "### Execution Steps & Side Effects",
      "",
      "| # | Action | Actor | Outcome | Resulting State | Details & Side Effects |",
      "| :---: | :--- | :--- | :---: | :--- | :--- |",
      ...s.steps.map((step) => {
        const fx = step.sideEffects.length > 0 ? `<br>Side effects: ${step.sideEffects.join("; ")}` : "";
        return `| ${step.stepNumber} | ${escapeMd(step.action)} | \`${escapeMd(step.actor)}\` | \`${step.outcome}\` | \`${step.resultingState}\` | ${escapeMd(step.detail)}${escapeMd(fx)} |`;
      }),
      "",
      "### Immutable Audit Trail Output",
      "",
      "| Audit ID | Timestamp | From State | To State | Triggered By (`userId` / `role`) | Outcome | Reason / Notes | Changed Fields (`delta`) |",
      "| :--- | :--- | :--- | :--- | :--- | :---: | :--- | :--- |",
      ...s.auditTrail.map((entry) => {
        const deltaKeys = Object.keys(entry.delta);
        const deltaSummary =
          deltaKeys.length > 0
            ? deltaKeys
                .map((k) =>
                  entry.delta[k]?.removed ? `${k}: <removed>` : `${k}: ${JSON.stringify(entry.delta[k]?.after)}`
                )
                .join(", ")
            : "—";
        return `| \`${entry.id}\` | \`${entry.timestamp}\` | \`${entry.from_state ?? "null"}\` | \`${entry.to_state}\` | \`${entry.triggered_by.userId}\` (\`${entry.triggered_by.role}\`) | \`${entry.outcome}\` | ${escapeMd(entry.reason)} | ${escapeMd(deltaSummary)} |`;
      })
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function printScenariosToConsole(summaries: readonly ScenarioRunSummary[]): void {
  console.log("================================================================================");
  console.log("          CLAIMS WORKFLOW ORCHESTRATOR — SCENARIO EXECUTION REPORT              ");
  console.log("================================================================================\n");
  for (const s of summaries) {
    console.log(`[${s.passedExpectation ? "PASS" : "FAIL"}] ${s.id}: ${s.title} (${s.claimId}) -> ${s.finalState} (v${s.finalVersion})`);
    for (const step of s.steps) {
      console.log(`  ${step.stepNumber}. [${step.outcome}] ${step.action} by ${step.actor} -> ${step.resultingState}`);
    }
    console.log("");
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const summaries = executeAllScenarios();
  printScenariosToConsole(summaries);
  mkdirSync(dirname(DEFAULT_OUTPUT_PATH), { recursive: true });
  writeFileSync(DEFAULT_OUTPUT_PATH, renderScenariosMarkdown(summaries), "utf-8");
  console.log(`Saved full scenario report and audit trails to: ${DEFAULT_OUTPUT_PATH}`);
  if (summaries.some((s) => !s.passedExpectation)) process.exitCode = 1;
}
