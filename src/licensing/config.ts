/**
 * Licensing configuration.
 *
 * roblox-mcp-pro is sold under a paid subscription. Licensing is enforced with
 * Lemon Squeezy's License API: customers buy on your store, Lemon Squeezy mints
 * a license key automatically, and this server validates that key online (with
 * an offline grace window) on startup.
 *
 * ▶ BEFORE PUBLISHING: fill in your real Lemon Squeezy Store ID and Product ID
 *   below (see SELLING.md). They can also be supplied at runtime via the env
 *   vars for testing. While both are 0/unset the store/product ownership check
 *   is skipped — fine for local development, NOT for a real release.
 */

import os from "node:os";
import path from "node:path";

/**
 * Which payment/license provider is active: "polar" (default) or "lemonsqueezy".
 * Polar requires a deployed license proxy (see licensing-proxy/) because its API
 * needs an org token that must not ship in the package.
 */
export const LICENSE_PROVIDER = (process.env.RMP_LICENSE_PROVIDER ?? "polar").toLowerCase();

/**
 * URL of the self-hosted Polar license proxy (keyless validate/activate). Only
 * used when RMP_LICENSE_PROVIDER=polar. Override with RMP_LICENSE_PROXY_URL.
 */
export const LICENSE_PROXY_URL =
  process.env.RMP_LICENSE_PROXY_URL ?? "https://roblox-mcp-pro-license.peerapolselanon.workers.dev";

/** Your Lemon Squeezy numeric Store ID. Find it in Settings → Stores. */
export const LEMONSQUEEZY_STORE_ID = Number.parseInt(
  process.env.RMP_LS_STORE_ID ?? "398915",
  10,
);

/** The numeric Product ID of the roblox-mcp-pro subscription product. */
export const LEMONSQUEEZY_PRODUCT_ID = Number.parseInt(
  process.env.RMP_LS_PRODUCT_ID ?? "1120208",
  10,
);

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

/** True once real store/product IDs are configured (i.e. a real release). */
export const OWNERSHIP_CHECK_ENABLED =
  LEMONSQUEEZY_STORE_ID > 0 && LEMONSQUEEZY_PRODUCT_ID > 0;
