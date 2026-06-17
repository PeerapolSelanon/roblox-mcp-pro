/**
 * execute_luau — run arbitrary Luau inside the connected Studio session.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callStudio, describeError } from "../services/studio.js";
import { ok, fail } from "../services/format.js";

const InputSchema = z
  .object({
    code: z
      .string()
      .min(1, "code must not be empty")
      .max(100_000, "code must not exceed 100,000 characters")
      .describe(
        "Luau source to execute in Studio. Use `return <expr>` to send a value " +
          "back; the returned value(s) are serialized into the result.",
      ),
    timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(5_000)
      .describe("Max execution time in Studio before aborting (default 5000)."),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface ExecuteResult {
  ok: boolean;
  returns: unknown[];
  output: string;
  error?: string;
}

export function registerExecuteTools(server: McpServer): void {
  server.registerTool(
    "execute_luau",
    {
      title: "Execute Luau in Studio",
      description:
        "Run Luau in the connected Studio session and capture output. Full plugin privileges; " +
        "print/warn is captured as 'output'; end with `return <value>` to send data back.\n" +
        "Args: code (Luau source), timeout_ms (100-60000, default 5000).\n" +
        "Returns: { ok, returns:any[], output:string, error? } (ok=false carries the traceback).\n" +
        "Prefer query_instances/mutate_instances/describe_instance for plain reads & edits.",
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
        const result = await callStudio<ExecuteResult>("execute_luau", input);
        const text = result.ok
          ? renderSuccess(result)
          : `Script raised an error:\n${result.error ?? "(no message)"}` +
            (result.output ? `\n\nOutput before error:\n${result.output}` : "");
        return ok(result as unknown as Record<string, unknown>, text);
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );
}

function renderSuccess(result: ExecuteResult): string {
  const parts: string[] = [];
  if (result.output) parts.push(`Output:\n${result.output}`);
  if (result.returns.length > 0) {
    // Compact JSON — pretty-printing return values just burns tokens.
    parts.push(`Returned: ${JSON.stringify(result.returns)}`);
  }
  if (parts.length === 0) parts.push("Script ran successfully (no output or return value).");
  return parts.join("\n\n");
}
