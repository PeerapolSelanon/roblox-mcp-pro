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
 * How long to wait after the LAST agent leaves before shutting down. Liveness is
 * driven by agents only (NOT the Studio plugin): when no MCP client is connected
 * there is nothing to drive Studio, so the broker frees the port and exits. The
 * grace is small by design — just enough to absorb an MCP host that restarts its
 * server (agents briefly hit zero then reconnect) so we don't kill+respawn the
 * broker on every reconnect. Tunable via ROBLOX_MCP_IDLE_SHUTDOWN_MS; set 0 for
 * immediate teardown. The Studio plugin reconnects automatically to the next broker.
 */
function idleShutdownMs(): number {
  const raw = Number(process.env.ROBLOX_MCP_IDLE_SHUTDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1500;
}

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

/**
 * Stop the bridge and exit. A hard fallback timer force-exits even if a lingering
 * connection — e.g. an open dashboard SSE stream — keeps `server.close()` from
 * resolving; without it the broker could never free the port while a dashboard
 * tab is open.
 */
function stopAndExit(): void {
  void bridge.stop().catch(() => {});
  setTimeout(() => process.exit(0), 400);
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

  const graceMs = idleShutdownMs();
  let teardownTimer: NodeJS.Timeout | null = null;

  const cancelTeardown = (): void => {
    if (teardownTimer) {
      clearTimeout(teardownTimer);
      teardownTimer = null;
    }
  };

  const armTeardown = (delayMs: number = graceMs): void => {
    cancelTeardown();
    teardownTimer = setTimeout(() => {
      // Re-check at fire time: an agent may have (re)connected during the grace.
      if (routes.state.agentCount() === 0) {
        log("last agent left — shutting down and freeing the port.");
        stopAndExit();
      }
    }, delayMs);
    // Don't let a pending teardown keep the event loop alive on its own.
    teardownTimer.unref();
  };

  // The registry fires onEmpty the moment the connected-agent count hits zero —
  // whether from a clean deregister or from pruning a crashed agent. Steady-state
  // teardown honors graceMs (which may be 0 for immediate shutdown).
  routes.state.onEmpty = () => armTeardown();

  // Housekeeping: prune dead agents + refresh the dashboard. Also cancels any
  // pending teardown as soon as an agent is present again (belt-and-suspenders
  // alongside the re-check inside the timer).
  const heartbeat = setInterval(() => {
    routes.tick();
    if (routes.state.agentCount() > 0) cancelTeardown();
  }, 1000);
  heartbeat.unref();

  // If the broker spawned but no agent ever registers (rare race), don't linger.
  // Use a floor independent of graceMs: the client that spawned us must still
  // ping until we're up, then register — a tiny configured grace (even 0) must
  // not tear us down before our own spawning client can connect. Registration
  // doesn't cancel this timer; the fire-time agentCount()===0 re-check (and the
  // 1s heartbeat cancel) handle a client that attaches during the floor.
  if (routes.state.agentCount() === 0) armTeardown(Math.max(graceMs, 3000));

  const shutdown = (): void => {
    log("shutting down…");
    clearInterval(heartbeat);
    cancelTeardown();
    stopAndExit();
  };
  // Let a newer client replace us via POST /rpc/shutdown.
  routes.setShutdownHook(shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  log(`startup error: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
