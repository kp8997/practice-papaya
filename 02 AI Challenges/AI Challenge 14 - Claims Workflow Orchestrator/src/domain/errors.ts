import { cloneAndFreeze } from "./freeze.js";

export type WorkflowErrorCode =
  | "CLAIM_NOT_FOUND"
  | "INVALID_CLAIM_DATA"
  | "CONCURRENCY_CONFLICT"
  | "TERMINAL_STATE"
  | "INVALID_TRANSITION"
  | "UNAUTHORIZED_ROLE"
  | "CYCLE_LIMIT_EXCEEDED"
  | "PRECONDITION_FAILED";

export interface WorkflowErrorDetail {
  readonly code: WorkflowErrorCode;
  readonly message: string;
  readonly claimId: string;
  readonly fromState?: string;
  readonly toState?: string;
  readonly failedPreconditions?: readonly string[];
  readonly allowedTransitions?: readonly {
    readonly to: string;
    readonly roles: readonly string[];
  }[];
  readonly requiredRoles?: readonly string[];
}

export function createWorkflowError(detail: WorkflowErrorDetail): Readonly<WorkflowErrorDetail> {
  return cloneAndFreeze(detail);
}

