import type {
  Actor,
  AuditEntry,
  AvailableTransition,
  Claim,
} from "../domain/types.js";
import type { ReplayedClaimTrajectory } from "../engine/types.js";

export interface SessionOptions {
  readonly configPath?: string;
  readonly initialClockIso?: string;
}

export interface ClockSnapshot {
  readonly iso: string;
  readonly timestamp: number;
}

export interface ClockAdvanceInput {
  readonly days?: number;
  readonly hours?: number;
  readonly minutes?: number;
}

export interface CreateClaimSessionInput {
  readonly id?: string;
  readonly actor?: Actor;
  readonly amount?: number;
  readonly policyLimit?: number;
  readonly submittedDocuments?: readonly string[];
  readonly notes?: string;
  readonly extraData?: Readonly<Record<string, unknown>>;
}

export interface AdvanceClaimSessionInput {
  readonly claimId: string;
  readonly toState: string;
  readonly role: string;
  readonly userId?: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly notes?: string;
  readonly expectedVersion?: number;
  readonly idempotencyKey?: string;
}

export interface ClaimDetailView {
  readonly claim: Claim;
  readonly availableTransitions: readonly AvailableTransition[];
}

export interface AuditReportView {
  readonly claimId: string;
  readonly count: number;
  readonly entries: readonly AuditEntry[];
  readonly replay: ReplayedClaimTrajectory;
}

export interface SeedClaimsResult {
  readonly seeded: readonly string[];
  readonly claims: readonly Claim[];
}
