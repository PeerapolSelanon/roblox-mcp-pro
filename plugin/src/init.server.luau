--!strict
-- roblox-mcp-pro Studio plugin entry point.
-- Adds a toolbar toggle that connects to the local MCP bridge and long-polls
-- for commands, dispatching each to its handler.

local HttpService = game:GetService("HttpService")

local Bridge = require(script.Bridge)
local Dispatcher = require(script.Dispatcher)

local DEFAULT_URL = "http://127.0.0.1:3690"
local SETTING_URL = "roblox_mcp_pro_url"
local SETTING_TOKEN = "roblox_mcp_pro_token"

-- Resolve config from saved plugin settings (falls back to defaults).
local url = plugin:GetSetting(SETTING_URL) or DEFAULT_URL
local token = plugin:GetSetting(SETTING_TOKEN)
Bridge.configure(url, token)

local toolbar = plugin:CreateToolbar("Roblox MCP Pro")
-- Note: PluginToolbarButton has no settable Text/Tooltip after creation, so the
-- label is fixed here and on/off state is shown via SetActive (highlight).
local button = toolbar:CreateButton(
	"RobloxMcpProToggle",
	"Connect/disconnect this Studio session to the local roblox-mcp-pro server",
	"",
	"MCP"
)
button.ClickableWhenViewportHidden = true

local connected = false

local function log(message: string)
	print("[roblox-mcp-pro] " .. message)
end

local RETRY_WAIT = 5 -- seconds to back off while the server is unreachable

local function pollLoop()
	-- Best-effort enable HTTP for localhost requests.
	pcall(function()
		HttpService.HttpEnabled = true
	end)

	-- Track reachability so we only log on state changes (no per-cycle spam).
	local reachable = true
	local announcedDown = false

	while connected do
		local command, err = Bridge.dequeue()
		if command then
			if not reachable then
				log("reconnected to " .. url)
			end
			reachable = true
			announcedDown = false
			local ok, result, errMsg = Dispatcher.dispatch(command.tool, command.args)
			Bridge.respond(command.id, ok, result, errMsg)
		elseif err then
			-- Transport error (server down, HTTP disabled). Warn once per outage.
			reachable = false
			if not announcedDown then
				announcedDown = true
				warn(
					"[roblox-mcp-pro] MCP server unreachable at "
						.. url
						.. " — retrying every "
						.. RETRY_WAIT
						.. "s. Start it (node dist/index.js) and ensure 'Allow HTTP Requests' is on."
				)
			end
			task.wait(RETRY_WAIT)
		else
			-- nil command, no error = long-poll timed out; server is up. Loop again.
			if not reachable then
				log("reconnected to " .. url)
			end
			reachable = true
			announcedDown = false
		end
	end
end

local SETTING_ACTIVE = "roblox_mcp_pro_active"

local function setConnected(value: boolean)
	connected = value
	button:SetActive(value)
	plugin:SetSetting(SETTING_ACTIVE, value) -- remember across reloads
	if value then
		log("connecting to " .. url .. " (button highlighted = on)")
		task.spawn(pollLoop)
	else
		log("disconnected (button not highlighted = off)")
	end
end

button.Click:Connect(function()
	setConnected(not connected)
end)

plugin.Unloading:Connect(function()
	connected = false
end)

-- Auto-reconnect if we were connected before a reload, so rebuilds don't require
-- clicking the button again.
log(("loaded %d tools."):format(Dispatcher.toolCount))
if plugin:GetSetting(SETTING_ACTIVE) == true then
	log("restoring previous connection…")
	setConnected(true)
else
	log("click the 'MCP' button on the toolbar to connect.")
end
