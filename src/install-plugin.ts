/**
 * Studio plugin distribution. The plugin (RobloxMcpPro.rbxmx) ships inside this
 * npm package, so customers never touch a GitHub release.
 *
 * - `ensurePluginInstalled()` runs automatically on server startup and copies the
 *   bundled plugin into the Roblox Plugins folder *only when it's missing or
 *   different* — so plugin updates happen with zero customer effort.
 * - `installPlugin()` is the explicit `roblox-mcp-pro install-plugin` CLI command
 *   (manual install / repair), logging to stdout/stderr.
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";

/** Absolute path to the plugin file bundled in this package. */
function bundledPluginPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "plugin", "RobloxMcpPro.rbxmx");
}

/** The local Roblox Studio plugins folder for this OS, or null if unsupported. */
function pluginsDir(): string | null {
  const platform = os.platform();
  if (platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Roblox", "Plugins");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Documents", "Roblox", "Plugins");
  }
  return null;
}

export type PluginSyncStatus =
  | "installed" // newly placed
  | "updated" // replaced an older copy
  | "current" // already up to date
  | "unsupported" // OS without a known plugins folder
  | "error";

export interface PluginSyncResult {
  status: PluginSyncStatus;
  dest?: string;
}

/**
 * Copy the bundled plugin into the Roblox Plugins folder if it's missing or
 * differs from what's installed. Best-effort: never throws.
 */
export async function ensurePluginInstalled(): Promise<PluginSyncResult> {
  try {
    const dir = pluginsDir();
    if (!dir) return { status: "unsupported" };
    const dest = path.join(dir, "RobloxMcpPro.rbxmx");
    const source = await fs.readFile(bundledPluginPath());

    let existing: Buffer | null = null;
    try {
      existing = await fs.readFile(dest);
    } catch {
      existing = null;
    }
    if (existing?.equals(source)) return { status: "current", dest };

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(dest, source);
    return { status: existing ? "updated" : "installed", dest };
  } catch {
    return { status: "error" };
  }
}

/** Explicit CLI command: install/repair the plugin with human-readable output. */
export async function installPlugin(): Promise<void> {
  const dir = pluginsDir();
  if (!dir) {
    console.error(
      "Auto-install isn't supported on this OS. Copy the plugin file into your\n" +
        "Roblox Studio plugins folder manually. File location:\n  " +
        bundledPluginPath(),
    );
    process.exitCode = 1;
    return;
  }

  const result = await ensurePluginInstalled();
  if (result.status === "error") {
    console.error(`Failed to install the plugin. Try again or copy it manually from:\n  ${bundledPluginPath()}`);
    process.exitCode = 1;
    return;
  }

  const dest = result.dest ?? path.join(dir, "RobloxMcpPro.rbxmx");
  console.log(`✅ Roblox MCP Pro plugin is installed at:\n  ${dest}\n`);
  console.log(
    "Next: open Roblox Studio and click the MCP toolbar button to connect.\n" +
      "(If Studio was already open, restart it so the plugin loads.)",
  );
}
