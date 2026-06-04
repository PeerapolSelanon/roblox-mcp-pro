/**
 * Helper for the many tools whose only job is to validate input and forward it
 * to the matching Studio handler, returning the structured result.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import { callStudio, describeError } from "../services/studio.js";
import { ok, fail } from "../services/format.js";

interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export function forwardTool(
  server: McpServer,
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: ZodRawShape;
    annotations: ToolAnnotations;
  },
): void {
  server.registerTool(name, config, async (input: Record<string, unknown>) => {
    try {
      const result = await callStudio<Record<string, unknown>>(name, input);
      return ok(result, JSON.stringify(result, null, 2));
    } catch (error) {
      return fail(describeError(error));
    }
  });
}
