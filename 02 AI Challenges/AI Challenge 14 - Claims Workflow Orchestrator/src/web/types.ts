import type { ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import type { ClaimsSession } from "../app/claims-session.js";
import type { SessionOptions } from "../app/types.js";

export interface WebServerOptions extends SessionOptions {
  readonly port?: number;
  readonly hostname?: string;
  readonly silent?: boolean;
}

export interface WorkflowWebApp {
  readonly app: Hono;
  readonly session: ClaimsSession;
}

export interface WebServerInstance extends WorkflowWebApp {
  readonly server: ServerType;
  readonly port: number;
  readonly close: () => Promise<void>;
}

export interface CreateClaimDto {
  readonly id?: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly notes?: string;
}

export interface AdvanceClaimDto {
  readonly toState?: string;
  readonly actor?: {
    readonly userId?: string;
    readonly role?: string;
  };
  readonly input?: Readonly<Record<string, unknown>>;
  readonly notes?: string;
  readonly expectedVersion?: number;
  readonly idempotencyKey?: string;
}

export interface AdvanceClockDto {
  readonly days?: number;
  readonly hours?: number;
}

