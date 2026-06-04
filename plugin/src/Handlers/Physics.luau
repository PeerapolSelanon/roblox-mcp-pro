--!strict
-- Handler for manage_physics: physical properties and simple welds.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Serialize = require(script.Parent.Parent.Serialize)

return function(args: any): any
	local action = args.action or "set"
	local recording = ChangeHistoryService:TryBeginRecording("MCP manage_physics")
	local result: any

	if action == "set" then
		local inst = args.path and Serialize.resolve(args.path) or nil
		if not inst or not inst:IsA("BasePart") then
			result = { ok = false, error = "BasePart not found at: " .. tostring(args.path) }
		else
			local part = inst :: BasePart
			local err = Serialize.applyProperties(part, args.properties)
			-- Optional custom physical properties.
			local pp = args.physical_properties
			if not err and type(pp) == "table" then
				local okPP = pcall(function()
					part.CustomPhysicalProperties = PhysicalProperties.new(
						pp.density or 0.7,
						pp.friction or 0.3,
						pp.elasticity or 0.5,
						pp.frictionWeight or 1,
						pp.elasticityWeight or 1
					)
				end)
				if not okPP then
					err = "failed to set CustomPhysicalProperties"
				end
			end
			result = { ok = err == nil, path = Serialize.path(part), error = err }
		end
	elseif action == "weld" then
		local a = args.part0 and Serialize.resolve(args.part0) or nil
		local b = args.part1 and Serialize.resolve(args.part1) or nil
		if not a or not a:IsA("BasePart") or not b or not b:IsA("BasePart") then
			result = { ok = false, error = "part0 and part1 must both be BaseParts" }
		else
			local weld = Instance.new("WeldConstraint")
			weld.Part0 = a :: BasePart
			weld.Part1 = b :: BasePart
			weld.Parent = a
			result = { ok = true, path = Serialize.path(weld) }
		end
	else
		result = { ok = false, error = "unknown manage_physics action: " .. tostring(action) }
	end

	if recording then
		ChangeHistoryService:FinishRecording(
			recording,
			result.ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
		)
	end
	return result
end
