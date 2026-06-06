/**
 * `roblox-mcp-pro install-plugin` — copies the bundled Studio plugin
 * (RobloxMcpPro.rbxmx, shipped inside this npm package) into the local Roblox
 * Plugins folder. This is how customers get the plugin without needing access to
 * the (private) source repo or a GitHub Release.
 *
 * Runs as a one-shot CLI command, so it logs to stdout/stderr normally (it is
 * NOT the MCP stdio server — see index.ts for the argv dispatch).
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";

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

export async function installPlugin(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = path.join(here, "..", "plugin", "RobloxMcpPro.rbxmx");

  const dir = pluginsDir();
  if (!dir) {
    console.error(
      "Auto-install isn't supported on this OS. Copy the plugin file into your\n" +
        "Roblox Studio plugins folder manually. File location:\n  " +
        source,
    );
    process.exitCode = 1;
    return;
  }

  try {
    await fs.access(source);
  } catch {
    console.error(
      `Bundled plugin not found at:\n  ${source}\n` +
        "Reinstall the package (npm i -g roblox-mcp-pro) and try again.",
    );
    process.exitCode = 1;
    return;
  }

  const dest = path.join(dir, "RobloxMcpPro.rbxmx");
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(source, dest);

  console.log(`✅ Installed the Roblox MCP Pro plugin to:\n  ${dest}\n`);
  console.log(
    "Next: open Roblox Studio and click the MCP toolbar button to connect.\n" +
      "(If Studio was already open, restart it so the plugin loads.)",
  );
}
