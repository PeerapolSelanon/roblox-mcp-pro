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
  TRIAL_DAYS,
  OFFLINE_GRACE_DAYS,
  PURCHASE_URL,
  PRODUCT_NAME,
  LEMONSQUEEZY_STORE_ID,
  LEMONSQUEEZY_PRODUCT_ID,
  OWNERSHIP_CHECK_ENABLED,
} from "./config.js";
import { readStore, writeStore } from "./store.js";
import { activate, validate, type LsResult } from "./lemonsqueezy.js";

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

function ownsKey(r: LsResult): boolean {
  if (!OWNERSHIP_CHECK_ENABLED) return true; // dev mode: skip the match
  return r.storeId === LEMONSQUEEZY_STORE_ID && r.productId === LEMONSQUEEZY_PRODUCT_ID;
}

async function readLicenseFile(): Promise<string | undefined> {
  try {
    const raw = (await fs.readFile(LICENSE_FILE, "utf8")).trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

async function resolveWithKey(key: string): Promise<LicenseState | "no-key"> {
  const store = await readStore();
  // If the key changed since last activation, drop the stale instance binding.
  let instanceId = store.licenseKey === key ? store.instanceId : undefined;

  // Activate this machine the first time we see this key.
  if (!instanceId) {
    const act = await activate(key, os.hostname() || "device");
    if (act.reachable) {
      if (act.valid && act.instanceId && ownsKey(act)) {
        instanceId = act.instanceId;
        await writeStore({ instanceId, licenseKey: key });
      } else if (act.reachable && !ownsKey(act)) {
        return "no-key"; // key belongs to a different store/product
      }
      // else: reachable but invalid → fall through to validate for a clear status
    }
    // If unreachable, fall through to the offline-grace path below.
  }

  const val = await validate(key, instanceId);

  if (val.reachable) {
    if (!ownsKey(val)) return "no-key";
    if (val.valid && val.status !== "expired" && val.status !== "disabled") {
      await writeStore({
        licenseKey: key,
        lastValidatedAt: new Date().toISOString(),
        lastValidationOk: true,
      });
      return {
        status: "licensed",
        message: `Licensed ✅ (${PRODUCT_NAME}).`,
        expiresAt: val.expiresAt ?? null,
      };
    }
    await writeStore({ lastValidationOk: false });
    return {
      status: "locked",
      message:
        `Your ${PRODUCT_NAME} subscription is ${val.status ?? "inactive"}. ` +
        `Renew at ${PURCHASE_URL}`,
      expiresAt: val.expiresAt ?? null,
    };
  }

  // Network failure — honor an offline grace window for known-good licenses.
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
        `Free trial: ${daysLeft} of ${TRIAL_DAYS} day(s) left. ` +
        `Buy a license at ${PURCHASE_URL}`,
      daysLeft,
    };
  }
  return {
    status: "locked",
    message:
      `Your ${TRIAL_DAYS}-day free trial has ended. ` +
      `Buy a license at ${PURCHASE_URL} and set ROBLOX_MCP_LICENSE.`,
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
