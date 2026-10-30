import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WorkflowConfigError,
  loadWorkflowConfig,
  parseWorkflowConfig,
} from "../../src/engine/config-schema.js";

const MAIN_CONFIG_PATH = resolve(import.meta.dirname, "../../config/claims-workflow.yaml");

describe("Phase 1 — Workflow Config Schema & Loader", () => {
  it("loads and validates the primary claims-workflow.yaml matching all 8 spec states, 5 roles, and 9 transitions", () => {
    const config = loadWorkflowConfig(MAIN_CONFIG_PATH);

    expect(config.initialState).toBe("SUBMITTED");
    expect(Object.keys(config.states)).toEqual([
      "SUBMITTED",
      "DOCUMENTS_VERIFIED",
      "UNDER_ASSESSMENT",
      "PENDING_INFO",
      "APPROVED",
      "REJECTED",
      "PAYMENT_INITIATED",
      "CLOSED",
    ]);
    expect(config.states.CLOSED?.terminal).toBe(true);
    expect(config.roles).toEqual([
      "document_clerk",
      "team_lead",
      "assessor",
      "finance",
      "system",
    ]);
    expect(config.transitions).toHaveLength(9);
    expect(config.cyclePolicies).toHaveLength(1);
    expect(config.cyclePolicies[0]?.maxCycles).toBe(3);
    expect(config.cyclePolicies[0]?.errorMessage).toBe(
      "Maximum information requests exceeded — escalate to team lead"
    );
  });

  it("rejects transitions referencing an undeclared target state", () => {
    const raw = loadWorkflowConfig(MAIN_CONFIG_PATH);
    const broken = structuredClone(raw);
    broken.transitions.push({
      from: "SUBMITTED",
      to: "NON_EXISTENT_STATE",
      roles: ["document_clerk"],
      preconditions: [],
      sideEffects: [],
    });

    expect(() => parseWorkflowConfig(broken)).toThrowError(WorkflowConfigError);
    expect(() => parseWorkflowConfig(broken)).toThrow(/unknown target state 'NON_EXISTENT_STATE'/);
  });

  it("rejects transitions originating from a terminal state", () => {
    const raw = loadWorkflowConfig(MAIN_CONFIG_PATH);
    const broken = structuredClone(raw);
    broken.transitions.push({
      from: "CLOSED",
      to: "SUBMITTED",
      roles: ["system"],
      preconditions: [],
      sideEffects: [],
    });

    expect(() => parseWorkflowConfig(broken)).toThrow(/Terminal state 'CLOSED' cannot have outgoing transitions/);
  });

  it("rejects transitions referencing an undeclared role", () => {
    const raw = loadWorkflowConfig(MAIN_CONFIG_PATH);
    const broken = structuredClone(raw);
    if (broken.transitions[0]) {
      broken.transitions[0].roles = ["rogue_admin"];
    }

    expect(() => parseWorkflowConfig(broken)).toThrow(/undeclared role 'rogue_admin'/);
  });

  it("rejects unreachable states and dead-end non-terminal states", () => {
    const raw = loadWorkflowConfig(MAIN_CONFIG_PATH);
    const broken = structuredClone(raw);
    broken.states.ORPHAN_STATE = {
      description: "Disconnected state",
      terminal: false,
    };

    expect(() => parseWorkflowConfig(broken)).toThrow(/ORPHAN_STATE/);
  });

  it("rejects cycle policies whose path steps do not match real transitions", () => {
    const raw = loadWorkflowConfig(MAIN_CONFIG_PATH);
    const broken = structuredClone(raw);
    if (broken.cyclePolicies[0]) {
      broken.cyclePolicies[0].path = [
        "UNDER_ASSESSMENT",
        "APPROVED",
        "UNDER_ASSESSMENT",
      ];
    }

    expect(() => parseWorkflowConfig(broken)).toThrow(/is not a defined transition/);
  });

  it("rejects malformed scoped paths in preconditions", () => {
    const raw = loadWorkflowConfig(MAIN_CONFIG_PATH);
    const broken = structuredClone(raw) as Record<string, unknown>;
    (broken.transitions as Array<Record<string, unknown>>)[1] = {
      from: "DOCUMENTS_VERIFIED",
      to: "UNDER_ASSESSMENT",
      roles: ["team_lead"],
      preconditions: [
        {
          description: "Bad path prefix",
          check: { op: "not_empty", path: "wrongScope.assessorId" },
        },
      ],
      sideEffects: [],
    };

    expect(() => parseWorkflowConfig(broken)).toThrow(
      /Path must start with 'claim\.', 'input\.', or 'effective\.'/
    );
  });
});

