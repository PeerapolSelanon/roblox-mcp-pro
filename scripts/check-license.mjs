#!/usr/bin/env node
/**
 * Owner/support tool: validate (and optionally activate) a Lemon Squeezy license
 * key against the same License API the server uses. Handy for testing your store
 * setup or debugging a customer's key.
 *
 * Usage:
 *   node scripts/check-license.mjs <license-key>
 *   node scripts/check-license.mjs <license-key> --activate "Test device"
 *
 * No secret API key needed — these endpoints take only the customer's key.
 */

const [, , key, ...rest] = process.argv;
if (!key) {
  console.error("Usage: node scripts/check-license.mjs <license-key> [--activate <name>]");
  process.exit(1);
}

const API = "https://api.lemonsqueezy.com/v1/licenses";

async function call(endpoint, body) {
  const res = await fetch(`${API}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
  });
  return res.json();
}

const activateIdx = rest.indexOf("--activate");
if (activateIdx !== -1) {
  const name = rest[activateIdx + 1] ?? "Test device";
  console.log(`\n→ activate (instance_name="${name}")`);
  const act = await call("activate", { license_key: key, instance_name: name });
  console.log(JSON.stringify(act, null, 2));
  if (act.instance?.id) {
    console.log(`\n→ validate (instance_id=${act.instance.id})`);
    console.log(JSON.stringify(await call("validate", { license_key: key, instance_id: act.instance.id }), null, 2));
  }
} else {
  console.log("\n→ validate");
  const val = await call("validate", { license_key: key });
  console.log(JSON.stringify(val, null, 2));
  console.log(
    `\nSummary: valid=${val.valid} status=${val.license_key?.status ?? "?"} ` +
      `store=${val.meta?.store_id ?? "?"} product=${val.meta?.product_id ?? "?"}`,
  );
}
