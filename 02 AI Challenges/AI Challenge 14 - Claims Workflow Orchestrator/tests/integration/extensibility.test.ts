import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadWorkflowConfig } from "../../src/engine/config-schema.js";
import { WorkflowOrchestrator } from "../../src/engine/orchestrator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENDED_CONFIG_PATH = resolve(
  __dirname,
  "../../config/claims-workflow.fraud-check.yaml"
);

describe("Phase 4 — Config-Only Extensibility Proof (Zero Engine Code Changes)", () => {
  it("orchestrates a new FRAUD_CHECK state and fraud_analyst role loaded purely from YAML config", () => {
    const extendedConfig = loadWorkflowConfig(EXTENDED_CONFIG_PATH);
    const orchestrator = new WorkflowOrchestrator(extendedConfig);

    // 1. Low-risk claim passes FRAUD_CHECK -> UNDER_ASSESSMENT -> APPROVED
    const cleanClaim = orchestrator.createClaim({
      id: "CLM-FRAUD-PASS",
      data: {
        amount: 5000,
        policyLimit: 10000,
        submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
      },
    });

    expect(
      orchestrator.transition({
        claimId: cleanClaim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-1", role: "document_clerk" },
      }).ok
    ).toBe(true);

    const toFraudCheck = orchestrator.transition({
      claimId: cleanClaim.id,
      toState: "FRAUD_CHECK",
      actor: { userId: "clerk-1", role: "document_clerk" },
    });
    expect(toFraudCheck.ok).toBe(true);
    if (toFraudCheck.ok) {
      expect(toFraudCheck.claim.state).toBe("FRAUD_CHECK");
      expect(toFraudCheck.claim.data.fraudCheckStartedAt).toBeDefined();
    }

    const clearFraud = orchestrator.transition({
      claimId: cleanClaim.id,
      toState: "UNDER_ASSESSMENT",
      actor: { userId: "fraud-1", role: "fraud_analyst" },
      input: {
        fraudRiskScore: 15,
        assessorId: "assessor-1",
      },
    });
    expect(clearFraud.ok).toBe(true);
    if (clearFraud.ok) {
      expect(clearFraud.claim.state).toBe("UNDER_ASSESSMENT");
      expect(clearFraud.claim.data.fraudCleared).toBe(true);
    }

    // 2. High-risk claim (> 70 score) is blocked from UNDER_ASSESSMENT and routed FRAUD_CHECK -> REJECTED
    const highRiskClaim = orchestrator.createClaim({
      id: "CLM-FRAUD-REJECT",
      data: {
        amount: 9500,
        policyLimit: 10000,
        submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
      },
    });

    orchestrator.transition({
      claimId: highRiskClaim.id,
      toState: "DOCUMENTS_VERIFIED",
      actor: { userId: "clerk-1", role: "document_clerk" },
    });
    orchestrator.transition({
      claimId: highRiskClaim.id,
      toState: "FRAUD_CHECK",
      actor: { userId: "clerk-1", role: "document_clerk" },
    });

    const blockedPass = orchestrator.transition({
      claimId: highRiskClaim.id,
      toState: "UNDER_ASSESSMENT",
      actor: { userId: "fraud-1", role: "fraud_analyst" },
      input: {
        fraudRiskScore: 92,
        assessorId: "assessor-1",
      },
    });
    expect(blockedPass.ok).toBe(false);
    if (!blockedPass.ok) {
      expect(blockedPass.error.code).toBe("PRECONDITION_FAILED");
    }

    const fraudReject = orchestrator.transition({
      claimId: highRiskClaim.id,
      toState: "REJECTED",
      actor: { userId: "fraud-1", role: "fraud_analyst" },
      input: {
        fraudRiskScore: 92,
        rejectionReason: "Forged provider invoice detected (risk score 92)",
      },
    });
    expect(fraudReject.ok).toBe(true);
    if (fraudReject.ok) {
      expect(fraudReject.claim.state).toBe("REJECTED");
    }
  });
});

