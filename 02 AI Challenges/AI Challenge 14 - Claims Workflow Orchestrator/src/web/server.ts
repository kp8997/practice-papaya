import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkflowConfig } from "../engine/config-schema.js";
import { WorkflowOrchestrator } from "../engine/orchestrator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = resolve(__dirname, "../../config/claims-workflow.yaml");
const PUBLIC_DIR = resolve(__dirname, "public");

export interface WebServerOptions {
  readonly configPath?: string;
  readonly port?: number;
  readonly host?: string;
  readonly initialClockIso?: string;
  readonly silent?: boolean;
}

export interface WebServerInstance {
  readonly server: Server;
  readonly orchestrator: WorkflowOrchestrator;
  readonly port: number;
  readonly close: () => Promise<void>;
  readonly getSimulatedClockIso: () => string;
  readonly advanceClockDays: (days: number) => string;
}

export type HttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse | MockResponseLike
) => Promise<void>;

export interface MockResponseLike {
  writeHead: (statusCode: number, headers?: Record<string, string>) => unknown;
  end: (chunk?: string) => unknown;
  statusCode?: number;
}

/**
 * Parses JSON request body asynchronously.
 */
async function parseJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer | string) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      if (raw.trim().length === 0) {
        resolvePromise({} as T);
        return;
      }
      try {
        const parsed = JSON.parse(raw) as T;
        resolvePromise(parsed);
      } catch (err) {
        reject(new Error(`Invalid JSON request body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

/**
 * Sends a structured JSON response with proper CORS headers.
 */
function sendJson(res: ServerResponse | MockResponseLike, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(body);
}

/**
 * Seeds sample claims (C-HAPPY, C-ASSESS, C-REJECTED) into the given orchestrator.
 */
export function seedSampleClaims(orchestrator: WorkflowOrchestrator): string[] {
  const created: string[] = [];

  if (!orchestrator.getClaim("C-HAPPY")) {
    orchestrator.createClaim({
      id: "C-HAPPY",
      data: {
        amount: 6500,
        policyLimit: 10000,
        submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
      },
      notes: "Sample claim in SUBMITTED state with all required documents",
    });
    created.push("C-HAPPY");
  }

  if (!orchestrator.getClaim("C-ASSESS")) {
    orchestrator.createClaim({
      id: "C-ASSESS",
      data: {
        amount: 8200,
        policyLimit: 10000,
        submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
      },
      notes: "Sample claim in UNDER_ASSESSMENT assigned to assessor-alice",
    });
    orchestrator.transition({
      claimId: "C-ASSESS",
      toState: "DOCUMENTS_VERIFIED",
      actor: { userId: "clerk-bob", role: "document_clerk" },
    });
    orchestrator.transition({
      claimId: "C-ASSESS",
      toState: "UNDER_ASSESSMENT",
      actor: { userId: "lead-sarah", role: "team_lead" },
      input: { assessorId: "assessor-alice" },
    });
    created.push("C-ASSESS");
  }

  if (!orchestrator.getClaim("C-REJECTED")) {
    orchestrator.createClaim({
      id: "C-REJECTED",
      data: {
        amount: 4000,
        policyLimit: 10000,
        submittedDocuments: ["claim_form", "medical_report", "itemized_receipt"],
      },
      notes: "Sample claim in REJECTED state awaiting appeal expiration or acknowledgement",
    });
    orchestrator.transition({
      claimId: "C-REJECTED",
      toState: "DOCUMENTS_VERIFIED",
      actor: { userId: "clerk-bob", role: "document_clerk" },
    });
    orchestrator.transition({
      claimId: "C-REJECTED",
      toState: "UNDER_ASSESSMENT",
      actor: { userId: "lead-sarah", role: "team_lead" },
      input: { assessorId: "assessor-alice" },
    });
    orchestrator.transition({
      claimId: "C-REJECTED",
      toState: "REJECTED",
      actor: { userId: "assessor-alice", role: "assessor" },
      input: {
        assessmentReportComplete: true,
        rejectionReason: "Non-covered cosmetic treatment",
      },
    });
    created.push("C-REJECTED");
  }

  return created;
}

export interface WorkflowApiContext {
  orchestrator: WorkflowOrchestrator;
  getClockMs: () => number;
  setClockMs: (ms: number) => void;
  advanceClockMs: (deltaMs: number) => number;
  configPath: string;
}

/**
 * Creates the core HTTP request handler for the Claims Workflow API.
 */
export function createWorkflowApiHandler(options: WebServerOptions = {}): {
  handler: HttpRequestHandler;
  context: WorkflowApiContext;
} {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  let clockMs = Date.parse(options.initialClockIso ?? "2026-10-30T09:00:00.000Z");

  const context: WorkflowApiContext = {
    orchestrator: new WorkflowOrchestrator(loadWorkflowConfig(configPath), {
      clock: { now: () => new Date(clockMs) },
    }),
    getClockMs: () => clockMs,
    setClockMs: (ms: number) => { clockMs = ms; },
    advanceClockMs: (deltaMs: number) => { clockMs += deltaMs; return clockMs; },
    configPath,
  };

  const handler: HttpRequestHandler = async (req, res) => {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    const host = req.headers?.host ?? "localhost";
    const parsedUrl = new URL(req.url ?? "/", `http://${host}`);
    const pathname = parsedUrl.pathname;
    const method = req.method ?? "GET";

    try {
      // 1. Static UI serving
      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const html = await readFile(resolve(PUBLIC_DIR, "index.html"), "utf8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(html);
        return;
      }

      // 2. GET /api/workflow — Workflow configuration metadata
      if (method === "GET" && pathname === "/api/workflow") {
        sendJson(res, 200, {
          ok: true,
          config: context.orchestrator.getConfig(),
          clock: {
            iso: new Date(clockMs).toISOString(),
            timestamp: clockMs,
          },
        });
        return;
      }

      // 3. GET /api/clock & POST /api/clock/advance — Simulated Clock
      if (pathname === "/api/clock") {
        if (method === "GET") {
          sendJson(res, 200, {
            ok: true,
            clock: {
              iso: new Date(clockMs).toISOString(),
              timestamp: clockMs,
            },
          });
          return;
        }
        if (method === "POST") {
          const body = await parseJsonBody<{ days?: number; hours?: number }>(req);
          const days = Number(body.days ?? 0);
          const hours = Number(body.hours ?? 0);
          clockMs += (days * 24 + hours) * 60 * 60 * 1000;
          sendJson(res, 200, {
            ok: true,
            message: `Simulated clock advanced by ${days} days, ${hours} hours.`,
            clock: {
              iso: new Date(clockMs).toISOString(),
              timestamp: clockMs,
            },
          });
          return;
        }
      }

      // 4. POST /api/seed — Seed sample claims
      if (method === "POST" && pathname === "/api/seed") {
        const seeded = seedSampleClaims(context.orchestrator);
        sendJson(res, 200, {
          ok: true,
          message: seeded.length > 0 ? `Seeded claims: ${seeded.join(", ")}` : "Claims already seeded.",
          seeded,
          claims: context.orchestrator.getAllClaims(),
        });
        return;
      }

      // 5. POST /api/reset — Reset in-memory database
      if (method === "POST" && pathname === "/api/reset") {
        context.orchestrator = new WorkflowOrchestrator(loadWorkflowConfig(configPath), {
          clock: { now: () => new Date(clockMs) },
        });
        sendJson(res, 200, {
          ok: true,
          message: "Orchestrator in-memory database reset successfully.",
        });
        return;
      }

      // 6. GET /api/claims & POST /api/claims
      if (pathname === "/api/claims") {
        if (method === "GET") {
          const claims = context.orchestrator.getAllClaims();
          sendJson(res, 200, { ok: true, count: claims.length, claims });
          return;
        }
        if (method === "POST") {
          const body = await parseJsonBody<{
            id?: string;
            data?: Record<string, unknown>;
            notes?: string;
          }>(req);

          const defaultDocs = context.orchestrator.getConfig().defaults.requiredDocuments;
          const initialData: Record<string, unknown> = {
            amount: 5000,
            policyLimit: 10000,
            submittedDocuments: [...defaultDocs],
            ...(body.data ?? {}),
          };

          const claim = context.orchestrator.createClaim({
            ...(body.id ? { id: body.id } : {}),
            ...(body.notes ? { notes: body.notes } : {}),
            data: initialData,
          });

          sendJson(res, 201, {
            ok: true,
            message: `Claim ${claim.id} created in ${claim.state}.`,
            claim,
            availableTransitions: context.orchestrator.getAvailableTransitions(claim.id),
          });
          return;
        }
      }

      // 7. GET /api/outbox — Dispatched events across claims
      if (method === "GET" && pathname === "/api/outbox") {
        const events = context.orchestrator.getOutboxEvents();
        sendJson(res, 200, { ok: true, count: events.length, events });
        return;
      }

      // 8. Individual Claim Endpoints: /api/claims/:id/...
      const claimRouteMatch = pathname.match(/^\/api\/claims\/([^/]+)(?:\/(advance|audit|outbox))?$/);
      if (claimRouteMatch) {
        const claimId = decodeURIComponent(claimRouteMatch[1]!);
        const subAction = claimRouteMatch[2];

        // A. GET /api/claims/:id — Claim details + available transitions
        if (!subAction && method === "GET") {
          const claim = context.orchestrator.getClaim(claimId);
          if (!claim) {
            sendJson(res, 404, { ok: false, error: { code: "CLAIM_NOT_FOUND", message: `Claim '${claimId}' not found` } });
            return;
          }
          const availableTransitions = context.orchestrator.getAvailableTransitions(claimId);
          sendJson(res, 200, { ok: true, claim, availableTransitions });
          return;
        }

        // B. POST /api/claims/:id/advance — Execute transition
        if (subAction === "advance" && method === "POST") {
          const body = await parseJsonBody<{
            toState: string;
            actor: { userId: string; role: string };
            input?: Record<string, unknown>;
            notes?: string;
            expectedVersion?: number;
            idempotencyKey?: string;
          }>(req);

          if (!body.toState || !body.actor?.role) {
            sendJson(res, 400, {
              ok: false,
              error: {
                code: "BAD_REQUEST",
                message: "Missing required fields 'toState' and 'actor.role'.",
              },
            });
            return;
          }

          const result = context.orchestrator.transition({
            claimId,
            toState: body.toState,
            actor: {
              userId: body.actor.userId ?? `u-${body.actor.role}`,
              role: body.actor.role,
            },
            ...(body.input ? { input: body.input } : {}),
            ...(body.notes ? { notes: body.notes } : {}),
            ...(body.expectedVersion !== undefined ? { expectedVersion: body.expectedVersion } : {}),
            ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
          });

          clockMs += 60 * 1000;

          if (!result.ok) {
            const statusCode =
              result.error.code === "CLAIM_NOT_FOUND"
                ? 404
                : result.error.code === "CONCURRENCY_CONFLICT"
                  ? 409
                  : 422;
            sendJson(res, statusCode, {
              ok: false,
              error: result.error,
              claim: result.claim,
            });
            return;
          }

          sendJson(res, 200, {
            ok: true,
            message: `Claim transitioned to ${result.claim.state}.`,
            claim: result.claim,
            auditEntry: result.auditEntry,
            sideEffects: result.sideEffects,
            idempotentReplay: result.idempotentReplay,
            availableTransitions: context.orchestrator.getAvailableTransitions(claimId),
          });
          return;
        }

        // C. GET /api/claims/:id/audit — Audit Trail + Replay Verification
        if (subAction === "audit" && method === "GET") {
          const claim = context.orchestrator.getClaim(claimId);
          if (!claim) {
            sendJson(res, 404, { ok: false, error: { code: "CLAIM_NOT_FOUND", message: `Claim '${claimId}' not found` } });
            return;
          }
          const entries = context.orchestrator.getAuditTrail(claimId);
          const replay = context.orchestrator.replayClaim(claimId);
          sendJson(res, 200, {
            ok: true,
            claimId,
            count: entries.length,
            entries,
            replay,
          });
          return;
        }

        // D. GET /api/claims/:id/outbox — Outbox Events for claim
        if (subAction === "outbox" && method === "GET") {
          const claim = context.orchestrator.getClaim(claimId);
          if (!claim) {
            sendJson(res, 404, { ok: false, error: { code: "CLAIM_NOT_FOUND", message: `Claim '${claimId}' not found` } });
            return;
          }
          const events = context.orchestrator.getOutboxEvents(claimId);
          sendJson(res, 200, { ok: true, claimId, count: events.length, events });
          return;
        }
      }

      // Default: 404 Not Found
      sendJson(res, 404, {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Endpoint '${method} ${pathname}' not found.`,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, {
        ok: false,
        error: { code: "INTERNAL_SERVER_ERROR", message },
      });
    }
  };

  return { handler, context };
}

/**
 * Creates and starts the Claims Workflow Orchestrator HTTP web server.
 */
export async function createWebServer(options: WebServerOptions = {}): Promise<WebServerInstance> {
  const { handler, context } = createWorkflowApiHandler(options);
  const server = createServer((req, res) => {
    void handler(req, res);
  });

  const requestedPort = options.port ?? (process.env.PORT ? Number(process.env.PORT) : 3000);
  const host = options.host ?? "0.0.0.0";

  await new Promise<void>((resolvePromise) => {
    server.listen(requestedPort, host, () => {
      resolvePromise();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : requestedPort;

  if (!options.silent) {
    console.log("================================================================================");
    console.log(`  Claims Workflow Orchestrator Web Workbench is running!`);
    console.log(`  UI URL  : http://localhost:${actualPort}`);
    console.log(`  API Doc : http://localhost:${actualPort}/api/workflow`);
    console.log(`  Config  : ${context.configPath}`);
    console.log("================================================================================\n");
  }

  return {
    server,
    orchestrator: context.orchestrator,
    port: actualPort,
    close: async () => {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((err) => (err ? reject(err) : resolvePromise()));
      });
    },
    getSimulatedClockIso: () => new Date(context.getClockMs()).toISOString(),
    advanceClockDays: (days: number) => {
      const updated = context.advanceClockMs(days * 24 * 60 * 60 * 1000);
      return new Date(updated).toISOString();
    },
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const customConfigIdx = process.argv.indexOf("--config");
  const customConfig =
    customConfigIdx >= 0 && process.argv[customConfigIdx + 1]
      ? resolve(process.cwd(), process.argv[customConfigIdx + 1]!)
      : DEFAULT_CONFIG_PATH;

  createWebServer({ configPath: customConfig }).catch((err) => {
    console.error("Failed to start Web Server:", err);
    process.exit(1);
  });
}
