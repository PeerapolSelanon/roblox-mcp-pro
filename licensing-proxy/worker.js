/**
 * roblox-mcp-pro — Polar license proxy (Cloudflare Worker).
 *
 * Polar's license-key validate/activate endpoints require an Organization
 * Access Token (a secret that grants org-wide access). That token must NEVER
 * ship inside the npm package — even obfuscated, it would be extractable. This
 * tiny worker holds the token server-side and exposes a *keyless* surface the
 * client can safely call with only the customer's license key:
 *
 *   POST /activate  { key, label }            -> { ok, activationId, status, expiresAt }
 *   POST /validate  { key, activationId? }    -> { ok, valid, status, expiresAt }
 *
 * The worker also enforces ownership server-side: it pins requests to your
 * organization and (optionally) a single benefit/product, so a key from another
 * Polar product can't unlock this one.
 *
 * Deploy (free tier):
 *   1) npm i -g wrangler && wrangler login
 *   2) wrangler secret put POLAR_TOKEN          # your Organization Access Token
 *   3) set POLAR_ORG_ID (+ optional POLAR_BENEFIT_ID) as vars in wrangler.toml
 *   4) wrangler deploy
 *   5) point the client at the deployed URL via RMP_LICENSE_PROXY_URL.
 *
 * Use https://sandbox-api.polar.sh for testing by setting POLAR_API_BASE.
 */

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return json({ ok: false, error: "POST only" }, 405);
    }
    const url = new URL(request.url);
    const action = url.pathname.replace(/\/+$/, "").split("/").pop();
    if (action !== "activate" && action !== "validate") {
      return json({ ok: false, error: "unknown action" }, 404);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "bad JSON" }, 400);
    }
    const key = String(body.key ?? "").trim();
    if (!key) return json({ ok: false, error: "missing key" }, 400);

    const apiBase = env.POLAR_API_BASE || "https://api.polar.sh";
    const orgId = env.POLAR_ORG_ID;
    if (!env.POLAR_TOKEN || !orgId) {
      return json({ ok: false, error: "proxy not configured" }, 500);
    }

    const headers = {
      Authorization: `Bearer ${env.POLAR_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    try {
      if (action === "activate") {
        const payload = {
          key,
          organization_id: orgId,
          label: String(body.label ?? "device").slice(0, 100),
        };
        if (env.POLAR_BENEFIT_ID) payload.benefit_id = env.POLAR_BENEFIT_ID;
        const res = await fetch(`${apiBase}/v1/license-keys/activate`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          return json({ ok: false, valid: false, error: errorOf(data, res.status) });
        }
        const lk = data.license_key ?? data;
        return json({
          ok: true,
          valid: isValid(lk),
          activationId: data.id ?? null,
          status: lk.status ?? null,
          expiresAt: lk.expires_at ?? null,
        });
      }

      // validate
      const payload = { key, organization_id: orgId };
      if (body.activationId) payload.activation_id = body.activationId;
      if (env.POLAR_BENEFIT_ID) payload.benefit_id = env.POLAR_BENEFIT_ID;
      const res = await fetch(`${apiBase}/v1/license-keys/validate`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 404) {
        return json({ ok: true, valid: false, status: "not_found" });
      }
      if (!res.ok) {
        return json({ ok: false, valid: false, error: errorOf(data, res.status) });
      }
      return json({
        ok: true,
        valid: isValid(data),
        status: data.status ?? null,
        expiresAt: data.expires_at ?? null,
      });
    } catch (err) {
      return json({ ok: false, valid: false, error: String(err) }, 502);
    }
  },
};

/** A Polar key is usable when granted and not past its expiry. */
function isValid(lk) {
  if (!lk || lk.status !== "granted") return false;
  if (lk.expires_at && Date.parse(lk.expires_at) <= Date.now()) return false;
  return true;
}

function errorOf(data, status) {
  return (data && (data.detail || data.error)) || `HTTP ${status}`;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
