import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ClaimsSession, DEFAULT_CONFIG_PATH } from "../app/claims-session.js";
import type {
  AdvanceClaimDto,
  AdvanceClockDto,
  CreateClaimDto,
  WebServerInstance,
  WebServerOptions,
  WorkflowWebApp,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "public");

const STATIC_ASSETS: Readonly<Record<string, { file: string; mime: string }>> = {
  "/": { file: "index.html", mime: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", mime: "text/html; charset=utf-8" },
  "/styles.css": { file: "styles.css", mime: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", mime: "application/javascript; charset=utf-8" },
};

/**
 * Builds the Hono web application backed by a shared ClaimsSession.
 * Testable in-memory via `app.request(...)` without opening network sockets.
 */
export function createWorkflowApp(options: WebServerOptions = {}): WorkflowWebApp {
  const session = new ClaimsSession(options);
  const app = new Hono();

  app.use("*", cors());

  for (const [route, asset] of Object.entries(STATIC_ASSETS)) {
    app.get(route, async (c) => {
      const content = await readFile(resolve(PUBLIC_DIR, asset.file), "utf8");
      return c.body(content, 200, {
        "Content-Type": asset.mime,
        "Cache-Control": "no-cache",
      });
    });
  }

  app.get("/api/workflow", (c) =>
    c.json({ ok: true, config: session.getWorkflow(), clock: session.getClock() })
  );

  app.get("/api/clock", (c) => c.json({ ok: true, clock: session.getClock() }));

  app.post("/api/clock", async (c) => {
    const body = await c.req.json<AdvanceClockDto>().catch(() => ({} as AdvanceClockDto));
    const days = Number(body.days ?? 0);
    const hours = Number(body.hours ?? 0);
    const clock = session.advanceClock({ days, hours });
    return c.json({
      ok: true,
      message: `Simulated clock advanced by ${days} days, ${hours} hours.`,
      clock,
    });
  });

  app.post("/api/seed", (c) => {
    const { seeded, claims } = session.seedDemoClaims();
    return c.json({
      ok: true,
      message: seeded.length > 0 ? `Seeded claims: ${seeded.join(", ")}` : "Claims already seeded.",
      seeded,
      claims,
    });
  });

  app.post("/api/reset", (c) => {
    session.reset();
    return c.json({ ok: true, message: "Orchestrator in-memory database reset successfully." });
  });

  app.get("/api/claims", (c) => {
    const claims = session.listClaims();
    return c.json({ ok: true, count: claims.length, claims });
  });

  app.post("/api/claims", async (c) => {
    const body = await c.req.json<CreateClaimDto>().catch(() => ({} as CreateClaimDto));
    const view = session.createClaim({
      ...(body.id ? { id: body.id } : {}),
      ...(body.notes ? { notes: body.notes } : {}),
      ...(body.data ? { extraData: body.data } : {}),
    });
    return c.json(
      { ok: true, message: `Claim ${view.claim.id} created in ${view.claim.state}.`, ...view },
      201
    );
  });

  app.get("/api/outbox", (c) => {
    const events = session.getOutbox();
    return c.json({ ok: true, count: events.length, events });
  });

  app.get("/api/claims/:id", (c) => {
    const claimId = c.req.param("id");
    const view = session.getClaimView(claimId);
    if (!view) {
      return c.json(
        { ok: false, error: { code: "CLAIM_NOT_FOUND", message: `Claim '${claimId}' not found` } },
        404
      );
    }
    return c.json({ ok: true, ...view });
  });

  app.post("/api/claims/:id/advance", async (c) => {
    const claimId = c.req.param("id");
    const body = await c.req.json<AdvanceClaimDto>().catch(() => ({} as AdvanceClaimDto));

    if (!body.toState || !body.actor?.role) {
      return c.json(
        {
          ok: false,
          error: { code: "BAD_REQUEST", message: "Missing required fields 'toState' and 'actor.role'." },
        },
        400
      );
    }

    const result = session.advanceClaim({
      claimId,
      toState: body.toState,
      role: body.actor.role,
      ...(body.actor.userId !== undefined ? { userId: body.actor.userId } : {}),
      ...(body.input !== undefined ? { input: body.input } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.expectedVersion !== undefined ? { expectedVersion: body.expectedVersion } : {}),
      ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
    });

    if (!result.ok) {
      const status =
        result.error.code === "CLAIM_NOT_FOUND"
          ? 404
          : result.error.code === "CONCURRENCY_CONFLICT"
            ? 409
            : 422;
      return c.json({ ok: false, error: result.error, claim: result.claim }, status);
    }

    return c.json({
      ok: true,
      message: `Claim transitioned to ${result.claim.state}.`,
      claim: result.claim,
      auditEntry: result.auditEntry,
      sideEffects: result.sideEffects,
      idempotentReplay: result.idempotentReplay,
      availableTransitions: session.getClaimView(claimId)?.availableTransitions ?? [],
    });
  });

  app.get("/api/claims/:id/audit", (c) => {
    const claimId = c.req.param("id");
    const report = session.getAuditReport(claimId);
    if (!report) {
      return c.json(
        { ok: false, error: { code: "CLAIM_NOT_FOUND", message: `Claim '${claimId}' not found` } },
        404
      );
    }
    return c.json({ ok: true, ...report });
  });

  app.get("/api/claims/:id/outbox", (c) => {
    const claimId = c.req.param("id");
    if (!session.getClaimView(claimId)) {
      return c.json(
        { ok: false, error: { code: "CLAIM_NOT_FOUND", message: `Claim '${claimId}' not found` } },
        404
      );
    }
    const events = session.getOutbox(claimId);
    return c.json({ ok: true, claimId, count: events.length, events });
  });

  app.notFound((c) =>
    c.json(
      { ok: false, error: { code: "NOT_FOUND", message: `Endpoint '${c.req.method} ${c.req.path}' not found.` } },
      404
    )
  );

  app.onError((err, c) =>
    c.json({ ok: false, error: { code: "INTERNAL_SERVER_ERROR", message: err.message } }, 500)
  );

  return { app, session };
}

/**
 * Starts the HTTP server listening on a TCP port for browser / Postman access.
 */
export async function createWebServer(options: WebServerOptions = {}): Promise<WebServerInstance> {
  const { app, session } = createWorkflowApp(options);
  const requestedPort = options.port ?? (process.env.PORT ? Number(process.env.PORT) : 3000);
  const hostname = options.hostname ?? "0.0.0.0";

  let actualPort = requestedPort;
  const server = await new Promise<ReturnType<typeof serve>>((resolveServer) => {
    const srv = serve({ fetch: app.fetch, port: requestedPort, hostname }, (info) => {
      actualPort = info.port;
      resolveServer(srv);
    });
  });

  if (!options.silent) {
    console.log("================================================================================");
    console.log("  Claims Workflow Orchestrator Web Workbench is running!");
    console.log(`  UI URL  : http://localhost:${actualPort}`);
    console.log(`  API Doc : http://localhost:${actualPort}/api/workflow`);
    console.log(`  Config  : ${session.getConfigPath()}`);
    console.log("================================================================================\n");
  }

  return {
    app,
    session,
    server,
    port: actualPort,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const customConfigIdx = process.argv.indexOf("--config");
  const configPath =
    customConfigIdx >= 0 && process.argv[customConfigIdx + 1]
      ? resolve(process.cwd(), process.argv[customConfigIdx + 1]!)
      : DEFAULT_CONFIG_PATH;

  createWebServer({ configPath }).catch((err) => {
    console.error("Failed to start Web Server:", err);
    process.exit(1);
  });
}
