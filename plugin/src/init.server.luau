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
local SETTING_AUTOCONNECT = "roblox_mcp_pro_autoconnect"
local SETTING_SYNCMODE = "roblox_mcp_pro_syncmode"

-- Resolve config from saved plugin settings (falls back to defaults).
local url = plugin:GetSetting(SETTING_URL) or DEFAULT_URL
local token = plugin:GetSetting(SETTING_TOKEN)
local autoConnect = plugin:GetSetting(SETTING_AUTOCONNECT) == true
local syncMode = plugin:GetSetting(SETTING_SYNCMODE) or "two-way"
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
UI.create(widget, { url = url, token = token, autoConnect = autoConnect, syncMode = syncMode })

local connected = false
local isSyncing = false

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

	-- Reflect reachability immediately. Otherwise the panel sits on "Connecting"
	-- until the first /dequeue returns, which the long-poll can hold open for up
	-- to ~25s when no command is waiting.
	if connected and Bridge.health() then
		UI.setStatus("Connected")
	end

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

			-- Feed execution result to UI console (but not broker-internal probes
			-- like the dashboard's periodic system_info — only real agent commands).
			if not command.internal then
				UI.addLog(command.tool, ok, if ok then nil else errMsg)
			end
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

-- Reflect a sync-status result from the broker in the UI.
local function applySyncResult(result: any)
	isSyncing = result.running == true
	UI.setSyncStatus(isSyncing, result.mode, result.scriptCount)
end

-- While connected, poll the broker's sync status so the Sync card stays in step
-- (including sync started by an AI agent rather than this panel).
local function startSyncRefresher()
	task.spawn(function()
		while connected do
			local st = Bridge.syncStatus()
			if st then
				applySyncResult(st)
			end
			task.wait(5)
		end
	end)
end

local function setConnected(value: boolean)
	connected = value
	-- Tell the broker right away so the dashboard reflects it within ~1s.
	task.spawn(function()
		Bridge.notifyPresence(value)
	end)
	if value then
		log("connecting to " .. url)
		UI.setStatus("Connecting")
		task.spawn(pollLoop)
		startSyncRefresher()
	else
		log("disconnected")
		UI.setStatus("Disconnected")
		isSyncing = false
		UI.setSyncStatus(false, syncMode, 0)
	end
end

-- Connect UI Callbacks
UI.onConnectionToggled = function(connect: boolean)
	setConnected(connect)
end

UI.onAutoConnectChanged = function(enabled: boolean)
	plugin:SetSetting(SETTING_AUTOCONNECT, enabled)
	log("auto-connect " .. (if enabled then "enabled" else "disabled"))
end

UI.onSyncModeChanged = function(mode: string)
	syncMode = mode
	plugin:SetSetting(SETTING_SYNCMODE, mode)
	-- If sync is already running, restart it in the new direction.
	if connected and isSyncing then
		task.spawn(function()
			local result, err = Bridge.syncControl("start", mode)
			if result then
				applySyncResult(result)
			else
				warn("[roblox-mcp-pro] sync mode change failed: " .. tostring(err))
			end
		end)
	end
end

UI.onSyncToggled = function(enabled: boolean, mode: string)
	if not connected then
		UI.setSyncStatus(false, mode, 0)
		warn("[roblox-mcp-pro] Connect to the server before enabling sync.")
		return
	end
	task.spawn(function()
		local action = if enabled then "start" else "stop"
		local result, err = Bridge.syncControl(action, mode)
		if result then
			applySyncResult(result)
		else
			isSyncing = false
			UI.setSyncStatus(false, mode, 0)
			warn("[roblox-mcp-pro] sync " .. action .. " failed: " .. tostring(err))
		end
	end)
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
	-- Best-effort: tell the broker we're going so the dashboard updates fast
	-- (Studio closing may cut this off; the liveness timeout is the fallback).
	if connected then
		Bridge.notifyPresence(false)
	end
	connected = false
end)

-- Auto-connect only when the user opted in (default off). Fixes the old
-- behavior where the plugin reconnected on its own after a single connect.
log(("loaded %d tools."):format(Dispatcher.toolCount))
if autoConnect then
	log("auto-connect is on; connecting…")
	setConnected(true)
else
	log("click the 'MCP' button on the toolbar or open the panel to connect.")
	UI.setStatus("Disconnected")
end
