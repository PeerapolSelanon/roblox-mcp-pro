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
      .enum(["fill_block", "fill_ball", "fill_region", "clear", "set_material"])
      .describe(
        "fill_block: box of terrain · fill_ball: sphere · fill_region: axis-aligned region · clear: wipe all terrain.",
      ),
    material: z
      .string()
      .max(50)
      .optional()
      .describe("Enum.Material name, e.g. 'Grass', 'Rock', 'Water', 'Sand' (default 'Grass')."),
    position: Vec3.optional().describe("Center for fill_block."),
    size: Vec3.optional().describe("Size for fill_block (default [16,16,16])."),
    center: Vec3.optional().describe("Center for fill_ball."),
    radius: z.number().positive().optional().describe("Radius for fill_ball (default 8)."),
    min: Vec3.optional().describe("Minimum corner for fill_region."),
    max: Vec3.optional().describe("Maximum corner for fill_region."),
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
  - action ('fill_block'|'fill_ball'|'fill_region'|'clear'): operation.
  - material (string): Enum.Material name (default 'Grass').
  - position + size (number[3]): for fill_block.
  - center + radius: for fill_ball.
  - min + max (number[3]): for fill_region.

Returns (structured):
  { "ok": boolean, "action": string, "error"?: string }

Examples:
  - A grass platform: action: "fill_block", position: [0,0,0], size: [64,4,64], material: "Grass"
  - A rock boulder: action: "fill_ball", center: [0,10,0], radius: 12, material: "Rock"
  - Wipe terrain: action: "clear"

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
