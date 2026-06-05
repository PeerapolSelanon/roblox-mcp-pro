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
import { syncEngine } from "../sync/engine.js";
import { BrokerState } from "./registry.js";
import { DASHBOARD_HTML } from "./dashboard.js";

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
  const a = (args ?? {}) as { action?: string; roots?: string[] };
  switch (a.action) {
    case "start":
      return (await syncEngine.start(a.roots)) as unknown as Record<string, unknown>;
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

  function buildSnapshot(): Record<string, unknown> {
    const snap = state.snapshot();
    return {
      plugin: bridge.status(),
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
    broadcast();
  }

  return { handle, tick, state };
}
