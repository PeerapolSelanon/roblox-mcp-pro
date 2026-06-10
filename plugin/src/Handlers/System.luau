--!strict
-- Handler for system_info: report basic Studio session details.

local RunService = game:GetService("RunService")
local resolvePlaceName = require(script.Parent.Parent.PlaceName)

return function(_args: any): any
	return {
		placeId = game.PlaceId,
		placeName = resolvePlaceName(),
		studioVersion = version(),
		isRunning = RunService:IsRunning(),
	}
end
