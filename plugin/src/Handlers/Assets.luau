--!strict
-- Handler for manage_assets: insert marketplace assets by id.

local InsertService = game:GetService("InsertService")
local MarketplaceService = game:GetService("MarketplaceService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Serialize = require(script.Parent.Parent.Serialize)

return function(args: any): any
	local action = args.action or "insert"

	if action == "insert" then
		local assetId = tonumber(args.asset_id)
		if not assetId then
			return { ok = false, error = "asset_id (a number) is required" }
		end
		local parent = Serialize.resolve(args.parent or "Workspace") or workspace
		local recording = ChangeHistoryService:TryBeginRecording("MCP manage_assets insert")
		local ok, model = pcall(function()
			return InsertService:LoadAsset(assetId)
		end)
		if not ok or not model then
			if recording then
				ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Cancel)
			end
			return { ok = false, error = "LoadAsset failed (check id/permissions): " .. tostring(model) }
		end
		local inserted = {}
		for _, child in model:GetChildren() do
			child.Parent = parent
			table.insert(inserted, Serialize.path(child))
		end
		model:Destroy()
		if recording then
			ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
		end
		return { ok = true, inserted = inserted }
	elseif action == "info" then
		local assetId = tonumber(args.asset_id)
		if not assetId then
			return { ok = false, error = "asset_id (a number) is required" }
		end
		local ok, info = pcall(function()
			return MarketplaceService:GetProductInfo(assetId)
		end)
		if not ok then
			return { ok = false, error = "GetProductInfo failed: " .. tostring(info) }
		end
		return { ok = true, info = { name = info.Name, description = info.Description, creator = info.Creator and info.Creator.Name } }
	else
		return { ok = false, error = "unknown manage_assets action: " .. tostring(action) }
	end
end
