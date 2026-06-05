/**
 * Broker HTTP routes layered on top of the bridge's plugin protocol:
 *
 *   /rpc/*    — the API each MCP client (AI agent) process talks to:
 *                 ping · register · identify · heartbeat · deregister · call · status
 *   /         — the monitoring dashboard (HTML)
 *   /api/*    — dashboard data: state (snapshot JSON) and stream (SSE)
 *
 * The `manage_sync` tool is handled here, locally, against the single shared
 * sync engine — so multiple agents never spin up competing file watchers.
 * Every other tool is forwarded to the Studio plugin via `bridge.enqueue`.
 */

import type http from "node:http";
import type { Bridge } from "../services/bridge.js";
import { StudioError } from "../services/errors.js";
import { BRIDGE_PORT } from "../constants.js";
import { syncEngine, type SyncMode } from "../sync/engine.js";
import { BrokerState } from "./registry.js";
import { DASHBOARD_HTML } from "./dashboard.js";

/** Studio session details, polled from the plugin for the dashboard. */
interface StudioInfo {
  placeId?: number;
  placeName?: string;
  studioVersion?: string;
  isRunning?: boolean;
}

export interface BrokerRoutes {
  handle: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ) => Promise<boolean>;
  /** Periodic housekeeping: prune dead agents and refresh dashboard listeners. */
  tick: () => void;
  state: BrokerState;
}

/** Run a `manage_sync` action against the shared engine; throws on failure. */
async function runSync(args: unknown): Promise<Record<string, unknown>> {
  const a = (args ?? {}) as { action?: string; roots?: string[]; mode?: SyncMode };
  switch (a.action) {
    case "start":
      return (await syncEngine.start(a.roots, a.mode)) as unknown as Record<string, unknown>;
    case "stop":
      await syncEngine.stop();
      return syncEngine.status() as unknown as Record<string, unknown>;
    case "status":
      return syncEngine.status() as unknown as Record<string, unknown>;
    case "pull":
      if (!syncEngine.isRunning()) throw new StudioError("start sync before pulling.");
      await syncEngine.pull();
      return syncEngine.status() as unknown as Record<string, unknown>;
    case "push": {
      if (!syncEngine.isRunning()) throw new StudioError("start sync before pushing.");
      const pushed = await syncEngine.push();
      return { ...syncEngine.status(), pushed } as unknown as Record<string, unknown>;
    }
    default:
      throw new StudioError(`unknown sync action: ${String(a.action)}`);
  }
}

export function createBrokerRoutes(bridge: Bridge): BrokerRoutes {
  const state = new BrokerState();
  const sseClients = new Set<http.ServerResponse>();
  let totalCommands = 0;
  const startedAt = Date.now();

  // Studio session details for the dashboard, refreshed from the plugin on a
  // throttle. Polled via bridge.enqueue directly (not /rpc/call) so these
  // internal probes never show up in the agent command log.
  let studio: StudioInfo | null = null;
  let studioAt = 0;
  let studioInflight = false;
  const STUDIO_TTL_MS = 8000;

  async function refreshStudio(): Promise<void> {
    if (!bridge.status().pluginConnected) {
      if (studio) {
        studio = null;
        broadcast();
      }
      return;
    }
    if (studioInflight || Date.now() - studioAt < STUDIO_TTL_MS) return;
    studioInflight = true;
    try {
      // internal: keep this probe out of the plugin's activity log.
      studio = (await bridge.enqueue("system_info", {}, { internal: true })) as StudioInfo;
      studioAt = Date.now();
      broadcast();
    } catch {
      // Plugin dropped mid-probe; leave the last value until it reconnects.
    } finally {
      studioInflight = false;
    }
  }

  function buildSnapshot(): Record<string, unknown> {
    const snap = state.snapshot();
    return {
      brokerStartedAt: startedAt,
      port: BRIDGE_PORT,
      plugin: bridge.status(),
      studio,
      sync: syncEngine.status(),
      totalCommands,
      agents: snap.agents,
      recent: snap.recent,
    };
  }

  function broadcast(): void {
    if (sseClients.size === 0) return;
    const payload = `data: ${JSON.stringify(buildSnapshot())}\n\n`;
    for (const client of sseClients) {
      if (!client.writableEnded) client.write(payload);
    }
  }

  state.onChange = broadcast;

  function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded) return;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => (data += c));
      req.on("end", () => {
        try {
          resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
      req.on("error", reject);
    });
  }

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const path = url.pathname;
    const method = req.method ?? "GET";

    // --- dashboard ---------------------------------------------------------
    if (method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(DASHBOARD_HTML);
      return true;
    }
    if (method === "GET" && path === "/api/state") {
      sendJson(res, 200, buildSnapshot());
      return true;
    }
    if (method === "GET" && path === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(buildSnapshot())}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return true;
    }

    // --- Studio plugin sync control ---------------------------------------
    // The plugin uses these to drive the shared sync engine from its own UI
    // (start/stop + direction), independent of any AI agent.
    if (method === "GET" && path === "/plugin/sync") {
      sendJson(res, 200, { ok: true, result: syncEngine.status() });
      return true;
    }
    if (method === "POST" && path === "/plugin/sync") {
      const body = await readJson(req);
      try {
        const result = await runSync(body);
        sendJson(res, 200, { ok: true, result });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    // Explicit connect/disconnect signal so the dashboard updates instantly.
    if (method === "POST" && path === "/plugin/status") {
      const body = await readJson(req);
      bridge.setPluginPresence(body.connected === true);
      void refreshStudio();
      broadcast();
      sendJson(res, 200, { ok: true });
      return true;
    }

    // --- client RPC --------------------------------------------------------
    if (method === "GET" && path === "/rpc/ping") {
      sendJson(res, 200, { broker: "roblox-mcp-pro" });
      return true;
    }
    if (method === "GET" && path === "/rpc/status") {
      sendJson(res, 200, bridge.status());
      return true;
    }
    if (method === "POST" && path === "/rpc/register") {
      const body = await readJson(req);
      const clientId = state.register(
        String(body.name ?? "agent"),
        body.version ? String(body.version) : undefined,
        typeof body.pid === "number" ? body.pid : undefined,
      );
      sendJson(res, 200, { clientId });
      return true;
    }
    if (method === "POST" && path === "/rpc/identify") {
      const body = await readJson(req);
      state.identify(
        String(body.clientId ?? ""),
        String(body.name ?? ""),
        body.version ? String(body.version) : undefined,
      );
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (method === "POST" && path === "/rpc/heartbeat") {
      const body = await readJson(req);
      const known = state.heartbeat(String(body.clientId ?? ""));
      sendJson(res, 200, { ok: known });
      return true;
    }
    if (method === "POST" && path === "/rpc/deregister") {
      const body = await readJson(req);
      state.deregister(String(body.clientId ?? ""));
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (method === "POST" && path === "/rpc/call") {
      const body = await readJson(req);
      const clientId = String(body.clientId ?? "");
      const tool = String(body.tool ?? "");
      const args = body.args;
      const start = Date.now();
      let ok = true;
      let result: unknown = null;
      let error: string | undefined;
      try {
        result =
          tool === "manage_sync"
            ? await runSync(args)
            : await bridge.enqueue(tool, args);
      } catch (e) {
        ok = false;
        error = e instanceof Error ? e.message : String(e);
      }
      totalCommands += 1;
      state.recordCommand({
        ts: start,
        clientId,
        agent: state.agentName(clientId),
        tool,
        ok,
        durationMs: Date.now() - start,
        error,
      });
      sendJson(res, 200, { ok, result: result ?? null, error });
      return true;
    }

    return false;
  }

  function tick(): void {
    state.prune();
    void refreshStudio();
    broadcast();
  }

  return { handle, tick, state };
}
