import type { WorkflowErrorCode } from "./errors.js";

export const MAX_MONETARY_AMOUNT = 1_000_000_000;
export const MAX_CLOCK_ADVANCE_DAYS = 36_500; // 100 years
export const CLAIM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const DOCUMENT_LIST_KEYS = new Set(["submittedDocuments", "requiredDocuments", "newDocuments"]);
const BOOLEAN_FIELD_KEYS = new Set([
  "assessmentReportComplete",
  "paymentConfirmed",
  "memberAcknowledged",
  "archived",
  "fraudCleared",
]);
const NON_EMPTY_TEXT_KEYS = new Set([
  "rejectionReason",
  "missingInfoDescription",
  "additionalInfo",
  "paymentReference",
]);

export type ValidationErrorCode = Extract<WorkflowErrorCode, "INVALID_CLAIM_DATA"> | "DUPLICATE_CLAIM";

/**
 * Structured error thrown when claim creation, clock manipulation, or CLI/API input fails validation.
 */
export class ClaimValidationError extends Error {
  public readonly code: ValidationErrorCode;
  public readonly issues: readonly string[];

  constructor(issues: string | readonly string[], code: ValidationErrorCode = "INVALID_CLAIM_DATA") {
    const list = typeof issues === "string" ? [issues] : [...issues];
    super(list.join("; "));
    this.name = "ClaimValidationError";
    this.code = code;
    this.issues = Object.freeze(list);
  }
}

function describeValue(val: unknown): string {
  if (val === undefined) return "undefined";
  if (typeof val === "number" && !Number.isFinite(val)) return String(val);
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

export function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (typeof val !== "object" || val === null || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

/**
 * Parses a raw CLI/query string into a finite number, rejecting empty strings, whitespace, booleans, and NaN/Infinity.
 */
export function parseStrictFiniteNumber(raw: unknown, fieldName: string): number {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new ClaimValidationError(`'${fieldName}' must be a finite number (got ${describeValue(raw)})`);
    }
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) {
      throw new ClaimValidationError(`'${fieldName}' must be a valid number (got ${describeValue(raw)})`);
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new ClaimValidationError(`'${fieldName}' must be a finite number (got ${describeValue(raw)})`);
    }
    return parsed;
  }
  throw new ClaimValidationError(`'${fieldName}' must be a number (got ${describeValue(raw)})`);
}

/**
 * Parses a raw string or number into a positive safe integer (>= 1).
 */
export function parseStrictPositiveInt(raw: unknown, fieldName: string): number {
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw < 1) {
      throw new ClaimValidationError(
        `'${fieldName}' must be a positive integer >= 1 (got ${describeValue(raw)})`
      );
    }
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) {
      throw new ClaimValidationError(
        `'${fieldName}' must be a positive integer >= 1 (got ${describeValue(raw)})`
      );
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new ClaimValidationError(
        `'${fieldName}' must be a positive integer >= 1 (got ${describeValue(raw)})`
      );
    }
    return parsed;
  }
  throw new ClaimValidationError(
    `'${fieldName}' must be a positive integer >= 1 (got ${describeValue(raw)})`
  );
}

/**
 * Validates a custom Claim ID (1-64 chars, starts with alphanumeric, safe URL/CLI characters).
 */
export function validateClaimId(id: unknown, fieldName = "id"): string | null {
  if (typeof id !== "string") {
    return `'${fieldName}' must be a non-empty string (got ${describeValue(id)})`;
  }
  const trimmed = id.trim();
  if (!CLAIM_ID_PATTERN.test(trimmed) || trimmed !== id) {
    return `'${fieldName}' must be 1–64 characters starting with a letter or digit and containing only letters, digits, '.', '_', ':', or '-' without leading/trailing spaces (got ${describeValue(id)})`;
  }
  return null;
}

/**
 * Validates an Actor ({ userId, role }).
 */
export function validateActorInput(actor: unknown): string[] {
  if (!isPlainObject(actor)) {
    return [`'actor' must be an object with 'userId' and 'role' (got ${describeValue(actor)})`];
  }
  const issues: string[] = [];
  if (
    typeof actor.userId !== "string" ||
    actor.userId.trim().length === 0 ||
    actor.userId.trim().length > 128 ||
    /[\r\n\t]/.test(actor.userId)
  ) {
    issues.push(
      `'actor.userId' must be a non-empty string up to 128 characters (got ${describeValue(actor.userId)})`
    );
  }
  if (
    typeof actor.role !== "string" ||
    actor.role.trim().length === 0 ||
    actor.role.trim().length > 64 ||
    /\s/.test(actor.role.trim())
  ) {
    issues.push(
      `'actor.role' must be a non-empty role identifier without spaces (got ${describeValue(actor.role)})`
    );
  }
  return issues;
}

/**
 * Validates optional transition or creation notes.
 */
export function validateNotesInput(notes: unknown): string | null {
  if (notes === undefined) return null;
  if (typeof notes !== "string") {
    return `'notes' must be a string (got ${describeValue(notes)})`;
  }
  if (notes.length > 1000) {
    return `'notes' must not exceed 1000 characters (got length ${notes.length})`;
  }
  return null;
}

/**
 * Validates optional optimistic concurrency version.
 */
export function validateExpectedVersionInput(expectedVersion: unknown): string | null {
  if (expectedVersion === undefined) return null;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    return `'expectedVersion' must be a positive integer >= 1 (got ${describeValue(expectedVersion)})`;
  }
  return null;
}

/**
 * Validates optional idempotency key.
 */
export function validateIdempotencyKeyInput(key: unknown): string | null {
  if (key === undefined) return null;
  if (typeof key !== "string" || key.trim().length === 0 || key.trim().length > 128) {
    return `'idempotencyKey' must be a non-empty string up to 128 characters (got ${describeValue(key)})`;
  }
  return null;
}

function inspectNestedValues(value: unknown, path: string, depth: number, issues: string[]): void {
  if (depth > 8) {
    issues.push(`'${path}' exceeds maximum object nesting depth of 8`);
    return;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    issues.push(`'${path}' must be a finite number (got ${describeValue(value)})`);
    return;
  }
  if (typeof value === "function" || typeof value === "symbol") {
    issues.push(`'${path}' contains an unsupported value type (${typeof value})`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => inspectNestedValues(item, `${path}[${idx}]`, depth + 1, issues));
    return;
  }
  if (value !== null && typeof value === "object") {
    if (!isPlainObject(value)) {
      issues.push(`'${path}' must be a plain JSON-compatible object`);
      return;
    }
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) {
        issues.push(`'${path}.${key}' uses a forbidden property name '${key}'`);
        continue;
      }
      inspectNestedValues(value[key], `${path}.${key}`, depth + 1, issues);
    }
  }
}

/**
 * Validates claim `data` (on creation) or `input` (on state transition) against domain invariants:
 * - Monetary fields (`amount`, `policyLimit`) must be finite numbers > 0 and <= 1,000,000,000
 * - `fraudRiskScore` must be a finite number in [0, 100]
 * - Document arrays (`submittedDocuments`, `requiredDocuments`, `newDocuments`) must be arrays of non-empty strings
 * - Boolean flags (`assessmentReportComplete`, `paymentConfirmed`, `memberAcknowledged`, etc.) must be booleans
 * - Identifier & reason fields (`assessorId`, `rejectionReason`, `missingInfoDescription`, `additionalInfo`, `paymentReference`) must be valid non-empty strings
 * - Rejects NaN, Infinity, non-plain objects, and prototype-polluting keys anywhere in the payload
 */
export function validateClaimDataPayload(payload: unknown, label = "data"): string[] {
  if (!isPlainObject(payload)) {
    return [`'${label}' must be a plain object (got ${describeValue(payload)})`];
  }

  const issues: string[] = [];

  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      issues.push(`'${label}.${key}' uses a forbidden property name '${key}'`);
      continue;
    }

    const val = payload[key];
    if (val === undefined) continue;

    if (key === "amount" || key === "policyLimit") {
      if (typeof val !== "number" || !Number.isFinite(val) || val <= 0 || val > MAX_MONETARY_AMOUNT) {
        issues.push(
          `'${key}' must be a positive number greater than 0 (max ${MAX_MONETARY_AMOUNT.toLocaleString("en-US")}), got ${describeValue(val)}`
        );
      }
      continue;
    }

    if (key === "fraudRiskScore") {
      if (typeof val !== "number" || !Number.isFinite(val) || val < 0 || val > 100) {
        issues.push(`'fraudRiskScore' must be a number between 0 and 100, got ${describeValue(val)}`);
      }
      continue;
    }

    if (DOCUMENT_LIST_KEYS.has(key)) {
      if (
        !Array.isArray(val) ||
        !val.every((item) => typeof item === "string" && item.trim().length > 0 && item.trim().length <= 200)
      ) {
        issues.push(
          `'${key}' must be an array of non-empty document name strings (got ${describeValue(val)})`
        );
      }
      continue;
    }

    if (BOOLEAN_FIELD_KEYS.has(key)) {
      if (typeof val !== "boolean") {
        issues.push(`'${key}' must be a boolean (true or false), got ${describeValue(val)}`);
      }
      continue;
    }

    if (key === "assessorId") {
      if (typeof val !== "string" || !IDENTIFIER_PATTERN.test(val.trim())) {
        issues.push(
          `'assessorId' must be a valid non-empty identifier string without spaces (got ${describeValue(val)})`
        );
      }
      continue;
    }

    if (NON_EMPTY_TEXT_KEYS.has(key)) {
      if (typeof val !== "string" || val.trim().length === 0 || val.length > 1000) {
        issues.push(
          `'${key}' must be a non-empty string up to 1000 characters (got ${describeValue(val)})`
        );
      }
      continue;
    }

    inspectNestedValues(val, `${label}.${key}`, 1, issues);
  }

  return issues;
}

/**
 * Validates an ISO-8601 timestamp string and returns epoch milliseconds.
 */
export function validateClockIso(iso: unknown): number {
  if (typeof iso !== "string" || iso.trim().length === 0) {
    throw new ClaimValidationError(`Initial clock timestamp must be a valid ISO-8601 string (got ${describeValue(iso)})`);
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new ClaimValidationError(`Invalid ISO-8601 clock timestamp '${iso}'`);
  }
  return ms;
}

/**
 * Validates simulated clock advancement delta (monotonic non-negative, finite, bounded) and returns delta in ms.
 */
export function validateClockAdvanceDelta(
  delta: { readonly days?: unknown; readonly hours?: unknown; readonly minutes?: unknown },
  requirePositiveTotal = false
): number {
  if (!isPlainObject(delta)) {
    throw new ClaimValidationError("Clock advance payload must be an object");
  }

  const parseUnit = (val: unknown, unit: string): number => {
    if (val === undefined) return 0;
    const num = parseStrictFiniteNumber(val, unit);
    if (num < 0) {
      throw new ClaimValidationError(
        `Simulated clock cannot move backwards: '${unit}' must be >= 0 (got ${num})`
      );
    }
    return num;
  };

  const days = parseUnit(delta.days, "days");
  const hours = parseUnit(delta.hours, "hours");
  const minutes = parseUnit(delta.minutes, "minutes");

  const totalMs =
    days * 24 * 60 * 60 * 1000 + hours * 60 * 60 * 1000 + minutes * 60 * 1000;
  const maxMs = MAX_CLOCK_ADVANCE_DAYS * 24 * 60 * 60 * 1000;

  if (requirePositiveTotal && totalMs <= 0) {
    throw new ClaimValidationError(
      "Clock advancement must be greater than 0 (specify positive days, hours, or minutes)"
    );
  }
  if (totalMs > maxMs) {
    throw new ClaimValidationError(
      `Clock advancement exceeds maximum allowed step of ${MAX_CLOCK_ADVANCE_DAYS} days`
    );
  }

  return totalMs;
}

