/**
 * Helper for the many tools whose only job is to validate input and forward it
 * to the matching Studio handler, returning the structured result.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import { callStudio, describeError } from "../services/studio.js";
import { ok, fail } from "../services/format.js";

interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * Accepted synonyms for canonical field names. Agents sometimes guess a
 * plausible alias; rather than hard-fail on a misnamed key we accept these and
 * normalize them. Aliases are only added to a tool's schema when its canonical
 * field exists, so unrelated tools stay clean.
 */
const ALIASES: Record<string, string[]> = {
  path: ["instance", "target", "instancePath", "instance_path"],
  parent: ["parentPath", "parent_path"],
  class_name: ["className", "class"],
};

/** Add alias fields to a shape, but only where the canonical field is present. */
function shapeWithAliases(shape: ZodRawShape): ZodRawShape {
  const out: ZodRawShape = { ...shape };
  for (const [canonical, aliases] of Object.entries(ALIASES)) {
    if (!(canonical in shape)) continue;
    for (const alias of aliases) {
      if (!(alias in out)) {
        out[alias] = z.unknown().optional().describe(`Alias for '${canonical}'.`);
      }
    }
  }
  return out;
}

/** Fold any alias keys onto their canonical field (canonical wins if both set). */
function normalizeAliases(input: Record<string, unknown>): Record<string, unknown> {
  for (const [canonical, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases) {
      if (alias in input) {
        if (input[canonical] === undefined && input[alias] !== undefined) {
          input[canonical] = input[alias];
        }
        delete input[alias];
      }
    }
  }
  return input;
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
  const withAliases = { ...config, inputSchema: shapeWithAliases(config.inputSchema) };
  server.registerTool(name, withAliases, async (input: Record<string, unknown>) => {
    try {
      const result = await callStudio<Record<string, unknown>>(name, normalizeAliases(input));
      // Compact JSON (not pretty-printed) — the agent reads this text, so the
      // indentation/newlines of a pretty dump are pure wasted tokens. The full
      // typed object still rides along in structuredContent for clients that use it.
      return ok(result, JSON.stringify(result));
    } catch (error) {
      return fail(describeError(error));
    }
  });
}
