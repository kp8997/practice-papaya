import { cloneAndFreeze, deepFreeze } from "../domain/freeze.js";
import type { Clock, OutboxEvent } from "../domain/types.js";
import { SystemClock } from "../domain/types.js";

export interface EnqueueOutboxInput {
  readonly claimId: string;
  readonly auditEntryId: string;
  readonly timestamp: string;
  readonly type: string;
  readonly target?: string;
  readonly message: string;
}

export type OutboxDispatcher = (event: OutboxEvent) => void;

export interface OutboxStoreOptions {
  readonly clock?: Clock;
  readonly dispatcher?: OutboxDispatcher;
}

/**
 * Default console dispatcher used when running interactive CLI or scenario scripts.
 * Tests can inject a silent or custom dispatcher to assert emitted side effects cleanly.
 */
export const ConsoleOutboxDispatcher: OutboxDispatcher = (event: OutboxEvent) => {
  const targetSuffix = event.target ? ` -> ${event.target}` : "";
  console.log(`[side-effect:${event.type}${targetSuffix}] ${event.message}`);
};

/**
 * In-memory Transactional Outbox store.
 * Decouples durable domain state transitions from external side-effect execution:
 * 1. Events are enqueued with status `PENDING` alongside the state commit.
 * 2. Dispatching invokes the configured handler and transitions the record to `DISPATCHED` or `FAILED`.
 * 3. Handler exceptions are caught and recorded on the outbox record (`FAILED`) so they never corrupt committed claim state.
 */
export class OutboxStore {
  readonly #events: OutboxEvent[] = [];
  readonly #clock: Clock;
  readonly #dispatcher: OutboxDispatcher;
  #sequence = 0;

  constructor(options: OutboxStoreOptions = {}) {
    this.#clock = options.clock ?? SystemClock;
    this.#dispatcher = options.dispatcher ?? (() => {});
  }

  public enqueue(input: EnqueueOutboxInput): OutboxEvent {
    this.#sequence += 1;
    const id = `OBX-${String(this.#sequence).padStart(4, "0")}`;
    const event: OutboxEvent = cloneAndFreeze({
      id,
      claimId: input.claimId,
      auditEntryId: input.auditEntryId,
      timestamp: input.timestamp,
      type: input.type,
      ...(input.target !== undefined ? { target: input.target } : {}),
      message: input.message,
      status: "PENDING",
    });

    this.#events.push(event);
    return event;
  }

  public dispatchPending(claimId?: string): readonly OutboxEvent[] {
    const processed: OutboxEvent[] = [];

    for (let i = 0; i < this.#events.length; i++) {
      const current = this.#events[i];
      if (!current || current.status !== "PENDING") continue;
      if (claimId !== undefined && current.claimId !== claimId) continue;

      const dispatchedAt = this.#clock.now().toISOString();
      try {
        this.#dispatcher(current);
        const updated: OutboxEvent = cloneAndFreeze({
          ...current,
          status: "DISPATCHED",
          dispatchedAt,
        });
        this.#events[i] = updated;
        processed.push(updated);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const failed: OutboxEvent = cloneAndFreeze({
          ...current,
          status: "FAILED",
          dispatchedAt,
          errorMessage,
        });
        this.#events[i] = failed;
        processed.push(failed);
      }
    }

    return deepFreeze(processed);
  }

  public getByClaimId(claimId: string): readonly OutboxEvent[] {
    return deepFreeze(this.#events.filter((e) => e.claimId === claimId));
  }

  public getFailedEvents(): readonly OutboxEvent[] {
    return deepFreeze(this.#events.filter((e) => e.status === "FAILED"));
  }

  public getAll(): readonly OutboxEvent[] {
    return deepFreeze([...this.#events]);
  }
}

