/**
 * manage_animation — manage Animation instances and best-effort preview.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callStudio, describeError } from "../services/studio.js";
import { ok, fail } from "../services/format.js";
import { InstancePath } from "../schemas/common.js";

const InputSchema = z
  .object({
    action: z
      .enum(["create", "set", "play"])
      .describe("create an Animation, set its properties, or play it on a rig's Animator."),
    parent: InstancePath.optional().describe("Parent for 'create' (default 'ReplicatedStorage')."),
    name: z.string().max(200).optional().describe("Name for the created Animation."),
    path: InstancePath.optional().describe("Existing Animation path for 'set'."),
    animation_id: z
      .string()
      .max(200)
      .optional()
      .describe("AnimationId, e.g. 'rbxassetid://507770453', for 'create'/'play'."),
    target_path: InstancePath.optional().describe(
      "For 'play': a model/Humanoid that has (or contains) an Animator.",
    ),
    properties: z.record(z.unknown()).optional().describe("Properties for 'set'."),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

export function registerAnimationTools(server: McpServer): void {
  server.registerTool(
    "manage_animation",
    {
      title: "Manage Animation",
      description: `Create and configure Animation instances, and attempt playback on a rig.

Args:
  - action ('create'|'set'|'play').
  - parent (string): for 'create' (default 'ReplicatedStorage').
  - name (string): for 'create'.
  - animation_id (string): rbxassetid for 'create'/'play'.
  - path (string): existing Animation for 'set'.
  - target_path (string): for 'play' — a rig with a Humanoid/Animator.
  - properties (object): for 'set'.

Returns (structured):
  { "ok": boolean, "path"?: string, "length"?: number, "note"?: string, "error"?: string }

Examples:
  - Store an animation: action: "create", name: "Wave", animation_id: "rbxassetid://507770453"
  - Try to preview: action: "play", animation_id: "rbxassetid://507770453",
      target_path: "Workspace.Dummy"

Error Handling:
  - Returns "Error: …not connected" if no Studio session is attached.
  - 'play' needs an Animator under target_path; visible preview may require Play mode.`,
      inputSchema: InputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input: Input) => {
      try {
        const result = await callStudio<Record<string, unknown>>("manage_animation", input);
        const text = result.ok
          ? `Animation ${input.action} ok${result.path ? `: ${String(result.path)}` : ""}` +
            (result.note ? `\n${String(result.note)}` : "")
          : `Animation ${input.action} failed: ${result.error ?? "unknown"}`;
        return ok(result, text);
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );
}
