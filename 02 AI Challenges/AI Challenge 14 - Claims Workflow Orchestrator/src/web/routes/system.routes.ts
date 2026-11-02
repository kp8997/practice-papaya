import { Hono } from "hono";
import type { ClaimsSession } from "../../app/claims-session.js";
import {
  ClaimValidationError,
  isPlainObject,
  parseStrictFiniteNumber,
  validateClockAdvanceDelta,
} from "../../domain/validation.js";
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
    const raw = await c.req.text();
    let parsed: unknown = {};
    if (raw.trim() !== "") {
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new ClaimValidationError(
          `Malformed JSON request body: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (!isPlainObject(parsed)) {
      throw new ClaimValidationError("Clock payload must be a JSON object");
    }

    const body = parsed as AdvanceClockDto & { readonly minutes?: unknown };
    const days = body.days !== undefined ? parseStrictFiniteNumber(body.days, "days") : 0;
    const hours = body.hours !== undefined ? parseStrictFiniteNumber(body.hours, "hours") : 0;
    const minutes = body.minutes !== undefined ? parseStrictFiniteNumber(body.minutes, "minutes") : 0;
    validateClockAdvanceDelta({ days, hours, minutes }, true);

    const clock = session.advanceClock({ days, hours, minutes });
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
