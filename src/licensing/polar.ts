/**
 * Client for the Polar license proxy (see licensing-proxy/worker.js).
 *
 * Polar's own validate/activate endpoints require an Organization Access Token,
 * which must never ship in this package. So the client never talks to Polar
 * directly — it talks to a small self-hosted proxy that holds the token and
 * exposes a keyless surface. Nothing secret ships here; the customer supplies
 * only their license key.
 *
 * The proxy enforces org/product ownership, so a valid response already means
 * "a real key for this product" — the caller treats `valid` as authoritative.
 */

import { LICENSE_PROXY_URL } from "./config.js";
import type { ProviderResult } from "./provider.js";

const REQUEST_TIMEOUT_MS = 8_000;

async function post(action: "activate" | "validate", body: Record<string, unknown>): Promise<ProviderResult> {
  if (!LICENSE_PROXY_URL) {
    return { reachable: false, valid: false, owns: false, error: "license proxy URL not configured (RMP_LICENSE_PROXY_URL)" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${LICENSE_PROXY_URL.replace(/\/+$/, "")}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = (await res.json()) as {
      ok?: boolean;
      valid?: boolean;
      status?: string | null;
      expiresAt?: string | null;
      activationId?: string | null;
      error?: string;
    };
    const valid = Boolean(data.valid);
    return {
      reachable: true,
      valid,
      // The proxy already enforced org + product, so a valid key is ours.
      owns: valid,
      status: data.status ?? undefined,
      expiresAt: data.expiresAt ?? null,
      instanceId: data.activationId ?? undefined,
      error: data.error,
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

/** Register this machine; returns an activation id as instanceId on success. */
export function activate(licenseKey: string, instanceName: string): Promise<ProviderResult> {
  return post("activate", { key: licenseKey, label: instanceName });
}

/** Validate a key, optionally bound to a previously-activated instance. */
export function validate(licenseKey: string, instanceId?: string): Promise<ProviderResult> {
  return post("validate", { key: licenseKey, activationId: instanceId });
}
