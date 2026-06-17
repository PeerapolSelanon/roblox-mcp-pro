/**
 * Building tools: manage_physics, manage_assets, manage_scripts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InstancePath } from "../schemas/common.js";
import { forwardTool } from "./_forward.js";
import { callStudio, describeError } from "../services/studio.js";
import { ok, fail } from "../services/format.js";
import { analyzeSource } from "../services/analyze.js";

const Physics = z
  .object({
    action: z
      .enum([
        "set",
        "weld",
        "register_group",
        "assign_group",
        "set_collidable",
        "get_groups",
      ])
      .describe(
        "set physical properties on a part · weld two parts · collision groups: " +
          "register_group (create), assign_group (put a part/subtree in a group), " +
          "set_collidable (whether two groups collide), get_groups (list + matrix).",
      ),
    path: InstancePath.optional().describe("Target BasePart for 'set'/'assign_group'."),
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
    group: z
      .string()
      .max(100)
      .optional()
      .describe("Collision group name for register_group/assign_group/set_collidable."),
    other_group: z
      .string()
      .max(100)
      .optional()
      .describe("For 'set_collidable': the second group (pair with `group`)."),
    collidable: z
      .boolean()
      .optional()
      .describe("For 'set_collidable': should the two groups collide (default true)."),
    recursive: z
      .boolean()
      .optional()
      .describe("For 'assign_group': also assign every BasePart descendant (default false)."),
  })
  .strict();

const Assets = z
  .object({
    action: z
      .enum(["search", "insert", "info", "search_insert"])
      .describe(
        "search the marketplace by keyword, insert an asset into the place, fetch its product info, " +
          "or search_insert (search and insert the top result in one call).",
      ),
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
    action: z
      .enum([
        "get",
        "set",
        "get_attributes",
        "set_attributes",
        "remove_attributes",
        "get_tags",
        "add_tags",
        "remove_tags",
        "get_tagged",
        "mass_get",
        "mass_set",
        "modify_children",
        "set_relative",
      ])
      .describe(
        "Read/write properties, attributes, CollectionService tags; bulk ops " +
          "(mass_get/mass_set many paths, modify_children = one map onto matching children); " +
          "set_relative = current*scale+delta without reading first.",
      ),
    path: InstancePath.optional().describe("Target instance (not used by get_tagged/mass_*)."),
    paths: z
      .array(InstancePath)
      .max(200)
      .optional()
      .describe("For 'mass_get'/'mass_set': target instances."),
    names: z
      .array(z.string())
      .max(100)
      .optional()
      .describe("For 'get'/'mass_get': specific property names. For 'remove_attributes': attribute names."),
    properties: z
      .record(z.unknown())
      .optional()
      .describe("For 'set'/'mass_set'/'modify_children': property map to apply."),
    class_name: z
      .string()
      .max(100)
      .optional()
      .describe("For 'modify_children': only children matching this class (IsA, so 'BasePart' works)."),
    name: z.string().max(200).optional().describe("For 'modify_children': only children whose Name contains this."),
    recursive: z.boolean().optional().describe("For 'modify_children': include all descendants (default false)."),
    property: z.string().max(100).optional().describe("For 'set_relative': the property to adjust."),
    delta: z
      .union([z.number(), z.array(z.number()).length(3)])
      .optional()
      .describe("For 'set_relative': amount to add (number, or [x,y,z] for Vector3 properties)."),
    scale: z.number().optional().describe("For 'set_relative': multiplier applied before delta (default 1)."),
    attributes: z
      .record(z.unknown())
      .optional()
      .describe(
        "For 'set_attributes': name -> value map. [x,y,z] arrays become Vector3; " +
          "{r,g,b} (0..1) becomes Color3.",
      ),
    tags: z.array(z.string().min(1)).max(50).optional().describe("For 'add_tags'/'remove_tags'."),
    tag: z.string().max(100).optional().describe("For 'get_tagged': the tag to look up."),
    limit: z.number().int().min(1).max(500).optional().describe("For 'get_tagged': max results (default 100)."),
  })
  .strict();

const Scripts = z
  .object({
    action: z
      .enum([
        "get_source",
        "set_source",
        "create",
        "delete",
        "edit_replace",
        "edit_insert",
        "edit_delete",
        "search",
        "replace",
        "get_dependencies",
        "analyze",
      ])
      .describe(
        "get_source/set_source/create/delete a script, surgical line edits " +
          "(edit_replace/edit_insert/edit_delete), search scripts, find/replace in one script, " +
          "get_dependencies (static require() scan), or analyze (static Luau check for syntax/type " +
          "errors before a playtest).",
      ),
    path: InstancePath.optional().describe(
      "Target script. For 'search': optional root to search under (default 'game').",
    ),
    source: z.string().max(200_000).optional().describe("Luau source for set_source/create."),
    class_name: z
      .enum(["Script", "LocalScript", "ModuleScript"])
      .optional()
      .describe("For 'create' (default ModuleScript)."),
    parent: InstancePath.optional().describe("For 'create': parent path."),
    name: z.string().max(200).optional().describe("For 'create': script name."),
    start_line: z.number().int().min(1).optional().describe(
      "1-based inclusive start line for get_source (slice), edit_replace, edit_delete.",
    ),
    end_line: z.number().int().min(1).optional().describe(
      "1-based inclusive end line for get_source (slice), edit_replace, edit_delete.",
    ),
    new_content: z.string().max(200_000).optional().describe(
      "For 'edit_replace': content replacing the start_line..end_line range (may be multi-line).",
    ),
    after_line: z.number().int().min(0).optional().describe(
      "For 'edit_insert': insert after this line (0 = top of file).",
    ),
    content: z.string().max(200_000).optional().describe("For 'edit_insert': content to insert."),
    pattern: z.string().max(500).optional().describe(
      "For 'search'/'replace': plain text by default; Lua pattern when lua_pattern is true.",
    ),
    replacement: z.string().max(10_000).optional().describe("For 'replace': replacement text."),
    case_sensitive: z.boolean().optional().describe("For 'search': default false."),
    lua_pattern: z.boolean().optional().describe("Treat pattern as a Lua pattern (default false)."),
    max_results: z.number().int().min(1).max(500).optional().describe("For 'search': cap matches (default 100)."),
    dry_run: z.boolean().optional().describe("For 'replace': count matches without writing."),
  })
  .strict();

const mut = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export function registerBuildTools(server: McpServer): void {
  forwardTool(server, "manage_properties", {
    title: "Manage Properties",
    description:
      "Read/write properties, attributes, and CollectionService tags — single, bulk, or relative.\n" +
      "Args: action ('get'|'set'|'get_attributes'|'set_attributes'|'remove_attributes'|'get_tags'|" +
      "'add_tags'|'remove_tags'|'get_tagged'|'mass_get'|'mass_set'|'modify_children'|'set_relative'), " +
      "path | paths (mass_*), names?, properties?, attributes?, tags?, tag?, limit?, " +
      "class_name?/name?/recursive? (modify_children), property?/delta?/scale? (set_relative).\n" +
      "Returns: { ok, path?, properties?, attributes?, tags?, instances?, results?, applied?, error? }.\n" +
      "Examples: action: 'set_attributes', path: 'Workspace.Door', attributes: { Locked: true } ·\n" +
      "  action: 'modify_children', path: 'Workspace.Lights', class_name: 'PointLight', properties: { Brightness: 2 } ·\n" +
      "  action: 'set_relative', path: 'Workspace.Platform', property: 'Position', delta: [0,5,0] (raise 5 studs) ·\n" +
      "  action: 'get_tagged', tag: 'Checkpoint' -> every tagged instance with its path.",
    inputSchema: Properties.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  });

  forwardTool(server, "manage_physics", {
    title: "Manage Physics",
    description:
      "Set physical properties, weld parts, or manage collision groups (which parts pass through which).\n" +
      "Args: action ('set'|'weld'|'register_group'|'assign_group'|'set_collidable'|'get_groups'), " +
      "path?, properties?, physical_properties?, part0?/part1? (weld), group?/other_group?/collidable?/recursive? (groups).\n" +
      "Returns: { ok, path?, group?, groups?, matrix?, assigned?, error? }.\n" +
      "Collision-group flow: register_group {group:'Enemies'} -> assign_group {path:'Workspace.Mob', group:'Enemies', recursive:true} -> \n" +
      "  set_collidable {group:'Enemies', other_group:'Players', collidable:false} (enemies stop blocking players).",
    inputSchema: Physics.shape,
    annotations: mut,
  });

  server.registerTool(
    "manage_assets",
    {
      title: "Manage Assets",
      description:
        "Search the marketplace by keyword, insert assets by id (InsertService), or read product info.\n" +
        "Args: action ('search'|'insert'|'info'|'search_insert'), keyword?+category?+limit? (search/search_insert), " +
        "asset_id?+parent? (insert/info).\n" +
        "Returns: search -> { ok, results: [{ id, name, creator }] }; insert -> { ok, inserted?: string[] }; " +
        "info -> { ok, info }; search_insert -> insert result + { chosen, alternatives }.\n" +
        "Example: action: 'search_insert', keyword: 'low poly tree' inserts the top match in one call.",
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
        if (args.action === "search_insert") {
          if (!args.keyword) return fail("'search_insert' requires keyword.");
          const results = await searchToolbox(args.keyword, args.category, args.limit);
          const chosen = results[0];
          if (!chosen) return fail(`No assets found for '${args.keyword}'.`);
          const result = await callStudio<Record<string, unknown>>("manage_assets", {
            action: "insert",
            asset_id: chosen.id,
            parent: args.parent,
          });
          const structured = { ...result, chosen, alternatives: results.slice(1, 5) };
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

  server.registerTool(
    "manage_scripts",
    {
      title: "Manage Scripts",
      description:
        "Read, write, create, delete, surgically edit, search, and statically analyze script source. " +
        "Prefer the edit_* actions over rewriting whole files with set_source — fewer tokens, fewer mistakes.\n" +
        "Args: action ('get_source'|'set_source'|'create'|'delete'|'edit_replace'|'edit_insert'|" +
        "'edit_delete'|'search'|'replace'|'analyze'), plus per-action fields:\n" +
        "  get_source: path (+ start_line/end_line to read a slice; result includes lineCount)\n" +
        "  edit_replace: path, start_line, end_line, new_content · edit_insert: path, after_line (0=top), content\n" +
        "  edit_delete: path, start_line, end_line · search: pattern (+ path root default 'game', " +
        "case_sensitive?, lua_pattern?, max_results?) · replace: path, pattern, replacement (+ lua_pattern?, dry_run?) · " +
        "get_dependencies: path (static require() scan -> what this script depends on) · " +
        "analyze: path (static Luau check -> { ok, analyzer, errorCount, diagnostics:[{line,column,severity,message}] }; " +
        "run after editing to catch syntax/type errors before a playtest. Needs a Luau analyzer on PATH " +
        "(luau-lsp or luau-analyze); analyzer:'none' if none is installed.)\n" +
        "Returns: { ok, path?, source?, lineCount?, matches?, replacements?, dependencies?, diagnostics?, error? }.\n" +
        "Example: edit a script, then action: 'analyze', path: <it> -> fix any diagnostics before play.",
      inputSchema: Scripts.shape,
      annotations: mut,
    },
    async (input) => {
      try {
        const args = Scripts.parse(input);
        if (args.action === "analyze") {
          if (!args.path) return fail("'analyze' requires path.");
          const src = await callStudio<{ source?: string }>("manage_scripts", {
            action: "get_source",
            path: args.path,
          });
          if (typeof src.source !== "string") return fail(`No source at '${args.path}'.`);
          const { analyzer, diagnostics } = analyzeSource(src.source);
          const errorCount = diagnostics.filter((d) => d.severity === "error").length;
          const structured = {
            ok: errorCount === 0,
            path: args.path,
            analyzer,
            errorCount,
            diagnostics,
            ...(analyzer === "none"
              ? { hint: "No Luau analyzer found. Install luau-lsp or luau-analyze to enable static checks." }
              : {}),
          };
          return ok(structured, JSON.stringify(structured));
        }
        const result = await callStudio<Record<string, unknown>>("manage_scripts", args);
        return ok(result, JSON.stringify(result));
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );
}
