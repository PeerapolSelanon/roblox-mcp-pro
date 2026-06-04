/**
 * batch_execute — run several Studio operations in one round-trip and one undo.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callStudio, describeError } from "../services/studio.js";
import { ok, fail } from "../services/format.js";

const SubOperation = z
  .object({
    tool: z
      .enum(["execute_luau", "query_instances", "mutate_instances", "spatial_query", "manage_terrain"])
      .describe("Which Studio tool to run for this step."),
    args: z.record(z.unknown()).describe("Arguments for that tool (same shape as calling it directly)."),
  })
  .strict();

const InputSchema = z
  .object({
    operations: z
      .array(SubOperation)
      .min(1, "Provide at least one operation")
      .max(200, "At most 200 operations per batch")
      .describe("Ordered steps executed in a single undo recording."),
    stop_on_error: z
      .boolean()
      .default(false)
      .describe("Stop the batch at the first failing operation (default false)."),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface BatchResult {
  results: { ok: boolean; result?: unknown; error?: string }[];
}

export function registerBatchTools(server: McpServer): void {
  server.registerTool(
    "batch_execute",
    {
      title: "Batch Execute Studio Operations",
      description: `Run many Studio operations in one call, grouped into a single undo step.

More efficient than separate calls and atomic for undo. Each step names a tool and its args.

Args:
  - operations (array): each { tool, args }. tool is one of execute_luau, query_instances,
    mutate_instances, spatial_query, manage_terrain.
  - stop_on_error (boolean): halt at first failure (default false).

Returns (structured):
  { "results": [ { "ok": boolean, "result"?: any, "error"?: string } ] }
  (results are positional, matching the operations array)

Examples:
  - Build a row of parts:
      operations: [
        { tool: "mutate_instances", args: { operations: [{ action: "create", class_name: "Part",
            parent: "Workspace", name: "P1" }] } },
        { tool: "mutate_instances", args: { operations: [{ action: "create", class_name: "Part",
            parent: "Workspace", name: "P2" }] } }
      ]

Error Handling:
  - Returns "Error: …not connected" if no Studio session is attached.
  - Per-step failures appear as ok=false with an 'error' string.`,
      inputSchema: InputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input: Input) => {
      try {
        const result = await callStudio<BatchResult>("batch_execute", input);
        const okCount = result.results.filter((r) => r.ok).length;
        const text =
          `# Batch: ${okCount}/${result.results.length} steps succeeded\n` +
          result.results
            .map((r, i) => `${r.ok ? "✅" : "❌"} step ${i + 1}${r.error ? ` — ${r.error}` : ""}`)
            .join("\n");
        return ok(result as unknown as Record<string, unknown>, text);
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );
}
