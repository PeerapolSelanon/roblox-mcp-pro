/**
 * Manual e2e for the real-time broker lifecycle (Task 5).
 * Spawns the freshly-built broker on an ISOLATED port (3699) so it never
 * touches a real session broker on 3690. Drives /rpc directly.
 *
 * Run: node scripts/test-lifecycle.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BROKER = path.resolve(DIR, "../dist/broker/main.js");
const PKG_VERSION = JSON.parse(readFileSync(path.resolve(DIR, "../package.json"), "utf8")).version;
const PORT = 3699;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ping() {
  try {
    const res = await fetch(`${BASE}/rpc/ping`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
async function register(name) {
  const res = await fetch(`${BASE}/rpc/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, pid: process.pid }),
  });
  return (await res.json()).clientId;
}
async function deregister(clientId) {
  await fetch(`${BASE}/rpc/deregister`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId }),
  });
}

function spawnBroker(extraEnv = {}) {
  const child = spawn(process.execPath, [BROKER], {
    stdio: "ignore",
    env: {
      ...process.env,
      ROBLOX_MCP_PORT: String(PORT),
      ROBLOX_MCP_NO_OPEN_DASHBOARD: "1",
      ...extraEnv,
    },
  });
  return child;
}

async function waitUp(timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await ping()) return true;
    await sleep(100);
  }
  return false;
}
/** Poll until the broker stops answering; return ms elapsed, or -1 if never. */
async function waitDown(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!(await ping())) return Date.now() - t0;
    await sleep(100);
  }
  return -1;
}
/** True if the child process actually exited within the timeout. */
function waitExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => { clearTimeout(t); resolve(true); });
  });
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}: ${detail}`);
}

async function killIfAlive(child) {
  if (await ping()) {
    try { child.kill("SIGKILL"); } catch {}
    await sleep(300);
  }
}

async function scenario1() {
  // Single agent, clean exit (deregister) → broker down within grace (~1.5s).
  const child = spawnBroker();
  if (!(await waitUp())) return record("S1 single clean exit", false, "broker never came up");
  const id = await register("agentA");
  await sleep(300);
  if (!(await ping())) return record("S1 single clean exit", false, "broker died while agent connected");
  await deregister(id);
  const downMs = await waitDown(6000);
  const exited = await waitExit(child, 2000);
  const ok = downMs >= 0 && downMs < 4000 && exited;
  record("S1 single clean exit", ok, ok ? `down ~${downMs}ms, process exited (grace 1500)` : `downMs=${downMs} exited=${exited}`);
  await killIfAlive(child);
}

async function scenario2() {
  // Two agents: one leaves → stays up; both leave → down.
  const child = spawnBroker();
  if (!(await waitUp())) return record("S2 two agents", false, "broker never came up");
  const a = await register("agentA");
  const b = await register("agentB");
  await sleep(300);
  await deregister(a);
  await sleep(2500); // longer than grace — must still be up because B remains
  const stillUp = !!(await ping());
  if (!stillUp) { await killIfAlive(child); return record("S2 two agents", false, "broker died while agentB still connected"); }
  await deregister(b);
  const downMs = await waitDown(6000);
  const exited = await waitExit(child, 2000);
  const ok = downMs >= 0 && downMs < 4000 && exited;
  record("S2 two agents", ok, ok ? `survived 1st leave; down ~${downMs}ms + exited after last leave` : `downMs=${downMs} exited=${exited} after last leave`);
  await killIfAlive(child);
}

async function scenario3() {
  // Crash sim: register then never heartbeat → pruned (TTL 6s) → down ~TTL+tick+grace.
  const child = spawnBroker();
  if (!(await waitUp())) return record("S3 crash (no heartbeat)", false, "broker never came up");
  await register("agentCrash");
  await sleep(300);
  if (!(await ping())) { await killIfAlive(child); return record("S3 crash (no heartbeat)", false, "died too early"); }
  const downMs = await waitDown(15000); // expect ~6s TTL + ~1s tick + 1.5s grace
  const exited = await waitExit(child, 2000);
  const ok = downMs >= 4000 && downMs < 12000 && exited;
  record("S3 crash (no heartbeat)", ok, ok ? `pruned + down/exited in ~${downMs}ms` : `downMs=${downMs} exited=${exited} (expected ~6-9s)`);
  await killIfAlive(child);
}

async function scenario4() {
  // Fresh broker reports current package version (no stale broker lingering).
  const child = spawnBroker();
  if (!(await waitUp())) return record("S4 fresh version", false, "broker never came up");
  const id = await register("agentV");
  const info = await ping();
  const ok = info?.version === PKG_VERSION && info?.broker === "roblox-mcp-pro";
  record("S4 fresh version", ok, `ping.version=${info?.version} vs package=${PKG_VERSION}`);
  await deregister(id);
  await waitDown(6000);
  await killIfAlive(child);
}

async function scenario5() {
  // grace=0: steady-state teardown near-instant; BUT startup floor (3s) must
  // keep the broker alive long enough for its first client even at grace 0.
  const child = spawnBroker({ ROBLOX_MCP_IDLE_SHUTDOWN_MS: "0" });
  if (!(await waitUp())) return record("S5 grace=0", false, "broker never came up");
  // Startup floor check: with NO registration yet, broker must still be up ~1.5s in.
  await sleep(1500);
  const upDuringFloor = !!(await ping());
  // Now register + clean exit → should die fast (<1s).
  const id = await register("agentZero");
  await sleep(300);
  await deregister(id);
  const downMs = await waitDown(4000);
  const exited = await waitExit(child, 2000);
  const fast = downMs >= 0 && downMs < 1500;
  const ok = upDuringFloor && fast && exited;
  record("S5 grace=0", ok, `startupFloorHeld=${upDuringFloor}; steady-state down ~${downMs}ms; exited=${exited}`);
  await killIfAlive(child);
}

async function main() {
  // Refuse to run if something is already on our test port.
  if (await ping()) {
    console.error(`Something is already listening on ${PORT}; aborting to stay safe.`);
    process.exit(2);
  }
  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
  await scenario5();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(failed.length === 0 ? 0 : 1);
}
main();
