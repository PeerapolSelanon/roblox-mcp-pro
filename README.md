# roblox-mcp-pro

An open-source **Model Context Protocol (MCP) server** that lets AI agents (Claude, Cursor,
etc.) control a live **Roblox Studio** session: run Luau, query and mutate the DataModel, and
keep a bidirectional Studio ↔ local-filesystem mirror.

> Original, independent project. All code is written from scratch and licensed under
> AGPL-3.0-or-later.

## How it works

```
AI Agent ──MCP stdio──▶ MCP Server (Node/TS) ──HTTP 127.0.0.1:3690──▶ Studio Plugin (Luau)
                          tool registry            long-poll /dequeue        dispatch handlers
                          bridge (queue)           POST /respond             execute via Studio API
```

1. **MCP server** (`src/`) exposes tools over stdio.
2. **Bridge** holds a localhost HTTP server; each tool enqueues a command and awaits a result.
3. **Studio plugin** (`plugin/`) long-polls the bridge, runs the command in Studio, posts the result back.

## Install (end users)

### Super Easy Install (Windows)

Open PowerShell and run the following command to automatically download the Roblox Studio plugin and register the MCP server in your AI clients (Claude Desktop, Cursor, Cline, etc.):

```powershell
irm https://raw.githubusercontent.com/PeerapolSelanon/roblox-mcp-pro/main/install.ps1 | iex
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

## Tools (23)

**Core**

| Tool                | Description                                            |
| ------------------- | ----------------------------------------------------- |
| `system_info`       | Connection + Studio session status.                   |
| `execute_luau`      | Run Luau in Studio; capture output and return values. |
| `query_instances`   | Search the DataModel; serialize matching instances.   |
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
