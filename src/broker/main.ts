#!/usr/bin/env node
/**
 * roblox-mcp-pro broker — the single long-lived process that owns the bridge
 * port, talks to the Studio plugin, and multiplexes commands from every
 * connected AI agent. MCP client processes auto-spawn this on demand (see
 * src/client/transport.ts); a second broker that loses the port race exits
 * quietly.
 *
 * Detached from any terminal, so it logs to a file as well as stderr.
 */

import { appendFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { bridge } from "../services/bridge.js";
import { BRIDGE_HOST, BRIDGE_PORT } from "../constants.js";
import { createBrokerRoutes } from "./routes.js";

const LOG_FILE = path.join(os.tmpdir(), "roblox-mcp-pro-broker.log");

function log(message: string): void {
  const line = `[${new Date().toISOString()}] [broker] ${message}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // Logging is best-effort; never let it crash the broker.
  }
}

/** Exit after this long with no agents AND no Studio plugin polling. */
const IDLE_SHUTDOWN_MS = 120_000;

async function main(): Promise<void> {
  const routes = createBrokerRoutes(bridge);
  bridge.onUnhandled = routes.handle;

  try {
    await bridge.start();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      // Another broker won the race (or something else holds the port). The
      // client that spawned us will connect to whoever is listening.
      log(`port ${BRIDGE_PORT} already in use — assuming another broker; exiting.`);
      process.exit(0);
    }
    log(`FATAL: could not bind ${BRIDGE_HOST}:${BRIDGE_PORT}: ${String(error)}`);
    process.exit(1);
  }

  log(`listening on http://${BRIDGE_HOST}:${BRIDGE_PORT} (dashboard at /)`);

  let idleSince: number | null = null;
  const heartbeat = setInterval(() => {
    routes.tick();
    const busy = routes.state.agentCount() > 0 || bridge.status().pluginConnected;
    if (busy) {
      idleSince = null;
    } else {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= IDLE_SHUTDOWN_MS) {
        log("idle with no agents or plugin — shutting down.");
        clearInterval(heartbeat);
        void bridge.stop().then(() => process.exit(0));
      }
    }
  }, 1000);
  heartbeat.unref();

  const shutdown = (): void => {
    log("shutting down…");
    clearInterval(heartbeat);
    void bridge.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  log(`startup error: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
