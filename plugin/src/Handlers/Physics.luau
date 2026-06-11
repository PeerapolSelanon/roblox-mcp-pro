--!strict
-- Handler for manage_physics: physical properties, welds, and collision groups.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local PhysicsService = game:GetService("PhysicsService")
local Serialize = require(script.Parent.Parent.Serialize)

-- Collision-group reads don't mutate, so answer them before opening a recording.
local function handleGroups(action: string, args: any): any?
	if action == "get_groups" then
		local groups = {}
		for _, g in PhysicsService:GetRegisteredCollisionGroups() do
			table.insert(groups, g.name)
		end
		-- Report the current pairwise collidability matrix too.
		local matrix = {}
		for _, a in groups do
			for _, b in groups do
				if a <= b then
					table.insert(matrix, {
						a = a,
						b = b,
						collidable = PhysicsService:CollisionGroupsAreCollidable(a, b),
					})
				end
			end
		end
		return { ok = true, groups = groups, matrix = matrix }
	elseif action == "register_group" then
		local name = args.group
		if type(name) ~= "string" or name == "" then
			return { ok = false, error = "register_group requires group (name)" }
		end
		if PhysicsService:IsCollisionGroupRegistered(name) then
			return { ok = true, group = name, note = "already registered" }
		end
		local ok, err = pcall(function()
			PhysicsService:RegisterCollisionGroup(name)
		end)
		return { ok = ok, group = name, error = if ok then nil else tostring(err) }
	elseif action == "set_collidable" then
		local a, b = args.group, args.other_group
		if type(a) ~= "string" or type(b) ~= "string" then
			return { ok = false, error = "set_collidable requires group and other_group" }
		end
		local collidable = args.collidable
		if collidable == nil then
			collidable = true
		end
		local ok, err = pcall(function()
			PhysicsService:CollisionGroupSetCollidable(a, b, collidable == true)
		end)
		return { ok = ok, group = a, other_group = b, collidable = collidable == true, error = if ok then nil else tostring(err) }
	end
	return nil
end

return function(args: any): any
	local action = args.action or "set"

	-- Collision-group reads short-circuit (no undo waypoint needed).
	if action == "get_groups" then
		return handleGroups(action, args)
	end

	local recording = ChangeHistoryService:TryBeginRecording("MCP manage_physics")
	local result: any

	local groupResult = handleGroups(action, args)
	if groupResult ~= nil then
		result = groupResult
	elseif action == "assign_group" then
		-- Put a part (and optionally its descendants) into a collision group.
		local inst = args.path and Serialize.resolve(args.path) or nil
		if not inst then
			result = { ok = false, error = "path not found: " .. tostring(args.path) }
		elseif type(args.group) ~= "string" then
			result = { ok = false, error = "assign_group requires group" }
		elseif not PhysicsService:IsCollisionGroupRegistered(args.group) then
			result = { ok = false, error = "collision group not registered: " .. tostring(args.group) }
		else
			local count = 0
			local targets = { inst }
			if args.recursive == true then
				targets = inst:GetDescendants()
				table.insert(targets, inst)
			end
			for _, t in targets do
				if t:IsA("BasePart") then
					(t :: BasePart).CollisionGroup = args.group
					count += 1
				end
			end
			result = { ok = count > 0, path = Serialize.path(inst), group = args.group, assigned = count }
		end
	elseif action == "set" then
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
