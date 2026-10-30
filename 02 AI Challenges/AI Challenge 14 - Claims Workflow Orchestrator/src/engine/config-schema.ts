import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

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

export type ScopedPath = z.infer<typeof ScopedPathSchema>;

const PrimitiveValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export type PrimitiveValue = z.infer<typeof PrimitiveValueSchema>;

export type LeafCondition =
  | { op: "present"; path: ScopedPath }
  | { op: "not_empty"; path: ScopedPath }
  | { op: "equals"; path: ScopedPath; value: PrimitiveValue }
  | { op: "gt"; path: ScopedPath; value: number }
  | { op: "gte"; path: ScopedPath; value: number }
  | { op: "lte"; path: ScopedPath; value: number }
  | { op: "lte_path"; path: ScopedPath; otherPath: ScopedPath }
  | { op: "includes_all"; path: ScopedPath; requiredPath: ScopedPath }
  | { op: "days_in_state_gte"; days: number };

export type Condition =
  | LeafCondition
  | { all_of: Condition[] }
  | { any_of: Condition[] }
  | { not: Condition };

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

export type PreconditionConfig = z.infer<typeof PreconditionSchema>;

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

export type SideEffectConfig = z.infer<typeof SideEffectSchema>;

export const StateDefinitionSchema = z
  .object({
    description: z.string().min(1),
    terminal: z.boolean().default(false),
  })
  .strict();

export type StateDefinition = z.infer<typeof StateDefinitionSchema>;

export const TransitionDefinitionSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    roles: z.array(z.string().min(1)).min(1),
    preconditions: z.array(PreconditionSchema).default([]),
    sideEffects: z.array(SideEffectSchema).default([]),
  })
  .strict();

export type TransitionDefinition = z.infer<typeof TransitionDefinitionSchema>;

export const CyclePolicySchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1).default(""),
    path: z.array(z.string().min(1)).min(3),
    maxCycles: z.number().int().positive(),
    errorMessage: z.string().min(1),
  })
  .strict();

export type CyclePolicy = z.infer<typeof CyclePolicySchema>;

export const WorkflowDefaultsSchema = z
  .object({
    requiredDocuments: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .default({ requiredDocuments: [] });

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
    const stateNames = new Set(Object.keys(config.states));
    const roleSet = new Set<string>();

    // 1. Ensure roles are unique
    config.roles.forEach((role, idx) => {
      if (roleSet.has(role)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roles", idx],
          message: `Duplicate role '${role}' in roles list`,
        });
      }
      roleSet.add(role);
    });

    // 2. Validate initialState exists and is not terminal
    const initialStateDef = config.states[config.initialState];
    if (!initialStateDef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["initialState"],
        message: `Initial state '${config.initialState}' is not defined in states`,
      });
    } else if (initialStateDef.terminal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["initialState"],
        message: `Initial state '${config.initialState}' cannot be marked terminal`,
      });
    }

    // 3. Require at least one terminal state
    const terminalStates = Object.entries(config.states)
      .filter(([, def]) => def.terminal)
      .map(([name]) => name);
    if (terminalStates.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["states"],
        message: "Workflow must declare at least one terminal state",
      });
    }

    // 4. Validate transitions: state existence, terminal source, duplicate edges, and roles
    const edgeSet = new Set<string>();
    const outgoingByState = new Map<string, string[]>();

    config.transitions.forEach((transition, idx) => {
      const fromDef = config.states[transition.from];
      const toDef = config.states[transition.to];

      if (!fromDef) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transitions", idx, "from"],
          message: `Transition references unknown source state '${transition.from}'`,
        });
      } else if (fromDef.terminal) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transitions", idx, "from"],
          message: `Terminal state '${transition.from}' cannot have outgoing transitions`,
        });
      }

      if (!toDef) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transitions", idx, "to"],
          message: `Transition references unknown target state '${transition.to}'`,
        });
      }

      const edgeKey = `${transition.from}->${transition.to}`;
      if (edgeSet.has(edgeKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transitions", idx],
          message: `Duplicate transition '${transition.from} -> ${transition.to}'`,
        });
      }
      edgeSet.add(edgeKey);

      const list = outgoingByState.get(transition.from) ?? [];
      list.push(transition.to);
      outgoingByState.set(transition.from, list);

      transition.roles.forEach((role, roleIdx) => {
        if (!roleSet.has(role)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["transitions", idx, "roles", roleIdx],
            message: `Transition '${transition.from} -> ${transition.to}' references undeclared role '${role}'`,
          });
        }
      });
    });

    // 5. Ensure every non-terminal state has at least one outgoing transition
    for (const [stateName, stateDef] of Object.entries(config.states)) {
      if (!stateDef.terminal && (outgoingByState.get(stateName)?.length ?? 0) === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["states", stateName],
          message: `Non-terminal state '${stateName}' has no outgoing transitions (dead-end state)`,
        });
      }
    }

    // 6. Reachability check via BFS from initialState
    if (initialStateDef) {
      const visited = new Set<string>([config.initialState]);
      const queue: string[] = [config.initialState];
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

      for (const stateName of stateNames) {
        if (!visited.has(stateName)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["states", stateName],
            message: `State '${stateName}' is unreachable from initial state '${config.initialState}'`,
          });
        }
      }
    }

    // 7. Validate cycle policies: closed loop and valid transition edges
    const policyIds = new Set<string>();
    config.cyclePolicies.forEach((policy, idx) => {
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
  });

export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

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

