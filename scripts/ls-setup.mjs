#!/usr/bin/env node
/**
 * Owner setup helper: reads your Lemon Squeezy API key from .secrets/lsq.key
 * (or the LSQUEEZY_API_KEY env var) and prints your Store ID, Product ID(s), and
 * Variant ID(s) + buy URLs — the values you paste into src/licensing/config.ts.
 *
 * Usage:  node scripts/ls-setup.mjs
 *
 * This uses the read-only management API (needs your secret key), unlike the
 * license validate/activate calls the shipped server makes.
 */

import { readFileSync } from "node:fs";

function loadKey() {
  if (process.env.LSQUEEZY_API_KEY) return process.env.LSQUEEZY_API_KEY.trim();
  try {
    return readFileSync(new URL("../.secrets/lsq.key", import.meta.url), "utf8").trim();
  } catch {
    console.error("No API key. Put it in .secrets/lsq.key or set LSQUEEZY_API_KEY.");
    process.exit(1);
  }
}

const KEY = loadKey();
const BASE = "https://api.lemonsqueezy.com/v1";

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Accept: "application/vnd.api+json",
      Authorization: `Bearer ${KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

const stores = await get("/stores");
console.log("\n=== STORES ===");
for (const s of stores.data) {
  console.log(`  Store ID ${s.id} — ${s.attributes.name} (${s.attributes.domain})`);
}

const products = await get("/products");
console.log("\n=== PRODUCTS ===");
for (const p of products.data) {
  console.log(
    `  Product ID ${p.id} — ${p.attributes.name} ` +
      `[store ${p.attributes.store_id}, status ${p.attributes.status}]`,
  );
  console.log(`     buy URL: ${p.attributes.buy_now_url ?? "(none)"}`);
  try {
    const variants = await get(`/variants?filter[product_id]=${p.id}`);
    for (const v of variants.data) {
      console.log(
        `     ↳ Variant ID ${v.id} — ${v.attributes.name} ` +
          `(interval ${v.attributes.interval ?? "—"}, status ${v.attributes.status})`,
      );
    }
  } catch (e) {
    console.log(`     (couldn't list variants: ${e.message})`);
  }
}

console.log("\nPaste the right Store ID + Product ID into src/licensing/config.ts");
console.log("(or build with RMP_LS_STORE_ID / RMP_LS_PRODUCT_ID / RMP_PURCHASE_URL set).\n");
