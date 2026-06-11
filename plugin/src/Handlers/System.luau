--!strict
-- Handler for system_info: report basic Studio session details, a stable
-- per-session id (so the agent can tell when Studio was reopened / switched),
-- and a few read-only Studio settings.

local RunService = game:GetService("RunService")
local resolvePlaceName = require(script.Parent.Parent.PlaceName)

-- Generated once when this plugin instance loads; stays constant for the life of
-- the Studio session and changes when the plugin reloads / Studio restarts.
local SESSION_ID = game:GetService("HttpService"):GenerateGUID(false)

local function studioSettings(): any
	local out: { [string]: any } = {}
	pcall(function()
		local studio = settings():GetService("Studio")
		local theme = studio.Theme
		out.theme = theme and theme.Name or nil
	end)
	return out
end

return function(_args: any): any
	return {
		placeId = game.PlaceId,
		placeName = resolvePlaceName(),
		studioVersion = version(),
		isRunning = RunService:IsRunning(),
		sessionId = SESSION_ID,
		studioSettings = studioSettings(),
	}
end
