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
import { callStudio } from "../services/studio.js";
import type { StudioEvent } from "../types.js";
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

interface SyncStatus {
  running: boolean;
  roots: string[];
  placeId: number | null;
  scriptCount: number;
  syncDir: string;
}

function log(message: string): void {
  process.stderr.write(`[roblox-mcp-pro:sync] ${message}\n`);
}

function syncRootDir(): string {
  return process.env.ROBLOX_MCP_SYNC_DIR ?? path.join(process.cwd(), "roblox-mcp-sync");
}

class SyncEngine {
  private running = false;
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
      roots: this.roots,
      placeId: this.placeId,
      scriptCount: this.instanceToFile.size,
      syncDir: this.explorerDir || syncRootDir(),
    };
  }

  /** Start syncing the given roots (defaults to the script-bearing services). */
  async start(roots?: string[]): Promise<SyncStatus> {
    if (this.running) await this.stop();
    this.roots = roots && roots.length > 0 ? roots : DEFAULT_ROOTS;

    const info = await callStudio<{ placeId?: number }>("system_info", {});
    this.placeId = info.placeId ?? 0;
    this.placeDir = path.join(syncRootDir(), `place_${this.placeId}`);
    this.explorerDir = path.join(this.placeDir, "explorer");

    await this.pull();
    await this.startFileWatcher();
    await this.startStudioWatch();

    this.running = true;
    log(`started: ${this.roots.join(", ")} -> ${this.explorerDir}`);
    return this.status();
  }

  /** Full Studio -> disk snapshot; rebuilds the file index and sourcemap. */
  async pull(): Promise<void> {
    const snap = await callStudio<SnapshotResponse>("sync_snapshot", { roots: this.roots });
    await fs.rm(this.explorerDir, { recursive: true, force: true });
    await fs.mkdir(this.explorerDir, { recursive: true });

    this.fileToInstance.clear();
    this.instanceToFile.clear();
    for (const root of snap.roots) {
      const scripts = await writeTree(this.explorerDir, root);
      this.index(scripts);
      // Suppress the watcher events our own writes will trigger, so a pull
      // doesn't echo every file back to Studio as a "change".
      const expiry = Date.now() + 3000;
      for (const s of scripts) this.suppressFile.set(s.absPath, expiry);
    }
    await writeSourcemap(this.placeDir, this.explorerDir);
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
    if (!instancePath) return; // unknown file (new on disk) — not yet supported

    try {
      const source = await fs.readFile(absPath, "utf8");
      this.suppressStudio.set(instancePath, Date.now() + SUPPRESS_MS);
      await callStudio("sync_apply", { action: "set_source", path: instancePath, source });
      log(`FS->Studio ${instancePath}`);
    } catch (error) {
      log(`FS->Studio failed for ${instancePath}: ${String(error)}`);
    }
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
