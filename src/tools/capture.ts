/**
 * capture_studio — screenshot the live Roblox Studio window so the agent can
 * visually inspect the scene/UI (real render, not a reconstruction).
 *
 * Runs in the MCP server via an OS-level window capture; it does not require the
 * Studio plugin to be connected, only that Studio is open.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CaptureResult } from "../services/capture.js";
import { callStudio } from "../services/studio.js";

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
      description:
        "Screenshot the live Studio window (OS-level, Windows only; needs Studio open). " +
        "With the plugin connected it captures your bound Place's window, so it's safe when " +
        "multiple Places are open. Use to visually inspect the real render — lighting, materials, " +
        "meshes, layout — after building. Briefly foregrounds the Studio window.\n" +
        "Args: fullscreen (default false = just the Studio window, true = whole primary screen).\n" +
        "Returns: a PNG image block + { ok, width, height, windowTitle }. Errors if Studio isn't open.",
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
        // Runs in the broker (the Studio host), which resolves the bound Place so
        // multi-place sessions capture the right window.
        const shot = await callStudio<CaptureResult>("capture_studio", {
          fullscreen: args.fullscreen,
        });
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
