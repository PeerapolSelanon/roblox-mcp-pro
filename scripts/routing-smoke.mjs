#!/usr/bin/env node
/**
 * Hermetic test for the broker's session routing — the "never edit the wrong
 * Place" guarantee. No Studio, no network, no port bind.
 *
 *   L1: resolveTargetSession decision matrix (pure).
 *   L2: the real /rpc/call dispatch via createBrokerRoutes + a fake Bridge,
 *       driven through the actual handle() with fake req/res. This is the layer
 *       that catches wiring bugs — e.g. a tool that forgets to resolve the
 *       bound session before acting (the multi-place capture bug).
 *
 * capture_studio's happy path spawns PowerShell, so only its fail-closed branch
 * (which throws before any capture) is exercised here.
 *
 * Run: node scripts/routing-smoke.mjs  (needs dist/)
 */

import { Readable } from "node:stream";

const { resolveTargetSession } = await import("../dist/broker/resolve.js");
const { createBrokerRoutes } = await import("../dist/broker/routes.js");

const failures = [];
const check = (label, cond, detail) => {
  if (!cond) failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};
const threw = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

// --- L1: resolveTargetSession (pure) ---
const s1 = { sessionId: "sess-1", placeName: "Lobby" };
const s2 = { sessionId: "sess-2", placeName: "Arena" };

const bound = resolveTargetSession({ bound: "sess-1", connected: [s1, s2] });
check("L1 bound → sticky sessionId", bound.sessionId === "sess-1" && bound.autoBind === false, JSON.stringify(bound));

check("L1 zero connected → throws", threw(() => resolveTargetSession({ bound: null, connected: [] })));

const one = resolveTargetSession({ bound: null, connected: [s1] });
check("L1 one connected → auto-bind", one.sessionId === "sess-1" && one.autoBind === true, JSON.stringify(one));

check("L1 >1 unbound → fail-closed throw", threw(() => resolveTargetSession({ bound: null, connected: [s1, s2] })));

// --- L2: real /rpc/call dispatch through handle() with a fake Bridge ---
function makeBridge(sessions) {
  const enqueueCalls = [];
  const bridge = {
    connectedSessions: () => sessions,
    allSessions: () => sessions.map((s) => ({ ...s, connected: true })),
    isConnected: (id) => sessions.some((s) => s.sessionId === id),
    status: () => ({ pluginConnected: sessions.length > 0 }),
    setPresence: () => {},
    onEvent: () => () => {},
    enqueue: (sessionId, tool, args) => {
      enqueueCalls.push({ sessionId, tool, args });
      return Promise.resolve({ ok: true, ranOn: sessionId });
    },
  };
  return { bridge, enqueueCalls };
}

/** Drive routes.handle() like an HTTP POST and return the parsed JSON body. */
async function rpc(routes, path, bodyObj) {
  const req = Readable.from([JSON.stringify(bodyObj)]);
  req.method = "POST";
  let body = "";
  const res = {
    writableEnded: false,
    writeHead() {},
    write() {},
    end(b) {
      body = b ?? "";
      this.writableEnded = true;
    },
  };
  await routes.handle(req, res, new URL(`http://127.0.0.1${path}`));
  return body ? JSON.parse(body) : {};
}

const register = (routes) => rpc(routes, "/rpc/register", { name: "test-agent" });
const call = (routes, clientId, tool, args) => rpc(routes, "/rpc/call", { clientId, tool, args });

// fail-closed: 2 Places, unbound agent, a plugin tool → refused, nothing enqueued.
{
  const { bridge, enqueueCalls } = makeBridge([s1, s2]);
  const routes = createBrokerRoutes(bridge);
  const { clientId } = await register(routes);
  const r = await call(routes, clientId, "execute_luau", { source: "return 1" });
  check("L2 fail-closed → ok:false", r.ok === false, JSON.stringify(r));
  check("L2 fail-closed → lists Places", /Places are connected/i.test(r.error ?? ""), r.error);
  check("L2 fail-closed → no enqueue", enqueueCalls.length === 0, `enqueued ${enqueueCalls.length}`);
}

// auto-bind: exactly 1 Place → routes to it without an explicit attach.
{
  const { bridge, enqueueCalls } = makeBridge([s1]);
  const routes = createBrokerRoutes(bridge);
  const { clientId } = await register(routes);
  await call(routes, clientId, "execute_luau", { source: "return 1" });
  check("L2 auto-bind → enqueued once", enqueueCalls.length === 1, `enqueued ${enqueueCalls.length}`);
  check("L2 auto-bind → correct session", enqueueCalls[0]?.sessionId === "sess-1", JSON.stringify(enqueueCalls[0]));
}

// bound: attach to one of two Places → every command targets that Place only.
{
  const { bridge, enqueueCalls } = makeBridge([s1, s2]);
  const routes = createBrokerRoutes(bridge);
  const { clientId } = await register(routes);
  const att = await call(routes, clientId, "manage_agents", { action: "attach", place: "Arena" });
  check("L2 attach → ok", att.ok === true && att.result?.ok === true, JSON.stringify(att));
  await call(routes, clientId, "execute_luau", { source: "return 1" });
  check("L2 bound → enqueue targets bound Place", enqueueCalls[0]?.sessionId === "sess-2", JSON.stringify(enqueueCalls[0]));
}

// capture_studio: fail-closed before any PowerShell when unbound + >1 Place.
{
  const { bridge, enqueueCalls } = makeBridge([s1, s2]);
  const routes = createBrokerRoutes(bridge);
  const { clientId } = await register(routes);
  const r = await call(routes, clientId, "capture_studio", { fullscreen: false });
  check("L2 capture fail-closed → ok:false", r.ok === false, JSON.stringify(r));
  // Must be the routing refusal, NOT a PowerShell/capture error — proves capture
  // resolves the bound session before doing anything (guards the multi-place bug).
  check("L2 capture fail-closed → routing refusal", /Places are connected/i.test(r.error ?? ""), r.error);
  check("L2 capture fail-closed → no enqueue", enqueueCalls.length === 0);
}

// manage_agents discovery: sessions lists connected Places; list includes self.
{
  const { bridge } = makeBridge([s1, s2]);
  const routes = createBrokerRoutes(bridge);
  const { clientId } = await register(routes);
  const sess = await call(routes, clientId, "manage_agents", { action: "sessions" });
  check("L2 sessions → count 2", sess.result?.count === 2, JSON.stringify(sess.result));
  const list = await call(routes, clientId, "manage_agents", { action: "list" });
  const self = (list.result?.agents ?? []).find((a) => a.self);
  check("L2 list → includes self", Boolean(self), JSON.stringify(list.result));
  const det = await call(routes, clientId, "manage_agents", { action: "detach" });
  check("L2 detach → ok", det.result?.detached === true, JSON.stringify(det.result));
}

if (failures.length > 0) {
  console.error(`routing-smoke: FAIL (${failures.length})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("routing-smoke: OK — resolveTargetSession matrix + broker dispatch (fail-closed/auto-bind/bound).");
process.exit(0);
