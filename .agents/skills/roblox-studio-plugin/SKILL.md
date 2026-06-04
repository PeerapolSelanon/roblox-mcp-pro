---
name: roblox-studio-plugin
description: >-
  How to build, package, and install a high-quality Roblox Studio plugin in Luau — toolbar
  buttons, dock widgets, the plugin lifecycle, persisting state across reloads, undo via
  ChangeHistoryService, reading/writing script source via ScriptEditorService, HttpService from
  plugins, and packaging to .rbxmx with Rojo. Use this whenever building or editing a Roblox
  Studio plugin (anything under a plugin/ folder, a `*.server.luau` plugin entry, PluginToolbar,
  PluginToolbarButton, CreateDockWidgetPluginGui, plugin:GetSetting/SetSetting, plugin:Activate),
  or when the user wants to make, package, install, or debug a Studio plugin — even if they only
  say "Studio plugin", "toolbar button", or "rbxmx". Read this before writing plugin code; it
  encodes non-obvious Studio behaviors that are easy to get wrong.
---

# Building Roblox Studio plugins

A Studio plugin is Luau that runs inside Studio's editor with elevated privileges (the global
`plugin` object). It can read/edit the DataModel, add toolbar UI, talk to localhost over HTTP,
and register undo waypoints. The hard part isn't the API surface — it's a handful of Studio
behaviors that silently misbehave if you don't know them. This skill front-loads those.

A complete, tested reference implementation lives in this repo under `plugin/` (entry
`plugin/src/init.server.luau`, modules in `plugin/src/`). Read it for a working example.

## Project layout (Rojo)

Structure the plugin as a directory that Rojo compiles into one `.rbxmx`:

```
plugin/
  default.project.json     # { "name": "MyPlugin", "tree": { "$path": "src" } }
  src/
    init.server.luau       # a folder with init.server.luau becomes the root *Script* (the plugin)
    Foo.luau               # sibling ModuleScripts → require(script.Foo)
    Handlers/Bar.luau      # subfolder → require(script.Handlers.Bar)
```

Build + install (Windows):

```powershell
rojo build default.project.json --output MyPlugin.rbxmx
Copy-Item MyPlugin.rbxmx (Join-Path $env:LOCALAPPDATA "Roblox\Plugins\MyPlugin.rbxmx") -Force
```

`%LOCALAPPDATA%\Roblox\Plugins` is the local plugins folder. Pin the Rojo version in `aftman.toml`
so builds are reproducible.

## Gotchas that will bite you

These are the non-obvious behaviors. Internalize them — each one is a bug we hit and fixed.

- **`PluginToolbarButton` has no settable `Text` or `Tooltip`.** The label/tooltip are fixed at
  `CreateButton(id, tooltip, icon, text)` time. Assigning `button.Text = …` errors at runtime.
  Show on/off state with `button:SetActive(bool)` (it highlights), not by changing text.
- **Studio does NOT reliably hot-reload local `.rbxmx` plugins.** After rebuilding, the running
  plugin is often the *old* one until Studio restarts (or sometimes regains focus). Always log a
  startup line like `("loaded %d tools"):format(n)` (and a version) so you can confirm in the
  Output which build is actually live. When new code "isn't taking effect", suspect this first.
- **Plugin state resets every reload.** Persist anything that should survive a reload with
  `plugin:SetSetting(key, value)` / `plugin:GetSetting(key)`. A common pattern: save whether the
  plugin was "active", and on load auto-restore it so iterating doesn't require re-clicking.
- **One bad module breaks the whole plugin.** If `require(child)` errors at load, the requiring
  module errors too, cascading to the entry script and the plugin silently does nothing. Load
  optional/numerous modules defensively so a single failure disables only that feature:
  ```lua
  local map = {}
  for name, moduleName in pairs(HANDLER_NAMES) do
      local ok, mod = pcall(require, Handlers[moduleName])
      if ok then map[name] = mod else warn("failed to load " .. moduleName .. ": " .. tostring(mod)) end
  end
  ```
- **`loadstring` works in plugin context** (unlike in a running game without LoadStringEnabled),
  but guard it: `if type(loadstring) ~= "function" then …`. Capture printed output by connecting
  `LogService.MessageOut` for the duration of the call rather than trying to override `print`
  (`setfenv` is unavailable in modern Luau).

## Toolbar + lifecycle skeleton

```lua
local toolbar = plugin:CreateToolbar("My Plugin")
-- label & tooltip are fixed here; state is shown via SetActive
local button = toolbar:CreateButton("MyToggle", "Toggle the thing", "", "My Plugin")
button.ClickableWhenViewportHidden = true

local active = false
local function setActive(v)
    active = v
    button:SetActive(v)
    plugin:SetSetting("active", v)           -- survive reloads
    -- start/stop your work here
end

button.Click:Connect(function() setActive(not active) end)
plugin.Unloading:Connect(function() active = false end)

if plugin:GetSetting("active") == true then setActive(true) end  -- auto-restore
```

For richer UI, use a dock widget:
`plugin:CreateDockWidgetPluginGui(id, DockWidgetPluginGuiInfo.new(...))`, then parent a ScreenGui's
contents into it. Keep it lazy — only build the widget when first shown.

## Editing the DataModel safely

- **Wrap mutations in undo recordings** so the user can Ctrl+Z your changes:
  ```lua
  local rec = ChangeHistoryService:TryBeginRecording("My action")
  -- …make changes…
  if rec then ChangeHistoryService:FinishRecording(rec, Enum.FinishRecordingOperation.Commit) end
  ```
  Use `Cancel` instead of `Commit` when the operation failed, so a no-op doesn't pollute history.
- **Read/write script source via `ScriptEditorService`**, not just `.Source`. `GetEditorSource(s)`
  reflects unsaved edits in an open document; `UpdateSourceAsync(s, fn)` writes safely even when
  the script is open in the editor. Fall back to `s.Source` if the service call fails.
- **Never edit `CoreGui` / `CorePackages`** (and the plugin's own GUI service). Guard against it —
  walking an instance's ancestry and refusing protected names prevents corrupting the session.

## HttpService from a plugin

Plugins can call localhost. `HttpService:RequestAsync` **yields**, so run loops in `task.spawn`.
A long-poll request blocks up to the server's hold time (well under the ~60s client timeout), so
it's fine for command/event channels. Best-effort enable with `pcall(function()
HttpService.HttpEnabled = true end)` and surface a clear message if requests fail (HTTP disabled or
server down) instead of spamming — warn once per outage and back off.

## Edit-mode caveats for common services

Most things work in edit mode, but a few are subtle:
- `TweenService:Create(…):Play()` advances in edit mode (Heartbeat runs) — usable for previews.
- Playing animations on a rig needs an `Animator`; visible motion of a programmatic
  `LoadAnimation():Play()` may require Play mode.
- `Sound:Play()` previews in edit mode.
- `Selection` (`game:GetService("Selection")`) reads/sets the Explorer selection; great for
  pointing the user at what you changed.

## Verifying a plugin

You usually can't fully drive Studio headlessly. Verify by: build + install, restart/reopen Studio,
confirm your startup log line appears (proves the new build loaded), click the toolbar button, and
watch the Output. If the plugin pairs with an external process (e.g. an MCP/localhost server), a
harness that starts the server and exercises it end-to-end while the real plugin answers is the
most reliable check — see this repo's test pattern.
