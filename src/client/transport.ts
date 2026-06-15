/**
 * Client transport: how each MCP server process talks to the shared broker.
 *
 * The MCP process is always a *client* — it never binds the bridge port itself.
 * On startup it finds the broker (auto-spawning a detached one if none is
 * running) and registers, so any number of AI agents can attach to the single
 * Studio session at once. Tools call `call()`; `studio.ts` wraps it as
 * `callStudio`.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BRIDGE_HOST, BRIDGE_PORT, BRIDGE_TOKEN, COMMAND_TIMEOUT_MS } from "../constants.js";
import { StudioError } from "../services/errors.js";
import { VERSION } from "../version.js";
import type { BridgeStatus } from "../types.js";

const BASE = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;

let clientId: string | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
// Remembered registration so we can transparently re-attach if the broker is
// replaced mid-session (killed, upgraded, crashed) — see recoverBroker().
let lastName: string | null = null;
let lastVersion: string | undefined;
let recovering: Promise<void> | null = null;

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (BRIDGE_TOKEN) h["x-auth-token"] = BRIDGE_TOKEN;
  return h;
}

// "stale" = a roblox-mcp-pro broker running an OLDER version than this client.
// We try to replace it so a package update actually takes effect (new routes,
// new dashboard) instead of new clients silently attaching to the old broker.
type PingResult = "ours" | "stale" | "foreign" | "down";

/** True if `brokerVersion` is older than this client's VERSION (missing = old). */
function brokerIsOlder(brokerVersion: string | undefined): boolean {
  if (!brokerVersion) return true;
  const a = brokerVersion.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const b = VERSION.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

async function ping(): Promise<PingResult> {
  try {
    const res = await fetch(`${BASE}/rpc/ping`, {
      headers: headers(),
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return "foreign";
    const body = (await res.json()) as { broker?: string; version?: string };
    if (body.broker !== "roblox-mcp-pro") return "foreign";
    return brokerIsOlder(body.version) ? "stale" : "ours";
  } catch {
    return "down";
  }
}

/** Ask an older broker to shut down so we can spawn a current one. Best-effort. */
async function requestBrokerShutdown(): Promise<void> {
  try {
    await fetch(`${BASE}/rpc/shutdown`, {
      method: "POST",
      headers: headers(),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // Pre-1.0.27 brokers have no /rpc/shutdown; we fall back to attaching.
  }
}

function spawnBroker(): void {
  const brokerPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../broker/main.js",
  );
  const child = spawn(process.execPath, [brokerPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
}

/** Ensure a broker is reachable, spawning one if needed. */
export async function ensureBroker(): Promise<void> {
  const first = await ping();
  if (first === "ours") return;
  if (first === "foreign") {
    throw new Error(
      `Port ${BRIDGE_PORT} is held by a process that isn't a roblox-mcp-pro broker. ` +
        "Stop it or set ROBLOX_MCP_PORT to a free port.",
    );
  }

  if (first === "stale") {
    // An older broker is holding the port. Ask it to exit, then take over so the
    // update's new routes/dashboard actually load. If it won't leave (a very old
    // broker without /rpc/shutdown), attach to it rather than failing.
    await requestBrokerShutdown();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await delay(300);
      const state = await ping();
      if (state === "down") break;
      if (state === "ours") return; // a newer broker won the race
    }
    if ((await ping()) === "stale") return; // old broker stayed; use it as-is
  }

  spawnBroker();
  // Wait for the freshly spawned (or a racing) broker to come up.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(400);
    const state = await ping();
    if (state === "ours") return;
    if (state === "foreign") {
      throw new Error(
        `Port ${BRIDGE_PORT} is held by a non-broker process. Set ROBLOX_MCP_PORT to a free port.`,
      );
    }
  }
  throw new Error("Timed out waiting for the roblox-mcp-pro broker to start.");
}

/**
 * The broker died mid-session (upgrade, crash, manual kill). Spawn/find a new
 * one and re-register under our previous identity so the dashboard keeps the
 * same name. Single-flight: concurrent failing calls share one recovery.
 */
function recoverBroker(): Promise<void> {
  recovering ??= (async () => {
    try {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      clientId = null;
      await ensureBroker();
      await register(lastName ?? "agent", lastVersion);
    } finally {
      recovering = null;
    }
  })();
  return recovering;
}

/** Register this agent with the broker and begin heartbeating. */
export async function register(name: string, version?: string): Promise<void> {
  lastName = name;
  lastVersion = version;
  const res = await fetch(`${BASE}/rpc/register`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ name, version, pid: process.pid, cwd: process.cwd() }),
    signal: AbortSignal.timeout(3000),
  });
  const body = (await res.json()) as { clientId?: string };
  clientId = body.clientId ?? null;

  heartbeatTimer = setInterval(() => {
    if (!clientId) return;
    void fetch(`${BASE}/rpc/heartbeat`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ clientId }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
    // 2s (was 10s): a faster pulse lets the broker prune a crashed agent — one
    // that died without deregistering — within a few seconds, so it can free
    // the port promptly. Local HTTP, so the extra traffic is negligible.
  }, 2_000);
  heartbeatTimer.unref();
}

/** Update this agent's display name once the MCP handshake reveals the client. */
export function identify(name: string, version?: string): void {
  lastName = name;
  lastVersion = version;
  if (!clientId) return;
  void fetch(`${BASE}/rpc/identify`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ clientId, name, version }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

/** Best-effort tell the broker we're going away (on shutdown). */
export async function deregister(): Promise<void> {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (!clientId) return;
  try {
    await fetch(`${BASE}/rpc/deregister`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ clientId }),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    // Going down anyway; the broker prunes us on heartbeat timeout.
  }
}

/** Run a tool via the broker (forwarded to Studio, or handled broker-side). */
export async function call<T = unknown>(tool: string, args: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/rpc/call`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ clientId, tool, args }),
      signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS + 5000),
    });
  } catch (e) {
    // Broker gone mid-session (upgrade/kill/crash): spawn a fresh one,
    // re-register, and retry the call once before giving up.
    try {
      await recoverBroker();
      res = await fetch(`${BASE}/rpc/call`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ clientId, tool, args }),
        signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS + 5000),
      });
    } catch {
      throw new StudioError(
        `Lost connection to the roblox-mcp-pro broker (${e instanceof Error ? e.message : String(e)}).`,
      );
    }
  }
  if (!res.ok) throw new StudioError(`Broker returned HTTP ${res.status}.`);
  const body = (await res.json()) as { ok: boolean; result?: T; error?: string };
  if (!body.ok) throw new StudioError(body.error ?? "Unknown Studio error");
  return (body.result ?? null) as T;
}

/** Fetch bridge/plugin status from the broker. */
export async function status(): Promise<BridgeStatus> {
  try {
    const res = await fetch(`${BASE}/rpc/status`, {
      headers: headers(),
      signal: AbortSignal.timeout(2000),
    });
    return (await res.json()) as BridgeStatus;
  } catch {
    await recoverBroker();
    const res = await fetch(`${BASE}/rpc/status`, {
      headers: headers(),
      signal: AbortSignal.timeout(2000),
    });
    return (await res.json()) as BridgeStatus;
  }
}
