import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { CommanderError } from "commander";
import { ClaimsSession, DEFAULT_CONFIG_PATH, resolveConfigPathFromArgv } from "../app/claims-session.js";
import { ClaimValidationError } from "../domain/validation.js";
import type { WorkflowOrchestrator } from "../engine/orchestrator.js";
import type { WorkflowConfig } from "../engine/types.js";
import { buildCliProgram } from "./commands.js";
import { tokenizeCommand } from "./parser.js";
import { isColorSupported, paint } from "./theme.js";
import type { CommandExecutionOutput } from "./types.js";

/**
 * Starts the interactive readline REPL loop.
 */
export function startInteractiveRepl(configPath = DEFAULT_CONFIG_PATH): void {
  const session = new CliSession(configPath);
  const cfg = session.getWorkflow();

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

/**
 * Manages an interactive CLI session backed by a ClaimsSession and Commander.
 */
export class CliSession {
  readonly #session: ClaimsSession;
  readonly #color: boolean;

  constructor(
    configPath = DEFAULT_CONFIG_PATH,
    initialClockIso?: string,
    color = isColorSupported()
  ) {
    this.#session = new ClaimsSession({
      configPath,
      ...(initialClockIso !== undefined ? { initialClockIso } : {}),
    });
    this.#color = color;
  }

  public getOrchestrator(): WorkflowOrchestrator {
    return this.#session.getOrchestrator();
  }

  public getWorkflow(): WorkflowConfig {
    return this.#session.getWorkflow();
  }

  public executeCommand(rawLine: string): CommandExecutionOutput {
    const tokens = tokenizeCommand(rawLine.trim());
    if (tokens.length === 0) return { output: "", shouldExit: false };

    const head = tokens[0]!.toLowerCase();
    if (head === "exit" || head === "quit") {
      return { output: "Exiting Claims Workflow CLI.", shouldExit: true };
    }

    const chunks: string[] = [];
    const program = buildCliProgram(this.#session, (text) => chunks.push(text.trimEnd()), this.#color);

    try {
      program.parse([head, ...tokens.slice(1)], { from: "user" });
    } catch (err) {
      if (err instanceof ClaimValidationError) {
        const badge = paint(`[REJECTED — ${err.code}]`, ["bold", "red"], this.#color);
        chunks.push(`${badge} ${err.message}`);
      } else if (!(err instanceof CommanderError)) {
        chunks.push(`[CLI ERROR] ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { output: chunks.filter(Boolean).join("\n"), shouldExit: false };
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const configPath = resolveConfigPathFromArgv();
  startInteractiveRepl(configPath);
}
