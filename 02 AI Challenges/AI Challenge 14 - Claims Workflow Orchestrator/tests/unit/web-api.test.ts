import { describe, expect, it } from "vitest";
import { createWorkflowApp } from "../../src/web/server.js";

describe("Web UI Server & REST API (Phase 7 — Hono)", () => {
  const { app } = createWorkflowApp({ silent: true });

  const jsonPost = (path: string, body?: unknown) =>
    app.request(path, {
      method: "POST",
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });

  it("serves the HTML workbench and static assets", async () => {
    const htmlRes = await app.request("/");
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("Content-Type")).toContain("text/html");
    const html = await htmlRes.text();
    expect(html).toContain("Claims Workflow Orchestrator — Workbench");
    expect(html).toContain("simulated-clock");

    const cssRes = await app.request("/styles.css");
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("Content-Type")).toContain("text/css");

    const jsRes = await app.request("/app.js");
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("Content-Type")).toContain("application/javascript");
  });

  it("returns workflow metadata at GET /api/workflow", async () => {
    const res = await app.request("/api/workflow");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      config: { name: string; version: string; roles: string[] };
    };
    expect(json.ok).toBe(true);
    expect(json.config.name).toBe("Insurance Claims Lifecycle Workflow");
    expect(json.config.version).toBe("1.0.0");
    expect(json.config.roles).toContain("assessor");
  });

  it("seeds sample claims at POST /api/seed", async () => {
    const res = await jsonPost("/api/seed");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; claims: Array<{ id: string }> };
    expect(json.ok).toBe(true);
    expect(json.claims.length).toBeGreaterThanOrEqual(3);
  });

  it("lists claims at GET /api/claims", async () => {
    const res = await app.request("/api/claims");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; count: number; claims: Array<{ id: string; state: string }> };
    expect(json.ok).toBe(true);
    expect(json.count).toBeGreaterThanOrEqual(3);
    expect(json.claims.find((c) => c.id === "C-HAPPY")?.state).toBe("SUBMITTED");
  });

  it("fetches single claim and available transitions at GET /api/claims/:id", async () => {
    const res = await app.request("/api/claims/C-HAPPY");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      claim: { id: string; state: string };
      availableTransitions: Array<{ to: string; allPreconditionsMet: boolean }>;
    };
    expect(json.ok).toBe(true);
    expect(json.claim.id).toBe("C-HAPPY");
    expect(json.availableTransitions[0]?.to).toBe("DOCUMENTS_VERIFIED");
    expect(json.availableTransitions[0]?.allPreconditionsMet).toBe(true);
  });

  it("advances claim through POST /api/claims/:id/advance", async () => {
    const res = await jsonPost("/api/claims/C-HAPPY/advance", {
      toState: "DOCUMENTS_VERIFIED",
      actor: { userId: "clerk-test", role: "document_clerk" },
      notes: "Verified in automated test",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; claim: { state: string; version: number } };
    expect(json.ok).toBe(true);
    expect(json.claim.state).toBe("DOCUMENTS_VERIFIED");
    expect(json.claim.version).toBe(2);
  });

  it("rejects invalid role transition with HTTP 422 and structured error", async () => {
    const res = await jsonPost("/api/claims/C-HAPPY/advance", {
      toState: "UNDER_ASSESSMENT",
      actor: { userId: "clerk-intruder", role: "document_clerk" },
    });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("UNAUTHORIZED_ROLE");
  });

  it("returns audit trail and replay integrity at GET /api/claims/:id/audit", async () => {
    const res = await app.request("/api/claims/C-HAPPY/audit");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      count: number;
      entries: Array<{ outcome: string }>;
      replay: { currentState: string; deniedAttempts: number };
    };
    expect(json.ok).toBe(true);
    expect(json.count).toBeGreaterThanOrEqual(3);
    expect(json.entries.some((e) => e.outcome === "DENIED")).toBe(true);
    expect(json.replay.currentState).toBe("DOCUMENTS_VERIFIED");
    expect(json.replay.deniedAttempts).toBe(1);
  });

  it("returns outbox side-effects at GET /api/claims/:id/outbox", async () => {
    const res = await app.request("/api/claims/C-HAPPY/outbox");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; count: number; events: Array<{ status: string }> };
    expect(json.ok).toBe(true);
    expect(json.count).toBeGreaterThan(0);
    expect(json.events[0]?.status).toBe("DISPATCHED");
  });

  it("advances simulated clock via POST /api/clock", async () => {
    const res = await jsonPost("/api/clock", { days: 31 });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; clock: { iso: string } };
    expect(json.ok).toBe(true);
    expect(Date.parse(json.clock.iso)).toBeGreaterThan(Date.parse("2026-11-25T00:00:00Z"));
  });

  it("creates a new custom claim via POST /api/claims", async () => {
    const res = await jsonPost("/api/claims", {
      id: "C-CUSTOM-TEST",
      data: { amount: 3500, policyLimit: 12000 },
      notes: "Custom test claim",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { ok: boolean; claim: { id: string; state: string } };
    expect(json.ok).toBe(true);
    expect(json.claim.id).toBe("C-CUSTOM-TEST");
    expect(json.claim.state).toBe("SUBMITTED");
  });
});
