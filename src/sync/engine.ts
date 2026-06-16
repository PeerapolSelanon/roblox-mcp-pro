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
 * Session routing is handled via SyncEngine#callStudio (instance method).
 */
import {
  writeTree,
  escapeName,
  type ScriptFile,
  type SnapshotRoot,
} from "./mirror.js";
import { writeSourcemap } from "./sourcemap.js";
import { defaultProjectJson } from "../broker/scaffold.js";

const SUPPRESS_MS = 2000;
const RESYNC_DEBOUNCE_MS = 1500;

const DEFAULT_ROOTS = [
  "ServerScriptService",
  "ReplicatedStorage",
  "ReplicatedFirst",
  "StarterGui",
  "StarterPlayer",
  "ServerStorage",
  "Lighting",
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
  placeName: string | null;
  scriptCount: number;
  syncDir: string;
  /** Universe root (the folder containing places/); "" until sync has started. */
  baseDir: string;
  initialDirection?: "studio-to-disk" | "disk-to-studio";
  /** True while Studio is in a Run-mode playtest (sync paused, FS edits queued). */
  playtestActive: boolean;
}

function log(message: string): void {
  process.stderr.write(`[roblox-mcp-pro:sync] ${message}\n`);
}

function syncRootDir(): string {
  return process.env.ROBLOX_MCP_SYNC_DIR ?? process.cwd();
}

/**
 * One project folder = one universe; each place mirrors into its own
 * `places/<Name>_<placeId>/` folder. Identity is the `placeId` recorded in
 * `place.json` (folder names are cosmetic and may be renamed); unsaved places
 * (placeId 0) fall back to matching by name. This is what prevents a snapshot
 * of one place from ever landing in another place's mirror.
 */
async function resolvePlaceFolder(baseDir: string, placeId: number, placeName: string): Promise<string> {
  const placesDir = path.join(baseDir, "places");
  await fs.mkdir(placesDir, { recursive: true });

  let entries: string[] = [];
  try {
    entries = await fs.readdir(placesDir);
  } catch {
    // Unreadable places dir: fall through and create a fresh folder.
  }
  for (const entry of entries) {
    const dir = path.join(placesDir, entry);
    try {
      const raw = await fs.readFile(path.join(dir, "place.json"), "utf8");
      const meta = JSON.parse(raw) as { placeId?: number; name?: string };
      const match = placeId > 0 ? meta.placeId === placeId : meta.placeId === 0 && meta.name === placeName;
      if (match) {
        if (meta.name !== placeName || meta.placeId !== placeId) {
          // Keep the recorded name fresh (place renamed / first publish).
          await fs.writeFile(
            path.join(dir, "place.json"),
            JSON.stringify({ placeId, name: placeName }, null, 2),
            "utf8",
          );
        }
        return dir;
      }
    } catch {
      // Not a place folder (no/invalid place.json) — skip it.
    }
  }

  const dir = path.join(placesDir, `${escapeName(placeName)}_${placeId}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "place.json"),
    JSON.stringify({ placeId, name: placeName }, null, 2),
    "utf8",
  );
  // Seed a per-place Rojo-style project file for luau-lsp etc. (never overwrite).
  try {
    await fs.writeFile(path.join(dir, "default.project.json"), defaultProjectJson(placeName), { flag: "wx" });
  } catch {
    // Already there — fine.
  }
  return dir;
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
  private placeName: string | null = null;
  private baseDir = "";
  private placeDir = "";
  private explorerDir = "";
  private fileToInstance = new Map<string, string>();
  private instanceToFile = new Map<string, string>();
  private watcher: FSWatcher | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly suppressFile = new Map<string, number>();
  private readonly suppressStudio = new Map<string, number>();
  private resyncTimer: NodeJS.Timeout | null = null;
  /** The Studio session this sync engine is pinned to. */
  private pinnedSession = "default";
  // Run-mode awareness: while Studio is in a playtest, FS edits are queued
  // (replayed after stop) and Studio events are dropped (transient sim state).
  private runActive = false;
  private readonly pendingFsChanges = new Set<string>();
  private readonly pendingFsUnlinks = new Set<string>();
  private sawStructuralDuringRun = false;
  // Recent sync activity, newest last; capped so it never grows unbounded.
  private readonly historyLog: { at: string; kind: string; detail: string }[] = [];
  private lastPullAt: string | null = null;
  private lastPushAt: string | null = null;

  /** Forward a tool call to the pinned Studio session via the bridge. */
  private callStudio<T = unknown>(tool: string, args: unknown): Promise<T> {
    return bridge.enqueue(this.pinnedSession, tool, args) as Promise<T>;
  }

  private record(kind: string, detail: string): void {
    this.historyLog.push({ at: new Date().toISOString(), kind, detail });
    if (this.historyLog.length > 100) this.historyLog.shift();
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Recent sync events (newest last). */
  history(limit = 30): { at: string; kind: string; detail: string }[] {
    return this.historyLog.slice(-Math.max(1, Math.min(limit, 100)));
  }

  /** Counts + timing for a quick "where is sync at" answer. */
  progress(): Record<string, unknown> {
    return {
      running: this.running,
      mode: this.mode,
      scriptCount: this.instanceToFile.size,
      lastPullAt: this.lastPullAt,
      lastPushAt: this.lastPushAt,
      events: this.historyLog.length,
      syncDir: this.explorerDir || syncRootDir(),
    };
  }

  /** Resolve a read/write target to an absolute mirror path, or null. Accepts an
   *  instance path ("game.ReplicatedStorage.Mod") or a path relative to the
   *  explorer dir. Guards against escaping the mirror. */
  private resolveMirrorPath(target: string): string | null {
    const direct = this.instanceToFile.get(target);
    if (direct) return direct;
    const withGame = target.startsWith("game.") ? target : `game.${target}`;
    const viaGame = this.instanceToFile.get(withGame);
    if (viaGame) return viaGame;
    // Treat as a relative file path under explorer/.
    const abs = path.resolve(this.explorerDir, target);
    const root = path.resolve(this.explorerDir);
    if (abs === root || abs.startsWith(root + path.sep)) return abs;
    return null;
  }

  /** Read a mirrored script file by instance path or relative file path. */
  async readFile(target: string): Promise<{ ok: boolean; path?: string; content?: string; error?: string }> {
    const abs = this.resolveMirrorPath(target);
    if (!abs) return { ok: false, error: `not a tracked mirror file: ${target}` };
    try {
      const content = await fs.readFile(abs, "utf8");
      this.record("read_file", target);
      return { ok: true, path: abs, content };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Write a mirror file; in two-way / disk-to-studio the watcher pushes it to Studio. */
  async writeFile(
    target: string,
    content: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    const abs = this.resolveMirrorPath(target);
    if (!abs) return { ok: false, error: `not a tracked mirror file: ${target}` };
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
      this.record("write_file", target);
      return { ok: true, path: abs };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  status(): SyncStatus {
    return {
      running: this.running,
      mode: this.mode,
      roots: this.roots,
      placeId: this.placeId,
      placeName: this.placeName,
      scriptCount: this.instanceToFile.size,
      syncDir: this.explorerDir || syncRootDir(),
      baseDir: this.baseDir,
      initialDirection: this.initialDirection,
      playtestActive: this.runActive,
    };
  }

  /** Start syncing the given roots (defaults to the script-bearing services). */
  async start(
    roots?: string[],
    mode?: SyncMode,
    initialDirection?: "studio-to-disk" | "disk-to-studio",
    customSyncDir?: string,
    sessionId: string = "default",
  ): Promise<SyncStatus> {
    this.pinnedSession = sessionId;
    if (this.running) await this.stop();
    this.mode = normalizeMode(mode);
    this.initialDirection = initialDirection;
    this.roots = roots && roots.length > 0 ? roots : DEFAULT_ROOTS;

    this.baseDir = customSyncDir ?? syncRootDir();
    await this.resolvePlaceDirs();

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

    // Always listen for bridge events (run_state_changed matters in every mode);
    // sync change events from Studio are only requested when we mirror them.
    this.unsubscribe = bridge.onEvent((event) => void this.onStudioEvent(event));
    if (this.mode !== "disk-to-studio") {
      await this.callStudio("sync_watch", { action: "watch", roots: this.roots });
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
   * Ask Studio which place is open and point placeDir/explorerDir at its
   * mirror folder. With ROBLOX_MCP_FLAT_SYNC=true the legacy single-place
   * layout (explorer/ at the project root) is kept instead.
   */
  private async resolvePlaceDirs(): Promise<void> {
    const info = await this.callStudio<{ placeId?: number; placeName?: string }>("system_info", {});
    this.placeId = info.placeId ?? 0;
    this.placeName = info.placeName ?? "Untitled";

    if (process.env.ROBLOX_MCP_FLAT_SYNC === "true") {
      this.placeDir = this.baseDir;
    } else {
      this.placeDir = await resolvePlaceFolder(this.baseDir, this.placeId, this.placeName);
    }
    this.explorerDir = path.join(this.placeDir, "explorer");
  }

  /**
   * Full Studio -> disk snapshot; rebuilds the file index and sourcemap.
   * The file watcher is closed while we rewrite the tree and reopened with
   * `ignoreInitial` afterward, so our own writes never fire watcher events.
   */
  async pull(): Promise<void> {
    // Re-check which place is open: Studio may have switched since we started
    // (the plugin reconnects after a place change while the engine keeps
    // running). Never write one place's snapshot into another place's folder.
    const before = this.placeId;
    await this.resolvePlaceDirs();
    if (before !== null && before !== this.placeId) {
      log(`place changed (${before} -> ${this.placeId}); mirroring to ${this.explorerDir}`);
    }
    const snap = await this.callStudio<SnapshotResponse>("sync_snapshot", { roots: this.roots });
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    await fs.mkdir(this.explorerDir, { recursive: true });

    this.fileToInstance.clear();
    this.instanceToFile.clear();
    for (const root of snap.roots) {
      // Replace only this root's own folder, leaving folders this sync doesn't
      // own (e.g. a scaffolded Workspace) intact. Wiping all of explorer/ here
      // would delete any non-synced service the user set up.
      await fs.rm(path.join(this.explorerDir, escapeName(root.tree.name)), {
        recursive: true,
        force: true,
      });
      const scripts = await writeTree(this.explorerDir, root);
      this.index(scripts);
    }
    await writeSourcemap(this.placeDir, this.explorerDir);
    // disk -> Studio live mirroring, unless we're mirroring Studio -> disk only.
    if (this.mode !== "studio-to-disk") {
      await this.startFileWatcher();
    }
    this.lastPullAt = new Date().toISOString();
    this.record("pull", `${this.instanceToFile.size} scripts`);
    log(`pulled ${this.instanceToFile.size} scripts from Studio`);
  }

  /** Force disk -> Studio for every tracked script. */
  async push(): Promise<number> {
    let count = 0;
    for (const [instancePath, absPath] of this.instanceToFile) {
      const source = await fs.readFile(absPath, "utf8");
      this.suppressStudio.set(instancePath, Date.now() + SUPPRESS_MS);
      await this.callStudio("sync_apply", { action: "set_source", path: instancePath, source });
      count += 1;
    }
    this.lastPushAt = new Date().toISOString();
    this.record("push", `${count} scripts`);
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
        await this.callStudio("sync_watch", { action: "unwatch" });
      } catch {
        // Plugin may already be gone; ignore.
      }
    }
    this.running = false;
    this.runActive = false;
    this.pendingFsChanges.clear();
    this.pendingFsUnlinks.clear();
    this.sawStructuralDuringRun = false;
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
    if (this.runActive) {
      this.pendingFsChanges.add(absPath); // replayed after the playtest stops
      return;
    }
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
      await this.callStudio("sync_apply", { action: "set_source", path: instancePath, source });
      log(`FS->Studio ${instancePath}`);
    } catch (error) {
      log(`FS->Studio failed for ${instancePath}: ${String(error)}`);
    }
  }

  /** A new .luau file appeared on disk -> create the corresponding script in Studio. */
  private async onFileAdd(absPath: string): Promise<void> {
    if (!this.running) return;
    if (this.runActive) {
      this.pendingFsChanges.add(absPath); // replayed after the playtest stops
      return;
    }
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
      const res = await this.callStudio<{ ok: boolean; path?: string; error?: string }>(
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
    if (this.runActive) {
      this.pendingFsChanges.delete(absPath);
      this.pendingFsUnlinks.add(absPath); // replayed after the playtest stops
      return;
    }
    const instancePath = this.fileToInstance.get(absPath);
    if (!instancePath) return;
    if (this.consume(this.suppressFile, absPath)) return; // our own removal

    this.fileToInstance.delete(absPath);
    this.instanceToFile.delete(instancePath);
    try {
      this.suppressStudio.set(instancePath, Date.now() + SUPPRESS_MS);
      await this.callStudio("mutate_instances", {
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

    if (event.kind === "run_state_changed") {
      const data = event.data as { state?: string } | undefined;
      await this.onRunStateChanged(data?.state ?? "edit");
      return;
    }

    if (this.runActive) {
      // Playtest in progress: simulation/script churn is transient — don't
      // mirror it. Remember structural changes so we re-pull once it stops.
      if (event.kind === "added" || event.kind === "removing") {
        this.sawStructuralDuringRun = true;
      }
      return;
    }

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

  /**
   * Playtest transitions. "running"/"paused" both count as run mode (the
   * DataModel is still in its transient simulation state while paused); only
   * "edit" ends it. On return to edit: replay queued FS edits (the agent's
   * intent wins over whatever the run left behind), then re-pull if the run
   * made structural changes we skipped.
   */
  private async onRunStateChanged(state: string): Promise<void> {
    const active = state !== "edit";
    if (active === this.runActive) return;
    this.runActive = active;

    if (active) {
      log(`playtest ${state}: sync paused, queuing FS edits`);
      return;
    }

    const unlinks = [...this.pendingFsUnlinks];
    const changes = [...this.pendingFsChanges];
    this.pendingFsUnlinks.clear();
    this.pendingFsChanges.clear();
    log(`playtest ended: replaying ${changes.length} FS edit(s), ${unlinks.length} delete(s)`);
    for (const p of unlinks) {
      await this.onFileUnlink(p);
    }
    for (const p of changes) {
      await this.onFileChange(p);
    }
    if (this.sawStructuralDuringRun) {
      this.sawStructuralDuringRun = false;
      this.scheduleResync();
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
