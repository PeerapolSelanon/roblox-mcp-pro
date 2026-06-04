--!strict
-- Handler for system_info: report basic Studio session details.

local RunService = game:GetService("RunService")

return function(_args: any): any
	local placeName: string? = nil
	pcall(function()
		placeName = game.Name
	end)
	return {
		placeId = game.PlaceId,
		placeName = placeName,
		studioVersion = version(),
		isRunning = RunService:IsRunning(),
	}
end
