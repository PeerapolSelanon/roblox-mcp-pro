--!strict
-- Handler for workspace_state: a high-level read-only snapshot of the session,
-- plus 'changes' — a tree diff against the previous baseline so the agent can
-- see what was added/removed (by itself or the user) without re-querying.

local Workspace = game:GetService("Workspace")
local Selection = game:GetService("Selection")
local RunService = game:GetService("RunService")
local Serialize = require(script.Parent.Parent.Serialize)
local resolvePlaceName = require(script.Parent.Parent.PlaceName)

local SUMMARY_SERVICES = {
	"Workspace", "ServerScriptService", "ServerStorage", "ReplicatedStorage",
	"ReplicatedFirst", "StarterGui", "StarterPack", "StarterPlayer", "Lighting",
}

-- Diffing more instances than this gets noisy and slow; truncate and say so.
local MAX_TRACKED = 50_000
local MAX_REPORTED = 200

-- Baseline lives for the plugin session: path -> className.
local baseline: { [string]: string }? = nil

local function captureTree(): ({ [string]: string }, boolean)
	local map: { [string]: string } = {}
	local count = 0
	local truncated = false
	for _, name in SUMMARY_SERVICES do
		local ok, svc = pcall(function()
			return game:GetService(name :: any)
		end)
		if ok and svc then
			for _, inst in svc:GetDescendants() do
				count += 1
				if count > MAX_TRACKED then
					truncated = true
					break
				end
				map[Serialize.path(inst)] = inst.ClassName
			end
		end
		if truncated then
			break
		end
	end
	return map, truncated
end

local function snapshot(): any
	local services = {}
	for _, name in SUMMARY_SERVICES do
		local ok, svc = pcall(function()
			return game:GetService(name :: any)
		end)
		if ok and svc then
			services[name] = #svc:GetChildren()
		end
	end

	local camera = Workspace.CurrentCamera
	return {
		ok = true,
		placeId = game.PlaceId,
		placeName = resolvePlaceName(),
		isRunning = RunService:IsRunning(),
		gravity = Workspace.Gravity,
		childCounts = services,
		selectionCount = #Selection:Get(),
		camera = camera and {
			position = Serialize.value(camera.CFrame.Position),
			fieldOfView = camera.FieldOfView,
		} or nil,
	}
end

-- What the Studio camera is currently looking at: pose + the part under the
-- center of the view + parts roughly in front of the camera.
local function viewport(): any
	local camera = Workspace.CurrentCamera
	if not camera then
		return { ok = false, error = "no CurrentCamera" }
	end
	local cf = camera.CFrame
	local lookAt: any = nil
	local hit = Workspace:Raycast(cf.Position, cf.LookVector * 2000)
	if hit then
		lookAt = {
			instance = Serialize.path(hit.Instance),
			position = Serialize.value(hit.Position),
			distance = hit.Distance,
		}
	end
	-- Parts in a box centred ~50 studs ahead of the camera (cheap "on screen").
	local ahead = cf.Position + cf.LookVector * 50
	local inFront = {}
	for i, p in Workspace:GetPartBoundsInBox(CFrame.new(ahead), Vector3.new(120, 120, 120)) do
		if i > 50 then
			break
		end
		table.insert(inFront, Serialize.path(p))
	end
	return {
		ok = true,
		position = Serialize.value(cf.Position),
		lookVector = Serialize.value(cf.LookVector),
		fieldOfView = camera.FieldOfView,
		viewportSize = { camera.ViewportSize.X, camera.ViewportSize.Y },
		focus = lookAt,
		partsInView = inFront,
	}
end

return function(args: any): any
	local action = (args and args.action) or "snapshot"

	if action == "snapshot" then
		return snapshot()
	elseif action == "viewport" then
		return viewport()
	elseif action == "changes" then
		local current, truncated = captureTree()
		if baseline == nil then
			baseline = current
			return {
				ok = true,
				baselineCreated = true,
				tracked = 0,
				truncated = truncated,
				note = "Baseline captured — call 'changes' again later to see what was added/removed.",
			}
		end
		local added: { any } = {}
		local removed: { string } = {}
		local addedTotal, removedTotal = 0, 0
		for path, className in current do
			if (baseline :: { [string]: string })[path] == nil then
				addedTotal += 1
				if addedTotal <= MAX_REPORTED then
					table.insert(added, { path = path, className = className })
				end
			end
		end
		for path in baseline :: { [string]: string } do
			if current[path] == nil then
				removedTotal += 1
				if removedTotal <= MAX_REPORTED then
					table.insert(removed, path)
				end
			end
		end
		baseline = current
		return {
			ok = true,
			addedTotal = addedTotal,
			removedTotal = removedTotal,
			added = added,
			removed = removed,
			truncated = truncated,
			note = "Renames/moves appear as remove+add. Property and script-source changes are not tracked.",
		}
	else
		return { ok = false, error = "unknown workspace_state action: " .. tostring(action) }
	end
end
