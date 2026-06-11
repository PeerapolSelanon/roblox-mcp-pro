# roblox-mcp-pro

An open-source **Model Context Protocol (MCP) server** that lets AI agents (Claude, Codex,
Cursor, Antigravity, …) control a live **Roblox Studio** session — run Luau, query and mutate
the DataModel, build UI/terrain/lighting, and keep a two-way Studio ↔ local-file mirror.

> Original, independent project. All code is written from scratch by the author.
> **Proprietary software** — a paid commercial license is required to use it. See
> [`LICENSE`](LICENSE).

---

## What you install

There are **three pieces**. Most people only need the first two.

| # | Piece | What it is | Required? |
|---|-------|-----------|-----------|
| 1 | **MCP server** | An npm package (`roblox-mcp-pro`) you register with your AI agent. | ✅ Yes |
| 2 | **Studio plugin** | A file (`RobloxMcpPro.rbxmx`) you drop into Roblox Studio. | ✅ Yes |
| 3 | **Agent skills** | Guides that teach your AI *how* to drive the server well. | ⭐ Recommended |

```
Your AI agent ──MCP──▶ roblox-mcp-pro ──HTTP 127.0.0.1:3690──▶ Studio plugin ──▶ Roblox Studio
   (1)                      (server)                              (2)
```

You **never start the server by hand** — your AI agent launches it automatically using the
command you register below. Multiple agents (Claude Code, Codex, Antigravity, …) can drive the
**same** Studio session at once.

### 💳 License

Roblox MCP Pro is a paid product with a **14-day free trial** — no key needed to try it. After the
trial you need a license key (see [pricing/buy](https://roblox-mcp-pro.lemonsqueezy.com/checkout/buy/91ab6fc2-cbd5-42b8-8125-483bed295faa)). Once you
have a key, add it as shown in **[Part 1 → Add your license key](#add-your-license-key)**. Check
status anytime by asking your agent to run `system_info`.

---

## 🚀 Quick install

Two commands get you running:

```bash
# 1) Register the server with your AI agent (Claude Code shown; see below for others)
claude mcp add roblox-mcp-pro -- npx -y roblox-mcp-pro@latest
# 2) Install the Studio plugin
npx roblox-mcp-pro@latest install-plugin
```

Then open Roblox Studio, click the **MCP** button, and ask your agent to run `system_info`.
For other AI clients and license-key setup, see the manual steps below.

> _Maintainer note:_ collaborators with repo access can run the all-in-one Windows installer
> `gh api repos/PeerapolSelanon/roblox-mcp-pro/contents/install.ps1 -H "Accept: application/vnd.github.v3.raw" | Out-String | iex`.

---

## 🔧 Manual install

The server is a single npm package. **Every AI client uses the exact same launch command** —
only *where* you write it down changes. The command is always:

```
command:  npx
args:     -y  roblox-mcp-pro@latest
```

`npx` downloads and runs the published package on demand — no clone, no build. The `@latest` tag
means you **always get the newest version automatically** — updates need zero effort on your part.

> **Updates are automatic.** Because the command uses `@latest`, each time your AI client starts
> the server it fetches the newest release. The Studio plugin also self-updates: the server copies
> the latest bundled plugin into your Plugins folder on startup (just restart Studio when it tells
> you a new plugin was installed). You never have to reinstall anything by hand.

### Part 1 — Install the MCP server

#### A. CLI agents (one command each) — Claude Code · Codex · Antigravity / Gemini

**Claude Code**

```bash
claude mcp add roblox-mcp-pro -- npx -y roblox-mcp-pro@latest
```

**Codex**

```bash
codex mcp add roblox-mcp-pro -- npx -y roblox-mcp-pro@latest
```

> If `codex mcp add` isn't available in your version, add this to `~/.codex/config.toml` instead:
> ```toml
> [mcp_servers.roblox-mcp-pro]
> command = "npx"
> args = ["-y", "roblox-mcp-pro@latest"]
> ```

**Antigravity / Gemini CLI**

```bash
gemini mcp add roblox-mcp-pro npx -y roblox-mcp-pro@latest
```

> If that doesn't work, add the JSON block below to `~/.gemini/config/mcp_config.json`.

#### B. Other clients (edit one config file) — Claude Desktop · Cursor · Windsurf · Cline

These don't have a CLI command, so you paste the **same JSON** into the client's config file:

```json
{
  "mcpServers": {
    "roblox-mcp-pro": {
      "command": "npx",
      "args": ["-y", "roblox-mcp-pro@latest"]
    }
  }
}
```

> If the file already has other servers, just add the `"roblox-mcp-pro"` entry **inside** the
> existing `"mcpServers"` object — don't replace the whole file.

Where each file lives:

| Client | Config file (Windows) |
|--------|------------------------|
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `%APPDATA%\Cursor\User\globalStorage\moose-coder.cursor-mcp\mcp.json` |
| Windsurf | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` |
| Cline (VS Code) | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` |

After editing, **restart the client** so it picks up the new server.

<a id="add-your-license-key"></a>
#### Add your license key

During the 14-day trial you can skip this. After buying, you get a license key — add it to your
client config in an **`env`** block next to the command. Example (works for any client; just put it
in that client's config file):

```json
{
  "mcpServers": {
    "roblox-mcp-pro": {
      "command": "npx",
      "args": ["-y", "roblox-mcp-pro@latest"],
      "env": { "ROBLOX_MCP_LICENSE": "YOUR-LICENSE-KEY" }
    }
  }
}
```

For **Codex** (TOML), add the env under the server block:

```toml
[mcp_servers.roblox-mcp-pro]
command = "npx"
args = ["-y", "roblox-mcp-pro@latest"]
env = { ROBLOX_MCP_LICENSE = "YOUR-LICENSE-KEY" }
```

Don't want it in a config file? Save the key to **`%USERPROFILE%\.roblox-mcp-pro\license.key`**
(one line, just the key). Restart the client, then run `system_info` — it should show
`license: licensed`.

#### Optional environment variables

| Variable             | Default  | Meaning                                    |
| -------------------- | -------- | ------------------------------------------ |
| `ROBLOX_MCP_LICENSE` | _(none)_ | Your license key (after the free trial).   |
| `ROBLOX_MCP_PORT`    | `3690`   | Bridge port (the plugin must match).       |
| `ROBLOX_MCP_TOKEN`   | _(none)_ | Shared secret; also set it in the plugin.  |

### Part 2 — Install the Studio plugin

**Usually automatic** — the first time your AI client starts the server, it copies the plugin into
your Roblox Plugins folder for you (and keeps it updated on every launch). In most cases you can
skip straight to Part 3.

Want to install it right now without starting a client? Run:

```bash
npx roblox-mcp-pro@latest install-plugin
```

It works on Windows and macOS and tells you where it put the file. (To disable the automatic
behavior, set the env var `ROBLOX_MCP_NO_PLUGIN_AUTOINSTALL=1`.)

**Prefer to do it by hand?** The file lives in the installed package at
`node_modules/roblox-mcp-pro/plugin/RobloxMcpPro.rbxmx` — copy it into:

- **Windows:** `%LOCALAPPDATA%\Roblox\Plugins`
- **macOS:** `~/Documents/Roblox/Plugins`

Open Roblox Studio — a **Roblox MCP Pro** button appears in the toolbar. (Studio turns on HTTP
requests automatically when you connect; if needed, set `HttpService.HttpEnabled = true`.)

### Part 3 — Agent skills (automatic)

Skills are short guides that teach your AI how to use the tools well (building UI from an image,
animating GUIs, writing Studio plugins, etc.). **You don't need to do anything** — the server
installs them for you on startup, the same way it installs the plugin. Only **Claude Code**
(`~/.claude/skills`) and **Codex** (`~/.codex/skills`) have a skills mechanism, so skills are
copied there when those clients are present; other clients still work fine, just without the extra
guidance.

(To opt out, set `ROBLOX_MCP_NO_SKILL_AUTOINSTALL=1`.)

### Part 4 — Connect & verify

1. In Studio, click the **MCP** toolbar button so it's highlighted (this connects the plugin).
2. Ask your AI agent to call **`system_info`**.
3. You should see `pluginConnected: true` and a `license:` line (`trial`, `licensed`, or
   `locked`). 🎉

If `license` shows `locked`, your trial ended or your key is missing/expired — see
[Add your license key](#add-your-license-key).

---

## 🖥️ Monitor dashboard

The dashboard opens in your browser automatically the first time the server starts, at
**http://127.0.0.1:3690/** — watch connected agents, plugin status, the command queue, live
activity, and sync status in real time. (Don't want it to open on its own? Set
`ROBLOX_MCP_NO_OPEN_DASHBOARD=1`; you can still open the URL manually anytime.)

---

## 🧰 Tools (28)

**Core**

| Tool                | Description                                            |
| ------------------- | ----------------------------------------------------- |
| `system_info`       | Connection + Studio session status.                   |
| `execute_luau`      | Run Luau in Studio; capture output and return values. |
| `query_instances`   | Search the DataModel; serialize matching instances.   |
| `find_instances`    | Targeted multi-filter search; compact grouped results. |
| `scene_overview`    | One-call DataModel map: class histogram + shallow tree. |
| `describe_instance` | One instance's properties + children + ancestry; or class reflection via API dump. |
| `mutate_instances`  | Create / edit / move / clone / delete instances.      |
| `manage_properties` | Properties, attributes, and CollectionService tags.   |
| `batch_execute`     | Run many operations in one round-trip + one undo.     |

**World & visuals**

| Tool               | Description                                           |
| ------------------ | ----------------------------------------------------- |
| `manage_terrain`   | Voxel terrain: fills, ramps, material swap, smooth, procedural hills. |
| `manage_lighting`  | Time of day, fog, ambient, exposure, shadows.         |
| `manage_effects`   | Bloom, Blur, ColorCorrection, DoF, Atmosphere, Sky.   |
| `manage_camera`    | Read, set, or aim the CurrentCamera.                  |
| `manage_tween`     | Animate instance properties with TweenService.        |
| `manage_physics`   | Physical properties and welds.                        |
| `spatial_query`    | Box / radius / raycast / nearest / ground & placement checks. |

**Content**

| Tool                | Description                                          |
| ------------------- | --------------------------------------------------- |
| `manage_ui`         | Build/edit GUI hierarchies (UDim2/Color coercion).  |
| `ui_preview`        | Show a GUI on a clean backdrop for a comparison screenshot. |
| `manage_audio`      | Create, configure, and preview Sounds.              |
| `manage_animation`  | Manage Animation instances; best-effort preview.    |
| `manage_assets`     | Search the marketplace; insert assets; read product info. |
| `manage_scripts`    | Read/write/create scripts; line edits, search, find-replace. |

**Sync & Studio**

| Tool               | Description                                            |
| ------------------ | ----------------------------------------------------- |
| `manage_sync`      | Bidirectional Studio ↔ local mirror (+ sourcemap).    |
| `manage_selection` | Read/change the Explorer selection; watch for user clicks. |
| `manage_studio`    | Studio info + playtests: Run mode (run/pause/stop) and real Play Solo / multiplayer with test scripts + auto reports. |
| `manage_logs`      | Recent Output log history (filter by type or `since`). |
| `workspace_state`  | Session snapshot + tree diff since last check.        |
| `capture_studio`   | Screenshot the Studio window so the agent sees the real render. |

---

## 🛠️ Build from source (developers)

```powershell
npm install
npm run build      # compile the server to dist/
.\build.ps1        # build the plugin .rbxmx and install it to the Plugins folder
```

When working **in this repo** with Claude Code, a project `.mcp.json` is already included — just
approve the `roblox-mcp-pro` server when prompted (or run `/mcp`).

### Development

```powershell
npm run dev          # server with auto-reload (tsx watch)
npm run inspector    # exercise tools with the MCP Inspector
.\build.ps1 -NoInstall
```

### Releasing

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds the plugin, attaches
`RobloxMcpPro.rbxmx` to a GitHub Release, then publishes the server to npm.

```bash
npm version patch        # bump package.json and create the matching vX.Y.Z tag
git push --follow-tags   # push commit + tag -> Actions cuts the release
```

npm publishing needs an `NPM_TOKEN` repository secret (Settings → Secrets → Actions). Until it's
set, the plugin/GitHub-Release half still succeeds; only the npm job fails.

---

## How it works (under the hood)

```
AI Agent A ─MCP stdio─▶ MCP client ─┐
AI Agent B ─MCP stdio─▶ MCP client ─┼─HTTP 127.0.0.1:3690─▶ Broker ◀─long-poll─ Studio Plugin (Luau)
AI Agent C ─MCP stdio─▶ MCP client ─┘                       queue + dashboard    dispatch handlers
```

1. **MCP client** exposes the tools over stdio. Each AI agent spawns its own.
2. **Broker** is one shared localhost process that owns port 3690, queues commands, and talks to
   the plugin. The first client to start auto-spawns it; the rest just connect — so multiple
   agents can drive one Studio session concurrently.
3. **Studio plugin** long-polls the broker, runs each command in Studio, and posts the result back.

---

## License

**Proprietary — All Rights Reserved.** This software requires a paid commercial license to use.
See [`LICENSE`](LICENSE). To purchase a license, contact **peerapolselanon@gmail.com**.
