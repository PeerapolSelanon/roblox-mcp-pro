--!strict
-- Handler for spatial_query: spatial searches over Workspace.

local Workspace = game:GetService("Workspace")
local Serialize = require(script.Parent.Parent.Serialize)

local function toVector3(t: any, default: Vector3?): Vector3
	if type(t) == "table" then
		return Vector3.new(t.x or t[1] or 0, t.y or t[2] or 0, t.z or t[3] or 0)
	end
	return default or Vector3.zero
end

local function serializePart(part: BasePart): any
	return {
		path = Serialize.path(part),
		name = part.Name,
		className = part.ClassName,
		position = Serialize.value(part.Position),
		size = Serialize.value(part.Size),
	}
end

return function(args: any): any
	local query = args.query or "in_radius"
	local limit = args.limit or 100

	if query == "in_box" then
		local cf = CFrame.new(toVector3(args.center))
		local size = toVector3(args.size, Vector3.new(10, 10, 10))
		local parts = Workspace:GetPartBoundsInBox(cf, size)
		local out = {}
		for i, p in parts do
			if i > limit then
				break
			end
			table.insert(out, serializePart(p))
		end
		return { query = query, count = #out, parts = out }
	elseif query == "in_radius" then
		local center = toVector3(args.center)
		local radius = args.radius or 10
		local parts = Workspace:GetPartBoundsInRadius(center, radius)
		local out = {}
		for i, p in parts do
			if i > limit then
				break
			end
			table.insert(out, serializePart(p))
		end
		return { query = query, count = #out, parts = out }
	elseif query == "raycast" then
		local origin = toVector3(args.origin)
		local direction = toVector3(args.direction, Vector3.new(0, -100, 0))
		local result = Workspace:Raycast(origin, direction)
		if not result then
			return { query = query, hit = false }
		end
		return {
			query = query,
			hit = true,
			instance = Serialize.path(result.Instance),
			position = Serialize.value(result.Position),
			normal = Serialize.value(result.Normal),
			distance = result.Distance,
			material = result.Material.Name,
		}
	elseif query == "nearest" then
		local point = toVector3(args.point)
		local className = args.class_name
		local maxDistance = args.max_distance or math.huge
		local best: BasePart? = nil
		local bestDist = maxDistance
		for _, inst in Workspace:GetDescendants() do
			if inst:IsA("BasePart") and (not className or inst.ClassName == className) then
				local dist = (inst.Position - point).Magnitude
				if dist < bestDist then
					bestDist = dist
					best = inst
				end
			end
		end
		if not best then
			return { query = query, found = false }
		end
		return {
			query = query,
			found = true,
			instance = Serialize.path(best),
			distance = bestDist,
			position = Serialize.value(best.Position),
		}
	else
		error("unknown spatial query: " .. tostring(query))
	end
end
