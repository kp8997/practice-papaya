import { Command } from "commander";
import type { ClaimsSession } from "../app/claims-session.js";
import {
  ClaimValidationError,
  parseStrictFiniteNumber,
  parseStrictPositiveInt,
  validateClockAdvanceDelta,
} from "../domain/validation.js";
import {
  formatAuditReport,
  formatClaimsList,
  formatClaimView,
  formatOutboxEvents,
  formatTransitionResult,
  formatWorkflow,
} from "./formatters.js";
import { parseJsonObjectPayload, parseSetPairs, parseValue } from "./parser.js";
import { isColorSupported } from "./theme.js";
import type { AdvanceCmdOptions, AuditCmdOptions, CreateCmdOptions } from "./types.js";

const collectValues = (val: string, prev: string[]) => [...prev, val];

/**
 * Builds the declarative Commander CLI program bound to a ClaimsSession.
 */
export function buildCliProgram(
  session: ClaimsSession,
  onOutput: (text: string) => void,
  defaultColor = isColorSupported()
): Command {
  const program = new Command("claims")
    .description("Interactive Claims Workflow Orchestrator CLI")
    .exitOverride()
    .configureOutput({ writeOut: onOutput, writeErr: onOutput });

  program
    .command("workflow")
    .description("Show configured states, roles, transitions & cycle rules")
    .option("--color", "Force ANSI color output")
    .option("--no-color", "Disable ANSI color output")
    .action((opts: { color?: boolean }) =>
      onOutput(formatWorkflow(session.getWorkflow(), { color: opts.color ?? defaultColor }))
    );

  program
    .command("seed")
    .description("Create 3 sample claims (C-HAPPY, C-ASSESS, C-REJECTED)")
    .action(() => {
      const { seeded } = session.seedDemoClaims();
      onOutput(
        seeded.length === 0
          ? "Sample claims (C-HAPPY, C-ASSESS, C-REJECTED) already exist. Run 'list' to inspect."
          : `Seeded sample claims:\n${seeded.map((id) => `  - ${id}`).join("\n")}\nTry: show C-ASSESS`
      );
    });

  program
    .command("list")
    .description("List all claims in the current session")
    .option("--color", "Force ANSI color output")
    .option("--no-color", "Disable ANSI color output")
    .action((opts: { color?: boolean }) =>
      onOutput(formatClaimsList(session.listClaims(), { color: opts.color ?? defaultColor }))
    );

  program
    .command("create")
    .description("Create a new claim in SUBMITTED state")
    .option("-i, --id <id>", "Custom claim ID")
    .option("--amount <number>", "Claimed amount > 0 (default: 5000)")
    .option("--policy-limit <number>", "Policy limit > 0 (default: 10000)")
    .option("--limit <number>", "Alias for --policy-limit")
    .option("--docs <items>", "Comma-separated document names or 'none'")
    .option("--notes <text>", "Submission notes")
    .option("-s, --set <key=value>", "Extra claim data key=value", collectValues, [])
    .action((opts: CreateCmdOptions & { limit?: string }) => {
      const parsedAmount =
        opts.amount !== undefined ? parseStrictFiniteNumber(opts.amount, "amount") : undefined;
      const parsedPolicyLimitOpt =
        opts.policyLimit !== undefined
          ? parseStrictFiniteNumber(opts.policyLimit, "policyLimit")
          : undefined;
      const parsedLimitAlias =
        opts.limit !== undefined ? parseStrictFiniteNumber(opts.limit, "limit") : undefined;

      if (
        parsedPolicyLimitOpt !== undefined &&
        parsedLimitAlias !== undefined &&
        parsedPolicyLimitOpt !== parsedLimitAlias
      ) {
        throw new ClaimValidationError(
          `Conflicting policy limit options: --policy-limit (${parsedPolicyLimitOpt}) vs --limit (${parsedLimitAlias})`
        );
      }

      const policyLimit = parsedLimitAlias ?? parsedPolicyLimitOpt;
      const submittedDocuments =
        opts.docs !== undefined ? (parseValue("submittedDocuments", opts.docs) as string[]) : undefined;
      const extraData = parseSetPairs(opts.set);

      const view = session.createClaim({
        ...(parsedAmount !== undefined ? { amount: parsedAmount } : {}),
        ...(policyLimit !== undefined ? { policyLimit } : {}),
        extraData,
        ...(opts.id !== undefined ? { id: opts.id } : {}),
        ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
        ...(submittedDocuments !== undefined ? { submittedDocuments } : {}),
      });

      const finalAmount = view.claim.data.amount;
      const finalLimit = view.claim.data.policyLimit;
      const docs = (view.claim.data.submittedDocuments as string[] | undefined) ?? [];
      onOutput(
        [
          `[OK] Created claim ${view.claim.id} -> ${view.claim.state} (v${view.claim.version})`,
          `     Amount: ${String(finalAmount)}, Policy Limit: ${String(finalLimit)}, Docs: [${docs.join(", ")}]`,
          `     Run 'show ${view.claim.id}' to inspect valid transitions and required roles.`,
        ].join("\n")
      );
    });

  program
    .command("show <claimId>")
    .aliases(["status", "transitions"])
    .description("View current state + valid transitions (with required role)")
    .option("--color", "Force ANSI color output")
    .option("--no-color", "Disable ANSI color output")
    .action((claimId: string, opts: { color?: boolean }) => {
      const view = session.getClaimView(claimId);
      const color = opts.color ?? defaultColor;
      onOutput(
        view
          ? formatClaimView(view, session.getWorkflow(), { color })
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
    .option("--expected-version <number>", "Optimistic concurrency version check (integer >= 1)")
    .option("--idempotency-key <key>", "Idempotency key for safe retries")
    .option("-s, --set <key=value>", "Input field key=value (repeatable)", collectValues, [])
    .option("--json <payload>", "Raw JSON input object")
    .option("--color", "Force ANSI color output")
    .option("--no-color", "Disable ANSI color output")
    .action((claimId: string, toState: string, opts: AdvanceCmdOptions & { color?: boolean }) => {
      const expectedVersion =
        opts.expectedVersion !== undefined
          ? parseStrictPositiveInt(opts.expectedVersion, "expectedVersion")
          : undefined;
      const input = {
        ...parseSetPairs(opts.set),
        ...(opts.json !== undefined ? parseJsonObjectPayload(opts.json) : {}),
      };
      const result = session.advanceClaim({
        claimId,
        toState,
        role: opts.role!,
        input,
        ...(opts.user !== undefined ? { userId: opts.user } : {}),
        ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      });
      const color = opts.color ?? defaultColor;
      onOutput(formatTransitionResult(result, { color }));
    });

  program
    .command("audit <claimId>")
    .description("View full immutable audit trail & replay verification")
    .option("--outcome <type>", "Filter entries by outcome: 'success' or 'denied'")
    .option("-n, --limit <number>", "Limit output to the last N entries (integer >= 1)")
    .option("--color", "Force ANSI color output")
    .option("--no-color", "Disable ANSI color output")
    .action((claimId: string, opts: AuditCmdOptions) => {
      let outcome: "success" | "denied" | undefined;
      if (opts.outcome !== undefined) {
        const normalized = opts.outcome.trim().toLowerCase();
        if (normalized !== "success" && normalized !== "denied") {
          throw new ClaimValidationError(
            `'--outcome' must be 'success' or 'denied' (got '${opts.outcome}')`
          );
        }
        outcome = normalized;
      }

      const limit =
        opts.limit !== undefined ? parseStrictPositiveInt(opts.limit, "limit") : undefined;

      const report = session.getAuditReport(claimId);
      const color = opts.color ?? defaultColor;
      onOutput(
        report
          ? formatAuditReport(report, {
              color,
              ...(outcome !== undefined ? { outcome } : {}),
              ...(limit !== undefined ? { limit } : {}),
            })
          : `No audit entries found for claim '${claimId}'.`
      );
    });

  program
    .command("outbox [claimId]")
    .description("View dispatched side-effect outbox events")
    .option("--color", "Force ANSI color output")
    .option("--no-color", "Disable ANSI color output")
    .action((...args: unknown[]) => {
      const claimId = typeof args[0] === "string" ? args[0] : undefined;
      const opts = (
        typeof args[1] === "object" && args[1] !== null
          ? args[1]
          : typeof args[0] === "object" && args[0] !== null
            ? args[0]
            : {}
      ) as { color?: boolean };
      const color = opts.color ?? defaultColor;
      onOutput(formatOutboxEvents(session.getOutbox(claimId), claimId, { color }));
    });

  program
    .command("clock [days]")
    .description("Inspect simulated clock or advance by +<days>")
    .allowUnknownOption(true)
    .action((rawDays: string | undefined, _opts: unknown, cmd: Command) => {
      const arg = rawDays ?? cmd.args[0];
      if (arg === undefined) {
        onOutput(`Current simulated time: ${session.getClock().iso}\nUsage: clock +<days> (e.g., clock +31)`);
        return;
      }
      const days = parseStrictFiniteNumber(arg, "days");
      validateClockAdvanceDelta({ days }, true);
      const updated = session.advanceClock({ days });
      onOutput(`Advanced simulated clock by ${days} day(s) -> ${updated.iso}`);
    });

  return program;
}
