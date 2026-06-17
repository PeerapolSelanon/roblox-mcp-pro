#!/usr/bin/env node
/**
 * Hermetic test for the license gate's local decision logic — the revenue path.
 * No network, no real ~/.roblox-mcp-pro: HOME is redirected to a temp dir before
 * the module loads (so config's STATE_DIR resolves there), and the license proxy
 * URL is pointed at a dead port so any provider call fails fast as "unreachable".
 *
 *   - trial state machine: fresh / mid-trial / day-14 boundary / expired
 *   - offline grace: previously-valid key, network down, within vs past the window
 *
 * Run: node scripts/license-smoke.mjs  (needs dist/)
 */

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = 14; // config default
const GRACE_DAYS = 7; // config default

// Redirect home + kill the proxy BEFORE importing the licensing module: config.ts
// captures STATE_DIR and LICENSE_PROXY_URL at import time.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "rmp-lic-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.RMP_LICENSE_PROXY_URL = "http://127.0.0.1:1"; // connection refused → unreachable
delete process.env.ROBLOX_MCP_LICENSE;

const STATE_DIR = path.join(home, ".roblox-mcp-pro");
const STATE_FILE = path.join(STATE_DIR, "state.json");

const { resolveLicense } = await import("../dist/licensing/license.js");

const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY_MS).toISOString();
const reset = async () => {
  await fs.rm(STATE_DIR, { recursive: true, force: true });
  await fs.mkdir(STATE_DIR, { recursive: true });
};
const writeState = (store) => fs.writeFile(STATE_FILE, JSON.stringify(store), "utf8");

const failures = [];
function check(label, cond, detail) {
  if (!cond) failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}

// --- Trial state machine (no key) ---
await reset();
delete process.env.ROBLOX_MCP_LICENSE;
let s = await resolveLicense();
check("fresh trial → status trial", s.status === "trial", `got ${s.status}`);
check("fresh trial → full days", s.daysLeft === TRIAL_DAYS, `got ${s.daysLeft}`);
check("fresh trial → persists trialStartedAt", JSON.parse(await fs.readFile(STATE_FILE, "utf8")).trialStartedAt != null);

await reset();
await writeState({ trialStartedAt: iso(10) });
s = await resolveLicense();
check("mid trial → status trial", s.status === "trial", `got ${s.status}`);
check("mid trial → 4 days left", s.daysLeft === TRIAL_DAYS - 10, `got ${s.daysLeft}`);

await reset();
await writeState({ trialStartedAt: iso(TRIAL_DAYS) }); // exactly day 14 → used up
s = await resolveLicense();
check("day-14 boundary → locked", s.status === "locked", `got ${s.status}`);
check("day-14 boundary → 0 days left", s.daysLeft === 0, `got ${s.daysLeft}`);

await reset();
await writeState({ trialStartedAt: iso(30) });
s = await resolveLicense();
check("expired trial → locked", s.status === "locked", `got ${s.status}`);

// --- Offline grace (key present, network down) ---
process.env.ROBLOX_MCP_LICENSE = "test-key";

await reset();
await writeState({ licenseKey: "test-key", instanceId: "inst-1", lastValidationOk: true, lastValidatedAt: iso(2) });
s = await resolveLicense();
check("offline within grace → licensed", s.status === "licensed", `got ${s.status} (${s.message})`);

await reset();
await writeState({ licenseKey: "test-key", instanceId: "inst-1", lastValidationOk: true, lastValidatedAt: iso(GRACE_DAYS + 3) });
s = await resolveLicense();
check("offline past grace → locked", s.status === "locked", `got ${s.status} (${s.message})`);

// --- cleanup ---
await fs.rm(home, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`license-smoke: FAIL (${failures.length})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("license-smoke: OK — trial machine + offline grace.");
process.exit(0);
