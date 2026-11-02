import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CliSession } from "../../src/cli/repl.js";
import { ClaimValidationError } from "../../src/domain/validation.js";
import { loadWorkflowConfig } from "../../src/engine/config-schema.js";
import { WorkflowOrchestrator } from "../../src/engine/orchestrator.js";
import { createWorkflowApp } from "../../src/web/server.js";

const MAIN_CONFIG_PATH = resolve(import.meta.dirname, "../../config/claims-workflow.yaml");

describe("Input Validation Across Domain, CLI & Web API", () => {
  describe("Domain & WorkflowOrchestrator Validation", () => {
    it("rejects negative, zero, NaN, Infinity, non-numeric, and excessive monetary amounts or policy limits on createClaim", () => {
      const config = loadWorkflowConfig(MAIN_CONFIG_PATH);
      const orchestrator = new WorkflowOrchestrator(config);

      for (const badAmount of [-3000, -0.01, 0, Number.NaN, Number.POSITIVE_INFINITY, "5000", null, 2_000_000_000]) {
        expect(() =>
          orchestrator.createClaim({ data: { amount: badAmount, policyLimit: 10000 } })
        ).toThrow(ClaimValidationError);
      }

      for (const badLimit of [-1000, 0, Number.NaN, Number.NEGATIVE_INFINITY, "10000", false]) {
        expect(() =>
          orchestrator.createClaim({ data: { amount: 1000, policyLimit: badLimit } })
        ).toThrow(ClaimValidationError);
      }

      // Failed creation attempts must not pollute claims store or skip sequence numbers
      expect(orchestrator.getAllClaims()).toHaveLength(0);
      const valid = orchestrator.createClaim({ data: { amount: 250.75, policyLimit: 5000 } });
      expect(valid.id).toBe("C-1");
    });

    it("rejects malformed claim IDs, duplicate IDs, blank actors, invalid document lists, and non-string notes", () => {
      const config = loadWorkflowConfig(MAIN_CONFIG_PATH);
      const orchestrator = new WorkflowOrchestrator(config);

      for (const badId of ["", "   ", "-100", "bad id", "bad/id", " leading"]) {
        expect(() => orchestrator.createClaim({ id: badId })).toThrow(ClaimValidationError);
      }

      expect(() =>
        orchestrator.createClaim({ actor: { userId: "   ", role: "system" } })
      ).toThrow(ClaimValidationError);

      expect(() =>
        orchestrator.createClaim({ data: { submittedDocuments: ["claim_form", "  "] } })
      ).toThrow(ClaimValidationError);

      expect(() =>
        orchestrator.createClaim({ notes: 12345 as unknown as string })
      ).toThrow(ClaimValidationError);

      orchestrator.createClaim({ id: "CLM-DUP-1" });
      try {
        orchestrator.createClaim({ id: "CLM-DUP-1" });
        expect.unreachable("Expected duplicate ID error");
      } catch (err) {
        expect(err).toBeInstanceOf(ClaimValidationError);
        expect((err as ClaimValidationError).code).toBe("DUPLICATE_CLAIM");
      }
    });

    it("rejects invalid transition payloads (negative amount override, invalid fraudRiskScore, non-boolean flags, invalid expectedVersion) with INVALID_CLAIM_DATA without mutating state", () => {
      const config = loadWorkflowConfig(MAIN_CONFIG_PATH);
      const orchestrator = new WorkflowOrchestrator(config);
      const claim = orchestrator.createClaim({
        id: "CLM-VAL-TRANS",
        data: {
          amount: 4000,
          policyLimit: 10000,
          submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
        },
      });

      const negAmountRes = orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-1", role: "document_clerk" },
        input: { amount: -500 },
      });
      expect(negAmountRes.ok).toBe(false);
      if (!negAmountRes.ok) {
        expect(negAmountRes.error.code).toBe("INVALID_CLAIM_DATA");
        expect(negAmountRes.error.message).toContain("'amount' must be a positive number");
      }

      const badFraudScore = orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-1", role: "document_clerk" },
        input: { fraudRiskScore: -15 },
      });
      expect(badFraudScore.ok).toBe(false);
      if (!badFraudScore.ok) {
        expect(badFraudScore.error.code).toBe("INVALID_CLAIM_DATA");
      }

      const badBool = orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-1", role: "document_clerk" },
        input: { assessmentReportComplete: "yes" },
      });
      expect(badBool.ok).toBe(false);
      if (!badBool.ok) {
        expect(badBool.error.code).toBe("INVALID_CLAIM_DATA");
      }

      const badVersion = orchestrator.transition({
        claimId: claim.id,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-1", role: "document_clerk" },
        expectedVersion: 0,
      });
      expect(badVersion.ok).toBe(false);
      if (!badVersion.ok) {
        expect(badVersion.error.code).toBe("INVALID_CLAIM_DATA");
      }

      // Claim remains completely unchanged at v1 in SUBMITTED with original amount 4000
      const persisted = orchestrator.getClaim(claim.id)!;
      expect(persisted.state).toBe("SUBMITTED");
      expect(persisted.version).toBe(1);
      expect(persisted.data.amount).toBe(4000);
    });
  });

  describe("CLI Command & Argument Validation", () => {
    it("rejects negative/zero/non-numeric amounts, policy limits, conflicting limit flags, and invalid --docs in CLI create", () => {
      const session = new CliSession(undefined, undefined, false);

      expect(session.executeCommand("create --amount -3000").output).toContain(
        "[REJECTED — INVALID_CLAIM_DATA]"
      );
      expect(session.executeCommand("create --amount 0").output).toContain(
        "[REJECTED — INVALID_CLAIM_DATA]"
      );
      expect(session.executeCommand("create --amount abc").output).toContain(
        "[REJECTED — INVALID_CLAIM_DATA]"
      );
      expect(session.executeCommand("create --policy-limit -100").output).toContain(
        "[REJECTED — INVALID_CLAIM_DATA]"
      );
      expect(session.executeCommand("create --limit 0").output).toContain(
        "[REJECTED — INVALID_CLAIM_DATA]"
      );
      expect(session.executeCommand("create --set amount=-3000").output).toContain(
        "[REJECTED — INVALID_CLAIM_DATA]"
      );
      expect(
        session.executeCommand("create --policy-limit 10000 --limit 8000").output
      ).toContain("[REJECTED — INVALID_CLAIM_DATA]");
      expect(session.executeCommand('create --docs ""').output).toContain(
        "[REJECTED — INVALID_CLAIM_DATA]"
      );
      expect(session.executeCommand("create --docs claim_form,,receipt").output).toContain(
        "[REJECTED — INVALID_CLAIM_DATA]"
      );

      // None of the invalid create commands should have persisted a claim
      expect(session.executeCommand("list").output).toContain("No claims in session yet");

      // Valid --docs none works cleanly
      const emptyDocsCreate = session.executeCommand("create --id C-NODOCS --amount 1200 --docs none");
      expect(emptyDocsCreate.output).toContain("[OK] Created claim C-NODOCS -> SUBMITTED");
      expect(emptyDocsCreate.output).toContain("Docs: []");
    });

    it("preserves numeric-looking string identifiers (e.g. assessorId=101) so assigned-assessor RBAC cannot be bypassed", () => {
      const session = new CliSession(undefined, undefined, false);
      session.executeCommand("create --id C-NUM-ID --amount 3000");
      session.executeCommand("advance C-NUM-ID DOCUMENTS_VERIFIED -r document_clerk -u clerk-1");

      const assignRes = session.executeCommand(
        "advance C-NUM-ID UNDER_ASSESSMENT -r team_lead -u lead-1 -s assessorId=101"
      );
      expect(assignRes.output).toContain("[OK] DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT");

      // Different assessor '202' must be blocked because '101' was preserved as string "101"
      const intruder = session.executeCommand(
        "advance C-NUM-ID APPROVED -r assessor -u 202 -s assessmentReportComplete=true"
      );
      expect(intruder.output).toContain("[REJECTED — UNAUTHORIZED_ROLE]");
      expect(intruder.output).toContain("assigned to assessor '101'");

      // Assigned assessor '101' succeeds
      const owner = session.executeCommand(
        "advance C-NUM-ID APPROVED -r assessor -u 101 -s assessmentReportComplete=true"
      );
      expect(owner.output).toContain("[OK] UNDER_ASSESSMENT -> APPROVED");
    });

    it("validates --set, --json, --expected-version, audit filters, and clock deltas in CLI", () => {
      const session = new CliSession(undefined, undefined, false);
      session.executeCommand("create --id C-FLAGS --amount 2000");

      expect(
        session.executeCommand("advance C-FLAGS DOCUMENTS_VERIFIED -r document_clerk -s malformed_pair").output
      ).toContain("[REJECTED — INVALID_CLAIM_DATA]");

      expect(
        session.executeCommand("advance C-FLAGS DOCUMENTS_VERIFIED -r document_clerk --json '[1,2,3]'").output
      ).toContain("[REJECTED — INVALID_CLAIM_DATA]");

      expect(
        session.executeCommand("advance C-FLAGS DOCUMENTS_VERIFIED -r document_clerk --expected-version -1").output
      ).toContain("[REJECTED — INVALID_CLAIM_DATA]");

      expect(session.executeCommand("audit C-FLAGS --outcome maybe").output).toContain(
        "[REJECTED — INVALID_CLAIM_DATA]"
      );
      expect(session.executeCommand("audit C-FLAGS -n 0").output).toContain(
        "[REJECTED — INVALID_CLAIM_DATA]"
      );
      expect(session.executeCommand("audit C-FLAGS -n -5").output).toContain(
        "[REJECTED — INVALID_CLAIM_DATA]"
      );

      const clockBefore = session.executeCommand("clock").output;
      expect(session.executeCommand("clock -5").output).toContain("[REJECTED — INVALID_CLAIM_DATA]");
      expect(session.executeCommand("clock 0").output).toContain("[REJECTED — INVALID_CLAIM_DATA]");
      expect(session.executeCommand("clock abc").output).toContain("[REJECTED — INVALID_CLAIM_DATA]");
      expect(session.executeCommand("clock").output).toBe(clockBefore);
    });
  });

  describe("Web API Endpoint Validation", () => {
    it("returns HTTP 400 on invalid claim data, malformed JSON, or negative clock deltas, and HTTP 409 on duplicate claim IDs", async () => {
      const { app } = createWorkflowApp({ silent: true });

      const negAmountRes = await app.request("/api/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "C-BAD-WEB", data: { amount: -3000, policyLimit: 10000 } }),
      });
      expect(negAmountRes.status).toBe(400);
      const negJson = (await negAmountRes.json()) as { ok: boolean; error: { code: string } };
      expect(negJson.ok).toBe(false);
      expect(negJson.error.code).toBe("INVALID_CLAIM_DATA");

      const badJsonRes = await app.request("/api/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{bad json",
      });
      expect(badJsonRes.status).toBe(400);

      // Valid create followed by duplicate ID -> 409
      const okRes = await app.request("/api/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "C-WEB-1", data: { amount: 4000, policyLimit: 10000 } }),
      });
      expect(okRes.status).toBe(201);

      const dupRes = await app.request("/api/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "C-WEB-1", data: { amount: 4000, policyLimit: 10000 } }),
      });
      expect(dupRes.status).toBe(409);

      // Invalid transition input -> 400
      const badAdvance = await app.request("/api/claims/C-WEB-1/advance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toState: "DOCUMENTS_VERIFIED",
          actor: { role: "document_clerk", userId: "clerk-1" },
          input: { amount: -100 },
        }),
      });
      expect(badAdvance.status).toBe(400);

      // Negative or zero clock delta -> 400
      const negClock = await app.request("/api/clock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: -10 }),
      });
      expect(negClock.status).toBe(400);

      const zeroClock = await app.request("/api/clock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: 0 }),
      });
      expect(zeroClock.status).toBe(400);
    });
  });
});

