import { describe, expect, it } from "vitest";
import { CliSession } from "../../src/cli/repl.js";
import { tokenizeCommand } from '../../src/cli/parser.js'
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

  it("formats audit output with structured tree layout, line-by-line delta changes, and supports outcome/limit/color filtering", () => {
    const session = new CliSession();
    session.executeCommand("create --id C-TREE --amount 5000");

    // Denied attempt: unauthorized role from SUBMITTED
    const deniedStep = session.executeCommand(
      "advance C-TREE DOCUMENTS_VERIFIED --role assessor --user assessor-1"
    );
    expect(deniedStep.output).toContain("[REJECTED — UNAUTHORIZED_ROLE]");

    // Successful attempt
    const successStep = session.executeCommand(
      'advance C-TREE DOCUMENTS_VERIFIED --role document_clerk --user clerk-1 --notes "All clear"'
    );
    expect(successStep.output).toContain("[OK] SUBMITTED -> DOCUMENTS_VERIFIED");

    // Full audit trail
    const auditFull = session.executeCommand("audit C-TREE");
    expect(auditFull.output).toContain("Immutable Audit Trail for C-TREE (3 entries)");
    expect(auditFull.output).toContain("│ Actor  : assessor-1 (assessor)");
    expect(auditFull.output).toContain("│ Actor  : clerk-1 (document_clerk)");
    expect(auditFull.output).toContain("[DENIED: UNAUTHORIZED_ROLE]");
    expect(auditFull.output).toContain("[SUCCESS · v2]");
    expect(auditFull.output).toContain("└ Delta  :");
    expect(auditFull.output).toContain("+ amount");

    // Filter by outcome: denied only
    const auditDenied = session.executeCommand("audit C-TREE --outcome denied");
    expect(auditDenied.output).toContain("[DENIED: UNAUTHORIZED_ROLE]");
    expect(auditDenied.output).not.toContain("[SUCCESS · v2]");
    expect(auditDenied.output).toContain("showing 1");

    // Filter by outcome: success only
    const auditSuccess = session.executeCommand("audit C-TREE --outcome success");
    expect(auditSuccess.output).toContain("[SUCCESS · v1]");
    expect(auditSuccess.output).toContain("[SUCCESS · v2]");
    expect(auditSuccess.output).not.toContain("[DENIED: UNAUTHORIZED_ROLE]");

    // Limit to latest 1 entry
    const auditLimit = session.executeCommand("audit C-TREE -n 1");
    expect(auditLimit.output).toContain("AUD-0003");
    expect(auditLimit.output).not.toContain("AUD-0001");

    // Color flags
    const auditColor = session.executeCommand("audit C-TREE --color");
    expect(auditColor.output).toContain("\x1b[");

    const auditNoColor = session.executeCommand("audit C-TREE --no-color");
    expect(auditNoColor.output).not.toContain("\x1b[");
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
