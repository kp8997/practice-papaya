import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditEntry, TransitionResult } from "../domain/types.js";
import { loadWorkflowConfig } from "../engine/config-schema.js";
import { WorkflowOrchestrator } from "../engine/orchestrator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = resolve(__dirname, "../../config/claims-workflow.yaml");
const DEFAULT_OUTPUT_PATH = resolve(__dirname, "../../docs/scenario-results.md");

export interface ScenarioStepRecord {
  readonly stepNumber: number;
  readonly action: string;
  readonly actor: string;
  readonly outcome: "SUCCESS" | "REJECTED";
  readonly resultingState: string;
  readonly detail: string;
  readonly sideEffects: readonly string[];
}

export interface ScenarioRunSummary {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly claimId: string;
  readonly finalState: string;
  readonly finalVersion: number;
  readonly passedExpectation: boolean;
  readonly steps: readonly ScenarioStepRecord[];
  readonly auditTrail: readonly AuditEntry[];
}

function createScenarioHarness(startIso = "2026-10-15T08:00:00.000Z") {
  const config = loadWorkflowConfig(DEFAULT_CONFIG_PATH);
  let clockMs = Date.parse(startIso);

  const advanceMinutes = (minutes: number) => {
    clockMs += minutes * 60 * 1000;
  };

  const orchestrator = new WorkflowOrchestrator(config, {
    clock: {
      now: () => new Date(clockMs),
    },
  });

  return { orchestrator, advanceMinutes };
}

function recordTransitionStep(
  steps: ScenarioStepRecord[],
  action: string,
  actorLabel: string,
  result: TransitionResult,
  fallbackState: string
): void {
  if (result.ok) {
    steps.push({
      stepNumber: steps.length + 1,
      action,
      actor: actorLabel,
      outcome: "SUCCESS",
      resultingState: result.claim.state,
      detail: result.auditEntry.reason,
      sideEffects: result.sideEffects.map((s) =>
        s.target ? `[${s.type} -> ${s.target}] ${s.description}` : `[${s.type}] ${s.description}`
      ),
    });
  } else {
    steps.push({
      stepNumber: steps.length + 1,
      action,
      actor: actorLabel,
      outcome: "REJECTED",
      resultingState: result.claim?.state ?? fallbackState,
      detail: `[${result.error.code}] ${result.error.message}`,
      sideEffects: [],
    });
  }
}

export function executeAllScenarios(): readonly ScenarioRunSummary[] {
  const summaries: ScenarioRunSummary[] = [];

  /* ------------------------------------------------------------------------ */
  /* Scenario 1: Happy Path                                                   */
  /* ------------------------------------------------------------------------ */
  {
    const { orchestrator, advanceMinutes } = createScenarioHarness();
    const steps: ScenarioStepRecord[] = [];
    const claim = orchestrator.createClaim({
      id: "CLM-001",
      actor: { userId: "member-anna", role: "system" },
      notes: "Submitted inpatient hospitalization claim",
      data: {
        amount: 6800,
        policyLimit: 10000,
        submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
      },
    });
    steps.push({
      stepNumber: 1,
      action: "Create Claim (-> SUBMITTED)",
      actor: "member-anna (system)",
      outcome: "SUCCESS",
      resultingState: claim.state,
      detail: "Claim created with all 3 required documents ($6,800 / $10,000 limit)",
      sideEffects: [],
    });

    advanceMinutes(15);
    recordTransitionStep(
      steps,
      "SUBMITTED -> DOCUMENTS_VERIFIED",
      "clerk-bob (document_clerk)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-bob", role: "document_clerk" },
        notes: "Confirmed claim_form, medical_report, and itemized_receipt are valid",
      }),
      claim.state
    );

    advanceMinutes(20);
    recordTransitionStep(
      steps,
      "DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT",
      "lead-sarah (team_lead)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-sarah", role: "team_lead" },
        input: { assessorId: "assessor-alice" },
        notes: "Assigned claim to assessor-alice",
      }),
      "DOCUMENTS_VERIFIED"
    );

    advanceMinutes(45);
    recordTransitionStep(
      steps,
      "UNDER_ASSESSMENT -> APPROVED",
      "assessor-alice (assessor)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "APPROVED",
        actor: { userId: "assessor-alice", role: "assessor" },
        input: { assessmentReportComplete: true },
        notes: "Assessment report completed; approved $6,800 within $10,000 policy limit",
      }),
      "UNDER_ASSESSMENT"
    );

    advanceMinutes(10);
    recordTransitionStep(
      steps,
      "APPROVED -> PAYMENT_INITIATED",
      "finance-frank (finance)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "PAYMENT_INITIATED",
        actor: { userId: "finance-frank", role: "finance" },
        notes: "Initiated bank transfer against generated payment request",
      }),
      "APPROVED"
    );

    advanceMinutes(30);
    recordTransitionStep(
      steps,
      "PAYMENT_INITIATED -> CLOSED",
      "finance-frank (finance)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "CLOSED",
        actor: { userId: "finance-frank", role: "finance" },
        input: { paymentConfirmed: true, paymentReference: "PAY-REF-20261015-01" },
        notes: "Bank settlement confirmed; claim closed",
      }),
      "PAYMENT_INITIATED"
    );

    const finalClaim = orchestrator.getClaim(claim.id)!;
    summaries.push({
      id: "Scenario 1",
      title: "Happy Path",
      objective:
        "SUBMITTED -> DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT -> APPROVED -> PAYMENT_INITIATED -> CLOSED",
      claimId: claim.id,
      finalState: finalClaim.state,
      finalVersion: finalClaim.version,
      passedExpectation: finalClaim.state === "CLOSED" && steps.every((s) => s.outcome === "SUCCESS"),
      steps,
      auditTrail: orchestrator.getAuditTrail(claim.id),
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Scenario 2: Rejection Path                                               */
  /* ------------------------------------------------------------------------ */
  {
    const { orchestrator, advanceMinutes } = createScenarioHarness();
    const steps: ScenarioStepRecord[] = [];
    const claim = orchestrator.createClaim({
      id: "CLM-002",
      actor: { userId: "member-ben", role: "system" },
      notes: "Submitted outpatient cosmetic dental claim",
      data: {
        amount: 3400,
        policyLimit: 10000,
        submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
      },
    });
    steps.push({
      stepNumber: 1,
      action: "Create Claim (-> SUBMITTED)",
      actor: "member-ben (system)",
      outcome: "SUCCESS",
      resultingState: claim.state,
      detail: "Claim submitted with required documents",
      sideEffects: [],
    });

    advanceMinutes(10);
    recordTransitionStep(
      steps,
      "SUBMITTED -> DOCUMENTS_VERIFIED",
      "clerk-bob (document_clerk)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-bob", role: "document_clerk" },
        notes: "Documents verified present",
      }),
      claim.state
    );

    advanceMinutes(15);
    recordTransitionStep(
      steps,
      "DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT",
      "lead-sarah (team_lead)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-sarah", role: "team_lead" },
        input: { assessorId: "assessor-alice" },
        notes: "Assigned to assessor-alice",
      }),
      "DOCUMENTS_VERIFIED"
    );

    advanceMinutes(30);
    recordTransitionStep(
      steps,
      "UNDER_ASSESSMENT -> REJECTED",
      "assessor-alice (assessor)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "REJECTED",
        actor: { userId: "assessor-alice", role: "assessor" },
        input: {
          assessmentReportComplete: true,
          rejectionReason: "Elective cosmetic procedure excluded under Policy Clause 7.3",
        },
        notes: "Denied per policy exclusion Clause 7.3",
      }),
      "UNDER_ASSESSMENT"
    );

    advanceMinutes(120);
    recordTransitionStep(
      steps,
      "REJECTED -> CLOSED",
      "workflow-bot (system)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "CLOSED",
        actor: { userId: "workflow-bot", role: "system" },
        input: { memberAcknowledged: true },
        notes: "Member acknowledged rejection notice; claim archived",
      }),
      "REJECTED"
    );

    const finalClaim = orchestrator.getClaim(claim.id)!;
    summaries.push({
      id: "Scenario 2",
      title: "Rejection Path",
      objective: "SUBMITTED -> DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT -> REJECTED -> CLOSED",
      claimId: claim.id,
      finalState: finalClaim.state,
      finalVersion: finalClaim.version,
      passedExpectation: finalClaim.state === "CLOSED" && Boolean(finalClaim.data.archived),
      steps,
      auditTrail: orchestrator.getAuditTrail(claim.id),
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Scenario 3: Request More Info Loop                                       */
  /* ------------------------------------------------------------------------ */
  {
    const { orchestrator, advanceMinutes } = createScenarioHarness();
    const steps: ScenarioStepRecord[] = [];
    const claim = orchestrator.createClaim({
      id: "CLM-003",
      actor: { userId: "member-claire", role: "system" },
      notes: "Submitted surgical claim",
      data: {
        amount: 9100,
        policyLimit: 10000,
        submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
      },
    });
    steps.push({
      stepNumber: 1,
      action: "Create Claim (-> SUBMITTED)",
      actor: "member-claire (system)",
      outcome: "SUCCESS",
      resultingState: claim.state,
      detail: "Claim submitted",
      sideEffects: [],
    });

    advanceMinutes(10);
    recordTransitionStep(
      steps,
      "SUBMITTED -> DOCUMENTS_VERIFIED",
      "clerk-bob (document_clerk)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-bob", role: "document_clerk" },
        notes: "Initial documents verified",
      }),
      "SUBMITTED"
    );

    advanceMinutes(15);
    recordTransitionStep(
      steps,
      "DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT",
      "lead-sarah (team_lead)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-sarah", role: "team_lead" },
        input: { assessorId: "assessor-alice" },
        notes: "Assigned to assessor-alice",
      }),
      "DOCUMENTS_VERIFIED"
    );

    advanceMinutes(25);
    recordTransitionStep(
      steps,
      "UNDER_ASSESSMENT -> PENDING_INFO",
      "assessor-alice (assessor)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "PENDING_INFO",
        actor: { userId: "assessor-alice", role: "assessor" },
        input: { missingInfoDescription: "Pre-operative pathology report required" },
        notes: "Requested missing pathology report from member",
      }),
      "UNDER_ASSESSMENT"
    );

    advanceMinutes(60);
    recordTransitionStep(
      steps,
      "PENDING_INFO -> DOCUMENTS_VERIFIED",
      "clerk-bob (document_clerk)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-bob", role: "document_clerk" },
        input: { newDocuments: ["pathology_report.pdf"] },
        notes: "Member uploaded pathology_report.pdf; verified valid",
      }),
      "PENDING_INFO"
    );

    advanceMinutes(15);
    recordTransitionStep(
      steps,
      "DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT",
      "lead-sarah (team_lead)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-sarah", role: "team_lead" },
        input: { assessorId: "assessor-alice" },
        notes: "Returned to assessor-alice for reassessment",
      }),
      "DOCUMENTS_VERIFIED"
    );

    advanceMinutes(30);
    recordTransitionStep(
      steps,
      "UNDER_ASSESSMENT -> APPROVED",
      "assessor-alice (assessor)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "APPROVED",
        actor: { userId: "assessor-alice", role: "assessor" },
        input: { assessmentReportComplete: true },
        notes: "Pathology confirmed medical necessity; approved",
      }),
      "UNDER_ASSESSMENT"
    );

    advanceMinutes(10);
    recordTransitionStep(
      steps,
      "APPROVED -> PAYMENT_INITIATED",
      "finance-frank (finance)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "PAYMENT_INITIATED",
        actor: { userId: "finance-frank", role: "finance" },
        notes: "Payment initiated",
      }),
      "APPROVED"
    );

    advanceMinutes(20);
    recordTransitionStep(
      steps,
      "PAYMENT_INITIATED -> CLOSED",
      "finance-frank (finance)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "CLOSED",
        actor: { userId: "finance-frank", role: "finance" },
        input: { paymentConfirmed: true, paymentReference: "PAY-REF-20261015-03" },
        notes: "Payment confirmed; claim closed",
      }),
      "PAYMENT_INITIATED"
    );

    const finalClaim = orchestrator.getClaim(claim.id)!;
    summaries.push({
      id: "Scenario 3",
      title: "Request More Info Loop",
      objective:
        "SUBMITTED -> DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT -> PENDING_INFO -> DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT -> APPROVED -> PAYMENT_INITIATED -> CLOSED",
      claimId: claim.id,
      finalState: finalClaim.state,
      finalVersion: finalClaim.version,
      passedExpectation: finalClaim.state === "CLOSED" && finalClaim.version === 9,
      steps,
      auditTrail: orchestrator.getAuditTrail(claim.id),
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Scenario 4: Invalid Transition (SUBMITTED -> APPROVED)                   */
  /* ------------------------------------------------------------------------ */
  {
    const { orchestrator, advanceMinutes } = createScenarioHarness();
    const steps: ScenarioStepRecord[] = [];
    const claim = orchestrator.createClaim({
      id: "CLM-004",
      actor: { userId: "member-dan", role: "system" },
      notes: "Submitted claim",
      data: {
        amount: 5000,
        policyLimit: 10000,
        submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
      },
    });
    steps.push({
      stepNumber: 1,
      action: "Create Claim (-> SUBMITTED)",
      actor: "member-dan (system)",
      outcome: "SUCCESS",
      resultingState: claim.state,
      detail: "Claim created in SUBMITTED",
      sideEffects: [],
    });

    advanceMinutes(5);
    const invalidAttempt = orchestrator.transition({
      claimId: claim.id,
      toState: "APPROVED",
      actor: { userId: "assessor-alice", role: "assessor" },
      notes: "Attempted direct jump to APPROVED before document verification",
    });
    recordTransitionStep(
      steps,
      "Attempt SUBMITTED -> APPROVED (Illegal Jump)",
      "assessor-alice (assessor)",
      invalidAttempt,
      claim.state
    );

    const finalClaim = orchestrator.getClaim(claim.id)!;
    summaries.push({
      id: "Scenario 4",
      title: "Invalid Transition",
      objective: "Attempt SUBMITTED -> APPROVED (must fail with specific non-generic error)",
      claimId: claim.id,
      finalState: finalClaim.state,
      finalVersion: finalClaim.version,
      passedExpectation:
        !invalidAttempt.ok &&
        invalidAttempt.error.code === "INVALID_TRANSITION" &&
        finalClaim.state === "SUBMITTED",
      steps,
      auditTrail: orchestrator.getAuditTrail(claim.id),
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Scenario 5: Unauthorized Role                                            */
  /* ------------------------------------------------------------------------ */
  {
    const { orchestrator, advanceMinutes } = createScenarioHarness();
    const steps: ScenarioStepRecord[] = [];
    const claim = orchestrator.createClaim({
      id: "CLM-005",
      actor: { userId: "member-eva", role: "system" },
      notes: "Submitted claim",
      data: {
        amount: 4500,
        policyLimit: 10000,
        submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
      },
    });
    steps.push({
      stepNumber: 1,
      action: "Create Claim (-> SUBMITTED)",
      actor: "member-eva (system)",
      outcome: "SUCCESS",
      resultingState: claim.state,
      detail: "Claim created in SUBMITTED",
      sideEffects: [],
    });

    advanceMinutes(5);
    const wrongRoleAttempt = orchestrator.transition({
      claimId: claim.id,
      toState: "DOCUMENTS_VERIFIED",
      actor: { userId: "finance-frank", role: "finance" },
      notes: "Finance user attempting document verification",
    });
    recordTransitionStep(
      steps,
      "Attempt SUBMITTED -> DOCUMENTS_VERIFIED with wrong role (finance)",
      "finance-frank (finance)",
      wrongRoleAttempt,
      claim.state
    );

    const finalClaim = orchestrator.getClaim(claim.id)!;
    summaries.push({
      id: "Scenario 5",
      title: "Unauthorized Role",
      objective: "Attempt transition with unauthorized role (must fail with role error)",
      claimId: claim.id,
      finalState: finalClaim.state,
      finalVersion: finalClaim.version,
      passedExpectation:
        !wrongRoleAttempt.ok &&
        wrongRoleAttempt.error.code === "UNAUTHORIZED_ROLE" &&
        finalClaim.state === "SUBMITTED",
      steps,
      auditTrail: orchestrator.getAuditTrail(claim.id),
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Scenario 6 (Evaluation Criterion): Precondition Failure Demo             */
  /* ------------------------------------------------------------------------ */
  {
    const { orchestrator, advanceMinutes } = createScenarioHarness();
    const steps: ScenarioStepRecord[] = [];
    const claim = orchestrator.createClaim({
      id: "CLM-006",
      actor: { userId: "member-gina", role: "system" },
      notes: "Submitted high-value surgery claim exceeding policy cap",
      data: {
        amount: 14500,
        policyLimit: 10000,
        submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
      },
    });
    steps.push({
      stepNumber: 1,
      action: "Create Claim (-> SUBMITTED)",
      actor: "member-gina (system)",
      outcome: "SUCCESS",
      resultingState: claim.state,
      detail: "Claim created with amount $14,500 > policy limit $10,000",
      sideEffects: [],
    });

    advanceMinutes(10);
    recordTransitionStep(
      steps,
      "SUBMITTED -> DOCUMENTS_VERIFIED",
      "clerk-bob (document_clerk)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-bob", role: "document_clerk" },
      }),
      "SUBMITTED"
    );

    advanceMinutes(10);
    recordTransitionStep(
      steps,
      "DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT",
      "lead-sarah (team_lead)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-sarah", role: "team_lead" },
        input: { assessorId: "assessor-alice" },
      }),
      "DOCUMENTS_VERIFIED"
    );

    advanceMinutes(15);
    const overCapAttempt = orchestrator.transition({
      claimId: claim.id,
      toState: "APPROVED",
      actor: { userId: "assessor-alice", role: "assessor" },
      input: { assessmentReportComplete: true },
      notes: "Attempted approval despite amount exceeding policy limit",
    });
    recordTransitionStep(
      steps,
      "Attempt UNDER_ASSESSMENT -> APPROVED ($14,500 > $10,000 cap)",
      "assessor-alice (assessor)",
      overCapAttempt,
      "UNDER_ASSESSMENT"
    );

    const finalClaim = orchestrator.getClaim(claim.id)!;
    summaries.push({
      id: "Scenario 6",
      title: "Precondition Enforcement Demo",
      objective: "Demonstrate precondition failure when claim amount exceeds policy limit",
      claimId: claim.id,
      finalState: finalClaim.state,
      finalVersion: finalClaim.version,
      passedExpectation:
        !overCapAttempt.ok &&
        overCapAttempt.error.code === "PRECONDITION_FAILED" &&
        finalClaim.state === "UNDER_ASSESSMENT",
      steps,
      auditTrail: orchestrator.getAuditTrail(claim.id),
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Scenario 7 (Evaluation Criterion): Cycle Limit Exceeded on 4th Attempt   */
  /* ------------------------------------------------------------------------ */
  {
    const { orchestrator, advanceMinutes } = createScenarioHarness();
    const steps: ScenarioStepRecord[] = [];
    const claim = orchestrator.createClaim({
      id: "CLM-007",
      actor: { userId: "member-hank", role: "system" },
      notes: "Submitted claim requiring repeated info follow-ups",
      data: {
        amount: 5200,
        policyLimit: 10000,
        submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
      },
    });
    steps.push({
      stepNumber: 1,
      action: "Create Claim (-> SUBMITTED)",
      actor: "member-hank (system)",
      outcome: "SUCCESS",
      resultingState: claim.state,
      detail: "Claim created in SUBMITTED",
      sideEffects: [],
    });

    advanceMinutes(10);
    recordTransitionStep(
      steps,
      "SUBMITTED -> DOCUMENTS_VERIFIED",
      "clerk-bob (document_clerk)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-bob", role: "document_clerk" },
      }),
      "SUBMITTED"
    );
    advanceMinutes(10);
    recordTransitionStep(
      steps,
      "DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT",
      "lead-sarah (team_lead)",
      orchestrator.transition({
        claimId: claim.id,
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-sarah", role: "team_lead" },
        input: { assessorId: "assessor-alice" },
      }),
      "DOCUMENTS_VERIFIED"
    );

    for (let loop = 1; loop <= 3; loop++) {
      advanceMinutes(15);
      recordTransitionStep(
        steps,
        `Loop #${loop}: UNDER_ASSESSMENT -> PENDING_INFO`,
        "assessor-alice (assessor)",
        orchestrator.transition({
          claimId: claim.id,
          toState: "PENDING_INFO",
          actor: { userId: "assessor-alice", role: "assessor" },
          input: { missingInfoDescription: `Missing clinical attachment #${loop}` },
          notes: `Information request #${loop}`,
        }),
        "UNDER_ASSESSMENT"
      );
      advanceMinutes(30);
      recordTransitionStep(
        steps,
        `Loop #${loop}: PENDING_INFO -> DOCUMENTS_VERIFIED`,
        "clerk-bob (document_clerk)",
        orchestrator.transition({
          claimId: claim.id,
          toState: "DOCUMENTS_VERIFIED",
          actor: { userId: "clerk-bob", role: "document_clerk" },
          input: { newDocuments: [`attachment_${loop}.pdf`] },
          notes: `Received attachment_${loop}.pdf`,
        }),
        "PENDING_INFO"
      );
      advanceMinutes(10);
      recordTransitionStep(
        steps,
        `Loop #${loop}: DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT`,
        "lead-sarah (team_lead)",
        orchestrator.transition({
          claimId: claim.id,
          toState: "UNDER_ASSESSMENT",
          actor: { userId: "lead-sarah", role: "team_lead" },
          input: { assessorId: "assessor-alice" },
          notes: `Re-assigned after attachment #${loop}`,
        }),
        "DOCUMENTS_VERIFIED"
      );
    }

    advanceMinutes(15);
    const fourthAttempt = orchestrator.transition({
      claimId: claim.id,
      toState: "PENDING_INFO",
      actor: { userId: "assessor-alice", role: "assessor" },
      input: { missingInfoDescription: "4th request" },
      notes: "4th info request attempt",
    });
    recordTransitionStep(
      steps,
      "Attempt #4: UNDER_ASSESSMENT -> PENDING_INFO (Exceeds Max 3 Cycles)",
      "assessor-alice (assessor)",
      fourthAttempt,
      "UNDER_ASSESSMENT"
    );

    const finalClaim = orchestrator.getClaim(claim.id)!;
    summaries.push({
      id: "Scenario 7",
      title: "Cycle Detection Limit (Max 3 Cycles)",
      objective:
        'Allow 3 info-request loops and block the 4th with "Maximum information requests exceeded — escalate to team lead"',
      claimId: claim.id,
      finalState: finalClaim.state,
      finalVersion: finalClaim.version,
      passedExpectation:
        !fourthAttempt.ok &&
        fourthAttempt.error.code === "CYCLE_LIMIT_EXCEEDED" &&
        fourthAttempt.error.message ===
          "Maximum information requests exceeded — escalate to team lead",
      steps,
      auditTrail: orchestrator.getAuditTrail(claim.id),
    });
  }

  return summaries;
}

function escapeMdCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderScenariosMarkdown(summaries: readonly ScenarioRunSummary[]): string {
  const lines: string[] = [
    "# Claims Workflow Orchestrator — Scenario Results & Audit Trails",
    "",
    "Generated by `npm run scenarios` against `config/claims-workflow.yaml`.",
    "",
    "## Summary Matrix",
    "",
    "| Scenario | Claim ID | Final State | Claim Version | Audit Entries | Status |",
    "| :--- | :--- | :--- | :---: | :---: | :---: |",
  ];

  for (const s of summaries) {
    lines.push(
      `| **${s.id}: ${s.title}** | \`${s.claimId}\` | \`${s.finalState}\` | \`v${s.finalVersion}\` | ${s.auditTrail.length} | ${s.passedExpectation ? "PASS" : "FAIL"} |`
    );
  }

  for (const s of summaries) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(`## ${s.id} — ${s.title} (\`${s.claimId}\`)`);
    lines.push("");
    lines.push(`- **Objective:** ${s.objective}`);
    lines.push(`- **Final State:** \`${s.finalState}\` (version \`v${s.finalVersion}\`)`);
    lines.push(`- **Expectation Met:** \`${s.passedExpectation}\``);
    lines.push("");
    lines.push("### Execution Steps & Side Effects");
    lines.push("");
    lines.push("| # | Action | Actor | Outcome | Resulting State | Details & Side Effects |");
    lines.push("| :---: | :--- | :--- | :---: | :--- | :--- |");

    for (const step of s.steps) {
      const fx =
        step.sideEffects.length > 0 ? `<br>Side effects: ${step.sideEffects.join("; ")}` : "";
      lines.push(
        `| ${step.stepNumber} | ${escapeMdCell(step.action)} | \`${escapeMdCell(step.actor)}\` | \`${step.outcome}\` | \`${step.resultingState}\` | ${escapeMdCell(step.detail)}${escapeMdCell(fx)} |`
      );
    }

    lines.push("");
    lines.push("### Immutable Audit Trail Output");
    lines.push("");
    lines.push(
      "| Audit ID | Timestamp | From State | To State | Triggered By (`userId` / `role`) | Outcome | Reason / Notes | Changed Fields (`delta`) |"
    );
    lines.push("| :--- | :--- | :--- | :--- | :--- | :---: | :--- | :--- |");

    for (const entry of s.auditTrail) {
      const deltaKeys = Object.keys(entry.delta);
      const deltaSummary =
        deltaKeys.length > 0
          ? deltaKeys
              .map((k) => {
                const change = entry.delta[k];
                if (change?.removed) return `${k}: <removed>`;
                return `${k}: ${JSON.stringify(change?.after)}`;
              })
              .join(", ")
          : "—";

      lines.push(
        `| \`${entry.id}\` | \`${entry.timestamp}\` | \`${entry.from_state ?? "null"}\` | \`${entry.to_state}\` | \`${entry.triggered_by.userId}\` (\`${entry.triggered_by.role}\`) | \`${entry.outcome}\` | ${escapeMdCell(entry.reason)} | ${escapeMdCell(deltaSummary)} |`
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

export function printScenariosToConsole(summaries: readonly ScenarioRunSummary[]): void {
  console.log("================================================================================");
  console.log("          CLAIMS WORKFLOW ORCHESTRATOR — SCENARIO EXECUTION REPORT              ");
  console.log("================================================================================\n");

  for (const s of summaries) {
    const badge = s.passedExpectation ? "[PASS]" : "[FAIL]";
    console.log(`${badge} ${s.id}: ${s.title} (${s.claimId})`);
    console.log(`  Objective   : ${s.objective}`);
    console.log(`  Final State : ${s.finalState} (v${s.finalVersion})`);
    console.log("  Steps:");
    for (const step of s.steps) {
      console.log(
        `    ${step.stepNumber}. [${step.outcome}] ${step.action} by ${step.actor} -> ${step.resultingState}`
      );
      console.log(`       Detail: ${step.detail}`);
      for (const fx of step.sideEffects) {
        console.log(`       SideEffect: ${fx}`);
      }
    }
    console.log(`  Audit Trail (${s.auditTrail.length} immutable entries):`);
    for (const entry of s.auditTrail) {
      console.log(
        `    - ${entry.id} | ${entry.timestamp} | ${entry.from_state ?? "null"} -> ${entry.to_state} | ${entry.triggered_by.userId} (${entry.triggered_by.role}) | ${entry.outcome} | ${entry.reason}`
      );
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

  if (summaries.some((s) => !s.passedExpectation)) {
    process.exitCode = 1;
  }
}

