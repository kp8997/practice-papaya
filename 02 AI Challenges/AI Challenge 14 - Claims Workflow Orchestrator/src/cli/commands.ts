import { Command } from "commander";
import type { ClaimsSession } from "../app/claims-session.js";
import {
  formatAuditReport,
  formatClaimsList,
  formatClaimView,
  formatOutboxEvents,
  formatTransitionResult,
  formatWorkflow,
} from "./formatters.js";
import { parseSetPairs, parseValue } from "./parser.js";
import type { AdvanceCmdOptions, CreateCmdOptions } from "./types.js";

const collectValues = (val: string, prev: string[]) => [...prev, val];

/**
 * Builds the declarative Commander CLI program bound to a ClaimsSession.
 */
export function buildCliProgram(session: ClaimsSession, onOutput: (text: string) => void): Command {
  const program = new Command("claims")
    .description("Interactive Claims Workflow Orchestrator CLI")
    .exitOverride()
    .configureOutput({ writeOut: onOutput, writeErr: onOutput });

  program
    .command("workflow")
    .description("Show configured states, roles, transitions & cycle rules")
    .action(() => onOutput(formatWorkflow(session.getWorkflow())));

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
    .action(() => onOutput(formatClaimsList(session.listClaims())));

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
      const view = session.createClaim({
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
      const view = session.getClaimView(claimId);
      onOutput(
        view ? formatClaimView(view, session.getWorkflow()) : `[NOT FOUND] Claim '${claimId}' does not exist.`
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
      const result = session.advanceClaim({
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
      const report = session.getAuditReport(claimId);
      onOutput(report ? formatAuditReport(report) : `No audit entries found for claim '${claimId}'.`);
    });

  program
    .command("outbox [claimId]")
    .description("View dispatched side-effect outbox events")
    .action((claimId?: string) => onOutput(formatOutboxEvents(session.getOutbox(claimId), claimId)));

  program
    .command("clock [days]")
    .description("Inspect simulated clock or advance by +<days>")
    .action((rawDays?: string) => {
      if (!rawDays || !/^\+?\d+(\.\d+)?$/.test(rawDays)) {
        onOutput(`Current simulated time: ${session.getClock().iso}\nUsage: clock +<days> (e.g., clock +31)`);
        return;
      }
      const days = Number(rawDays.replace(/^\+/, ""));
      const updated = session.advanceClock({ days });
      onOutput(`Advanced simulated clock by ${days} day(s) -> ${updated.iso}`);
    });

  return program;
}

