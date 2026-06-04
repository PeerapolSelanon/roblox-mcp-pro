--!strict
-- Handler for manage_effects: create/configure post-processing & atmosphere
-- effects (BloomEffect, BlurEffect, ColorCorrectionEffect, DepthOfFieldEffect,
-- SunRaysEffect, Atmosphere, Sky) under Lighting by default.

local Lighting = game:GetService("Lighting")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Serialize = require(script.Parent.Parent.Serialize)

return function(args: any): any
	local action = args.action or "create"
	local recording = ChangeHistoryService:TryBeginRecording("MCP manage_effects")
	local result: any

	if action == "create" then
		local parent = Serialize.resolve(args.parent or "Lighting") or Lighting
		local okNew, inst = pcall(function()
			return Instance.new(args.effect_type)
		end)
		if not okNew or not inst then
			result = { ok = false, error = "invalid effect_type: " .. tostring(args.effect_type) }
		else
			if args.name then
				inst.Name = args.name
			end
			local err = Serialize.applyProperties(inst, args.properties)
			inst.Parent = parent
			result = { ok = err == nil, path = Serialize.path(inst), error = err }
		end
	elseif action == "set" then
		local inst = args.path and Serialize.resolve(args.path) or nil
		if not inst then
			result = { ok = false, error = "path not found: " .. tostring(args.path) }
		else
			local err = Serialize.applyProperties(inst, args.properties)
			result = { ok = err == nil, path = Serialize.path(inst), error = err }
		end
	elseif action == "delete" then
		local inst = args.path and Serialize.resolve(args.path) or nil
		if not inst then
			result = { ok = false, error = "path not found: " .. tostring(args.path) }
		else
			inst:Destroy()
			result = { ok = true }
		end
	else
		result = { ok = false, error = "unknown manage_effects action: " .. tostring(action) }
	end

	if recording then
		ChangeHistoryService:FinishRecording(
			recording,
			result.ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
		)
	end
	return result
end
