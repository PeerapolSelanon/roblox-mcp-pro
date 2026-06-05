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
      "Class histogram + shallow tree; duplicate leaf children are collapsed (Tile x50 -> one " +
      "entry with count). At 'game' it scopes to user services unless include_internal.\n" +
      "Args: path (default 'game'), depth (default 2), max_per_level (default 50), include_internal (default false).\n" +
      "Returns: { total, classCounts:{Class:n}, tree:{name,class,n,children?,count?,more?,scoped?} }.",
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
          .describe("Max distinct child groups per node (default 50)."),
        include_internal: z
          .boolean()
          .default(false)
          .describe("At 'game', include internal Studio services (default false = user services only)."),
      })
      .strict().shape,
    annotations: READ_ONLY,
  });

  forwardTool(server, "find_instances", {
    title: "Find Instances",
    description:
      "Targeted search with combined filters; returns a compact grouped result by default " +
      "(collapses matches by parent+class with a count + sample) — far cheaper than dumping every match.\n" +
      "Args: path (root, default 'game'), class_name?, name? (substring), name_pattern? (Lua pattern), " +
      "tag? (CollectionService), match_props? ({Prop:value}, e.g. {Anchored:false} or {Material:'Neon'}), " +
      "recursive (default true), mode (grouped[default]|count|paths|full), limit (default 200), props? (full mode projection).\n" +
      "Returns by mode: grouped {total,groups:[{parent,class,count,sample}]} · count {total,byClass} · " +
      "paths {total,paths[]} · full {total,instances:[{path,name,className,properties}]}.",
    inputSchema: z
      .object({
        path: z.string().default("game").describe("Root to search under (default 'game')."),
        class_name: z.string().max(100).optional().describe("Exact ClassName filter."),
        name: z.string().max(200).optional().describe("Name substring filter."),
        name_pattern: z.string().max(200).optional().describe("Lua pattern matched against Name."),
        tag: z.string().max(100).optional().describe("CollectionService tag the instance must have."),
        match_props: z
          .record(z.unknown())
          .optional()
          .describe("Property predicates all matches must satisfy, e.g. {Anchored:false}."),
        recursive: z.boolean().default(true).describe("Search descendants (default true)."),
        mode: z
          .enum(["grouped", "count", "paths", "full"])
          .default("grouped")
          .describe("Result shape (default grouped)."),
        limit: z.number().int().min(1).max(1000).default(200).describe("Max entries (default 200)."),
        props: z
          .array(z.string().min(1))
          .max(40)
          .optional()
          .describe("For mode 'full': property projection."),
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
