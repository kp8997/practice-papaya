import { createWorkflowError, type WorkflowErrorCode } from "../domain/errors.js";
import { cloneAndFreeze, deepFreeze } from "../domain/freeze.js";
import {
  ClaimValidationError,
  isPlainObject,
  validateActorInput,
  validateClaimDataPayload,
  validateClaimId,
  validateExpectedVersionInput,
  validateIdempotencyKeyInput,
  validateNotesInput,
} from "../domain/validation.js";
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
import { AuditStore, computeDataDelta, replayClaimHistory } from "./audit-store.js";
import { evaluateCyclePolicy } from "./cycle-detector.js";
import { OutboxStore } from "./outbox-store.js";
import { evaluatePreconditions } from "./rule-evaluator.js";
import { applySideEffectMutations, enqueueAndDispatchSideEffects } from "./side-effects.js";
import type {
  ReplayedClaimTrajectory,
  RuleEvaluationContext,
  TransitionDefinition,
  WorkflowConfig,
  WorkflowOrchestratorOptions,
} from "./types.js";

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
    const rawInput: unknown = input;
    if (!isPlainObject(rawInput)) {
      throw new ClaimValidationError("'input' must be a plain object", "INVALID_CLAIM_DATA");
    }

    const issues: string[] = [];
    if (input.id !== undefined) {
      const idErr = validateClaimId(input.id, "id");
      if (idErr) issues.push(idErr);
    }

    const actorCandidate: unknown = input.actor ?? { userId: "system", role: "system" };
    issues.push(...validateActorInput(actorCandidate));

    const notesErr = validateNotesInput(input.notes);
    if (notesErr) issues.push(notesErr);

    const rawData: unknown = input.data;
    if (rawData !== undefined && !isPlainObject(rawData)) {
      issues.push("'data' must be a plain object");
    }

    const initialData: Record<string, unknown> = {
      ...(this.#config.defaults.requiredDocuments.length > 0
        ? { requiredDocuments: [...this.#config.defaults.requiredDocuments] }
        : {}),
      ...(isPlainObject(rawData) ? structuredClone(rawData) : {}),
    };
    issues.push(...validateClaimDataPayload(initialData, "data"));

    if (issues.length > 0) {
      throw new ClaimValidationError(issues, "INVALID_CLAIM_DATA");
    }

    const actor = actorCandidate as Actor;

    if (input.id !== undefined && this.#claims.has(input.id)) {
      throw new ClaimValidationError(`Claim '${input.id}' already exists`, "DUPLICATE_CLAIM");
    }

    let id = input.id;
    if (id === undefined) {
      do {
        this.#claimSequence += 1;
        id = `C-${this.#claimSequence}`;
      } while (this.#claims.has(id));
    }

    const nowIso = this.#clock.now().toISOString();
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

    const sanitizedActor: Actor = {
      userId: actor.userId.trim(),
      role: actor.role.trim(),
    };
    const delta = computeDataDelta({}, initialData);

    this.#auditSequence += 1;
    this.#auditStore.append({
      id: `AUD-${String(this.#auditSequence).padStart(4, "0")}`,
      claimId: id,
      timestamp: nowIso,
      fromState: null,
      toState: this.#config.initialState,
      triggeredBy: sanitizedActor,
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
    if (!isPlainObject(request) || typeof request.claimId !== "string" || request.claimId.trim().length === 0) {
      return cloneAndFreeze({
        ok: false,
        idempotentReplay: false,
        error: createWorkflowError({
          code: "INVALID_CLAIM_DATA",
          message: "'claimId' must be a non-empty string",
          claimId: String(request?.claimId ?? ""),
          toState: String(request?.toState ?? ""),
        }),
      });
    }

    const validIdempotencyKey =
      request.idempotencyKey !== undefined && validateIdempotencyKeyInput(request.idempotencyKey) === null
        ? request.idempotencyKey.trim()
        : undefined;
    const idempotencyCacheKey =
      validIdempotencyKey !== undefined ? `${request.claimId}::${validIdempotencyKey}` : undefined;

    if (idempotencyCacheKey !== undefined) {
      const cached = this.#idempotencyCache.get(idempotencyCacheKey);
      if (cached !== undefined) {
        return cloneAndFreeze({ ...cached, idempotentReplay: true });
      }
    }

    const claim = this.#claims.get(request.claimId);
    if (!claim) {
      return cloneAndFreeze({
        ok: false,
        idempotentReplay: false,
        error: createWorkflowError({
          code: "CLAIM_NOT_FOUND",
          message: `Claim '${request.claimId}' does not exist`,
          claimId: request.claimId,
          toState: String(request.toState ?? ""),
        }),
      });
    }

    const inputFailure = this.#validateTransitionRequest(claim, request, idempotencyCacheKey);
    if (inputFailure) return inputFailure;

    const concurrencyFailure = this.#checkConcurrency(claim, request, idempotencyCacheKey);
    if (concurrencyFailure) return concurrencyFailure;

    const terminalFailure = this.#checkTerminalState(claim, request, idempotencyCacheKey);
    if (terminalFailure) return terminalFailure;

    const { transitionDef, failure: transitionFailure } = this.#lookupTransition(
      claim,
      request,
      idempotencyCacheKey
    );
    if (transitionFailure || !transitionDef) return transitionFailure!;

    const authFailure = this.#authorizeRole(claim, request, transitionDef, idempotencyCacheKey);
    if (authFailure) return authFailure;

    const cycleFailure = this.#checkCycleLimit(claim, request, idempotencyCacheKey);
    if (cycleFailure) return cycleFailure;

    const evalContext = this.#buildEvaluationContext(claim, request);
    const preconditionFailure = this.#checkPreconditions(
      claim,
      request,
      transitionDef,
      evalContext,
      idempotencyCacheKey
    );
    if (preconditionFailure) return preconditionFailure;

    return this.#commitTransition(claim, request, transitionDef, evalContext, idempotencyCacheKey);
  }

  #validateTransitionRequest(
    claim: Claim,
    request: TransitionRequest,
    idempotencyCacheKey?: string
  ): TransitionFailure | null {
    const issues: string[] = [];

    if (typeof request.toState !== "string" || request.toState.trim().length === 0) {
      issues.push("'toState' must be a non-empty state name string");
    }

    issues.push(...validateActorInput(request.actor));

    const notesErr = validateNotesInput(request.notes);
    if (notesErr) issues.push(notesErr);

    const versionErr = validateExpectedVersionInput(request.expectedVersion);
    if (versionErr) issues.push(versionErr);

    const idemErr = validateIdempotencyKeyInput(request.idempotencyKey);
    if (idemErr) issues.push(idemErr);

    if (request.input !== undefined) {
      issues.push(...validateClaimDataPayload(request.input, "input"));
    }

    if (issues.length > 0) {
      return this.#recordFailure({
        claim,
        request,
        code: "INVALID_CLAIM_DATA",
        message: `Invalid transition input on claim '${claim.id}': ${issues.join("; ")}`,
        idempotencyCacheKey,
      });
    }
    return null;
  }

  #checkConcurrency(
    claim: Claim,
    request: TransitionRequest,
    idempotencyCacheKey?: string
  ): TransitionFailure | null {
    if (request.expectedVersion !== undefined && request.expectedVersion !== claim.version) {
      return this.#recordFailure({
        claim,
        request,
        code: "CONCURRENCY_CONFLICT",
        message: `Concurrency conflict on claim '${claim.id}': expected version ${request.expectedVersion}, but current version is ${claim.version}`,
        idempotencyCacheKey,
      });
    }
    return null;
  }

  #checkTerminalState(
    claim: Claim,
    request: TransitionRequest,
    idempotencyCacheKey?: string
  ): TransitionFailure | null {
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
    return null;
  }

  #lookupTransition(
    claim: Claim,
    request: TransitionRequest,
    idempotencyCacheKey?: string
  ): { transitionDef?: TransitionDefinition; failure?: TransitionFailure } {
    const outgoingTransitions = this.#config.transitions.filter((t) => t.from === claim.state);
    const transitionDef = outgoingTransitions.find((t) => t.to === request.toState);

    if (!transitionDef) {
      const allowedSummary = outgoingTransitions
        .map((t) => `${t.to} (role: ${t.roles.join("/")})`)
        .join(", ");
      const unknownStateHint =
        this.#config.states[request.toState] === undefined
          ? ` ('${request.toState}' is not a defined workflow state)`
          : "";

      return {
        failure: this.#recordFailure({
          claim,
          request,
          code: "INVALID_TRANSITION",
          message: `Transition '${claim.state} -> ${request.toState}' is not allowed for claim '${claim.id}'${unknownStateHint}. Allowed transitions from '${claim.state}': ${allowedSummary || "none"}`,
          allowedTransitions: outgoingTransitions.map((t) => ({
            to: t.to,
            roles: [...t.roles],
          })),
          idempotencyCacheKey,
        }),
      };
    }
    return { transitionDef };
  }

  #authorizeRole(
    claim: Claim,
    request: TransitionRequest,
    transitionDef: TransitionDefinition,
    idempotencyCacheKey?: string
  ): TransitionFailure | null {
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
    return null;
  }

  #checkCycleLimit(
    claim: Claim,
    request: TransitionRequest,
    idempotencyCacheKey?: string
  ): TransitionFailure | null {
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
    return null;
  }

  #buildEvaluationContext(claim: Claim, request: TransitionRequest): RuleEvaluationContext {
    const now = this.#clock.now();
    const inputPayload = request.input ?? {};
    const effective = buildEffectiveData(claim.data, inputPayload);
    return {
      claim,
      input: inputPayload,
      effective,
      now,
    };
  }

  #checkPreconditions(
    claim: Claim,
    request: TransitionRequest,
    transitionDef: TransitionDefinition,
    evalContext: RuleEvaluationContext,
    idempotencyCacheKey?: string
  ): TransitionFailure | null {
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
    return null;
  }

  #commitTransition(
    claim: Claim,
    request: TransitionRequest,
    transitionDef: TransitionDefinition,
    evalContext: RuleEvaluationContext,
    idempotencyCacheKey?: string
  ): TransitionSuccess {
    const nowIso = evalContext.now.toISOString();
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
    const safeActor: Actor = {
      userId:
        typeof params.request.actor?.userId === "string" && params.request.actor.userId.trim().length > 0
          ? params.request.actor.userId.trim()
          : "unknown",
      role:
        typeof params.request.actor?.role === "string" && params.request.actor.role.trim().length > 0
          ? params.request.actor.role.trim()
          : "unknown",
    };
    const safeToState =
      typeof params.request.toState === "string" ? params.request.toState : String(params.request.toState ?? "");
    const safeNotes =
      typeof params.request.notes === "string" ? params.request.notes : params.message;

    this.#auditSequence += 1;
    const auditEntry = this.#auditStore.append({
      id: `AUD-${String(this.#auditSequence).padStart(4, "0")}`,
      claimId: params.claim.id,
      timestamp: nowIso,
      fromState: params.claim.state,
      toState: safeToState,
      triggeredBy: safeActor,
      notes: safeNotes,
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
      toState: safeToState,
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
