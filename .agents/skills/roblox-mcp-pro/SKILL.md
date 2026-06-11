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

## When something fails

Errors are returned as actionable text. Common ones: not connected (fix the plugin/server),
"protected service" (CoreGui/CorePackages are intentionally off-limits), and per-operation errors
inside `batch_execute`/`mutate_instances` results (other operations still ran). Read the `error`
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

