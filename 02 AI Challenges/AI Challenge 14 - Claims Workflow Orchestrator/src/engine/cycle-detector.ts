import { cloneAndFreeze } from "../domain/freeze.js";
import type { AuditEntry, CycleStatusPreview } from "../domain/types.js";
import type { CyclePolicy } from "./config-schema.js";

/**
 * Stateless cycle detector that derives loop iteration counts directly from the
 * immutable AuditStore (`SUCCESS` entries only).
 *
 * For a cycle path `[S0, S1, ..., S0]`, each time a claim transitions along the
 * entry edge `S0 -> S1` (e.g. `UNDER_ASSESSMENT -> PENDING_INFO`), one loop
 * iteration is counted.
 * - Iterations `1..maxCycles` are allowed.
 * - Attempt `maxCycles + 1` (e.g. the 4th attempt when `maxCycles === 3`) is rejected
 *   with `policy.errorMessage`.
 */
export function evaluateCyclePolicy(
  cyclePolicies: readonly CyclePolicy[],
  fromState: string,
  toState: string,
  claimAuditHistory: readonly AuditEntry[]
): CycleStatusPreview | undefined {
  for (const policy of cyclePolicies) {
    const entryFrom = policy.path[0];
    const entryTo = policy.path[1];
    if (entryFrom !== fromState || entryTo !== toState) {
      continue;
    }

    const currentCount = claimAuditHistory.filter(
      (entry) =>
        entry.outcome === "SUCCESS" &&
        entry.fromState === entryFrom &&
        entry.toState === entryTo
    ).length;

    return cloneAndFreeze({
      policyId: policy.id,
      currentCount,
      maxCycles: policy.maxCycles,
      exceeded: currentCount >= policy.maxCycles,
      errorMessage: policy.errorMessage,
    });
  }

  return undefined;
}

