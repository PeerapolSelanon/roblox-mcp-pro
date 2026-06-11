/**
 * License gate. Wraps McpServer.registerTool so every tool handler first checks
 * the resolved license state. The free tier always works; only Pro calls (see
 * tiers.ts) are blocked when the license is "locked" (trial ended / no key),
 * with a friendly upgrade message. While "trial" or "licensed", everything runs.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fail } from "../services/format.js";
import { currentLicense } from "./license.js";
import { PRODUCT_NAME, PURCHASE_URL } from "./config.js";
import { isProCall } from "./tiers.js";

function upgradeMessage(toolName: string): string {
  const lic = currentLicense();
  return (
    `🔒 ${toolName} is a ${PRODUCT_NAME} Pro feature — ${lic.message}\n` +
    `Your free plan still includes the core tools (query/mutate instances, properties, ` +
    `scripts, raw Luau, logs, selection, snapshots, one-way Studio→disk sync).\n` +
    `Unlock Pro (advanced building, terrain, spatial analysis, bulk edits, ` +
    `bidirectional sync, playtest automation, UI Studio) at ${PURCHASE_URL}, then set ` +
    `your key via ROBLOX_MCP_LICENSE or ~/.roblox-mcp-pro/license.key and restart.`
  );
}

type RegisterTool = McpServer["registerTool"];

/**
 * Install the gate. Must run BEFORE registerAllTools so the wrapper is in place
 * when each tool registers.
 */
export function installLicenseGate(server: McpServer): void {
  const original = server.registerTool.bind(server) as RegisterTool;

  const wrapped: RegisterTool = (name, config, handler) => {
    const call = handler as (...args: unknown[]) => unknown;
    const guardedHandler = ((...args: unknown[]) => {
      // Free tier works regardless of license; only Pro calls require an
      // active trial or a license.
      if (currentLicense().status === "locked" && isProCall(name, args[0])) {
        return fail(upgradeMessage(name));
      }
      return call(...args);
    }) as typeof handler;
    return original(name, config, guardedHandler);
  };

  server.registerTool = wrapped;
}
