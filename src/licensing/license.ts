/**
 * License resolution — decides whether this run is licensed, on a free trial,
 * or locked, and produces a single LicenseState the rest of the server reads.
 *
 * Flow:
 *   1. A license key (env ROBLOX_MCP_LICENSE or ~/.roblox-mcp-pro/license.key)?
 *      → activate this machine if needed, then validate online.
 *      → valid & active            : licensed
 *      → expired/disabled          : locked (renew)
 *      → network down, was valid    : licensed (offline grace window)
 *      → network down, never valid  : locked (can't verify)
 *      → key not for our product    : treated as "no key" → trial
 *   2. No usable key → free trial tracked locally; once it lapses → locked.
 */

import os from "node:os";
import { promises as fs } from "node:fs";
import {
  LICENSE_FILE,
  STATE_DIR,
  TRIAL_DAYS,
  OFFLINE_GRACE_DAYS,
  PURCHASE_URL,
  PRODUCT_NAME,
} from "./config.js";
import { readStore, writeStore, type LicenseStore } from "./store.js";
import { provider } from "./provider.js";

const { activate, validate } = provider;

export type LicenseStatus = "licensed" | "trial" | "locked";

export interface LicenseState {
  status: LicenseStatus;
  /** Short human-readable summary (also surfaced via system_info). */
  message: string;
  /** Days remaining for a trial, or until a known subscription expiry. */
  daysLeft?: number;
  /** Subscription expiry timestamp, if known. */
  expiresAt?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

let cached: LicenseState = {
  status: "locked",
  message: "License not resolved yet.",
};

/** The license state computed at startup. Read by the gate and system_info. */
export function currentLicense(): LicenseState {
  return cached;
}

function daysBetween(fromIso: string, to: number): number {
  return Math.floor((to - Date.parse(fromIso)) / DAY_MS);
}

async function readLicenseFile(): Promise<string | undefined> {
  try {
    const raw = (await fs.readFile(LICENSE_FILE, "utf8")).trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** A subscription/key status that still grants access (covers both providers:
 *  LS uses active/expired/disabled/inactive; Polar uses granted/revoked/disabled). */
function isLive(status?: string): boolean {
  return status !== "expired" && status !== "disabled" && status !== "revoked" && status !== "inactive";
}

/** Result when Lemon Squeezy is unreachable: offline grace window, else locked. */
function offlineResult(store: LicenseStore): LicenseState {
  if (store.lastValidationOk && store.lastValidatedAt) {
    const used = daysBetween(store.lastValidatedAt, Date.now());
    if (used <= OFFLINE_GRACE_DAYS) {
      return {
        status: "licensed",
        message: `Licensed ✅ (offline — re-checks within ${OFFLINE_GRACE_DAYS - used} day(s)).`,
        daysLeft: OFFLINE_GRACE_DAYS - used,
      };
    }
  }
  return {
    status: "locked",
    message:
      `Couldn't verify your ${PRODUCT_NAME} license (no internet). ` +
      "Connect to the internet and try again.",
  };
}

const licensed = (expiresAt?: string | null): LicenseState => ({
  status: "licensed",
  message: `Licensed ✅ (${PRODUCT_NAME}).`,
  expiresAt: expiresAt ?? null,
});

/**
 * Resolve a license key. The activation limit is enforced by REQUIRING a bound
 * activation instance: a machine either re-validates its own instance, or it
 * must successfully ACTIVATE a new one. If activation fails because the limit is
 * full, we lock — we never fall back to a bare key check (which would let one key
 * run on unlimited machines).
 */
async function resolveWithKey(key: string): Promise<LicenseState | "no-key"> {
  const store = await readStore();
  const boundInstance = store.licenseKey === key ? store.instanceId : undefined;

  // 1) Returning machine — re-validate its own activation instance.
  if (boundInstance) {
    const val = await validate(key, boundInstance);
    if (!val.reachable) return offlineResult(store);
    if (!val.owns) return "no-key";
    if (val.valid && isLive(val.status)) {
      await writeStore({
        licenseKey: key,
        lastValidatedAt: new Date().toISOString(),
        lastValidationOk: true,
      });
      return licensed(val.expiresAt);
    }
    if (!isLive(val.status)) {
      await writeStore({ lastValidationOk: false });
      return {
        status: "locked",
        message: `Your ${PRODUCT_NAME} subscription is ${val.status}. Renew at ${PURCHASE_URL}`,
        expiresAt: val.expiresAt ?? null,
      };
    }
    // Instance was deactivated elsewhere — forget it and try to re-activate below.
    await writeStore({ instanceId: undefined });
  }

  // 2) New machine — MUST activate. This is what enforces the activation limit.
  const act = await activate(key, os.hostname() || "device");
  if (!act.reachable) return offlineResult(store);

  if (act.valid && act.instanceId && act.owns) {
    await writeStore({
      instanceId: act.instanceId,
      licenseKey: key,
      lastValidatedAt: new Date().toISOString(),
      lastValidationOk: true,
    });
    return licensed(act.expiresAt);
  }

  // Activation failed — classify why.
  if (!act.owns) return "no-key"; // wrong store/product or key not found → trial
  if (!isLive(act.status)) {
    return {
      status: "locked",
      message: `Your ${PRODUCT_NAME} subscription is ${act.status}. Renew at ${PURCHASE_URL}`,
    };
  }
  // Key is valid & ours, but this machine couldn't be activated → device limit hit.
  return {
    status: "locked",
    message:
      `This license is already active on another device (activation limit reached). ` +
      `Deactivate the other device, or get another license at ${PURCHASE_URL}`,
  };
}

async function resolveTrial(): Promise<LicenseState> {
  const store = await readStore();
  let startedAt = store.trialStartedAt;
  if (!startedAt) {
    startedAt = new Date().toISOString();
    await writeStore({ trialStartedAt: startedAt });
  }
  const used = daysBetween(startedAt, Date.now());
  const daysLeft = TRIAL_DAYS - used;
  if (daysLeft > 0) {
    return {
      status: "trial",
      message:
        `Pro trial: ${daysLeft} of ${TRIAL_DAYS} day(s) left (full access). ` +
        `Keep Pro after the trial at ${PURCHASE_URL}`,
      daysLeft,
    };
  }
  return {
    status: "locked",
    message:
      `Your ${TRIAL_DAYS}-day Pro trial has ended — the free tier still works. ` +
      `Re-unlock Pro at ${PURCHASE_URL} and set ROBLOX_MCP_LICENSE.`,
    daysLeft: 0,
  };
}

/** Resolve and cache the license state. Call once at startup. */
export async function resolveLicense(): Promise<LicenseState> {
  const key = process.env.ROBLOX_MCP_LICENSE?.trim() || (await readLicenseFile());
  if (key) {
    const result = await resolveWithKey(key);
    if (result !== "no-key") {
      cached = result;
      return cached;
    }
  }
  cached = await resolveTrial();
  return cached;
}

/**
 * Save a license key to ~/.roblox-mcp-pro/license.key and re-resolve, so a user
 * can paste a key (dashboard or CLI) instead of editing their client config.
 * Note: a running MCP server caches its license at startup — the user must
 * restart their AI client for a newly-saved key to take effect there.
 */
export async function saveLicenseKey(key: string): Promise<LicenseState> {
  const trimmed = key.trim();
  if (!trimmed) {
    return { status: "locked", message: "No license key provided." };
  }
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(LICENSE_FILE, `${trimmed}\n`, "utf8");
  // Validate/activate immediately so the caller can confirm the key works. The
  // env var, if set, would override the file on the next resolve — flag that.
  if (process.env.ROBLOX_MCP_LICENSE?.trim()) {
    const result = await resolveWithKey(trimmed);
    return result === "no-key"
      ? { status: "locked", message: "That key isn't for this product." }
      : result;
  }
  return resolveLicense();
}
