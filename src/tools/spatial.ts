/**
 * spatial_query — spatial searches over Workspace (box, radius, raycast, nearest).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callStudio, describeError } from "../services/studio.js";
import { ok, fail } from "../services/format.js";

const Vec3 = z
  .array(z.number())
  .length(3)
  .describe("A 3-number [x, y, z] vector.");

const InputSchema = z
  .object({
    query: z
      .enum([
        "in_box",
        "in_radius",
        "raycast",
        "nearest",
        "find_ground",
        "check_placement",
        "bounds",
        "find_flat",
        "analyze_walkable",
        "spatial_map",
      ])
      .describe(
        "in_box: parts within a box · in_radius: parts within a sphere · " +
          "raycast: first hit along a ray · nearest: closest BasePart to a point · " +
          "find_ground: walkable surface Y under a point · " +
          "check_placement: is a box-shaped spot free of colliding parts · " +
          "bounds: bounding box of a Model/Part · find_flat: flat build spots in a region · " +
          "analyze_walkable: how much of a region is walkable · spatial_map: part-density grid.",
      ),
    path: z
      .string()
      .max(500)
      .optional()
      .describe("For 'bounds': the Model or BasePart to measure."),
    step: z
      .number()
      .positive()
      .optional()
      .describe("find_flat/analyze_walkable: grid sample spacing in studs (default 8)."),
    tolerance: z
      .number()
      .positive()
      .optional()
      .describe("find_flat: max height difference vs neighbors to count as flat (default 1)."),
    max_slope: z
      .number()
      .positive()
      .optional()
      .describe("analyze_walkable: max walkable slope in degrees (default 45)."),
    cell: z
      .number()
      .positive()
      .optional()
      .describe("spatial_map: grid cell size in studs (default 16, grid capped at 32x32)."),
    center: Vec3.optional().describe("Center point for in_box / in_radius."),
    size: Vec3.optional().describe("Box size for in_box (default [10,10,10])."),
    radius: z.number().positive().optional().describe("Sphere radius for in_radius (default 10)."),
    origin: Vec3.optional().describe("Ray origin for raycast."),
    direction: Vec3.optional().describe("Ray direction+length for raycast (default [0,-100,0])."),
    point: Vec3.optional().describe("Reference point for nearest / find_ground."),
    from_height: z
      .number()
      .optional()
      .describe("find_ground: Y to cast down from (default max(point.y, 500))."),
    class_name: z.string().max(100).optional().describe("Restrict nearest to this ClassName."),
    max_distance: z.number().positive().optional().describe("Max distance for nearest."),
    limit: z.number().int().min(1).max(500).default(100).describe("Max parts returned."),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

export function registerSpatialTools(server: McpServer): void {
  server.registerTool(
    "spatial_query",
    {
      title: "Spatial Query Workspace",
      description: `Run spatial searches over Workspace geometry.

Args:
  - query ('in_box'|'in_radius'|'raycast'|'nearest'): the kind of search.
  - center/size (number[3]): for in_box.
  - center/radius: for in_radius.
  - origin/direction (number[3]): for raycast.
  - point/class_name/max_distance: for nearest; point (+from_height?) for find_ground.
  - center/size: for check_placement (is that box free of colliding parts?).
  - limit (number): cap on returned parts (default 100).

Returns (structured):
  - in_box/in_radius: { query, count, parts: [{ path, name, className, position, size }] }
  - raycast: { query, hit, instance?, position?, normal?, distance?, material? }
  - nearest: { query, found, instance?, distance?, position? }
  - find_ground: { query, found, groundY?, position?, normal?, material?, instance? }
  - check_placement: { query, clear, count, blocking: [parts] }
  - bounds: { query, ok, center, size, min, max }
  - find_flat: { query, sampled, found, spots: [{position:[x,y,z]}] }
  - analyze_walkable: { query, sampled, walkable, tooSteep, noGround, walkableRatio }
  - spatial_map: { query, cols, rows, cell, origin, grid: number[][] (part counts) }

Examples:
  - Parts near origin: query: "in_radius", center: [0,0,0], radius: 25
  - Where to stand something: query: "find_ground", point: [10,0,10] -> use groundY
  - Is the spot free: query: "check_placement", center: [10,5,10], size: [8,10,8]
  - Closest spawn: query: "nearest", point: [0,0,0], class_name: "SpawnLocation"

Error Handling:
  - Returns "Error: …not connected" if no Studio session is attached.
  - raycast returns hit=false / nearest returns found=false when nothing matches.`,
      inputSchema: InputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input: Input) => {
      try {
        const result = await callStudio<Record<string, unknown>>("spatial_query", input);
        return ok(result, JSON.stringify(result, null, 2));
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );
}
