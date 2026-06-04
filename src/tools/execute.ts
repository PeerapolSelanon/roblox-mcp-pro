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
      description: `Run a Luau script inside the connected Roblox Studio session and capture its output.

The code runs with full plugin privileges in Studio's command context. Anything printed
(via print/warn) is captured as 'output'. To return data, end with \`return <value>\`.

Args:
  - code (string): Luau source to run. Example: \`return workspace:GetChildren()[1].Name\`
  - timeout_ms (number): Abort after this many ms (100-60000, default 5000)

Returns (structured):
  {
    "ok": boolean,        // true if the script ran without raising an error
    "returns": any[],     // serialized return values
    "output": string,     // captured print/warn output
    "error"?: string      // error message + traceback when ok is false
  }

Examples:
  - Use when: "What is the Name of the first child of Workspace?" -> code: "return workspace:GetChildren()[1].Name"
  - Use when: you need a one-off computation or inspection not covered by a dedicated tool.
  - Don't use when: a structured tool exists (prefer query_instances / mutate_instances for
    reading and editing instances — they return cleaner, safer data).

Error Handling:
  - Returns ok=false with the Luau traceback if the script errors.
  - Returns "Error: Roblox Studio plugin is not connected…" if no Studio session is attached.`,
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
  if (result.output) parts.push("Output:\n" + result.output);
  if (result.returns.length > 0) {
    parts.push("Returned:\n" + JSON.stringify(result.returns, null, 2));
  }
  if (parts.length === 0) parts.push("Script ran successfully (no output or return value).");
  return parts.join("\n\n");
}
