/**
 * Local filesystem browsing for the dashboard's folder picker. The broker only
 * listens on 127.0.0.1, so exposing read-only directory listings (plus a
 * single-level mkdir for "New project") is the same trust level as the
 * existing /api/scaffold endpoint, which already writes into arbitrary dirs.
 *
 * Also keeps a small "recent project folders" list at
 * ~/.roblox-mcp-pro/recent-projects.json so auto-detection works even when no
 * agent is connected (e.g. the user opens the dashboard before their AI client).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const RECENT_FILE = path.join(os.homedir(), ".roblox-mcp-pro", "recent-projects.json");
const RECENT_MAX = 8;

export interface DirEntry {
  name: string;
  path: string;
  /** Looks like a roblox-mcp-pro project (places/, default.project.json, …). */
  isProject: boolean;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
}

/** Windows folders that are never useful as a project location. */
const SKIP_NAMES = new Set([
  "$recycle.bin",
  "system volume information",
  "recovery",
  "perflogs",
  "node_modules",
]);

/** Does this folder look like a (potential) Roblox project? Cheap checks only. */
export async function looksLikeProject(dir: string): Promise<boolean> {
  const markers = ["places", "default.project.json", "place.json", ".agents"];
  for (const marker of markers) {
    try {
      await fs.stat(path.join(dir, marker));
      return true;
    } catch {
      // keep probing
    }
  }
  return false;
}

/** List drive roots (win32) or "/" (posix) as the top of the browse tree. */
export async function listRoots(): Promise<DirEntry[]> {
  if (process.platform !== "win32") {
    return [{ name: "/", path: "/", isProject: false }];
  }
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const checks = await Promise.allSettled(
    letters.map(async (letter) => {
      const root = `${letter}:\\`;
      await fs.stat(root);
      return root;
    }),
  );
  return checks
    .filter((c): c is PromiseFulfilledResult<string> => c.status === "fulfilled")
    .map((c) => ({ name: c.value, path: c.value, isProject: false }));
}

/** List the sub-directories of `dir` (dirs only, hidden/system filtered). */
export async function browseDir(dir: string): Promise<BrowseResult> {
  const abs = path.resolve(dir);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const dirs: DirEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name.startsWith(".") || name.startsWith("$") || SKIP_NAMES.has(name.toLowerCase())) continue;
    dirs.push({
      name,
      path: path.join(abs, name),
      isProject: await looksLikeProject(path.join(abs, name)),
    });
  }
  dirs.sort((a, b) => Number(b.isProject) - Number(a.isProject) || a.name.localeCompare(b.name));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, dirs };
}

// ---- Project tab web IDE: directory listing + text file read/write --------

export interface TreeEntry {
  name: string;
  path: string;
  type: "dir" | "file";
}

/**
 * One level of the project file tree (dirs first, then files). Unlike the
 * folder picker, dotfiles are included — .agents/.claude are part of a
 * project — only system/noise folders are filtered.
 */
export async function listProjectDir(
  dir: string,
): Promise<{ path: string; isProject: boolean; entries: TreeEntry[] }> {
  const abs = path.resolve(dir);
  const raw = await fs.readdir(abs, { withFileTypes: true });
  const entries: TreeEntry[] = [];
  for (const entry of raw) {
    const name = entry.name;
    // .git is hidden like in VS Code; other dotfolders (.agents, .claude) matter.
    if (name.startsWith("$") || name === ".git" || SKIP_NAMES.has(name.toLowerCase())) continue;
    if (!entry.isDirectory() && !entry.isFile()) continue;
    entries.push({ name, path: path.join(abs, name), type: entry.isDirectory() ? "dir" : "file" });
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
  );
  return { path: abs, isProject: await looksLikeProject(abs), entries };
}

/** Editor size cap — the dashboard editor is for scripts, not assets. */
const MAX_EDIT_BYTES = 1024 * 1024;

export async function readTextFile(file: string): Promise<{ path: string; content: string }> {
  const abs = path.resolve(file);
  const st = await fs.stat(abs);
  if (!st.isFile()) throw new Error("not a file");
  if (st.size > MAX_EDIT_BYTES) throw new Error("file is too large to edit here (>1 MB)");
  const buf = await fs.readFile(abs);
  if (buf.includes(0)) throw new Error("binary file — not editable here");
  return { path: abs, content: buf.toString("utf8") };
}

export async function writeTextFile(file: string, content: string): Promise<{ path: string }> {
  const abs = path.resolve(file);
  await fs.writeFile(abs, content, "utf8");
  return { path: abs };
}

/** Recently used project folders, most recent first. Existing dirs only. */
export async function loadRecentProjects(): Promise<string[]> {
  let saved: string[];
  try {
    saved = JSON.parse(await fs.readFile(RECENT_FILE, "utf8")) as string[];
    if (!Array.isArray(saved)) return [];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const dir of saved) {
    if (typeof dir !== "string") continue;
    try {
      await fs.stat(dir);
      out.push(dir);
    } catch {
      // gone — drop it
    }
  }
  return out;
}

/** Remember a folder the user actually used (sync start / scaffold). */
export async function rememberProject(dir: string): Promise<void> {
  try {
    const abs = path.resolve(dir);
    const current = await loadRecentProjects();
    const next = [abs, ...current.filter((d) => d !== abs)].slice(0, RECENT_MAX);
    await fs.mkdir(path.dirname(RECENT_FILE), { recursive: true });
    await fs.writeFile(RECENT_FILE, JSON.stringify(next, null, 2), "utf8");
  } catch {
    // best-effort; never fail the action that triggered it
  }
}
