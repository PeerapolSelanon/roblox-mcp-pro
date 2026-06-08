import { promises as fs } from "node:fs";
import path from "node:path";

function log(message: string): void {
  process.stdout.write(`[init] ${message}\n`);
}

function cleanWallyName(name: string): string {
  // Wally package names should be alphanumeric or hyphens, lowercased.
  return name.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}

export async function initProject(): Promise<void> {
  const cwd = process.cwd();
  const projectName = path.basename(cwd);
  const cleanName = cleanWallyName(projectName);

  log(`Initializing Roblox project in: ${cwd}`);

  // 1. Create explorer directories
  const explorerDir = path.join(cwd, "explorer");
  const replicatedStorage = path.join(explorerDir, "ReplicatedStorage");
  const serverScriptService = path.join(explorerDir, "ServerScriptService");

  try {
    await fs.mkdir(explorerDir, { recursive: true });
    await fs.mkdir(replicatedStorage, { recursive: true });
    await fs.mkdir(serverScriptService, { recursive: true });
    log("Created explorer/ directory structure.");
  } catch (err) {
    log(`Warning: Failed to create directories: ${String(err)}`);
  }

  // 2. default.project.json
  const rojoConfigPath = path.join(cwd, "default.project.json");
  const rojoConfig = {
    name: projectName,
    tree: {
      $className: "DataModel",
      ReplicatedStorage: {
        $path: "explorer/ReplicatedStorage",
        Packages: {
          $path: "Packages"
        }
      },
      ServerScriptService: {
        $path: "explorer/ServerScriptService",
        ServerPackages: {
          $path: "ServerPackages"
        }
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

  // 3. wally.toml
  const wallyConfigPath = path.join(cwd, "wally.toml");
  const wallyConfig = `[package]
name = "peerapol/${cleanName}"
version = "0.1.0"
registry = "https://github.com/UpliftGames/wally-index"
realm = "shared"

[dependencies]
# Add dependencies here, e.g.:
# Promise = "evaera/promise@4.0.0"
`;

  try {
    const exists = await fs.access(wallyConfigPath).then(() => true).catch(() => false);
    if (!exists) {
      await fs.writeFile(wallyConfigPath, wallyConfig, "utf8");
      log("Created wally.toml");
    } else {
      log("Skipped wally.toml (already exists)");
    }
  } catch (err) {
    log(`Error writing wally.toml: ${String(err)}`);
  }

  // 4. selene.toml
  const seleneConfigPath = path.join(cwd, "selene.toml");
  const seleneConfig = `std = "roblox"
`;

  try {
    const exists = await fs.access(seleneConfigPath).then(() => true).catch(() => false);
    if (!exists) {
      await fs.writeFile(seleneConfigPath, seleneConfig, "utf8");
      log("Created selene.toml");
    } else {
      log("Skipped selene.toml (already exists)");
    }
  } catch (err) {
    log(`Error writing selene.toml: ${String(err)}`);
  }

  // 5. .gitignore
  const gitignorePath = path.join(cwd, ".gitignore");
  const gitignoreConfig = `.rojo/
sourcemap.json
Packages/
ServerPackages/
node_modules/
dist/
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
