/**
 * query_instances + mutate_instances — read and edit the Studio DataModel.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callStudio, describeError } from "../services/studio.js";
import { ok, fail } from "../services/format.js";
import { InstancePath, pagination } from "../schemas/common.js";
import { PROTECTED_SERVICES } from "../constants.js";

// --- query_instances --------------------------------------------------------

const QueryInputSchema = z
  .object({
    path: InstancePath.default("game").describe(
      "Root to search from (default 'game'). Use a service like 'Workspace' to scope.",
    ),
    class_name: z
      .string()
      .max(100)
      .optional()
      .describe("If set, only include instances of this ClassName (e.g. 'Part')."),
    name: z
      .string()
      .max(100)
      .optional()
      .describe("If set, only include instances whose Name contains this substring."),
    recursive: z
      .boolean()
      .default(true)
      .describe("Search all descendants (true) or only direct children (false)."),
    include_properties: z
      .boolean()
      .default(false)
      .describe("Include a serialized property map for each matched instance."),
    ...pagination,
  })
  .strict();

type QueryInput = z.infer<typeof QueryInputSchema>;

interface InstanceDto {
  path: string;
  name: string;
  className: string;
  childCount: number;
  properties?: Record<string, unknown>;
}

interface QueryResult {
  total: number;
  instances: InstanceDto[];
}

// --- mutate_instances -------------------------------------------------------

const OperationSchema = z
  .object({
    action: z
      .enum(["create", "set_properties", "rename", "reparent", "delete", "clone"])
      .describe("What to do to the target instance."),
    path: InstancePath.optional().describe(
      "Target instance path. Required for all actions except 'create' (where it is " +
        "the parent the new instance is created under).",
    ),
    class_name: z
      .string()
      .max(100)
      .optional()
      .describe("ClassName for 'create' (e.g. 'Part', 'Folder')."),
    name: z
      .string()
      .max(200)
      .optional()
      .describe("New name for 'create'/'rename', or the clone's name."),
    parent: InstancePath.optional().describe(
      "Destination parent path for 'reparent', or parent for 'create'/'clone'.",
    ),
    properties: z
      .record(z.unknown())
      .optional()
      .describe(
        "Property map to apply, e.g. {\"Anchored\": true, \"Size\": [4,1,2], " +
          "\"BrickColor\": \"Bright red\"}. Used by 'create' and 'set_properties'.",
      ),
  })
  .strict();

const MutateInputSchema = z
  .object({
    operations: z
      .array(OperationSchema)
      .min(1, "Provide at least one operation")
      .max(100, "At most 100 operations per call")
      .describe("Ordered list of mutations applied atomically per-operation."),
  })
  .strict();

type MutateInput = z.infer<typeof MutateInputSchema>;

interface OperationResult {
  ok: boolean;
  action: string;
  path?: string;
  resultPath?: string;
  error?: string;
}

interface MutateResult {
  results: OperationResult[];
}

/** Reject operations that target protected services before hitting Studio. */
function guardProtected(input: MutateInput): string | null {
  for (const op of input.operations) {
    const target = op.path ?? "";
    for (const svc of PROTECTED_SERVICES) {
      if (target === svc || target.includes(`.${svc}`) || target.startsWith(`${svc}.`)) {
        if (op.action === "delete" || op.action === "reparent" || op.action === "set_properties") {
          return `Refusing to ${op.action} protected service path '${target}' (${svc}).`;
        }
      }
    }
  }
  return null;
}

export function registerInstanceTools(server: McpServer): void {
  server.registerTool(
    "query_instances",
    {
      title: "Query Studio Instances",
      description: `Search the Roblox Studio DataModel and return matching instances.

Args:
  - path (string): Root to search from (default 'game').
  - class_name (string, optional): Filter by exact ClassName.
  - name (string, optional): Filter by Name substring (case-sensitive).
  - recursive (boolean): Descendants vs direct children (default true).
  - include_properties (boolean): Attach a serialized property map (default false).
  - limit / offset (number): Pagination (default 100 / 0).

Returns (structured):
  {
    "total": number,                 // total matches before pagination
    "instances": [
      { "path": string, "name": string, "className": string,
        "childCount": number, "properties"?: object }
    ]
  }

Examples:
  - "List every Part in Workspace" -> path: "Workspace", class_name: "Part"
  - "Find instances named 'Spawn'" -> name: "Spawn"

Error Handling:
  - Returns "Error: …not connected" if no Studio session is attached.
  - Returns total=0 with an empty list when nothing matches.`,
      inputSchema: QueryInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input: QueryInput) => {
      try {
        const result = await callStudio<QueryResult>("query_instances", input);
        const shown = result.instances.length;
        const lines = [
          `# Query results (${shown} of ${result.total})`,
          "",
          ...result.instances.map(
            (i) =>
              `- **${i.name}** (${i.className}) — \`${i.path}\`` +
              (i.childCount ? ` · ${i.childCount} children` : ""),
          ),
        ];
        return ok(result as unknown as Record<string, unknown>, lines.join("\n"));
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  server.registerTool(
    "mutate_instances",
    {
      title: "Mutate Studio Instances",
      description: `Create, edit, move, clone, or delete instances in the Studio DataModel.

Each operation is one of: create | set_properties | rename | reparent | delete | clone.
Operations run in order; each reports its own success/failure.

Args:
  - operations (array): Each item:
      { action, path?, class_name?, name?, parent?, properties? }
    - create:         class_name + parent (+ name, properties)
    - set_properties: path + properties
    - rename:         path + name
    - reparent:       path + parent
    - delete:         path
    - clone:          path (+ parent, name)
  Property values accept primitives, [x,y,z] arrays for Vector3/Size, and color names.

Returns (structured):
  { "results": [ { "ok": boolean, "action": string, "path"?: string,
                   "resultPath"?: string, "error"?: string } ] }

Examples:
  - Make a red anchored part:
      operations: [{ action: "create", class_name: "Part", parent: "Workspace",
                     name: "Block", properties: { Anchored: true, BrickColor: "Bright red" } }]
  - Move a model: operations: [{ action: "reparent", path: "Workspace.Old",
                                 parent: "ServerStorage" }]

Error Handling:
  - Refuses to delete/reparent/edit protected services (CoreGui, CorePackages, …).
  - Per-operation failures appear as ok=false with an 'error' string; other ops still run.`,
      inputSchema: MutateInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input: MutateInput) => {
      const guard = guardProtected(input);
      if (guard) return fail(`Error: ${guard}`);
      try {
        const result = await callStudio<MutateResult>("mutate_instances", input);
        const okCount = result.results.filter((r) => r.ok).length;
        const lines = [
          `# Mutation results (${okCount}/${result.results.length} succeeded)`,
          "",
          ...result.results.map(
            (r) =>
              `${r.ok ? "✅" : "❌"} ${r.action} ` +
              `${r.resultPath ?? r.path ?? ""}` +
              (r.error ? ` — ${r.error}` : ""),
          ),
        ];
        return ok(result as unknown as Record<string, unknown>, lines.join("\n"));
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );
}
