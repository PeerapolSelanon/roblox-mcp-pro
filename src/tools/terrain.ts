/**
 * manage_terrain — generate and edit Workspace.Terrain.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callStudio, describeError } from "../services/studio.js";
import { ok, fail } from "../services/format.js";

const Vec3 = z.array(z.number()).length(3).describe("A 3-number [x, y, z] vector.");

const InputSchema = z
  .object({
    action: z
      .enum([
        "fill_block",
        "fill_ball",
        "fill_region",
        "fill_cylinder",
        "fill_wedge",
        "replace_material",
        "smooth",
        "generate",
        "clear",
      ])
      .describe(
        "fill_block: box · fill_ball: sphere · fill_region: axis-aligned region · " +
          "fill_cylinder: vertical cylinder · fill_wedge: ramp/slope · " +
          "replace_material: swap one material for another in a region · " +
          "smooth: soften blocky edges in a region · " +
          "generate: procedural noise heightmap terrain · clear: wipe all terrain.",
      ),
    material: z
      .string()
      .max(50)
      .optional()
      .describe("Enum.Material name, e.g. 'Grass', 'Rock', 'Water', 'Sand' (default 'Grass')."),
    position: Vec3.optional().describe("Center for fill_block/fill_cylinder/fill_wedge/generate."),
    size: Vec3.optional().describe(
      "Size for fill_block/fill_wedge (default [16,16,16]); area for generate ([w, _, d], max 512).",
    ),
    center: Vec3.optional().describe("Center for fill_ball."),
    radius: z.number().positive().optional().describe("Radius for fill_ball/fill_cylinder (default 8)."),
    height: z.number().positive().optional().describe("Height for fill_cylinder (default 8)."),
    rotation: Vec3.optional().describe("fill_wedge: [x,y,z] rotation in degrees (slope direction)."),
    min: Vec3.optional().describe("Minimum corner for fill_region/replace_material/smooth."),
    max: Vec3.optional().describe("Maximum corner for fill_region/replace_material/smooth (smooth max 128/axis)."),
    from_material: z
      .string()
      .max(50)
      .optional()
      .describe("replace_material: the material to replace (material = what it becomes)."),
    strength: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("smooth: blend strength 0..1 (default 0.5)."),
    amplitude: z.number().positive().optional().describe("generate: max hill height in studs (default 16)."),
    noise_scale: z
      .number()
      .positive()
      .optional()
      .describe("generate: noise wavelength in studs — bigger = smoother hills (default 64)."),
    seed: z.number().optional().describe("generate: noise seed (default 0)."),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

export function registerTerrainTools(server: McpServer): void {
  server.registerTool(
    "manage_terrain",
    {
      title: "Manage Workspace Terrain",
      description: `Generate or edit voxel terrain in Workspace.Terrain.

Args:
  - action ('fill_block'|'fill_ball'|'fill_region'|'fill_cylinder'|'fill_wedge'|'replace_material'|'smooth'|'generate'|'clear').
  - material (string): Enum.Material name (default 'Grass').
  - position + size: fill_block/fill_wedge (+rotation degrees for wedge slope) · position+radius+height: fill_cylinder.
  - center + radius: fill_ball.
  - min + max: fill_region / replace_material (+from_material) / smooth (+strength 0..1).
  - position + size + amplitude + noise_scale + seed: generate (procedural hills).

Returns (structured):
  { "ok": boolean, "action": string, "error"?: string }

Examples:
  - A grass platform: action: "fill_block", position: [0,0,0], size: [64,4,64], material: "Grass"
  - Rolling hills: action: "generate", position: [0,0,0], size: [256,0,256], amplitude: 24, material: "Grass"
  - A ramp: action: "fill_wedge", position: [0,8,0], size: [16,16,32], rotation: [0,90,0]
  - Sand beach from grass: action: "replace_material", min: [-64,-4,-64], max: [64,8,64], from_material: "Grass", material: "Sand"
  - Soften edges: action: "smooth", min: [-32,0,-32], max: [32,32,32], strength: 0.6

Error Handling:
  - Returns "Error: …not connected" if no Studio session is attached.
  - Returns ok=false for an unknown action.`,
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
        const result = await callStudio<{ ok: boolean; action: string; error?: string }>(
          "manage_terrain",
          input,
        );
        const text = result.ok
          ? `Terrain ${result.action} applied.`
          : `Terrain ${result.action} failed: ${result.error ?? "unknown"}`;
        return ok(result as unknown as Record<string, unknown>, text);
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );
}
