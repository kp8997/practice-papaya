import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Claim, OutboxEvent, TransitionResult } from "../domain/types.js";
import { loadWorkflowConfig } from "../engine/config-schema.js";
import { WorkflowOrchestrator } from "../engine/orchestrator.js";
import type { WorkflowConfig } from "../engine/types.js";
import type {
  AdvanceClaimSessionInput,
  AuditReportView,
  ClaimDetailView,
  ClockAdvanceInput,
  ClockSnapshot,
  CreateClaimSessionInput,
  SeedClaimsResult,
  SessionOptions,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = resolve(__dirname, "../../config/claims-workflow.yaml");
const DEFAULT_CLOCK_ISO = "2026-10-30T09:00:00.000Z";

/**
 * Resolves an optional `--config <path>` flag from CLI arguments.
 */
export function resolveConfigPathFromArgv(
  argv: readonly string[] = process.argv,
  defaultPath = DEFAULT_CONFIG_PATH
): string {
  const idx = argv.indexOf("--config");
  return idx >= 0 && argv[idx + 1] ? resolve(process.cwd(), argv[idx + 1]!) : defaultPath;
}

/**
 * Shared application facade managing the WorkflowOrchestrator, simulated clock,
 * claim creation defaults, and demo seeds for both the CLI and Web adapters.
 */
export class ClaimsSession {
  readonly #configPath: string;
  #clockMs: number;
  #orchestrator: WorkflowOrchestrator;

  constructor(options: SessionOptions = {}) {
    this.#configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
    this.#clockMs = Date.parse(options.initialClockIso ?? DEFAULT_CLOCK_ISO);
    this.#orchestrator = this.#buildOrchestrator();
  }

  #buildOrchestrator(): WorkflowOrchestrator {
    const config = loadWorkflowConfig(this.#configPath);
    return new WorkflowOrchestrator(config, {
      clock: { now: () => new Date(this.#clockMs) },
    });
  }

  public getConfigPath(): string {
    return this.#configPath;
  }

  public getOrchestrator(): WorkflowOrchestrator {
    return this.#orchestrator;
  }

  public getWorkflow(): WorkflowConfig {
    return this.#orchestrator.getConfig();
  }

  public getClock(): ClockSnapshot {
    return {
      iso: new Date(this.#clockMs).toISOString(),
      timestamp: this.#clockMs,
    };
  }

  public advanceClock(delta: ClockAdvanceInput): ClockSnapshot {
    const daysMs = (delta.days ?? 0) * 24 * 60 * 60 * 1000;
    const hoursMs = (delta.hours ?? 0) * 60 * 60 * 1000;
    const minutesMs = (delta.minutes ?? 0) * 60 * 1000;
    this.#clockMs += daysMs + hoursMs + minutesMs;
    return this.getClock();
  }

  public reset(): void {
    this.#orchestrator = this.#buildOrchestrator();
  }

  public listClaims(): readonly Claim[] {
    return this.#orchestrator.getAllClaims();
  }

  public getClaimView(claimId: string): ClaimDetailView | undefined {
    const claim = this.#orchestrator.getClaim(claimId);
    if (!claim) return undefined;
    return {
      claim,
      availableTransitions: this.#orchestrator.getAvailableTransitions(claimId),
    };
  }

  public createClaim(input: CreateClaimSessionInput = {}): ClaimDetailView {
    const defaultDocs = this.#orchestrator.getConfig().defaults.requiredDocuments;
    const claim = this.#orchestrator.createClaim({
      ...(input.id !== undefined ? { id: input.id } : {}),
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      data: {
        amount: input.amount ?? 5000,
        policyLimit: input.policyLimit ?? 10000,
        submittedDocuments: input.submittedDocuments
          ? [...input.submittedDocuments]
          : [...defaultDocs],
        ...(input.extraData ?? {}),
      },
    });
    return {
      claim,
      availableTransitions: this.#orchestrator.getAvailableTransitions(claim.id),
    };
  }

  public advanceClaim(params: AdvanceClaimSessionInput): TransitionResult {
    const existing = this.#orchestrator.getClaim(params.claimId);
    const defaultUser =
      params.role === "assessor" && typeof existing?.data.assessorId === "string"
        ? existing.data.assessorId
        : `u-${params.role}`;

    const result = this.#orchestrator.transition({
      claimId: params.claimId,
      toState: params.toState,
      actor: {
        userId: params.userId ?? defaultUser,
        role: params.role,
      },
      ...(params.input && Object.keys(params.input).length > 0 ? { input: params.input } : {}),
      ...(params.notes !== undefined ? { notes: params.notes } : {}),
      ...(params.expectedVersion !== undefined ? { expectedVersion: params.expectedVersion } : {}),
      ...(params.idempotencyKey !== undefined ? { idempotencyKey: params.idempotencyKey } : {}),
    });

    this.advanceClock({ minutes: 1 });
    return result;
  }

  public getAuditReport(claimId: string): AuditReportView | undefined {
    if (!this.#orchestrator.getClaim(claimId)) return undefined;
    const entries = this.#orchestrator.getAuditTrail(claimId);
    return {
      claimId,
      count: entries.length,
      entries,
      replay: this.#orchestrator.replayClaim(claimId),
    };
  }

  public getOutbox(claimId?: string): readonly OutboxEvent[] {
    return this.#orchestrator.getOutboxEvents(claimId);
  }

  public seedDemoClaims(): SeedClaimsResult {
    const seeded: string[] = [];
    const hasFraudCheck = "FRAUD_CHECK" in this.getWorkflow().states;

    const advanceToAssessment = (claimId: string) => {
      this.#orchestrator.transition({
        claimId,
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-bob", role: "document_clerk" },
      });
      if (hasFraudCheck) {
        this.#orchestrator.transition({
          claimId,
          toState: "FRAUD_CHECK",
          actor: { userId: "clerk-bob", role: "document_clerk" },
        });
        this.#orchestrator.transition({
          claimId,
          toState: "UNDER_ASSESSMENT",
          actor: { userId: "fraud-dana", role: "fraud_analyst" },
          input: { fraudRiskScore: 15, assessorId: "assessor-alice" },
        });
      } else {
        this.#orchestrator.transition({
          claimId,
          toState: "UNDER_ASSESSMENT",
          actor: { userId: "lead-sarah", role: "team_lead" },
          input: { assessorId: "assessor-alice" },
        });
      }
    };

    if (!this.#orchestrator.getClaim("C-HAPPY")) {
      this.createClaim({
        id: "C-HAPPY",
        amount: 6500,
        policyLimit: 10000,
        notes: "Sample claim in SUBMITTED state with all required documents",
      });
      seeded.push("C-HAPPY");
    }

    if (!this.#orchestrator.getClaim("C-ASSESS")) {
      this.createClaim({
        id: "C-ASSESS",
        amount: 8200,
        policyLimit: 10000,
        notes: "Sample claim in UNDER_ASSESSMENT assigned to assessor-alice",
      });
      advanceToAssessment("C-ASSESS");
      seeded.push("C-ASSESS");
    }

    if (!this.#orchestrator.getClaim("C-REJECTED")) {
      this.createClaim({
        id: "C-REJECTED",
        amount: 4000,
        policyLimit: 10000,
        notes: "Sample claim in REJECTED state awaiting appeal expiration or acknowledgement",
      });
      advanceToAssessment("C-REJECTED");
      this.#orchestrator.transition({
        claimId: "C-REJECTED",
        toState: "REJECTED",
        actor: { userId: "assessor-alice", role: "assessor" },
        input: {
          assessmentReportComplete: true,
          rejectionReason: "Non-covered cosmetic treatment",
        },
      });
      seeded.push("C-REJECTED");
    }

    return { seeded, claims: this.listClaims() };
  }
}
