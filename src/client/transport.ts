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
import type { BridgeStatus } from "../types.js";

const BASE = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;

let clientId: string | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (BRIDGE_TOKEN) h["x-auth-token"] = BRIDGE_TOKEN;
  return h;
}

type PingResult = "ours" | "foreign" | "down";

async function ping(): Promise<PingResult> {
  try {
    const res = await fetch(`${BASE}/rpc/ping`, {
      headers: headers(),
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return "foreign";
    const body = (await res.json()) as { broker?: string };
    return body.broker === "roblox-mcp-pro" ? "ours" : "foreign";
  } catch {
    return "down";
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

/** Register this agent with the broker and begin heartbeating. */
export async function register(name: string, version?: string): Promise<void> {
  const res = await fetch(`${BASE}/rpc/register`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ name, version, pid: process.pid }),
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
  }, 10_000);
  heartbeatTimer.unref();
}

/** Update this agent's display name once the MCP handshake reveals the client. */
export function identify(name: string, version?: string): void {
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
    throw new StudioError(
      `Lost connection to the roblox-mcp-pro broker (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  if (!res.ok) throw new StudioError(`Broker returned HTTP ${res.status}.`);
  const body = (await res.json()) as { ok: boolean; result?: T; error?: string };
  if (!body.ok) throw new StudioError(body.error ?? "Unknown Studio error");
  return (body.result ?? null) as T;
}

/** Fetch bridge/plugin status from the broker. */
export async function status(): Promise<BridgeStatus> {
  const res = await fetch(`${BASE}/rpc/status`, {
    headers: headers(),
    signal: AbortSignal.timeout(2000),
  });
  return (await res.json()) as BridgeStatus;
}
