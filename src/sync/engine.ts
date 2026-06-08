/**
 * Sync engine: keeps a Studio subtree and an on-disk mirror in step.
 *
 *   - pull:  Studio -> disk (full snapshot, also rebuilds sourcemap)
 *   - FS -> Studio:  watch *.luau files; on change push source into Studio
 *   - Studio -> FS:  receive change events from the plugin; write files
 *
 * An echo-guard suppresses the change a write triggers on the other side so the
 * two directions don't ping-pong.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { bridge } from "../services/bridge.js";
import type { StudioEvent } from "../types.js";

/**
 * The sync engine runs *inside the broker process*, so it talks to Studio
 * directly via the local bridge queue rather than the client transport.
 */
function callStudio<T = unknown>(tool: string, args: unknown): Promise<T> {
  return bridge.enqueue(tool, args) as Promise<T>;
}
import {
  writeTree,
  type ScriptFile,
  type SnapshotRoot,
} from "./mirror.js";
import { writeSourcemap } from "./sourcemap.js";

const SUPPRESS_MS = 2000;
const RESYNC_DEBOUNCE_MS = 1500;

const DEFAULT_ROOTS = [
  "ServerScriptService",
  "ReplicatedStorage",
  "StarterGui",
  "StarterPlayer",
  "ServerStorage",
];

interface SnapshotResponse {
  roots: SnapshotRoot[];
}

/**
 * Sync direction:
 *  - two-way:        disk <-> Studio (default)
 *  - studio-to-disk: Studio -> disk only (Studio is the source of truth; live
 *                    edits mirror to files, disk edits are ignored)
 *  - disk-to-studio: disk -> Studio only (files are the source of truth; file
 *                    edits push to Studio, Studio edits are ignored)
 */
export type SyncMode = "two-way" | "studio-to-disk" | "disk-to-studio";

const SYNC_MODES: readonly SyncMode[] = ["two-way", "studio-to-disk", "disk-to-studio"];

function normalizeMode(mode: unknown): SyncMode {
  return typeof mode === "string" && SYNC_MODES.includes(mode as SyncMode)
    ? (mode as SyncMode)
    : "two-way";
}

interface SyncStatus {
  running: boolean;
  mode: SyncMode;
  roots: string[];
  placeId: number | null;
  scriptCount: number;
  syncDir: string;
  initialDirection?: "studio-to-disk" | "disk-to-studio";
}

function log(message: string): void {
  process.stderr.write(`[roblox-mcp-pro:sync] ${message}\n`);
}

function syncRootDir(): string {
  return process.env.ROBLOX_MCP_SYNC_DIR ?? process.cwd();
}

/** Reverse the name escaping done by the mirror (`~~` -> `~`). */
function deEscape(name: string): string {
  return name.replace(/~~/g, "~");
}

/** Determine the script ClassName from a .luau filename suffix, or null. */
function classFromFile(file: string): string | null {
  if (file.endsWith(".server.luau")) return "Script";
  if (file.endsWith(".client.luau")) return "LocalScript";
  if (file.endsWith(".module.luau")) return "ModuleScript";
  return null;
}

class SyncEngine {
  private running = false;
  private mode: SyncMode = "two-way";
  private initialDirection?: "studio-to-disk" | "disk-to-studio";
  private roots: string[] = [];
  private placeId: number | null = null;
  private placeDir = "";
  private explorerDir = "";
  private fileToInstance = new Map<string, string>();
  private instanceToFile = new Map<string, string>();
  private watcher: FSWatcher | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly suppressFile = new Map<string, number>();
  private readonly suppressStudio = new Map<string, number>();
  private resyncTimer: NodeJS.Timeout | null = null;

  isRunning(): boolean {
    return this.running;
  }

  status(): SyncStatus {
    return {
      running: this.running,
      mode: this.mode,
      roots: this.roots,
      placeId: this.placeId,
      scriptCount: this.instanceToFile.size,
      syncDir: this.explorerDir || syncRootDir(),
      initialDirection: this.initialDirection,
    };
  }

  /** Start syncing the given roots (defaults to the script-bearing services). */
  async start(
    roots?: string[],
    mode?: SyncMode,
    initialDirection?: "studio-to-disk" | "disk-to-studio",
  ): Promise<SyncStatus> {
    if (this.running) await this.stop();
    this.mode = normalizeMode(mode);
    this.initialDirection = initialDirection;
    this.roots = roots && roots.length > 0 ? roots : DEFAULT_ROOTS;

    const info = await callStudio<{ placeId?: number }>("system_info", {});
    this.placeId = info.placeId ?? 0;
    
    const isFlat = process.env.ROBLOX_MCP_FLAT_SYNC !== "false";
    if (isFlat) {
      this.placeDir = syncRootDir();
    } else {
      this.placeDir = path.join(syncRootDir(), `place_${this.placeId}`);
    }
    this.explorerDir = path.join(this.placeDir, "explorer");

    if (initialDirection === "disk-to-studio") {
      // disk-to-studio initial sync: do not clear local disk files.
      // Scan disk folder structure to index them, then push to Studio.
      await fs.mkdir(this.explorerDir, { recursive: true });
      await this.scanDiskAndIndex();
      await this.push();
      // disk -> Studio live mirroring, unless we're mirroring Studio -> disk only.
      if (this.mode !== "studio-to-disk") {
        await this.startFileWatcher();
      }
    } else {
      // Studio -> disk initial sync: pull everything.
      // pull() rebuilds the mirror and (unless Studio-only) starts the file watcher.
      await this.pull();
    }

    // Studio -> disk live mirroring, unless we're pushing disk -> Studio only.
    if (this.mode !== "disk-to-studio") {
      await this.startStudioWatch();
    }

    this.running = true;
    log(`started (${this.mode}, initial: ${initialDirection ?? "studio-to-disk"}): ${this.roots.join(", ")} -> ${this.explorerDir}`);
    return this.status();
  }

  private async scanDiskAndIndex(): Promise<void> {
    this.fileToInstance.clear();
    this.instanceToFile.clear();

    const scripts: ScriptFile[] = [];
    const scan = async (dir: string, parentInstancePath: string) => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subDir = path.join(dir, entry.name);
            let name = deEscape(entry.name);

            // Try to read .props.json to get the exact Roblox name (with spaces, symbols, etc.)
            const propsPath = path.join(subDir, `${entry.name}.props.json`);
            try {
              const propsContent = await fs.readFile(propsPath, "utf8");
              const props = JSON.parse(propsContent) as { name?: string };
              if (props.name) {
                name = props.name;
              }
            } catch {
              // Ignore and use de-escaped folder name
            }

            const instancePath = `${parentInstancePath}.${name}`;

            // Look for any .luau script files in this subdirectory
            const subEntries = await fs.readdir(subDir);
            for (const subEntry of subEntries) {
              if (subEntry.endsWith(".luau")) {
                const absPath = path.join(subDir, subEntry);
                scripts.push({ absPath, instancePath });
              }
            }

            // Recursively scan children
            await scan(subDir, instancePath);
          }
        }
      } catch (err) {
        log(`Error scanning directory ${dir}: ${String(err)}`);
      }
    };

    await scan(this.explorerDir, "game");

    // Now index them
    this.index(scripts);
    log(`Indexed ${this.instanceToFile.size} scripts from disk`);
  }


  /**
   * Full Studio -> disk snapshot; rebuilds the file index and sourcemap.
   * The file watcher is closed while we rewrite the tree and reopened with
   * `ignoreInitial` afterward, so our own writes never fire watcher events.
   */
  async pull(): Promise<void> {
    const snap = await callStudio<SnapshotResponse>("sync_snapshot", { roots: this.roots });
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    await fs.rm(this.explorerDir, { recursive: true, force: true });
    await fs.mkdir(this.explorerDir, { recursive: true });

    this.fileToInstance.clear();
    this.instanceToFile.clear();
    for (const root of snap.roots) {
      const scripts = await writeTree(this.explorerDir, root);
      this.index(scripts);
    }
    await writeSourcemap(this.placeDir, this.explorerDir);
    // disk -> Studio live mirroring, unless we're mirroring Studio -> disk only.
    if (this.mode !== "studio-to-disk") {
      await this.startFileWatcher();
    }
    log(`pulled ${this.instanceToFile.size} scripts from Studio`);
  }

  /** Force disk -> Studio for every tracked script. */
  async push(): Promise<number> {
    let count = 0;
    for (const [instancePath, absPath] of this.instanceToFile) {
      const source = await fs.readFile(absPath, "utf8");
      this.suppressStudio.set(instancePath, Date.now() + SUPPRESS_MS);
      await callStudio("sync_apply", { action: "set_source", path: instancePath, source });
      count += 1;
    }
    log(`pushed ${count} scripts to Studio`);
    return count;
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.running) {
      try {
        await callStudio("sync_watch", { action: "unwatch" });
      } catch {
        // Plugin may already be gone; ignore.
      }
    }
    this.running = false;
    log("stopped");
  }

  // --- internals -----------------------------------------------------------

  private index(scripts: ScriptFile[]): void {
    for (const s of scripts) {
      this.fileToInstance.set(s.absPath, s.instancePath);
      this.instanceToFile.set(s.instancePath, s.absPath);
    }
  }

  private async startFileWatcher(): Promise<void> {
    this.watcher = chokidar.watch(this.explorerDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
    });
    this.watcher.on("change", (p: string) => {
      if (p.endsWith(".luau")) void this.onFileChange(p);
    });
    this.watcher.on("add", (p: string) => {
      if (p.endsWith(".luau")) void this.onFileAdd(p);
    });
    this.watcher.on("unlink", (p: string) => {
      if (p.endsWith(".luau")) void this.onFileUnlink(p);
    });
  }

  private async startStudioWatch(): Promise<void> {
    this.unsubscribe = bridge.onEvent((event) => this.onStudioEvent(event));
    await callStudio("sync_watch", { action: "watch", roots: this.roots });
  }

  private consume(map: Map<string, number>, key: string): boolean {
    const expiry = map.get(key);
    if (expiry !== undefined) {
      map.delete(key);
      if (expiry > Date.now()) return true;
    }
    return false;
  }

  private async onFileChange(absPath: string): Promise<void> {
    if (!this.running) return;
    if (this.consume(this.suppressFile, absPath)) return; // echo of a Studio write

    const instancePath = this.fileToInstance.get(absPath);
    if (!instancePath) {
      // A file we don't track changed — treat it as a new script.
      void this.onFileAdd(absPath);
      return;
    }

    try {
      const source = await fs.readFile(absPath, "utf8");
      this.suppressStudio.set(instancePath, Date.now() + SUPPRESS_MS);
      await callStudio("sync_apply", { action: "set_source", path: instancePath, source });
      log(`FS->Studio ${instancePath}`);
    } catch (error) {
      log(`FS->Studio failed for ${instancePath}: ${String(error)}`);
    }
  }

  /** A new .luau file appeared on disk -> create the corresponding script in Studio. */
  private async onFileAdd(absPath: string): Promise<void> {
    if (!this.running) return;
    if (this.fileToInstance.has(absPath)) return; // already tracked (handled by change)
    if (this.consume(this.suppressFile, absPath)) return; // our own write

    const className = classFromFile(absPath);
    if (!className) return;
    const dir = path.dirname(absPath);
    const name = deEscape(path.basename(dir));
    const parentPath = this.instancePathFromDir(path.dirname(dir));
    if (!parentPath) return;

    try {
      const source = await fs.readFile(absPath, "utf8");
      const instancePath = `${parentPath}.${name}`;
      this.suppressStudio.set(instancePath, Date.now() + SUPPRESS_MS);
      const res = await callStudio<{ ok: boolean; path?: string; error?: string }>(
        "manage_scripts",
        { action: "create", class_name: className, parent: parentPath, name, source },
      );
      if (res.ok) {
        const created = res.path ?? instancePath;
        this.fileToInstance.set(absPath, created);
        this.instanceToFile.set(created, absPath);
        log(`FS->Studio created ${created}`);
      } else {
        log(`FS->Studio create failed for ${instancePath}: ${res.error ?? "unknown"}`);
      }
    } catch (error) {
      log(`FS->Studio create failed: ${String(error)}`);
    }
  }

  /** A tracked .luau file was deleted on disk -> delete the script in Studio. */
  private async onFileUnlink(absPath: string): Promise<void> {
    if (!this.running) return;
    const instancePath = this.fileToInstance.get(absPath);
    if (!instancePath) return;
    if (this.consume(this.suppressFile, absPath)) return; // our own removal

    this.fileToInstance.delete(absPath);
    this.instanceToFile.delete(instancePath);
    try {
      this.suppressStudio.set(instancePath, Date.now() + SUPPRESS_MS);
      await callStudio("mutate_instances", {
        operations: [{ action: "delete", path: instancePath }],
      });
      log(`FS->Studio deleted ${instancePath}`);
    } catch (error) {
      log(`FS->Studio delete failed for ${instancePath}: ${String(error)}`);
    }
  }

  /** Map a directory under explorerDir to its instance path (e.g. "game.ServerScriptService.Folder"). */
  private instancePathFromDir(dir: string): string | null {
    const rel = path.relative(this.explorerDir, dir);
    if (rel.startsWith("..")) return null;
    const segments = rel.split(path.sep).filter((s) => s.length > 0).map(deEscape);
    return `game${segments.length ? "." + segments.join(".") : ""}`;
  }

  private async onStudioEvent(event: StudioEvent): Promise<void> {
    if (!this.running) return;

    if (event.kind === "source_changed") {
      const instancePath = event.path;
      if (this.consume(this.suppressStudio, instancePath)) return; // echo of an FS write
      const absPath = this.instanceToFile.get(instancePath);
      if (!absPath) {
        this.scheduleResync(); // new script we don't track yet
        return;
      }
      const data = event.data as { source?: string } | undefined;
      if (typeof data?.source !== "string") return;
      this.suppressFile.set(absPath, Date.now() + SUPPRESS_MS);
      await fs.writeFile(absPath, data.source, "utf8");
      log(`Studio->FS ${instancePath}`);
    } else if (event.kind === "added" || event.kind === "removing") {
      this.scheduleResync(); // structural change: re-snapshot after things settle
    }
  }

  /** Debounce a full re-pull for structural changes (add/remove instances). */
  private scheduleResync(): void {
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      void this.pull().catch((e) => log(`resync failed: ${String(e)}`));
    }, RESYNC_DEBOUNCE_MS);
  }
}

export const syncEngine = new SyncEngine();
