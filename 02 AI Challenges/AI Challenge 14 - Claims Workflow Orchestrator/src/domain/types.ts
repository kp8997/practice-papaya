import type { WorkflowErrorCode, WorkflowErrorDetail } from "./errors.js";

export interface Clock {
  now(): Date;
}

export const SystemClock: Clock = {
  now: () => new Date(),
};

export interface Actor {
  readonly userId: string;
  readonly role: string;
}

export type ClaimData = Readonly<Record<string, unknown>>;

export interface Claim {
  readonly id: string;
  readonly state: string;
  readonly version: number;
  readonly workflowVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stateEnteredAt: string;
  readonly data: ClaimData;
}

export interface CreateClaimInput {
  readonly id?: string;
  readonly actor?: Actor;
  readonly data?: Record<string, unknown>;
  readonly notes?: string;
}

export interface TransitionRequest {
  readonly claimId: string;
  readonly toState: string;
  readonly actor: Actor;
  readonly input?: Record<string, unknown>;
  readonly notes?: string;
  readonly expectedVersion?: number;
  readonly idempotencyKey?: string;
}

export type AuditOutcome = "SUCCESS" | "DENIED";

export interface AuditFieldChange {
  readonly before: unknown;
  readonly after: unknown;
}

export type AuditDelta = Readonly<Record<string, AuditFieldChange>>;

export interface ExecutedSideEffect {
  readonly type: string;
  readonly description: string;
  readonly target?: string;
  readonly patchedFields?: Readonly<Record<string, unknown>>;
  readonly outboxEventId?: string;
}

/**
 * Immutable compliance audit trail entry.
 * Includes the required spec fields (`timestamp`, `from_state`, `to_state`,
 * `triggered_by` user ID + role, `reason/notes`) alongside camelCase aliases,
 * field-level `delta`, `workflowVersion`, and `outcome`.
 */
export interface AuditEntry {
  readonly id: string;
  readonly claimId: string;
  readonly timestamp: string;
  readonly from_state: string | null;
  readonly to_state: string;
  readonly triggered_by: Actor;
  readonly reason: string;
  readonly fromState: string | null;
  readonly toState: string;
  readonly triggeredBy: Actor;
  readonly notes: string;
  readonly outcome: AuditOutcome;
  readonly errorCode?: WorkflowErrorCode;
  readonly workflowVersion: string;
  readonly claimVersion: number;
  readonly delta: AuditDelta;
  readonly sideEffects: readonly ExecutedSideEffect[];
}

export type OutboxEventStatus = "PENDING" | "DISPATCHED" | "FAILED";

export interface OutboxEvent {
  readonly id: string;
  readonly claimId: string;
  readonly auditEntryId: string;
  readonly timestamp: string;
  readonly type: string;
  readonly target?: string;
  readonly message: string;
  readonly status: OutboxEventStatus;
  readonly dispatchedAt?: string;
  readonly errorMessage?: string;
}

export interface PreconditionCheckResult {
  readonly description: string;
  readonly passed: boolean;
  readonly failureReason?: string;
}

export interface CycleStatusPreview {
  readonly policyId: string;
  readonly currentCount: number;
  readonly maxCycles: number;
  readonly exceeded: boolean;
  readonly errorMessage: string;
}

export interface AvailableTransition {
  readonly from: string;
  readonly to: string;
  readonly roles: readonly string[];
  readonly preconditions: readonly PreconditionCheckResult[];
  readonly allPreconditionsMet: boolean;
  readonly cycleStatus?: CycleStatusPreview;
}

export interface TransitionSuccess {
  readonly ok: true;
  readonly idempotentReplay: boolean;
  readonly claim: Claim;
  readonly auditEntry: AuditEntry;
  readonly sideEffects: readonly ExecutedSideEffect[];
  readonly outboxEvents: readonly OutboxEvent[];
}

export interface TransitionFailure {
  readonly ok: false;
  readonly idempotentReplay: boolean;
  readonly error: WorkflowErrorDetail;
  readonly claim?: Claim;
  readonly auditEntry?: AuditEntry;
}

export type TransitionResult = TransitionSuccess | TransitionFailure;

