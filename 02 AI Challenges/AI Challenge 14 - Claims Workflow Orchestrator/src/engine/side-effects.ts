import { cloneAndFreeze } from "../domain/freeze.js";
import type { ExecutedSideEffect, OutboxEvent } from "../domain/types.js";
import type { OutboxStore } from "./outbox-store.js";
import { resolveScopedPath } from "./rule-evaluator.js";
import type {
  PreparedSideEffectPlan,
  RuleEvaluationContext,
  SideEffectConfig,
  SideEffectMutationResult,
} from "./types.js";

/**
 * Interpolates `{{scope.path}}` placeholders in side-effect message templates
 * against the current `{ claim, input, effective, now }` evaluation context.
 */
export function interpolateTemplate(template: string, ctx: RuleEvaluationContext): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, rawPath: string) => {
    const resolved = resolveScopedPath(rawPath, ctx);
    if (resolved === undefined || resolved === null) {
      return "N/A";
    }
    if (typeof resolved === "object") {
      return JSON.stringify(resolved);
    }
    return String(resolved);
  });
}

/**
 * Step 1 of side-effect processing:
 * Applies synchronous claim-data patches (e.g. `create_payment_request`, `record_timestamp`,
 * `reset_timer`, `trigger_payment`, `archive_claim`, `set_field`) to a candidate copy of
 * `claim.data` BEFORE committing the transition and computing the audit delta.
 */
export function applySideEffectMutations(
  sideEffects: readonly SideEffectConfig[],
  baseContext: RuleEvaluationContext,
  nextSequence: () => number
): SideEffectMutationResult {
  const workingData: Record<string, unknown> = structuredClone(
    baseContext.effective as Record<string, unknown>
  );
  const plans: PreparedSideEffectPlan[] = [];
  const nowIso = baseContext.now.toISOString();

  for (const effect of sideEffects) {
    let patchedFields: Record<string, unknown> | undefined;
    let clearedFields: string[] | undefined;

    switch (effect.type) {
      case "notify": {
        break;
      }

      case "record_timestamp": {
        workingData[effect.field] = nowIso;
        patchedFields = { [effect.field]: nowIso };
        break;
      }

      case "create_payment_request": {
        const seq = String(nextSequence()).padStart(4, "0");
        const paymentRequestId = `PR-${baseContext.claim.id}-${seq}`;
        workingData[effect.field] = paymentRequestId;
        patchedFields = { [effect.field]: paymentRequestId };
        break;
      }

      case "reset_timer": {
        delete workingData[effect.clearField];
        workingData[`${effect.timer}TimerResetAt`] = nowIso;
        patchedFields = { [`${effect.timer}TimerResetAt`]: nowIso };
        clearedFields = [effect.clearField];
        break;
      }

      case "trigger_payment": {
        const seq = String(nextSequence()).padStart(4, "0");
        const transactionId = `PAY-${baseContext.claim.id}-${seq}`;
        workingData[effect.field] = transactionId;
        patchedFields = { [effect.field]: transactionId };
        break;
      }

      case "archive_claim": {
        workingData[effect.field] = nowIso;
        workingData.archived = true;
        patchedFields = { [effect.field]: nowIso, archived: true };
        break;
      }

      case "set_field": {
        workingData[effect.field] = effect.value;
        patchedFields = { [effect.field]: effect.value };
        break;
      }
    }

    const updatedCtx: RuleEvaluationContext = {
      claim: baseContext.claim,
      input: baseContext.input,
      effective: workingData,
      now: baseContext.now,
    };

    const renderedMessage = interpolateTemplate(effect.message, updatedCtx);
    plans.push({
      config: effect,
      renderedMessage,
      ...(patchedFields !== undefined ? { patchedFields: cloneAndFreeze(patchedFields) } : {}),
      ...(clearedFields !== undefined ? { clearedFields: cloneAndFreeze(clearedFields) } : {}),
    });
  }

  return {
    nextData: workingData,
    plans: cloneAndFreeze(plans),
  };
}

/**
 * Step 2 of side-effect processing:
 * Enqueues every prepared side effect into the Transactional Outbox and dispatches
 * pending events after the state transition has been committed.
 */
export function enqueueAndDispatchSideEffects(
  claimId: string,
  auditEntryId: string,
  timestamp: string,
  plans: readonly PreparedSideEffectPlan[],
  outboxStore: OutboxStore
): {
  readonly executedSideEffects: readonly ExecutedSideEffect[];
  readonly outboxEvents: readonly OutboxEvent[];
} {
  const enqueuedIds: string[] = [];

  for (const plan of plans) {
    const target = plan.config.type === "notify" ? plan.config.target : undefined;
    const event = outboxStore.enqueue({
      claimId,
      auditEntryId,
      timestamp,
      type: plan.config.type,
      ...(target !== undefined ? { target } : {}),
      message: plan.renderedMessage,
    });
    enqueuedIds.push(event.id);
  }

  const dispatchedEvents = outboxStore.dispatchPending(claimId);
  const executedSideEffects: ExecutedSideEffect[] = plans.map((plan, idx) => {
    const target = plan.config.type === "notify" ? plan.config.target : undefined;
    const outboxEventId = enqueuedIds[idx];
    return {
      type: plan.config.type,
      description: plan.renderedMessage,
      ...(target !== undefined ? { target } : {}),
      ...(plan.patchedFields !== undefined ? { patchedFields: plan.patchedFields } : {}),
      ...(outboxEventId !== undefined ? { outboxEventId } : {}),
    };
  });

  return {
    executedSideEffects: cloneAndFreeze(executedSideEffects),
    outboxEvents: dispatchedEvents,
  };
}
