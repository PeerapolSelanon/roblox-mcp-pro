/**
 * Licensing configuration.
 *
 * roblox-mcp-pro is sold under a paid subscription, enforced via Polar: customers
 * buy on your store, Polar mints a license key, and this server validates that key
 * online (with an offline grace window) on startup through a self-hosted proxy.
 */

import os from "node:os";
import path from "node:path";

/**
 * URL of the self-hosted Polar license proxy (keyless validate/activate). Polar's
 * own API needs an org token that must not ship in the package, so the client
 * talks to this proxy instead. Override with RMP_LICENSE_PROXY_URL.
 */
export const LICENSE_PROXY_URL =
  process.env.RMP_LICENSE_PROXY_URL ?? "https://roblox-mcp-pro-license.peerapolselanon.workers.dev";

/** Public-facing checkout / store URL shown when a license is required. */
export const PURCHASE_URL =
  process.env.RMP_PURCHASE_URL ??
  "https://buy.polar.sh/polar_cl_ZOs8s5PTV2KAyj0y71A7xtBzIpPbdclQfrQBP3IHCyH";

/** Human-readable product name used in messages. */
export const PRODUCT_NAME = "Roblox MCP Pro";

/** Free trial length, in days, for first-time users with no license key. */
export const TRIAL_DAYS = Number.parseInt(process.env.RMP_TRIAL_DAYS ?? "14", 10);

/**
 * How long a previously-valid license keeps working without a successful online
 * re-check (network outage tolerance). Paying customers shouldn't be locked out
 * by a flaky connection.
 */
export const OFFLINE_GRACE_DAYS = Number.parseInt(
  process.env.RMP_OFFLINE_GRACE_DAYS ?? "7",
  10,
);

/** Per-user state directory (trial start, activation instance id, last check). */
export const STATE_DIR = path.join(os.homedir(), ".roblox-mcp-pro");

/** JSON file holding non-secret local licensing state. */
export const STATE_FILE = path.join(STATE_DIR, "state.json");

/**
 * Optional file holding the license key, as an alternative to the
 * ROBLOX_MCP_LICENSE env var. One key per file, leading/trailing space trimmed.
 */
export const LICENSE_FILE = path.join(STATE_DIR, "license.key");
