# roblox-mcp-pro

**Let your AI agent build inside Roblox Studio.** An open-source [Model Context
Protocol](https://modelcontextprotocol.io) server that gives Claude, Codex, Cursor, Antigravity
(and any MCP client) hands-on control of a *live* Roblox Studio session — run Luau, query and
mutate the DataModel, build UI/terrain/lighting, screenshot the viewport, and keep a two-way
Studio ↔ local-file mirror.

[![npm](https://img.shields.io/npm/v/roblox-mcp-pro?color=cb3837&logo=npm)](https://www.npmjs.com/package/roblox-mcp-pro)
[![downloads](https://img.shields.io/npm/dm/roblox-mcp-pro?color=cb3837)](https://www.npmjs.com/package/roblox-mcp-pro)
[![license](https://img.shields.io/npm/l/roblox-mcp-pro?color=22c55e)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-7c3aed)](https://modelcontextprotocol.io)

> **Free and open source** under the [MIT License](LICENSE) — every tool, no key, no trial, no
> Pro/free split. Original, independent project; all code written from scratch.

---

## What it feels like

Connect the server, click the **MCP** button in Studio, then just talk to your agent:

> *"Build a glassy settings panel with a volume slider and a close button, then animate it sliding in."*
>
> *"Scatter 30 trees across the terrain, avoiding the water, and add soft evening lighting with fog."*
>
> *"Read this screenshot and rebuild this shop UI pixel-for-pixel."*
>
> *"Sync the whole place to disk so I can edit scripts in my editor — two-way, live."*

The agent picks the right tools, runs them in your open Studio session, screenshots the result to
check its own work, and iterates — while you watch it happen.

## Why this one

- 🧰 **29 focused tools** — instances, properties, scripts, raw Luau, UI, terrain, lighting,
  effects, tweens, camera, animation, audio, physics, marketplace assets, spatial queries, bulk
  edits, playtest automation, screenshots. [Full list ↓](#-tools-29)
- 🔁 **Two-way sync** — mirror the live DataModel to local files and back. Edit scripts in your
  own editor; changes flow both ways. **Multiple Places sync at once**, each on its own engine.
- 👥 **Multi-agent** — Claude Code, Codex, and Antigravity can all drive the **same** Studio
  session concurrently through one shared broker.
- 👁️ **It sees what it builds** — `capture_studio` screenshots the real viewport so the agent
  closes the loop instead of building blind.
- 📊 **Live dashboard** at `127.0.0.1:3690` — connected agents, plugin status, command queue,
  and sync state in real time.
- ♻️ **Zero-maintenance** — `npx … @latest` auto-updates the server; the Studio plugin and agent
  skills self-install on startup.

---

## 🚀 Quick start

Two commands (Claude Code shown — [other clients below](#a-cli-agents-one-command-each--claude-code--codex--antigravity--gemini)):

```bash
# 1) Register the server with your AI agent
claude mcp add roblox-mcp-pro -- npx -y roblox-mcp-pro@latest
# 2) Install the Studio plugin (also auto-installs on first run)
npx roblox-mcp-pro@latest install-plugin
```

Then: open Roblox Studio → click the **Roblox MCP Pro** toolbar button so it's highlighted → ask
your agent to call **`system_info`**. You should see `pluginConnected: true`. 🎉

```
Your AI agent ──MCP──▶ roblox-mcp-pro ──HTTP 127.0.0.1:3690──▶ Studio plugin ──▶ Roblox Studio
```

You **never start the server by hand** — your agent launches it automatically with the command you
register. The plugin self-updates on each launch (restart Studio when it tells you a new plugin
was installed).

---

## 🔧 Manual install

The server is a single npm package. **Every AI client uses the exact same launch command** — only
*where* you write it down changes:

```
command:  npx
args:     -y  roblox-mcp-pro@latest
```

`npx` downloads and runs the published package on demand — no clone, no build. `@latest` means you
always get the newest version automatically. (Pin a version like `roblox-mcp-pro@1.0.48` to opt out
of auto-update.)

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

#### Optional environment variables

| Variable             | Default  | Meaning                                    |
| -------------------- | -------- | ------------------------------------------ |
| `ROBLOX_MCP_PORT`    | `3690`   | Bridge port (the plugin must match).       |
| `ROBLOX_MCP_TOKEN`   | _(none)_ | Shared secret; also set it in the plugin.  |
| `ROBLOX_MCP_NO_PLUGIN_AUTOINSTALL` | _(unset)_ | `1` disables auto-installing the plugin. |
| `ROBLOX_MCP_NO_SKILL_AUTOINSTALL`  | _(unset)_ | `1` disables auto-installing agent skills. |
| `ROBLOX_MCP_NO_OPEN_DASHBOARD`     | _(unset)_ | `1` stops the dashboard opening on startup. |

### Part 2 — Install the Studio plugin

**Usually automatic** — the first time your AI client starts the server, it copies the plugin into
your Roblox Plugins folder and keeps it updated on every launch. To install it right now without
starting a client:

```bash
npx roblox-mcp-pro@latest install-plugin
```

**Prefer to do it by hand?** The file ships inside the package at
`node_modules/roblox-mcp-pro/plugin/RobloxMcpPro.rbxmx` — copy it into:

- **Windows:** `%LOCALAPPDATA%\Roblox\Plugins`
- **macOS:** `~/Documents/Roblox/Plugins`

Open Roblox Studio — a **Roblox MCP Pro** button appears in the toolbar. (Studio enables HTTP
requests automatically when you connect; if needed, set `HttpService.HttpEnabled = true`.)

### Part 3 — Agent skills (automatic)

Skills are short guides that teach your AI how to use the tools well (building UI from an image,
animating GUIs, writing Studio plugins, etc.). **You don't need to do anything** — the server
installs them on startup, the same way it installs the plugin. Only **Claude Code**
(`~/.claude/skills`) and **Codex** (`~/.codex/skills`) have a skills mechanism, so skills are
copied there when those clients are present; other clients still work fine, just without the extra
guidance.

---

## 🧰 Tools (29)

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

**Sync, sessions & Studio**

| Tool               | Description                                            |
| ------------------ | ----------------------------------------------------- |
| `manage_sync`      | Bidirectional Studio ↔ local mirror (+ sourcemap); multiple Places at once. |
| `manage_agents`    | List connected agents/Places; bind this agent to a specific Place. |
| `manage_selection` | Read/change the Explorer selection; watch for user clicks. |
| `manage_studio`    | Studio info + playtests: Run mode (run/pause/stop) and real Play Solo / multiplayer with test scripts + auto reports. |
| `manage_logs`      | Recent Output log history (filter by type or `since`). |
| `workspace_state`  | Session snapshot + tree diff since last check.        |
| `capture_studio`   | Screenshot the Studio window so the agent sees the real render. |

---

## 🖥️ Monitor dashboard

Opens automatically the first time the server starts, at **http://127.0.0.1:3690/** — watch
connected agents, plugin status, the command queue, live activity, and sync status in real time.
(Set `ROBLOX_MCP_NO_OPEN_DASHBOARD=1` to stop it auto-opening; the URL still works anytime.)

---

## How it works (under the hood)

```
AI Agent A ─MCP stdio─▶ MCP client ─┐
AI Agent B ─MCP stdio─▶ MCP client ─┼─HTTP 127.0.0.1:3690─▶ Broker ◀─long-poll─ Studio Plugin (Luau)
AI Agent C ─MCP stdio─▶ MCP client ─┘                       queue + dashboard    dispatch handlers
```

1. **MCP client** exposes the tools over stdio. Each AI agent spawns its own.
2. **Broker** is one shared localhost process that owns port 3690, queues commands, and talks to
   the plugin. The first client to start auto-spawns it; the rest just connect — so multiple agents
   can drive one Studio session concurrently.
3. **Studio plugin** long-polls the broker, runs each command in Studio, and posts the result back.

---

## 🛠️ Build from source (developers)

```powershell
npm install
npm run build      # compile the server to dist/
.\build.ps1        # build the plugin .rbxmx and install it to the Plugins folder
```

When working **in this repo** with Claude Code, a project `.mcp.json` is already included — just
approve the `roblox-mcp-pro` server when prompted (or run `/mcp`).

```powershell
npm run dev          # server with auto-reload (tsx watch)
npm test             # build + hermetic smokes + unit tests
npm run lint         # biome lint
npm run inspector    # exercise tools with the MCP Inspector
.\build.ps1 -NoInstall
```

### Releasing

```bash
npm version patch        # bump package.json + create the matching vX.Y.Z tag
git push --follow-tags   # push commit + tag -> Actions cuts the release
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds the plugin, attaches
`RobloxMcpPro.rbxmx` to a GitHub Release, then publishes the server to npm. (npm publishing needs an
`NPM_TOKEN` repo secret; until it's set, the GitHub-Release half still succeeds.)

---

## License

**MIT** — free and open source. See [`LICENSE`](LICENSE). Use it, fork it, ship it; contributions
welcome.
