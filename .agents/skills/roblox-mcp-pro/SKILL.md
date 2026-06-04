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

## Choosing the right tool

Prefer the **specific** tool over `execute_luau`. The structured tools return clean, validated
data and guard against damaging the session (they refuse to touch CoreGui/CorePackages). Reach for
`execute_luau` only for one-off logic no dedicated tool covers — and remember its output is
captured print/warn plus `return` values.

| You want to… | Use |
| --- | --- |
| Read instances / the tree | `query_instances` |
| Create / edit / move / clone / delete instances | `mutate_instances` |
| Read or write specific properties | `manage_properties` |
| Do many edits atomically (one undo) | `batch_execute` |
| Run arbitrary Luau | `execute_luau` |
| Find parts by space (box, radius, raycast, nearest) | `spatial_query` |
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
