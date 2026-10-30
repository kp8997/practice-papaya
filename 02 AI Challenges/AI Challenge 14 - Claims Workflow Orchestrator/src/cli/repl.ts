import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { ClaimsSession, DEFAULT_CONFIG_PATH } from "../app/claims-session.js";
import type { WorkflowOrchestrator } from "../engine/orchestrator.js";
import {
  formatAuditReport,
  formatClaimsList,
  formatClaimView,
  formatOutboxEvents,
  formatTransitionResult,
  formatWorkflow,
} from "./formatters.js";
import type { AdvanceCmdOptions, CommandExecutionOutput, CreateCmdOptions } from "./types.js";

const ARRAY_KEYS = new Set(["submittedDocuments", "requiredDocuments", "newDocuments"]);
const collectValues = (val: string, prev: string[]) => [...prev, val];

function parseValue(key: string, raw: string): unknown {
  if (ARRAY_KEYS.has(key)) {
    return raw === "none" || raw.trim() === ""
      ? []
      : raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
}

function parseSetPairs(pairs: readonly string[] = []): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const parts = pair.slice(0, eq).split(".");
    const value = parseValue(parts.at(-1)!, pair.slice(eq + 1));
    let cursor = result;
    for (const part of parts.slice(0, -1)) {
      if (typeof cursor[part] !== "object" || cursor[part] === null || Array.isArray(cursor[part])) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts.at(-1)!] = value;
  }
  return result;
}

/**
 * Splits a CLI input line into tokens while respecting single and double quotes.
 */
export function tokenizeCommand(line: string): string[] {
  const matches = line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!matches) return [];
  return matches.map((token) => token.replace(/"([^"]*)"|'([^']*)'/g, "$1$2"));
}

export function startInteractiveRepl(configPath = DEFAULT_CONFIG_PATH): void {
  const session = new CliSession(configPath);
  const cfg = session.getOrchestrator().getConfig();

  console.log("================================================================================");
  console.log(`  Claims Workflow Orchestrator CLI — ${cfg.name} (v${cfg.version})`);
  console.log("  Type 'help' for commands, 'seed' for sample claims, or 'exit' to quit.");
  console.log("================================================================================\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "claims> " });
  rl.prompt();
  rl.on("line", (line) => {
    const { output, shouldExit } = session.executeCommand(line);
    if (output) console.log(output);
    if (shouldExit) rl.close();
    else rl.prompt();
  });
}

export class CliSession {
  readonly #session: ClaimsSession;

  constructor(configPath = DEFAULT_CONFIG_PATH, initialClockIso?: string) {
    this.#session = new ClaimsSession({
      configPath,
      ...(initialClockIso !== undefined ? { initialClockIso } : {}),
    });
  }

  public getOrchestrator(): WorkflowOrchestrator {
    return this.#session.getOrchestrator();
  }

  #buildProgram(onOutput: (text: string) => void): Command {
    const program = new Command("claims")
      .description("Interactive Claims Workflow Orchestrator CLI")
      .exitOverride()
      .configureOutput({ writeOut: onOutput, writeErr: onOutput });

    program
      .command("workflow")
      .description("Show configured states, roles, transitions & cycle rules")
      .action(() => onOutput(formatWorkflow(this.#session.getWorkflow())));

    program
      .command("seed")
      .description("Create 3 sample claims (C-HAPPY, C-ASSESS, C-REJECTED)")
      .action(() => {
        const { seeded } = this.#session.seedDemoClaims();
        onOutput(
          seeded.length === 0
            ? "Sample claims (C-HAPPY, C-ASSESS, C-REJECTED) already exist. Run 'list' to inspect."
            : `Seeded sample claims:\n${seeded.map((id) => `  - ${id}`).join("\n")}\nTry: show C-ASSESS`
        );
      });

    program
      .command("list")
      .description("List all claims in the current session")
      .action(() => onOutput(formatClaimsList(this.#session.listClaims())));

    program
      .command("create")
      .description("Create a new claim in SUBMITTED state")
      .option("-i, --id <id>", "Custom claim ID")
      .option("--amount <number>", "Claimed amount", "5000")
      .option("--policy-limit <number>", "Policy limit", "10000")
      .option("--limit <number>", "Alias for --policy-limit")
      .option("--docs <items>", "Comma-separated document names or 'none'")
      .option("--notes <text>", "Submission notes")
      .option("-s, --set <key=value>", "Extra claim data key=value", collectValues, [])
      .action((opts: CreateCmdOptions & { limit?: string }) => {
        const amount = Number(opts.amount ?? 5000);
        const policyLimit = Number(opts.limit ?? opts.policyLimit ?? 10000);
        const submittedDocuments =
          opts.docs !== undefined ? (parseValue("submittedDocuments", opts.docs) as string[]) : undefined;
        const view = this.#session.createClaim({
          amount,
          policyLimit,
          extraData: parseSetPairs(opts.set),
          ...(opts.id !== undefined ? { id: opts.id } : {}),
          ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
          ...(submittedDocuments !== undefined ? { submittedDocuments } : {}),
        });
        const docs = (view.claim.data.submittedDocuments as string[] | undefined) ?? [];
        onOutput(
          [
            `[OK] Created claim ${view.claim.id} -> ${view.claim.state} (v${view.claim.version})`,
            `     Amount: ${amount}, Policy Limit: ${policyLimit}, Docs: [${docs.join(", ")}]`,
            `     Run 'show ${view.claim.id}' to inspect valid transitions and required roles.`,
          ].join("\n")
        );
      });

    program
      .command("show <claimId>")
      .aliases(["status", "transitions"])
      .description("View current state + valid transitions (with required role)")
      .action((claimId: string) => {
        const view = this.#session.getClaimView(claimId);
        onOutput(
          view
            ? formatClaimView(view, this.#session.getWorkflow())
            : `[NOT FOUND] Claim '${claimId}' does not exist.`
        );
      });

    program
      .command("advance <claimId> <toState>")
      .alias("transition")
      .description("Advance a claim to a target state")
      .requiredOption("-r, --role <role>", "Actor role executing the transition")
      .option("-u, --user <userId>", "Actor user ID")
      .option("--notes <text>", "Transition notes / reason")
      .option("--expected-version <number>", "Optimistic concurrency version check")
      .option("--idempotency-key <key>", "Idempotency key for safe retries")
      .option("-s, --set <key=value>", "Input field key=value (repeatable)", collectValues, [])
      .option("--json <payload>", "Raw JSON input object")
      .action((claimId: string, toState: string, opts: AdvanceCmdOptions) => {
        const input = {
          ...parseSetPairs(opts.set),
          ...(opts.json ? (JSON.parse(opts.json) as Record<string, unknown>) : {}),
        };
        const result = this.#session.advanceClaim({
          claimId,
          toState,
          role: opts.role!,
          input,
          ...(opts.user !== undefined ? { userId: opts.user } : {}),
          ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
          ...(opts.expectedVersion !== undefined ? { expectedVersion: Number(opts.expectedVersion) } : {}),
          ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
        });
        onOutput(formatTransitionResult(result));
      });

    program
      .command("audit <claimId>")
      .description("View full immutable audit trail & replay verification")
      .action((claimId: string) => {
        const report = this.#session.getAuditReport(claimId);
        onOutput(report ? formatAuditReport(report) : `No audit entries found for claim '${claimId}'.`);
      });

    program
      .command("outbox [claimId]")
      .description("View dispatched side-effect outbox events")
      .action((claimId?: string) => onOutput(formatOutboxEvents(this.#session.getOutbox(claimId), claimId)));

    program
      .command("clock [days]")
      .description("Inspect simulated clock or advance by +<days>")
      .action((rawDays?: string) => {
        if (!rawDays || !/^\+?\d+(\.\d+)?$/.test(rawDays)) {
          onOutput(`Current simulated time: ${this.#session.getClock().iso}\nUsage: clock +<days> (e.g., clock +31)`);
          return;
        }
        const days = Number(rawDays.replace(/^\+/, ""));
        const updated = this.#session.advanceClock({ days });
        onOutput(`Advanced simulated clock by ${days} day(s) -> ${updated.iso}`);
      });

    return program;
  }

  public executeCommand(rawLine: string): CommandExecutionOutput {
    const tokens = tokenizeCommand(rawLine.trim());
    if (tokens.length === 0) return { output: "", shouldExit: false };

    const head = tokens[0]!.toLowerCase();
    if (head === "exit" || head === "quit") {
      return { output: "Exiting Claims Workflow CLI.", shouldExit: true };
    }

    const chunks: string[] = [];
    const program = this.#buildProgram((text) => chunks.push(text.trimEnd()));

    try {
      program.parse([head, ...tokens.slice(1)], { from: "user" });
    } catch (err) {
      if (!(err instanceof CommanderError)) {
        chunks.push(`[CLI ERROR] ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { output: chunks.filter(Boolean).join("\n"), shouldExit: false };
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const idx = process.argv.indexOf("--config");
  const configPath =
    idx >= 0 && process.argv[idx + 1] ? resolve(process.cwd(), process.argv[idx + 1]!) : DEFAULT_CONFIG_PATH;
  startInteractiveRepl(configPath);
}
