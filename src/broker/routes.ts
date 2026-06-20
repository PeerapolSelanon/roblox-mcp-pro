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
// `path` is shadowed by the url pathname inside handle(); keep an alias too.
import path from "node:path";
import nodePath from "node:path";
import type { Bridge } from "../services/bridge.js";
import { captureStudioWindow } from "../services/capture.js";
import { StudioError } from "../services/errors.js";
import { BRIDGE_PORT } from "../constants.js";
import { syncManager, type SyncMode } from "../sync/engine.js";
import { VERSION } from "../version.js";
import { BrokerState } from "./registry.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import {
  browseDir,
  listRoots,
  loadRecentProjects,
  rememberProject,
} from "./fsbrowse.js";
import { resolveTargetSession } from "./resolve.js";
import type { SessionMeta, SessionStatus } from "../types.js";

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

/**
 * Run a `manage_sync` action against the per-session engine; throws on failure.
 * `bound` is the calling agent's bound sessionId (null for dashboard/plugin-driven
 * calls). The target Place is picked by: explicit place/session arg → bound →
 * the only connected Place → fail-closed (refuse, list choices) when ambiguous.
 * This lets several Places sync at once, each on its own engine.
 */
async function runSync(
  args: unknown,
  liveSessions: () => SessionStatus[],
  bound: string | null = null,
): Promise<Record<string, unknown>> {
  const a = (args ?? {}) as {
    action?: string;
    roots?: string[];
    mode?: SyncMode;
    initialDirection?: "studio-to-disk" | "disk-to-studio";
    syncDir?: string;
    file?: string;
    content?: string;
    limit?: number;
    session?: string;
    place?: string;
  };

  const sessions = liveSessions();
  const want = (a.session ?? a.place ?? "").trim();
  let target: string;
  if (want) {
    const lower = want.toLowerCase();
    const match = sessions.find(
      (s) => s.sessionId === want || (s.placeName ?? "").toLowerCase() === lower,
    );
    if (!match) {
      const names = sessions.map((s) => s.placeName ?? s.sessionId).join(", ") || "(none)";
      throw new StudioError(`No connected Place matches "${want}". Connected: ${names}.`);
    }
    target = match.sessionId;
  } else {
    // bound → it; exactly one connected → it; >1 unbound → fail-closed.
    target = resolveTargetSession({ bound, connected: sessions }).sessionId;
  }
  const engine = syncManager.forSession(target);

  switch (a.action) {
    case "start":
      return (await engine.start(
        a.roots,
        a.mode,
        a.initialDirection,
        a.syncDir,
        target,
      )) as unknown as Record<string, unknown>;
    case "stop":
      await engine.stop();
      return engine.status() as unknown as Record<string, unknown>;
    case "status":
      return engine.status() as unknown as Record<string, unknown>;
    case "pull":
      if (!engine.isRunning()) throw new StudioError("start sync before pulling.");
      await engine.pull();
      return engine.status() as unknown as Record<string, unknown>;
    case "push": {
      if (!engine.isRunning()) throw new StudioError("start sync before pushing.");
      const pushed = await engine.push();
      return { ...engine.status(), pushed } as unknown as Record<string, unknown>;
    }
    case "progress":
      return engine.progress();
    case "history":
      return { ok: true, history: engine.history(a.limit ?? 30) };
    case "read_file": {
      if (!a.file) throw new StudioError("read_file requires 'file'.");
      if (!engine.isRunning()) throw new StudioError("start sync before reading mirror files.");
      return (await engine.readFile(a.file)) as unknown as Record<string, unknown>;
    }
    case "write_file": {
      if (!a.file) throw new StudioError("write_file requires 'file'.");
      if (typeof a.content !== "string") throw new StudioError("write_file requires 'content'.");
      if (!engine.isRunning()) throw new StudioError("start sync before writing mirror files.");
      return (await engine.writeFile(a.file, a.content)) as unknown as Record<string, unknown>;
    }
    default:
      throw new StudioError(`unknown sync action: ${String(a.action)}`);
  }
}

/**
 * Run a `manage_agents` action against the broker's agent registry.
 * Handled here (never sent to Studio) because the broker is the only process
 * that sees every connected agent. `fromClientId` is the calling agent.
 */
function runAgents(
  state: BrokerState,
  fromClientId: string,
  args: unknown,
  liveSessions: () => SessionStatus[],
): Record<string, unknown> {
  const a = (args ?? {}) as {
    action?: string;
    place?: string;
    session?: string;
  };
  switch (a.action) {
    case "list": {
      const agents = state.snapshot().agents.map((ag) => ({
        clientId: ag.clientId,
        name: ag.name,
        version: ag.version,
        cwd: ag.cwd,
        boundSession: ag.boundSession,
        lastSeenAt: ag.lastSeenAt,
        self: ag.clientId === fromClientId,
      }));
      return { ok: true, you: fromClientId, agents };
    }
    case "sessions": {
      const sessions = liveSessions().map((s) => ({
        sessionId: s.sessionId,
        placeName: s.placeName ?? null,
        placeId: s.placeId ?? null,
        jobId: s.jobId ?? null,
        boundAgents: state.agentsBoundTo(s.sessionId).map((ag) => ag.name),
      }));
      return { ok: true, count: sessions.length, sessions };
    }
    case "attach": {
      const sessions = liveSessions();
      const want = (a.session ?? a.place ?? "").trim();
      if (!want) {
        throw new StudioError(
          "attach requires 'place' (a Place name) or 'session' (a sessionId).",
        );
      }
      const lower = want.toLowerCase();
      let matches = sessions.filter((s) => s.sessionId === want);
      if (matches.length === 0) {
        matches = sessions.filter((s) => (s.placeName ?? "").toLowerCase() === lower);
      }
      if (matches.length === 0) {
        const names = sessions.map((s) => s.placeName ?? s.sessionId).join(", ");
        throw new StudioError(
          `No connected Place matches '${want}'. Connected: ${names || "(none)"}.`,
        );
      }
      if (matches.length > 1) {
        const opts = matches.map((s) => `${s.placeName ?? "?"} (session ${s.sessionId})`).join("; ");
        throw new StudioError(
          `'${want}' is ambiguous — ${matches.length} sessions match. Attach by sessionId: ${opts}.`,
        );
      }
      const matched = matches[0]!;
      if (!state.attach(fromClientId, matched.sessionId)) {
        throw new StudioError("you are not registered with the broker.");
      }
      return {
        ok: true,
        attached: { sessionId: matched.sessionId, placeName: matched.placeName ?? null },
      };
    }
    case "detach": {
      state.detach(fromClientId);
      return { ok: true, detached: true };
    }
    default:
      throw new StudioError(`unknown agents action: ${String(a.action)}`);
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
  // Per-session so two open Places don't interfere.
  type Playtest = { kind: string; startedAtSec: number; untilMs: number; placeName?: string };
  const playtests = new Map<string, Playtest>();
  const PLAYTEST_RECONNECT_GRACE_MS = 30_000;

  function playtestWindow(sessionId: string): Playtest | null {
    const pt = playtests.get(sessionId);
    if (pt && Date.now() > pt.untilMs) {
      playtests.delete(sessionId);
      return null;
    }
    return pt ?? null;
  }

  // Best-effort live frame of the running game, attached to playtest_status when
  // the agent asks (capture:true). The plugin is suspended mid-playtest, but the
  // window grab is host-side so it still works. Never throws — a failed capture
  // just omits the image so polling keeps working.
  async function captureFrame(placeName?: string): Promise<Record<string, unknown>> {
    try {
      const shot = await captureStudioWindow({ placeName });
      return { screenshot: shot.base64, screenshotWidth: shot.width, screenshotHeight: shot.height };
    } catch (e) {
      return { screenshotError: e instanceof Error ? e.message : String(e) };
    }
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
      const connected = bridge.connectedSessions();
      if (connected.length === 0) {
        // nothing live to probe
        studioInflight = false;
        return;
      }
      studio = (await bridge.enqueue(connected[0]!.sessionId, "system_info", {}, { internal: true })) as StudioInfo;
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
    const syncStatus = syncManager.primaryStatus() as unknown as { baseDir?: string };
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
      sessions: bridge.allSessions().map((s) => ({
        ...s,
        boundAgents: state.agentsBoundTo(s.sessionId).map((ag) => ({ clientId: ag.clientId, name: ag.name })),
      })),
      sync: syncManager.primaryStatus(),
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
      // no-store: after a broker upgrade the browser must not show a stale dashboard.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(DASHBOARD_HTML);
      return true;
    }
    if (method === "GET" && path === "/api/state") {
      sendJson(res, 200, buildSnapshot());
      return true;
    }
    if (method === "POST" && path === "/api/agents/attach") {
      const body = await readJson(req);
      const clientId = String(body.clientId ?? "");
      const sessionId = String(body.sessionId ?? "");
      if (!sessionId) {
        const updated = state.detach(clientId);
        sendJson(res, 200, updated ? { ok: true, detached: true } : { ok: false, error: "no such agent" });
        return true;
      }
      const updated = state.attach(clientId, sessionId);
      sendJson(res, 200, updated ? { ok: true, sessionId } : { ok: false, error: "no such agent" });
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

    // --- folder picker (dashboard) ------------------------------------------
    // Read-only directory listing + suggestions so the dashboard can offer a
    // real "Browse…" picker and accurate auto-detection. Localhost-only broker.
    if (method === "GET" && path === "/api/fs/browse") {
      const target = url.searchParams.get("path");
      try {
        if (!target) {
          // Top level: drive roots + everything we can auto-detect.
          const [roots, recent] = await Promise.all([listRoots(), loadRecentProjects()]);
          const suggestions: { path: string; source: string }[] = [];
          const seen = new Set<string>();
          const add = (dir: string | null | undefined, source: string): void => {
            if (!dir || seen.has(dir)) return;
            seen.add(dir);
            suggestions.push({ path: dir, source });
          };
          const syncStatus = syncManager.primaryStatus() as unknown as { baseDir?: string };
          add(syncStatus.baseDir, "active sync");
          const agents = [...state.snapshot().agents].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
          for (const agent of agents) add(agent.cwd, agent.name);
          for (const dir of recent) add(dir, "recent");
          sendJson(res, 200, { ok: true, roots, suggestions });
        } else {
          sendJson(res, 200, { ok: true, ...(await browseDir(target)) });
        }
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    // Create a single new folder inside an existing one (for "New project").
    if (method === "POST" && path === "/api/fs/mkdir") {
      const body = await readJson(req);
      const parent = String(body.parent ?? "").trim();
      const name = String(body.name ?? "").trim();
      if (!parent || !name || /[\\/:*?"<>|]/.test(name)) {
        sendJson(res, 200, { ok: false, error: "invalid folder name" });
        return true;
      }
      try {
        const dir = nodePath.join(nodePath.resolve(parent), name);
        await fs.mkdir(dir);
        sendJson(res, 200, { ok: true, path: dir });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    // --- Studio plugin sync control ---------------------------------------
    // The plugin uses these to drive the shared sync engine from its own UI
    // (start/stop + direction), independent of any AI agent.
    if (method === "GET" && path === "/plugin/sync") {
      sendJson(res, 200, { ok: true, result: syncManager.primaryStatus() });
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
        const result = await runSync(body, () => bridge.connectedSessions());
        if (body.action === "start" && body.syncDir) {
          void rememberProject(String(body.syncDir));
        }
        sendJson(res, 200, { ok: true, result });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    // Explicit connect/disconnect signal so the dashboard updates instantly.
    if (method === "POST" && path === "/plugin/status") {
      const body = await readJson(req);
      const sessionId = String(body.sessionId ?? "default");
      const meta: Partial<SessionMeta> = {
        placeId: typeof body.placeId === "number" ? body.placeId : undefined,
        placeName: body.placeName ? String(body.placeName) : undefined,
        jobId: body.jobId ? String(body.jobId) : undefined,
        studioPid: typeof body.studioPid === "number" ? body.studioPid : undefined,
      };
      bridge.setPresence(sessionId, body.connected === true, meta);
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
      let sessionForLog: string | undefined;
      let placeForLog: string | undefined;
      const studioAction =
        tool === "manage_studio" ? String((args as { action?: unknown } | undefined)?.action ?? "") : "";
      try {
        // Resolve the target session for playtest tracking (best-effort, no throw here).
        const targetSession =
          tool === "manage_sync" || tool === "manage_agents"
            ? null
            : state.boundSessionOf(clientId) ??
              (bridge.connectedSessions().length === 1
                ? bridge.connectedSessions()[0]!.sessionId
                : null);
        const pt = targetSession ? playtestWindow(targetSession) : null;
        const suspended = pt !== null && targetSession !== null && !bridge.isConnected(targetSession);
        if (suspended && tool !== "manage_sync" && tool !== "manage_agents") {
          if (studioAction === "playtest_status") {
            result = {
              ok: true,
              running: true,
              kind: pt!.kind,
              started_at: pt!.startedAtSec,
              suspended: true,
              note:
                "the Studio plugin is suspended while the playtest runs; " +
                "status is broker-inferred — poll again for the final report.",
            };
            if ((args as { capture?: unknown } | undefined)?.capture) {
              Object.assign(result as Record<string, unknown>, await captureFrame(pt!.placeName));
            }
          } else {
            const leftSec = Math.max(0, Math.ceil((pt!.untilMs - PLAYTEST_RECONNECT_GRACE_MS - Date.now()) / 1000));
            throw new StudioError(
              `A '${pt!.kind}' playtest is running and the Studio plugin is suspended until it ends ` +
                `(~${leftSec}s left at most). Poll manage_studio {action:'playtest_status'} for the report, then retry.`,
            );
          }
        } else {
          if (tool === "manage_sync") {
            result = await runSync(
              args,
              () => bridge.connectedSessions(),
              state.boundSessionOf(clientId),
            );
          } else if (tool === "manage_agents") {
            result = runAgents(state, clientId, args, () => bridge.connectedSessions());
          } else if (tool === "capture_studio") {
            // Host-side window grab (the plugin sandbox can't read pixels). When a
            // plugin session is connected, resolve the bound Place — fail-closed on
            // >1 unbound, same as every other tool — so multi-place captures hit the
            // right window. With no session connected, fall back to best-effort.
            const connected = bridge.connectedSessions();
            let placeName: string | undefined;
            if (connected.length > 0) {
              const target = resolveTargetSession({
                bound: state.boundSessionOf(clientId),
                connected,
              });
              if (target.autoBind) state.attach(clientId, target.sessionId);
              sessionForLog = target.sessionId;
              placeName = connected.find((s) => s.sessionId === target.sessionId)?.placeName;
              placeForLog = placeName;
            }
            result = await captureStudioWindow({
              fullscreen: Boolean((args as { fullscreen?: boolean } | undefined)?.fullscreen),
              placeName,
              savePath: (args as { savePath?: string } | undefined)?.savePath,
            });
          } else {
            const target = resolveTargetSession({
              bound: state.boundSessionOf(clientId),
              connected: bridge.connectedSessions(),
            });
            if (target.autoBind) state.attach(clientId, target.sessionId);
            sessionForLog = target.sessionId;
            placeForLog =
              bridge.connectedSessions().find((s) => s.sessionId === target.sessionId)?.placeName;
            result = await bridge.enqueue(target.sessionId, tool, args);
          }
          if (studioAction === "play" || studioAction === "multiplayer") {
            const r = result as { ok?: boolean; duration?: number; started_at?: number } | null;
            if (r?.ok === true && targetSession) {
              playtests.set(targetSession, {
                kind: studioAction,
                startedAtSec: typeof r.started_at === "number" ? r.started_at : Math.floor(Date.now() / 1000),
                untilMs: Date.now() + (typeof r.duration === "number" ? r.duration : 30) * 1000 + PLAYTEST_RECONNECT_GRACE_MS,
                placeName: placeForLog,
              });
            }
          } else if (studioAction === "playtest_status") {
            // A real (plugin-answered) status that says the test ended closes
            // the window immediately — no need to wait it out.
            const r = result as { running?: boolean } | null;
            if (r && r.running === false && targetSession) playtests.delete(targetSession);
            else if (r?.running === true && (args as { capture?: unknown } | undefined)?.capture) {
              Object.assign(result as Record<string, unknown>, await captureFrame(placeForLog));
            }
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
        sessionId: sessionForLog,
        placeName: placeForLog,
      });
      sendJson(res, 200, { ok, result: result ?? null, error });
      return true;
    }

    return false;
  }

  function tick(): void {
    state.prune();
    bridge.prune(); // forget Studio sessions that closed (esp. abrupt closes)
    void refreshStudio();
    void refreshPlaces();
    broadcast();
  }

  return { handle, tick, state, setShutdownHook: (fn) => { shutdownHook = fn; } };
}
