# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`roblox-mcp-pro` is an MCP server (TypeScript/Node, stdio) plus a Roblox Studio plugin (Luau)
that lets AI agents drive a live Roblox Studio session: run Luau, query/mutate the DataModel, and
keep a bidirectional Studio ↔ local-filesystem mirror. **Original, clean-room project** — do not
copy from any commercial vendor; the string "weppy"/"WEPPY" must never appear in this repo.
**Proprietary** — All Rights Reserved; a paid commercial license is required to use it (see `LICENSE`).

## Commands

```powershell
npm install
npm run build          # tsc -> dist/   (server)
npm run dev            # tsx watch src/index.ts (server with auto-reload)
npm run inspector      # exercise tools with the MCP Inspector
.\build.ps1            # rojo build plugin -> RobloxMcpPro.rbxmx + install to %LOCALAPPDATA%\Roblox\Plugins
.\build.ps1 -NoInstall # build the .rbxmx only
```

There is no test runner and no linter configured. "Testing" means running the server against the
real Studio plugin (see **Testing against Studio** below). `tsc` (via `npm run build`) is the
type-check; the config is `strict` with `noUncheckedIndexedAccess`.

Releasing: `npm version patch` then `git push --follow-tags`. A `v*` tag triggers
`.github/workflows/release.yml`, which builds the plugin, attaches `RobloxMcpPro.rbxmx` to a
GitHub Release, and publishes the server to npm (needs the `NPM_TOKEN` repo secret).

## Architecture

```
AI Agent A ─MCP stdio─▶ MCP client ─┐
AI Agent B ─MCP stdio─▶ MCP client ─┼─HTTP 127.0.0.1:3690─▶ Broker ◀─long-poll─ Studio Plugin (plugin/, Luau)
AI Agent C ─MCP stdio─▶ MCP client ─┘   (dist/broker/main.js)    /dequeue · /respond · /event
```

The server side is split into a **shared broker** (one long-lived process that owns the port and
talks to the plugin) and **thin MCP clients** (one per AI agent process, spawned by the agent).
This lets Claude Code, Codex, Antigravity, etc. drive the same Studio session **concurrently** —
they share the single broker instead of each fighting for port 3690.

- **`src/services/bridge.ts`** — the broker's core: HTTP server + command-queue + long-poll
  protocol. A caller does `enqueue(tool, args)` → Promise; the plugin long-polls `GET /dequeue`
  (held open up to `LONG_POLL_TIMEOUT_MS`, then 204), runs the command, and `POST`s the result to
  `/respond`, resolving the matching Promise by command id. `POST /event` carries Studio→server
  change notifications (sync). `GET /health` reports status. The `onUnhandled` hook lets the
  broker layer its `/rpc/*` and dashboard routes onto the same socket. **The plugin protocol is
  unchanged** — `plugin/src/Bridge.luau` / `init.server.luau`'s `pollLoop` still talk to the same
  three endpoints.
- **`src/broker/`** — the broker process. `main.ts` (entry, idle-shutdown ~20s after the last
  **agent** disconnects — liveness is agent-driven, NOT plugin-driven, so the port frees for a
  fresh broker across upgrades; logs to `%TEMP%/roblox-mcp-pro-broker.log`), `routes.ts` (the `/rpc/*`
  client API + `/`, `/api/state`, `/api/stream` dashboard; routes `manage_sync` to the local
  engine, everything else to `bridge.enqueue`), `registry.ts` (connected agents + rolling command
  log), `dashboard.ts` (self-contained HTML).
- **`src/client/transport.ts`** — what each MCP process uses. `ensureBroker()` pings
  `GET /rpc/ping`; if nothing answers it **spawns a detached broker** and waits (a broker that
  loses the bind race exits quietly). Then `register`/`identify`/`heartbeat`/`deregister` and
  `call(tool, args)` (`POST /rpc/call`) / `status()`. The MCP process **never binds the port
  itself**.
- **`src/services/studio.ts`** — `callStudio(tool, args)` wraps `transport.call`; throws
  `StudioError` (defined in `src/services/errors.ts`) with actionable text on failure.

**Concurrency model:** non-sync tools run from any number of agents simultaneously. The broker is
a singleton on port 3690 (override with `ROBLOX_MCP_PORT`; plugin URL must match). The monitoring
dashboard is at **http://127.0.0.1:3690/** — live agents, plugin status, queue, command activity,
sync status (SSE-driven).

**Process-boundary gotcha:** `src/sync/engine.ts` and `src/broker/*` run *in the broker*, so they
use `bridge.enqueue` directly. Everything under `src/tools/*` runs *in the client*, so it uses
`callStudio`/`transport`. Don't import `bridge` from a tool or `transport` from the broker —
that's what creates the two-process split.

### Tool ↔ handler pairing

Each MCP tool has a matching plugin handler. To add or change behavior you almost always touch
**both sides**, and the tool name must match in three places:

1. **Server tool** in `src/tools/*.ts`, registered in `src/tools/index.ts` via
   `registerAllTools`. Most tools are thin: they validate a zod schema and forward to Studio via
   `forwardTool` (`src/tools/_forward.ts`) or a hand-written `callStudio` call. Tools that do
   real server-side work (`system_info`, sync, capture) are written out by hand.
2. **Plugin handler** in `plugin/src/Handlers/<Name>.luau` — a single function `(args) -> result`.
3. **Dispatcher mapping** in `plugin/src/Dispatcher.luau` (`HANDLER_NAMES = { tool_name = "ModuleName" }`).
   Handlers load via `pcall`, so one broken handler disables only its own tool; the plugin logs
   "loaded N tools" on startup.

**Conventions for server tools:** every tool returns via the `ok(structured, text)` / `fail(text)`
helpers in `src/services/format.ts` — both human-readable `content` text and machine-readable
`structuredContent`, auto-truncated at `CHARACTER_LIMIT` (25k). **Token discipline:** the `content`
text is what the agent reads, so keep it compact — emit compact JSON (never `JSON.stringify(x, null, 2)`;
`forwardTool` already does this) and write **concise** descriptions (one-line summary + one-line
Args + one-line Returns; see `src/tools/overview.ts` / `world.ts` as the template — tool defs ship
in every request). Tools declare MCP annotations
(`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`).
`PROTECTED_SERVICES` in `src/constants.ts` must never be mutated/deleted. Studio values serialize
compactly: Vector3/Vector2/Color3 as arrays (`[x,y,z]`), and read tools accept a `props` projection.

All server logging goes to **stderr** (`stdout` is reserved for the MCP protocol).

### Licensing (paid product)

This is sold software, not open source (see `LICENSE`, `SELLING.md`). `src/licensing/*` enforces it
in the **client** (`src/index.ts`): `resolveLicense()` runs once at startup and
`installLicenseGate(server)` wraps `McpServer.registerTool` so every tool except `system_info`
short-circuits with a "buy a license" `fail()` when the state is `locked`. States: `licensed` /
`trial` / `locked`.
- **`license.ts`** — the resolver. Key from `ROBLOX_MCP_LICENSE` or `~/.roblox-mcp-pro/license.key`.
  With a key it activates+validates via Lemon Squeezy; valid→licensed, expired/disabled→locked,
  offline-but-recently-valid→licensed (7-day grace), key-not-ours→falls through to trial. No key →
  14-day local trial tracked in `~/.roblox-mcp-pro/state.json`.
- **`lemonsqueezy.ts`** — calls the LS License API (`/activate`, `/validate`). These endpoints take
  only the customer's key (no secret API key ships).
- **`config.ts`** — `LEMONSQUEEZY_STORE_ID`/`PRODUCT_ID` must be set for a real release (env
  `RMP_LS_STORE_ID`/`RMP_LS_PRODUCT_ID` or hardcode); while 0 the ownership check is skipped (dev
  mode only). `system_info` reports the license state. Owner test tool: `scripts/check-license.mjs`.
The broker is **not** gated — licensing belongs to each agent's client process.

### Sync engine

`src/sync/{engine,mirror,sourcemap}.ts` keeps a Studio subtree and an on-disk mirror in step. It
lives in the **broker** (single engine shared by all agents, so multiple agents never spin up
competing file watchers); the `manage_sync` tool forwards control to it via `/rpc/call`.
**Layout: one project folder = one universe**; each place mirrors into
`places/<Name>_<placeId>/{place.json, explorer/, default.project.json, sourcemap.json}`. Identity
is the `placeId` in `place.json` (folder names are cosmetic; unsaved places with id 0 match by
name), and `pull` re-resolves the open place first so a snapshot never lands in another place's
folder. Base dir = the syncDir arg, else the active agent's cwd, else `ROBLOX_MCP_SYNC_DIR`;
`ROBLOX_MCP_FLAT_SYNC=true` keeps the legacy single-place `explorer/`-at-root layout.
Directions:
- **pull** (Studio→disk): full snapshot via `sync_snapshot`, rebuilds files + sourcemap.
- **FS→Studio**: chokidar watches `*.luau`; change/add/unlink push source / create / delete in
  Studio (`sync_apply`, `manage_scripts`, `mutate_instances`).
- **Studio→FS**: `bridge.onEvent` receives `source_changed` / `added` / `removing` events; source
  edits write files directly, structural changes debounce a full re-pull.

An **echo-guard** (`suppressFile` / `suppressStudio` maps, `SUPPRESS_MS`) suppresses the change a
write triggers on the opposite side so the two directions don't ping-pong. Known gap: non-script
property edits in Studio mirror only on resync, not live.

## Studio plugin specifics

- Built with **rojo** (pinned `rojo-rbx/rojo@7.7.0-rc.1` in `aftman.toml`; install Aftman first).
  rojo is ONLY a plugin-build tool here — it is unrelated to the sync feature, which is custom.
- Plugin files are `--!strict` Luau under `plugin/src/`. Entry is `init.server.luau` (toolbar
  toggle + DockWidget panel + poll loop). UI is `plugin/src/UI.luau`. Serialization helpers in
  `Serialize.luau`. The committed `plugin/RobloxMcpPro.rbxmx` is the built artifact.
- The plugin remembers its connection across reloads (`roblox_mcp_pro_active` setting) and
  auto-reconnects; after a server restart it needs ~one 5s retry to reattach.

## Testing against Studio

There is no unit-test harness. To verify a change end-to-end:
1. Spawn `node dist/index.js` (or a Node MCP-stdio client harness). It auto-spawns
   the broker on 3690 if one isn't already running — no need to manage the port manually. The
   broker logs to `%TEMP%/roblox-mcp-pro-broker.log` and idle-exits ~20s after the last agent
   disconnects (the Studio plugin alone does not keep it alive).
2. The real Studio plugin (toggled ON once, then auto-reconnects) answers commands.
3. To test broker/transport plumbing without Studio, hit `/rpc/*` and `/api/state` directly (a
   `call` for a plugin tool returns `{ok:false, error:"…not connected"}`), and open the dashboard
   at http://127.0.0.1:3690/.

Studio does **not** reliably hot-reload a rebuilt `.rbxmx` — if a new tool reports "Unknown tool",
restart Studio. After a server kill, allow ~5s for the plugin's retry to reconnect.

## Tool count note

The README, `system_info` description, and the `meta`/version strings can drift from the actual
registered tool set. The source of truth is `registerAllTools` (`src/tools/index.ts`) for the
server and `HANDLER_NAMES` (`plugin/src/Dispatcher.luau`) for the plugin. Keep README's "Tools"
table in sync when adding/removing a tool.

## capture_studio (Windows-only, no plugin)

`capture_studio` (`src/tools/capture.ts` + `src/services/capture.ts`) takes an **OS-level
screenshot** of the Studio window via Win32 + System.Drawing through PowerShell, returning an
image so the agent sees the real render. It does NOT go through the bridge/plugin and only works
on Windows.
