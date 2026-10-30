import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ClaimsSession, resolveConfigPathFromArgv } from "../app/claims-session.js";
import { createClaimsRoutes } from "./routes/claims.routes.js";
import { createSystemRoutes } from "./routes/system.routes.js";
import type { WebServerInstance, WebServerOptions, WorkflowWebApp } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "public");

const STATIC_ASSETS: Readonly<Record<string, { file: string; mime: string }>> = {
  "/": { file: "index.html", mime: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", mime: "text/html; charset=utf-8" },
  "/styles.css": { file: "styles.css", mime: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", mime: "application/javascript; charset=utf-8" },
};

/**
 * Builds the Hono web application backed by modular route controllers.
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

  // Mount modular route controllers (Separation of Concerns)
  app.route("/api", createSystemRoutes(session));
  app.route("/api/claims", createClaimsRoutes(session));

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
  const configPath = resolveConfigPathFromArgv();
  createWebServer({ configPath }).catch((err) => {
    console.error("Failed to start Web Server:", err);
    process.exit(1);
  });
}
