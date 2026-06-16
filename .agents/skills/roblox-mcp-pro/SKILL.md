---
name: roblox-mcp-pro
description: >-
  How to drive the roblox-mcp-pro MCP server to control a live Roblox Studio session — running
  Luau, querying/mutating the DataModel, building UI, terrain, lighting/effects, audio/animation,
  spatial queries, and bidirectional Studio↔disk sync. Use this whenever the task involves the
  roblox-mcp-pro tools (names like execute_luau, query_instances, mutate_instances, manage_sync,
  manage_ui, manage_terrain, manage_lighting, spatial_query, batch_execute, workspace_state),
  or whenever the user wants an agent to change things inside Roblox Studio through this server —
  even if they don't name a specific tool. Read this before the first tool call to pick the right
  tool and confirm the connection.
---

# Using roblox-mcp-pro

roblox-mcp-pro exposes 23 tools that act on a **live Roblox Studio session**. The MCP server
talks to a Studio plugin over a localhost bridge; the plugin runs each command with full plugin
privileges and returns structured results. Your job is to choose the right tool and verify the
session is actually connected before relying on results.

## Always start with the connection check

Tools fail with `Error: Roblox Studio plugin is not connected…` if no Studio session is attached.
Before a sequence of changes, call **`system_info`** once. If `bridge.pluginConnected` is false,
tell the user to open Studio and click the **MCP** button on the toolbar (it must be highlighted),
and that the roblox-mcp-pro server must be running. Don't keep retrying blindly — surface the fix.

`workspace_state` is a good second call to orient yourself (place name, child counts per service,
camera, selection) before editing.

> Exact per-parameter contracts for every tool live in
> [references/tools.md](references/tools.md) — auto-generated from the server's
> own schemas each release, so it is always current. Check it when unsure about
> an argument name, type, or default.

## Choosing the right tool

Prefer the **specific** tool over `execute_luau`. The structured tools return clean, validated
data and guard against damaging the session (they refuse to touch CoreGui/CorePackages). Reach for
`execute_luau` only for one-off logic no dedicated tool covers — and remember its output is
captured print/warn plus `return` values.

| You want to… | Use |
| --- | --- |
| Read instances / the tree | `query_instances` |
| Create / edit / move / clone / delete instances | `mutate_instances` |
| N spaced copies (fence rows, grids) | `mutate_instances` action `duplicate` (count + offset) |
| Read or write specific properties | `manage_properties` |
| Attributes / CollectionService tags | `manage_properties` (get/set_attributes, add/remove_tags, get_tagged) |
| Same properties on many instances at once | `manage_properties` (mass_set, mass_get, modify_children) |
| Adjust a value relatively ("raise 5 studs", "double it") | `manage_properties` set_relative (delta/scale) |
| What properties/events does class X have | `describe_instance` with `class_name` (API-dump reflection) |
| Do many edits atomically (one undo) | `batch_execute` |
| Run arbitrary Luau | `execute_luau` |
| Find parts by space (box, radius, raycast, nearest) | `spatial_query` |
| Ground height / is a spot free to build | `spatial_query` (find_ground, check_placement) |
| Bounding box / flat spots / walkability / density map | `spatial_query` (bounds, find_flat, analyze_walkable, spatial_map) |
| Generate/edit terrain | `manage_terrain` |
| Time of day, fog, ambient, shadows | `manage_lighting` |
| Bloom/Blur/ColorCorrection/DoF/Atmosphere/Sky | `manage_effects` |
| Move/aim the camera | `manage_camera` |
| Animate properties over time | `manage_tween` |
| Physical props / welds | `manage_physics` |
| Collision groups (who passes through whom) | `manage_physics` (register_group, assign_group, set_collidable, get_groups) |
| Emit/toggle particles | `manage_effects` (emit, toggle) |
| List/stop animation tracks on a rig | `manage_animation` (get_tracks, stop) |
| Aim the 3D audio listener | `manage_audio` set_listener |
| What is the camera looking at | `workspace_state` action 'viewport' |
| Read/edit a synced script file, sync history | `manage_sync` (read_file, write_file, history, progress) |
| Build GUI (ScreenGui/Frame/labels/buttons) | `manage_ui` |
| Create/preview Sound | `manage_audio` |
| Animation instances / preview | `manage_animation` |
| Insert marketplace assets by id | `manage_assets` |
| Read/write script source, create scripts | `manage_scripts` |
| Surgical script edits / search code | `manage_scripts` (edit_replace/edit_insert/edit_delete by line, search across scripts, replace with dry_run) |
| What does this script require()? | `manage_scripts` get_dependencies |
| Procedural hills / ramps / material swap / smooth terrain | `manage_terrain` (generate, fill_wedge, fill_cylinder, replace_material, smooth) |
| Let the user point at an instance by clicking it | `manage_selection` watch |
| What changed since I last looked | `workspace_state` action 'changes' |
| Mirror Studio↔disk both ways | `manage_sync` |
| Explorer selection | `manage_selection` |
| Studio version/theme/run state | `manage_studio` |
| Recent Output logs | `manage_logs` |
| High-level session snapshot | `workspace_state` |
| See other AI agents / claim a role / hand a task to one | `manage_agents` (list, set_role, send, inbox, read, done) |

## Multi-agent coordination (`manage_agents`)

When several AI agents drive the same Studio session, `manage_agents` lets them
pass tasks directly to one another through the shared broker (no Studio round-trip):

- `list` — who's connected, each with a `clientId` and `role` (your row has
  `self: true`); the response's `lead` names the current lead.
- `set_role` — claim a role: `lead` (you plan and dispatch), `worker` (you execute
  tasks others send), or `idle`. Only **one lead at a time** — claiming lead demotes
  the previous lead to worker.
- `send` — deliver a task by `to`: an agent name (`claude-code`), an exact `clientId`
  (when names collide), or a group keyword — `workers` (all workers), `lead`, `all`.
  Include `subject`/`body`.
- `inbox` — messages addressed to you (`unreadOnly` to skip read ones).
- `read` / `done` — mark your messages read or complete.

### Lead / worker pattern

- **Lead agent**: `set_role {role:"lead"}`, plan the work, then fan it out with
  `send {to:"workers", subject, body}` (or to one named agent). Poll `inbox` for the
  workers' results.
- **Worker agent**: `set_role {role:"worker"}`, then **check `inbox` at the start of
  every turn and poll it while idle** — execute each task and report back with
  `send {to:"lead", body:"<result>"}`, then `done {messageId}`.

### Single agent (solo = both planner and worker)

If you are the **only** agent connected, roles and the mailbox add nothing — just
plan and do the work in your own turn. Don't `send` tasks to yourself and don't sit
polling `inbox`. Check `list` first: if there are no other agents (or no `worker`),
act as both — make the plan, then execute it yourself. A `lead` whose `send
{to:"workers"}` reports no workers should simply carry out the task directly rather
than wait. Only switch to delegating once another worker agent actually connects.

MCP is request/response, so a recipient only sees a message when it calls `inbox` —
nothing pushes a task to an agent automatically. The roles are a coordination
convention the broker tracks and routes by; each agent still acts per its own prompt.

## Working with multiple Places at once

When more than one Roblox Studio Place is open and connected to the broker, each
connection is a **session** with its own `sessionId` and Place name.

### Safety rule — fail-closed when unbound

If an agent is **not bound to a Place** and **more than one Place is connected**, every
Studio command is refused with an error that lists the connected Places. Attach first:

```
manage_agents { action: "attach", place: "<Place name>" }
```

After attaching, **all** of that agent's tool calls go exclusively to that Place until
it detaches or the session ends. With exactly **one** Place connected, commands
auto-route and auto-bind — single-Place workflows are completely unchanged.

### Session discovery and binding

- `manage_agents { action: "sessions" }` — list connected Places (name, placeId, bound agents).
- `manage_agents { action: "attach", place: "<Place name>" }` — bind to a named Place; name must match what `sessions` reports.
- `manage_agents { action: "detach" }` — release the binding (useful when switching Places or handing off).

### Lead / Worker dispatch across Places

The standard Lead/Worker role pattern extends naturally to multi-Place editing:

1. **Lead** plans the work and delivers a task to the Worker via
   `manage_agents { action: "send", to: "<worker>", body: "edit Place X: ..." }`,
   naming the target Place in the body.
2. **Worker** calls `manage_agents { action: "inbox" }`, reads the task, then
   immediately attaches: `manage_agents { action: "attach", place: "X" }`.
3. **Worker** executes all edits — every tool call is provably scoped to Place X.
4. **Worker** reports back: `manage_agents { action: "send", to: "lead", body: "<result>" }`,
   then `manage_agents { action: "done", messageId: "<id>" }`.

The **Lead** can also call `attach` to inspect or verify a Place (read-only intent)
while the Worker is attached to a different one — each agent holds its own binding.

### Sync with multiple Places

`manage_sync { action: "start" }` must be pinned to one Place when more than one is
connected. Pass the Place name explicitly:

```
manage_sync { action: "start", place: "<Place name>" }
```

If you omit `place` when multiple sessions are active, `start` is refused. Once
started, sync operates on that Place's session for its lifetime.

## Patterns that work well

- **Batch related edits.** Building several parts or a whole structure? Wrap the operations in
  `batch_execute` so it's one undo step and one round-trip, not N. Each step reports its own
  ok/error, so a single bad op doesn't lose the rest.
- **Verify after you change.** After a `mutate_instances`/`manage_ui` create, a quick
  `query_instances` (with `include_properties: true`) confirms it landed as intended.
- **Property value shapes.** Vectors are `[x,y,z]`; Color3 is `[r,g,b]` (0–1); UDim2 is
  `[[xScale,xOffset],[yScale,yOffset]]`; CFrame is a 12-number array; enums and BrickColor are
  their string names. Values are coerced to the property's current type, so match the existing type.
- **Check logs after running code.** If `execute_luau` or a playtest misbehaves, `manage_logs`
  returns the recent Output history (newest first) so you can see prints and errors.
- **Edit scripts surgically.** Don't `set_source` a whole file to change three lines:
  `manage_scripts` `search` finds the line numbers, `get_source` with `start_line`/`end_line`
  reads just that slice, and `edit_replace`/`edit_insert`/`edit_delete` change only those lines.
- **Duplicate-named siblings.** Paths accept a 1-based index — `Workspace.Part[2]` is the second
  child named `Part` — so you can target instances that share a name.
- **Place things on the ground.** `spatial_query` `find_ground` returns the exact Y under a
  point, and `check_placement` tells you whether a box-shaped spot is free before you build there.

## Bidirectional sync (`manage_sync`)

`manage_sync` mirrors a Studio subtree to `roblox-mcp-sync/place_{placeId}/explorer/` and keeps
both sides in step, plus a `sourcemap.json` for luau-lsp. This is how you give the agent (and the
human) a stable on-disk copy of the project to edit with normal file tools.

- `action: "start"` — snapshot + begin two-way watching. Defaults to the script-bearing services
  (ServerScriptService, ReplicatedStorage, StarterGui, StarterPlayer, ServerStorage). Pass
  `roots: ["Workspace.Systems", …]` to scope differently.
- `action: "pull"` — force Studio → disk (after big structural changes).
- `action: "push"` — force disk → Studio (apply all local script edits).
- `action: "stop"` / `"status"`.

Script sync is fully two-way: creating, editing, or deleting a `.luau` file on disk creates,
updates, or deletes the script in Studio, and the same edits in Studio flow back to disk. The one
remaining gap is that non-script property changes in Studio mirror on resync (when instances are
added/removed), not live — use `pull` to resynchronize when in doubt.

## Free vs Pro

New installs get a 14-day trial of full Pro. After it ends the **free tier keeps working
forever** — core reads and edits (`query_instances`, `find_instances`, `scene_overview`,
`describe_instance`, `mutate_instances` create/edit/clone, `manage_properties` get/set,
`manage_scripts` get/set/create, `execute_luau`, `manage_logs`, `manage_selection`,
`workspace_state` snapshot, `system_info`, and one-way Studio→disk sync). **Pro** adds the
visual toolset (`manage_ui`, `manage_terrain`, `manage_effects`, `manage_tween`,
`manage_camera`, `manage_animation`, `manage_audio`, `manage_physics`, `manage_assets`),
`spatial_query`, bulk/relative property ops, surgical script search/edit, bidirectional sync,
and playtest automation. A locked Pro call returns a clear upgrade message; check status anytime
with `system_info` (`license.status`: `trial`/`licensed` = full, `locked` = free only).

## When something fails

Errors are returned as actionable text. Common ones: not connected (fix the plugin/server),
"protected service" (CoreGui/CorePackages are intentionally off-limits), a Pro-feature lock
(trial ended — the free tier still works; see above), and per-operation errors inside
`batch_execute`/`mutate_instances` results (other operations still ran). Read the `error`
string and adjust rather than retrying the same call.

## AI Agent Prompt Handling: Project Initialization

If the user asks the AI agent to initialize a full Roblox project (e.g., "ช่วย init roblox หน่อย", "init roblox", "setup roblox workspace"), the agent should execute the following sequence of steps:

1. **Create Explorer Folder Structure on Disk:**
   Create the directory `explorer/` and the following subdirectories:
   - `explorer/ReplicatedStorage`
   - `explorer/ServerScriptService`
   - `explorer/ServerStorage`
   - `explorer/StarterGui`
   - `explorer/StarterPlayer`
   - `explorer/StarterPlayer/StarterCharacterScripts`
   - `explorer/StarterPlayer/StarterPlayerScripts`

2. **Create config files:**
   - **`default.project.json`** with a tree mapping the above explorer folders and including Wally Package settings:
     ```json
     {
       "name": "<projectName>",
       "tree": {
         "$className": "DataModel",
         "ReplicatedStorage": {
           "$path": "explorer/ReplicatedStorage",
           "Packages": {
             "$path": "Packages"
           }
         },
         "ServerScriptService": {
           "$path": "explorer/ServerScriptService",
           "ServerPackages": {
             "$path": "ServerPackages"
           }
         },
         "StarterGui": {
           "$path": "explorer/StarterGui"
         },
         "StarterPlayer": {
           "$path": "explorer/StarterPlayer",
           "StarterCharacterScripts": {
             "$path": "explorer/StarterPlayer/StarterCharacterScripts"
           },
           "StarterPlayerScripts": {
             "$path": "explorer/StarterPlayer/StarterPlayerScripts"
           }
         },
         "ServerStorage": {
           "$path": "explorer/ServerStorage"
         }
       }
     }
     ```
   - **`wally.toml`** with default package settings:
     ```toml
     [package]
     name = "peerapol/<projectName>"
     version = "0.1.0"
     registry = "https://github.com/UpliftGames/wally-index"
     realm = "shared"

     [dependencies]
     # Add dependencies here
     ```
   - **`selene.toml`** with standard Roblox configuration:
     ```toml
     std = "roblox"
     ```
   - **`.gitignore`** ignoring unnecessary files:
     ```gitignore
     .rojo/
     sourcemap.json
     Packages/
     ServerPackages/
     node_modules/
     dist/
     *.log
     ```

3. **Generate sourcemap.json:**
   Create a basic/empty `sourcemap.json` or run `rojo sourcemap default.project.json --output sourcemap.json` if Rojo is available.

## UI Layout & Advanced Designing Techniques

### 1. Multi-Layer Glowing Borders with Consecutive Offsets
When designing complex multi-layer borders (e.g. inner/center/outer strokes) on frames, avoid nesting helper transparent frames. Instead:
- Put all `UIStroke` instances directly under the target frame.
- Set all `UIStroke` positions to `Enum.BorderStrokePosition.Inner` and mode to `Enum.ApplyStrokeMode.Border`.
- Use math-driven consecutive negative `BorderOffset` values to keep them flush without gaps:
  - `OuterStroke` (shadow/border): `BorderOffset = 0` (Thickness = `T1`)
  - `CenterStroke` (core glow): `BorderOffset = -T1` (Thickness = `T2`)
  - `InnerStroke` (inner shadow): `BorderOffset = -(T1 + T2)` (Thickness = `T3`)
  This guarantees that borders don't get clipped by parent `ScrollingFrame` boundaries or `ClipsDescendants`.

### 2. Auto-Resizing ScrollingFrame Settings
When building list menus or scroll views:
- Set `AutomaticCanvasSize = Enum.AutomaticSize.Y` and `ScrollingDirection = Enum.ScrollingDirection.Y` to allow the vertical scrolling canvas to automatically scale to its contents without manually calculating canvas heights.
- Make sure `ScrollBarThickness` is non-zero (e.g. `6`) so scrollbars are visible and functional when the contents exceed the container size.

### 3. Responsive Scaling using UIScale
To make a GUI larger/smaller proportionally on different viewport sizes:
- Place a `UIScale` instance (named e.g. `MainScale`) inside the main frame.
- Animate the `UIScale.Scale` property on window open/close rather than tweening the `Size` of the frame, which preserves all layout constraints and child ratios (fonts, strokes, paddings) perfectly.


