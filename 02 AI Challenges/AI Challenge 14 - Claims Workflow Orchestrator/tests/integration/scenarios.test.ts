import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadWorkflowConfig } from "../../src/engine/config-schema.js";
import { WorkflowOrchestrator } from "../../src/engine/orchestrator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_CONFIG_PATH = resolve(__dirname, "../../config/claims-workflow.yaml");

function createTestOrchestrator(initialTimeIso = "2026-10-01T09:00:00.000Z") {
  let currentTime = new Date(initialTimeIso);
  const config = loadWorkflowConfig(MAIN_CONFIG_PATH);
  const emittedLogs: string[] = [];

  const orchestrator = new WorkflowOrchestrator(config, {
    clock: {
      now: () => currentTime,
    },
    outboxDispatcher: (event) => {
      const target = event.target ? ` -> ${event.target}` : "";
      emittedLogs.push(`[${event.type}${target}] ${event.message}`);
    },
  });

  const advanceDays = (days: number) => {
    currentTime = new Date(currentTime.getTime() + days * 24 * 60 * 60 * 1000);
  };

  return { orchestrator, emittedLogs, advanceDays };
}

describe("Phase 4 — End-to-End Claims Workflow Scenarios & Edge Cases", () => {
  describe("Required Spec Scenarios (1–5)", () => {
    it("Scenario 1 — Happy path: SUBMITTED -> DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT -> APPROVED -> PAYMENT_INITIATED -> CLOSED", () => {
      const { orchestrator, emittedLogs } = createTestOrchestrator();

      const claim = orchestrator.createClaim({
        id: "CLM-SCENARIO-1",
        actor: { userId: "member-101", role: "system" },
        data: {
          amount: 6500,
          policyLimit: 10000,
          submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
        },
        notes: "Initial inpatient claim submission",
      });
      expect(claim.state).toBe("SUBMITTED");

      // 1. SUBMITTED -> DOCUMENTS_VERIFIED (document_clerk)
      const s1 = orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-1", role: "document_clerk" },
        notes: "All required documents verified",
      });
      expect(s1.ok).toBe(true);

      // 2. DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT (team_lead)
      const s2 = orchestrator.transition({
        claimId: claim.id,
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-1", role: "team_lead" },
        input: { assessorId: "assessor-1" },
        notes: "Assigned to assessor-1",
      });
      expect(s2.ok).toBe(true);
      if (s2.ok) {
        expect(s2.claim.data.assessmentStartedAt).toBe("2026-10-01T09:00:00.000Z");
      }

      // 3. UNDER_ASSESSMENT -> APPROVED (assessor)
      const s3 = orchestrator.transition({
        claimId: claim.id,
        toState: "APPROVED",
        actor: { userId: "assessor-1", role: "assessor" },
        input: { assessmentReportComplete: true },
        notes: "Medical necessity confirmed; within policy limit",
      });
      expect(s3.ok).toBe(true);
      if (s3.ok) {
        expect(s3.claim.data.paymentRequestId).toBe("PR-CLM-SCENARIO-1-0001");
      }

      // 4. APPROVED -> PAYMENT_INITIATED (finance)
      const s4 = orchestrator.transition({
        claimId: claim.id,
        toState: "PAYMENT_INITIATED",
        actor: { userId: "finance-1", role: "finance" },
        notes: "Disbursement initiated",
      });
      expect(s4.ok).toBe(true);
      if (s4.ok) {
        expect(s4.claim.data.paymentTransactionId).toBe("PAY-CLM-SCENARIO-1-0002");
      }

      // 5. PAYMENT_INITIATED -> CLOSED (finance)
      const s5 = orchestrator.transition({
        claimId: claim.id,
        toState: "CLOSED",
        actor: { userId: "finance-1", role: "finance" },
        input: {
          paymentConfirmed: true,
          paymentReference: "WIRE-2026-9988",
        },
        notes: "Payment settled and confirmed",
      });
      expect(s5.ok).toBe(true);
      if (s5.ok) {
        expect(s5.claim.state).toBe("CLOSED");
        expect(s5.claim.version).toBe(6);
      }

      const audit = orchestrator.getAuditTrail(claim.id);
      expect(audit.map((a) => `${a.from_state ?? "NULL"}->${a.to_state}`)).toEqual([
        "NULL->SUBMITTED",
        "SUBMITTED->DOCUMENTS_VERIFIED",
        "DOCUMENTS_VERIFIED->UNDER_ASSESSMENT",
        "UNDER_ASSESSMENT->APPROVED",
        "APPROVED->PAYMENT_INITIATED",
        "PAYMENT_INITIATED->CLOSED",
      ]);

      expect(emittedLogs).toHaveLength(6);
      const replayed = orchestrator.replayClaim(claim.id);
      expect(replayed.currentState).toBe("CLOSED");
      expect(replayed.version).toBe(6);
    });

    it("Scenario 2 — Rejection path: SUBMITTED -> DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT -> REJECTED -> CLOSED (via member acknowledgement)", () => {
      const { orchestrator } = createTestOrchestrator();

      const claim = orchestrator.createClaim({
        id: "CLM-SCENARIO-2A",
        data: {
          amount: 4200,
          policyLimit: 10000,
          submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
        },
      });

      orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-1", role: "document_clerk" },
      });
      orchestrator.transition({
        claimId: claim.id,
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-1", role: "team_lead" },
        input: { assessorId: "assessor-1" },
      });

      const rejected = orchestrator.transition({
        claimId: claim.id,
        toState: "REJECTED",
        actor: { userId: "assessor-1", role: "assessor" },
        input: {
          assessmentReportComplete: true,
          rejectionReason: "Pre-existing condition exclusion under Section 4.2",
        },
        notes: "Claim denied due to policy exclusion",
      });
      expect(rejected.ok).toBe(true);

      const closed = orchestrator.transition({
        claimId: claim.id,
        toState: "CLOSED",
        actor: { userId: "sys-cron", role: "system" },
        input: { memberAcknowledged: true },
        notes: "Member acknowledged rejection decision",
      });
      expect(closed.ok).toBe(true);
      if (closed.ok) {
        expect(closed.claim.state).toBe("CLOSED");
        expect(closed.claim.data.archived).toBe(true);
        expect(closed.claim.data.archivedAt).toBeDefined();
      }
    });

    it("Scenario 2B — Rejection path closed automatically after 30-day appeal period expires", () => {
      const { orchestrator, advanceDays } = createTestOrchestrator();

      const claim = orchestrator.createClaim({
        id: "CLM-SCENARIO-2B",
        data: {
          amount: 4200,
          policyLimit: 10000,
          submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
        },
      });

      orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-1", role: "document_clerk" },
      });
      orchestrator.transition({
        claimId: claim.id,
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-1", role: "team_lead" },
        input: { assessorId: "assessor-1" },
      });
      orchestrator.transition({
        claimId: claim.id,
        toState: "REJECTED",
        actor: { userId: "assessor-1", role: "assessor" },
        input: {
          assessmentReportComplete: true,
          rejectionReason: "Non-covered cosmetic procedure",
        },
      });

      // Advance clock by 31 days (> 30 day appeal period)
      advanceDays(31);

      const closedAfterExpiry = orchestrator.transition({
        claimId: claim.id,
        toState: "CLOSED",
        actor: { userId: "sys-cron", role: "system" },
        notes: "Appeal window (30 days) expired without appeal",
      });
      expect(closedAfterExpiry.ok).toBe(true);
      if (closedAfterExpiry.ok) {
        expect(closedAfterExpiry.claim.state).toBe("CLOSED");
      }
    });

    it("Scenario 3 — Request more info loop: SUBMITTED -> DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT -> PENDING_INFO -> DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT -> APPROVED -> PAYMENT_INITIATED -> CLOSED", () => {
      const { orchestrator } = createTestOrchestrator();

      const claim = orchestrator.createClaim({
        id: "CLM-SCENARIO-3",
        data: {
          amount: 8900,
          policyLimit: 10000,
          submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
        },
      });

      expect(
        orchestrator.transition({
          claimId: claim.id,
          toState: "DOCUMENTS_VERIFIED",
          actor: { userId: "clerk-1", role: "document_clerk" },
        }).ok
      ).toBe(true);

      expect(
        orchestrator.transition({
          claimId: claim.id,
          toState: "UNDER_ASSESSMENT",
          actor: { userId: "lead-1", role: "team_lead" },
          input: { assessorId: "assessor-1" },
        }).ok
      ).toBe(true);

      // Assessor requests more info
      const pending = orchestrator.transition({
        claimId: claim.id,
        toState: "PENDING_INFO",
        actor: { userId: "assessor-1", role: "assessor" },
        input: { missingInfoDescription: "Attending physician discharge summary required" },
      });
      expect(pending.ok).toBe(true);

      // Document clerk receives new documents -> resets assessment timer
      const reVerified = orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-1", role: "document_clerk" },
        input: { newDocuments: ["discharge_summary.pdf"] },
      });
      expect(reVerified.ok).toBe(true);
      if (reVerified.ok) {
        expect(reVerified.claim.data.assessmentStartedAt).toBeUndefined();
        expect(reVerified.claim.data.assessmentTimerResetAt).toBeDefined();
      }

      // Team lead moves back to UNDER_ASSESSMENT
      expect(
        orchestrator.transition({
          claimId: claim.id,
          toState: "UNDER_ASSESSMENT",
          actor: { userId: "lead-1", role: "team_lead" },
          input: { assessorId: "assessor-1" },
        }).ok
      ).toBe(true);

      // Assessor approves
      expect(
        orchestrator.transition({
          claimId: claim.id,
          toState: "APPROVED",
          actor: { userId: "assessor-1", role: "assessor" },
          input: { assessmentReportComplete: true },
        }).ok
      ).toBe(true);

      // Finance initiates and confirms payment
      expect(
        orchestrator.transition({
          claimId: claim.id,
          toState: "PAYMENT_INITIATED",
          actor: { userId: "finance-1", role: "finance" },
        }).ok
      ).toBe(true);

      const finalClose = orchestrator.transition({
        claimId: claim.id,
        toState: "CLOSED",
        actor: { userId: "finance-1", role: "finance" },
        input: { paymentConfirmed: true, paymentReference: "PAY-REF-300" },
      });
      expect(finalClose.ok).toBe(true);

      const auditStates = orchestrator.getAuditTrail(claim.id).map((e) => e.to_state);
      expect(auditStates).toEqual([
        "SUBMITTED",
        "DOCUMENTS_VERIFIED",
        "UNDER_ASSESSMENT",
        "PENDING_INFO",
        "DOCUMENTS_VERIFIED",
        "UNDER_ASSESSMENT",
        "APPROVED",
        "PAYMENT_INITIATED",
        "CLOSED",
      ]);
    });

    it("Scenario 4 — Invalid transition: Attempt SUBMITTED -> APPROVED fails with specific error listing valid transitions", () => {
      const { orchestrator } = createTestOrchestrator();

      const claim = orchestrator.createClaim({
        id: "CLM-SCENARIO-4",
        data: {
          amount: 5000,
          policyLimit: 10000,
          submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
        },
      });

      const res = orchestrator.transition({
        claimId: claim.id,
        toState: "APPROVED",
        actor: { userId: "assessor-1", role: "assessor" },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("INVALID_TRANSITION");
        expect(res.error.message).toContain("SUBMITTED -> APPROVED");
        expect(res.error.message).toContain("DOCUMENTS_VERIFIED (role: document_clerk)");
        expect(res.error.allowedTransitions).toEqual([
          { to: "DOCUMENTS_VERIFIED", roles: ["document_clerk"] },
        ]);
      }
      expect(orchestrator.getClaim(claim.id)?.state).toBe("SUBMITTED");
    });

    it("Scenario 5 — Unauthorized role: Attempt transition with wrong role fails with specific error", () => {
      const { orchestrator } = createTestOrchestrator();

      const claim = orchestrator.createClaim({
        id: "CLM-SCENARIO-5",
        data: {
          amount: 5000,
          policyLimit: 10000,
          submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
        },
      });

      // Assessor tries to perform SUBMITTED -> DOCUMENTS_VERIFIED (requires document_clerk)
      const res = orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "assessor-1", role: "assessor" },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("UNAUTHORIZED_ROLE");
        expect(res.error.message).toContain("Role 'assessor'");
        expect(res.error.message).toContain("Required role(s): document_clerk");
        expect(res.error.requiredRoles).toEqual(["document_clerk"]);
      }
      expect(orchestrator.getClaim(claim.id)?.state).toBe("SUBMITTED");
    });
  });

  describe("Additional Invalid Transition & Lookup Edge Cases", () => {
    it("rejects transitions on a non-existent claim ID with CLAIM_NOT_FOUND", () => {
      const { orchestrator } = createTestOrchestrator();
      const res = orchestrator.transition({
        claimId: "CLM-MISSING",
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-1", role: "document_clerk" },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("CLAIM_NOT_FOUND");
      }
    });

    it("rejects any transition out of terminal state CLOSED with TERMINAL_STATE", () => {
      const { orchestrator } = createTestOrchestrator();
      const claim = orchestrator.createClaim({
        id: "CLM-TERM",
        data: {
          amount: 3000,
          policyLimit: 10000,
          submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
        },
      });

      orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-1", role: "document_clerk" },
      });
      orchestrator.transition({
        claimId: claim.id,
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-1", role: "team_lead" },
        input: { assessorId: "assessor-1" },
      });
      orchestrator.transition({
        claimId: claim.id,
        toState: "REJECTED",
        actor: { userId: "assessor-1", role: "assessor" },
        input: { assessmentReportComplete: true, rejectionReason: "Duplicate claim" },
      });
      orchestrator.transition({
        claimId: claim.id,
        toState: "CLOSED",
        actor: { userId: "sys-1", role: "system" },
        input: { memberAcknowledged: true },
      });

      const reopenAttempt = orchestrator.transition({
        claimId: claim.id,
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-1", role: "team_lead" },
      });
      expect(reopenAttempt.ok).toBe(false);
      if (!reopenAttempt.ok) {
        expect(reopenAttempt.error.code).toBe("TERMINAL_STATE");
        expect(reopenAttempt.error.message).toContain("terminal");
      }
      expect(orchestrator.getAvailableTransitions(claim.id)).toEqual([]);
    });

    it("rejects skipping APPROVED -> CLOSED directly and rejects unknown target states", () => {
      const { orchestrator } = createTestOrchestrator();
      const claim = orchestrator.createClaim({
        id: "CLM-SKIP",
        data: {
          amount: 3000,
          policyLimit: 10000,
          submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
        },
      });

      const unknownStateRes = orchestrator.transition({
        claimId: claim.id,
        toState: "ARCHIVED_DIRECTLY",
        actor: { userId: "clerk-1", role: "document_clerk" },
      });
      expect(unknownStateRes.ok).toBe(false);
      if (!unknownStateRes.ok) {
        expect(unknownStateRes.error.code).toBe("INVALID_TRANSITION");
        expect(unknownStateRes.error.message).toContain("not a defined workflow state");
      }

      orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-1", role: "document_clerk" },
      });
      orchestrator.transition({
        claimId: claim.id,
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-1", role: "team_lead" },
        input: { assessorId: "assessor-1" },
      });
      orchestrator.transition({
        claimId: claim.id,
        toState: "APPROVED",
        actor: { userId: "assessor-1", role: "assessor" },
        input: { assessmentReportComplete: true },
      });

      const skipPayment = orchestrator.transition({
        claimId: claim.id,
        toState: "CLOSED",
        actor: { userId: "finance-1", role: "finance" },
      });
      expect(skipPayment.ok).toBe(false);
      if (!skipPayment.ok) {
        expect(skipPayment.error.code).toBe("INVALID_TRANSITION");
        expect(skipPayment.error.message).toContain("PAYMENT_INITIATED (role: finance)");
      }
    });
  });

  describe("Precondition Enforcement & Role Violations Across All Transitions", () => {
    it("enforces preconditions on document verification, assessor assignment, approval amount, rejection reason, pending info, and appeal expiry", () => {
      const { orchestrator, advanceDays } = createTestOrchestrator();

      const claim = orchestrator.createClaim({
        id: "CLM-PRECOND",
        data: {
          amount: 14000,
          policyLimit: 10000,
          submittedDocuments: ["claim_form"], // missing medical_report & itemized_receipt
        },
      });

      // 1. Missing required documents
      const missingDocs = orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-1", role: "document_clerk" },
      });
      expect(missingDocs.ok).toBe(false);
      if (!missingDocs.ok) {
        expect(missingDocs.error.code).toBe("PRECONDITION_FAILED");
        expect(missingDocs.error.message).toContain("medical_report");
      }

      // Supply all required documents
      orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-1", role: "document_clerk" },
        input: {
          submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
        },
      });

      // 2. Missing assessorId on DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT
      const missingAssessor = orchestrator.transition({
        claimId: claim.id,
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-1", role: "team_lead" },
      });
      expect(missingAssessor.ok).toBe(false);
      if (!missingAssessor.ok) {
        expect(missingAssessor.error.code).toBe("PRECONDITION_FAILED");
      }

      // Assign assessor
      orchestrator.transition({
        claimId: claim.id,
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-1", role: "team_lead" },
        input: { assessorId: "assessor-1" },
      });

      // 3. Approve fails when amount (14000) > policyLimit (10000)
      const overLimit = orchestrator.transition({
        claimId: claim.id,
        toState: "APPROVED",
        actor: { userId: "assessor-1", role: "assessor" },
        input: { assessmentReportComplete: true },
      });
      expect(overLimit.ok).toBe(false);
      if (!overLimit.ok) {
        expect(overLimit.error.code).toBe("PRECONDITION_FAILED");
        expect(overLimit.error.message).toContain("14000");
        expect(overLimit.error.message).toContain("10000");
      }

      // 4. Reject fails when rejectionReason is missing
      const missingRejectReason = orchestrator.transition({
        claimId: claim.id,
        toState: "REJECTED",
        actor: { userId: "assessor-1", role: "assessor" },
        input: { assessmentReportComplete: true },
      });
      expect(missingRejectReason.ok).toBe(false);
      if (!missingRejectReason.ok) {
        expect(missingRejectReason.error.code).toBe("PRECONDITION_FAILED");
      }

      // 5. Pending info fails without missingInfoDescription
      const missingInfoDesc = orchestrator.transition({
        claimId: claim.id,
        toState: "PENDING_INFO",
        actor: { userId: "assessor-1", role: "assessor" },
      });
      expect(missingInfoDesc.ok).toBe(false);

      // Valid transition to PENDING_INFO, then test PENDING_INFO -> DOCUMENTS_VERIFIED without new info
      orchestrator.transition({
        claimId: claim.id,
        toState: "PENDING_INFO",
        actor: { userId: "assessor-1", role: "assessor" },
        input: { missingInfoDescription: "Need updated itemized invoice" },
      });

      const noNewDocs = orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-1", role: "document_clerk" },
      });
      expect(noNewDocs.ok).toBe(false);
      if (!noNewDocs.ok) {
        expect(noNewDocs.error.code).toBe("PRECONDITION_FAILED");
      }

      // Return to UNDER_ASSESSMENT and reject properly
      orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-1", role: "document_clerk" },
        input: { additionalInfo: "Clarified invoice line items" },
      });
      orchestrator.transition({
        claimId: claim.id,
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-1", role: "team_lead" },
        input: { assessorId: "assessor-1" },
      });
      orchestrator.transition({
        claimId: claim.id,
        toState: "REJECTED",
        actor: { userId: "assessor-1", role: "assessor" },
        input: {
          assessmentReportComplete: true,
          rejectionReason: "Exceeds policy coverage cap and non-covered items",
        },
      });

      // 6. REJECTED -> CLOSED fails on day 10 without memberAcknowledged
      advanceDays(10);
      const prematureClose = orchestrator.transition({
        claimId: claim.id,
        toState: "CLOSED",
        actor: { userId: "sys-1", role: "system" },
      });
      expect(prematureClose.ok).toBe(false);
      if (!prematureClose.ok) {
        expect(prematureClose.error.code).toBe("PRECONDITION_FAILED");
        expect(prematureClose.error.message).toContain("less than required 30d");
      }
    });

    it("blocks finance/assessor/undeclared role violations on payment and closure transitions", () => {
      const { orchestrator } = createTestOrchestrator();
      const claim = orchestrator.createClaim({
        id: "CLM-ROLES",
        data: {
          amount: 4000,
          policyLimit: 10000,
          submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
        },
      });

      orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-1", role: "document_clerk" },
      });
      orchestrator.transition({
        claimId: claim.id,
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-1", role: "team_lead" },
        input: { assessorId: "assessor-1" },
      });
      orchestrator.transition({
        claimId: claim.id,
        toState: "APPROVED",
        actor: { userId: "assessor-1", role: "assessor" },
        input: { assessmentReportComplete: true },
      });

      // Assessor cannot initiate payment (requires finance)
      const assessorPay = orchestrator.transition({
        claimId: claim.id,
        toState: "PAYMENT_INITIATED",
        actor: { userId: "assessor-1", role: "assessor" },
      });
      expect(assessorPay.ok).toBe(false);
      if (!assessorPay.ok) {
        expect(assessorPay.error.code).toBe("UNAUTHORIZED_ROLE");
      }

      // Unknown role 'ceo' cannot initiate payment
      const unknownRolePay = orchestrator.transition({
        claimId: claim.id,
        toState: "PAYMENT_INITIATED",
        actor: { userId: "user-ceo", role: "ceo" },
      });
      expect(unknownRolePay.ok).toBe(false);
      if (!unknownRolePay.ok) {
        expect(unknownRolePay.error.code).toBe("UNAUTHORIZED_ROLE");
      }
    });
  });

  describe("Cycle Limit Enforcement & Post-Limit Recovery", () => {
    it("allows 3 information request cycles, blocks the 4th with the exact spec message, and allows subsequent approval", () => {
      const { orchestrator } = createTestOrchestrator();

      const claim = orchestrator.createClaim({
        id: "CLM-CYCLE-MAX",
        data: {
          amount: 6000,
          policyLimit: 10000,
          submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
        },
      });

      orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-1", role: "document_clerk" },
      });
      orchestrator.transition({
        claimId: claim.id,
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-1", role: "team_lead" },
        input: { assessorId: "assessor-1" },
      });

      for (let i = 1; i <= 3; i++) {
        expect(
          orchestrator.transition({
            claimId: claim.id,
            toState: "PENDING_INFO",
            actor: { userId: "assessor-1", role: "assessor" },
            input: { missingInfoDescription: `Request #${i}` },
          }).ok
        ).toBe(true);

        expect(
          orchestrator.transition({
            claimId: claim.id,
            toState: "DOCUMENTS_VERIFIED",
            actor: { userId: "clerk-1", role: "document_clerk" },
            input: { newDocuments: [`extra_doc_${i}.pdf`] },
          }).ok
        ).toBe(true);

        expect(
          orchestrator.transition({
            claimId: claim.id,
            toState: "UNDER_ASSESSMENT",
            actor: { userId: "lead-1", role: "team_lead" },
            input: { assessorId: "assessor-1" },
          }).ok
        ).toBe(true);
      }

      // 4th attempt to transition UNDER_ASSESSMENT -> PENDING_INFO must be blocked
      const fourthAttempt = orchestrator.transition({
        claimId: claim.id,
        toState: "PENDING_INFO",
        actor: { userId: "assessor-1", role: "assessor" },
        input: { missingInfoDescription: "Request #4" },
      });

      expect(fourthAttempt.ok).toBe(false);
      if (!fourthAttempt.ok) {
        expect(fourthAttempt.error.code).toBe("CYCLE_LIMIT_EXCEEDED");
        expect(fourthAttempt.error.message).toBe(
          "Maximum information requests exceeded — escalate to team lead"
        );
      }

      // Claim stays in UNDER_ASSESSMENT and can still be approved or rejected
      expect(orchestrator.getClaim(claim.id)?.state).toBe("UNDER_ASSESSMENT");
      const approveAfterLimit = orchestrator.transition({
        claimId: claim.id,
        toState: "APPROVED",
        actor: { userId: "assessor-1", role: "assessor" },
        input: { assessmentReportComplete: true },
      });
      expect(approveAfterLimit.ok).toBe(true);
    });
  });
});

