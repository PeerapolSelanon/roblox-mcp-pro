--!strict
-- Handler for manage_animation: manage Animation instances and best-effort preview.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Serialize = require(script.Parent.Parent.Serialize)

-- The instance an Animator must live under (Humanoid or AnimationController),
-- whether that's the target itself or a descendant.
local function findAnimatorHost(target: Instance): Instance?
	if target:IsA("Humanoid") or target:IsA("AnimationController") then
		return target
	end
	return target:FindFirstChildWhichIsA("Humanoid", true)
		or target:FindFirstChildWhichIsA("AnimationController", true)
end

-- Find a rig's Animator, creating one under its Humanoid/AnimationController if
-- missing — in edit mode rigs often have the controller but no Animator yet.
local function findOrCreateAnimator(target: Instance): Animator?
	local existing = target:FindFirstChildWhichIsA("Animator", true)
	if existing then
		return existing :: Animator
	end
	local host = findAnimatorHost(target)
	if not host then
		return nil
	end
	local animator = Instance.new("Animator")
	animator.Parent = host
	return animator
end

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
		local animator = findOrCreateAnimator(target)
		if not animator then
			return { ok = false, error = "no Humanoid or AnimationController under target to host an Animator; play requires a rig" }
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
	elseif action == "stop" then
		local target = args.target_path and Serialize.resolve(args.target_path) or nil
		if not target then
			return { ok = false, error = "target_path not found" }
		end
		local animator = target:FindFirstChildWhichIsA("Animator", true)
		if not animator then
			return { ok = false, error = "no Animator under target" }
		end
		local stopped = 0
		for _, track in (animator :: Animator):GetPlayingAnimationTracks() do
			track:Stop()
			stopped += 1
		end
		return { ok = true, stopped = stopped }
	elseif action == "get_tracks" then
		-- List the AnimationTracks currently playing on a rig's Animator.
		local target = args.target_path and Serialize.resolve(args.target_path) or nil
		if not target then
			return { ok = false, error = "target_path (a Humanoid or model with an Animator) not found" }
		end
		local animator = target:FindFirstChildWhichIsA("Animator", true)
		if not animator then
			return {
				ok = true,
				count = 0,
				tracks = {},
				note = "no Animator under target — playing tracks exist only during a playtest, "
					.. "and the Animator is usually created at runtime. Use manage_studio 'play' to inspect live animation.",
			}
		end
		local tracks = {}
		for _, track in (animator :: Animator):GetPlayingAnimationTracks() do
			table.insert(tracks, {
				name = track.Name,
				animationId = track.Animation and track.Animation.AnimationId or nil,
				isPlaying = track.IsPlaying,
				length = track.Length,
				speed = track.Speed,
				weight = track.WeightCurrent,
				priority = track.Priority.Name,
				looped = track.Looped,
			})
		end
		return { ok = true, count = #tracks, tracks = tracks }
	else
		return { ok = false, error = "unknown manage_animation action: " .. tostring(action) }
	end
end
