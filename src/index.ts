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
import { installPlugin, ensurePluginInstalled } from "./install-plugin.js";
import { ensureSkillsInstalled } from "./install-skills.js";
import { VERSION } from "./version.js";
import { initProject } from "./init-project.js";

function log(message: string): void {
  process.stderr.write(`[roblox-mcp-pro] ${message}\n`);
}

async function main(): Promise<void> {
  // One-shot CLI subcommands (run, then exit — not the MCP stdio server).
  if (process.argv[2] === "init") {
    await initProject();
    return;
  }
  if (process.argv[2] === "install-plugin") {
    await installPlugin();
    return;
  }
  if (process.argv[2] === "--version" || process.argv[2] === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  log(`roblox-mcp-pro v${VERSION}`);

  // Keep the Studio plugin up to date automatically — copy the bundled plugin
  // into the Roblox Plugins folder when it's missing or out of date, so a server
  // update also updates the plugin with no action from the user.
  if (process.env.ROBLOX_MCP_NO_PLUGIN_AUTOINSTALL !== "1") {
    const sync = await ensurePluginInstalled();
    if (sync.status === "installed") {
      log(`installed Studio plugin → ${sync.dest} (open Studio and click MCP)`);
    } else if (sync.status === "updated") {
      log(`updated Studio plugin → restart Roblox Studio to load the new version`);
    }
  }

  // Keep agent skills up to date for skill-capable clients (Claude Code, Codex).
  if (process.env.ROBLOX_MCP_NO_SKILL_AUTOINSTALL !== "1") {
    const skills = await ensureSkillsInstalled();
    if (skills.changed > 0) {
      log(`installed/updated ${skills.changed} agent skill file(s)`);
    }
  }

  const server = new McpServer({
    name: "roblox-studio-mcp-server",
    version: "0.1.0",
  });

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

  // MCP hosts usually stop the server by closing the stdio pipe rather than
  // sending a signal (especially on Windows). Treat every one of these as the
  // same clean exit so the broker always hears our deregister and can free the
  // port promptly. Guarded so the duplicate triggers only deregister once.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutting down…");
    await deregister();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  server.server.onclose = () => void shutdown();
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
}

main().catch((error: unknown) => {
  log(`startup error: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
