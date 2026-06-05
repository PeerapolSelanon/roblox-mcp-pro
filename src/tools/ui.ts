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
    replace: z
      .boolean()
      .default(false)
      .describe("For 'create': if a child with the same name exists under parent, delete it first (clean rebuild while iterating)."),
    path: InstancePath.optional().describe("Target instance for 'set'/'delete'."),
    properties: z.record(z.unknown()).optional().describe("Properties for 'set'."),
  })
  .strict();

const PreviewSchema = z
  .object({
    action: z
      .enum(["show", "hide"])
      .default("show")
      .describe("show: render the GUI full-screen on a solid backdrop · hide: remove the preview."),
    path: InstancePath.optional().describe("GUI to preview (ScreenGui/Frame/...). Required for 'show'."),
    background: z
      .array(z.number())
      .length(3)
      .optional()
      .describe("Backdrop color [r,g,b] 0-1 (default dark grey)."),
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

  server.registerTool(
    "ui_preview",
    {
      title: "Preview GUI (clean capture)",
      description:
        "Render a GUI full-screen on a solid backdrop in edit mode so capture_studio gets a clean, " +
        "isolated shot (no 3D scene behind it) to compare against a mockup. The design loop: " +
        "manage_ui -> ui_preview show -> capture_studio -> compare to mockup -> manage_ui set -> repeat -> ui_preview hide.\n" +
        "Args: action (show[default]|hide), path (GUI to preview, required for show), background ([r,g,b] 0-1).\n" +
        "Returns: { ok, showing, cloned?, error? }. Originals are untouched (a clone is shown).",
      inputSchema: PreviewSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input: z.infer<typeof PreviewSchema>) => {
      try {
        const result = await callStudio<Record<string, unknown>>("ui_preview", input);
        const text = result.ok
          ? input.action === "hide"
            ? "Preview hidden."
            : `Preview shown (${result.cloned ?? 0} element(s)). Now call capture_studio, compare to the mockup, then ui_preview hide.`
          : `ui_preview failed: ${result.error ?? "unknown"}`;
        return ok(result, text);
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );
}
