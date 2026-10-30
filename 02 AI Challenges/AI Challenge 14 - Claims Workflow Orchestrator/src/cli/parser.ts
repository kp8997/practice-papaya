const ARRAY_KEYS = new Set(["submittedDocuments", "requiredDocuments", "newDocuments"]);

/**
 * Splits a CLI input line into tokens while respecting single and double quotes.
 */
export function tokenizeCommand(line: string): string[] {
  const matches = line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!matches) return [];
  return matches.map((token) => token.replace(/"([^"]*)"|'([^']*)'/g, "$1$2"));
}

/**
 * Parses a CLI string value into boolean, number, array, or string.
 */
export function parseValue(key: string, raw: string): unknown {
  if (ARRAY_KEYS.has(key)) {
    return raw === "none" || raw.trim() === ""
      ? []
      : raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
}

/**
 * Parses repeated `--set key=value` or `key.nested=value` flags into a nested object.
 */
export function parseSetPairs(pairs: readonly string[] = []): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const parts = pair.slice(0, eq).split(".");
    const value = parseValue(parts.at(-1)!, pair.slice(eq + 1));
    let cursor = result;
    for (const part of parts.slice(0, -1)) {
      if (typeof cursor[part] !== "object" || cursor[part] === null || Array.isArray(cursor[part])) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts.at(-1)!] = value;
  }
  return result;
}

