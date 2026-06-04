--!strict
-- Handler for manage_animation: manage Animation instances and best-effort preview.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Serialize = require(script.Parent.Parent.Serialize)

return function(args: any): any
	local action = args.action or "create"

	if action == "create" then
		local recording = ChangeHistoryService:TryBeginRecording("MCP manage_animation create")
		local parent = Serialize.resolve(args.parent or "ReplicatedStorage")
		if not parent then
			return { ok = false, error = "parent not found: " .. tostring(args.parent) }
		end
		local anim = Instance.new("Animation")
		if args.name then
			anim.Name = args.name
		end
		if args.animation_id then
			anim.AnimationId = tostring(args.animation_id)
		end
		local err = Serialize.applyProperties(anim, args.properties)
		anim.Parent = parent
		if recording then
			ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
		end
		return { ok = err == nil, path = Serialize.path(anim), error = err }
	elseif action == "set" then
		local inst = args.path and Serialize.resolve(args.path) or nil
		if not inst then
			return { ok = false, error = "path not found: " .. tostring(args.path) }
		end
		local err = Serialize.applyProperties(inst, args.properties)
		return { ok = err == nil, path = Serialize.path(inst), error = err }
	elseif action == "play" then
		-- Best effort: load+play on a Humanoid/AnimationController's Animator.
		local target = args.target_path and Serialize.resolve(args.target_path) or nil
		if not target then
			return { ok = false, error = "target_path (a Humanoid or model) not found" }
		end
		local animator = target:FindFirstChildWhichIsA("Animator", true)
		if not animator then
			local humanoid = target:FindFirstChildWhichIsA("Humanoid")
			if humanoid then
				animator = humanoid:FindFirstChildWhichIsA("Animator")
			end
		end
		if not animator then
			return { ok = false, error = "no Animator found under target; play requires a rig with a Humanoid/Animator" }
		end
		local anim = Instance.new("Animation")
		anim.AnimationId = tostring(args.animation_id or "")
		local ok, track = pcall(function()
			return (animator :: Animator):LoadAnimation(anim)
		end)
		if not ok or not track then
			return { ok = false, error = "failed to load animation (check AnimationId): " .. tostring(track) }
		end
		track:Play()
		return {
			ok = true,
			note = "Playing. Visible preview of programmatic playback may require Play mode.",
			length = track.Length,
		}
	else
		return { ok = false, error = "unknown manage_animation action: " .. tostring(action) }
	end
end
