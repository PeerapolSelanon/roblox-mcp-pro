/**
 * Local, non-secret licensing state persisted at ~/.roblox-mcp-pro/state.json.
 *
 * Nothing here is a secret — the license key itself is supplied by the user via
 * env var or LICENSE_FILE. This file only remembers the trial start, the
 * provider's activation instance id for this machine (Lemon Squeezy instance or
 * Polar activation), and the last successful online validation (so we can grant
 * an offline grace window).
 */

import { promises as fs } from "node:fs";
import { STATE_DIR, STATE_FILE } from "./config.js";

export interface LicenseStore {
  /** ISO timestamp the free trial began on this machine. */
  trialStartedAt?: string;
  /** Provider activation instance id for this machine (LS instance / Polar activation). */
  instanceId?: string;
  /** The license key this instance was activated with (to detect key changes). */
  licenseKey?: string;
  /** ISO timestamp of the last successful online validation. */
  lastValidatedAt?: string;
  /** Whether that last online check said the license was valid. */
  lastValidationOk?: boolean;
}

export async function readStore(): Promise<LicenseStore> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as LicenseStore;
    }
  } catch {
    // Missing or corrupt file → start fresh.
  }
  return {};
}

export async function writeStore(patch: Partial<LicenseStore>): Promise<void> {
  const current = await readStore();
  const next: LicenseStore = { ...current, ...patch };
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    // Best-effort: if we can't persist, licensing still works for this run.
  }
}
