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
