import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaimsSession } from "../../src/app/claims-session.js";
import { printScenariosToConsole, renderScenariosMarkdown } from "./reporter.js";
import { SCENARIOS } from "./specs.js";
import type { ScenarioRunSummary, ScenarioSpec, ScenarioStepRecord } from "./types.js";

export { printScenariosToConsole, renderScenariosMarkdown } from "./reporter.js";
export { SCENARIOS } from "./specs.js";
export type { ScenarioRunSummary, ScenarioStepRecord, ScenarioSpec } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_PATH = resolve(__dirname, "../../docs/scenario-results.md");

export function runScenario(spec: ScenarioSpec): ScenarioRunSummary {
  const session = new ClaimsSession({ initialClockIso: "2026-10-15T08:00:00.000Z" });
  const view = session.createClaim({
    id: spec.claim.id,
    actor: spec.claim.actor,
    notes: spec.claim.notes,
    amount: spec.claim.amount,
    policyLimit: spec.claim.policyLimit,
    ...(spec.claim.submittedDocuments ? { submittedDocuments: spec.claim.submittedDocuments } : {}),
  });

  const steps: ScenarioStepRecord[] = [
    {
      stepNumber: 1,
      action: "Create Claim (-> SUBMITTED)",
      actor: `${spec.claim.actor.userId} (${spec.claim.actor.role})`,
      outcome: "SUCCESS",
      resultingState: view.claim.state,
      detail: spec.claim.createDetail,
      sideEffects: [],
    },
  ];

  for (const step of spec.steps) {
    if (step.advanceMinutes) session.advanceClock({ minutes: step.advanceMinutes });
    const currentState = session.getClaimView(spec.claim.id)?.claim.state ?? view.claim.state;
    const result = session.advanceClaim({
      claimId: spec.claim.id,
      toState: step.toState,
      role: step.actor.role,
      userId: step.actor.userId,
      ...(step.input ? { input: step.input } : {}),
      ...(step.notes ? { notes: step.notes } : {}),
    });

    const actorLabel = `${step.actor.userId} (${step.actor.role})`;
    steps.push(
      result.ok
        ? {
            stepNumber: steps.length + 1,
            action: step.action,
            actor: actorLabel,
            outcome: "SUCCESS",
            resultingState: result.claim.state,
            detail: result.auditEntry.reason,
            sideEffects: result.sideEffects.map((s) =>
              s.target ? `[${s.type} -> ${s.target}] ${s.description}` : `[${s.type}] ${s.description}`
            ),
          }
        : {
            stepNumber: steps.length + 1,
            action: step.action,
            actor: actorLabel,
            outcome: "REJECTED",
            resultingState: result.claim?.state ?? currentState,
            detail: `[${result.error.code}] ${result.error.message}`,
            sideEffects: [],
          }
    );
  }

  const finalView = session.getClaimView(spec.claim.id)!;
  const auditReport = session.getAuditReport(spec.claim.id)!;

  return {
    id: spec.id,
    title: spec.title,
    objective: spec.objective,
    claimId: spec.claim.id,
    finalState: finalView.claim.state,
    finalVersion: finalView.claim.version,
    passedExpectation: spec.verify({
      finalState: finalView.claim.state,
      finalVersion: finalView.claim.version,
      finalData: finalView.claim.data,
      steps,
    }),
    steps,
    auditTrail: auditReport.entries,
  };
}

/**
 * Executes all 7 required scenarios and returns their structured run summaries.
 */
export function executeAllScenarios(): readonly ScenarioRunSummary[] {
  return SCENARIOS.map(runScenario);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const summaries = executeAllScenarios();
  printScenariosToConsole(summaries);
  mkdirSync(dirname(DEFAULT_OUTPUT_PATH), { recursive: true });
  writeFileSync(DEFAULT_OUTPUT_PATH, renderScenariosMarkdown(summaries), "utf-8");
  console.log(`Saved full scenario report and audit trails to: ${DEFAULT_OUTPUT_PATH}`);
  if (summaries.some((s) => !s.passedExpectation)) process.exitCode = 1;
}

