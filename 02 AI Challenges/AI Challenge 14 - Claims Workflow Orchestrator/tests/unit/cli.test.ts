import { describe, expect, it } from "vitest";
import { CliSession, tokenizeCommand } from "../../src/cli/repl.js";
import { executeAllScenarios, renderScenariosMarkdown } from "../../scripts/scenarios/index.js";

describe("Phase 5 — Interactive CLI & Scenario Runner", () => {
  it("tokenizes quoted CLI arguments cleanly", () => {
    const tokens = tokenizeCommand(
      'advance C-1 REJECTED --role assessor --notes "Excluded under section 4.2"'
    );
    expect(tokens).toEqual([
      "advance",
      "C-1",
      "REJECTED",
      "--role",
      "assessor",
      "--notes",
      "Excluded under section 4.2",
    ]);
  });

  it("supports creating, inspecting valid transitions with required roles, advancing states, and viewing audit trails via CliSession", () => {
    const session = new CliSession();

    const created = session.executeCommand(
      "create --id C-CLI --amount 6000 --policy-limit 10000 --docs claim_form,medical_report,itemized_receipt"
    );
    expect(created.output).toContain("Created claim C-CLI -> SUBMITTED");

    const shown = session.executeCommand("show C-CLI");
    expect(shown.output).toContain("Current State    : SUBMITTED");
    expect(shown.output).toContain("DOCUMENTS_VERIFIED");
    expect(shown.output).toContain("required role(s): document_clerk");

    const step1 = session.executeCommand(
      'advance C-CLI DOCUMENTS_VERIFIED --role document_clerk --user clerk-1 --notes "Verified"'
    );
    expect(step1.output).toContain("[OK] SUBMITTED -> DOCUMENTS_VERIFIED");

    const step2 = session.executeCommand(
      "advance C-CLI UNDER_ASSESSMENT --role team_lead --user lead-1 --set assessorId=assessor-1"
    );
    expect(step2.output).toContain("[OK] DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT");

    // Inspect available transitions at UNDER_ASSESSMENT (shows APPROVED, REJECTED, PENDING_INFO + roles)
    const showAssessment = session.executeCommand("show C-CLI");
    expect(showAssessment.output).toContain("-> APPROVED");
    expect(showAssessment.output).toContain("-> REJECTED");
    expect(showAssessment.output).toContain("-> PENDING_INFO");
    expect(showAssessment.output).toContain("required role(s): assessor");
    expect(showAssessment.output).toContain("cycle usage: 0/3");

    const rejectStep = session.executeCommand(
      'advance C-CLI REJECTED --role assessor --user assessor-1 --set assessmentReportComplete=true --set rejectionReason="Out of network"'
    );
    expect(rejectStep.output).toContain("[OK] UNDER_ASSESSMENT -> REJECTED");

    // Advance simulated clock by 31 days to expire appeal period, then close as system
    expect(session.executeCommand("clock +31").output).toContain("Advanced simulated clock by 31");
    const closeStep = session.executeCommand("advance C-CLI CLOSED --role system --user cron-1");
    expect(closeStep.output).toContain("[OK] REJECTED -> CLOSED");

    const auditOut = session.executeCommand("audit C-CLI");
    expect(auditOut.output).toContain("Immutable Audit Trail for C-CLI (5 entries)");
    expect(auditOut.output).toContain(
      "trajectory=[SUBMITTED -> DOCUMENTS_VERIFIED -> UNDER_ASSESSMENT -> REJECTED -> CLOSED]"
    );

    const outboxOut = session.executeCommand("outbox C-CLI");
    expect(outboxOut.output).toContain("[DISPATCHED]");

    expect(session.executeCommand("exit").shouldExit).toBe(true);
  });

  it("executes all 7 scenarios and renders complete Markdown report with audit trails", () => {
    const summaries = executeAllScenarios();
    expect(summaries).toHaveLength(7);
    expect(summaries.every((s) => s.passedExpectation)).toBe(true);

    const md = renderScenariosMarkdown(summaries);
    expect(md).toContain("## Scenario 1 — Happy Path");
    expect(md).toContain("## Scenario 2 — Rejection Path");
    expect(md).toContain("## Scenario 3 — Request More Info Loop");
    expect(md).toContain("## Scenario 4 — Invalid Transition");
    expect(md).toContain("## Scenario 5 — Unauthorized Role");
    expect(md).toContain("Maximum information requests exceeded — escalate to team lead");
  });
});

