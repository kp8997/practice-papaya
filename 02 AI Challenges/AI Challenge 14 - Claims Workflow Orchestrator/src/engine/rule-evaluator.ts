import { cloneAndFreeze } from "../domain/freeze.js";
import type { PreconditionCheckResult } from "../domain/types.js";
import type {
  Condition,
  ConditionEvaluationOutcome,
  PreconditionConfig,
  RuleEvaluationContext,
  ScopedPath,
} from "./types.js";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function formatValue(val: unknown): string {
  if (val === undefined) return "undefined";
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

function getNestedProperty(root: unknown, segments: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Resolves a scoped path (`claim.*`, `input.*`, or `effective.*`) against the evaluation context.
 * For `claim.<field>`, checks `claim.data.<field>` first, then top-level claim metadata (`id`, `state`, `version`, etc.).
 */
export function resolveScopedPath(path: ScopedPath | string, ctx: RuleEvaluationContext): unknown {
  const [scope, ...rest] = path.split(".");
  if (!scope || rest.length === 0) {
    return undefined;
  }

  if (scope === "input") {
    return getNestedProperty(ctx.input, rest);
  }

  if (scope === "effective") {
    const fromEffective = getNestedProperty(ctx.effective, rest);
    if (fromEffective !== undefined) {
      return fromEffective;
    }
    return getNestedProperty(ctx.claim, rest);
  }

  if (scope === "claim") {
    const fromData = getNestedProperty(ctx.claim.data, rest);
    if (fromData !== undefined) {
      return fromData;
    }
    return getNestedProperty(ctx.claim, rest);
  }

  return undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0 && value.every((item) => isNonEmpty(item));
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

/**
 * Evaluates a single declarative Condition node (leaf operator or boolean combinator).
 */
export function evaluateCondition(
  condition: Condition,
  ctx: RuleEvaluationContext
): ConditionEvaluationOutcome {
  if ("all_of" in condition) {
    const childResults = condition.all_of.map((child) => evaluateCondition(child, ctx));
    const failed = childResults.filter((r) => !r.passed);
    if (failed.length === 0) {
      return {
        passed: true,
        reason: childResults.map((r) => r.reason).join(" AND "),
      };
    }
    return {
      passed: false,
      reason: failed.map((r) => r.reason).join("; "),
    };
  }

  if ("any_of" in condition) {
    const childResults = condition.any_of.map((child) => evaluateCondition(child, ctx));
    const passedChild = childResults.find((r) => r.passed);
    if (passedChild) {
      return {
        passed: true,
        reason: passedChild.reason,
      };
    }
    return {
      passed: false,
      reason: `None of the conditions met (${childResults.map((r) => r.reason).join(" OR ")})`,
    };
  }

  if ("not" in condition) {
    const inner = evaluateCondition(condition.not, ctx);
    return {
      passed: !inner.passed,
      reason: !inner.passed
        ? `NOT (${inner.reason}) satisfied`
        : `Expected NOT condition to pass, but inner condition held (${inner.reason})`,
    };
  }

  switch (condition.op) {
    case "present": {
      const actual = resolveScopedPath(condition.path, ctx);
      const passed = actual !== undefined && actual !== null;
      return {
        passed,
        reason: passed
          ? `${condition.path} is present (${formatValue(actual)})`
          : `${condition.path} is missing (got ${formatValue(actual)})`,
      };
    }

    case "not_empty": {
      const actual = resolveScopedPath(condition.path, ctx);
      const passed = isNonEmpty(actual);
      return {
        passed,
        reason: passed
          ? `${condition.path} is non-empty`
          : `${condition.path} must not be empty (got ${formatValue(actual)})`,
      };
    }

    case "equals": {
      const actual = resolveScopedPath(condition.path, ctx);
      const passed = actual === condition.value;
      return {
        passed,
        reason: passed
          ? `${condition.path} equals ${formatValue(condition.value)}`
          : `${condition.path} expected ${formatValue(condition.value)}, got ${formatValue(actual)}`,
      };
    }

    case "gt": {
      const actual = resolveScopedPath(condition.path, ctx);
      const passed = isFiniteNumber(actual) && actual > condition.value;
      return {
        passed,
        reason: passed
          ? `${condition.path} (${actual}) > ${condition.value}`
          : `${condition.path} must be a finite number > ${condition.value} (got ${formatValue(actual)})`,
      };
    }

    case "gte": {
      const actual = resolveScopedPath(condition.path, ctx);
      const passed = isFiniteNumber(actual) && actual >= condition.value;
      return {
        passed,
        reason: passed
          ? `${condition.path} (${actual}) >= ${condition.value}`
          : `${condition.path} must be a finite number >= ${condition.value} (got ${formatValue(actual)})`,
      };
    }

    case "lte": {
      const actual = resolveScopedPath(condition.path, ctx);
      const passed = isFiniteNumber(actual) && actual <= condition.value;
      return {
        passed,
        reason: passed
          ? `${condition.path} (${actual}) <= ${condition.value}`
          : `${condition.path} must be a finite number <= ${condition.value} (got ${formatValue(actual)})`,
      };
    }

    case "lte_path": {
      const actual = resolveScopedPath(condition.path, ctx);
      const other = resolveScopedPath(condition.otherPath, ctx);
      const passed = isFiniteNumber(actual) && isFiniteNumber(other) && actual <= other;
      return {
        passed,
        reason: passed
          ? `${condition.path} (${actual}) <= ${condition.otherPath} (${other})`
          : `${condition.path} (${formatValue(actual)}) exceeds or cannot be compared with ${condition.otherPath} (${formatValue(other)})`,
      };
    }

    case "includes_all": {
      const actual = resolveScopedPath(condition.path, ctx);
      const required = resolveScopedPath(condition.requiredPath, ctx);
      if (!Array.isArray(required)) {
        return {
          passed: false,
          reason: `${condition.requiredPath} must be an array of required items (got ${formatValue(required)})`,
        };
      }
      if (!Array.isArray(actual)) {
        return {
          passed: false,
          reason: `${condition.path} must be an array containing ${formatValue(required)} (got ${formatValue(actual)})`,
        };
      }
      const actualSet = new Set(actual);
      const missing = required.filter((item) => !actualSet.has(item));
      const passed = missing.length === 0;
      return {
        passed,
        reason: passed
          ? `${condition.path} contains all required items (${formatValue(required)})`
          : `${condition.path} is missing required items: ${formatValue(missing)}`,
      };
    }

    case "days_in_state_gte": {
      const enteredMs = Date.parse(ctx.claim.stateEnteredAt);
      if (Number.isNaN(enteredMs)) {
        return {
          passed: false,
          reason: `Invalid stateEnteredAt timestamp '${ctx.claim.stateEnteredAt}'`,
        };
      }
      const elapsedDays = (ctx.now.getTime() - enteredMs) / MS_PER_DAY;
      const passed = elapsedDays >= condition.days;
      const rounded = Math.floor(elapsedDays * 100) / 100;
      return {
        passed,
        reason: passed
          ? `Days in state (${rounded}d) >= ${condition.days}d`
          : `Days in state (${rounded}d) is less than required ${condition.days}d`,
      };
    }
  }
}

/**
 * Evaluates all preconditions configured on a transition and returns frozen results.
 */
export function evaluatePreconditions(
  preconditions: readonly PreconditionConfig[],
  ctx: RuleEvaluationContext
): readonly PreconditionCheckResult[] {
  const results: PreconditionCheckResult[] = preconditions.map((pre) => {
    const outcome = evaluateCondition(pre.check, ctx);
    if (outcome.passed) {
      return {
        description: pre.description,
        passed: true,
      };
    }
    return {
      description: pre.description,
      passed: false,
      failureReason: `${pre.description}: ${outcome.reason}`,
    };
  });

  return cloneAndFreeze(results);
}
