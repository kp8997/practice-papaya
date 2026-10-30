import { Hono } from "hono";
import type { ClaimsSession } from "../../app/claims-session.js";
import type { AdvanceClaimDto, CreateClaimDto } from "../types.js";

/**
 * Creates the Hono router for claim CRUD, transitions, audit, and outbox.
 */
export function createClaimsRoutes(session: ClaimsSession): Hono {
  const router = new Hono();

  router.get("/", (c) => {
    const claims = session.listClaims();
    return c.json({ ok: true, count: claims.length, claims });
  });

  router.post("/", async (c) => {
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

  router.get("/:id", (c) => {
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

  router.post("/:id/advance", async (c) => {
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

  router.get("/:id/audit", (c) => {
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

  router.get("/:id/outbox", (c) => {
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

  return router;
}

