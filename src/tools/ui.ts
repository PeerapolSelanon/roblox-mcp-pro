/**
 * manage_ui — build and edit GUI hierarchies.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callStudio, describeError } from "../services/studio.js";
import { ok, fail } from "../services/format.js";
import { InstancePath } from "../schemas/common.js";

interface UINodeShape {
  className: string;
  name?: string;
  properties?: Record<string, unknown>;
  children?: UINodeShape[];
}

const UINode: z.ZodType<UINodeShape> = z.lazy(() =>
  z
    .object({
      className: z.string().min(1).describe("GUI ClassName, e.g. 'ScreenGui', 'Frame', 'TextLabel'."),
      name: z.string().max(200).optional().describe("Instance name."),
      properties: z
        .record(z.unknown())
        .optional()
        .describe(
          "Property map. UDim2 as [[xScale,xOffset],[yScale,yOffset]], Color3 as [r,g,b] (0-1).",
        ),
      children: z.array(UINode).optional().describe("Nested child nodes."),
    })
    .strict(),
);

const InputSchema = z
  .object({
    action: z
      .enum(["create", "set", "delete"])
      .describe("create: build a tree · set: apply properties to a path · delete: destroy a path."),
    parent: InstancePath.optional().describe("Parent for 'create' (default 'StarterGui')."),
    tree: UINode.optional().describe("UI tree spec for 'create'."),
    path: InstancePath.optional().describe("Target instance for 'set'/'delete'."),
    properties: z.record(z.unknown()).optional().describe("Properties for 'set'."),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

export function registerUITools(server: McpServer): void {
  server.registerTool(
    "manage_ui",
    {
      title: "Manage GUI / UI",
      description: `Build and edit Roblox GUI hierarchies (ScreenGui, Frame, TextLabel, buttons, …).

Args:
  - action ('create'|'set'|'delete').
  - parent (string): for 'create' (default 'StarterGui').
  - tree (object): for 'create' — { className, name?, properties?, children? } (recursive).
  - path (string): for 'set'/'delete'.
  - properties (object): for 'set'.
  Property hints: Size/Position as UDim2 [[xS,xO],[yS,yO]]; BackgroundColor3/TextColor3 as [r,g,b] 0-1.

Returns (structured):
  { "ok": boolean, "rootPath"?: string, "path"?: string, "error"?: string }

Examples:
  - A label inside a screen:
      action: "create", parent: "StarterGui",
      tree: { className: "ScreenGui", name: "HUD", children: [
        { className: "TextLabel", name: "Title",
          properties: { Text: "Hello", Size: [[0,200],[0,50]], Position: [[0.5,-100],[0,20]],
                        BackgroundColor3: [0.1,0.1,0.1], TextColor3: [1,1,1] } } ] }

Error Handling:
  - Returns "Error: …not connected" if no Studio session is attached.
  - On a bad property the partial tree is rolled back and an 'error' is returned.`,
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
        const result = await callStudio<Record<string, unknown>>("manage_ui", input);
        const text = result.ok
          ? `UI ${input.action} ok: ${result.rootPath ?? result.path ?? ""}`
          : `UI ${input.action} failed: ${result.error ?? "unknown"}`;
        return ok(result, text);
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );
}
