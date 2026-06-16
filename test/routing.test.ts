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
