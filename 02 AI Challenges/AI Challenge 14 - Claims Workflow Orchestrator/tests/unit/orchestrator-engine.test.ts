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

  it("guarantees Read-Your-Own-Writes during post-commit outbox dispatch (claim and audit trail are already committed when dispatcher runs)", () => {
    const config = loadWorkflowConfig(MAIN_CONFIG_PATH);
    const observedDuringDispatch: {
      claimState: string | undefined;
      claimVersion: number | undefined;
      auditCount: number;
      latestAuditToState: string | undefined;
      outboxStatusAtCallTime: string | undefined;
    }[] = [];

    let orchestratorRef!: WorkflowOrchestrator;
    orchestratorRef = new WorkflowOrchestrator(config, {
      outboxDispatcher: (event) => {
        const liveClaim = orchestratorRef.getClaim(event.claimId);
        const liveAudit = orchestratorRef.getAuditTrail(event.claimId);
        observedDuringDispatch.push({
          claimState: liveClaim?.state,
          claimVersion: liveClaim?.version,
          auditCount: liveAudit.length,
          latestAuditToState: liveAudit[liveAudit.length - 1]?.toState,
          outboxStatusAtCallTime: event.status,
        });
      },
    });

    orchestratorRef.createClaim({
      id: "C-RYOW",
      data: {
        amount: 4500,
        policyLimit: 10000,
        submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
      },
    });

    const result = orchestratorRef.transition({
      claimId: "C-RYOW",
      toState: "DOCUMENTS_VERIFIED",
      actor: { userId: "u-clerk-1", role: "document_clerk" },
    });

    expect(result.ok).toBe(true);
    expect(observedDuringDispatch).toHaveLength(1);
    // When the outbox dispatcher runs, the claim & audit must ALREADY reflect the committed transition
    expect(observedDuringDispatch[0]).toEqual({
      claimState: "DOCUMENTS_VERIFIED",
      claimVersion: 2,
      auditCount: 2,
      latestAuditToState: "DOCUMENTS_VERIFIED",
      outboxStatusAtCallTime: "PENDING",
    });
  });

  it("atomically rolls back claim state, audit store, outbox store, and sequence counters if an error occurs mid-commit", () => {
    const config = loadWorkflowConfig(MAIN_CONFIG_PATH);

    class FaultyAuditStore extends AuditStore {
      public failNextAppend = false;

      public override append(input: Parameters<AuditStore["append"]>[0]) {
        if (this.failNextAppend) {
          throw new Error("Simulated storage failure after outbox enqueue");
        }
        return super.append(input);
      }
    }

    const faultyAuditStore = new FaultyAuditStore();
    const dispatchedEvents: string[] = [];
    const orchestrator = new WorkflowOrchestrator(config, {
      auditStore: faultyAuditStore,
      outboxDispatcher: (ev) => {
        dispatchedEvents.push(ev.id);
      },
    });

    orchestrator.createClaim({
      id: "C-ROLLBACK",
      data: {
        amount: 3000,
        policyLimit: 10000,
        submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
      },
    });

    // Inject fault right before transition commit
    faultyAuditStore.failNextAppend = true;

    expect(() =>
      orchestrator.transition({
        claimId: "C-ROLLBACK",
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "u-clerk-1", role: "document_clerk" },
      })
    ).toThrow("Simulated storage failure after outbox enqueue");

    // Verify 100% atomic rollback:
    // 1. Claim remains in SUBMITTED v1
    const claimAfterFail = orchestrator.getClaim("C-ROLLBACK");
    expect(claimAfterFail?.state).toBe("SUBMITTED");
    expect(claimAfterFail?.version).toBe(1);

    // 2. Outbox store was rolled back (0 orphaned PENDING events, 0 dispatched events)
    expect(orchestrator.getOutboxEvents("C-ROLLBACK")).toHaveLength(0);
    expect(dispatchedEvents).toHaveLength(0);

    // 3. Audit trail still has only the initial creation entry (AUD-0001)
    const auditAfterFail = orchestrator.getAuditTrail("C-ROLLBACK");
    expect(auditAfterFail).toHaveLength(1);
    expect(auditAfterFail[0]?.id).toBe("AUD-0001");

    // 4. Subsequent transition after recovery succeeds with contiguous IDs (AUD-0002, OBX-0001)
    faultyAuditStore.failNextAppend = false;
    const retryResult = orchestrator.transition({
      claimId: "C-ROLLBACK",
      toState: "DOCUMENTS_VERIFIED",
      actor: { userId: "u-clerk-1", role: "document_clerk" },
    });
    expect(retryResult.ok).toBe(true);
    if (retryResult.ok) {
      expect(retryResult.claim.state).toBe("DOCUMENTS_VERIFIED");
      expect(retryResult.claim.version).toBe(2);
      expect(retryResult.auditEntry.id).toBe("AUD-0002");
      expect(retryResult.outboxEvents[0]?.id).toBe("OBX-0001");
    }
  });

  it("atomically rolls back createClaim if audit logging fails during creation", () => {
    const config = loadWorkflowConfig(MAIN_CONFIG_PATH);

    class FaultyAuditStore extends AuditStore {
      public failNextAppend = false;

      public override append(input: Parameters<AuditStore["append"]>[0]) {
        if (this.failNextAppend) {
          throw new Error("Simulated audit disk failure during createClaim");
        }
        return super.append(input);
      }
    }

    const faultyStore = new FaultyAuditStore();
    const orchestrator = new WorkflowOrchestrator(config, {
      auditStore: faultyStore,
    });

    faultyStore.failNextAppend = true;
    expect(() =>
      orchestrator.createClaim({
        id: "C-FAIL-CREATE",
        data: { amount: 1000 },
      })
    ).toThrow("Simulated audit disk failure during createClaim");

    // The claim must NOT exist in the orchestrator
    expect(orchestrator.getClaim("C-FAIL-CREATE")).toBeUndefined();
    expect(orchestrator.getAllClaims()).toHaveLength(0);
    expect(orchestrator.getAuditTrail("C-FAIL-CREATE")).toHaveLength(0);

    // After resolving failure, can create claim cleanly with no corruption
    faultyStore.failNextAppend = false;
    const successfulClaim = orchestrator.createClaim({
      id: "C-FAIL-CREATE",
      data: { amount: 1000 },
    });
    expect(successfulClaim.id).toBe("C-FAIL-CREATE");
    expect(orchestrator.getClaim("C-FAIL-CREATE")).toBeDefined();
    expect(orchestrator.getAuditTrail("C-FAIL-CREATE")).toHaveLength(1);
    expect(orchestrator.getAuditTrail("C-FAIL-CREATE")[0]?.id).toBe("AUD-0001");
  });

  it("isolates Phase 1 precondition failure: zero side effects prepared or enqueued, zero state mutation", () => {
    const config = loadWorkflowConfig(MAIN_CONFIG_PATH);
    const orchestrator = new WorkflowOrchestrator(config);

    orchestrator.createClaim({
      id: "C-GUARD",
      data: {
        amount: 2500,
        policyLimit: 10000,
        submittedDocuments: ["claim_form"], // Missing medical_report & itemized_receipt
      },
    });

    const failureResult = orchestrator.transition({
      claimId: "C-GUARD",
      toState: "DOCUMENTS_VERIFIED",
      actor: { userId: "u-clerk", role: "document_clerk" },
    });

    expect(failureResult.ok).toBe(false);
    if (!failureResult.ok) {
      expect(failureResult.error.code).toBe("PRECONDITION_FAILED");
    }

    // Zero outbox events enqueued or dispatched
    expect(orchestrator.getOutboxEvents("C-GUARD")).toHaveLength(0);

    // Claim state and version unchanged
    const claim = orchestrator.getClaim("C-GUARD");
    expect(claim?.state).toBe("SUBMITTED");
    expect(claim?.version).toBe(1);

    // Audit trail logs exactly one DENIED attempt without mutating delta or side effects
    const audit = orchestrator.getAuditTrail("C-GUARD");
    expect(audit).toHaveLength(2); // AUD-0001 (create SUCCESS), AUD-0002 (transition DENIED)
    expect(audit[1]?.outcome).toBe("DENIED");
    expect(audit[1]?.errorCode).toBe("PRECONDITION_FAILED");
    expect(audit[1]?.sideEffects).toEqual([]);
    expect(audit[1]?.delta).toEqual({});
  });

  it("isolates Phase 3 outbox handler failures: domain transition remains committed, outbox marked FAILED", () => {
    const config = loadWorkflowConfig(MAIN_CONFIG_PATH);
    const orchestrator = new WorkflowOrchestrator(config, {
      outboxDispatcher: (event) => {
        if (event.type === "notify") {
          throw new Error("Downstream notification service unavailable (HTTP 503)");
        }
      },
    });

    orchestrator.createClaim({
      id: "C-OUTBOX-FAIL",
      data: {
        amount: 3000,
        policyLimit: 10000,
        submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
      },
    });

    const result = orchestrator.transition({
      claimId: "C-OUTBOX-FAIL",
      toState: "DOCUMENTS_VERIFIED",
      actor: { userId: "u-clerk", role: "document_clerk" },
    });

    // Domain transition MUST succeed despite downstream outbox dispatcher failure
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claim.state).toBe("DOCUMENTS_VERIFIED");
      expect(result.claim.version).toBe(2);
      expect(result.auditEntry.outcome).toBe("SUCCESS");

      // Outbox event is marked FAILED with error message captured
      expect(result.outboxEvents).toHaveLength(1);
      expect(result.outboxEvents[0]?.status).toBe("FAILED");
      expect(result.outboxEvents[0]?.errorMessage).toBe(
        "Downstream notification service unavailable (HTTP 503)"
      );
    }

    // Claim is persisted in new state
    const persisted = orchestrator.getClaim("C-OUTBOX-FAIL");
    expect(persisted?.state).toBe("DOCUMENTS_VERIFIED");
    expect(persisted?.version).toBe(2);

    // Querying failed outbox events returns the failed event
    const failedEvents = orchestrator.getFailedOutboxEvents();
    expect(failedEvents.some((e) => e.claimId === "C-OUTBOX-FAIL")).toBe(true);
  });
});

