import { describe, expect, it } from "vitest";
import { createWorkflowError } from "../../src/domain/errors.js";
import { cloneAndFreeze, deepFreeze } from "../../src/domain/freeze.js";
import type { Claim } from "../../src/domain/types.js";
import {
  AuditStore,
  computeDataDelta,
  replayClaimHistory,
} from "../../src/engine/audit-store.js";
import { OutboxStore } from "../../src/engine/outbox-store.js";
import {
  evaluateCondition,
  evaluatePreconditions,
  resolveScopedPath,
  type RuleEvaluationContext,
} from "../../src/engine/rule-evaluator.js";

function makeSampleClaim(overrides: Partial<Claim> = {}): Claim {
  return cloneAndFreeze({
    id: "C-100",
    state: "UNDER_ASSESSMENT",
    version: 2,
    workflowVersion: "1.0.0",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T01:00:00.000Z",
    stateEnteredAt: "2026-10-01T00:00:00.000Z",
    data: {
      amount: 8000,
      policyLimit: 10000,
      requiredDocuments: ["claim_form", "medical_report"],
      submittedDocuments: ["claim_form", "medical_report"],
      assessorId: "u-assessor-1",
      nested: { report: { status: "complete" } },
    },
    ...overrides,
  });
}

describe("Phase 2 — Domain Core, RuleEvaluator, AuditStore & OutboxStore", () => {
  describe("Immutability & Error Primitives (freeze.ts & errors.ts)", () => {
    it("clones and deeply freezes nested objects and arrays so caller and consumer mutations fail", () => {
      const source = { nested: { tags: ["initial"] } };
      const frozen = cloneAndFreeze(source);

      // Mutating original source does not affect the frozen clone
      source.nested.tags.push("mutated-outside");
      expect(frozen.nested.tags).toEqual(["initial"]);

      // Mutating frozen clone throws TypeError
      expect(() => {
        (frozen.nested.tags as string[]).push("tamper");
      }).toThrow(TypeError);

      const err = createWorkflowError({
        code: "UNAUTHORIZED_ROLE",
        message: "Role not allowed",
        claimId: "C-100",
        requiredRoles: ["assessor"],
      });
      expect(Object.isFrozen(err)).toBe(true);
      expect(Object.isFrozen(err.requiredRoles)).toBe(true);
      expect(deepFreeze(42)).toBe(42);
    });
  });

  describe("RuleEvaluator & Scoped Paths (rule-evaluator.ts)", () => {
    it("resolves claim.*, input.*, and effective.* scopes accurately (including nested paths)", () => {
      const claim = makeSampleClaim();
      const input = { amount: 12000, freshNote: "added now" };
      const ctx: RuleEvaluationContext = {
        claim,
        input,
        effective: { ...claim.data, ...input },
        now: new Date("2026-10-05T00:00:00.000Z"),
      };

      // claim.amount reads persisted claim data (8000), while effective.amount reads merged (12000)
      expect(resolveScopedPath("claim.amount", ctx)).toBe(8000);
      expect(resolveScopedPath("input.amount", ctx)).toBe(12000);
      expect(resolveScopedPath("effective.amount", ctx)).toBe(12000);
      expect(resolveScopedPath("claim.freshNote", ctx)).toBeUndefined();
      expect(resolveScopedPath("input.freshNote", ctx)).toBe("added now");
      expect(resolveScopedPath("claim.nested.report.status", ctx)).toBe("complete");
      expect(resolveScopedPath("claim.id", ctx)).toBe("C-100");
    });

    it("rejects empty strings, whitespace-only strings, and arrays containing blank items in not_empty", () => {
      const claim = makeSampleClaim();
      const ctx: RuleEvaluationContext = {
        claim,
        input: {
          blankText: "   ",
          emptyArray: [],
          arrayWithBlankItem: ["valid_doc.pdf", "   "],
          validArray: ["valid_doc.pdf"],
        },
        effective: claim.data,
        now: new Date("2026-10-05T00:00:00.000Z"),
      };

      expect(evaluateCondition({ op: "not_empty", path: "input.blankText" }, ctx).passed).toBe(
        false
      );
      expect(evaluateCondition({ op: "not_empty", path: "input.emptyArray" }, ctx).passed).toBe(
        false
      );
      expect(
        evaluateCondition({ op: "not_empty", path: "input.arrayWithBlankItem" }, ctx).passed
      ).toBe(false);
      expect(evaluateCondition({ op: "not_empty", path: "input.validArray" }, ctx).passed).toBe(
        true
      );
    });

    it("evaluates present, equals, gt, gte, lte, lte_path, not, and rejects NaN / Infinity", () => {
      const claim = makeSampleClaim({
        data: {
          amount: 12000,
          policyLimit: 10000,
          badNum: Number.NaN,
          infNum: Number.POSITIVE_INFINITY,
          zeroVal: -0,
        },
      });
      const ctx: RuleEvaluationContext = {
        claim,
        input: {},
        effective: claim.data,
        now: new Date("2026-10-05T00:00:00.000Z"),
      };

      expect(evaluateCondition({ op: "present", path: "effective.amount" }, ctx).passed).toBe(true);
      expect(evaluateCondition({ op: "present", path: "effective.missing" }, ctx).passed).toBe(
        false
      );
      expect(
        evaluateCondition({ op: "equals", path: "effective.zeroVal", value: 0 }, ctx).passed
      ).toBe(true);
      expect(
        evaluateCondition({ op: "gte", path: "effective.amount", value: 12000 }, ctx).passed
      ).toBe(true);
      expect(
        evaluateCondition({ op: "lte", path: "effective.policyLimit", value: 10000 }, ctx).passed
      ).toBe(true);
      expect(
        evaluateCondition(
          { not: { op: "equals", path: "effective.amount", value: 9999 } },
          ctx
        ).passed
      ).toBe(true);

      const lteOutcome = evaluateCondition(
        { op: "lte_path", path: "effective.amount", otherPath: "effective.policyLimit" },
        ctx
      );
      expect(lteOutcome.passed).toBe(false);
      expect(lteOutcome.reason).toContain("12000");
      expect(lteOutcome.reason).toContain("10000");

      expect(evaluateCondition({ op: "gt", path: "effective.badNum", value: 0 }, ctx).passed).toBe(
        false
      );
      expect(
        evaluateCondition({ op: "lte", path: "effective.infNum", value: 999999 }, ctx).passed
      ).toBe(false);
    });

    it("reports missing required items clearly in includes_all", () => {
      const claim = makeSampleClaim({
        data: {
          requiredDocuments: ["claim_form", "medical_report", "itemized_receipt"],
          submittedDocuments: ["claim_form"],
        },
      });
      const ctx: RuleEvaluationContext = {
        claim,
        input: {},
        effective: claim.data,
        now: new Date("2026-10-05T00:00:00.000Z"),
      };

      const res = evaluatePreconditions(
        [
          {
            description: "All required documents present",
            check: {
              op: "includes_all",
              path: "effective.submittedDocuments",
              requiredPath: "effective.requiredDocuments",
            },
          },
        ],
        ctx
      );

      expect(res[0]?.passed).toBe(false);
      expect(res[0]?.failureReason).toContain("medical_report");
      expect(res[0]?.failureReason).toContain("itemized_receipt");
    });

    it("evaluates days_in_state_gte and any_of / all_of combinators using the injected clock", () => {
      const claim = makeSampleClaim({
        state: "REJECTED",
        stateEnteredAt: "2026-10-01T00:00:00.000Z",
        data: { memberAcknowledged: false },
      });

      const day10Ctx: RuleEvaluationContext = {
        claim,
        input: {},
        effective: claim.data,
        now: new Date("2026-10-11T00:00:00.000Z"),
      };
      const day31Ctx: RuleEvaluationContext = {
        claim,
        input: {},
        effective: claim.data,
        now: new Date("2026-11-01T00:00:00.000Z"),
      };

      const appealRule = {
        any_of: [
          { op: "days_in_state_gte" as const, days: 30 },
          { op: "equals" as const, path: "effective.memberAcknowledged" as const, value: true },
        ],
      };

      expect(evaluateCondition(appealRule, day10Ctx).passed).toBe(false);
      expect(evaluateCondition(appealRule, day31Ctx).passed).toBe(true);
    });
  });

  describe("AuditStore Immutability, Deltas & Replay (audit-store.ts)", () => {
    it("enforces runtime immutability on audit entries, isolates claims, and blocks array mutation", () => {
      const store = new AuditStore();
      const entry = store.append({
        claimId: "C-1",
        timestamp: "2026-10-01T00:00:00.000Z",
        fromState: "SUBMITTED",
        toState: "DOCUMENTS_VERIFIED",
        triggeredBy: { userId: "u-clerk", role: "document_clerk" },
        notes: "Verified all documents",
        outcome: "SUCCESS",
        workflowVersion: "1.0.0",
        claimVersion: 2,
      });

      store.append({
        claimId: "C-2",
        timestamp: "2026-10-01T00:01:00.000Z",
        fromState: null,
        toState: "SUBMITTED",
        triggeredBy: { userId: "system", role: "system" },
        notes: "Other claim",
        outcome: "SUCCESS",
        workflowVersion: "1.0.0",
        claimVersion: 1,
      });

      expect(entry.from_state).toBe("SUBMITTED");
      expect(entry.to_state).toBe("DOCUMENTS_VERIFIED");
      expect(entry.triggered_by).toEqual({ userId: "u-clerk", role: "document_clerk" });
      expect(entry.reason).toBe("Verified all documents");

      // Querying by claim ID returns only that claim's entries
      expect(store.getByClaimId("C-1")).toHaveLength(1);
      expect(store.getByClaimId("C-2")).toHaveLength(1);
      expect(store.getAll()).toHaveLength(2);

      // Attempting to mutate any field or nested object must throw TypeError
      expect(() => {
        (entry as { notes: string }).notes = "tampered";
      }).toThrow(TypeError);
      expect(() => {
        (entry.triggeredBy as { role: string }).role = "assessor";
      }).toThrow(TypeError);

      const history = store.getByClaimId("C-1");
      expect(() => {
        (history as unknown as AuditStore[]).pop();
      }).toThrow(TypeError);
    });

    it("computes field deltas (including removed fields vs explicit null) and replays state accurately", () => {
      const store = new AuditStore();

      const snap1 = {
        amount: 5000,
        policyLimit: 10000,
        submittedDocuments: ["id_card"],
        assessmentStartedAt: "2026-10-01T00:00:00.000Z",
      };
      const delta1 = computeDataDelta({}, snap1);
      store.append({
        claimId: "C-77",
        timestamp: "2026-10-01T00:00:00.000Z",
        fromState: null,
        toState: "SUBMITTED",
        triggeredBy: { userId: "system", role: "system" },
        notes: "Created",
        outcome: "SUCCESS",
        workflowVersion: "1.0.0",
        claimVersion: 1,
        delta: delta1,
      });

      // Denied attempt must not alter replayed state
      store.append({
        claimId: "C-77",
        timestamp: "2026-10-01T00:05:00.000Z",
        fromState: "SUBMITTED",
        toState: "APPROVED",
        triggeredBy: { userId: "u-clerk", role: "document_clerk" },
        notes: "Illegal skip",
        outcome: "DENIED",
        errorCode: "INVALID_TRANSITION",
        workflowVersion: "1.0.0",
        claimVersion: 1,
      });

      // In snap2: assessmentStartedAt is removed (e.g. timer reset), while optionalNote is explicitly null
      const snap2 = {
        amount: 5000,
        policyLimit: 10000,
        submittedDocuments: ["id_card", "invoice"],
        optionalNote: null,
      };
      const delta2 = computeDataDelta(snap1, snap2);
      expect(Object.keys(delta2).sort()).toEqual([
        "assessmentStartedAt",
        "optionalNote",
        "submittedDocuments",
      ]);
      expect(delta2.assessmentStartedAt?.removed).toBe(true);
      expect(delta2.optionalNote?.removed).toBeUndefined();

      store.append({
        claimId: "C-77",
        timestamp: "2026-10-01T00:10:00.000Z",
        fromState: "SUBMITTED",
        toState: "DOCUMENTS_VERIFIED",
        triggeredBy: { userId: "u-clerk", role: "document_clerk" },
        notes: "Docs verified",
        outcome: "SUCCESS",
        workflowVersion: "1.0.0",
        claimVersion: 2,
        delta: delta2,
      });

      const replayed = replayClaimHistory("C-77", store.getByClaimId("C-77"));
      expect(replayed.currentState).toBe("DOCUMENTS_VERIFIED");
      expect(replayed.version).toBe(2);
      expect(replayed.stateHistory).toEqual(["SUBMITTED", "DOCUMENTS_VERIFIED"]);
      expect(replayed.deniedAttempts).toBe(1);
      expect(replayed.data).toEqual(snap2);
      expect("assessmentStartedAt" in replayed.data).toBe(false);
    });
  });

  describe("OutboxStore Transactional Isolation (outbox-store.ts)", () => {
    it("transitions PENDING events to DISPATCHED and isolates handler errors as FAILED", () => {
      const dispatchedMessages: string[] = [];
      const outbox = new OutboxStore({
        dispatcher: (event) => {
          if (event.target === "broken_webhook") {
            throw new Error("Downstream SMTP timeout");
          }
          dispatchedMessages.push(event.message);
        },
      });

      outbox.enqueue({
        claimId: "C-1",
        auditEntryId: "AUD-0001",
        timestamp: "2026-10-01T00:00:00.000Z",
        type: "notify",
        target: "assessor_team",
        message: "Claim C-1 ready",
      });
      outbox.enqueue({
        claimId: "C-1",
        auditEntryId: "AUD-0001",
        timestamp: "2026-10-01T00:00:00.000Z",
        type: "notify",
        target: "broken_webhook",
        message: "Will fail gracefully",
      });

      const processed = outbox.dispatchPending("C-1");
      expect(processed).toHaveLength(2);
      expect(processed[0]?.status).toBe("DISPATCHED");
      expect(processed[1]?.status).toBe("FAILED");
      expect(processed[1]?.errorMessage).toBe("Downstream SMTP timeout");
      expect(dispatchedMessages).toEqual(["Claim C-1 ready"]);
      expect(outbox.getFailedEvents()).toHaveLength(1);
      expect(outbox.getByClaimId("C-1")).toHaveLength(2);
    });
  });
});
