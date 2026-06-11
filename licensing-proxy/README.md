# Polar license proxy

A tiny Cloudflare Worker that lets `roblox-mcp-pro` use **Polar** for licensing.

## Why this exists

Polar's `validate` / `activate` license-key endpoints require an **Organization
Access Token** — a secret that grants org-wide access. That token must never ship
inside the npm package (even obfuscated code can be reversed). This worker holds
the token server-side and exposes a **keyless** surface the client calls with only
the customer's license key:

```
POST /activate  { key, label }          -> { ok, valid, activationId, status, expiresAt }
POST /validate  { key, activationId? }   -> { ok, valid, status, expiresAt }
```

It also pins requests to your organization (and optionally one product's benefit),
so a key from another Polar product can't unlock this one.

## Deploy (free tier)

```bash
npm i -g wrangler
wrangler login
cd licensing-proxy

# set your org id (+ optional benefit id) in wrangler.toml [vars]
wrangler secret put POLAR_TOKEN     # paste your Organization Access Token
wrangler deploy
```

`wrangler deploy` prints a URL like
`https://roblox-mcp-pro-license.<you>.workers.dev`.

## Point the server at it

Set these in your MCP client config / release env:

```
RMP_LICENSE_PROVIDER=polar
RMP_LICENSE_PROXY_URL=https://roblox-mcp-pro-license.<you>.workers.dev
RMP_PURCHASE_URL=<your Polar checkout link>
```

Default (no env) keeps the existing Lemon Squeezy path, so nothing changes until
you flip `RMP_LICENSE_PROVIDER`.

## Test against sandbox

Set `POLAR_API_BASE = "https://sandbox-api.polar.sh"` in `wrangler.toml` and use a
sandbox token + key while validating the flow end to end.
