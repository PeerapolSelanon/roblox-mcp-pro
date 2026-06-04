--!strict
-- roblox-mcp-pro Studio plugin entry point.
-- Adds a toolbar toggle that connects to the local MCP bridge and long-polls
-- for commands, dispatching each to its handler.

local HttpService = game:GetService("HttpService")

local Bridge = require(script.Bridge)
local Dispatcher = require(script.Dispatcher)
local UI = require(script.UI)

local DEFAULT_URL = "http://127.0.0.1:3690"
local SETTING_URL = "roblox_mcp_pro_url"
local SETTING_TOKEN = "roblox_mcp_pro_token"

-- Resolve config from saved plugin settings (falls back to defaults).
local url = plugin:GetSetting(SETTING_URL) or DEFAULT_URL
local token = plugin:GetSetting(SETTING_TOKEN)
Bridge.configure(url, token)

local toolbar = plugin:CreateToolbar("Roblox MCP Pro")
local button = toolbar:CreateButton(
	"RobloxMcpProToggle",
	"Toggle the Roblox MCP Pro control panel panel",
	"",
	"MCP"
)
button.ClickableWhenViewportHidden = true

-- Initialize DockWidget GUI
local widgetInfo = DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Right, -- initial dock state
	false, -- initially disabled (closed by default)
	false, -- override previous enabled state (remember layout)
	300, -- default width
	300, -- default height
	250, -- minimum width
	200  -- minimum height
)
local widget = plugin:CreateDockWidgetPluginGui("RobloxMcpProPanel", widgetInfo)

-- Create the UI panel inside the widget
UI.create(widget, { url = url, token = token })

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
		if not connected then break end -- Safeguard against connection closed while yielding
		
		if command then
			if not reachable then
				log("reconnected to " .. url)
			end
			reachable = true
			announcedDown = false
			UI.setStatus("Connected")
			
			local ok, result, errMsg = Dispatcher.dispatch(command.tool, command.args)
			Bridge.respond(command.id, ok, result, errMsg)
			
			-- Feed execution result to UI console
			UI.addLog(command.tool, ok, if ok then nil else errMsg)
		elseif err then
			-- Transport error (server down, HTTP disabled). Warn once per outage.
			reachable = false
			UI.setStatus("Offline")
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
			UI.setStatus("Connected")
		end
	end
end

local SETTING_ACTIVE = "roblox_mcp_pro_active"

local function setConnected(value: boolean)
	connected = value
	plugin:SetSetting(SETTING_ACTIVE, value) -- remember across reloads
	if value then
		log("connecting to " .. url)
		UI.setStatus("Connecting")
		task.spawn(pollLoop)
	else
		log("disconnected")
		UI.setStatus("Disconnected")
	end
end

-- Connect UI Callbacks
UI.onConnectionToggled = function(connect: boolean)
	setConnected(connect)
end

UI.onSettingsSaved = function(newUrl: string, newToken: string?)
	url = newUrl
	token = newToken
	plugin:SetSetting(SETTING_URL, newUrl)
	plugin:SetSetting(SETTING_TOKEN, newToken)
	Bridge.configure(newUrl, newToken)
	log("settings updated, URL: " .. newUrl)
	
	-- Restart connection if active to apply new URL/Token
	if connected then
		setConnected(false)
		task.wait(0.1)
		setConnected(true)
	end
end

-- Toggle widget visibility via toolbar button
button.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

-- Sync button state with widget visibility
widget:GetPropertyChangedSignal("Enabled"):Connect(function()
	button:SetActive(widget.Enabled)
end)
button:SetActive(widget.Enabled)

plugin.Unloading:Connect(function()
	connected = false
end)

-- Restore active connection if it was on before reload
log(("loaded %d tools."):format(Dispatcher.toolCount))
if plugin:GetSetting(SETTING_ACTIVE) == true then
	log("restoring previous connection…")
	setConnected(true)
else
	log("click the 'MCP' button on the toolbar or open the panel to connect.")
	UI.setStatus("Disconnected")
end
