import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Condition, LeafCondition, WorkflowConfig } from "./types.js";

/**
 * Valid scoped data paths used inside declarative precondition checks:
 * - `claim.<field>`     : reads strictly from persisted claim state before the transition
 * - `input.<field>`     : reads strictly from the current transition's input payload
 * - `effective.<field>` : reads from merged `{ ...claim.data, ...input }`
 */
export const ScopedPathSchema = z
  .string()
  .regex(
    /^(claim|input|effective)\.[a-zA-Z_][a-zA-Z0-9_.]*$/,
    "Path must start with 'claim.', 'input.', or 'effective.' followed by a valid property path"
  );

const PrimitiveValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const LeafConditionSchema: z.ZodType<LeafCondition> = z.discriminatedUnion("op", [
  z.object({ op: z.literal("present"), path: ScopedPathSchema }).strict(),
  z.object({ op: z.literal("not_empty"), path: ScopedPathSchema }).strict(),
  z
    .object({
      op: z.literal("equals"),
      path: ScopedPathSchema,
      value: PrimitiveValueSchema,
    })
    .strict(),
  z.object({ op: z.literal("gt"), path: ScopedPathSchema, value: z.number() }).strict(),
  z.object({ op: z.literal("gte"), path: ScopedPathSchema, value: z.number() }).strict(),
  z.object({ op: z.literal("lte"), path: ScopedPathSchema, value: z.number() }).strict(),
  z
    .object({
      op: z.literal("lte_path"),
      path: ScopedPathSchema,
      otherPath: ScopedPathSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("includes_all"),
      path: ScopedPathSchema,
      requiredPath: ScopedPathSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("days_in_state_gte"),
      days: z.number().positive("days must be > 0"),
    })
    .strict(),
]);

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    LeafConditionSchema,
    z.object({ all_of: z.array(ConditionSchema).min(1) }).strict(),
    z.object({ any_of: z.array(ConditionSchema).min(1) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
  ])
);

export const PreconditionSchema = z
  .object({
    description: z.string().min(1),
    check: ConditionSchema,
  })
  .strict();

export const SideEffectSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("notify"),
      target: z.string().min(1),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("record_timestamp"),
      field: z.string().min(1),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("create_payment_request"),
      field: z.string().min(1).default("paymentRequestId"),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("reset_timer"),
      timer: z.string().min(1),
      clearField: z.string().min(1),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("trigger_payment"),
      field: z.string().min(1).default("paymentTransactionId"),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("archive_claim"),
      field: z.string().min(1).default("archivedAt"),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("set_field"),
      field: z.string().min(1),
      value: PrimitiveValueSchema,
      message: z.string().min(1),
    })
    .strict(),
]);

export const StateDefinitionSchema = z
  .object({
    description: z.string().min(1),
    terminal: z.boolean().default(false),
  })
  .strict();

export const TransitionDefinitionSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    roles: z.array(z.string().min(1)).min(1),
    preconditions: z.array(PreconditionSchema).default([]),
    sideEffects: z.array(SideEffectSchema).default([]),
  })
  .strict();

export const CyclePolicySchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1).default(""),
    path: z.array(z.string().min(1)).min(3),
    maxCycles: z.number().int().positive(),
    errorMessage: z.string().min(1),
  })
  .strict();

export const WorkflowDefaultsSchema = z
  .object({
    requiredDocuments: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .default({ requiredDocuments: [] });

function validateRoles(roles: readonly string[], ctx: z.RefinementCtx): Set<string> {
  const roleSet = new Set<string>();
  roles.forEach((role, idx) => {
    if (roleSet.has(role)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["roles", idx],
        message: `Duplicate role '${role}' in roles list`,
      });
    }
    roleSet.add(role);
  });
  return roleSet;
}

function validateStates(
  initialState: string,
  states: Record<string, z.infer<typeof StateDefinitionSchema>>,
  ctx: z.RefinementCtx
): void {
  const initialStateDef = states[initialState];
  if (!initialStateDef) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["initialState"],
      message: `Initial state '${initialState}' is not defined in states`,
    });
  } else if (initialStateDef.terminal) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["initialState"],
      message: `Initial state '${initialState}' cannot be marked terminal`,
    });
  }

  const hasTerminal = Object.values(states).some((def) => def.terminal);
  if (!hasTerminal) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["states"],
      message: "Workflow must declare at least one terminal state",
    });
  }
}

interface TransitionTopology {
  readonly edgeSet: Set<string>;
  readonly outgoingByState: Map<string, string[]>;
}

function validateTransitions(
  transitions: readonly z.infer<typeof TransitionDefinitionSchema>[],
  states: Record<string, z.infer<typeof StateDefinitionSchema>>,
  roleSet: Set<string>,
  ctx: z.RefinementCtx
): TransitionTopology {
  const edgeSet = new Set<string>();
  const outgoingByState = new Map<string, string[]>();

  transitions.forEach((t, idx) => {
    const fromDef = states[t.from];
    const toDef = states[t.to];

    if (!fromDef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transitions", idx, "from"],
        message: `Transition references unknown source state '${t.from}'`,
      });
    } else if (fromDef.terminal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transitions", idx, "from"],
        message: `Terminal state '${t.from}' cannot have outgoing transitions`,
      });
    }

    if (!toDef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transitions", idx, "to"],
        message: `Transition references unknown target state '${t.to}'`,
      });
    }

    const edgeKey = `${t.from}->${t.to}`;
    if (edgeSet.has(edgeKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transitions", idx],
        message: `Duplicate transition '${t.from} -> ${t.to}'`,
      });
    }
    edgeSet.add(edgeKey);

    const list = outgoingByState.get(t.from) ?? [];
    list.push(t.to);
    outgoingByState.set(t.from, list);

    t.roles.forEach((role, roleIdx) => {
      if (!roleSet.has(role)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transitions", idx, "roles", roleIdx],
          message: `Transition '${t.from} -> ${t.to}' references undeclared role '${role}'`,
        });
      }
    });
  });

  return { edgeSet, outgoingByState };
}

function validateReachability(
  initialState: string,
  states: Record<string, z.infer<typeof StateDefinitionSchema>>,
  outgoingByState: Map<string, string[]>,
  ctx: z.RefinementCtx
): void {
  for (const [stateName, stateDef] of Object.entries(states)) {
    if (!stateDef.terminal && (outgoingByState.get(stateName)?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["states", stateName],
        message: `Non-terminal state '${stateName}' has no outgoing transitions (dead-end state)`,
      });
    }
  }

  if (states[initialState]) {
    const visited = new Set<string>([initialState]);
    const queue: string[] = [initialState];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      for (const next of outgoingByState.get(current) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }

    for (const stateName of Object.keys(states)) {
      if (!visited.has(stateName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["states", stateName],
          message: `State '${stateName}' is unreachable from initial state '${initialState}'`,
        });
      }
    }
  }
}

function validateCyclePolicies(
  cyclePolicies: readonly z.infer<typeof CyclePolicySchema>[],
  edgeSet: Set<string>,
  ctx: z.RefinementCtx
): void {
  const policyIds = new Set<string>();
  cyclePolicies.forEach((policy, idx) => {
    if (policyIds.has(policy.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cyclePolicies", idx, "id"],
        message: `Duplicate cycle policy id '${policy.id}'`,
      });
    }
    policyIds.add(policy.id);

    const first = policy.path[0];
    const last = policy.path[policy.path.length - 1];
    if (first !== last) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cyclePolicies", idx, "path"],
        message: `Cycle policy '${policy.id}' path must start and end with the same state (got '${first}' ... '${last}')`,
      });
    }

    for (let i = 0; i < policy.path.length - 1; i++) {
      const from = policy.path[i];
      const to = policy.path[i + 1];
      if (!from || !to) continue;
      if (!edgeSet.has(`${from}->${to}`)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cyclePolicies", idx, "path", i],
          message: `Cycle policy '${policy.id}' step '${from} -> ${to}' is not a defined transition`,
        });
      }
    }
  });
}

export const WorkflowConfigSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1).default("1.0.0"),
    initialState: z.string().min(1),
    defaults: WorkflowDefaultsSchema,
    roles: z.array(z.string().min(1)).min(1),
    states: z.record(z.string().min(1), StateDefinitionSchema),
    transitions: z.array(TransitionDefinitionSchema).min(1),
    cyclePolicies: z.array(CyclePolicySchema).default([]),
  })
  .strict()
  .superRefine((config, ctx) => {
    const roleSet = validateRoles(config.roles, ctx);
    validateStates(config.initialState, config.states, ctx);
    const { edgeSet, outgoingByState } = validateTransitions(
      config.transitions,
      config.states,
      roleSet,
      ctx
    );
    validateReachability(config.initialState, config.states, outgoingByState, ctx);
    validateCyclePolicies(config.cyclePolicies, edgeSet, ctx);
  });

export class WorkflowConfigError extends Error {
  public readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[]) {
    super(`${message}:\n  - ${issues.join("\n  - ")}`);
    this.name = "WorkflowConfigError";
    this.issues = Object.freeze([...issues]);
  }
}

/**
 * Parses and validates an in-memory object or YAML/JSON string into a strongly-typed WorkflowConfig.
 */
export function parseWorkflowConfig(rawInput: string | unknown): WorkflowConfig {
  let parsed: unknown = rawInput;
  if (typeof rawInput === "string") {
    try {
      parsed = parseYaml(rawInput);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new WorkflowConfigError("Failed to parse workflow YAML/JSON", [detail]);
    }
  }

  const result = WorkflowConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const loc = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${loc}${issue.message}`;
    });
    throw new WorkflowConfigError("Invalid workflow configuration", issues);
  }

  return result.data;
}

/**
 * Loads, parses, and validates a YAML or JSON workflow configuration file from disk.
 */
export function loadWorkflowConfig(filePath: string): WorkflowConfig {
  const content = readFileSync(filePath, "utf-8");
  return parseWorkflowConfig(content);
}

