import type { WorkflowErrorCode } from "../domain/errors.js";
import type {
  Actor,
  AuditDelta,
  AuditOutcome,
  Claim,
  ClaimData,
  Clock,
  ExecutedSideEffect,
  OutboxEvent,
} from "../domain/types.js";
import type { AuditStore } from "./audit-store.js";
import type { OutboxStore } from "./outbox-store.js";

/* -------------------------------------------------------------------------- */
/* CONFIGURATION SCHEMA CONTRACTS                                             */
/* -------------------------------------------------------------------------- */

export type ScopedPath = string;

export type PrimitiveValue = string | number | boolean | null;

export type LeafCondition =
  | { op: "present"; path: ScopedPath }
  | { op: "not_empty"; path: ScopedPath }
  | { op: "equals"; path: ScopedPath; value: PrimitiveValue }
  | { op: "gt"; path: ScopedPath; value: number }
  | { op: "gte"; path: ScopedPath; value: number }
  | { op: "lte"; path: ScopedPath; value: number }
  | { op: "lte_path"; path: ScopedPath; otherPath: ScopedPath }
  | { op: "includes_all"; path: ScopedPath; requiredPath: ScopedPath }
  | { op: "days_in_state_gte"; days: number };

export type Condition =
  | LeafCondition
  | { all_of: Condition[] }
  | { any_of: Condition[] }
  | { not: Condition };

export interface PreconditionConfig {
  description: string;
  check: Condition;
}

export type SideEffectConfig =
  | { type: "notify"; target: string; message: string }
  | { type: "record_timestamp"; field: string; message: string }
  | { type: "create_payment_request"; field: string; message: string }
  | {
      type: "reset_timer";
      timer: string;
      clearField: string;
      message: string;
    }
  | { type: "trigger_payment"; field: string; message: string }
  | { type: "archive_claim"; field: string; message: string }
  | {
      type: "set_field";
      field: string;
      value: unknown;
      message: string;
    };

export interface StateDefinition {
  description: string;
  terminal: boolean;
}

export interface TransitionDefinition {
  from: string;
  to: string;
  roles: string[];
  preconditions: PreconditionConfig[];
  sideEffects: SideEffectConfig[];
}

export interface CyclePolicy {
  id: string;
  description: string;
  path: string[];
  maxCycles: number;
  errorMessage: string;
}

export interface WorkflowDefaults {
  requiredDocuments: string[];
}

export interface WorkflowConfig {
  name: string;
  version: string;
  initialState: string;
  defaults: WorkflowDefaults;
  roles: string[];
  states: Record<string, StateDefinition>;
  transitions: TransitionDefinition[];
  cyclePolicies: CyclePolicy[];
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* AUDIT TRAIL CONTRACTS                                                      */
/* -------------------------------------------------------------------------- */

export interface AppendAuditInput {
  readonly id?: string;
  readonly claimId: string;
  readonly timestamp: string;
  readonly fromState: string | null;
  readonly toState: string;
  readonly triggeredBy: Actor;
  readonly notes: string;
  readonly outcome: AuditOutcome;
  readonly errorCode?: WorkflowErrorCode;
  readonly workflowVersion: string;
  readonly claimVersion: number;
  readonly delta?: AuditDelta;
  readonly sideEffects?: readonly ExecutedSideEffect[];
}

export interface ReplayedClaimTrajectory {
  readonly claimId: string;
  readonly currentState: string | null;
  readonly version: number;
  readonly stateHistory: readonly string[];
  readonly deniedAttempts: number;
  readonly data: ClaimData;
}

/* -------------------------------------------------------------------------- */
/* TRANSACTIONAL OUTBOX CONTRACTS                                             */
/* -------------------------------------------------------------------------- */

export interface EnqueueOutboxInput {
  readonly claimId: string;
  readonly auditEntryId: string;
  readonly timestamp: string;
  readonly type: string;
  readonly target?: string;
  readonly message: string;
}

export type OutboxDispatcher = (event: OutboxEvent) => void;

export interface OutboxStoreOptions {
  readonly clock?: Clock;
  readonly dispatcher?: OutboxDispatcher;
}

/* -------------------------------------------------------------------------- */
/* RULE EVALUATOR CONTRACTS                                                   */
/* -------------------------------------------------------------------------- */

export interface RuleEvaluationContext {
  readonly claim: Claim;
  readonly input: Readonly<Record<string, unknown>>;
  readonly effective: Readonly<Record<string, unknown>>;
  readonly now: Date;
}

export interface ConditionEvaluationOutcome {
  readonly passed: boolean;
  readonly reason: string;
}

/* -------------------------------------------------------------------------- */
/* SIDE EFFECT CONTRACTS                                                      */
/* -------------------------------------------------------------------------- */

export interface PreparedSideEffectPlan {
  readonly config: SideEffectConfig;
  readonly renderedMessage: string;
  readonly patchedFields?: Readonly<Record<string, unknown>>;
  readonly clearedFields?: readonly string[];
}

export interface SideEffectMutationResult {
  readonly nextData: Record<string, unknown>;
  readonly plans: readonly PreparedSideEffectPlan[];
}

export interface SideEffectExecutionResult {
  readonly executedSideEffects: readonly ExecutedSideEffect[];
  readonly outboxEvents: readonly OutboxEvent[];
}

/* -------------------------------------------------------------------------- */
/* ORCHESTRATOR CONTRACTS                                                     */
/* -------------------------------------------------------------------------- */

export interface WorkflowOrchestratorOptions {
  readonly clock?: Clock;
  readonly auditStore?: AuditStore;
  readonly outboxStore?: OutboxStore;
  readonly outboxDispatcher?: OutboxDispatcher;
  readonly enforceAssignedAssessor?: boolean;
}
