/**
 * World/visual tools: manage_lighting, manage_effects, manage_camera, manage_tween.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InstancePath, Vec3 } from "../schemas/common.js";
import { forwardTool } from "./_forward.js";

const Lighting = z
  .object({
    action: z.enum(["get", "set"]).describe("get current Lighting properties, or set them."),
    properties: z
      .record(z.unknown())
      .optional()
      .describe("For 'set': e.g. { ClockTime: 14, Brightness: 2, FogEnd: 500, OutdoorAmbient: [80,80,80] }."),
  })
  .strict();

const Effects = z
  .object({
    action: z.enum(["create", "set", "delete"]).describe("Manage a post-processing/atmosphere effect."),
    effect_type: z
      .string()
      .max(50)
      .optional()
      .describe("For 'create': BloomEffect, BlurEffect, ColorCorrectionEffect, DepthOfFieldEffect, SunRaysEffect, Atmosphere, Sky."),
    parent: InstancePath.optional().describe("Parent for 'create' (default 'Lighting')."),
    name: z.string().max(200).optional().describe("Name for the created effect."),
    path: InstancePath.optional().describe("Target for 'set'/'delete'."),
    properties: z.record(z.unknown()).optional().describe("Properties for 'create'/'set'."),
  })
  .strict();

const Camera = z
  .object({
    action: z.enum(["get", "set", "focus"]).describe("Read, set properties, or aim the CurrentCamera."),
    properties: z
      .record(z.unknown())
      .optional()
      .describe("For 'set': e.g. { FieldOfView: 70, CameraType: 'Scriptable' }."),
    position: Vec3.optional().describe("For 'focus': camera position (defaults near the target)."),
    look_at: Vec3.optional().describe("For 'focus': point to look at (if no target_path)."),
    target_path: InstancePath.optional().describe("For 'focus': instance to look at."),
  })
  .strict();

const Tween = z
  .object({
    path: InstancePath.describe("Instance to animate."),
    properties: z
      .record(z.unknown())
      .describe("Goal property map, e.g. { Position: [0,20,0], Transparency: 1, Size: [4,4,4] }."),
    duration: z.number().positive().max(60).default(1).describe("Seconds (default 1)."),
    easing_style: z.string().max(30).optional().describe("Enum.EasingStyle name, e.g. 'Quad', 'Bounce' (default Quad)."),
    easing_direction: z.string().max(10).optional().describe("'In' | 'Out' | 'InOut' (default Out)."),
    repeat_count: z.number().int().min(-1).default(0).describe("Times to repeat; -1 = forever (default 0)."),
    reverses: z.boolean().default(false).describe("Reverse after reaching the goal (default false)."),
    delay_time: z.number().min(0).default(0).describe("Delay before starting, seconds (default 0)."),
  })
  .strict();

const mut = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const del = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export function registerWorldTools(server: McpServer): void {
  forwardTool(server, "manage_lighting", {
    title: "Manage Lighting",
    description:
      "Read or set Lighting service properties (time of day, fog, ambient, exposure, shadows).\n" +
      "Args: action ('get'|'set'), properties (for 'set').\n" +
      "Returns: { ok, properties? } (get) or { ok, error? } (set).\n" +
      "Example: action: 'set', properties: { ClockTime: 7.5, FogEnd: 800, Brightness: 2 }.",
    inputSchema: Lighting.shape,
    annotations: mut,
  });

  forwardTool(server, "manage_effects", {
    title: "Manage Visual Effects",
    description:
      "Create, configure, or delete post-processing & atmosphere effects under Lighting.\n" +
      "Args: action ('create'|'set'|'delete'), effect_type, parent?, name?, path?, properties?.\n" +
      "Returns: { ok, path?, error? }.\n" +
      "Example: action: 'create', effect_type: 'BloomEffect', properties: { Intensity: 1.5, Threshold: 0.9 }.",
    inputSchema: Effects.shape,
    annotations: del,
  });

  forwardTool(server, "manage_camera", {
    title: "Manage Camera",
    description:
      "Read, configure, or aim Workspace.CurrentCamera.\n" +
      "Args: action ('get'|'set'|'focus'), properties?, position?, look_at?, target_path?.\n" +
      "Returns: { ok, cframe?, fieldOfView?, error? }.\n" +
      "Example: action: 'focus', target_path: 'Workspace.Boss', position: [0,30,40].",
    inputSchema: Camera.shape,
    annotations: mut,
  });

  forwardTool(server, "manage_tween", {
    title: "Tween Properties",
    description:
      "Animate an instance's properties over time with TweenService (previews in Studio).\n" +
      "Args: path, properties (goal), duration?, easing_style?, easing_direction?, repeat_count?, reverses?, delay_time?.\n" +
      "Returns: { ok, path?, duration?, error? }.\n" +
      "Example: path: 'Workspace.Door', properties: { Position: [10,5,0] }, duration: 2, easing_style: 'Sine'.",
    inputSchema: Tween.shape,
    annotations: mut,
  });
}
