# roblox-mcp-pro

An open-source **Model Context Protocol (MCP) server** that lets AI agents (Claude, Cursor,
etc.) control a live **Roblox Studio** session: run Luau, query and mutate the DataModel, and
keep a bidirectional Studio ↔ local-filesystem mirror.

> Original, independent project. All code is written from scratch and licensed under
> AGPL-3.0-or-later.

## How it works

```
AI Agent A ─MCP stdio─▶ MCP client ─┐
AI Agent B ─MCP stdio─▶ MCP client ─┼─HTTP 127.0.0.1:3690─▶ Broker ◀─long-poll─ Studio Plugin (Luau)
AI Agent C ─MCP stdio─▶ MCP client ─┘                       queue + dashboard    dispatch handlers
```

1. **MCP client** (`src/`) exposes tools over stdio. Each AI agent spawns its own.
2. **Broker** is one shared localhost process that owns port 3690, queues commands, and talks to
   the plugin. The first client to start auto-spawns it; the rest just connect — so **multiple AI
   agents (Claude Code, Codex, Antigravity, …) can drive the same Studio session at once**.
3. **Studio plugin** (`plugin/`) long-polls the broker, runs each command in Studio, posts the
   result back.

### Monitor dashboard

Open **http://127.0.0.1:3690/** in a browser to watch connected agents, plugin status, the command
queue, live activity, and sync status in real time.

## Install (end users)

### Super Easy Install (Windows - Private Repo)

Open PowerShell and run the following command (requires GitHub CLI `gh` to be installed and authenticated) to automatically download the Roblox Studio plugin and register the MCP server in your AI clients:

```powershell
gh api repos/PeerapolSelanon/roblox-mcp-pro/contents/install.ps1 -H "Accept: application/vnd.github.v3.raw" | Out-String | iex
```

---

### Manual Install

You need two pieces: the **MCP server** (a CLI you register with your agent) and the **Studio
plugin** (a file Studio loads).

### 1. Register the server with your agent

Claude Code, one command:

```bash
claude mcp add roblox-mcp-pro -- npx -y roblox-mcp-pro
```

Or add it to any client's MCP config manually:

```json
{
  "mcpServers": {
    "roblox-mcp-pro": {
      "command": "npx",
      "args": ["-y", "roblox-mcp-pro"]
    }
  }
}
```

`npx` downloads and runs the published package — no clone or build needed. (Prefer a pinned global
install? `npm i -g roblox-mcp-pro`, then use `"command": "roblox-mcp-pro"`.)

Optional environment variables:

| Variable           | Default | Meaning                                  |
| ------------------ | ------- | ---------------------------------------- |
| `ROBLOX_MCP_PORT`  | `3690`  | Bridge port (plugin must match).         |
| `ROBLOX_MCP_TOKEN` | _(none)_| Shared secret; also set it in the plugin.|

### 2. Install the Studio plugin

Download **`RobloxMcpPro.rbxmx`** from the
[latest release](https://github.com/PeerapolSelanon/roblox-mcp-pro/releases/latest) and drop it
into your local plugins folder:

- Windows: `%LOCALAPPDATA%\Roblox\Plugins`
- macOS: `~/Documents/Roblox/Plugins`

Open Studio — you'll see a **Roblox MCP Pro** toolbar. (Studio enables HTTP requests automatically
on connect; if needed, set `HttpService.HttpEnabled = true`.)

### 3. Connect

In Studio, click the **MCP** toolbar button so it's highlighted. Ask your agent to call
`system_info` — it should report `pluginConnected: true`.

## Build from source (developers)

```powershell
npm install
npm run build      # compile the server to dist/
.\build.ps1        # build the plugin .rbxmx and install it to the Plugins folder
```

When working **in this repo** with Claude Code, a project `.mcp.json` is already included — just
approve the `roblox-mcp-pro` server when prompted (or run `/mcp`).

## Tools (28)

**Core**

| Tool                | Description                                            |
| ------------------- | ----------------------------------------------------- |
| `system_info`       | Connection + Studio session status.                   |
| `execute_luau`      | Run Luau in Studio; capture output and return values. |
| `query_instances`   | Search the DataModel; serialize matching instances.   |
| `find_instances`    | Targeted multi-filter search; compact grouped results. |
| `scene_overview`    | One-call DataModel map: class histogram + shallow tree. |
| `describe_instance` | One instance's properties + children + ancestry in one call. |
| `mutate_instances`  | Create / edit / move / clone / delete instances.      |
| `manage_properties` | Read or write properties on any instance.             |
| `batch_execute`     | Run many operations in one round-trip + one undo.     |

**World & visuals**

| Tool               | Description                                           |
| ------------------ | ----------------------------------------------------- |
| `manage_terrain`   | Generate/edit voxel terrain (block, ball, region).    |
| `manage_lighting`  | Time of day, fog, ambient, exposure, shadows.         |
| `manage_effects`   | Bloom, Blur, ColorCorrection, DoF, Atmosphere, Sky.   |
| `manage_camera`    | Read, set, or aim the CurrentCamera.                  |
| `manage_tween`     | Animate instance properties with TweenService.        |
| `manage_physics`   | Physical properties and welds.                        |
| `spatial_query`    | Box / radius / raycast / nearest searches.            |

**Content**

| Tool                | Description                                          |
| ------------------- | --------------------------------------------------- |
| `manage_ui`         | Build/edit GUI hierarchies (UDim2/Color coercion).  |
| `ui_preview`        | Show a GUI on a clean backdrop for a comparison screenshot. |
| `manage_audio`      | Create, configure, and preview Sounds.              |
| `manage_animation`  | Manage Animation instances; best-effort preview.    |
| `manage_assets`     | Insert marketplace assets; read product info.       |
| `manage_scripts`    | Read/write script source; create scripts.           |

**Sync & Studio**

| Tool               | Description                                            |
| ------------------ | ----------------------------------------------------- |
| `manage_sync`      | Bidirectional Studio ↔ local mirror (+ sourcemap).    |
| `manage_selection` | Read/change the Explorer selection.                   |
| `manage_studio`    | Studio environment info (version, theme, state).      |
| `manage_logs`      | Recent Output log history.                            |
| `workspace_state`  | High-level read-only session snapshot.                |
| `capture_studio`   | Screenshot the Studio window so the agent sees the real render. |

## Development

```powershell
npm run dev          # server with auto-reload (tsx watch)
npm run inspector    # exercise tools with the MCP Inspector
.\build.ps1 -NoInstall
```

## Releasing

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds the plugin and attaches
`RobloxMcpPro.rbxmx` to a GitHub Release, then publishes the server to npm.

```bash
npm version patch        # bump package.json and create the matching vX.Y.Z tag
git push --follow-tags   # push commit + tag -> Actions cuts the release
```

npm publishing needs an `NPM_TOKEN` repository secret (Settings → Secrets → Actions). Until it's
set, the plugin/GitHub-Release half still succeeds; only the npm job fails.

## License

AGPL-3.0-or-later. See `LICENSE`.
