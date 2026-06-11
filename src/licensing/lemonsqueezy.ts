/**
 * Thin client for the Lemon Squeezy License API.
 *
 * These three endpoints are designed to be called directly from the customer's
 * machine — they do NOT require your secret API key, only the license key the
 * customer already has. So nothing secret ships in this package.
 *   POST /v1/licenses/activate   — register this machine as an "instance"
 *   POST /v1/licenses/validate   — check a key (+ optional instance) is valid
 *   POST /v1/licenses/deactivate — free up an activation slot (not used here)
 *
 * Docs: https://docs.lemonsqueezy.com/help/licensing/license-api
 */

import {
  LEMONSQUEEZY_STORE_ID,
  LEMONSQUEEZY_PRODUCT_ID,
  OWNERSHIP_CHECK_ENABLED,
} from "./config.js";
import type { ProviderResult } from "./provider.js";

const API_BASE = "https://api.lemonsqueezy.com/v1/licenses";
const REQUEST_TIMEOUT_MS = 8_000;

/** Whether a key's store/product match this product (or check disabled in dev). */
function ownsMatch(storeId?: number, productId?: number): boolean {
  if (!OWNERSHIP_CHECK_ENABLED) return true;
  return storeId === LEMONSQUEEZY_STORE_ID && productId === LEMONSQUEEZY_PRODUCT_ID;
}

interface LsRaw {
  activated?: boolean;
  valid?: boolean;
  error?: string | null;
  license_key?: {
    status?: string;
    expires_at?: string | null;
  };
  instance?: { id?: string } | null;
  meta?: { store_id?: number; product_id?: number } | null;
}

async function post(endpoint: string, body: Record<string, string>): Promise<ProviderResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(body).toString(),
      signal: controller.signal,
    });
    // 400 with a JSON body is a normal "invalid key" answer, still parseable.
    const data = (await res.json()) as LsRaw;
    return {
      reachable: true,
      valid: Boolean(data.valid ?? data.activated),
      owns: ownsMatch(data.meta?.store_id, data.meta?.product_id),
      status: data.license_key?.status,
      expiresAt: data.license_key?.expires_at ?? null,
      instanceId: data.instance?.id,
      error: data.error ?? undefined,
    };
  } catch (error) {
    return {
      reachable: false,
      valid: false,
      owns: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Register this machine. Returns an instanceId on success. */
export function activate(licenseKey: string, instanceName: string): Promise<ProviderResult> {
  return post("activate", { license_key: licenseKey, instance_name: instanceName });
}

/** Validate a key, optionally bound to a previously-activated instance. */
export function validate(licenseKey: string, instanceId?: string): Promise<ProviderResult> {
  const body: Record<string, string> = { license_key: licenseKey };
  if (instanceId) body.instance_id = instanceId;
  return post("validate", body);
}
