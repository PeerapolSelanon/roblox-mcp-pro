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
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Bridge } from "../services/bridge.js";
import { StudioError } from "../services/errors.js";
import { BRIDGE_PORT } from "../constants.js";
import { syncEngine, type SyncMode } from "../sync/engine.js";
import { resolveLicense, saveLicenseKey } from "../licensing/license.js";
import { VERSION } from "../version.js";
import { BrokerState } from "./registry.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import { scaffoldProject } from "./scaffold.js";

/** Studio session details, polled from the plugin for the dashboard. */
interface StudioInfo {
  placeId?: number;
  placeName?: string;
  studioVersion?: string;
  isRunning?: boolean;
}

/** One mirrored place under <universe>/places/ (read from its place.json). */
interface PlaceEntry {
  folder: string;
  placeId: number;
  name: string;
  /** mtime of the place's sourcemap.json — a good proxy for "last synced". */
  lastSyncedAt: number | null;
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
  /** Wire the graceful-shutdown action a newer client can trigger via /rpc/shutdown. */
  setShutdownHook: (fn: () => void) => void;
}

/** Run a `manage_sync` action against the shared engine; throws on failure. */
async function runSync(args: unknown): Promise<Record<string, unknown>> {
  const a = (args ?? {}) as {
    action?: string;
    roots?: string[];
    mode?: SyncMode;
    initialDirection?: "studio-to-disk" | "disk-to-studio";
    syncDir?: string;
    file?: string;
    content?: string;
    limit?: number;
  };
  switch (a.action) {
    case "start":
      return (await syncEngine.start(
        a.roots,
        a.mode,
        a.initialDirection,
        a.syncDir,
      )) as unknown as Record<string, unknown>;
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
    case "progress":
      return syncEngine.progress();
    case "history":
      return { ok: true, history: syncEngine.history(a.limit ?? 30) };
    case "read_file": {
      if (!a.file) throw new StudioError("read_file requires 'file'.");
      if (!syncEngine.isRunning()) throw new StudioError("start sync before reading mirror files.");
      return (await syncEngine.readFile(a.file)) as unknown as Record<string, unknown>;
    }
    case "write_file": {
      if (!a.file) throw new StudioError("write_file requires 'file'.");
      if (typeof a.content !== "string") throw new StudioError("write_file requires 'content'.");
      if (!syncEngine.isRunning()) throw new StudioError("start sync before writing mirror files.");
      return (await syncEngine.writeFile(a.file, a.content)) as unknown as Record<string, unknown>;
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
  // Graceful-shutdown action, wired by main(). A newer client hits /rpc/shutdown
  // so this (older) broker exits and frees the port for the new one.
  let shutdownHook: (() => void) | null = null;

  // During a StudioTestService playtest ('play'/'multiplayer') the edit-mode
  // plugin stops long-polling, so bridge.enqueue fail-fasts with "not
  // connected" even though everything is fine. The broker saw the launch
  // response (it carries `duration`), so remember the window and, while the
  // plugin is silent inside it, answer playtest_status ourselves and give
  // other tools an accurate "wait for the playtest" error instead.
  let playtest: { kind: string; startedAtSec: number; untilMs: number } | null = null;
  const PLAYTEST_RECONNECT_GRACE_MS = 30_000;

  function playtestWindow(): { kind: string; startedAtSec: number; untilMs: number } | null {
    if (playtest && Date.now() > playtest.untilMs) playtest = null;
    return playtest;
  }

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
    // No throttle while we have nothing to show (e.g. right after a reconnect,
    // possibly with a different place open) — only throttle refreshes.
    if (studioInflight || (studio !== null && Date.now() - studioAt < STUDIO_TTL_MS)) return;
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

  // Known place mirrors in the active universe, scanned from places/*/place.json
  // on a throttle so the dashboard can show every place, not just the open one.
  let places: PlaceEntry[] | null = null;
  let placesDir: string | null = null;
  let placesAt = 0;
  let placesInflight = false;
  const PLACES_TTL_MS = 5000;

  /** The universe root: sync's baseDir when started, else the active agent's cwd. */
  function universeDir(): string | null {
    const syncStatus = syncEngine.status() as unknown as { baseDir?: string };
    if (syncStatus.baseDir) return syncStatus.baseDir;
    const agents = state.snapshot().agents;
    const active = [...agents].sort((a, b) => b.lastSeenAt - a.lastSeenAt).find((a) => a.cwd);
    return active?.cwd ?? null;
  }

  async function refreshPlaces(): Promise<void> {
    if (placesInflight || Date.now() - placesAt < PLACES_TTL_MS) return;
    placesInflight = true;
    try {
      const base = universeDir();
      if (!base) {
        places = null;
        placesDir = null;
        return;
      }
      const dir = path.join(base, "places");
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        // No places/ folder — not a universe project (or nothing synced yet).
        places = null;
        placesDir = null;
        return;
      }
      const out: PlaceEntry[] = [];
      for (const entry of entries) {
        try {
          let raw = await fs.readFile(path.join(dir, entry, "place.json"), "utf8");
          // Tolerate a UTF-8 BOM (hand-edited place.json files).
          if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
          const meta = JSON.parse(raw) as { placeId?: number; name?: string };
          if (typeof meta.placeId !== "number") continue;
          let lastSyncedAt: number | null = null;
          try {
            lastSyncedAt = (await fs.stat(path.join(dir, entry, "sourcemap.json"))).mtimeMs;
          } catch {
            // Never pulled yet.
          }
          out.push({ folder: entry, placeId: meta.placeId, name: meta.name ?? entry, lastSyncedAt });
        } catch {
          // Not a place folder — skip.
        }
      }
      out.sort((a, b) => (b.lastSyncedAt ?? 0) - (a.lastSyncedAt ?? 0));
      places = out;
      placesDir = dir;
    } finally {
      placesAt = Date.now();
      placesInflight = false;
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
      places: places !== null ? { dir: placesDir, list: places } : null,
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

    // --- license: let users paste a key on the dashboard, no config edit ---
    if (method === "GET" && path === "/api/license") {
      const state = await resolveLicense();
      sendJson(res, 200, { status: state.status, message: state.message, daysLeft: state.daysLeft });
      return true;
    }
    if (method === "POST" && path === "/api/license") {
      const body = await readJson(req);
      const key = String(body.key ?? "").trim();
      if (!key) {
        sendJson(res, 400, { ok: false, error: "missing license key" });
        return true;
      }
      try {
        const state = await saveLicenseKey(key);
        sendJson(res, 200, { ok: state.status !== "locked", status: state.status, message: state.message });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    // --- new project scaffold ---------------------------------------------
    // Create an empty, sync-ready project skeleton on disk. The folder may be
    // given explicitly or resolved from the most recently active agent's cwd.
    if (method === "POST" && path === "/api/scaffold") {
      const body = await readJson(req);
      let dir = body.dir ? String(body.dir).trim() : "";
      if (!dir) {
        const agents = state.snapshot().agents;
        const active = [...agents].sort((a, b) => b.lastSeenAt - a.lastSeenAt).find((a) => a.cwd);
        if (active?.cwd) dir = active.cwd;
      }
      if (!dir) {
        sendJson(res, 200, { ok: false, error: "no project folder given and no active agent to detect one from." });
        return true;
      }
      try {
        const result = await scaffoldProject(dir);
        sendJson(res, 200, { ok: true, result });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
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
        // Resolve syncDir from active agents if not provided
        if (body.action === "start" && !body.syncDir) {
          const agents = state.snapshot().agents;
          if (agents.length > 0) {
            const sorted = [...agents].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
            const activeAgent = sorted.find((a) => a.cwd);
            if (activeAgent?.cwd) {
              body.syncDir = activeAgent.cwd;
            }
          }
        }
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
    if (method === "POST" && path === "/rpc/shutdown") {
      // A newer client is replacing us. Ack, then exit so it can bind the port.
      sendJson(res, 200, { ok: true, version: VERSION });
      if (shutdownHook) setTimeout(shutdownHook, 100);
      return true;
    }
    if (method === "GET" && path === "/rpc/ping") {
      sendJson(res, 200, { broker: "roblox-mcp-pro", version: VERSION });
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
        body.cwd ? String(body.cwd) : undefined,
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
      const studioAction =
        tool === "manage_studio" ? String((args as { action?: unknown } | undefined)?.action ?? "") : "";
      try {
        const suspended = playtestWindow() !== null && !bridge.status().pluginConnected;
        if (suspended && tool !== "manage_sync") {
          const pt = playtestWindow()!;
          if (studioAction === "playtest_status") {
            result = {
              ok: true,
              running: true,
              kind: pt.kind,
              started_at: pt.startedAtSec,
              suspended: true,
              note:
                "the Studio plugin is suspended while the playtest runs; " +
                "status is broker-inferred — poll again for the final report.",
            };
          } else {
            const leftSec = Math.max(0, Math.ceil((pt.untilMs - PLAYTEST_RECONNECT_GRACE_MS - Date.now()) / 1000));
            throw new StudioError(
              `A '${pt.kind}' playtest is running and the Studio plugin is suspended until it ends ` +
                `(~${leftSec}s left at most). Poll manage_studio {action:'playtest_status'} for the report, then retry.`,
            );
          }
        } else {
          result =
            tool === "manage_sync"
              ? await runSync(args)
              : await bridge.enqueue(tool, args);
          if (studioAction === "play" || studioAction === "multiplayer") {
            const r = result as { ok?: boolean; duration?: number; started_at?: number } | null;
            if (r?.ok === true) {
              playtest = {
                kind: studioAction,
                startedAtSec: typeof r.started_at === "number" ? r.started_at : Math.floor(Date.now() / 1000),
                untilMs: Date.now() + (typeof r.duration === "number" ? r.duration : 30) * 1000 + PLAYTEST_RECONNECT_GRACE_MS,
              };
            }
          } else if (studioAction === "playtest_status") {
            // A real (plugin-answered) status that says the test ended closes
            // the window immediately — no need to wait it out.
            const r = result as { running?: boolean } | null;
            if (r && r.running === false) playtest = null;
          }
        }
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
    void refreshPlaces();
    broadcast();
  }

  return { handle, tick, state, setShutdownHook: (fn) => { shutdownHook = fn; } };
}
