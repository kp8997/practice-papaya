import { createWorkflowError, type WorkflowErrorCode } from "../domain/errors.js";
import { cloneAndFreeze, deepFreeze } from "../domain/freeze.js";
import {
  SystemClock,
  type Actor,
  type AuditEntry,
  type AvailableTransition,
  type Claim,
  type Clock,
  type CreateClaimInput,
  type OutboxEvent,
  type TransitionFailure,
  type TransitionRequest,
  type TransitionResult,
  type TransitionSuccess,
} from "../domain/types.js";
import {
  AuditStore,
  computeDataDelta,
  replayClaimHistory,
  type ReplayedClaimTrajectory,
} from "./audit-store.js";
import type { TransitionDefinition, WorkflowConfig } from "./config-schema.js";
import { evaluateCyclePolicy } from "./cycle-detector.js";
import { OutboxStore, type OutboxDispatcher } from "./outbox-store.js";
import { evaluatePreconditions, type RuleEvaluationContext } from "./rule-evaluator.js";
import { applySideEffectMutations, enqueueAndDispatchSideEffects } from "./side-effects.js";

export interface WorkflowOrchestratorOptions {
  readonly clock?: Clock;
  readonly auditStore?: AuditStore;
  readonly outboxStore?: OutboxStore;
  readonly outboxDispatcher?: OutboxDispatcher;
  /**
   * When true (default), if a claim has an assigned `assessorId`, transitions requiring
   * role `assessor` must be triggered by that assigned `assessorId` (`actor.userId === claim.data.assessorId`).
   */
  readonly enforceAssignedAssessor?: boolean;
}

/**
 * Merges incoming transition payload with existing claim data.
 * Also accumulates `input.newDocuments` into `submittedDocuments` across `PENDING_INFO` loops.
 */
function buildEffectiveData(
  claimData: Readonly<Record<string, unknown>>,
  input: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...structuredClone(claimData as Record<string, unknown>),
    ...structuredClone(input as Record<string, unknown>),
  };

  if (
    Array.isArray(input.newDocuments) &&
    input.newDocuments.length > 0 &&
    input.submittedDocuments === undefined
  ) {
    const existingDocs = Array.isArray(claimData.submittedDocuments)
      ? (claimData.submittedDocuments as unknown[])
      : [];
    merged.submittedDocuments = Array.from(new Set([...existingDocs, ...input.newDocuments]));
  }

  return merged;
}

export class WorkflowOrchestrator {
  readonly #config: WorkflowConfig;
  readonly #clock: Clock;
  readonly #auditStore: AuditStore;
  readonly #outboxStore: OutboxStore;
  readonly #enforceAssignedAssessor: boolean;
  readonly #claims = new Map<string, Claim>();
  readonly #idempotencyCache = new Map<string, TransitionResult>();
  #claimSequence = 0;
  #sideEffectSequence = 0;
  #auditSequence = 0;

  constructor(config: WorkflowConfig, options: WorkflowOrchestratorOptions = {}) {
    this.#config = cloneAndFreeze(config);
    this.#clock = options.clock ?? SystemClock;
    this.#auditStore = options.auditStore ?? new AuditStore();
    this.#outboxStore =
      options.outboxStore ??
      new OutboxStore({
        clock: this.#clock,
        ...(options.outboxDispatcher !== undefined
          ? { dispatcher: options.outboxDispatcher }
          : {}),
      });
    this.#enforceAssignedAssessor = options.enforceAssignedAssessor ?? true;
  }

  public getConfig(): WorkflowConfig {
    return this.#config;
  }

  /**
   * Creates a new claim in the configured `initialState` and logs the initial audit entry.
   */
  public createClaim(input: CreateClaimInput = {}): Claim {
    this.#claimSequence += 1;
    const id = input.id ?? `C-${this.#claimSequence}`;
    if (this.#claims.has(id)) {
      throw new Error(`Claim '${id}' already exists`);
    }

    const nowIso = this.#clock.now().toISOString();
    const initialData: Record<string, unknown> = {
      ...(this.#config.defaults.requiredDocuments.length > 0
        ? { requiredDocuments: [...this.#config.defaults.requiredDocuments] }
        : {}),
      ...(input.data ? structuredClone(input.data) : {}),
    };

    const claim: Claim = cloneAndFreeze({
      id,
      state: this.#config.initialState,
      version: 1,
      workflowVersion: this.#config.version,
      createdAt: nowIso,
      updatedAt: nowIso,
      stateEnteredAt: nowIso,
      data: initialData,
    });

    const actor: Actor = input.actor ?? { userId: "system", role: "system" };
    const delta = computeDataDelta({}, initialData);

    this.#auditSequence += 1;
    this.#auditStore.append({
      id: `AUD-${String(this.#auditSequence).padStart(4, "0")}`,
      claimId: id,
      timestamp: nowIso,
      fromState: null,
      toState: this.#config.initialState,
      triggeredBy: actor,
      notes: input.notes ?? "Claim created and submitted",
      outcome: "SUCCESS",
      workflowVersion: this.#config.version,
      claimVersion: 1,
      delta,
      sideEffects: [],
    });

    this.#claims.set(id, claim);
    return claim;
  }

  public getClaim(claimId: string): Claim | undefined {
    return this.#claims.get(claimId);
  }

  public getAllClaims(): readonly Claim[] {
    return deepFreeze(Array.from(this.#claims.values()));
  }

  public getAuditTrail(claimId: string): readonly AuditEntry[] {
    return this.#auditStore.getByClaimId(claimId);
  }

  public replayClaim(claimId: string): ReplayedClaimTrajectory {
    return replayClaimHistory(claimId, this.#auditStore.getByClaimId(claimId));
  }

  public getOutboxEvents(claimId?: string): readonly OutboxEvent[] {
    if (claimId !== undefined) {
      return this.#outboxStore.getByClaimId(claimId);
    }
    return this.#outboxStore.getAll();
  }

  public getFailedOutboxEvents(): readonly OutboxEvent[] {
    return this.#outboxStore.getFailedEvents();
  }

  /**
   * Returns all valid outgoing transitions from a claim's current state, including
   * required roles, live precondition check statuses, and cycle counter status.
   */
  public getAvailableTransitions(
    claimId: string,
    previewInput: Readonly<Record<string, unknown>> = {}
  ): readonly AvailableTransition[] {
    const claim = this.#claims.get(claimId);
    if (!claim) {
      throw new Error(`Claim '${claimId}' does not exist`);
    }

    const currentStateDef = this.#config.states[claim.state];
    if (currentStateDef?.terminal) {
      return deepFreeze([]);
    }

    const outgoing = this.#config.transitions.filter((t) => t.from === claim.state);
    const effective = buildEffectiveData(claim.data, previewInput);
    const ctx: RuleEvaluationContext = {
      claim,
      input: previewInput,
      effective,
      now: this.#clock.now(),
    };
    const claimAudit = this.#auditStore.getByClaimId(claim.id);

    const available: AvailableTransition[] = outgoing.map((transition) => {
      const preconditions = evaluatePreconditions(transition.preconditions, ctx);
      const cycleStatus = evaluateCyclePolicy(
        this.#config.cyclePolicies,
        transition.from,
        transition.to,
        claimAudit
      );
      const allPreconditionsMet =
        preconditions.every((p) => p.passed) && !(cycleStatus?.exceeded ?? false);

      return {
        from: transition.from,
        to: transition.to,
        roles: [...transition.roles],
        preconditions,
        allPreconditionsMet,
        ...(cycleStatus !== undefined ? { cycleStatus } : {}),
      };
    });

    return cloneAndFreeze(available);
  }

  /**
   * Executes an atomic, validated state transition on a claim.
   */
  public transition(request: TransitionRequest): TransitionResult {
    // 0. Idempotency check
    const idempotencyCacheKey =
      request.idempotencyKey !== undefined
        ? `${request.claimId}::${request.idempotencyKey}`
        : undefined;

    if (idempotencyCacheKey !== undefined) {
      const cached = this.#idempotencyCache.get(idempotencyCacheKey);
      if (cached !== undefined) {
        return cloneAndFreeze({
          ...cached,
          idempotentReplay: true,
        });
      }
    }

    // 1. Claim existence check
    const claim = this.#claims.get(request.claimId);
    if (!claim) {
      return cloneAndFreeze({
        ok: false,
        idempotentReplay: false,
        error: createWorkflowError({
          code: "CLAIM_NOT_FOUND",
          message: `Claim '${request.claimId}' does not exist`,
          claimId: request.claimId,
          toState: request.toState,
        }),
      });
    }

    // 2. Optimistic concurrency check
    if (request.expectedVersion !== undefined && request.expectedVersion !== claim.version) {
      return this.#recordFailure({
        claim,
        request,
        code: "CONCURRENCY_CONFLICT",
        message: `Concurrency conflict on claim '${claim.id}': expected version ${request.expectedVersion}, but current version is ${claim.version}`,
        idempotencyCacheKey,
      });
    }

    // 3. Terminal state check
    const currentStateDef = this.#config.states[claim.state];
    if (currentStateDef?.terminal) {
      return this.#recordFailure({
        claim,
        request,
        code: "TERMINAL_STATE",
        message: `Cannot transition claim '${claim.id}' from '${claim.state}' to '${request.toState}': state '${claim.state}' is terminal and allows no further transitions`,
        idempotencyCacheKey,
      });
    }

    // 4. Valid transition edge check
    const outgoingTransitions = this.#config.transitions.filter((t) => t.from === claim.state);
    const transitionDef: TransitionDefinition | undefined = outgoingTransitions.find(
      (t) => t.to === request.toState
    );

    if (!transitionDef) {
      const allowedSummary = outgoingTransitions
        .map((t) => `${t.to} (role: ${t.roles.join("/")})`)
        .join(", ");
      const unknownStateHint =
        this.#config.states[request.toState] === undefined
          ? ` ('${request.toState}' is not a defined workflow state)`
          : "";

      return this.#recordFailure({
        claim,
        request,
        code: "INVALID_TRANSITION",
        message: `Transition '${claim.state} -> ${request.toState}' is not allowed for claim '${claim.id}'${unknownStateHint}. Allowed transitions from '${claim.state}': ${allowedSummary || "none"}`,
        allowedTransitions: outgoingTransitions.map((t) => ({
          to: t.to,
          roles: [...t.roles],
        })),
        idempotencyCacheKey,
      });
    }

    // 5. Role & assigned-assessor authorization check
    const isRoleDeclared = this.#config.roles.includes(request.actor.role);
    const isRoleAllowed = isRoleDeclared && transitionDef.roles.includes(request.actor.role);
    if (!isRoleAllowed) {
      return this.#recordFailure({
        claim,
        request,
        code: "UNAUTHORIZED_ROLE",
        message: `Role '${request.actor.role}' (user '${request.actor.userId}') is not authorized to perform '${claim.state} -> ${request.toState}' on claim '${claim.id}'. Required role(s): ${transitionDef.roles.join(", ")}`,
        requiredRoles: [...transitionDef.roles],
        idempotencyCacheKey,
      });
    }

    if (
      this.#enforceAssignedAssessor &&
      request.actor.role === "assessor" &&
      typeof claim.data.assessorId === "string" &&
      claim.data.assessorId.trim().length > 0 &&
      request.actor.userId !== claim.data.assessorId
    ) {
      return this.#recordFailure({
        claim,
        request,
        code: "UNAUTHORIZED_ROLE",
        message: `Assessor '${request.actor.userId}' is not authorized for claim '${claim.id}': claim is assigned to assessor '${claim.data.assessorId}'`,
        requiredRoles: [...transitionDef.roles],
        idempotencyCacheKey,
      });
    }

    // 6. Cycle limit check (derived from AuditStore)
    const claimAuditHistory = this.#auditStore.getByClaimId(claim.id);
    const cycleStatus = evaluateCyclePolicy(
      this.#config.cyclePolicies,
      claim.state,
      request.toState,
      claimAuditHistory
    );

    if (cycleStatus?.exceeded) {
      return this.#recordFailure({
        claim,
        request,
        code: "CYCLE_LIMIT_EXCEEDED",
        message: cycleStatus.errorMessage,
        idempotencyCacheKey,
      });
    }

    // 7. Precondition evaluation
    const now = this.#clock.now();
    const nowIso = now.toISOString();
    const inputPayload = request.input ?? {};
    const effective = buildEffectiveData(claim.data, inputPayload);
    const evalContext: RuleEvaluationContext = {
      claim,
      input: inputPayload,
      effective,
      now,
    };

    const preconditionResults = evaluatePreconditions(transitionDef.preconditions, evalContext);
    const failedPreconditions = preconditionResults
      .filter((r) => !r.passed)
      .map((r) => r.failureReason ?? r.description);

    if (failedPreconditions.length > 0) {
      return this.#recordFailure({
        claim,
        request,
        code: "PRECONDITION_FAILED",
        message: `Precondition check failed for '${claim.state} -> ${request.toState}' on claim '${claim.id}': ${failedPreconditions.join(" | ")}`,
        failedPreconditions,
        idempotencyCacheKey,
      });
    }

    // 8. Atomic state mutation, audit logging, and outbox dispatch
    const { nextData, plans } = applySideEffectMutations(
      transitionDef.sideEffects,
      evalContext,
      () => {
        this.#sideEffectSequence += 1;
        return this.#sideEffectSequence;
      }
    );

    const delta = computeDataDelta(claim.data, nextData);
    const nextVersion = claim.version + 1;
    const updatedClaim: Claim = cloneAndFreeze({
      ...claim,
      state: request.toState,
      version: nextVersion,
      updatedAt: nowIso,
      stateEnteredAt: nowIso,
      data: nextData,
    });

    this.#auditSequence += 1;
    const auditEntryId = `AUD-${String(this.#auditSequence).padStart(4, "0")}`;

    const { executedSideEffects, outboxEvents } = enqueueAndDispatchSideEffects(
      claim.id,
      auditEntryId,
      nowIso,
      plans,
      this.#outboxStore
    );

    const auditEntry = this.#auditStore.append({
      id: auditEntryId,
      claimId: claim.id,
      timestamp: nowIso,
      fromState: claim.state,
      toState: request.toState,
      triggeredBy: request.actor,
      notes: request.notes ?? `Transitioned ${claim.state} -> ${request.toState}`,
      outcome: "SUCCESS",
      workflowVersion: this.#config.version,
      claimVersion: nextVersion,
      delta,
      sideEffects: executedSideEffects,
    });

    this.#claims.set(claim.id, updatedClaim);

    const successResult: TransitionSuccess = cloneAndFreeze({
      ok: true,
      idempotentReplay: false,
      claim: updatedClaim,
      auditEntry,
      sideEffects: executedSideEffects,
      outboxEvents,
    });

    if (idempotencyCacheKey !== undefined) {
      this.#idempotencyCache.set(idempotencyCacheKey, successResult);
    }

    return successResult;
  }

  #recordFailure(params: {
    readonly claim: Claim;
    readonly request: TransitionRequest;
    readonly code: WorkflowErrorCode;
    readonly message: string;
    readonly failedPreconditions?: readonly string[];
    readonly allowedTransitions?: readonly {
      readonly to: string;
      readonly roles: readonly string[];
    }[];
    readonly requiredRoles?: readonly string[];
    readonly idempotencyCacheKey?: string | undefined;
  }): TransitionFailure {
    const nowIso = this.#clock.now().toISOString();
    this.#auditSequence += 1;
    const auditEntry = this.#auditStore.append({
      id: `AUD-${String(this.#auditSequence).padStart(4, "0")}`,
      claimId: params.claim.id,
      timestamp: nowIso,
      fromState: params.claim.state,
      toState: params.request.toState,
      triggeredBy: params.request.actor,
      notes: params.request.notes ?? params.message,
      outcome: "DENIED",
      errorCode: params.code,
      workflowVersion: this.#config.version,
      claimVersion: params.claim.version,
      delta: {},
      sideEffects: [],
    });

    const error = createWorkflowError({
      code: params.code,
      message: params.message,
      claimId: params.claim.id,
      fromState: params.claim.state,
      toState: params.request.toState,
      ...(params.failedPreconditions !== undefined
        ? { failedPreconditions: params.failedPreconditions }
        : {}),
      ...(params.allowedTransitions !== undefined
        ? { allowedTransitions: params.allowedTransitions }
        : {}),
      ...(params.requiredRoles !== undefined ? { requiredRoles: params.requiredRoles } : {}),
    });

    const failureResult: TransitionFailure = cloneAndFreeze({
      ok: false,
      idempotentReplay: false,
      error,
      claim: params.claim,
      auditEntry,
    });

    if (params.idempotencyCacheKey !== undefined) {
      this.#idempotencyCache.set(params.idempotencyCacheKey, failureResult);
    }

    return failureResult;
  }
}

