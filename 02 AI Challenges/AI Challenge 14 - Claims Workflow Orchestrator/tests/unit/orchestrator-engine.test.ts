import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflowConfig } from "../../src/engine/config-schema.js";
import { evaluateCyclePolicy } from "../../src/engine/cycle-detector.js";
import { WorkflowOrchestrator } from "../../src/engine/orchestrator.js";
import { AuditStore } from "../../src/engine/audit-store.js";

const MAIN_CONFIG_PATH = resolve(import.meta.dirname, "../../config/claims-workflow.yaml");

describe("Phase 3 — CycleDetector, SideEffects & WorkflowOrchestrator Unit Suite", () => {
  it("counts only SUCCESS loop entries and flags the 4th attempt as exceeded", () => {
    const config = loadWorkflowConfig(MAIN_CONFIG_PATH);
    const store = new AuditStore();

    for (let i = 1; i <= 3; i++) {
      store.append({
        claimId: "C-LOOP",
        timestamp: `2026-10-01T0${i}:00:00.000Z`,
        fromState: "UNDER_ASSESSMENT",
        toState: "PENDING_INFO",
        triggeredBy: { userId: "u-assessor-1", role: "assessor" },
        notes: `Info request #${i}`,
        outcome: "SUCCESS",
        workflowVersion: "1.0.0",
        claimVersion: i + 1,
      });
    }

    // A DENIED entry should not affect the count
    store.append({
      claimId: "C-LOOP",
      timestamp: "2026-10-01T04:00:00.000Z",
      fromState: "UNDER_ASSESSMENT",
      toState: "PENDING_INFO",
      triggeredBy: { userId: "u-clerk", role: "document_clerk" },
      notes: "Wrong role attempt",
      outcome: "DENIED",
      errorCode: "UNAUTHORIZED_ROLE",
      workflowVersion: "1.0.0",
      claimVersion: 4,
    });

    const preview = evaluateCyclePolicy(
      config.cyclePolicies,
      "UNDER_ASSESSMENT",
      "PENDING_INFO",
      store.getByClaimId("C-LOOP")
    );

    expect(preview).toBeDefined();
    expect(preview?.currentCount).toBe(3);
    expect(preview?.maxCycles).toBe(3);
    expect(preview?.exceeded).toBe(true);
    expect(preview?.errorMessage).toBe(
      "Maximum information requests exceeded — escalate to team lead"
    );
  });

  it("shows available transitions from current state including required roles and precondition status", () => {
    const config = loadWorkflowConfig(MAIN_CONFIG_PATH);
    const orchestrator = new WorkflowOrchestrator(config);

    const claim = orchestrator.createClaim({
      id: "C-AVAIL",
      data: {
        submittedDocuments: ["claim_form"], // missing medical_report & itemized_receipt
      },
    });

    const availableInitial = orchestrator.getAvailableTransitions(claim.id);
    expect(availableInitial).toHaveLength(1);
    expect(availableInitial[0]?.to).toBe("DOCUMENTS_VERIFIED");
    expect(availableInitial[0]?.roles).toEqual(["document_clerk"]);
    expect(availableInitial[0]?.allPreconditionsMet).toBe(false);

    // Previewing with all required documents shows allPreconditionsMet === true
    const availableWithDocs = orchestrator.getAvailableTransitions(claim.id, {
      submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
    });
    expect(availableWithDocs[0]?.allPreconditionsMet).toBe(true);
  });

  it("enforces optimistic concurrency locking (expectedVersion) and idempotency keys (idempotencyKey)", () => {
    const config = loadWorkflowConfig(MAIN_CONFIG_PATH);
    const orchestrator = new WorkflowOrchestrator(config);

    orchestrator.createClaim({
      id: "C-CONC",
      data: {
        submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
      },
    });

    // Stale expectedVersion (99 instead of 1) must be rejected with CONCURRENCY_CONFLICT
    const conflict = orchestrator.transition({
      claimId: "C-CONC",
      toState: "DOCUMENTS_VERIFIED",
      actor: { userId: "u-clerk-1", role: "document_clerk" },
      expectedVersion: 99,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe("CONCURRENCY_CONFLICT");
    }

    // Valid transition with idempotencyKey
    const firstCall = orchestrator.transition({
      claimId: "C-CONC",
      toState: "DOCUMENTS_VERIFIED",
      actor: { userId: "u-clerk-1", role: "document_clerk" },
      expectedVersion: 1,
      idempotencyKey: "req-verify-001",
    });
    expect(firstCall.ok).toBe(true);
    expect(firstCall.idempotentReplay).toBe(false);

    const outboxCountAfterFirst = orchestrator.getOutboxEvents("C-CONC").length;
    const auditCountAfterFirst = orchestrator.getAuditTrail("C-CONC").length;

    // Duplicate call with same idempotencyKey returns cached result without re-executing
    const replayCall = orchestrator.transition({
      claimId: "C-CONC",
      toState: "DOCUMENTS_VERIFIED",
      actor: { userId: "u-clerk-1", role: "document_clerk" },
      expectedVersion: 1,
      idempotencyKey: "req-verify-001",
    });
    expect(replayCall.ok).toBe(true);
    expect(replayCall.idempotentReplay).toBe(true);
    expect(orchestrator.getOutboxEvents("C-CONC")).toHaveLength(outboxCountAfterFirst);
    expect(orchestrator.getAuditTrail("C-CONC")).toHaveLength(auditCountAfterFirst);
  });

  it("enforces loop hygiene (resets assessmentReportComplete on PENDING_INFO and accumulates newDocuments) and assigned-assessor ownership", () => {
    const config = loadWorkflowConfig(MAIN_CONFIG_PATH);
    const orchestrator = new WorkflowOrchestrator(config);

    orchestrator.createClaim({
      id: "C-HYGIENE",
      data: {
        amount: 5000,
        policyLimit: 10000,
        submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
      },
    });

    orchestrator.transition({
      claimId: "C-HYGIENE",
      toState: "DOCUMENTS_VERIFIED",
      actor: { userId: "u-clerk", role: "document_clerk" },
    });

    orchestrator.transition({
      claimId: "C-HYGIENE",
      toState: "UNDER_ASSESSMENT",
      actor: { userId: "u-lead", role: "team_lead" },
      input: {
        assessorId: "u-assessor-assigned",
        assessmentReportComplete: true, // set early before requesting more info
      },
    });

    // Different assessor (u-assessor-other) must be blocked by assigned-assessor check
    const wrongAssessor = orchestrator.transition({
      claimId: "C-HYGIENE",
      toState: "APPROVED",
      actor: { userId: "u-assessor-other", role: "assessor" },
    });
    expect(wrongAssessor.ok).toBe(false);
    if (!wrongAssessor.ok) {
      expect(wrongAssessor.error.code).toBe("UNAUTHORIZED_ROLE");
      expect(wrongAssessor.error.message).toContain("u-assessor-assigned");
    }

    // Assigned assessor requests more info -> resets assessmentReportComplete to false
    const toPending = orchestrator.transition({
      claimId: "C-HYGIENE",
      toState: "PENDING_INFO",
      actor: { userId: "u-assessor-assigned", role: "assessor" },
      input: { missingInfoDescription: "Need specialist lab result" },
    });
    expect(toPending.ok).toBe(true);
    expect(orchestrator.getClaim("C-HYGIENE")?.data.assessmentReportComplete).toBe(false);

    // Document clerk receives newDocuments -> merged into submittedDocuments & resets timer
    const backToVerified = orchestrator.transition({
      claimId: "C-HYGIENE",
      toState: "DOCUMENTS_VERIFIED",
      actor: { userId: "u-clerk", role: "document_clerk" },
      input: { newDocuments: ["specialist_lab.pdf"] },
    });
    expect(backToVerified.ok).toBe(true);
    expect(orchestrator.getClaim("C-HYGIENE")?.data.submittedDocuments).toEqual([
      "claim_form",
      "medical_report",
      "itemized_receipt",
      "specialist_lab.pdf",
    ]);
    expect(orchestrator.getClaim("C-HYGIENE")?.data.assessmentStartedAt).toBeUndefined();
  });
});

