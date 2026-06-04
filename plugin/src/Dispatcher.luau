--!strict
-- Dispatcher: route an incoming command to its handler.
-- Handlers are loaded defensively: one broken handler disables only its own
-- tool rather than breaking the whole plugin.

local Handlers = script.Parent.Handlers

local HANDLER_NAMES = {
	execute_luau = "Execute",
	query_instances = "Query",
	mutate_instances = "Mutate",
	manage_properties = "Properties",
	system_info = "System",
	sync_snapshot = "SyncSnapshot",
	sync_watch = "SyncWatch",
	sync_apply = "SyncApply",
	batch_execute = "Batch",
	spatial_query = "Spatial",
	manage_terrain = "Terrain",
	manage_ui = "UI",
	manage_audio = "Audio",
	manage_animation = "Animation",
	manage_lighting = "Lighting",
	manage_effects = "Effects",
	manage_physics = "Physics",
	manage_camera = "Camera",
	manage_tween = "Tween",
	manage_assets = "Assets",
	manage_scripts = "Scripts",
	manage_selection = "Selection",
	manage_studio = "Studio",
	manage_logs = "Logs",
	workspace_state = "WorkspaceState",
}

local map: { [string]: (any) -> any } = {}
for tool, moduleName in HANDLER_NAMES do
	local ok, handler = pcall(function()
		return require(Handlers[moduleName])
	end)
	if ok and type(handler) == "function" then
		map[tool] = handler
	else
		warn(("[roblox-mcp-pro] failed to load handler '%s': %s"):format(moduleName, tostring(handler)))
	end
end

local Dispatcher = {}

-- Number of tools successfully loaded (for startup diagnostics).
Dispatcher.toolCount = 0
for _ in map do
	Dispatcher.toolCount += 1
end

-- Returns: success (boolean), result (any), errorMessage (string?)
function Dispatcher.dispatch(tool: string, args: any): (boolean, any, string?)
	local handler = map[tool]
	if not handler then
		return false, nil, "Unknown or unavailable tool: " .. tostring(tool)
	end
	local ok, result = pcall(handler, args)
	if ok then
		return true, result, nil
	else
		return false, nil, tostring(result)
	end
end

return Dispatcher
