import { ClaimValidationError, isPlainObject } from "../domain/validation.js";

const ARRAY_KEYS = new Set(["submittedDocuments", "requiredDocuments", "newDocuments"]);
const STRING_KEYS = new Set([
  "id",
  "assessorId",
  "rejectionReason",
  "missingInfoDescription",
  "additionalInfo",
  "paymentReference",
  "notes",
]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Splits a CLI input line into tokens while respecting single and double quotes.
 */
export function tokenizeCommand(line: string): string[] {
  const matches = line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!matches) return [];
  return matches.map((token) => token.replace(/"([^"]*)"|'([^']*)'/g, "$1$2"));
}

/**
 * Parses a CLI string value into boolean, number, array, or string based on field semantics.
 */
export function parseValue(key: string, raw: string): unknown {
  if (ARRAY_KEYS.has(key)) {
    const trimmed = raw.trim();
    if (trimmed.toLowerCase() === "none") return [];
    if (trimmed === "") {
      throw new ClaimValidationError(
        `'${key}' cannot be empty; provide comma-separated document names or 'none'`
      );
    }
    const items = raw.split(",").map((s) => s.trim());
    if (items.some((item) => item.length === 0)) {
      throw new ClaimValidationError(
        `'${key}' contains an empty item in '${raw}'; provide non-empty comma-separated document names`
      );
    }
    return items;
  }

  if (STRING_KEYS.has(key)) {
    return raw;
  }

  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw) ? Number(raw) : raw;
}

/**
 * Parses repeated `--set key=value` or `key.nested=value` flags into a nested object.
 */
export function parseSetPairs(pairs: readonly string[] = []): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new ClaimValidationError(
        `Invalid --set argument '${pair}': expected 'key=value' format with a non-empty key`
      );
    }
    const rawKey = pair.slice(0, eq).trim();
    const parts = rawKey.split(".");
    if (parts.some((p) => p.length === 0 || FORBIDDEN_KEYS.has(p))) {
      throw new ClaimValidationError(`Invalid --set key '${rawKey}'`);
    }

    const leafKey = parts.at(-1)!;
    const value = parseValue(leafKey, pair.slice(eq + 1));
    let cursor = result;
    for (const part of parts.slice(0, -1)) {
      if (typeof cursor[part] !== "object" || cursor[part] === null || Array.isArray(cursor[part])) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[leafKey] = value;
  }
  return result;
}

/**
 * Parses a `--json <payload>` string and validates that it represents a plain JSON object.
 */
export function parseJsonObjectPayload(rawJson: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new ClaimValidationError(
      `Invalid --json payload: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!isPlainObject(parsed)) {
    throw new ClaimValidationError(
      `Invalid --json payload: expected a JSON object (e.g. '{"key": "value"}'), got ${Array.isArray(parsed) ? "array" : typeof parsed}`
    );
  }
  return parsed;
}
