/**
 * Shared constants for roblox-mcp-pro.
 */

/** Loopback host — the bridge only ever binds to localhost. */
export const BRIDGE_HOST = "127.0.0.1";

/** Default bridge port; override with ROBLOX_MCP_PORT. */
export const BRIDGE_PORT = Number.parseInt(process.env.ROBLOX_MCP_PORT ?? "3690", 10);

/**
 * Optional shared secret. If set (via ROBLOX_MCP_TOKEN), the plugin must send a
 * matching `x-auth-token` header. Empty string = no auth (localhost-only bind).
 */
export const BRIDGE_TOKEN = process.env.ROBLOX_MCP_TOKEN ?? "";

/** How long the plugin's /dequeue long-poll is held open before returning 204 (ms). */
export const LONG_POLL_TIMEOUT_MS = 25_000;

/** How long a tool waits for the plugin to return a command result before failing (ms). */
export const COMMAND_TIMEOUT_MS = 30_000;

/** Plugin is considered "connected" if it polled within this window (ms). */
export const PLUGIN_LIVENESS_MS = LONG_POLL_TIMEOUT_MS + 10_000;

/**
 * When a plugin's long-poll socket closes unexpectedly (Studio quit/crashed
 * mid-poll), wait this long for it to re-poll before declaring the session gone.
 * Short, so a hard Studio close clears in seconds instead of waiting out
 * PLUGIN_LIVENESS_MS (which left dead sessions blocking routing for ~35s).
 */
export const PLUGIN_DISCONNECT_GRACE_MS = 3_000;

/** Remove a disconnected session from the registry this long after it drops (ms),
 *  after a brief "recently dropped" window on the dashboard. */
export const SESSION_PRUNE_GRACE_MS = 8_000;

/** Maximum characters returned in a single tool response before truncation. */
export const CHARACTER_LIMIT = 25_000;

/**
 * Roblox services that must never be mutated/deleted — protects the Studio
 * session and the plugin itself from accidental damage.
 */
export const PROTECTED_SERVICES: readonly string[] = [
  "CoreGui",
  "CorePackages",
  "CoreScripts",
  "RobloxPluginGuiService",
  "PluginGuiService",
];
