import type { Actor, AuditEntry } from "../domain/types.js";

export interface CommandExecutionOutput {
  readonly output: string;
  readonly shouldExit: boolean;
}

export interface CreateCmdOptions {
  readonly id?: string;
  readonly amount?: string;
  readonly policyLimit?: string;
  readonly docs?: string;
  readonly notes?: string;
  readonly set?: string[];
}

export interface AdvanceCmdOptions {
  readonly role?: string;
  readonly user?: string;
  readonly notes?: string;
  readonly expectedVersion?: string;
  readonly idempotencyKey?: string;
  readonly set?: string[];
  readonly json?: string;
}

export interface ScenarioStepSpec {
  readonly action: string;
  readonly advanceMinutes?: number;
  readonly toState: string;
  readonly actor: Actor;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly notes?: string;
}

export interface ScenarioSpec {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly claim: {
    readonly id: string;
    readonly actor: Actor;
    readonly notes: string;
    readonly createDetail: string;
    readonly amount: number;
    readonly policyLimit: number;
    readonly submittedDocuments?: readonly string[];
  };
  readonly steps: readonly ScenarioStepSpec[];
  readonly verify: (ctx: {
    readonly finalState: string;
    readonly finalVersion: number;
    readonly finalData: Readonly<Record<string, unknown>>;
    readonly steps: readonly ScenarioStepRecord[];
  }) => boolean;
}

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

