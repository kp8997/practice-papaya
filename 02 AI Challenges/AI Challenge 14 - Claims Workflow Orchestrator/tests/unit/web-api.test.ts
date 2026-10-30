import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createWorkflowApiHandler, type HttpRequestHandler } from "../../src/web/server.js";

interface MockResponseCapture {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  json: <T = unknown>() => T;
}

function createMockResponse(): {
  res: {
    writeHead: (code: number, hdrs?: Record<string, string>) => void;
    end: (chunk?: string) => void;
    statusCode: number;
  };
  capture: MockResponseCapture;
} {
  const capture: MockResponseCapture = {
    statusCode: 200,
    headers: {},
    body: "",
    json<T = unknown>() {
      return JSON.parse(capture.body) as T;
    },
  };

  const res = {
    statusCode: 200,
    writeHead(code: number, hdrs?: Record<string, string>) {
      capture.statusCode = code;
      if (hdrs) Object.assign(capture.headers, hdrs);
    },
    end(chunk?: string) {
      if (chunk !== undefined) capture.body += chunk;
    },
  };

  return { res, capture };
}

function createMockRequest(method: string, url: string, payload?: unknown): IncomingMessage {
  const stream = new Readable({
    read() {
      if (payload !== undefined) {
        this.push(JSON.stringify(payload));
      }
      this.push(null);
    },
  }) as unknown as IncomingMessage;

  stream.method = method;
  stream.url = url;
  stream.headers = { host: "localhost" };
  return stream;
}

async function dispatch(
  handler: HttpRequestHandler,
  method: string,
  url: string,
  payload?: unknown
): Promise<MockResponseCapture> {
  const req = createMockRequest(method, url, payload);
  const { res, capture } = createMockResponse();
  await handler(req, res as any);
  return capture;
}

describe("Web UI Server & REST API (Phase 7)", () => {
  const { handler, context } = createWorkflowApiHandler({ silent: true });

  it("serves the HTML workbench at GET /", async () => {
    const res = await dispatch(handler, "GET", "/");
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("text/html");
    expect(res.body).toContain("Claims Workflow Orchestrator — Workbench");
    expect(res.body).toContain("simulated-clock");
  });

  it("returns workflow metadata at GET /api/workflow", async () => {
    const res = await dispatch(handler, "GET", "/api/workflow");
    expect(res.statusCode).toBe(200);
    const json = res.json<{ ok: boolean; config: { name: string; version: string; roles: string[] } }>();
    expect(json.ok).toBe(true);
    expect(json.config.name).toBe("Insurance Claims Lifecycle Workflow");
    expect(json.config.version).toBe("1.0.0");
    expect(json.config.roles).toContain("assessor");
  });

  it("seeds sample claims at POST /api/seed", async () => {
    const res = await dispatch(handler, "POST", "/api/seed");
    expect(res.statusCode).toBe(200);
    const json = res.json<{ ok: boolean; seeded: string[]; claims: Array<{ id: string }> }>();
    expect(json.ok).toBe(true);
    expect(json.claims.length).toBeGreaterThanOrEqual(3);
  });

  it("lists claims at GET /api/claims", async () => {
    const res = await dispatch(handler, "GET", "/api/claims");
    expect(res.statusCode).toBe(200);
    const json = res.json<{ ok: boolean; count: number; claims: Array<{ id: string; state: string }> }>();
    expect(json.ok).toBe(true);
    expect(json.count).toBeGreaterThanOrEqual(3);
    const happy = json.claims.find((c) => c.id === "C-HAPPY");
    expect(happy?.state).toBe("SUBMITTED");
  });

  it("fetches single claim and available transitions at GET /api/claims/:id", async () => {
    const res = await dispatch(handler, "GET", "/api/claims/C-HAPPY");
    expect(res.statusCode).toBe(200);
    const json = res.json<{
      ok: boolean;
      claim: { id: string; state: string };
      availableTransitions: Array<{ to: string; allPreconditionsMet: boolean }>;
    }>();
    expect(json.ok).toBe(true);
    expect(json.claim.id).toBe("C-HAPPY");
    expect(json.availableTransitions).toHaveLength(1);
    expect(json.availableTransitions[0]?.to).toBe("DOCUMENTS_VERIFIED");
    expect(json.availableTransitions[0]?.allPreconditionsMet).toBe(true);
  });

  it("advances claim through POST /api/claims/:id/advance", async () => {
    const res = await dispatch(handler, "POST", "/api/claims/C-HAPPY/advance", {
      toState: "DOCUMENTS_VERIFIED",
      actor: { userId: "clerk-test", role: "document_clerk" },
      notes: "Verified in automated test",
    });

    expect(res.statusCode).toBe(200);
    const json = res.json<{
      ok: boolean;
      claim: { state: string; version: number };
      sideEffects: Array<{ type: string }>;
    }>();
    expect(json.ok).toBe(true);
    expect(json.claim.state).toBe("DOCUMENTS_VERIFIED");
    expect(json.claim.version).toBe(2);
  });

  it("rejects invalid role transition with HTTP 422 and structured error", async () => {
    const res = await dispatch(handler, "POST", "/api/claims/C-HAPPY/advance", {
      toState: "UNDER_ASSESSMENT",
      actor: { userId: "clerk-intruder", role: "document_clerk" }, // Requires team_lead!
    });

    expect(res.statusCode).toBe(422);
    const json = res.json<{ ok: boolean; error: { code: string; message: string } }>();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("UNAUTHORIZED_ROLE");
  });

  it("returns audit trail and replay integrity at GET /api/claims/:id/audit", async () => {
    const res = await dispatch(handler, "GET", "/api/claims/C-HAPPY/audit");
    expect(res.statusCode).toBe(200);
    const json = res.json<{
      ok: boolean;
      count: number;
      entries: Array<{ outcome: string }>;
      replay: { currentState: string; version: number; deniedAttempts: number };
    }>();
    expect(json.ok).toBe(true);
    expect(json.count).toBeGreaterThanOrEqual(3);
    expect(json.entries.some((e) => e.outcome === "DENIED")).toBe(true);
    expect(json.replay.currentState).toBe("DOCUMENTS_VERIFIED");
    expect(json.replay.deniedAttempts).toBe(1);
  });

  it("returns outbox side-effects at GET /api/claims/:id/outbox", async () => {
    const res = await dispatch(handler, "GET", "/api/claims/C-HAPPY/outbox");
    expect(res.statusCode).toBe(200);
    const json = res.json<{ ok: boolean; count: number; events: Array<{ type: string; status: string }> }>();
    expect(json.ok).toBe(true);
    expect(json.count).toBeGreaterThan(0);
    expect(json.events[0]?.status).toBe("DISPATCHED");
  });

  it("advances simulated clock via POST /api/clock", async () => {
    const res = await dispatch(handler, "POST", "/api/clock", { days: 31 });
    expect(res.statusCode).toBe(200);
    const json = res.json<{ ok: boolean; clock: { iso: string } }>();
    expect(json.ok).toBe(true);
    expect(Date.parse(json.clock.iso)).toBeGreaterThan(Date.parse("2026-11-25T00:00:00Z"));
  });

  it("creates a new custom claim via POST /api/claims", async () => {
    const res = await dispatch(handler, "POST", "/api/claims", {
      id: "C-CUSTOM-TEST",
      data: { amount: 3500, policyLimit: 12000 },
      notes: "Custom test claim",
    });
    expect(res.statusCode).toBe(201);
    const json = res.json<{ ok: boolean; claim: { id: string; state: string } }>();
    expect(json.ok).toBe(true);
    expect(json.claim.id).toBe("C-CUSTOM-TEST");
    expect(json.claim.state).toBe("SUBMITTED");
  });
});
