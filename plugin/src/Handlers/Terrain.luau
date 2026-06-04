--!strict
-- Handler for manage_terrain: generate and edit Workspace.Terrain.

local Workspace = game:GetService("Workspace")
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local function toVector3(t: any, default: Vector3?): Vector3
	if type(t) == "table" then
		return Vector3.new(t.x or t[1] or 0, t.y or t[2] or 0, t.z or t[3] or 0)
	end
	return default or Vector3.zero
end

local function material(name: any): Enum.Material
	if type(name) == "string" then
		for _, m in Enum.Material:GetEnumItems() do
			if m.Name == name then
				return m
			end
		end
	end
	return Enum.Material.Grass
end

return function(args: any): any
	local terrain = Workspace.Terrain
	local action = args.action or "fill_block"
	local recording = ChangeHistoryService:TryBeginRecording("MCP manage_terrain")

	local result: any
	if action == "fill_block" then
		local cf = CFrame.new(toVector3(args.position))
		local size = toVector3(args.size, Vector3.new(16, 16, 16))
		terrain:FillBlock(cf, size, material(args.material))
		result = { ok = true, action = action }
	elseif action == "fill_ball" then
		terrain:FillBall(toVector3(args.center), args.radius or 8, material(args.material))
		result = { ok = true, action = action }
	elseif action == "fill_region" then
		local min = toVector3(args.min)
		local max = toVector3(args.max)
		local region = Region3.new(min, max):ExpandToGrid(4)
		terrain:FillRegion(region, 4, material(args.material))
		result = { ok = true, action = action }
	elseif action == "clear" then
		terrain:Clear()
		result = { ok = true, action = action }
	else
		result = { ok = false, action = action, error = "unknown terrain action" }
	end

	if recording then
		ChangeHistoryService:FinishRecording(
			recording,
			result.ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
		)
	end
	return result
end
