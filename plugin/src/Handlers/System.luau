--!strict
-- Handler for system_info: report basic Studio session details, a stable
-- per-session id (so the agent can tell when Studio was reopened / switched),
-- and a few read-only Studio settings.

local RunService = game:GetService("RunService")
local resolvePlaceName = require(script.Parent.Parent.PlaceName)
local Bridge = require(script.Parent.Parent.Bridge)

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
		-- The SAME id the bridge sends as x-session-id, so a value read here can be
		-- used directly with manage_agents { action:"attach", session:<id> }.
		sessionId = Bridge.sessionId(),
		studioSettings = studioSettings(),
	}
end
