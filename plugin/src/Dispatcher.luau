--!strict
-- Dispatcher: route an incoming command to its handler.
-- Handlers are loaded defensively: one broken handler disables only its own
-- tool rather than breaking the whole plugin.

local ChangeHistoryService = game:GetService("ChangeHistoryService")

local Handlers = script.Parent.Handlers

-- Tools that never mutate the DataModel (or whose changes shouldn't create
-- undo steps, e.g. selection / transient previews). Everything else gets a
-- ChangeHistoryService waypoint after a successful dispatch, so one command
-- equals one Ctrl+Z step instead of agent work folding into the user's undo.
local NO_WAYPOINT = {
	query_instances = true,
	find_instances = true,
	scene_overview = true,
	describe_instance = true,
	system_info = true,
	sync_snapshot = true,
	sync_watch = true,
	spatial_query = true,
	manage_logs = true,
	manage_studio = true,
	manage_selection = true,
	workspace_state = true,
	ui_preview = true,
}

local HANDLER_NAMES = {
	execute_luau = "Execute",
	query_instances = "Query",
	find_instances = "FindInstances",
	scene_overview = "SceneOverview",
	describe_instance = "DescribeInstance",
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
	ui_preview = "UIPreview",
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
		if not NO_WAYPOINT[tool] then
			-- Best-effort: waypoints are unavailable while a playtest is running.
			pcall(function()
				ChangeHistoryService:SetWaypoint("MCP " .. tool)
			end)
		end
		return true, result, nil
	else
		return false, nil, tostring(result)
	end
end

return Dispatcher
