/**
 * Bridge: a localhost HTTP server connecting the MCP tools to the Roblox Studio
 * plugin(s). Each connected Studio window is a *session*, keyed by a sessionId
 * the plugin mints and carries in the `x-session-id` header. The bridge keeps a
 * per-session queue/waiters/liveness so a command only ever reaches the session
 * it was routed to — two open Places never share a queue.
 *
 * Flow per session:
 *   - A tool calls `enqueue(sessionId, tool, args)` and awaits a Promise.
 *   - That session's plugin long-polls `GET /dequeue` (with x-session-id); we
 *     hand it one of *its* commands.
 *   - The plugin executes it and `POST`s the result to `/respond`; we resolve
 *     the matching Promise (inflight is keyed by command id, globally unique).
 *
 * Binds to 127.0.0.1 only. An optional shared token (ROBLOX_MCP_TOKEN) adds a
 * header check on top of the loopback restriction.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import {
  BRIDGE_HOST,
  BRIDGE_PORT,
  BRIDGE_TOKEN,
  COMMAND_TIMEOUT_MS,
  LONG_POLL_TIMEOUT_MS,
  PLUGIN_LIVENESS_MS,
  PLUGIN_DISCONNECT_GRACE_MS,
  SESSION_PRUNE_GRACE_MS,
} from "../constants.js";
import type {
  BridgeStatus,
  Command,
  CommandResponse,
  SessionMeta,
  SessionStatus,
  StudioEvent,
} from "../types.js";
import { StudioError } from "./errors.js";

export { StudioError };

/** Header the plugin uses to identify its Studio session. */
const SESSION_HEADER = "x-session-id";
/** Fallback id for a plugin that predates session support (single-Place mode). */
const DEFAULT_SESSION = "default";

interface InflightEntry {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  /** Session this command was routed to, so a disconnect can fail it fast. */
  sessionId: string;
}

interface Waiter {
  res: http.ServerResponse;
  timer: NodeJS.Timeout;
}

interface Session {
  pending: Command[];
  waiters: Waiter[];
  lastPollAt: number | null;
  forcedOffline: boolean;
  /** Grace timer armed when a long-poll drops unexpectedly (abrupt Studio close). */
  disconnectTimer: NodeJS.Timeout | null;
  /** When prune first saw this session offline, used to age it out of the map. */
  offlineSince: number | null;
  meta: SessionMeta;
}

type EventListener = (event: StudioEvent, sessionId: string) => void;

export type UnhandledRoute = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
) => boolean | Promise<boolean>;

export class Bridge {
  private server: http.Server | null = null;
  private readonly sessions = new Map<string, Session>();
  /** Inflight commands keyed by their globally-unique id (cross-session safe). */
  private readonly inflight = new Map<string, InflightEntry>();
  private readonly eventListeners = new Set<EventListener>();

  onUnhandled: UnhandledRoute | null = null;

  // --- session bookkeeping ------------------------------------------------

  private ensure(sessionId: string): Session {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        pending: [],
        waiters: [],
        lastPollAt: null,
        forcedOffline: false,
        disconnectTimer: null,
        offlineSince: null,
        meta: { sessionId },
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** Record fresh plugin activity on a session and cancel any pending teardown. */
  private markAlive(s: Session): void {
    s.lastPollAt = Date.now();
    s.forcedOffline = false;
    s.offlineSince = null;
    if (s.disconnectTimer) {
      clearTimeout(s.disconnectTimer);
      s.disconnectTimer = null;
    }
  }

  /**
   * A long-poll for `sessionId` closed without us ending it (the plugin's
   * timeout and command dispatch both remove the waiter first), so Studio went
   * away mid-poll. Give it a short grace to re-poll; if it doesn't, mark the
   * session offline and fail its queued commands so callers don't hang.
   */
  private scheduleDisconnect(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.forcedOffline || s.disconnectTimer) return;
    s.disconnectTimer = setTimeout(() => {
      s.disconnectTimer = null;
      if (s.waiters.length === 0) {
        s.forcedOffline = true;
        this.failSession(sessionId, "Studio disconnected (the Place was closed).");
      }
    }, PLUGIN_DISCONNECT_GRACE_MS);
    s.disconnectTimer.unref?.();
  }

  /** Reject every queued/inflight command for a session (it's gone — don't wait). */
  private failSession(sessionId: string, reason: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.pending.length = 0;
    for (const [id, entry] of this.inflight) {
      if (entry.sessionId === sessionId) {
        clearTimeout(entry.timer);
        this.inflight.delete(id);
        entry.reject(new StudioError(reason));
      }
    }
  }

  /**
   * Drop sessions that have stayed disconnected past the prune grace, after a
   * brief "recently dropped" window. Without this a closed Studio — especially
   * an abrupt close — lingers in the registry, cluttering the dashboard and
   * (until liveness expired) blocking routing as a phantom Place. Returns true
   * if anything was removed. `now` is injectable for tests.
   */
  prune(now: number = Date.now()): boolean {
    let removed = false;
    for (const [id, s] of this.sessions) {
      if (this.isConnected(id)) {
        s.offlineSince = null;
        continue;
      }
      if (s.offlineSince === null) {
        s.offlineSince = now;
        continue;
      }
      if (now - s.offlineSince <= SESSION_PRUNE_GRACE_MS) continue;
      // Truly gone: release any held poll, fail queued commands, forget it.
      if (s.disconnectTimer) clearTimeout(s.disconnectTimer);
      for (const w of s.waiters) {
        clearTimeout(w.timer);
        if (!w.res.writableEnded) {
          w.res.statusCode = 204;
          w.res.end();
        }
      }
      s.waiters.length = 0;
      this.failSession(id, "Studio disconnected (the Place was closed).");
      this.sessions.delete(id);
      removed = true;
    }
    return removed;
  }

  /** True if a given session polled recently enough to be considered live. */
  isConnected(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    return (
      !!s &&
      !s.forcedOffline &&
      s.lastPollAt !== null &&
      Date.now() - s.lastPollAt < PLUGIN_LIVENESS_MS
    );
  }

  /** All currently-live sessions with their metadata (for routing + dashboard). */
  connectedSessions(): SessionStatus[] {
    const out: SessionStatus[] = [];
    for (const [id, s] of this.sessions) {
      if (this.isConnected(id)) {
        out.push({ ...s.meta, connected: true, queued: s.pending.length, lastPollAt: s.lastPollAt });
      }
    }
    return out;
  }

  /** Every known session, live or not (dashboard shows recently-dropped too). */
  allSessions(): SessionStatus[] {
    return [...this.sessions].map(([id, s]) => ({
      ...s.meta,
      connected: this.isConnected(id),
      queued: s.pending.length,
      lastPollAt: s.lastPollAt,
    }));
  }

  /**
   * Explicit connect/disconnect signal from a plugin, so the dashboard updates
   * within ~1s instead of waiting out the liveness window. Optionally updates
   * the session's metadata (placeId/placeName/jobId/studioPid).
   */
  setPresence(sessionId: string, connected: boolean, meta?: Partial<SessionMeta>): void {
    const s = this.ensure(sessionId);
    if (connected) {
      this.markAlive(s);
    } else {
      s.forcedOffline = true;
      if (s.disconnectTimer) {
        clearTimeout(s.disconnectTimer);
        s.disconnectTimer = null;
      }
    }
    if (meta) s.meta = { ...s.meta, ...meta, sessionId };
  }

  /** Aggregate status (back-compat): pluginConnected = any session is live. */
  status(): BridgeStatus {
    let queued = 0;
    let lastPollAt: number | null = null;
    let anyConnected = false;
    for (const [id, s] of this.sessions) {
      queued += s.pending.length;
      if (s.lastPollAt !== null && (lastPollAt === null || s.lastPollAt > lastPollAt)) {
        lastPollAt = s.lastPollAt;
      }
      if (this.isConnected(id)) anyConnected = true;
    }
    return {
      ok: true,
      pluginConnected: anyConnected,
      queued,
      inflight: this.inflight.size,
      lastPollAt,
    };
  }

  // --- lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        this.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const entry of this.inflight.values()) {
      clearTimeout(entry.timer);
      entry.reject(new StudioError("Bridge shutting down"));
    }
    this.inflight.clear();
    for (const s of this.sessions.values()) {
      s.pending.length = 0;
      if (s.disconnectTimer) {
        clearTimeout(s.disconnectTimer);
        s.disconnectTimer = null;
      }
      for (const waiter of s.waiters) {
        clearTimeout(waiter.timer);
        waiter.res.statusCode = 204;
        waiter.res.end();
      }
      s.waiters.length = 0;
    }
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  // --- enqueue ------------------------------------------------------------

  /**
   * Queue a command for a specific session and await its result. Fails fast if
   * that session's plugin is not connected.
   */
  enqueue(sessionId: string, tool: string, args: unknown, opts?: { internal?: boolean }): Promise<unknown> {
    if (!this.isConnected(sessionId)) {
      return Promise.reject(
        new StudioError(
          `Studio session '${sessionId}' is not connected. Open the Place, make sure the ` +
            "roblox-mcp-pro plugin is installed, and click its Connect button.",
        ),
      );
    }
    const s = this.ensure(sessionId);
    const command: Command = {
      id: randomUUID(),
      tool,
      args,
      createdAt: Date.now(),
      sessionId,
      internal: opts?.internal,
    };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inflight.delete(command.id);
        const idx = s.pending.findIndex((c) => c.id === command.id);
        if (idx !== -1) s.pending.splice(idx, 1);
        reject(
          new StudioError(
            `Command '${tool}' timed out after ${COMMAND_TIMEOUT_MS}ms with no response from ` +
              "Studio. The plugin may be busy or the action may have yielded indefinitely.",
          ),
        );
      }, COMMAND_TIMEOUT_MS);
      this.inflight.set(command.id, { resolve, reject, timer, sessionId });
      s.pending.push(command);
      this.flush(s);
    });
  }

  // --- internals ----------------------------------------------------------

  private flush(s: Session): void {
    while (s.pending.length > 0 && s.waiters.length > 0) {
      const waiter = s.waiters.shift()!;
      const command = s.pending.shift()!;
      clearTimeout(waiter.timer);
      this.sendJson(waiter.res, 200, command);
    }
  }

  private sessionIdOf(req: http.IncomingMessage): string {
    const raw = req.headers[SESSION_HEADER];
    const id = Array.isArray(raw) ? raw[0] : raw;
    return id?.trim() ? id.trim() : DEFAULT_SESSION;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${BRIDGE_HOST}`);
    const path = url.pathname;

    const isDashboard = req.method === "GET" && (path === "/" || path.startsWith("/api/"));
    if (BRIDGE_TOKEN && !isDashboard && req.headers["x-auth-token"] !== BRIDGE_TOKEN) {
      this.sendJson(res, 401, { error: "Invalid or missing x-auth-token" });
      return;
    }

    if (req.method === "GET" && path === "/health") {
      this.sendJson(res, 200, this.status());
      return;
    }

    if (req.method === "GET" && path === "/dequeue") {
      const sessionId = this.sessionIdOf(req);
      const s = this.ensure(sessionId);
      this.markAlive(s);
      if (s.pending.length > 0) {
        this.sendJson(res, 200, s.pending.shift()!);
        return;
      }
      const timer = setTimeout(() => {
        const idx = s.waiters.findIndex((w) => w.res === res);
        if (idx !== -1) s.waiters.splice(idx, 1);
        res.statusCode = 204;
        res.end();
      }, LONG_POLL_TIMEOUT_MS);
      const waiter: Waiter = { res, timer };
      s.waiters.push(waiter);
      res.on("close", () => {
        clearTimeout(timer);
        const idx = s.waiters.indexOf(waiter);
        // Still queued = the plugin closed the poll itself (timeout and dispatch
        // both remove the waiter before ending it), i.e. Studio went away.
        if (idx !== -1) {
          s.waiters.splice(idx, 1);
          this.scheduleDisconnect(sessionId);
        }
      });
      return;
    }

    if (req.method === "POST" && path === "/respond") {
      const sessionId = this.sessionIdOf(req);
      const s = this.ensure(sessionId);
      this.markAlive(s);
      const body = await this.readBody(req);
      const reply = JSON.parse(body) as CommandResponse;
      const entry = this.inflight.get(reply.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.inflight.delete(reply.id);
        if (reply.ok) entry.resolve(reply.result ?? null);
        else entry.reject(new StudioError(reply.error ?? "Unknown Studio error"));
      }
      this.sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && path === "/event") {
      const sessionId = this.sessionIdOf(req);
      const s = this.ensure(sessionId);
      this.markAlive(s);
      const body = await this.readBody(req);
      const event = JSON.parse(body) as StudioEvent;
      for (const listener of this.eventListeners) listener(event, sessionId);
      this.sendJson(res, 200, { ok: true });
      return;
    }

    if (this.onUnhandled) {
      const handled = await this.onUnhandled(req, res, url);
      if (handled) return;
    }

    this.sendJson(res, 404, { error: `Unknown route ${req.method} ${path}` });
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (data += chunk));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  private sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    if (res.writableEnded) return;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  }
}

/** Process-wide bridge singleton. */
export const bridge = new Bridge();
