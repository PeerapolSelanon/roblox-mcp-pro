/**
 * Project scaffolding: create a fresh, empty Roblox project skeleton on disk so
 * an agent (or the user) can start from a clean, sync-ready layout. Invoked from
 * the dashboard "New project" button via `POST /api/scaffold`.
 *
 * Layout created under the target folder (one project = one universe):
 *   places/                      -> one sub-folder per place, created by the
 *                                   sync engine on first connect:
 *                                   places/<Name>_<placeId>/{place.json,
 *                                   explorer/, default.project.json, sourcemap.json}
 *   selene.toml / wally.toml     -> lint + package-manager config (shared)
 *   .agents/skills/roblox-*      -> the project's bundled skills (for non-Claude agents)
 *   .claude/skills/roblox-*      -> the same skills (for Claude Code)
 *
 * Nothing is overwritten: existing files/folders are kept and reported as
 * "skipped", so running it twice is safe and it can fill gaps in a partial repo.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Package root = two levels up from dist/broker (or src/broker in dev). */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The roblox skills that ship in the npm package (see package.json `files`). */
const PROJECT_SKILLS = [
  "roblox-mcp-pro",
  "roblox-studio-plugin",
  "roblox-ui-animation",
  "roblox-ui-from-image",
];

export interface ScaffoldResult {
  dir: string;
  created: string[];
  skipped: string[];
}

function log(message: string): void {
  process.stderr.write(`[roblox-mcp-pro:scaffold] ${message}\n`);
}

/** Write a file only if it does not already exist. Records the outcome. */
async function writeIfAbsent(
  abs: string,
  rel: string,
  content: string,
  result: ScaffoldResult,
): Promise<void> {
  try {
    await fs.writeFile(abs, content, { encoding: "utf8", flag: "wx" });
    result.created.push(rel);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      result.skipped.push(rel);
    } else {
      throw e;
    }
  }
}

const SELENE_TOML = `std = "roblox"
`;

function wallyToml(slug: string): string {
  return `[package]
name = "you/${slug}"
version = "0.1.0"
registry = "https://github.com/UpliftGames/wally-index"
realm = "shared"

[dependencies]
`;
}

/** Rojo-style project file pointing at an explorer/ mirror (shared with the sync engine's per-place seeding). */
export function defaultProjectJson(name: string): string {
  return JSON.stringify(
    {
      name,
      tree: {
        $className: "DataModel",
        Workspace: { $path: "explorer/Workspace" },
        ReplicatedStorage: { $path: "explorer/ReplicatedStorage" },
        ReplicatedFirst: { $path: "explorer/ReplicatedFirst" },
        ServerScriptService: { $path: "explorer/ServerScriptService" },
        ServerStorage: { $path: "explorer/ServerStorage" },
        StarterGui: { $path: "explorer/StarterGui" },
        Lighting: { $path: "explorer/Lighting" },
        StarterPlayer: {
          StarterPlayerScripts: { $path: "explorer/StarterPlayer/StarterPlayerScripts" },
          StarterCharacterScripts: { $path: "explorer/StarterPlayer/StarterCharacterScripts" },
        },
      },
    },
    null,
    2,
  );
}

/** Copy a bundled skill folder into target/<dest>/skills/<skill>, never overwriting. */
async function copySkill(
  src: string,
  destSkillsDir: string,
  skill: string,
  destRelBase: string,
  result: ScaffoldResult,
): Promise<void> {
  const dest = path.join(destSkillsDir, skill);
  if (path.resolve(src) === path.resolve(dest)) {
    // Scaffolding into the package's own repo: source is the destination.
    result.skipped.push(`${destRelBase}/${skill}`);
    return;
  }
  const existed = await fs
    .stat(dest)
    .then(() => true)
    .catch(() => false);
  try {
    await fs.cp(src, dest, { recursive: true, force: false, errorOnExist: false });
    result[existed ? "skipped" : "created"].push(`${destRelBase}/${skill}`);
  } catch (e) {
    log(`skill copy failed for ${skill}: ${String(e)}`);
    result.skipped.push(`${destRelBase}/${skill}`);
  }
}

/**
 * Create an empty Roblox project skeleton at `targetDir`. Existing files are
 * left untouched. Returns lists of what was created vs. skipped.
 */
export async function scaffoldProject(targetDir: string): Promise<ScaffoldResult> {
  const dir = path.resolve(targetDir);
  const result: ScaffoldResult = { dir, created: [], skipped: [] };

  await fs.mkdir(dir, { recursive: true });
  const projectName = path.basename(dir) || "RobloxProject";
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";

  // 1. places/ — per-place mirrors are created by the sync engine on first
  // connect (identity = placeId in place.json); scaffold just makes the home.
  await fs.mkdir(path.join(dir, "places"), { recursive: true });
  await writeIfAbsent(path.join(dir, "places", ".gitkeep"), "places/.gitkeep", "", result);

  // 2. root config files (never overwritten, shared across all places)
  await writeIfAbsent(path.join(dir, "selene.toml"), "selene.toml", SELENE_TOML, result);
  await writeIfAbsent(path.join(dir, "wally.toml"), "wally.toml", wallyToml(slug), result);

  // 3. project skills -> .agents/skills and .claude/skills (must not be missing)
  const skillsSrcDir = path.join(PACKAGE_ROOT, ".agents", "skills");
  for (const target of [".agents", ".claude"] as const) {
    const destSkillsDir = path.join(dir, target, "skills");
    await fs.mkdir(destSkillsDir, { recursive: true });
    for (const skill of PROJECT_SKILLS) {
      const src = path.join(skillsSrcDir, skill);
      const exists = await fs.stat(src).then(() => true).catch(() => false);
      if (!exists) {
        result.skipped.push(`${target}/skills/${skill}`);
        continue;
      }
      await copySkill(src, destSkillsDir, skill, `${target}/skills`, result);
    }
  }

  log(`scaffolded ${dir}: ${result.created.length} created, ${result.skipped.length} skipped`);
  return result;
}
