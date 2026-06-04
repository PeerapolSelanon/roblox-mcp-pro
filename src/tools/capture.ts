/**
 * capture_studio — screenshot the live Roblox Studio window so the agent can
 * visually inspect the scene/UI (real render, not a reconstruction).
 *
 * Runs in the MCP server via an OS-level window capture; it does not require the
 * Studio plugin to be connected, only that Studio is open.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { captureStudioWindow } from "../services/capture.js";

const InputSchema = z
  .object({
    fullscreen: z
      .boolean()
      .default(false)
      .describe(
        "Capture the whole primary screen instead of just the Studio window (default false).",
      ),
  })
  .strict();

export function registerCaptureTools(server: McpServer): void {
  server.registerTool(
    "capture_studio",
    {
      title: "Capture Roblox Studio Window",
      description: `Take a screenshot of the live Roblox Studio window and return it as an image.

Use this to visually inspect the actual rendered scene or UI — lighting, materials,
meshes, textures, layout — instead of reasoning only from instance coordinates. Capture
after building or arranging something to judge how it looks, then iterate.

The capture is performed by the MCP server at the OS level (Windows), so it does NOT
require the Studio plugin connection — only that Roblox Studio is open. It briefly brings
the Studio window to the foreground.

Args:
  - fullscreen (boolean): capture the entire primary screen rather than just the Studio
    window (default false).

Returns:
  - An image (PNG) content block with the screenshot, plus structured
    { ok, width, height, windowTitle }.

Examples:
  - "Show me what the scene looks like" -> capture_studio
  - "Did the UI land where I expect?" -> capture_studio

Error Handling:
  - Returns an error if Roblox Studio is not running / has no open window, or if the
    OS screen capture fails. Windows only.`,
      inputSchema: InputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: { fullscreen?: boolean }) => {
      try {
        const shot = await captureStudioWindow({ fullscreen: args.fullscreen });
        return {
          content: [
            {
              type: "text" as const,
              text: `Captured Studio window "${shot.windowTitle}" (${shot.width}×${shot.height}px).`,
            },
            {
              type: "image" as const,
              data: shot.base64,
              mimeType: "image/png",
            },
          ],
          structuredContent: {
            ok: true,
            width: shot.width,
            height: shot.height,
            windowTitle: shot.windowTitle,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: could not capture Studio — ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
