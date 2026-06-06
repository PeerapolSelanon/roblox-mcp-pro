/**
 * Agent-skill distribution. The product skills (guides that teach an agent how
 * to drive the tools well) ship inside this npm package. On server startup we
 * copy them into the skill folders of any skill-capable client present on the
 * machine, so a customer gets them with zero effort, the same way the Studio
 * plugin self-installs.
 *
 * Only Claude Code (~/.claude/skills) and Codex (~/.codex/skills) have a skills
 * mechanism today; other clients still work, just without the extra guidance.
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";

/** Product skills bundled in the package (must match package.json `files`). */
const SKILLS = [
  "roblox-mcp-pro",
  "roblox-studio-plugin",
  "roblox-ui-animation",
  "roblox-ui-from-image",
];

/** Skill-capable clients: parent dir that must exist → its skills/ root. */
function skillTargets(): { parent: string; skillsDir: string }[] {
  const h = os.homedir();
  return [
    { parent: path.join(h, ".claude"), skillsDir: path.join(h, ".claude", "skills") },
    { parent: path.join(h, ".codex"), skillsDir: path.join(h, ".codex", "skills") },
  ];
}

function skillsSourceDir(): string {
  // dist/install-skills.js → ../.agents/skills (package root; shipped by npm).
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", ".agents", "skills");
}

async function readIfPresent(p: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(p);
  } catch {
    return null;
  }
}

export interface SkillSyncResult {
  /** Number of skill files newly written or updated. */
  changed: number;
  /** Skill-capable clients that received skills. */
  clients: number;
}

/**
 * Copy bundled skills into each present skill-capable client, writing only when
 * a file is missing or different. Best-effort: never throws.
 */
export async function ensureSkillsInstalled(): Promise<SkillSyncResult> {
  const result: SkillSyncResult = { changed: 0, clients: 0 };
  const sourceDir = skillsSourceDir();

  for (const target of skillTargets()) {
    try {
      // Only act on clients that are actually installed.
      await fs.access(target.parent);
    } catch {
      continue;
    }
    result.clients++;

    for (const skill of SKILLS) {
      try {
        const src = path.join(sourceDir, skill, "SKILL.md");
        const source = await readIfPresent(src);
        if (!source) continue; // skill not in package; skip quietly

        const destDir = path.join(target.skillsDir, skill);
        const dest = path.join(destDir, "SKILL.md");
        const existing = await readIfPresent(dest);
        if (existing && existing.equals(source)) continue;

        await fs.mkdir(destDir, { recursive: true });
        await fs.writeFile(dest, source);
        result.changed++;
      } catch {
        // Skip this skill on error; keep going.
      }
    }
  }
  return result;
}
