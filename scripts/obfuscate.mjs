#!/usr/bin/env node
/**
 * Obfuscate the compiled dist/ in place before publishing, so the code shipped
 * on public npm is hard to read or tamper with (it's a paid, closed product).
 *
 * Runs from prepublishOnly only — local `npm run build` stays readable for dev.
 * ESM-safe, moderate settings (no self-defending / control-flow flattening,
 * which are brittle on Node and hurt startup). Also strips source maps and
 * .d.ts files so the obfuscation can't be trivially reversed.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JsObfuscator from "javascript-obfuscator";

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

/** Recursively collect files under dir matching a predicate. */
function walk(dir, match, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, match, out);
    else if (match(full)) out.push(full);
  }
  return out;
}

const OPTIONS = {
  target: "node",
  compact: true,
  simplify: true,
  identifierNamesGenerator: "hexadecimal",
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: ["base64"],
  // Off on purpose: these break Node ESM / hurt startup, with little gain here.
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  debugProtection: false,
  // We rely on console + process.stderr for logging and the CLI.
  disableConsoleOutput: false,
  sourceMap: false,
};

// 1) Delete source maps and type declarations (would undo the obfuscation /
//    leak structure). Consumers run the bin; they don't import our types.
let removed = 0;
for (const f of walk(distDir, (p) => p.endsWith(".map") || p.endsWith(".d.ts"))) {
  rmSync(f);
  removed++;
}

// 2) Obfuscate every remaining .js file in place.
let count = 0;
for (const file of walk(distDir, (p) => p.endsWith(".js"))) {
  const src = readFileSync(file, "utf8");
  const out = JsObfuscator.obfuscate(src, OPTIONS).getObfuscatedCode();
  writeFileSync(file, out, "utf8");
  count++;
}

console.log(`obfuscated ${count} dist file(s); removed ${removed} map/.d.ts file(s)`);
