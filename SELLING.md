# Selling Roblox MCP Pro

This is the **owner's** guide — how to turn this repo into a paid product. Customers never read
this; they just buy a key and paste it into their config.

## How licensing works (the short version)

- The server is distributed normally (npm / `npx`). **It runs, but does nothing useful without a
  valid license** — every tool except `system_info` returns a "buy a license" message.
- New users get a **14-day free trial** automatically (tracked locally in
  `~/.roblox-mcp-pro/state.json`).
- A paying customer gets a **license key** (Lemon Squeezy generates it on purchase) and sets it via
  the `ROBLOX_MCP_LICENSE` env var or `~/.roblox-mcp-pro/license.key`.
- On startup the server calls Lemon Squeezy to **activate** the machine and **validate** the key.
  Valid + active subscription → unlocked. Expired/cancelled → locked with a "renew" message.
- If the customer is briefly offline, a previously-valid license keeps working for **7 days**
  (offline grace) so a flaky connection never locks out a paying user.

> ⚠️ **Honest limitation:** this is a JavaScript program that runs on the customer's machine, so a
> determined person *can* edit the code to bypass the check. This stops casual sharing/piracy
> (~95% of it), which is the realistic goal for an indie dev tool. To raise the bar, bundle +
> obfuscate before publishing (see "Hardening" below). Don't expect unbreakable DRM — nobody has it.

## One-time setup

### 1. Create the Lemon Squeezy product

1. Sign up at <https://lemonsqueezy.com> and create a **Store**.
2. Create a **Product** → **Subscription** (monthly and/or yearly variants).
3. In the product's settings, turn **ON "License keys"**.
   - **Activation limit:** how many machines one key can run on (e.g. `3`). This is your seat limit.
   - **License length:** set it to follow the subscription (the key disables when the sub ends).
4. Publish the product and grab your **checkout / store URL**.

### 2. Find your Store ID and Product ID

- **Store ID:** Lemon Squeezy dashboard → Settings → Stores (the numeric id).
- **Product ID:** open the product; the id is in the URL, or use the API
  `GET https://api.lemonsqueezy.com/v1/products` with your API key.

Quick test that a key works (after a test purchase):

```bash
node scripts/check-license.mjs <the-license-key>
# look at: valid=true status=active store=<yours> product=<yours>
```

### 3. Bake the IDs into the build

Edit `src/licensing/config.ts` and set real values (replace the `?? "0"` defaults), **or** export
them at build time:

```powershell
$env:RMP_LS_STORE_ID   = "12345"
$env:RMP_LS_PRODUCT_ID = "67890"
$env:RMP_PURCHASE_URL  = "https://your-store.lemonsqueezy.com/buy/xxxx"
npm run build
```

> Until both IDs are non-zero, the server runs in **dev mode** and skips the store/product
> ownership check — never ship a release built that way, or keys from *other* Lemon Squeezy stores
> would unlock your product.

Tunable knobs (all optional, env-overridable): `RMP_TRIAL_DAYS` (default 14),
`RMP_OFFLINE_GRACE_DAYS` (default 7).

### 4. Publish

```bash
npm version patch
git push --follow-tags   # release workflow builds the plugin + publishes to npm
```

Make sure the release build has the real Store/Product IDs compiled in (step 3). The GitHub Action
runs `npm run build`, so set `RMP_LS_STORE_ID` / `RMP_LS_PRODUCT_ID` as repo **secrets/variables**
and pass them into the build step, or hardcode them in `config.ts`.

## What the customer does after buying

Lemon Squeezy emails them a license key (also in their customer portal). They add it to their MCP
client config:

```json
{
  "mcpServers": {
    "roblox-mcp-pro": {
      "command": "npx",
      "args": ["-y", "roblox-mcp-pro"],
      "env": { "ROBLOX_MCP_LICENSE": "THEIR-KEY-HERE" }
    }
  }
}
```

…or save the key to `~/.roblox-mcp-pro/license.key`. Then restart the client. `system_info` will
report `license: licensed`.

## Refunds, cancellations, seat limits

- **Cancel / refund:** when the Lemon Squeezy subscription ends, the next `validate` returns
  `status: expired|disabled` → the server locks within the offline-grace window.
- **Move to a new machine / too many activations:** if a customer hits the activation limit, raise
  the limit in the product settings, or deactivate an old instance via the API
  (`POST /v1/licenses/deactivate`). The server stores its instance id in
  `~/.roblox-mcp-pro/state.json`.

## Hardening (optional, raises the bar)

The license check is plain JS in `dist/`. To make tampering harder before publishing:

1. **Bundle** to a single file (esbuild): `esbuild src/index.ts --bundle --platform=node
   --format=esm --outfile=dist/index.js`.
2. **Obfuscate** the bundle (e.g. `javascript-obfuscator`).
3. Optionally ship the bundled+obfuscated `dist/` only (keep `src/` out of the npm `files`).

This is defense-in-depth, not a guarantee. Pair it with fair pricing and good support — that
converts more would-be pirates than any obfuscator.
