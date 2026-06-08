import { promises as fs } from "node:fs";
import path from "node:path";

function log(message: string): void {
  process.stdout.write(`[init] ${message}\n`);
}

export async function initProject(): Promise<void> {
  const cwd = process.cwd();
  const projectName = path.basename(cwd);

  log(`Initializing Roblox project in: ${cwd}`);

  // 1. default.project.json
  const rojoConfigPath = path.join(cwd, "default.project.json");
  const rojoConfig = {
    name: projectName,
    tree: {
      $className: "DataModel",
      ReplicatedStorage: {
        $path: "explorer/ReplicatedStorage"
      },
      ServerScriptService: {
        $path: "explorer/ServerScriptService"
      },
      StarterGui: {
        $path: "explorer/StarterGui"
      },
      StarterPlayer: {
        $path: "explorer/StarterPlayer"
      },
      ServerStorage: {
        $path: "explorer/ServerStorage"
      }
    }
  };

  try {
    const exists = await fs.access(rojoConfigPath).then(() => true).catch(() => false);
    if (!exists) {
      await fs.writeFile(rojoConfigPath, JSON.stringify(rojoConfig, null, 2), "utf8");
      log("Created default.project.json");
    } else {
      log("Skipped default.project.json (already exists)");
    }
  } catch (err) {
    log(`Error writing default.project.json: ${String(err)}`);
  }

  // 2. .gitignore
  const gitignorePath = path.join(cwd, ".gitignore");
  const gitignoreConfig = `.rojo/
sourcemap.json
node_modules/
*.log
`;

  try {
    const exists = await fs.access(gitignorePath).then(() => true).catch(() => false);
    if (!exists) {
      await fs.writeFile(gitignorePath, gitignoreConfig, "utf8");
      log("Created .gitignore");
    } else {
      log("Skipped .gitignore (already exists)");
    }
  } catch (err) {
    log(`Error writing .gitignore: ${String(err)}`);
  }

  log("Project initialized successfully! You can now start flat-syncing.");
}
