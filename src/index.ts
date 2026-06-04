#!/usr/bin/env node
/**
 * roblox-mcp-pro — MCP server entry point.
 *
 * Boots the localhost bridge (for the Studio plugin) and serves MCP over stdio.
 * All logging goes to stderr; stdout is reserved for the MCP protocol.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bridge } from "./services/bridge.js";
import { registerAllTools } from "./tools/index.js";
import { BRIDGE_HOST, BRIDGE_PORT } from "./constants.js";

function log(message: string): void {
  process.stderr.write(`[roblox-mcp-pro] ${message}\n`);
}

async function main(): Promise<void> {
  const server = new McpServer({
    name: "roblox-studio-mcp-server",
    version: "0.1.0",
  });

  registerAllTools(server);

  try {
    await bridge.start();
    log(`bridge listening on http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
  } catch (error) {
    log(
      `FATAL: could not bind bridge on ${BRIDGE_HOST}:${BRIDGE_PORT} — ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        "Is another roblox-mcp-pro instance already running? " +
        "Set ROBLOX_MCP_PORT to use a different port.",
    );
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server ready (stdio)");

  const shutdown = async (): Promise<void> => {
    log("shutting down…");
    await bridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error: unknown) => {
  log(`startup error: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
