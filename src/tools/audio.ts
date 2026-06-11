/**
 * manage_audio — create, configure, and preview Sound instances.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callStudio, describeError } from "../services/studio.js";
import { ok, fail } from "../services/format.js";
import { InstancePath } from "../schemas/common.js";

const InputSchema = z
  .object({
    action: z
      .enum(["create", "set", "play", "stop", "pause", "resume", "set_listener"])
      .describe(
        "create a Sound, set its properties, control playback (previewable in Studio), " +
          "or set_listener (aim where 3D audio is heard from).",
      ),
    parent: InstancePath.optional().describe("Parent for 'create' (default 'Workspace')."),
    name: z.string().max(200).optional().describe("Name for the created Sound."),
    path: InstancePath.optional().describe("Existing Sound for set/play/stop/pause/resume, or the part for an 'object' listener."),
    properties: z
      .record(z.unknown())
      .optional()
      .describe("Sound properties, e.g. { SoundId: 'rbxassetid://123', Volume: 0.5, Looped: true }."),
    listener: z
      .enum(["camera", "object"])
      .optional()
      .describe("For 'set_listener': hear from the camera, or from a part (give its path)."),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

export function registerAudioTools(server: McpServer): void {
  server.registerTool(
    "manage_audio",
    {
      title: "Manage Audio (Sound)",
      description: `Create, configure, and preview Sound instances in Studio.

Args:
  - action ('create'|'set'|'play'|'stop'|'pause'|'resume'|'set_listener').
  - parent (string): for 'create' (default 'Workspace').
  - name (string): for 'create'.
  - path (string): existing Sound for the other actions (or the part for an 'object' listener).
  - properties (object): SoundId, Volume, Looped, PlaybackSpeed, RollOffMaxDistance, …
  - listener ('camera'|'object'): for 'set_listener'.

Returns (structured):
  { "ok": boolean, "path"?: string, "isPlaying"?: boolean, "error"?: string }

Examples:
  - Add looping music: action: "create", parent: "Workspace", name: "Music",
      properties: { SoundId: "rbxassetid://1837849285", Volume: 0.4, Looped: true }
  - Preview it: action: "play", path: "Workspace.Music"

Error Handling:
  - Returns "Error: …not connected" if no Studio session is attached.
  - Returns ok=false if the path is missing or not a Sound.`,
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
        const result = await callStudio<Record<string, unknown>>("manage_audio", input);
        const text = result.ok
          ? `Audio ${input.action} ok${result.path ? `: ${String(result.path)}` : ""}`
          : `Audio ${input.action} failed: ${result.error ?? "unknown"}`;
        return ok(result, text);
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );
}
