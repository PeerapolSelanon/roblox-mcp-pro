#!/usr/bin/env node
/**
 * Hermetic test for the disk-mirror layer of Studio↔disk sync. No Studio, no
 * chokidar, no network — just the pure name mapping plus materializing a
 * snapshot tree into a temp dir and reading it back.
 *
 *   - scriptSuffix / escapeName (pure)
 *   - writeTree: nesting, props.json, script suffix, value.json, sibling-name
 *     collisions (~N), filesystem escaping, and the returned script index
 *   - writeSourcemap: top-level dirs become DataModel services
 *
 * The sync engine itself (engine.ts) drives chokidar + the Studio bridge and is
 * out of scope here — it needs an integration/live test, not a hermetic one.
 *
 * Run: node scripts/sync-smoke.mjs  (needs dist/)
 */

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

const { scriptSuffix, escapeName, writeTree } = await import("../dist/sync/mirror.js");
const { writeSourcemap } = await import("../dist/sync/sourcemap.js");

const failures = [];
const check = (label, cond, detail) => {
  if (!cond) failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};
const exists = async (p) => {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
};
const readJson = async (p) => JSON.parse(await fs.readFile(p, "utf8"));

// --- pure: scriptSuffix ---
check("scriptSuffix Script", scriptSuffix("Script") === ".server.luau");
check("scriptSuffix LocalScript", scriptSuffix("LocalScript") === ".client.luau");
check("scriptSuffix ModuleScript", scriptSuffix("ModuleScript") === ".module.luau");
check("scriptSuffix non-script → null", scriptSuffix("Folder") === null);

// --- pure: escapeName ---
check("escapeName plain", escapeName("Foo") === "Foo");
check("escapeName slash → _", escapeName("a/b") === "a_b");
check("escapeName tilde → ~~", escapeName("a~b") === "a~~b");
check("escapeName forbidden → _", escapeName('a<>:"/\\|?*b') === "a_________b", JSON.stringify(escapeName('a<>:"/\\|?*b')));

// --- writeTree into a temp dir ---
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rmp-sync-"));
const explorerDir = path.join(tmp, "explorer");
await fs.mkdir(explorerDir, { recursive: true });

const node = (name, className, extra = {}) => ({ name, className, properties: {}, children: [], ...extra });
const tree = node("Workspace", "Workspace", {
  children: [
    node("Part", "Part", { properties: { Anchored: true } }),
    node("MyScript", "Script", { source: "print('hi')" }),
    node("Mod", "ModuleScript", { source: "return {}" }),
    node("Speed", "NumberValue", { value: 42 }),
    node("Dup", "Folder"),
    node("Dup", "Folder"), // sibling-name collision → Dup~2
    node("a/b", "Folder"), // escaped → a_b
    node("Parent", "Folder", { children: [node("Child", "Script", { source: "x" })] }),
  ],
});

const scripts = await writeTree(explorerDir, { path: "game.Workspace", tree });
const ws = path.join(explorerDir, "Workspace");

check("writeTree root props", (await readJson(path.join(ws, "Workspace.props.json"))).className === "Workspace");
check("writeTree part property", (await readJson(path.join(ws, "Part", "Part.props.json"))).properties.Anchored === true);
check("writeTree server script", (await fs.readFile(path.join(ws, "MyScript", "MyScript.server.luau"), "utf8")) === "print('hi')");
check("writeTree module script", await exists(path.join(ws, "Mod", "Mod.module.luau")));
const val = await readJson(path.join(ws, "Speed", "Speed.value.json"));
check("writeTree value object", val.value === 42 && val.className === "NumberValue", JSON.stringify(val));
check("writeTree collision Dup", await exists(path.join(ws, "Dup")));
check("writeTree collision Dup~2", await exists(path.join(ws, "Dup~2")));
check("writeTree escaped name a_b", await exists(path.join(ws, "a_b")));
check("writeTree nesting Parent/Child", await exists(path.join(ws, "Parent", "Child", "Child.server.luau")));

// returned script index
check("writeTree script count", scripts.length === 3, `got ${scripts.length}`);
const myScript = scripts.find((s) => s.absPath.endsWith("MyScript.server.luau"));
check("writeTree script instancePath", myScript?.instancePath === "game.Workspace.MyScript", JSON.stringify(myScript));
const childScript = scripts.find((s) => s.absPath.endsWith(path.join("Child", "Child.server.luau")));
check("writeTree nested instancePath", childScript?.instancePath === "game.Workspace.Parent.Child", JSON.stringify(childScript));

// --- writeSourcemap: top-level dirs → DataModel services ---
const placeDir = path.join(tmp, "place");
await fs.mkdir(placeDir, { recursive: true });
await writeSourcemap(placeDir, explorerDir);
const sm = await readJson(path.join(placeDir, "sourcemap.json"));
check("sourcemap root", sm.name === "game" && sm.className === "DataModel", JSON.stringify({ name: sm.name, className: sm.className }));
check("sourcemap has Workspace child", (sm.children ?? []).some((c) => c.name === "Workspace"));
const flat = JSON.stringify(sm);
check("sourcemap references a script file", /\.server\.luau/.test(flat));

await fs.rm(tmp, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`sync-smoke: FAIL (${failures.length})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("sync-smoke: OK — name mapping + writeTree materialization + sourcemap.");
process.exit(0);
