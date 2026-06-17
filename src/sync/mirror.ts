/**
 * mirror: read/write the on-disk representation of the DataModel.
 *
 * Format (nested-directory): each instance is a directory containing its own
 * metadata files, with children nested as sub-directories.
 *
 *   {Name}/
 *     {Name}.props.json                     -> { className, properties }
 *     {Name}.server|client|module.luau      -> script source
 *     {Name}.value.json                     -> { className, value }   (ValueObjects)
 *
 * Duplicate sibling names get a "~N" suffix; literal "~" is escaped as "~~".
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export interface SnapshotNode {
  name: string;
  className: string;
  source?: string | null;
  value?: unknown;
  properties: Record<string, unknown>;
  children: SnapshotNode[];
}

export interface SnapshotRoot {
  path: string;
  tree: SnapshotNode;
}

/** A script file written to disk and the instance it maps back to. */
export interface ScriptFile {
  absPath: string;
  instancePath: string;
}

const SCRIPT_SUFFIX: Record<string, string> = {
  Script: ".server.luau",
  LocalScript: ".client.luau",
  ModuleScript: ".module.luau",
};

/** Return the script-source filename suffix for a class, or null if not a script. */
export function scriptSuffix(className: string): string | null {
  return SCRIPT_SUFFIX[className] ?? null;
}

/** Escape a name so it is filesystem-safe and reversible. */
export function escapeName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strip control chars from filesystem names.
  return name.replace(/~/g, "~~").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

/** Pick a unique directory name among already-used siblings. */
function uniqueDirName(name: string, used: Set<string>): string {
  const base = escapeName(name);
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base}~${n}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Write a full snapshot tree under `explorerDir`. Returns the list of script
 * files written, for building the path<->instance index.
 */
export async function writeTree(
  explorerDir: string,
  root: SnapshotRoot,
): Promise<ScriptFile[]> {
  const scripts: ScriptFile[] = [];
  await writeNode(explorerDir, root.tree, root.path, new Set<string>(), scripts);
  return scripts;
}

async function writeNode(
  parentDir: string,
  node: SnapshotNode,
  instancePath: string,
  siblingUsed: Set<string>,
  scripts: ScriptFile[],
): Promise<void> {
  const dirName = uniqueDirName(node.name, siblingUsed);
  const dir = path.join(parentDir, dirName);
  await fs.mkdir(dir, { recursive: true });

  // Always write props (className + curated properties).
  await fs.writeFile(
    path.join(dir, `${dirName}.props.json`),
    JSON.stringify(
      { name: node.name, className: node.className, properties: node.properties },
      null,
      2,
    ),
    "utf8",
  );

  // Script source.
  const suffix = scriptSuffix(node.className);
  if (suffix && typeof node.source === "string") {
    const absPath = path.join(dir, `${dirName}${suffix}`);
    await fs.writeFile(absPath, node.source, "utf8");
    scripts.push({ absPath, instancePath });
  }

  // ValueObject value.
  if (node.value !== undefined) {
    await fs.writeFile(
      path.join(dir, `${dirName}.value.json`),
      JSON.stringify({ className: node.className, value: node.value }, null, 2),
      "utf8",
    );
  }

  // Recurse into children.
  const childUsed = new Set<string>();
  for (const child of node.children) {
    await writeNode(dir, child, `${instancePath}.${child.name}`, childUsed, scripts);
  }
}
