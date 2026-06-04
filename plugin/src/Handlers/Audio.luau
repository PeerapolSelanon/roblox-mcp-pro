--!strict
-- Handler for manage_audio: create, configure, and preview Sound instances.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Serialize = require(script.Parent.Parent.Serialize)

return function(args: any): any
	local action = args.action or "create"

	if action == "create" then
		local recording = ChangeHistoryService:TryBeginRecording("MCP manage_audio create")
		local parent = Serialize.resolve(args.parent or "Workspace")
		if not parent then
			return { ok = false, error = "parent not found: " .. tostring(args.parent) }
		end
		local sound = Instance.new("Sound")
		if args.name then
			sound.Name = args.name
		end
		local err = Serialize.applyProperties(sound, args.properties)
		sound.Parent = parent
		if recording then
			ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
		end
		return { ok = err == nil, path = Serialize.path(sound), error = err }
	end

	-- Remaining actions operate on an existing Sound.
	local inst = args.path and Serialize.resolve(args.path) or nil
	if not inst or not inst:IsA("Sound") then
		return { ok = false, error = "Sound not found at: " .. tostring(args.path) }
	end
	local sound = inst :: Sound

	if action == "set" then
		local err = Serialize.applyProperties(sound, args.properties)
		return { ok = err == nil, path = Serialize.path(sound), error = err }
	elseif action == "play" then
		sound:Play()
		return { ok = true, path = Serialize.path(sound), isPlaying = sound.IsPlaying }
	elseif action == "stop" then
		sound:Stop()
		return { ok = true, path = Serialize.path(sound) }
	elseif action == "pause" then
		sound:Pause()
		return { ok = true, path = Serialize.path(sound) }
	elseif action == "resume" then
		sound:Resume()
		return { ok = true, path = Serialize.path(sound) }
	else
		return { ok = false, error = "unknown manage_audio action: " .. tostring(action) }
	end
end
