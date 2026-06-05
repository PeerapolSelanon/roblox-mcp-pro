/**
 * Bridge: a localhost HTTP server that connects the MCP server (tools) to the
 * Roblox Studio plugin.
 *
 * Flow:
 *   - A tool calls `enqueue(tool, args)` and awaits a Promise.
 *   - The Studio plugin long-polls `GET /dequeue`; we hand it one command.
 *   - The plugin executes it and `POST`s the result to `/respond`, which
 *     resolves the matching Promise.
 *
 * The server binds to 127.0.0.1 only. An optional shared token (ROBLOX_MCP_TOKEN)
 * adds a header check on top of the loopback restriction.
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
} from "../constants.js";
import type {
  BridgeStatus,
  Command,
  CommandResponse,
  StudioEvent,
} from "../types.js";
import { StudioError } from "./errors.js";

export { StudioError };

interface InflightEntry {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface Waiter {
  res: http.ServerResponse;
  timer: NodeJS.Timeout;
}

type EventListener = (event: StudioEvent) => void;

/**
 * Handler for routes the bridge itself doesn't serve (the broker layers its
 * client RPC API and monitoring dashboard on top via this hook). Returns true
 * if it handled the request, in which case the bridge skips its 404.
 */
export type UnhandledRoute = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
) => boolean | Promise<boolean>;

export class Bridge {
  private server: http.Server | null = null;
  private readonly pending: Command[] = [];
  private readonly inflight = new Map<string, InflightEntry>();
  private readonly waiters: Waiter[] = [];
  private readonly eventListeners = new Set<EventListener>();
  private lastPollAt: number | null = null;

  /**
   * Optional hook the broker sets to serve its own routes (`/rpc/*`, the
   * dashboard, `/api/*`) on the same socket. Left null in any other context.
   */
  onUnhandled: UnhandledRoute | null = null;

  /** Start listening. Resolves once the socket is bound. */
  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        this.sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
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

  /** Stop listening and reject any outstanding work. */
  async stop(): Promise<void> {
    for (const entry of this.inflight.values()) {
      clearTimeout(entry.timer);
      entry.reject(new StudioError("Bridge shutting down"));
    }
    this.inflight.clear();
    this.pending.length = 0;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.res.statusCode = 204;
      waiter.res.end();
    }
    this.waiters.length = 0;
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** True if the plugin polled recently enough to be considered live. */
  isPluginConnected(): boolean {
    return (
      this.lastPollAt !== null &&
      Date.now() - this.lastPollAt < PLUGIN_LIVENESS_MS
    );
  }

  status(): BridgeStatus {
    return {
      ok: true,
      pluginConnected: this.isPluginConnected(),
      queued: this.pending.length,
      inflight: this.inflight.size,
      lastPollAt: this.lastPollAt,
    };
  }

  /** Subscribe to Studio->server change events (used by sync). Returns an unsubscribe fn. */
  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Queue a command for the plugin and await its result.
   * Fails fast with an actionable message if the plugin is not connected.
   */
  enqueue(tool: string, args: unknown): Promise<unknown> {
    if (!this.isPluginConnected()) {
      return Promise.reject(
        new StudioError(
          "Roblox Studio plugin is not connected. Open Roblox Studio, make sure " +
            "the roblox-mcp-pro plugin is installed, and click its Connect button.",
        ),
      );
    }
    const command: Command = { id: randomUUID(), tool, args, createdAt: Date.now() };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inflight.delete(command.id);
        // Drop it from the pending queue if it was never delivered.
        const idx = this.pending.findIndex((c) => c.id === command.id);
        if (idx !== -1) this.pending.splice(idx, 1);
        reject(
          new StudioError(
            `Command '${tool}' timed out after ${COMMAND_TIMEOUT_MS}ms with no ` +
              "response from Studio. The plugin may be busy or the action may have " +
              "yielded indefinitely.",
          ),
        );
      }, COMMAND_TIMEOUT_MS);
      this.inflight.set(command.id, { resolve, reject, timer });
      this.pending.push(command);
      this.flush();
    });
  }

  // --- internals -----------------------------------------------------------

  /** Deliver queued commands to any waiting long-poll responses. */
  private flush(): void {
    while (this.pending.length > 0 && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      const command = this.pending.shift()!;
      clearTimeout(waiter.timer);
      this.sendJson(waiter.res, 200, command);
    }
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${BRIDGE_HOST}`);
    const path = url.pathname;

    // The monitoring dashboard is meant to be opened in a browser, which can't
    // attach the shared token — exempt its read-only routes from auth.
    const isDashboard =
      req.method === "GET" && (path === "/" || path.startsWith("/api/"));

    // Auth (optional shared token).
    if (
      BRIDGE_TOKEN &&
      !isDashboard &&
      req.headers["x-auth-token"] !== BRIDGE_TOKEN
    ) {
      this.sendJson(res, 401, { error: "Invalid or missing x-auth-token" });
      return;
    }

    if (req.method === "GET" && path === "/health") {
      this.sendJson(res, 200, this.status());
      return;
    }

    if (req.method === "GET" && path === "/dequeue") {
      this.lastPollAt = Date.now();
      if (this.pending.length > 0) {
        const command = this.pending.shift()!;
        this.sendJson(res, 200, command);
        return;
      }
      // Hold the connection open until a command arrives or we time out.
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.res === res);
        if (idx !== -1) this.waiters.splice(idx, 1);
        res.statusCode = 204;
        res.end();
      }, LONG_POLL_TIMEOUT_MS);
      const waiter: Waiter = { res, timer };
      this.waiters.push(waiter);
      res.on("close", () => {
        clearTimeout(timer);
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
      });
      return;
    }

    if (req.method === "POST" && path === "/respond") {
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
      this.lastPollAt = Date.now();
      const body = await this.readBody(req);
      const event = JSON.parse(body) as StudioEvent;
      for (const listener of this.eventListeners) listener(event);
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
      req.on("data", (chunk: string) => {
        data += chunk;
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  private sendJson(
    res: http.ServerResponse,
    status: number,
    payload: unknown,
  ): void {
    if (res.writableEnded) return;
    const text = JSON.stringify(payload);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(text);
  }
}

/** Process-wide bridge singleton. */
export const bridge = new Bridge();
