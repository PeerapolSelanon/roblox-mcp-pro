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

## Setup

### 1. Build the server

```powershell
npm install
npm run build
```

### 2. Build & install the Studio plugin

```powershell
.\build.ps1
```

This builds `plugin/RobloxMcpPro.rbxmx` and copies it into
`%LOCALAPPDATA%\Roblox\Plugins`. Open Roblox Studio and you'll see a **Roblox MCP Pro**
toolbar. (You may need to allow HTTP requests: Studio enables it automatically on connect,
or set `HttpService.HttpEnabled = true`.)

### 3. Register the MCP server with your agent

Claude Desktop / Claude Code `mcp` config:

```json
{
  "mcpServers": {
    "roblox-mcp-pro": {
      "command": "node",
      "args": ["D:/roblox-mcp-pro/dist/index.js"]
    }
  }
}
```

Optional environment variables:

| Variable           | Default | Meaning                                  |
| ------------------ | ------- | ---------------------------------------- |
| `ROBLOX_MCP_PORT`  | `3690`  | Bridge port (plugin must match).         |
| `ROBLOX_MCP_TOKEN` | _(none)_| Shared secret; also set it in the plugin.|

### 4. Connect

In Studio, click **MCP: Off** on the toolbar → it flips to **MCP: On**. Ask your agent to call
`system_info` — it should report `pluginConnected: true`.

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

## License

AGPL-3.0-or-later. See `LICENSE`.
