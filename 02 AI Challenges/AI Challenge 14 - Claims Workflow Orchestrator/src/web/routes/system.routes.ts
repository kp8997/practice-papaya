import { Hono } from "hono";
import type { ClaimsSession } from "../../app/claims-session.js";
import type { AdvanceClockDto } from "../types.js";

/**
 * Creates the Hono router for workflow metadata, clock, seeding, and outbox.
 */
export function createSystemRoutes(session: ClaimsSession): Hono {
  const router = new Hono();

  router.get("/workflow", (c) =>
    c.json({ ok: true, config: session.getWorkflow(), clock: session.getClock() })
  );

  router.get("/clock", (c) => c.json({ ok: true, clock: session.getClock() }));

  router.post("/clock", async (c) => {
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

  router.post("/seed", (c) => {
    const { seeded, claims } = session.seedDemoClaims();
    return c.json({
      ok: true,
      message: seeded.length > 0 ? `Seeded claims: ${seeded.join(", ")}` : "Claims already seeded.",
      seeded,
      claims,
    });
  });

  router.post("/reset", (c) => {
    session.reset();
    return c.json({ ok: true, message: "Orchestrator in-memory database reset successfully." });
  });

  router.get("/outbox", (c) => {
    const events = session.getOutbox();
    return c.json({ ok: true, count: events.length, events });
  });

  return router;
}

