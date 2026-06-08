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
import { spawn } from "node:child_process";
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

/**
 * Exit after this long with no connected AI agents. Liveness is driven by agents
 * only (NOT the Studio plugin): when no MCP client is connected there is nothing
 * to drive Studio, so the broker frees the port and shuts down. This avoids a
 * stale broker squatting :3690 across upgrades — the next agent spawns a fresh
 * one. The Studio plugin reconnects automatically once a new broker is up.
 */
const IDLE_SHUTDOWN_MS = 20_000;

/**
 * Open the monitoring dashboard in the default browser once, when the broker
 * first binds the port. On by default; set ROBLOX_MCP_NO_OPEN_DASHBOARD to a
 * truthy value ("1"/"true"/"yes") to disable. Only the broker that wins the bind
 * race reaches here, so the dashboard opens at most once per broker (not once
 * per agent). Best-effort: a failure is logged, not fatal.
 */
function maybeOpenDashboard(url: string): void {
  const off = (process.env.ROBLOX_MCP_NO_OPEN_DASHBOARD ?? "").toLowerCase();
  if (off === "1" || off === "true" || off === "yes") {
    return;
  }
  try {
    const [command, args] =
      process.platform === "win32"
        ? // `start` is a cmd built-in; the empty "" is the window title so a
          // quoted URL isn't mistaken for one.
          (["cmd", ["/c", "start", "", url]] as const)
        : process.platform === "darwin"
          ? (["open", [url]] as const)
          : (["xdg-open", [url]] as const);
    const child = spawn(command, [...args], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", (error) => log(`could not open dashboard: ${String(error)}`));
    child.unref();
    log(`opening dashboard in browser: ${url}`);
  } catch (error) {
    log(`could not open dashboard: ${String(error)}`);
  }
}

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

  const dashboardUrl = `http://${BRIDGE_HOST}:${BRIDGE_PORT}/`;
  log(`listening on ${dashboardUrl} (dashboard at /)`);
  // Only the broker that actually bound the port reaches here — the one that
  // loses the bind race exits above, so the dashboard opens at most once.
  maybeOpenDashboard(dashboardUrl);

  let idleSince: number | null = null;
  const heartbeat = setInterval(() => {
    routes.tick();
    const busy = routes.state.agentCount() > 0;
    if (busy) {
      idleSince = null;
    } else {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= IDLE_SHUTDOWN_MS) {
        log("no connected agents — shutting down and freeing the port.");
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
