/**
 * system_info — report bridge/connection status and basic Studio session info.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bridge } from "../services/bridge.js";
import { callStudio } from "../services/studio.js";
import { ok } from "../services/format.js";

const InputSchema = z.object({}).strict();

interface StudioInfo {
  placeId?: number;
  placeName?: string;
  studioVersion?: string;
  isRunning?: boolean;
}

export function registerSystemTools(server: McpServer): void {
  server.registerTool(
    "system_info",
    {
      title: "Roblox MCP System Info",
      description: `Report connection status between the MCP server and Roblox Studio.

Use this first to confirm the Studio plugin is connected before running other tools.

Args: none

Returns (structured):
  {
    "bridge": { "ok", "pluginConnected", "queued", "inflight", "lastPollAt" },
    "studio"?: { "placeId", "placeName", "studioVersion", "isRunning" }  // when connected
  }

Error Handling:
  - Always succeeds. If the plugin is not connected, 'studio' is omitted and
    bridge.pluginConnected is false.`,
      inputSchema: InputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const status = bridge.status();
      const out: Record<string, unknown> = { bridge: status };
      let text = [
        "# Roblox MCP — System Info",
        "",
        `- Plugin connected: ${status.pluginConnected ? "yes ✅" : "no ❌"}`,
        `- Queued commands: ${status.queued}`,
        `- In-flight commands: ${status.inflight}`,
      ].join("\n");

      if (status.pluginConnected) {
        try {
          const studio = await callStudio<StudioInfo>("system_info", {});
          out.studio = studio;
          text +=
            `\n- Place: ${studio.placeName ?? "?"} (id ${studio.placeId ?? "?"})` +
            `\n- Studio version: ${studio.studioVersion ?? "?"}` +
            `\n- Play session running: ${studio.isRunning ? "yes" : "no"}`;
        } catch {
          // Plugin connected but didn't answer in time — still report bridge state.
          text += "\n- (Studio details unavailable: plugin did not respond.)";
        }
      } else {
        text +=
          "\n\nOpen Roblox Studio, install/enable the roblox-mcp-pro plugin, and click " +
          "its **Connect** button to attach a session.";
      }

      return ok(out, text);
    },
  );
}
