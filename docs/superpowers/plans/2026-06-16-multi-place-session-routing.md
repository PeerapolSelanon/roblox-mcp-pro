# Multi-Place Session Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let multiple Roblox Studio Places connect to one broker at once and route every command to the exact Place an agent is bound to — addressed by Place Name — so commands can never hit the wrong Place when more than one is connected.

**Architecture:** Today the broker has a *single* command queue and a *single* plugin connection — two Studio windows both long-poll the same queue, so a command goes to whichever polls first (non-deterministic). We make the bridge **session-aware**: each plugin mints a `sessionId`, carries it on every HTTP call, and the bridge keeps a `Map<sessionId, Session>` with its own queue/waiters/liveness. The broker resolves a target session per agent from a **binding** (`clientId → sessionId`) that the agent sets via `manage_agents.attach {place:"…"}`. When an agent is unbound: 1 session → auto-route + auto-bind; 0 → "not connected"; **>1 → fail-closed** (refuse, list the choices). The 1-Lead + 1-Worker workflow uses the existing role/mailbox machinery: you tell the Lead "edit Place X", it dispatches to the Worker, the Worker attaches by name and executes.

**Tech Stack:** TypeScript (Node 24, `node:http`, `node:test` via `tsx`), Luau (Roblox Studio plugin), zod schemas, single self-contained HTML dashboard.

**Backward compatibility:** A plugin that doesn't send `x-session-id` is treated as session id `"default"`, so the common single-Place workflow keeps working unchanged during rollout.

**Scope note (per-call override):** Q2 mentioned a per-call session override. The locked workflow (Q10: Lead dispatches → Worker attaches by name) never needs it, and `attach`/`detach` are O(1) broker-local calls, so re-attaching *is* the override. We deliberately do **not** add a `session` field to every tool schema (YAGNI, keeps schemas clean).

---

## File Structure

| File | Responsibility / change |
|---|---|
| `src/types.ts` | Add `SessionMeta`, `SessionStatus`; extend `Command` with `sessionId`. |
| `src/services/bridge.ts` | Rewrite: single queue → `Map<sessionId, Session>`; `enqueue(sessionId, …)`; per-session liveness; `sessions()`, `connectedSessions()`, `setPresence(sessionId, …)`. |
| `src/broker/registry.ts` | Add `boundSession` per agent + `attach`/`detach`/`boundSessionOf`; add `sessionId`+`placeName` to `CommandLogEntry`. |
| `src/broker/routes.ts` | Session resolution in `/rpc/call` (adaptive + fail-closed); `runAgents` gets `sessions`/`attach`/`detach`; `/plugin/status` accepts metadata; `/api/agents/attach`; sync pin; per-session playtest; `buildSnapshot` emits `sessions[]`. |
| `src/sync/engine.ts` | Pin to one `sessionId` at `start`; thread it into every `bridge.enqueue` call. |
| `src/tools/agents.ts` | Schema + result formatting for `sessions`/`attach`/`detach`; show `boundSession` in `list`. |
| `src/broker/dashboard.ts` | `studio` panel → session cards; `session` column in the activity feed; warn on >1 agent per Place. |
| `plugin/src/Bridge.luau` | Mint `sessionId`; send `x-session-id` on every request; carry metadata on `notifyPresence`. |
| `plugin/src/init.server.luau` | Gather `placeId`/`placeName`/`jobId`/`studioPid`; pass to `notifyPresence`. |
| `.agents/skills/roblox-mcp-pro/SKILL.md` | Document the Lead/Worker + attach-by-Place-Name workflow. |
| `test/bridge.test.ts` (new) | Unit tests: lazy session create, per-session presence, enqueue-rejects-disconnected. |
| `test/registry.test.ts` (new) | Unit tests: attach/detach/boundSessionOf, single-lead invariant still holds. |
| `test/routing.test.ts` (new) | Unit tests: `resolveTargetSession` adaptive + fail-closed branches. |

**Test harness:** `tsx` is already a devDependency (used by `npm run dev`). Run TS unit tests with the Node test runner under tsx:
`npx tsx --test test/<name>.test.ts`
If `tsx --test` is unavailable in the installed version, fall back to `node --import tsx --test test/<name>.test.ts`.

---

## Phase 1 — Per-session bridge (TS core)

### Task 1: Session types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add the new types and extend `Command`**

In `src/types.ts`, change the `Command` interface to add `sessionId`, and append the two new interfaces at the end of the file:

```ts
/** A command queued by a tool, to be executed by the Studio plugin. */
export interface Command {
  /** Unique correlation id. */
  id: string;
  /** Tool/handler name the plugin should dispatch to (e.g. "execute_luau"). */
  tool: string;
  /** Arbitrary JSON-serializable arguments for the handler. */
  args: unknown;
  /** Epoch ms the command was created. */
  createdAt: number;
  /** Target Studio session this command is routed to. */
  sessionId: string;
  /**
   * True for broker-internal probes (e.g. the dashboard's periodic system_info).
   * The plugin still runs them but omits them from its activity log so the log
   * only shows real AI-agent commands.
   */
  internal?: boolean;
}
```

Append:

```ts
/** Identifying details a plugin reports for its Studio session. */
export interface SessionMeta {
  sessionId: string;
  placeId?: number;
  placeName?: string;
  jobId?: string;
  studioPid?: number;
}

/** Per-session liveness + queue stats, surfaced to the dashboard and routing. */
export interface SessionStatus extends SessionMeta {
  connected: boolean;
  queued: number;
  lastPollAt: number | null;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: `tsc` fails in `src/services/bridge.ts` and elsewhere because `Command` literals don't yet set `sessionId`. This is expected — those call sites are fixed in Task 2. Confirm the error is *only* "Property 'sessionId' is missing" type errors, not a syntax error in `types.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add SessionMeta/SessionStatus and Command.sessionId"
```

---

### Task 2: Rewrite the bridge to be session-aware

**Files:**
- Modify (full rewrite): `src/services/bridge.ts`
- Test: `test/bridge.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/bridge.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../src/services/bridge.js";

test("a session is unknown until its plugin polls or reports presence", () => {
  const b = new Bridge();
  assert.equal(b.isConnected("s1"), false);
  assert.deepEqual(b.connectedSessions(), []);
});

test("setPresence(true) marks a session connected and stores metadata", () => {
  const b = new Bridge();
  b.setPresence("s1", true, { sessionId: "s1", placeId: 42, placeName: "Lobby" });
  assert.equal(b.isConnected("s1"), true);
  const list = b.connectedSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].placeName, "Lobby");
  assert.equal(list[0].placeId, 42);
});

test("setPresence(false) marks a session disconnected", () => {
  const b = new Bridge();
  b.setPresence("s1", true, { sessionId: "s1" });
  b.setPresence("s1", false);
  assert.equal(b.isConnected("s1"), false);
});

test("enqueue to a disconnected session rejects fast", async () => {
  const b = new Bridge();
  await assert.rejects(() => b.enqueue("ghost", "system_info", {}), /not connected/i);
});

test("status() aggregates: pluginConnected true if any session is live", () => {
  const b = new Bridge();
  assert.equal(b.status().pluginConnected, false);
  b.setPresence("s1", true, { sessionId: "s1" });
  assert.equal(b.status().pluginConnected, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/bridge.test.ts`
Expected: FAIL — current `Bridge` has no `isConnected(sessionId)`, `connectedSessions`, or `setPresence(sessionId, …)` signatures.

- [ ] **Step 3: Rewrite `src/services/bridge.ts`**

Replace the entire file with:

```ts
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
  meta: SessionMeta;
}

type EventListener = (event: StudioEvent) => void;

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
        meta: { sessionId },
      };
      this.sessions.set(sessionId, s);
    }
    return s;
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
    s.forcedOffline = !connected;
    if (connected) s.lastPollAt = Date.now();
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
      this.inflight.set(command.id, { resolve, reject, timer });
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
    return id && id.trim() ? id.trim() : DEFAULT_SESSION;
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
      s.lastPollAt = Date.now();
      s.forcedOffline = false;
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
        if (idx !== -1) s.waiters.splice(idx, 1);
      });
      return;
    }

    if (req.method === "POST" && path === "/respond") {
      const sessionId = this.sessionIdOf(req);
      const s = this.ensure(sessionId);
      s.lastPollAt = Date.now();
      s.forcedOffline = false;
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
      s.lastPollAt = Date.now();
      s.forcedOffline = false;
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
```

- [ ] **Step 4: Run the bridge test to verify it passes**

Run: `npx tsx --test test/bridge.test.ts`
Expected: PASS (5 tests).

> Note: `npm run build` still fails until `routes.ts`/`engine.ts` are updated to the new `enqueue(sessionId, …)` signature and `setPresence(sessionId, …)`. That's intentional — the compiler now points at every call site to fix in Phase 2. Do **not** try to fix those here.

- [ ] **Step 5: Commit**

```bash
git add src/services/bridge.ts test/bridge.test.ts
git commit -m "feat(bridge): session-aware queues keyed by x-session-id"
```

---

## Phase 2 — Broker registry binding + routing

### Task 3: Agent→session binding in the registry

**Files:**
- Modify: `src/broker/registry.ts`
- Test: `test/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/registry.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrokerState } from "../src/broker/registry.js";

test("a freshly registered agent has no bound session", () => {
  const s = new BrokerState();
  const id = s.register("worker", undefined, undefined);
  assert.equal(s.boundSessionOf(id), null);
});

test("attach binds, detach clears", () => {
  const s = new BrokerState();
  const id = s.register("worker", undefined, undefined);
  assert.equal(s.attach(id, "sess-A"), true);
  assert.equal(s.boundSessionOf(id), "sess-A");
  assert.equal(s.detach(id), true);
  assert.equal(s.boundSessionOf(id), null);
});

test("attach to an unknown agent returns false", () => {
  const s = new BrokerState();
  assert.equal(s.attach("nope", "sess-A"), false);
});

test("snapshot agents expose boundSession", () => {
  const s = new BrokerState();
  const id = s.register("worker", undefined, undefined);
  s.attach(id, "sess-A");
  const agent = s.snapshot().agents.find((a) => a.clientId === id);
  assert.equal(agent?.boundSession, "sess-A");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test test/registry.test.ts`
Expected: FAIL — `boundSessionOf`/`attach`/`detach` don't exist; `Agent` has no `boundSession`.

- [ ] **Step 3: Implement in `src/broker/registry.ts`**

In the `Agent` interface, add the field (after `role`):

```ts
  /** lead = plans & dispatches · worker = executes tasks · idle = unassigned. */
  role: AgentRole;
  /** sessionId this agent is bound to (its target Place), or null if unbound. */
  boundSession: string | null;
```

In `register(...)`, add `boundSession: null,` to the object literal pushed into `this.agents` (next to `role: "idle",`).

In `CommandLogEntry`, add the two optional fields:

```ts
export interface CommandLogEntry {
  ts: number;
  clientId: string;
  agent: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  error?: string;
  /** The Studio session the command was routed to (multi-Place feed column). */
  sessionId?: string;
  placeName?: string;
}
```

Add these methods to the `BrokerState` class (place them after `setRole`):

```ts
  // --- agent → session binding ------------------------------------------

  /** Bind an agent to a Studio session (its target Place). False if unknown. */
  attach(clientId: string, sessionId: string): boolean {
    const agent = this.agents.get(clientId);
    if (!agent) return false;
    agent.boundSession = sessionId;
    this.notify();
    return true;
  }

  /** Clear an agent's binding. False if unknown. */
  detach(clientId: string): boolean {
    const agent = this.agents.get(clientId);
    if (!agent) return false;
    agent.boundSession = null;
    this.notify();
    return true;
  }

  /** The session an agent is bound to, or null. */
  boundSessionOf(clientId: string): string | null {
    return this.agents.get(clientId)?.boundSession ?? null;
  }

  /** Agents currently bound to a given session (dashboard: warn if >1). */
  agentsBoundTo(sessionId: string): Agent[] {
    return [...this.agents.values()].filter((a) => a.boundSession === sessionId);
  }
```

- [ ] **Step 4: Run the registry test to verify it passes**

Run: `npx tsx --test test/registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/broker/registry.ts test/registry.test.ts
git commit -m "feat(registry): agent→session binding + command-log session fields"
```

---

### Task 4: Session-resolution logic (adaptive + fail-closed)

**Files:**
- Create: `src/broker/resolve.ts`
- Test: `test/routing.test.ts`

This is the heart of "never edit the wrong Place". Extracted into its own pure function so it is unit-testable without HTTP.

- [ ] **Step 1: Write the failing test**

Create `test/routing.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTargetSession } from "../src/broker/resolve.js";

const sess = (id: string, placeName?: string) => ({
  sessionId: id,
  placeName,
  connected: true,
  queued: 0,
  lastPollAt: Date.now(),
});

test("bound session is honored even when others are connected", () => {
  const r = resolveTargetSession({
    bound: "sess-A",
    connected: [sess("sess-A", "Lobby"), sess("sess-B", "Arena")],
  });
  assert.deepEqual(r, { sessionId: "sess-A", autoBind: false });
});

test("unbound + exactly one connected → auto-route and auto-bind", () => {
  const r = resolveTargetSession({ bound: null, connected: [sess("sess-A", "Lobby")] });
  assert.deepEqual(r, { sessionId: "sess-A", autoBind: true });
});

test("unbound + zero connected → throws not-connected", () => {
  assert.throws(
    () => resolveTargetSession({ bound: null, connected: [] }),
    /not connected/i,
  );
});

test("unbound + more than one connected → fail-closed, lists choices", () => {
  assert.throws(
    () => resolveTargetSession({ bound: null, connected: [sess("a", "Lobby"), sess("b", "Arena")] }),
    /Lobby[\s\S]*Arena/,
  );
});

test("bound to a now-gone session keeps targeting it (sticky)", () => {
  const r = resolveTargetSession({ bound: "sess-A", connected: [sess("sess-B", "Arena")] });
  assert.deepEqual(r, { sessionId: "sess-A", autoBind: false });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test test/routing.test.ts`
Expected: FAIL — `src/broker/resolve.ts` does not exist.

- [ ] **Step 3: Implement `src/broker/resolve.ts`**

```ts
/**
 * Resolve which Studio session a command should target. This is the single
 * place that enforces "never edit the wrong Place":
 *   - bound        → use it (sticky: kept even if the session is briefly gone).
 *   - unbound, 1   → use the only connected session, and signal auto-bind.
 *   - unbound, 0   → throw "not connected".
 *   - unbound, >1  → fail-closed: refuse and list the choices to attach to.
 */

import { StudioError } from "../services/errors.js";
import type { SessionStatus } from "../types.js";

export interface ResolveInput {
  /** The calling agent's bound sessionId, or null. */
  bound: string | null;
  /** Currently-connected sessions. */
  connected: SessionStatus[];
}

export interface ResolveResult {
  sessionId: string;
  /** True when the broker should record an auto-binding for the agent. */
  autoBind: boolean;
}

function label(s: SessionStatus): string {
  const name = s.placeName ?? "(unnamed place)";
  const pid = s.placeId ? ` placeId=${s.placeId}` : "";
  return `${name}${pid} [${s.sessionId}]`;
}

export function resolveTargetSession(input: ResolveInput): ResolveResult {
  const { bound, connected } = input;
  if (bound) {
    // Sticky: honor the binding even if the session is momentarily silent
    // (playtest / reconnect). enqueue surfaces a clear error if it never returns.
    return { sessionId: bound, autoBind: false };
  }
  if (connected.length === 0) {
    throw new StudioError(
      "No Studio session is connected. Open a Place, install the roblox-mcp-pro plugin, " +
        "and click Connect.",
    );
  }
  if (connected.length === 1) {
    return { sessionId: connected[0].sessionId, autoBind: true };
  }
  const choices = connected.map((s) => `  • ${label(s)}`).join("\n");
  throw new StudioError(
    `${connected.length} Studio Places are connected — refusing to guess which one to edit. ` +
      `Bind to one first with manage_agents { action:"attach", place:"<name>" }.\nConnected Places:\n${choices}`,
  );
}
```

- [ ] **Step 4: Run the routing test to verify it passes**

Run: `npx tsx --test test/routing.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/broker/resolve.ts test/routing.test.ts
git commit -m "feat(broker): fail-closed session resolution for multi-Place routing"
```

---

### Task 5: Wire routing + agent actions + metadata into routes.ts

**Files:**
- Modify: `src/broker/routes.ts`

This task is large; do the edits in order, then build.

- [ ] **Step 1: Add imports**

At the top of `src/broker/routes.ts`, add to the existing imports:

```ts
import { resolveTargetSession } from "./resolve.js";
import type { SessionMeta } from "../types.js";
```

- [ ] **Step 2: Add `attach`/`detach`/`sessions` to `runAgents`**

`runAgents` needs the bridge to list sessions, so change its signature to accept the bridge and the connected sessions via a getter. Replace the function declaration line:

```ts
function runAgents(state: BrokerState, fromClientId: string, args: unknown): Record<string, unknown> {
```

with:

```ts
function runAgents(
  state: BrokerState,
  fromClientId: string,
  args: unknown,
  liveSessions: () => SessionStatus[],
): Record<string, unknown> {
```

Add `SessionStatus` to the existing `../types.js` import. Extend the `action` enum destructure type to include the new actions and a `place` field:

```ts
  const a = (args ?? {}) as {
    action?: string;
    to?: string;
    role?: string;
    subject?: string;
    body?: string;
    unreadOnly?: boolean;
    messageId?: string;
    messageIds?: string[];
    place?: string;
    session?: string;
  };
```

In the `list` case, add `boundSession` to each mapped agent:

```ts
    case "list": {
      const agents = state.snapshot().agents.map((ag) => ({
        clientId: ag.clientId,
        name: ag.name,
        version: ag.version,
        cwd: ag.cwd,
        role: ag.role,
        boundSession: ag.boundSession,
        lastSeenAt: ag.lastSeenAt,
        self: ag.clientId === fromClientId,
      }));
      return { ok: true, you: fromClientId, lead: state.lead()?.name ?? null, agents };
    }
```

Add these three new cases before the `default:` case:

```ts
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
      // Match by sessionId first, then by case-insensitive Place name.
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
      if (!state.attach(fromClientId, matches[0].sessionId)) {
        throw new StudioError("you are not registered with the broker.");
      }
      return {
        ok: true,
        attached: { sessionId: matches[0].sessionId, placeName: matches[0].placeName ?? null },
      };
    }
    case "detach": {
      state.detach(fromClientId);
      return { ok: true, detached: true };
    }
```

Update the `list` description note nothing else.

- [ ] **Step 3: Update the `runAgents` call site**

In the `/rpc/call` handler, find:

```ts
              : tool === "manage_agents"
                ? runAgents(state, clientId, args)
```

Replace with:

```ts
              : tool === "manage_agents"
                ? runAgents(state, clientId, args, () => bridge.connectedSessions())
```

- [ ] **Step 4: Resolve the target session before forwarding to Studio**

In `/rpc/call`, the command currently forwards via `await bridge.enqueue(tool, args)`. Replace that single expression (inside the `else` branch where `result = … : await bridge.enqueue(tool, args);`) so non-broker tools resolve a session first. Change:

```ts
          result =
            tool === "manage_sync"
              ? await runSync(args)
              : tool === "manage_agents"
                ? runAgents(state, clientId, args, () => bridge.connectedSessions())
                : await bridge.enqueue(tool, args);
```

to:

```ts
          if (tool === "manage_sync") {
            result = await runSync(args, () => bridge.connectedSessions());
          } else if (tool === "manage_agents") {
            result = runAgents(state, clientId, args, () => bridge.connectedSessions());
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
```

Declare the log helpers near the top of the `/rpc/call` handler, next to `let ok = true;`:

```ts
      let sessionForLog: string | undefined;
      let placeForLog: string | undefined;
```

And add them to the `state.recordCommand({ … })` call:

```ts
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
```

- [ ] **Step 5: Make the playtest window per-session**

The single `playtest` variable becomes a per-session map. Replace:

```ts
  let playtest: { kind: string; startedAtSec: number; untilMs: number } | null = null;
  const PLAYTEST_RECONNECT_GRACE_MS = 30_000;

  function playtestWindow(): { kind: string; startedAtSec: number; untilMs: number } | null {
    if (playtest && Date.now() > playtest.untilMs) playtest = null;
    return playtest;
  }
```

with:

```ts
  const playtests = new Map<string, { kind: string; startedAtSec: number; untilMs: number }>();
  const PLAYTEST_RECONNECT_GRACE_MS = 30_000;

  function playtestWindow(sessionId: string): { kind: string; startedAtSec: number; untilMs: number } | null {
    const pt = playtests.get(sessionId);
    if (pt && Date.now() > pt.untilMs) {
      playtests.delete(sessionId);
      return null;
    }
    return pt ?? null;
  }
```

In `/rpc/call`, the suspended-check uses `playtestWindow()` and `bridge.status().pluginConnected`. Resolve the session up-front for this check too. Replace the suspended block's guard logic so it reads the target session's playtest window and connection. Concretely, at the start of the `try` in `/rpc/call`, before the suspended check, compute:

```ts
        const targetSession =
          tool === "manage_sync" || tool === "manage_agents"
            ? null
            : state.boundSessionOf(clientId) ??
              (bridge.connectedSessions().length === 1
                ? bridge.connectedSessions()[0].sessionId
                : null);
        const pt = targetSession ? playtestWindow(targetSession) : null;
        const suspended = pt !== null && targetSession !== null && !bridge.isConnected(targetSession);
```

Then in the suspended branch use `pt` (no longer `playtestWindow()!`). In the success branch where `studioAction === "play" || "multiplayer"`, record into the map keyed by the resolved session:

```ts
            if (r?.ok === true && targetSession) {
              playtests.set(targetSession, {
                kind: studioAction,
                startedAtSec: typeof r.started_at === "number" ? r.started_at : Math.floor(Date.now() / 1000),
                untilMs: Date.now() + (typeof r.duration === "number" ? r.duration : 30) * 1000 + PLAYTEST_RECONNECT_GRACE_MS,
              });
            }
```

and for `playtest_status` returning `running === false`: `if (r && r.running === false && targetSession) playtests.delete(targetSession);`

> When the resolved-target logic below (Step 4) and this guard both run, keep them consistent: both call `resolveTargetSession`/`boundSessionOf` against the same inputs. If this becomes duplicated, hoist a single `const target = …` at the top of `try` and reuse it in both places.

- [ ] **Step 6: Accept session metadata on `/plugin/status`**

Replace the `/plugin/status` handler:

```ts
    if (method === "POST" && path === "/plugin/status") {
      const body = await readJson(req);
      bridge.setPluginPresence(body.connected === true);
      void refreshStudio();
      broadcast();
      sendJson(res, 200, { ok: true });
      return true;
    }
```

with:

```ts
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
```

> `bridge.setPluginPresence` no longer exists (renamed to `setPresence(sessionId, …)` in Task 2). The compiler will flag any other caller — there are none besides this route.

- [ ] **Step 7: Add the human `/api/agents/attach` endpoint**

After the existing `/api/agents/role` handler block, add:

```ts
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
```

- [ ] **Step 8: Build and confirm the compiler is satisfied except for engine.ts/dashboard**

Run: `npm run build`
Expected: errors remaining are now only in `src/sync/engine.ts` (calls `bridge.enqueue(tool, args)` with the old 2-arg signature) and possibly `buildSnapshot` referencing `studio`. Fix engine in Task 6; dashboard data shape in Task 8. If you see errors in `routes.ts` itself, fix them before continuing.

- [ ] **Step 9: Commit**

```bash
git add src/broker/routes.ts
git commit -m "feat(broker): route /rpc/call per-session; attach/detach/sessions actions; per-session playtest; /api/agents/attach"
```

---

### Task 6: Pin the sync engine to one session (Q11 fail-closed)

**Files:**
- Modify: `src/sync/engine.ts`
- Modify: `src/broker/routes.ts` (the `runSync` helper)

- [ ] **Step 1: Update `runSync` to resolve + pin a session on start**

In `src/broker/routes.ts`, change the `runSync` signature and `start` case. Replace:

```ts
async function runSync(args: unknown): Promise<Record<string, unknown>> {
```

with:

```ts
async function runSync(
  args: unknown,
  liveSessions: () => SessionStatus[],
): Promise<Record<string, unknown>> {
```

In its `start` case, resolve exactly one session (fail-closed) and pass it to the engine:

```ts
    case "start": {
      const sessions = liveSessions();
      if (sessions.length === 0) throw new StudioError("No Studio session is connected to sync.");
      let pinned = sessions[0].sessionId;
      if (sessions.length > 1) {
        const want = (a as { session?: string; place?: string }).session
          ?? (a as { session?: string; place?: string }).place;
        const lower = (want ?? "").trim().toLowerCase();
        const match = sessions.find(
          (s) => s.sessionId === want || (s.placeName ?? "").toLowerCase() === lower,
        );
        if (!match) {
          const names = sessions.map((s) => s.placeName ?? s.sessionId).join(", ");
          throw new StudioError(
            `${sessions.length} Places are connected — sync needs one. ` +
              `Pass place:"<name>" to manage_sync start. Connected: ${names}.`,
          );
        }
        pinned = match.sessionId;
      }
      return (await syncEngine.start(
        a.roots,
        a.mode,
        a.initialDirection,
        a.syncDir,
        pinned,
      )) as unknown as Record<string, unknown>;
    }
```

(Also widen the `a` cast at the top of `runSync` to include `session?: string; place?: string;`.)

Update the two internal callers of `runSync` (the `/plugin/sync` POST handler and the `/rpc/call` manage_sync branch) to pass `() => bridge.connectedSessions()`. The `/rpc/call` one was already updated in Task 5 Step 4. For `/plugin/sync`:

```ts
        const result = await runSync(body, () => bridge.connectedSessions());
```

- [ ] **Step 2: Thread the pinned session through the engine**

In `src/sync/engine.ts`:
1. Add a private field on the engine class/object: `private pinnedSession = "default";` (match the file's existing style — if it's a closure-based singleton, add a module-level `let pinnedSession = "default";`).
2. Update the `start(...)` signature to accept a trailing `sessionId: string = "default"` parameter and assign `this.pinnedSession = sessionId;` (or the module variable) at the top of `start`.
3. **Mechanical, compiler-enforced:** every `bridge.enqueue(tool, args)` in this file becomes `bridge.enqueue(this.pinnedSession, tool, args)` (or `bridge.enqueue(pinnedSession, tool, args)`). The build will not pass until all are updated — let the compiler list them. Use the bound session so snapshot/pull/push only ever touch the pinned Place.

- [ ] **Step 3: Build to confirm all enqueue call sites are fixed**

Run: `npm run build`
Expected: PASS for `engine.ts`/`routes.ts`. (Dashboard data-shape errors, if any, are handled in Task 8.)

- [ ] **Step 4: Re-run all unit tests**

Run: `npx tsx --test test/bridge.test.ts test/registry.test.ts test/routing.test.ts`
Expected: PASS (14 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/sync/engine.ts src/broker/routes.ts
git commit -m "feat(sync): pin sync engine to one resolved session; fail-closed when ambiguous"
```

---

## Phase 3 — Studio plugin (Luau)

### Task 7: Plugin mints and sends a sessionId + metadata

**Files:**
- Modify: `plugin/src/Bridge.luau`
- Modify: `plugin/src/init.server.luau`

- [ ] **Step 1: Add a session id + header to `Bridge.luau`**

At the top of `plugin/src/Bridge.luau`, after `local authToken: string? = nil`, add:

```lua
-- A stable id for this Studio session, minted once per plugin load. Sent on
-- every request so the broker routes commands to this Place only.
local sessionId: string = HttpService:GenerateGUID(false)

function Bridge.sessionId(): string
	return sessionId
end
```

Update `headers()` to always include the session id:

```lua
local function headers(): { [string]: string }
	local h = { ["Content-Type"] = "application/json", ["x-session-id"] = sessionId }
	if authToken and authToken ~= "" then
		h["x-auth-token"] = authToken
	end
	return h
end
```

- [ ] **Step 2: Send metadata on presence**

Replace `Bridge.notifyPresence` in `Bridge.luau`:

```lua
-- Tell the broker we just connected/disconnected, with this session's identity,
-- so the dashboard updates immediately and routing knows which Place this is.
function Bridge.notifyPresence(connected: boolean, meta: { [string]: any }?)
	local body: { [string]: any } = { connected = connected, sessionId = sessionId }
	if meta then
		for k, v in meta do
			body[k] = v
		end
	end
	pcall(function()
		HttpService:RequestAsync({
			Url = baseUrl .. "/plugin/status",
			Method = "POST",
			Headers = headers(),
			Body = HttpService:JSONEncode(body),
		})
	end)
end
```

- [ ] **Step 3: Gather and pass metadata from `init.server.luau`**

In `plugin/src/init.server.luau`, add a `require` for the existing place-name resolver near the other requires:

```lua
local resolvePlaceName = require(script.PlaceName)
```

Add a helper that builds the metadata table (place after the `log` function):

```lua
local function sessionMeta(): { [string]: any }
	local meta: { [string]: any } = {}
	meta.placeId = game.PlaceId
	meta.placeName = resolvePlaceName()
	local jobId = game.JobId
	if jobId and jobId ~= "" then
		meta.jobId = jobId
	end
	return meta
end
```

In `setConnected`, pass the metadata on connect (and nothing extra on disconnect):

```lua
	task.spawn(function()
		Bridge.notifyPresence(value, if value then sessionMeta() else nil)
	end)
```

Also update the `plugin.Unloading` handler's `Bridge.notifyPresence(false)` call — it already passes only `false`, which is fine (meta is optional).

- [ ] **Step 4: Build and install the plugin**

Run: `./build.ps1`
Expected: builds `.rbxmx` via rojo and installs to `%LOCALAPPDATA%\Roblox\Plugins`. Restart Studio (or toggle the MCP button) afterward.

- [ ] **Step 5: Commit**

```bash
git add plugin/src/Bridge.luau plugin/src/init.server.luau
git commit -m "feat(plugin): mint per-session id, send x-session-id + Place metadata"
```

---

## Phase 4 — Tool schema

### Task 8: Expose sessions/attach/detach in manage_agents

**Files:**
- Modify: `src/tools/agents.ts`

- [ ] **Step 1: Extend the input schema**

In `src/tools/agents.ts`, update the `action` enum and add `place`/`session` fields:

```ts
    action: z
      .enum(["list", "set_role", "send", "inbox", "read", "done", "sessions", "attach", "detach"])
      .describe(
        "list: connected agents (roles + bound Place) · set_role: claim lead/worker/idle · " +
          "send: deliver a task/message · inbox: messages addressed to you · " +
          "read: mark unread read · done: mark a message complete · " +
          "sessions: list connected Studio Places · attach: bind yourself to a Place (by name) · " +
          "detach: unbind.",
      ),
```

Add after the `messageIds` field, before the closing `.strict()`:

```ts
    place: z
      .string()
      .max(200)
      .optional()
      .describe(
        "For 'attach': the Place name to bind to (e.g. 'Lobby'). Case-insensitive; " +
          "if the name is ambiguous, attach by 'session' instead.",
      ),
    session: z
      .string()
      .max(100)
      .optional()
      .describe("For 'attach': an exact sessionId (use when Place names collide)."),
```

- [ ] **Step 2: Add result formatting for the new actions**

In the `switch (input.action)` block, add cases before `default:`:

```ts
          case "sessions": {
            const sessions = (result.sessions as { sessionId: string; placeName?: string; placeId?: number; boundAgents?: string[] }[]) ?? [];
            if (!sessions.length) return ok(result, "No Studio Places connected.");
            const lines = sessions.map((s) => {
              const who = s.boundAgents?.length ? `  ← ${s.boundAgents.join(", ")}` : "";
              return `• ${s.placeName ?? "(unnamed)"}${s.placeId ? ` (placeId ${s.placeId})` : ""}  [${s.sessionId}]${who}`;
            });
            return ok(result, `${sessions.length} Place(s) connected:\n${lines.join("\n")}`);
          }
          case "attach": {
            const at = result.attached as { placeName?: string; sessionId?: string } | undefined;
            return ok(result, `Bound to '${at?.placeName ?? at?.sessionId ?? "?"}'. Your commands now target this Place.`);
          }
          case "detach":
            return ok(result, "Unbound. With >1 Place connected, attach before running commands.");
```

- [ ] **Step 3: Update the tool description text**

In the `description` string of `registerTool`, append a sentence so agents discover the feature:

```
"\nMulti-Place: when several Studio Places are connected, run action:'sessions' to see them, " +
"then action:'attach' with place:'<name>' to bind yourself before editing — commands refuse to " +
"run while you're unbound and more than one Place is connected."
```

- [ ] **Step 4: Build + regenerate docs**

Run: `npm run build && npm run docs`
Expected: PASS; `.agents/skills/roblox-mcp-pro/references/tools.md` regenerates with the new `manage_agents` schema.

- [ ] **Step 5: Commit**

```bash
git add src/tools/agents.ts .agents/skills/roblox-mcp-pro/references/tools.md
git commit -m "feat(tools): manage_agents sessions/attach/detach (bind by Place name)"
```

---

## Phase 5 — Dashboard

### Task 9: Multi-session snapshot + cards + feed column

**Files:**
- Modify: `src/broker/routes.ts` (`buildSnapshot`)
- Modify: `src/broker/dashboard.ts`

- [ ] **Step 1: Emit `sessions[]` from `buildSnapshot`**

In `src/broker/routes.ts`, replace the `studio` field in `buildSnapshot` with a `sessions` array sourced from the bridge, while keeping `studio` for backward-compatible single-Place display:

```ts
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
      sync: syncEngine.status(),
      places: places !== null ? { dir: placesDir, list: places } : null,
      totalCommands,
      agents: snap.agents,
      recent: snap.recent,
      mailbox: snap.mailbox,
    };
  }
```

- [ ] **Step 2: Render session cards in the dashboard**

In `src/broker/dashboard.ts`, locate the client-side render function that consumes the snapshot (search for `studio` and for where `agents`/`recent` are rendered — grep anchors: `data.studio`, `data.agents`, `renderState` / `render(`). Add a "Connected Places" section that iterates `data.sessions`:
- For each session render a card: `placeName` (bold), `placeId`, `jobId` (short), a green/red dot from `connected`, `queued`, and the list of `boundAgents` names.
- If `boundAgents.length > 1`, render an **amber warning** badge on the card ("⚠ 2 agents bound — expected 1") using the existing `--amber` / `--amber-bg` CSS variables.
- Place this section above the existing single-`studio` panel; keep the `studio` panel as a fallback shown only when `data.sessions.length <= 1`.

Concretely, add a helper alongside the other render helpers:

```js
function renderSessions(sessions) {
  if (!sessions || !sessions.length) return '';
  return sessions.map(s => {
    const dot = s.connected ? 'dot-green' : 'dot-red';
    const warn = (s.boundAgents && s.boundAgents.length > 1)
      ? '<span class="badge badge-amber">⚠ ' + s.boundAgents.length + ' agents bound</span>' : '';
    const who = (s.boundAgents || []).map(a => a.name).join(', ') || '<span class="faint">unbound</span>';
    return '<div class="card session-card">'
      + '<div class="session-head"><span class="' + dot + '"></span>'
      + '<b>' + (s.placeName || '(unnamed Place)') + '</b>' + warn + '</div>'
      + '<div class="faint">placeId ' + (s.placeId || '—') + ' · queued ' + s.queued + '</div>'
      + '<div>agents: ' + who + '</div>'
      + '</div>';
  }).join('');
}
```

Insert `renderSessions(data.sessions)` into the page's main render output (where the `studio` panel HTML is assembled). Reuse existing `.card`, `.faint`, `.dot-green`/`.dot-red`, `.badge` classes if present; if `.badge-amber`/`.session-card` don't exist, add minimal CSS rules next to the existing badge/card rules in the `<style>` block.

- [ ] **Step 3: Add the session column to the activity feed**

Find where `data.recent` rows are rendered (grep anchor: `recent` and `tool` and `agent` in `dashboard.ts`). Add a column that shows `r.placeName || r.sessionId || '—'` for each command row, so a human can see which Place every command hit. Add a matching header cell.

- [ ] **Step 4: Build and verify the dashboard manually**

Run: `npm run build`
Then start a broker and open the dashboard:
Run: `node dist/broker/main.js` (opens the dashboard at `http://127.0.0.1:3690/`)
Open two Studio Places (both with the rebuilt plugin) and click Connect in each. Expected: two session cards appear with distinct Place names; binding an agent shows under the correct card.

- [ ] **Step 5: Commit**

```bash
git add src/broker/routes.ts src/broker/dashboard.ts
git commit -m "feat(dashboard): per-Place session cards + session column in activity feed"
```

---

## Phase 6 — Workflow docs

### Task 10: Document the Lead/Worker + attach-by-name workflow

**Files:**
- Modify: `.agents/skills/roblox-mcp-pro/SKILL.md`

- [ ] **Step 1: Add a "Multiple Places at once" section**

Add a section to `SKILL.md` (curated advice; not the generated `tools.md`) describing:
- The 1-Lead + 1-Worker pattern: human talks to the Lead; Lead plans and `manage_agents send`s the task (including the Place name) to the Worker; Worker runs `manage_agents attach {place:"X"}` then executes; Lead can `attach` read-only to inspect.
- The safety rule: with >1 Place connected, an unbound agent's commands are refused with a list — always `attach` first.
- `manage_agents sessions` to discover connected Place names.
- For sync with multiple Places: pass `place:"X"` to `manage_sync` start.

Keep it concise and consistent with the existing SKILL.md voice.

- [ ] **Step 2: Commit**

```bash
git add .agents/skills/roblox-mcp-pro/SKILL.md
git commit -m "docs(skill): multi-Place Lead/Worker + attach-by-name workflow"
```

---

## Phase 7 — End-to-end verification

### Task 11: Live two-Place smoke test

**Files:**
- None (manual verification against live Studio).

- [ ] **Step 1: Rebuild everything**

Run: `npm run build && ./build.ps1`
Restart Studio.

- [ ] **Step 2: One Place, unbound — auto-route still works (backward compat)**

Open ONE Place, connect the plugin. From an agent run `scene_overview`. Expected: succeeds without any attach (adaptive auto-route + auto-bind). Run `manage_agents list` — your agent shows `boundSession` set to that Place's session.

- [ ] **Step 3: Two Places, unbound — fail-closed**

Open a SECOND Place, connect it. From a *fresh* agent (or after `manage_agents detach`) run `mutate_instances` (any mutation). Expected: refused with an error listing both Places by name. No mutation occurs in either Place.

- [ ] **Step 4: Attach by name — precise routing**

Run `manage_agents attach {place:"<Place A name>"}`, then create a clearly-named Part via `mutate_instances`. Verify in Studio that the Part appears **only in Place A**, not Place B. Repeat attaching to Place B and confirm isolation.

- [ ] **Step 5: Lead/Worker dispatch**

With two agents: agent1 `set_role lead`, agent2 `set_role worker`. Lead `send`s "edit Place B: add a SpawnLocation" to the worker. Worker `inbox` → `attach {place:"Place B"}` → executes. Confirm the SpawnLocation lands in Place B only, and the dashboard's activity feed shows the command against Place B.

- [ ] **Step 6: Sync pin**

With two Places connected, run `manage_sync start` with no place. Expected: refused, lists both. Run `manage_sync start {place:"Place A"}`. Expected: starts; edits mirror only Place A's folder.

- [ ] **Step 7: Final full test run + commit any fixes**

Run: `npx tsx --test test/bridge.test.ts test/registry.test.ts test/routing.test.ts`
Expected: PASS (14 tests). Commit any fixes discovered during the smoke test with focused messages.

---

## Self-Review

**Spec coverage (vs. the 11 locked grill decisions):**
- Q1 (sessionId + metadata) → Task 1, Task 7. ✅
- Q2 (bind-once attach) → Task 3, Task 5 (Step 2), Task 8. ✅ (per-call override intentionally dropped — see Scope note.)
- Q3 (adaptive + fail-closed + auto-bind) → Task 4, Task 5 (Step 4). ✅
- Q4 (plugin mints id; per-session bridge) → Task 2, Task 7. ✅
- Q5 (manage_agents sessions/attach/detach; boundSession in list) → Task 5 (Step 2), Task 8. ✅
- Q6 (roles as convention) → unchanged existing machinery; documented in Task 10. ✅
- Q7 (session cards + feed column + >1-agent warning) → Task 9. ✅
- Q8 (`/api/agents/attach`) → Task 5 (Step 7). ✅
- Q9 (sticky binding + per-session playtest grace) → Task 4 (sticky branch), Task 5 (Step 5). ✅
- Q10 (Lead dispatch → Worker attach) → Task 10 docs; mechanics exist. ✅
- Q11 (sync pin, fail-closed) → Task 6. ✅

**Placeholder scan:** Dashboard (Task 9) and engine.ts (Task 6 Step 2) use grep-anchored, compiler-enforced mechanical edits rather than full pasted code because both files are large (1056 / 683 lines) and their internal style must be matched in place. Every contract (data shapes, signatures) those edits depend on is fully specified. No "TBD"/"add error handling"/"similar to" placeholders remain.

**Type consistency:** `enqueue(sessionId, tool, args, opts?)`, `setPresence(sessionId, connected, meta?)`, `isConnected(sessionId)`, `connectedSessions()`/`allSessions()`, `attach`/`detach`/`boundSessionOf`/`agentsBoundTo`, `resolveTargetSession({bound, connected})`, and `SessionMeta`/`SessionStatus` field names are used identically across Tasks 1–9. `bridge.setPluginPresence` is fully removed and its sole caller updated (Task 5 Step 6).
