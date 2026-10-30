import { isDeepStrictEqual } from "node:util";
import { cloneAndFreeze, deepFreeze } from "../domain/freeze.js";
import type { WorkflowErrorCode } from "../domain/errors.js";
import type {
  Actor,
  AuditDelta,
  AuditEntry,
  AuditFieldChange,
  AuditOutcome,
  ClaimData,
  ExecutedSideEffect,
} from "../domain/types.js";

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

/**
 * Computes field-by-field `{ before, after }` deltas between two claim data snapshots.
 * Unchanged fields are omitted to keep audit payloads concise and compliance-friendly.
 */
export function computeDataDelta(
  beforeData: Readonly<Record<string, unknown>>,
  afterData: Readonly<Record<string, unknown>>
): AuditDelta {
  const keys = new Set([...Object.keys(beforeData), ...Object.keys(afterData)]);
  const delta: Record<string, AuditFieldChange> = {};

  for (const key of keys) {
    const beforeVal = beforeData[key];
    const afterVal = afterData[key];
    if (!isDeepStrictEqual(beforeVal, afterVal)) {
      const removed = !(key in afterData) || afterVal === undefined;
      delta[key] = {
        before: beforeVal === undefined ? null : structuredClone(beforeVal),
        after: afterVal === undefined ? null : structuredClone(afterVal),
        ...(removed ? { removed: true } : {}),
      };
    }
  }

  return cloneAndFreeze(delta);
}

/**
 * Append-only, tamper-proof audit trail store.
 * - Exposes ONLY `append()` and read queries (`getByClaimId()`, `getAll()`).
 * - Has no update, replace, or delete methods.
 * - Deeply freezes every entry upon creation and returns frozen defensive arrays on query.
 */
export class AuditStore {
  readonly #entries: AuditEntry[] = [];
  #sequence = 0;

  public append(input: AppendAuditInput): AuditEntry {
    this.#sequence += 1;
    const id = input.id ?? `AUD-${String(this.#sequence).padStart(4, "0")}`;
    const actor: Actor = {
      userId: input.triggeredBy.userId,
      role: input.triggeredBy.role,
    };

    const baseEntry: AuditEntry = {
      id,
      claimId: input.claimId,
      timestamp: input.timestamp,
      from_state: input.fromState,
      to_state: input.toState,
      triggered_by: actor,
      reason: input.notes,
      fromState: input.fromState,
      toState: input.toState,
      triggeredBy: actor,
      notes: input.notes,
      outcome: input.outcome,
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      workflowVersion: input.workflowVersion,
      claimVersion: input.claimVersion,
      delta: input.delta ?? {},
      sideEffects: input.sideEffects ?? [],
    };

    const frozenEntry = cloneAndFreeze(baseEntry);
    this.#entries.push(frozenEntry);
    return frozenEntry;
  }

  public getByClaimId(claimId: string): readonly AuditEntry[] {
    const filtered = this.#entries.filter((entry) => entry.claimId === claimId);
    return deepFreeze([...filtered]);
  }

  public getAll(): readonly AuditEntry[] {
    return deepFreeze([...this.#entries]);
  }
}

/**
 * Deterministically reconstructs a claim's current state, version, state history,
 * and accumulated data solely by replaying its immutable audit trail entries.
 */
export function replayClaimHistory(
  claimId: string,
  entries: readonly AuditEntry[]
): ReplayedClaimTrajectory {
  const claimEntries = entries.filter((e) => e.claimId === claimId);
  let currentState: string | null = null;
  let version = 0;
  let deniedAttempts = 0;
  const stateHistory: string[] = [];
  const data: Record<string, unknown> = {};

  for (const entry of claimEntries) {
    if (entry.outcome === "DENIED") {
      deniedAttempts += 1;
      continue;
    }

    currentState = entry.toState;
    version = entry.claimVersion;
    stateHistory.push(entry.toState);

    for (const [field, change] of Object.entries(entry.delta)) {
      if (change.removed) {
        delete data[field];
      } else {
        data[field] = structuredClone(change.after);
      }
    }
  }

  return cloneAndFreeze({
    claimId,
    currentState,
    version,
    stateHistory,
    deniedAttempts,
    data,
  });
}

