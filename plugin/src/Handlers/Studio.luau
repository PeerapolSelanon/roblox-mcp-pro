--!strict
-- Handler for manage_studio: read Studio environment info and theme.

local RunService = game:GetService("RunService")

return function(args: any): any
	local action = args.action or "info"

	if action == "info" then
		local themeName: string? = nil
		pcall(function()
			themeName = settings().Studio.Theme.Name
		end)
		return {
			ok = true,
			studioVersion = version(),
			theme = themeName,
			isRunning = RunService:IsRunning(),
			isEdit = RunService:IsEdit(),
			placeId = game.PlaceId,
			gameId = game.GameId,
		}
	else
		return { ok = false, error = "unknown manage_studio action: " .. tostring(action) }
	end
end
