/**
 * query_instances + mutate_instances — read and edit the Studio DataModel.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callStudio, describeError } from "../services/studio.js";
import { ok, fail, summarizeOps } from "../services/format.js";
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
    props: z
      .array(z.string().min(1))
      .max(40)
      .optional()
      .describe(
        "Field projection: read only these property names (implies " +
          "include_properties). Fewer props = fewer tokens. Default reads a common set.",
      ),
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
      .enum(["create", "set_properties", "rename", "reparent", "delete", "clone", "duplicate"])
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
    count: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("For 'duplicate': number of copies (default 1)."),
    offset: z
      .array(z.number())
      .length(3)
      .optional()
      .describe(
        "For 'duplicate': [x,y,z] studs between consecutive copies — copy i sits at " +
          "source pivot + offset*i. Great for rows/grids without N separate calls.",
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
  resultPaths?: string[];
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
      description:
        "Search the DataModel; return matching instances. For a broad map prefer scene_overview; " +
        "for one instance's full detail prefer describe_instance.\n" +
        "Args: path (default 'game'), class_name? (exact), name? (substring), recursive (default true), " +
        "include_properties (default false), props? (only these properties), limit/offset (default 100/0).\n" +
        "Returns: { total, instances:[{path,name,className,childCount,properties?}] }.",
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
      description:
        "Create/edit/move/clone/delete instances; ops run in order, each reports its own result.\n" +
        "Args: operations:[{action:create|set_properties|rename|reparent|delete|clone|duplicate, path?, " +
        "class_name?, name?, parent?, properties?, count?, offset?}]. create=class_name+parent; " +
        "set_properties=path+properties; rename=path+name; reparent=path+parent; delete=path; " +
        "clone=path(+parent,name); duplicate=path+count+offset (N spaced copies, e.g. a fence row). " +
        "Property values accept primitives, [x,y,z] arrays, and color names. Paths accept a sibling " +
        "index for duplicate names: 'Workspace.Part[2]' = second child named Part.\n" +
        "Returns: { ok, failedCount, firstError?, results:[{ok,action,path?,resultPath?,resultPaths?,error?}] } — top-level ok is true only if every op succeeded, so a partial failure is visible without scanning results. Refuses to mutate protected services.",
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
        const summary = summarizeOps(result.results);
        const okCount = result.results.length - summary.failedCount;
        const lines = [
          `# Mutation results (${okCount}/${result.results.length} succeeded)`,
          "",
          ...result.results.map(
            (r) =>
              `${r.ok ? "✅" : "❌"} ${r.action} ` +
              `${r.resultPath ?? (r.resultPaths ? `${r.resultPaths.length} copies (${r.resultPaths[0]} …)` : null) ?? r.path ?? ""}` +
              (r.error ? ` — ${r.error}` : ""),
          ),
        ];
        return ok({ ...summary, results: result.results }, lines.join("\n"));
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );
}
