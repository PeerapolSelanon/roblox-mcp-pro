#!/usr/bin/env node
/**
 * Hermetic smoke test for CI — no Studio, no license, no network, no broker.
 *
 * Loads the compiled tool registrations (same duck-typed McpServer trick as
 * gen-docs.mjs) and asserts the registry is well-formed: tools present, core
 * tools registered, every tool carries a title + zod inputSchema. Catches the
 * common ways a build silently breaks tool registration before it ships.
 *
 * Run: npm test  (builds first)  ·  node scripts/smoke.mjs  (needs dist/)
 */

const { registerAllTools } = await import(
  new URL("../dist/tools/index.js", import.meta.url).href
);

const tools = [];
const fakeServer = {
  registerTool(name, config, handler) {
    tools.push({ name, config, handler });
  },
};
registerAllTools(fakeServer);

const failures = [];
const fail = (msg) => failures.push(msg);

// 1) Registry is non-empty.
if (tools.length === 0) fail("no tools registered — registerAllTools captured 0");

// 2) Core tools that must always exist (stable public surface).
const CORE = ["execute_luau", "query_instances", "system_info", "scene_overview"];
const names = new Set(tools.map((t) => t.name));
for (const c of CORE) {
  if (!names.has(c)) fail(`core tool missing: ${c}`);
}

// 3) No duplicate registrations.
if (names.size !== tools.length) {
  const seen = new Set();
  const dupes = new Set();
  for (const t of tools) {
    if (seen.has(t.name)) dupes.add(t.name);
    seen.add(t.name);
  }
  fail(`duplicate tool names: ${[...dupes].join(", ")}`);
}

// 4) Every tool is well-formed: title, handler, and a zod inputSchema shape.
for (const { name, config, handler } of tools) {
  if (typeof handler !== "function") fail(`${name}: handler is not a function`);
  if (!config?.title) fail(`${name}: missing title`);
  const shape = config?.inputSchema;
  if (shape === undefined || shape === null || typeof shape !== "object") {
    fail(`${name}: inputSchema missing or not an object`);
    continue;
  }
  for (const [param, zodType] of Object.entries(shape)) {
    if (!zodType?._def) fail(`${name}.${param}: not a zod schema`);
  }
}

if (failures.length > 0) {
  console.error(`smoke: FAIL (${failures.length})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`smoke: OK — ${tools.length} tools, core present (${CORE.join(", ")}).`);
process.exit(0);
