/**
 * system_info — report bridge/connection status and basic Studio session info.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callStudio, getUsage } from "../services/studio.js";
import { status as brokerStatus } from "../client/transport.js";
import { ok } from "../services/format.js";
import { currentLicense } from "../licensing/license.js";
import { VERSION } from "../version.js";

const InputSchema = z.object({}).strict();

interface StudioInfo {
  placeId?: number;
  placeName?: string;
  studioVersion?: string;
  isRunning?: boolean;
  sessionId?: string;
  studioSettings?: Record<string, unknown>;
}

export function registerSystemTools(server: McpServer): void {
  server.registerTool(
    "system_info",
    {
      title: "Roblox MCP System Info",
      description:
        "Connection status between the MCP server and Studio. Call first to confirm the plugin is attached. Free.\n" +
        "Args: none. Returns: { version, license, usage:{studioCalls,uptimeSec}, " +
        "bridge:{ok,pluginConnected,queued,inflight,lastPollAt}, " +
        "studio?:{placeId,placeName,studioVersion,isRunning,sessionId,studioSettings} }. " +
        "Always succeeds; studio omitted when not connected. license.status 'trial'/'licensed' = full Pro; " +
        "'locked' = free tier only (Pro calls return an upgrade message).",
      inputSchema: InputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const status = await brokerStatus();
      const license = currentLicense();
      const usage = getUsage();
      const out: Record<string, unknown> = { version: VERSION, bridge: status, license, usage };
      let text = [
        "# Roblox MCP — System Info",
        "",
        `- Version: ${VERSION}`,
        `- License: ${license.status} — ${license.message}`,
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
            `\n- Play session running: ${studio.isRunning ? "yes" : "no"}` +
            (studio.sessionId ? `\n- Session id: ${studio.sessionId}` : "") +
            (studio.studioSettings?.theme ? `\n- Theme: ${String(studio.studioSettings.theme)}` : "");
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
