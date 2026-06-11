--!strict
-- Handler for manage_effects: create/configure post-processing & atmosphere
-- effects (BloomEffect, BlurEffect, ColorCorrectionEffect, DepthOfFieldEffect,
-- SunRaysEffect, Atmosphere, Sky) under Lighting by default — plus particle
-- effects (ParticleEmitter, Beam, Trail): emit a burst or toggle them on/off.

local Lighting = game:GetService("Lighting")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Serialize = require(script.Parent.Parent.Serialize)

local EMITTER_CLASSES = { ParticleEmitter = true, Beam = true, Trail = true, Fire = true, Smoke = true, Sparkles = true }

return function(args: any): any
	local action = args.action or "create"

	-- 'emit' fires a one-off particle burst; it has no persistent effect so it
	-- shouldn't create an undo step.
	if action == "emit" then
		local inst = args.path and Serialize.resolve(args.path) or nil
		if not inst or not inst:IsA("ParticleEmitter") then
			return { ok = false, error = "emit needs a ParticleEmitter path; got: " .. tostring(args.path) }
		end
		local count = math.clamp(tonumber(args.count) or 20, 1, 1000)
		;(inst :: ParticleEmitter):Emit(count)
		return { ok = true, path = Serialize.path(inst), emitted = count }
	end

	local recording = ChangeHistoryService:TryBeginRecording("MCP manage_effects")
	local result: any

	if action == "toggle" then
		local inst = args.path and Serialize.resolve(args.path) or nil
		if not inst or not EMITTER_CLASSES[inst.ClassName] then
			result = { ok = false, error = "toggle needs a ParticleEmitter/Beam/Trail/Fire/Smoke/Sparkles path" }
		else
			local enabled = args.enabled
			if enabled == nil then
				enabled = not (inst :: any).Enabled
			end
			;(inst :: any).Enabled = enabled == true
			result = { ok = true, path = Serialize.path(inst), enabled = enabled == true }
		end
	elseif action == "create" then
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
