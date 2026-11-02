import type { AuditReportView, ClaimDetailView } from "../app/types.js";
import type { Claim, OutboxEvent, TransitionResult } from "../domain/types.js";
import type { WorkflowConfig } from "../engine/types.js";
import {
  formatDataBlock,
  formatDeltaBlock,
  formatOutcomeBadge,
  formatStateBadge,
  paint,
  wordWrap,
} from "./theme.js";
import type { FormatterOptions } from "./types.js";

export interface FormatAuditOptions extends FormatterOptions {
  readonly outcome?: "success" | "denied" | undefined;
  readonly limit?: number | undefined;
}

export function formatWorkflow(cfg: WorkflowConfig, options: FormatterOptions = {}): string {
  const color = options.color ?? false;
  const lines = [
    `${paint("Workflow :", "dim", color)} ${paint(cfg.name, "bold", color)} (v${cfg.version})`,
    `${paint("Initial  :", "dim", color)} ${formatStateBadge(cfg.initialState, color)}`,
    `${paint("Roles    :", "dim", color)} ${cfg.roles.join(", ")}`,
    "",
    paint("States:", "bold", color),
    ...Object.entries(cfg.states).map(([name, def]) => {
      const termTag = def.terminal ? paint(" [TERMINAL]", ["bold", "red"], color) : "";
      return `  - ${formatStateBadge(name, color)}${termTag}: ${def.description}`;
    }),
    "",
    paint("Transitions:", "bold", color),
    ...cfg.transitions.map((t) => {
      const from = formatStateBadge(t.from, color);
      const to = formatStateBadge(t.to, color);
      const roles = paint(t.roles.join(", "), "cyan", color);
      return `  - ${from} -> ${to}  (authorized roles: ${roles})`;
    }),
  ];

  if (cfg.cyclePolicies.length > 0) {
    lines.push(
      "",
      paint("Cycle Policies:", "bold", color),
      ...cfg.cyclePolicies.flatMap((c) => [
        `  - ${paint(c.id, "bold", color)}: ${c.path.map((s) => formatStateBadge(s, color)).join(" -> ")} (maxCycles: ${paint(String(c.maxCycles), "yellow", color)})`,
        `    Rejection message: "${paint(c.errorMessage, "dim", color)}"`,
      ])
    );
  }
  return lines.join("\n");
}

export function formatClaimsList(claims: readonly Claim[], options: FormatterOptions = {}): string {
  const color = options.color ?? false;
  if (claims.length === 0) {
    return "No claims in session yet. Run 'create' or 'seed' to start.";
  }
  return [
    paint("Claims in Session:", "bold", color),
    ...claims.map((c) => {
      const stateBadge = formatStateBadge(c.state.padEnd(19), color);
      const assessor = c.data.assessorId ? `, assessor=${String(c.data.assessorId)}` : "";
      return `  - ${c.id.padEnd(12)} | state: ${stateBadge} | v${c.version} | amount: ${String(c.data.amount ?? "N/A")} / limit: ${String(c.data.policyLimit ?? "N/A")}${assessor}`;
    }),
  ].join("\n");
}

export function formatClaimView(
  view: ClaimDetailView,
  cfg: WorkflowConfig,
  options: FormatterOptions = {}
): string {
  const color = options.color ?? false;
  const { claim, availableTransitions } = view;
  const stateDef = cfg.states[claim.state];
  const terminalTag = stateDef?.terminal ? paint(" [TERMINAL]", ["bold", "red"], color) : "";
  const lines = [
    `Claim ID         : ${paint(claim.id, "bold", color)}`,
    `Current State    : ${claim.state}${terminalTag} — ${stateDef?.description ?? ""}`,
    `Version          : v${claim.version} (workflow v${claim.workflowVersion})`,
    `State Entered At : ${claim.stateEnteredAt}`,
    `Claim Data       :`,
    ...formatDataBlock(claim.data, "  ", color),
    "",
  ];

  if (availableTransitions.length === 0) {
    lines.push(paint("Available Transitions: none (claim is in a terminal state)", "dim", color));
    return lines.join("\n");
  }

  lines.push("Available Transitions from Current State:");
  for (const t of availableTransitions) {
    const readyTag = t.allPreconditionsMet
      ? paint("[READY]", ["bold", "green"], color)
      : paint("[REQUIRES INPUT / UNMET GUARD]", "yellow", color);
    const cycleInfo = t.cycleStatus
      ? ` | cycle usage: ${t.cycleStatus.currentCount}/${t.cycleStatus.maxCycles}${t.cycleStatus.exceeded ? paint(" (LIMIT REACHED)", ["bold", "red"], color) : ""}`
      : "";
    const targetBadge = formatStateBadge(t.to.padEnd(20), color);
    const rolesStr = paint(t.roles.join(", "), "cyan", color);
    lines.push(`  -> ${targetBadge} | required role(s): ${rolesStr} | ${readyTag}${cycleInfo}`);
    for (const pre of t.preconditions) {
      const tag = pre.passed
        ? paint("[PASS]", ["bold", "green"], color)
        : paint("[UNMET]", ["bold", "red"], color);
      const detail = !pre.passed && pre.failureReason ? ` (${pre.failureReason})` : "";
      lines.push(`       ${tag} ${pre.description}${detail}`);
    }
  }
  return lines.join("\n");
}

export function formatTransitionResult(
  result: TransitionResult,
  options: FormatterOptions = {}
): string {
  const color = options.color ?? false;
  if (!result.ok) {
    const codeTag = paint(`[REJECTED — ${result.error.code}]`, ["bold", "red"], color);
    const currState = result.claim?.state ? formatStateBadge(result.claim.state, color) : "N/A";
    return [
      `${codeTag} ${result.error.message}`,
      `  Current State remains: ${currState}`,
    ].join("\n");
  }

  const okTag = paint("[OK]", ["bold", "green"], color);
  const replayTag = result.idempotentReplay ? paint(" [IDEMPOTENT REPLAY]", ["bold", "cyan"], color) : "";
  const fromState = formatStateBadge(result.auditEntry.from_state ?? "NULL", color);
  const toState = formatStateBadge(result.claim.state, color);

  return [
    `${okTag} ${fromState} -> ${toState} (v${result.claim.version})${replayTag}`,
    `  Triggered By : ${result.auditEntry.triggered_by.userId} (${result.auditEntry.triggered_by.role})`,
    ...result.sideEffects.map((fx) => {
      const tag = paint(`[side-effect:${fx.type}${fx.target ? ` -> ${fx.target}` : ""}]`, "cyan", color);
      return `  ${tag} ${fx.description}`;
    }),
  ].join("\n");
}

export function formatAuditReport(
  report: AuditReportView,
  options: FormatAuditOptions = {}
): string {
  const color = options.color ?? false;
  const { claimId, entries, replay } = report;

  // Optional filtering by outcome
  let displayed = entries;
  if (options.outcome === "success") {
    displayed = displayed.filter((e) => e.outcome === "SUCCESS");
  } else if (options.outcome === "denied") {
    displayed = displayed.filter((e) => e.outcome === "DENIED");
  }

  // Optional limit on number of entries
  if (options.limit !== undefined && options.limit > 0 && displayed.length > options.limit) {
    displayed = displayed.slice(-options.limit);
  }

  const totalCount = entries.length;
  const successCount = entries.filter((e) => e.outcome === "SUCCESS").length;
  const deniedCount = totalCount - successCount;
  const statsTag = `[${paint(`${successCount} succeeded`, "green", color)}, ${paint(
    `${deniedCount} denied`,
    deniedCount > 0 ? "red" : "dim",
    color
  )}]`;
  const filterDesc =
    displayed.length !== totalCount
      ? ` (${totalCount} entries, showing ${displayed.length}) ${statsTag}`
      : ` (${totalCount} entries) ${statsTag}`;

  const lines = [
    `${paint("Immutable Audit Trail for", "bold", color)} ${paint(claimId, ["bold", "cyan"], color)}${filterDesc}:`,
    paint("─".repeat(78), "dim", color),
  ];

  for (const e of displayed) {
    const isSuccess = e.outcome === "SUCCESS";
    const icon = isSuccess ? paint("✔", ["bold", "green"], color) : paint("✖", ["bold", "red"], color);
    const idBadge = paint(e.id, "bold", color);
    const outcomeBadge = isSuccess
      ? paint(`[SUCCESS · v${e.claimVersion}]`, ["bold", "green"], color)
      : paint(`[DENIED${e.errorCode ? `: ${e.errorCode}` : ""}]`, ["bold", "red"], color);

    const fromState = formatStateBadge(e.from_state ?? "NULL", color);
    const toState = formatStateBadge(e.to_state, color);
    const arrow = paint("->", "dim", color);

    lines.push(`  ${icon} ${idBadge}  ${outcomeBadge}  ${fromState} ${arrow} ${toState}`);

    const treeBar = paint("│", "dim", color);
    const treeEnd = paint("└", "dim", color);
    const actorLabel = paint("Actor  :", "dim", color);
    const actorVal = `${e.triggered_by.userId} (${e.triggered_by.role})`;
    const tsVal = paint(`•  ${e.timestamp}`, "dim", color);
    lines.push(`    ${treeBar} ${actorLabel} ${actorVal}  ${tsVal}`);

    const hasDelta = Object.keys(e.delta).length > 0;
    const reasonLabel = isSuccess ? paint("Note   :", "dim", color) : paint("Error  :", "red", color);
    const wrappedReason = wordWrap(e.reason, 84, "               ");

    if (hasDelta) {
      lines.push(`    ${treeBar} ${reasonLabel} ${wrappedReason}`);
      lines.push(`    ${treeEnd} ${paint("Delta  :", "cyan", color)}`);
      lines.push(...formatDeltaBlock(e.delta, "        ", color));
    } else {
      lines.push(`    ${treeEnd} ${reasonLabel} ${wrappedReason}`);
    }
    lines.push("");
  }

  lines.push(
    paint("─".repeat(78), "dim", color),
    `Replay Check: state=${replay.currentState}, v${replay.version}, deniedAttempts=${replay.deniedAttempts}, trajectory=[${replay.stateHistory.join(" -> ")}]`
  );
  return lines.join("\n");
}

export function formatOutboxEvents(
  events: readonly OutboxEvent[],
  claimId?: string,
  options: FormatterOptions = {}
): string {
  const color = options.color ?? false;
  if (events.length === 0) {
    return claimId
      ? `No outbox events for claim '${claimId}'.`
      : "No outbox events recorded yet.";
  }
  return [
    `${paint("Transactional Outbox Events", "bold", color)} (${events.length}):`,
    ...events.map((e) => {
      const statusColor = e.status === "DISPATCHED" ? "green" : e.status === "FAILED" ? "red" : "yellow";
      const statusBadge = paint(`[${e.status}]`, ["bold", statusColor], color);
      const typeStr = paint(`${e.type}${e.target ? ` -> ${e.target}` : ""}`, "cyan", color);
      return `  ${e.id} | ${e.claimId} | ${statusBadge} ${typeStr}: ${e.message}`;
    }),
  ].join("\n");
}
