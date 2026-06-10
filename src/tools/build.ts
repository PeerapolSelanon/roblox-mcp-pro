/**
 * Building tools: manage_physics, manage_assets, manage_scripts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InstancePath } from "../schemas/common.js";
import { forwardTool } from "./_forward.js";
import { callStudio, describeError } from "../services/studio.js";
import { ok, fail } from "../services/format.js";

const Physics = z
  .object({
    action: z.enum(["set", "weld"]).describe("set physical properties on a part, or weld two parts."),
    path: InstancePath.optional().describe("Target BasePart for 'set'."),
    properties: z
      .record(z.unknown())
      .optional()
      .describe("For 'set': e.g. { Anchored: false, CanCollide: true, Massless: false }."),
    physical_properties: z
      .object({
        density: z.number().optional(),
        friction: z.number().optional(),
        elasticity: z.number().optional(),
        frictionWeight: z.number().optional(),
        elasticityWeight: z.number().optional(),
      })
      .optional()
      .describe("For 'set': CustomPhysicalProperties values."),
    part0: InstancePath.optional().describe("For 'weld': first BasePart."),
    part1: InstancePath.optional().describe("For 'weld': second BasePart (welded to part0)."),
  })
  .strict();

const Assets = z
  .object({
    action: z
      .enum(["search", "insert", "info"])
      .describe("search the marketplace by keyword, insert an asset into the place, or fetch its product info."),
    asset_id: z
      .union([z.string(), z.number()])
      .optional()
      .describe("For 'insert'/'info': catalog/asset id (number)."),
    parent: InstancePath.optional().describe("For 'insert': parent (default 'Workspace')."),
    keyword: z.string().max(200).optional().describe("For 'search': what to look for, e.g. 'low poly tree'."),
    category: z
      .enum(["models", "audio", "decals", "meshes"])
      .default("models")
      .describe("For 'search': asset category."),
    limit: z.number().int().min(1).max(30).default(10).describe("For 'search': max results."),
  })
  .strict();

/** Toolbox (Studio marketplace) category ids used by the toolbox-service API. */
const TOOLBOX_CATEGORY_IDS: Record<string, number> = {
  models: 10,
  audio: 9,
  decals: 13,
  meshes: 40,
};

interface ToolboxSearchItem {
  id: number;
  name: string;
  creator: string;
}

/**
 * Search the public Studio toolbox. This is the same (unauthenticated) API the
 * Studio Toolbox uses; it is not Open Cloud, so treat schema drift as a
 * recoverable tool error rather than a crash.
 */
async function searchToolbox(keyword: string, category: string, limit: number): Promise<ToolboxSearchItem[]> {
  const categoryId = TOOLBOX_CATEGORY_IDS[category] ?? 10;
  const searchUrl =
    `https://apis.roblox.com/toolbox-service/v1/marketplace/${categoryId}` +
    `?keyword=${encodeURIComponent(keyword)}&limit=${limit}`;
  const searchRes = await fetch(searchUrl, { headers: { Accept: "application/json" } });
  if (!searchRes.ok) {
    throw new Error(`toolbox search failed: HTTP ${searchRes.status}`);
  }
  const searchBody = (await searchRes.json()) as { data?: { id?: number }[] };
  const ids = (searchBody.data ?? [])
    .map((item) => item.id)
    .filter((id): id is number => typeof id === "number")
    .slice(0, limit);
  if (ids.length === 0) return [];

  const detailsUrl = `https://apis.roblox.com/toolbox-service/v1/items/details?assetIds=${ids.join(",")}`;
  const detailsRes = await fetch(detailsUrl, { headers: { Accept: "application/json" } });
  if (!detailsRes.ok) {
    // Details are a nicety; return bare ids rather than failing the search.
    return ids.map((id) => ({ id, name: `asset ${id}`, creator: "" }));
  }
  const detailsBody = (await detailsRes.json()) as {
    data?: { asset?: { id?: number; name?: string }; creator?: { name?: string } }[];
  };
  const byId = new Map<number, ToolboxSearchItem>();
  for (const entry of detailsBody.data ?? []) {
    const id = entry.asset?.id;
    if (typeof id === "number") {
      byId.set(id, { id, name: entry.asset?.name ?? `asset ${id}`, creator: entry.creator?.name ?? "" });
    }
  }
  return ids.map((id) => byId.get(id) ?? { id, name: `asset ${id}`, creator: "" });
}

const Properties = z
  .object({
    action: z.enum(["get", "set"]).describe("Read or write properties on any instance."),
    path: InstancePath.describe("Target instance."),
    names: z
      .array(z.string())
      .max(100)
      .optional()
      .describe("For 'get': specific property names (omit for a curated default set)."),
    properties: z.record(z.unknown()).optional().describe("For 'set': property map to apply."),
  })
  .strict();

const Scripts = z
  .object({
    action: z.enum(["get_source", "set_source", "create"]).describe("Read/write script source, or create a script."),
    path: InstancePath.optional().describe("Existing script for get_source/set_source."),
    source: z.string().max(200_000).optional().describe("Luau source for set_source/create."),
    class_name: z
      .enum(["Script", "LocalScript", "ModuleScript"])
      .optional()
      .describe("For 'create' (default ModuleScript)."),
    parent: InstancePath.optional().describe("For 'create': parent path."),
    name: z.string().max(200).optional().describe("For 'create': script name."),
  })
  .strict();

const mut = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerBuildTools(server: McpServer): void {
  forwardTool(server, "manage_properties", {
    title: "Manage Properties",
    description:
      "Read or write properties on any instance.\n" +
      "Args: action ('get'|'set'), path, names? (for get), properties? (for set).\n" +
      "Returns: { ok, path, properties?, error? }.\n" +
      "Example: action: 'set', path: 'Workspace.Sign', properties: { Material: 'Neon', Color: [1,0,0] }.",
    inputSchema: Properties.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  });

  forwardTool(server, "manage_physics", {
    title: "Manage Physics",
    description:
      "Set physical properties on parts or weld parts together.\n" +
      "Args: action ('set'|'weld'), path?, properties?, physical_properties?, part0?, part1?.\n" +
      "Returns: { ok, path?, error? }.\n" +
      "Example: action: 'set', path: 'Workspace.Crate', properties: { Anchored: false },\n" +
      "  physical_properties: { density: 2, friction: 0.4 }.",
    inputSchema: Physics.shape,
    annotations: mut,
  });

  server.registerTool(
    "manage_assets",
    {
      title: "Manage Assets",
      description:
        "Search the marketplace by keyword, insert assets by id (InsertService), or read product info.\n" +
        "Args: action ('search'|'insert'|'info'), keyword?+category?+limit? (search), asset_id?+parent? (insert/info).\n" +
        "Returns: search -> { ok, results: [{ id, name, creator }] }; insert -> { ok, inserted?: string[] }; info -> { ok, info }.\n" +
        "Example: action: 'search', keyword: 'low poly tree' -> pick an id -> action: 'insert', asset_id: <id>.",
      inputSchema: Assets.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const args = Assets.parse(input);
        if (args.action === "search") {
          if (!args.keyword) return fail("'search' requires keyword.");
          // Search runs server-side: the plugin can't call roblox.com domains.
          const results = await searchToolbox(args.keyword, args.category, args.limit);
          const structured = { ok: true, count: results.length, results };
          return ok(structured, JSON.stringify(structured));
        }
        if (args.asset_id === undefined) return fail(`'${args.action}' requires asset_id.`);
        const result = await callStudio<Record<string, unknown>>("manage_assets", {
          action: args.action,
          asset_id: args.asset_id,
          parent: args.parent,
        });
        return ok(result, JSON.stringify(result));
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  forwardTool(server, "manage_scripts", {
    title: "Manage Scripts",
    description:
      "Read or write a script's source, or create a new script.\n" +
      "Args: action ('get_source'|'set_source'|'create'), path?, source?, class_name?, parent?, name?.\n" +
      "Returns: { ok, path?, source?, error? }.\n" +
      "Example: action: 'create', class_name: 'ModuleScript', parent: 'ReplicatedStorage',\n" +
      "  name: 'Util', source: 'return {}'.",
    inputSchema: Scripts.shape,
    annotations: read,
  });
}
