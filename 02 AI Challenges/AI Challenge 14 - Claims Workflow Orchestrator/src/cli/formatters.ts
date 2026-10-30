import type { AuditReportView, ClaimDetailView } from "../app/types.js";
import type { Claim, OutboxEvent, TransitionResult } from "../domain/types.js";
import type { WorkflowConfig } from "../engine/types.js";

export function formatWorkflow(cfg: WorkflowConfig): string {
  const lines = [
    `Workflow : ${cfg.name} (v${cfg.version})`,
    `Initial  : ${cfg.initialState}`,
    `Roles    : ${cfg.roles.join(", ")}`,
    "",
    "States:",
    ...Object.entries(cfg.states).map(
      ([name, def]) => `  - ${name}${def.terminal ? " [TERMINAL]" : ""}: ${def.description}`
    ),
    "",
    "Transitions:",
    ...cfg.transitions.map(
      (t) => `  - ${t.from} -> ${t.to}  (authorized roles: ${t.roles.join(", ")})`
    ),
  ];

  if (cfg.cyclePolicies.length > 0) {
    lines.push(
      "",
      "Cycle Policies:",
      ...cfg.cyclePolicies.flatMap((c) => [
        `  - ${c.id}: ${c.path.join(" -> ")} (maxCycles: ${c.maxCycles})`,
        `    Rejection message: "${c.errorMessage}"`,
      ])
    );
  }
  return lines.join("\n");
}

export function formatClaimsList(claims: readonly Claim[]): string {
  if (claims.length === 0) {
    return "No claims in session yet. Run 'create' or 'seed' to start.";
  }
  return [
    "Claims in Session:",
    ...claims.map((c) => {
      const assessor = c.data.assessorId ? `, assessor=${String(c.data.assessorId)}` : "";
      return `  - ${c.id.padEnd(12)} | state: ${c.state.padEnd(19)} | v${c.version} | amount: ${String(c.data.amount ?? "N/A")} / limit: ${String(c.data.policyLimit ?? "N/A")}${assessor}`;
    }),
  ].join("\n");
}

export function formatClaimView(view: ClaimDetailView, cfg: WorkflowConfig): string {
  const { claim, availableTransitions } = view;
  const stateDef = cfg.states[claim.state];
  const lines = [
    `Claim ID         : ${claim.id}`,
    `Current State    : ${claim.state}${stateDef?.terminal ? " [TERMINAL]" : ""} — ${stateDef?.description ?? ""}`,
    `Version          : v${claim.version} (workflow v${claim.workflowVersion})`,
    `State Entered At : ${claim.stateEnteredAt}`,
    `Claim Data       : ${JSON.stringify(claim.data)}`,
    "",
  ];

  if (availableTransitions.length === 0) {
    lines.push("Available Transitions: none (claim is in a terminal state)");
    return lines.join("\n");
  }

  lines.push("Available Transitions from Current State:");
  for (const t of availableTransitions) {
    const readyTag = t.allPreconditionsMet ? "[READY]" : "[REQUIRES INPUT / UNMET GUARD]";
    const cycleInfo = t.cycleStatus
      ? ` | cycle usage: ${t.cycleStatus.currentCount}/${t.cycleStatus.maxCycles}${t.cycleStatus.exceeded ? " (LIMIT REACHED)" : ""}`
      : "";
    lines.push(`  -> ${t.to.padEnd(20)} | required role(s): ${t.roles.join(", ")} | ${readyTag}${cycleInfo}`);
    for (const pre of t.preconditions) {
      const detail = !pre.passed && pre.failureReason ? ` (${pre.failureReason})` : "";
      lines.push(`       [${pre.passed ? "PASS" : "UNMET"}] ${pre.description}${detail}`);
    }
  }
  return lines.join("\n");
}

export function formatTransitionResult(result: TransitionResult): string {
  if (!result.ok) {
    return [
      `[REJECTED — ${result.error.code}] ${result.error.message}`,
      `  Current State remains: ${result.claim?.state ?? "N/A"}`,
    ].join("\n");
  }
  return [
    `[OK] ${result.auditEntry.from_state} -> ${result.claim.state} (v${result.claim.version})${result.idempotentReplay ? " [IDEMPOTENT REPLAY]" : ""}`,
    `  Triggered By : ${result.auditEntry.triggered_by.userId} (${result.auditEntry.triggered_by.role})`,
    ...result.sideEffects.map(
      (fx) => `  [side-effect:${fx.type}${fx.target ? ` -> ${fx.target}` : ""}] ${fx.description}`
    ),
  ].join("\n");
}

export function formatAuditReport(report: AuditReportView): string {
  const { claimId, entries, replay } = report;
  const lines = [`Immutable Audit Trail for ${claimId} (${entries.length} entries):`];
  for (const e of entries) {
    const errSuffix = e.errorCode ? ` [${e.errorCode}]` : "";
    lines.push(
      `  ${e.id} | ${e.timestamp} | ${String(e.from_state ?? "NULL").padEnd(18)} -> ${e.to_state.padEnd(18)} | ${e.triggered_by.userId} (${e.triggered_by.role}) | ${e.outcome}${errSuffix}`,
      `           reason: ${e.reason}`
    );
    if (Object.keys(e.delta).length > 0) {
      lines.push(`           delta : ${JSON.stringify(e.delta)}`);
    }
  }
  lines.push(
    "",
    `Replay Check: state=${replay.currentState}, v${replay.version}, deniedAttempts=${replay.deniedAttempts}, trajectory=[${replay.stateHistory.join(" -> ")}]`
  );
  return lines.join("\n");
}

export function formatOutboxEvents(events: readonly OutboxEvent[], claimId?: string): string {
  if (events.length === 0) {
    return claimId ? `No outbox events for claim '${claimId}'.` : "No outbox events recorded yet.";
  }
  return [
    `Transactional Outbox Events (${events.length}):`,
    ...events.map(
      (e) => `  ${e.id} | ${e.claimId} | [${e.status}] ${e.type}${e.target ? ` -> ${e.target}` : ""}: ${e.message}`
    ),
  ].join("\n");
}

