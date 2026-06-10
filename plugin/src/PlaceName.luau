--!strict
-- Resolve the current place's display name accurately.
--
-- `game.Name` alone is unreliable: for a locally saved file it is the file
-- name including its extension ("MyGame.rbxl"), for an unsaved place it is a
-- placeholder ("Untitled Game"), and for a published place it is the name at
-- the time the file was last saved — stale if the place was renamed on the
-- website since. For published places, prefer the live marketplace name
-- (cached per PlaceId so the dashboard's periodic system_info probes don't
-- hit the web API every few seconds).

local MarketplaceService = game:GetService("MarketplaceService")

local cachedPlaceId: number? = nil
local cachedName: string? = nil

return function(): string?
	local name: string? = nil
	pcall(function()
		name = game.Name
	end)
	if name then
		-- Strip a local-file extension ("MyGame.rbxl" / "MyGame.rbxlx").
		name = (name:gsub("%.rbxlx?$", ""))
	end

	local placeId = game.PlaceId
	if placeId > 0 then
		if cachedPlaceId == placeId and cachedName then
			return cachedName
		end
		local ok, info = pcall(function()
			return MarketplaceService:GetProductInfo(placeId)
		end)
		if ok and info and type(info.Name) == "string" and #info.Name > 0 then
			cachedPlaceId = placeId
			cachedName = info.Name
			return cachedName
		end
	end
	return name
end
