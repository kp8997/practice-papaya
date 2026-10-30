import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { loadWorkflowConfig } from "../engine/config-schema.js";
import { WorkflowOrchestrator } from "../engine/orchestrator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = resolve(__dirname, "../../config/claims-workflow.yaml");

const ARRAY_KNOWN_KEYS = new Set([
  "submittedDocuments",
  "requiredDocuments",
  "newDocuments",
]);

/**
 * Splits a CLI input line into tokens while respecting single and double quotes.
 */
export function tokenizeCommand(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoteChar: '"' | "'" | null = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoteChar !== null) {
      if (ch === quoteChar) {
        quoteChar = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quoteChar = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function parseScalarOrArray(key: string, rawVal: string): unknown {
  if (ARRAY_KNOWN_KEYS.has(key)) {
    if (rawVal === "none" || rawVal.trim() === "") return [];
    return rawVal
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (rawVal === "true") return true;
  if (rawVal === "false") return false;
  if (rawVal === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(rawVal)) {
    return Number(rawVal);
  }
  return rawVal;
}

function setDotPath(target: Record<string, unknown>, dotKey: string, value: unknown): void {
  const parts = dotKey.split(".");
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const existing = cursor[part];
    if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
      const nextObj: Record<string, unknown> = {};
      cursor[part] = nextObj;
      cursor = nextObj;
    } else {
      cursor = existing as Record<string, unknown>;
    }
  }
  const leaf = parts[parts.length - 1];
  if (leaf) {
    cursor[leaf] = value;
  }
}

export interface CommandExecutionOutput {
  readonly output: string;
  readonly shouldExit: boolean;
}

export class CliSession {
  readonly #orchestrator: WorkflowOrchestrator;
  #clockMs: number;

  constructor(configPath = DEFAULT_CONFIG_PATH, initialIso = "2026-10-30T09:00:00.000Z") {
    this.#clockMs = Date.parse(initialIso);
    const config = loadWorkflowConfig(configPath);
    this.#orchestrator = new WorkflowOrchestrator(config, {
      clock: {
        now: () => new Date(this.#clockMs),
      },
    });
  }

  public getOrchestrator(): WorkflowOrchestrator {
    return this.#orchestrator;
  }

  public executeCommand(rawLine: string): CommandExecutionOutput {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      return { output: "", shouldExit: false };
    }

    const tokens = tokenizeCommand(trimmed);
    const cmd = tokens[0]?.toLowerCase() ?? "";
    const args = tokens.slice(1);

    try {
      switch (cmd) {
        case "exit":
        case "quit":
          return { output: "Exiting Claims Workflow CLI.", shouldExit: true };

        case "help":
          return { output: this.#renderHelp(), shouldExit: false };

        case "workflow":
          return { output: this.#renderWorkflow(), shouldExit: false };

        case "seed":
          return { output: this.#handleSeed(), shouldExit: false };

        case "list":
          return { output: this.#handleList(), shouldExit: false };

        case "create":
          return { output: this.#handleCreate(args), shouldExit: false };

        case "show":
        case "status":
        case "transitions":
          return { output: this.#handleShow(args), shouldExit: false };

        case "advance":
        case "transition":
          return { output: this.#handleAdvance(args), shouldExit: false };

        case "audit":
          return { output: this.#handleAudit(args), shouldExit: false };

        case "outbox":
          return { output: this.#handleOutbox(args), shouldExit: false };

        case "clock":
          return { output: this.#handleClock(args), shouldExit: false };

        default:
          return {
            output: `Unknown command '${cmd}'. Type 'help' to see available commands.`,
            shouldExit: false,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `[CLI ERROR] ${msg}`, shouldExit: false };
    }
  }

  #renderHelp(): string {
    return [
      "Available Commands:",
      "  workflow                                    Show configured states, roles, transitions & cycle rules",
      "  seed                                        Create 3 sample claims (C-HAPPY, C-ASSESS, C-REJECTED)",
      "  list                                        List all claims in the current session",
      "  create [--id ID] [--amount N] [--policy-limit N] [--docs a,b,c|none] [--notes TEXT]",
      "                                              Create a new claim in SUBMITTED state",
      "  show <claimId>                              View current state + valid transitions (with required role)",
      "  advance <claimId> <toState> --role <role> [--user <id>] [--set k=v ...] [--notes TEXT]",
      "                                              Advance a claim to a target state",
      "  audit <claimId>                             View full immutable audit trail & replay verification",
      "  outbox [claimId]                            View dispatched side-effect outbox events",
      "  clock +<days>                               Advance simulated clock by N days (for 30d appeal expiry)",
      "  help                                        Show this help guide",
      "  exit                                        Quit interactive session",
      "",
      "Quick Example:",
      "  create --id C-1 --amount 7500 --policy-limit 10000 --docs claim_form,medical_report,itemized_receipt",
      "  show C-1",
      '  advance C-1 DOCUMENTS_VERIFIED --role document_clerk --user clerk-1 --notes "Docs verified"',
      "  advance C-1 UNDER_ASSESSMENT --role team_lead --user lead-1 --set assessorId=assessor-1",
      "  advance C-1 APPROVED --role assessor --user assessor-1 --set assessmentReportComplete=true",
      "  advance C-1 PAYMENT_INITIATED --role finance --user finance-1",
      "  advance C-1 CLOSED --role finance --user finance-1 --set paymentConfirmed=true --set paymentReference=REF-99",
      "  audit C-1",
    ].join("\n");
  }

  #renderWorkflow(): string {
    const cfg = this.#orchestrator.getConfig();
    const lines: string[] = [
      `Workflow : ${cfg.name} (v${cfg.version})`,
      `Initial  : ${cfg.initialState}`,
      `Roles    : ${cfg.roles.join(", ")}`,
      "",
      "States:",
    ];

    for (const [name, def] of Object.entries(cfg.states)) {
      const tag = def.terminal ? " [TERMINAL]" : "";
      lines.push(`  - ${name}${tag}: ${def.description}`);
    }

    lines.push("");
    lines.push("Transitions:");
    for (const t of cfg.transitions) {
      lines.push(`  - ${t.from} -> ${t.to}  (authorized roles: ${t.roles.join(", ")})`);
    }

    if (cfg.cyclePolicies.length > 0) {
      lines.push("");
      lines.push("Cycle Policies:");
      for (const c of cfg.cyclePolicies) {
        lines.push(`  - ${c.id}: ${c.path.join(" -> ")} (maxCycles: ${c.maxCycles})`);
        lines.push(`    Rejection message: "${c.errorMessage}"`);
      }
    }

    return lines.join("\n");
  }

  #handleSeed(): string {
    const created: string[] = [];

    if (!this.#orchestrator.getClaim("C-HAPPY")) {
      this.#orchestrator.createClaim({
        id: "C-HAPPY",
        data: {
          amount: 6500,
          policyLimit: 10000,
          submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
        },
        notes: "Seeded claim ready at SUBMITTED",
      });
      created.push("C-HAPPY (SUBMITTED, $6,500 / $10,000 limit)");
    }

    if (!this.#orchestrator.getClaim("C-ASSESS")) {
      this.#orchestrator.createClaim({
        id: "C-ASSESS",
        data: {
          amount: 8200,
          policyLimit: 10000,
          submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
        },
      });
      this.#orchestrator.transition({
        claimId: "C-ASSESS",
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-bob", role: "document_clerk" },
      });
      this.#orchestrator.transition({
        claimId: "C-ASSESS",
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-sarah", role: "team_lead" },
        input: { assessorId: "assessor-alice" },
      });
      created.push("C-ASSESS (UNDER_ASSESSMENT, assigned to assessor-alice)");
    }

    if (!this.#orchestrator.getClaim("C-REJECTED")) {
      this.#orchestrator.createClaim({
        id: "C-REJECTED",
        data: {
          amount: 4000,
          policyLimit: 10000,
          submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
        },
      });
      this.#orchestrator.transition({
        claimId: "C-REJECTED",
        toState: "DOCUMENTS_VERIFIED",
        actor: { userId: "clerk-bob", role: "document_clerk" },
      });
      this.#orchestrator.transition({
        claimId: "C-REJECTED",
        toState: "UNDER_ASSESSMENT",
        actor: { userId: "lead-sarah", role: "team_lead" },
        input: { assessorId: "assessor-alice" },
      });
      this.#orchestrator.transition({
        claimId: "C-REJECTED",
        toState: "REJECTED",
        actor: { userId: "assessor-alice", role: "assessor" },
        input: {
          assessmentReportComplete: true,
          rejectionReason: "Non-covered cosmetic treatment",
        },
      });
      created.push("C-REJECTED (REJECTED, awaiting acknowledgement or 30d appeal expiry)");
    }

    if (created.length === 0) {
      return "Sample claims (C-HAPPY, C-ASSESS, C-REJECTED) already exist. Run 'list' to inspect.";
    }

    return [
      "Seeded sample claims:",
      ...created.map((c) => `  - ${c}`),
      "Try: show C-ASSESS",
    ].join("\n");
  }

  #handleList(): string {
    const claims = this.#orchestrator.getAllClaims();
    if (claims.length === 0) {
      return "No claims in session yet. Run 'create' or 'seed' to start.";
    }

    const lines = ["Claims in Session:"];
    for (const c of claims) {
      const amount = c.data.amount ?? "N/A";
      const limit = c.data.policyLimit ?? "N/A";
      const assessor = c.data.assessorId ? `, assessor=${String(c.data.assessorId)}` : "";
      lines.push(
        `  - ${c.id.padEnd(12)} | state: ${c.state.padEnd(19)} | v${c.version} | amount: ${String(amount)} / limit: ${String(limit)}${assessor}`
      );
    }
    return lines.join("\n");
  }

  #handleCreate(args: readonly string[]): string {
    let id: string | undefined;
    let amount = 5000;
    let policyLimit = 10000;
    let docsArg: string | undefined;
    let notes: string | undefined;
    const extraData: Record<string, unknown> = {};

    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      const next = args[i + 1];
      if ((flag === "--id" || flag === "-i") && next !== undefined) {
        id = next;
        i += 1;
      } else if (flag === "--amount" && next !== undefined) {
        amount = Number(next);
        i += 1;
      } else if ((flag === "--policy-limit" || flag === "--limit") && next !== undefined) {
        policyLimit = Number(next);
        i += 1;
      } else if (flag === "--docs" && next !== undefined) {
        docsArg = next;
        i += 1;
      } else if (flag === "--notes" && next !== undefined) {
        notes = next;
        i += 1;
      } else if (flag === "--set" && next !== undefined) {
        const eqIdx = next.indexOf("=");
        if (eqIdx > 0) {
          const k = next.slice(0, eqIdx);
          const v = next.slice(eqIdx + 1);
          setDotPath(extraData, k, parseScalarOrArray(k, v));
        }
        i += 1;
      }
    }

    const defaultDocs = this.#orchestrator.getConfig().defaults.requiredDocuments;
    const submittedDocuments =
      docsArg === undefined
        ? [...defaultDocs]
        : (parseScalarOrArray("submittedDocuments", docsArg) as string[]);

    const claim = this.#orchestrator.createClaim({
      ...(id !== undefined ? { id } : {}),
      ...(notes !== undefined ? { notes } : {}),
      data: {
        amount,
        policyLimit,
        submittedDocuments,
        ...extraData,
      },
    });

    return [
      `[OK] Created claim ${claim.id} -> ${claim.state} (v${claim.version})`,
      `     Amount: ${amount}, Policy Limit: ${policyLimit}, Docs: [${submittedDocuments.join(", ")}]`,
      `     Run 'show ${claim.id}' to inspect valid transitions and required roles.`,
    ].join("\n");
  }

  #handleShow(args: readonly string[]): string {
    const claimId = args[0];
    if (!claimId) {
      return "Usage: show <claimId>";
    }

    const claim = this.#orchestrator.getClaim(claimId);
    if (!claim) {
      return `[NOT FOUND] Claim '${claimId}' does not exist.`;
    }

    const stateDef = this.#orchestrator.getConfig().states[claim.state];
    const terminalTag = stateDef?.terminal ? " [TERMINAL]" : "";
    const available = this.#orchestrator.getAvailableTransitions(claimId);

    const lines: string[] = [
      `Claim ID         : ${claim.id}`,
      `Current State    : ${claim.state}${terminalTag} — ${stateDef?.description ?? ""}`,
      `Version          : v${claim.version} (workflow v${claim.workflowVersion})`,
      `State Entered At : ${claim.stateEnteredAt}`,
      `Claim Data       : ${JSON.stringify(claim.data)}`,
      "",
    ];

    if (available.length === 0) {
      lines.push("Available Transitions: none (claim is in a terminal state)");
      return lines.join("\n");
    }

    lines.push("Available Transitions from Current State:");
    for (const t of available) {
      const readyTag = t.allPreconditionsMet ? "[READY]" : "[REQUIRES INPUT / UNMET GUARD]";
      const cycleInfo = t.cycleStatus
        ? ` | cycle usage: ${t.cycleStatus.currentCount}/${t.cycleStatus.maxCycles}${t.cycleStatus.exceeded ? " (LIMIT REACHED)" : ""}`
        : "";
      lines.push(
        `  -> ${t.to.padEnd(20)} | required role(s): ${t.roles.join(", ")} | ${readyTag}${cycleInfo}`
      );
      for (const pre of t.preconditions) {
        const mark = pre.passed ? "PASS" : "UNMET";
        const detail = !pre.passed && pre.failureReason ? ` (${pre.failureReason})` : "";
        lines.push(`       [${mark}] ${pre.description}${detail}`);
      }
    }

    return lines.join("\n");
  }

  #handleAdvance(args: readonly string[]): string {
    const claimId = args[0];
    const toState = args[1];
    if (!claimId || !toState) {
      return "Usage: advance <claimId> <toState> --role <role> [--user <userId>] [--set key=value ...] [--notes TEXT]";
    }

    let role: string | undefined;
    let userId: string | undefined;
    let notes: string | undefined;
    let expectedVersion: number | undefined;
    let idempotencyKey: string | undefined;
    const inputPayload: Record<string, unknown> = {};

    for (let i = 2; i < args.length; i++) {
      const flag = args[i];
      const next = args[i + 1];
      if ((flag === "--role" || flag === "-r") && next !== undefined) {
        role = next;
        i += 1;
      } else if ((flag === "--user" || flag === "-u") && next !== undefined) {
        userId = next;
        i += 1;
      } else if (flag === "--notes" && next !== undefined) {
        notes = next;
        i += 1;
      } else if (flag === "--expected-version" && next !== undefined) {
        expectedVersion = Number(next);
        i += 1;
      } else if (flag === "--idempotency-key" && next !== undefined) {
        idempotencyKey = next;
        i += 1;
      } else if (flag === "--set" && next !== undefined) {
        const eqIdx = next.indexOf("=");
        if (eqIdx > 0) {
          const k = next.slice(0, eqIdx);
          const v = next.slice(eqIdx + 1);
          setDotPath(inputPayload, k, parseScalarOrArray(k, v));
        }
        i += 1;
      } else if (flag === "--json" && next !== undefined) {
        const parsed = JSON.parse(next) as Record<string, unknown>;
        Object.assign(inputPayload, parsed);
        i += 1;
      }
    }

    if (!role) {
      return "Missing required flag '--role <role>'. Run 'show <claimId>' to see which role is needed.";
    }

    const existingClaim = this.#orchestrator.getClaim(claimId);
    const defaultUser =
      role === "assessor" && typeof existingClaim?.data.assessorId === "string"
        ? existingClaim.data.assessorId
        : `u-${role}`;

    const result = this.#orchestrator.transition({
      claimId,
      toState,
      actor: {
        userId: userId ?? defaultUser,
        role,
      },
      ...(Object.keys(inputPayload).length > 0 ? { input: inputPayload } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });

    this.#clockMs += 60 * 1000;

    if (!result.ok) {
      return [
        `[REJECTED — ${result.error.code}] ${result.error.message}`,
        `  Current State remains: ${result.claim?.state ?? "N/A"}`,
      ].join("\n");
    }

    const lines: string[] = [
      `[OK] ${result.auditEntry.from_state} -> ${result.claim.state} (v${result.claim.version})${result.idempotentReplay ? " [IDEMPOTENT REPLAY]" : ""}`,
      `  Triggered By : ${result.auditEntry.triggered_by.userId} (${result.auditEntry.triggered_by.role})`,
    ];

    for (const fx of result.sideEffects) {
      const target = fx.target ? ` -> ${fx.target}` : "";
      lines.push(`  [side-effect:${fx.type}${target}] ${fx.description}`);
    }

    return lines.join("\n");
  }

  #handleAudit(args: readonly string[]): string {
    const claimId = args[0];
    if (!claimId) {
      return "Usage: audit <claimId>";
    }

    const entries = this.#orchestrator.getAuditTrail(claimId);
    if (entries.length === 0) {
      return `No audit entries found for claim '${claimId}'.`;
    }

    const lines: string[] = [`Immutable Audit Trail for ${claimId} (${entries.length} entries):`];
    for (const e of entries) {
      const errSuffix = e.errorCode ? ` [${e.errorCode}]` : "";
      lines.push(
        `  ${e.id} | ${e.timestamp} | ${String(e.from_state ?? "NULL").padEnd(18)} -> ${e.to_state.padEnd(18)} | ${e.triggered_by.userId} (${e.triggered_by.role}) | ${e.outcome}${errSuffix}`
      );
      lines.push(`           reason: ${e.reason}`);
      const deltaKeys = Object.keys(e.delta);
      if (deltaKeys.length > 0) {
        lines.push(`           delta : ${JSON.stringify(e.delta)}`);
      }
    }

    const replay = this.#orchestrator.replayClaim(claimId);
    lines.push("");
    lines.push(
      `Replay Check: state=${replay.currentState}, v${replay.version}, deniedAttempts=${replay.deniedAttempts}, trajectory=[${replay.stateHistory.join(" -> ")}]`
    );
    return lines.join("\n");
  }

  #handleOutbox(args: readonly string[]): string {
    const claimId = args[0];
    const events = this.#orchestrator.getOutboxEvents(claimId);
    if (events.length === 0) {
      return claimId
        ? `No outbox events for claim '${claimId}'.`
        : "No outbox events recorded yet.";
    }

    const lines = [
      `Transactional Outbox Events (${events.length}):`,
      ...events.map((e) => {
        const target = e.target ? ` -> ${e.target}` : "";
        return `  ${e.id} | ${e.claimId} | [${e.status}] ${e.type}${target}: ${e.message}`;
      }),
    ];
    return lines.join("\n");
  }

  #handleClock(args: readonly string[]): string {
    const raw = args[0];
    if (!raw || !/^\+?\d+(\.\d+)?$/.test(raw)) {
      return `Current simulated time: ${new Date(this.#clockMs).toISOString()}\nUsage: clock +<days> (e.g., clock +31)`;
    }
    const days = Number(raw.replace(/^\+/, ""));
    this.#clockMs += days * 24 * 60 * 60 * 1000;
    return `Advanced simulated clock by ${days} day(s) -> ${new Date(this.#clockMs).toISOString()}`;
  }
}

export function startInteractiveRepl(configPath = DEFAULT_CONFIG_PATH): void {
  const session = new CliSession(configPath);
  const cfg = session.getOrchestrator().getConfig();

  console.log("================================================================================");
  console.log(`  Claims Workflow Orchestrator CLI — ${cfg.name} (v${cfg.version})`);
  console.log("  Type 'help' for commands, 'seed' for sample claims, or 'exit' to quit.");
  console.log("================================================================================\n");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "claims> ",
  });

  rl.prompt();

  rl.on("line", (line) => {
    const { output, shouldExit } = session.executeCommand(line);
    if (output.length > 0) {
      console.log(output);
    }
    if (shouldExit) {
      rl.close();
      return;
    }
    rl.prompt();
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const customConfigIdx = process.argv.indexOf("--config");
  const customConfig =
    customConfigIdx >= 0 && process.argv[customConfigIdx + 1]
      ? resolve(process.cwd(), process.argv[customConfigIdx + 1]!)
      : DEFAULT_CONFIG_PATH;
  startInteractiveRepl(customConfig);
}

