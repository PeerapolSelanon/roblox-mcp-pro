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

const API_BASE = "https://api.lemonsqueezy.com/v1/licenses";
const REQUEST_TIMEOUT_MS = 8_000;

export interface LsResult {
  /** The HTTP request completed and returned parseable JSON. */
  reachable: boolean;
  /** Lemon Squeezy considers the key valid/active. */
  valid: boolean;
  /** License key status: "active" | "expired" | "disabled" | "inactive". */
  status?: string;
  /** Subscription/expiry timestamp, if any. */
  expiresAt?: string | null;
  /** Store the key belongs to — verify it matches yours. */
  storeId?: number;
  /** Product the key belongs to — verify it matches yours. */
  productId?: number;
  /** Activation instance id (from activate). */
  instanceId?: string;
  /** Error text from Lemon Squeezy or transport. */
  error?: string;
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

async function post(endpoint: string, body: Record<string, string>): Promise<LsResult> {
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
      status: data.license_key?.status,
      expiresAt: data.license_key?.expires_at ?? null,
      storeId: data.meta?.store_id,
      productId: data.meta?.product_id,
      instanceId: data.instance?.id,
      error: data.error ?? undefined,
    };
  } catch (error) {
    return {
      reachable: false,
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Register this machine. Returns an instanceId on success. */
export function activate(licenseKey: string, instanceName: string): Promise<LsResult> {
  return post("activate", { license_key: licenseKey, instance_name: instanceName });
}

/** Validate a key, optionally bound to a previously-activated instance. */
export function validate(licenseKey: string, instanceId?: string): Promise<LsResult> {
  const body: Record<string, string> = { license_key: licenseKey };
  if (instanceId) body.instance_id = instanceId;
  return post("validate", body);
}
