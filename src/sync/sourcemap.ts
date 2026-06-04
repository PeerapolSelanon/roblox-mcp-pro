/**
 * sourcemap: generate a luau-lsp-compatible sourcemap.json by scanning the
 * on-disk mirror. luau-lsp uses this to resolve `require` paths and types.
 *
 * Format: a tree of { name, className, filePaths?, children? } rooted at the
 * DataModel, with filePaths relative to the sourcemap.json location.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

interface SourcemapNode {
  name: string;
  className: string;
  filePaths?: string[];
  children?: SourcemapNode[];
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

async function readProps(
  dir: string,
  dirName: string,
): Promise<{ name: string; className: string } | null> {
  try {
    const raw = await fs.readFile(path.join(dir, `${dirName}.props.json`), "utf8");
    const parsed = JSON.parse(raw) as { name?: string; className?: string };
    return {
      name: parsed.name ?? dirName,
      className: parsed.className ?? "Instance",
    };
  } catch {
    return null;
  }
}

/** Scan one instance directory into a sourcemap node. `baseDir` is where sourcemap.json lives. */
async function scanDir(
  dir: string,
  dirName: string,
  baseDir: string,
): Promise<SourcemapNode | null> {
  const props = await readProps(dir, dirName);
  if (!props) return null;

  const node: SourcemapNode = { name: props.name, className: props.className };

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const filePaths: string[] = [];
  const children: SourcemapNode[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".luau")) {
      filePaths.push(toPosix(path.relative(baseDir, full)));
    } else if (entry.isDirectory()) {
      const child = await scanDir(full, entry.name, baseDir);
      if (child) children.push(child);
    }
  }

  if (filePaths.length > 0) node.filePaths = filePaths;
  if (children.length > 0) node.children = children;
  return node;
}

/**
 * Build sourcemap.json at `placeDir`, treating each top-level directory under
 * `explorerDir` as a child service of the DataModel.
 */
export async function writeSourcemap(
  placeDir: string,
  explorerDir: string,
): Promise<void> {
  const root: SourcemapNode = { name: "game", className: "DataModel", children: [] };

  let topDirs: string[] = [];
  try {
    const entries = await fs.readdir(explorerDir, { withFileTypes: true });
    topDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    topDirs = [];
  }

  for (const name of topDirs) {
    const child = await scanDir(path.join(explorerDir, name), name, placeDir);
    if (child) root.children!.push(child);
  }

  await fs.writeFile(
    path.join(placeDir, "sourcemap.json"),
    JSON.stringify(root, null, 2),
    "utf8",
  );
}
