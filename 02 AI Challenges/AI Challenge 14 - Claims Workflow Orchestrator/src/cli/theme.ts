import type { AuditDelta } from "../domain/types.js";

export type AnsiStyle =
  | "reset"
  | "bold"
  | "dim"
  | "italic"
  | "underline"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray"
  | "bgRed"
  | "bgGreen"
  | "bgYellow"
  | "bgCyan";

const ANSI_CODES: Record<AnsiStyle, string> = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgCyan: "\x1b[46m",
};

/**
 * Checks if ANSI colors should be enabled by default.
 * Respects NO_COLOR env var and checks whether stdout is a TTY.
 */
export function isColorSupported(): boolean {
  if (process.env.NO_COLOR && process.env.NO_COLOR !== "0") {
    return false;
  }
  return Boolean(process.stdout && process.stdout.isTTY);
}

/**
 * Applies ANSI escape sequences if colors are enabled.
 */
export function paint(text: string, style: AnsiStyle | AnsiStyle[], enabled = true): string {
  if (!enabled || !text) return text;
  const styles = Array.isArray(style) ? style : [style];
  const prefix = styles.map((s) => ANSI_CODES[s] ?? "").join("");
  return `${prefix}${text}${ANSI_CODES.reset}`;
}

/**
 * Maps workflow states to distinctive semantic colors.
 */
export function formatStateBadge(state: string, enabled = true): string {
  switch (state) {
    case "SUBMITTED":
    case "DOCUMENTS_VERIFIED":
      return paint(state, ["bold", "cyan"], enabled);

    case "UNDER_ASSESSMENT":
      return paint(state, ["bold", "yellow"], enabled);

    case "FRAUD_CHECK":
      return paint(state, ["bold", "yellow"], enabled);

    case "PENDING_INFO":
      return paint(state, ["bold", "magenta"], enabled);

    case "APPROVED":
    case "PAYMENT_INITIATED":
      return paint(state, ["bold", "green"], enabled);

    case "REJECTED":
      return paint(state, ["bold", "red"], enabled);

    case "CLOSED":
      return paint(state, ["bold", "blue"], enabled);

    default:
      return paint(state, ["bold", "white"], enabled);
  }
}

/**
 * Colorizes transition status outcomes (SUCCESS, DENIED, IDEMPOTENT).
 */
export function formatOutcomeBadge(
  outcome: string,
  errorCode?: string,
  enabled = true
): string {
  if (outcome === "SUCCESS") {
    return paint("✔ SUCCESS", ["bold", "green"], enabled);
  }
  const code = errorCode ? `: ${errorCode}` : "";
  return paint(`✖ DENIED${code}`, ["bold", "red"], enabled);
}

/**
 * Formats a primitive or array value with syntax highlighting.
 */
export function formatValue(value: unknown, enabled = true): string {
  if (value === null || value === undefined) {
    return paint(String(value), "dim", enabled);
  }
  if (typeof value === "number") {
    return paint(String(value), "yellow", enabled);
  }
  if (typeof value === "boolean") {
    return paint(String(value), "magenta", enabled);
  }
  if (typeof value === "string") {
    return paint(JSON.stringify(value), "green", enabled);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => formatValue(v, enabled)).join(", ");
    return `[${items}]`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Pretty-prints a key-value data dictionary into aligned lines.
 */
export function formatDataBlock(
  data: Readonly<Record<string, unknown>>,
  indent = "    ",
  enabled = true
): string[] {
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return [`${indent}${paint("(empty)", "dim", enabled)}`];
  }

  const maxKeyLen = Math.max(...entries.map(([k]) => k.length));
  return entries.map(([key, val]) => {
    const keyStr = paint(key.padEnd(maxKeyLen), "cyan", enabled);
    const colon = paint(":", "dim", enabled);
    return `${indent}${keyStr} ${colon} ${formatValue(val, enabled)}`;
  });
}

/**
 * Formats an audit delta into clear, line-by-line diff indicators (+, ~, -).
 */
export function formatDeltaBlock(
  delta: AuditDelta,
  indent = "        ",
  enabled = true
): string[] {
  const entries = Object.entries(delta);
  if (entries.length === 0) {
    return [`${indent}${paint("(no data fields modified)", "dim", enabled)}`];
  }

  const maxKeyLen = Math.max(...entries.map(([k]) => k.length));
  return entries.map(([key, change]) => {
    const paddedKey = key.padEnd(maxKeyLen);

    if (change.removed) {
      const sign = paint("-", ["bold", "red"], enabled);
      const k = paint(paddedKey, "red", enabled);
      return `${indent}${sign} ${k} : ${formatValue(change.before, enabled)} -> ${paint("(removed)", "red", enabled)}`;
    }

    if (change.before === null || change.before === undefined) {
      const sign = paint("+", ["bold", "green"], enabled);
      const k = paint(paddedKey, "green", enabled);
      return `${indent}${sign} ${k} : ${paint("null", "dim", enabled)} -> ${formatValue(change.after, enabled)}`;
    }

    const sign = paint("~", ["bold", "yellow"], enabled);
    const k = paint(paddedKey, "yellow", enabled);
    return `${indent}${sign} ${k} : ${formatValue(change.before, enabled)} -> ${formatValue(change.after, enabled)}`;
  });
}

/**
 * Wraps long strings across word boundaries to prevent awkward terminal wrapping.
 */
export function wordWrap(text: string, width = 80, indent = "               "): string {
  if (!text) return "";
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines.join(`\n${indent}`);
}

