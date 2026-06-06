/**
 * License gate. Wraps McpServer.registerTool so that every tool handler first
 * checks the resolved license state: when "locked", the call short-circuits with
 * a friendly "buy a license" error instead of running. A small whitelist stays
 * available so the agent can always report status and tell the user what to do.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fail } from "../services/format.js";
import { currentLicense } from "./license.js";
import { PRODUCT_NAME, PURCHASE_URL } from "./config.js";

/** Tools that work even when locked (so the user can see why + how to fix it). */
const ALWAYS_ALLOWED = new Set<string>(["system_info"]);

function lockedMessage(): string {
  const lic = currentLicense();
  return (
    `🔒 ${PRODUCT_NAME} is locked — ${lic.message}\n` +
    `Purchase or renew at ${PURCHASE_URL}, then set your key via the ` +
    `ROBLOX_MCP_LICENSE env var (in your MCP client config) or save it to ` +
    `~/.roblox-mcp-pro/license.key and restart.`
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
      if (!ALWAYS_ALLOWED.has(name) && currentLicense().status === "locked") {
        return fail(lockedMessage());
      }
      return call(...args);
    }) as typeof handler;
    return original(name, config, guardedHandler);
  };

  server.registerTool = wrapped;
}
