/**
 * Building tools: manage_physics, manage_assets, manage_scripts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InstancePath } from "../schemas/common.js";
import { forwardTool } from "./_forward.js";

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
    action: z.enum(["insert", "info"]).describe("insert an asset into the place, or fetch its product info."),
    asset_id: z.union([z.string(), z.number()]).describe("Catalog/asset id (number)."),
    parent: InstancePath.optional().describe("For 'insert': parent (default 'Workspace')."),
  })
  .strict();

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

  forwardTool(server, "manage_assets", {
    title: "Manage Assets",
    description:
      "Insert marketplace assets by id (InsertService) or read product info.\n" +
      "Args: action ('insert'|'info'), asset_id, parent?.\n" +
      "Returns: { ok, inserted?: string[], info?, error? }.\n" +
      "Example: action: 'insert', asset_id: 30738740, parent: 'Workspace'.",
    inputSchema: Assets.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  });

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
