/**
 * scene_overview + describe_instance — high-leverage read tools that collapse
 * many query_instances round-trips into one call (powerful + token-cheap).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { forwardTool } from "./_forward.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function registerOverviewTools(server: McpServer): void {
  forwardTool(server, "scene_overview", {
    title: "Scene Overview",
    description:
      "One-call map of the DataModel — use instead of many query_instances when orienting. " +
      "Returns a class histogram (count of every ClassName under `path`) plus a shallow, " +
      "breadth-capped tree.\n" +
      "Args: path (default 'game'), depth (default 2), max_per_level (default 50).\n" +
      "Returns: { total, classCounts:{Class:n}, tree:{name,class,n,children?,more?} }.",
    inputSchema: z
      .object({
        path: z.string().default("game").describe("Root to summarize (default 'game')."),
        depth: z.number().int().min(0).max(5).default(2).describe("Tree depth (default 2)."),
        max_per_level: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe("Max children listed per node (default 50)."),
      })
      .strict().shape,
    annotations: READ_ONLY,
  });

  forwardTool(server, "describe_instance", {
    title: "Describe Instance",
    description:
      "Everything about one instance in a single call: properties + children + ancestry " +
      "(replaces separate query/property/parent calls).\n" +
      "Args: path (required), props (string[] projection — read only these, optional), " +
      "children (bool, default true), max_children (default 100).\n" +
      "Returns: { path,name,className,childCount,properties,ancestors:[{name,class}]," +
      "children?:[{name,class,n}],moreChildren? }.",
    inputSchema: z
      .object({
        path: z.string().min(1).describe("Instance path (required)."),
        props: z
          .array(z.string().min(1))
          .max(40)
          .optional()
          .describe("Read only these properties (projection); omit for a common set."),
        children: z.boolean().default(true).describe("Include the child list (default true)."),
        max_children: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100)
          .describe("Max children listed (default 100)."),
      })
      .strict().shape,
    annotations: READ_ONLY,
  });
}
