#!/usr/bin/env node
/**
 * roblox-mcp-pro — MCP server entry point (client mode).
 *
 * Each AI agent spawns its own copy of this process. Instead of binding the
 * bridge port directly (which let only one agent run at a time), it connects to
 * a shared broker — auto-spawning one if none is running — so Claude Code,
 * Codex, Antigravity, etc. can all drive the same Studio session concurrently.
 * All logging goes to stderr; stdout is reserved for the MCP protocol.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./tools/index.js";
import { ensureBroker, register, identify, deregister } from "./client/transport.js";
import { BRIDGE_HOST, BRIDGE_PORT } from "./constants.js";
import { resolveLicense } from "./licensing/license.js";
import { installLicenseGate } from "./licensing/gate.js";
import { installPlugin } from "./install-plugin.js";

function log(message: string): void {
  process.stderr.write(`[roblox-mcp-pro] ${message}\n`);
}

async function main(): Promise<void> {
  // One-shot CLI subcommands (run, then exit — not the MCP stdio server).
  if (process.argv[2] === "install-plugin") {
    await installPlugin();
    return;
  }

  const server = new McpServer({
    name: "roblox-studio-mcp-server",
    version: "0.1.0",
  });

  // Resolve the license first, then put the gate in place before any tool
  // registers so locked sessions short-circuit cleanly.
  const license = await resolveLicense();
  log(`license: ${license.status} — ${license.message}`);
  installLicenseGate(server);

  registerAllTools(server);

  try {
    await ensureBroker();
    await register(process.env.ROBLOX_MCP_CLIENT_NAME ?? "agent");
    log(`connected to broker at http://${BRIDGE_HOST}:${BRIDGE_PORT} (monitor at /)`);
  } catch (error) {
    log(
      `FATAL: could not reach the roblox-mcp-pro broker — ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  // Once the MCP handshake completes we know which agent connected; label it.
  server.server.oninitialized = () => {
    const info = server.server.getClientVersion();
    if (info?.name) identify(info.name, info.version);
  };

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server ready (stdio)");

  const shutdown = async (): Promise<void> => {
    log("shutting down…");
    await deregister();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error: unknown) => {
  log(`startup error: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
