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
