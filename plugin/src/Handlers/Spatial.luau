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
	elseif query == "find_ground" then
		-- Drop a ray straight down to find the walkable surface under a point —
		-- the agent gets the exact Y to place objects on, no trial and error.
		local point = toVector3(args.point or args.center)
		local fromHeight = args.from_height or math.max(point.Y, 500)
		local origin = Vector3.new(point.X, fromHeight, point.Z)
		local result = Workspace:Raycast(origin, Vector3.new(0, -(fromHeight + 500), 0))
		if not result then
			return { query = query, found = false }
		end
		return {
			query = query,
			found = true,
			groundY = result.Position.Y,
			position = Serialize.value(result.Position),
			normal = Serialize.value(result.Normal),
			material = result.Material.Name,
			instance = Serialize.path(result.Instance),
		}
	elseif query == "check_placement" then
		-- Would a box at center/size overlap existing geometry? Lists blockers
		-- so the agent can pick a clear spot before creating anything.
		local cf = CFrame.new(toVector3(args.center))
		local size = toVector3(args.size, Vector3.new(4, 4, 4))
		local parts = Workspace:GetPartBoundsInBox(cf, size)
		local blocking = {}
		for i, p in parts do
			if i > limit then
				break
			end
			if p.CanCollide then
				table.insert(blocking, serializePart(p))
			end
		end
		return { query = query, clear = #blocking == 0, count = #blocking, blocking = blocking }
	elseif query == "bounds" then
		local inst = args.path and Serialize.resolve(args.path) or nil
		if not inst then
			return { query = query, ok = false, error = "path not found: " .. tostring(args.path) }
		end
		local cf: CFrame, size: Vector3
		if inst:IsA("Model") then
			cf, size = inst:GetBoundingBox()
		elseif inst:IsA("BasePart") then
			cf, size = inst.CFrame, inst.Size
		else
			return { query = query, ok = false, error = "bounds needs a Model or BasePart" }
		end
		local half = size / 2
		return {
			query = query,
			ok = true,
			center = Serialize.value(cf.Position),
			size = Serialize.value(size),
			min = Serialize.value(cf.Position - half),
			max = Serialize.value(cf.Position + half),
		}
	elseif query == "find_flat" or query == "analyze_walkable" then
		-- Grid-raycast a region: heights + surface normals per cell, then
		-- either pick flat build spots or summarize how walkable the area is.
		local center = toVector3(args.center)
		local size = toVector3(args.size, Vector3.new(64, 0, 64))
		local step = math.max(2, args.step or 8)
		local halfX, halfZ = size.X / 2, size.Z / 2
		local cols = math.min(50, math.floor(size.X / step) + 1)
		local rows = math.min(50, math.floor(size.Z / step) + 1)
		local samples: { { x: number, z: number, y: number?, normalY: number? } } = {}
		for ix = 0, cols - 1 do
			for iz = 0, rows - 1 do
				local x = center.X - halfX + ix * step
				local z = center.Z - halfZ + iz * step
				local hit = Workspace:Raycast(Vector3.new(x, center.Y + 500, z), Vector3.new(0, -1000, 0))
				table.insert(samples, {
					x = x,
					z = z,
					y = hit and hit.Position.Y or nil,
					normalY = hit and hit.Normal.Y or nil,
				})
			end
		end

		if query == "analyze_walkable" then
			local maxSlope = math.rad(args.max_slope or 45)
			local minNormalY = math.cos(maxSlope)
			local walkable, blocked, noGround = 0, 0, 0
			for _, s in samples do
				if s.y == nil then
					noGround += 1
				elseif (s.normalY or 0) >= minNormalY then
					walkable += 1
				else
					blocked += 1
				end
			end
			local total = #samples
			return {
				query = query,
				sampled = total,
				walkable = walkable,
				tooSteep = blocked,
				noGround = noGround,
				walkableRatio = total > 0 and walkable / total or 0,
			}
		end

		-- find_flat: a cell is flat when its height is close to its neighbors'.
		local tolerance = args.tolerance or 1
		local function heightAt(ix: number, iz: number): number?
			local s = samples[ix * rows + iz + 1]
			return s and s.y or nil
		end
		local flats = {}
		for ix = 1, cols - 2 do
			for iz = 1, rows - 2 do
				local h = heightAt(ix, iz)
				if h then
					local flat = true
					for dx = -1, 1 do
						for dz = -1, 1 do
							local n = heightAt(ix + dx, iz + dz)
							if n == nil or math.abs(n - h) > tolerance then
								flat = false
								break
							end
						end
						if not flat then
							break
						end
					end
					if flat and #flats < (args.limit or 20) then
						local s = samples[ix * rows + iz + 1]
						table.insert(flats, { position = { s.x, h, s.z } })
					end
				end
			end
		end
		return { query = query, sampled = #samples, found = #flats, spots = flats, step = step, tolerance = tolerance }
	elseif query == "spatial_map" then
		-- Coarse density map: how many parts overlap each grid cell. Cheap way
		-- to see where a map is busy vs empty before deciding where to build.
		local center = toVector3(args.center)
		local size = toVector3(args.size, Vector3.new(128, 64, 128))
		local cell = math.max(4, args.cell or 16)
		local cols = math.min(32, math.max(1, math.floor(size.X / cell)))
		local rows = math.min(32, math.max(1, math.floor(size.Z / cell)))
		local grid = {}
		for iz = 0, rows - 1 do
			local row = {}
			for ix = 0, cols - 1 do
				local cx = center.X - size.X / 2 + (ix + 0.5) * cell
				local cz = center.Z - size.Z / 2 + (iz + 0.5) * cell
				local parts = Workspace:GetPartBoundsInBox(
					CFrame.new(cx, center.Y, cz),
					Vector3.new(cell, size.Y, cell)
				)
				table.insert(row, #parts)
			end
			table.insert(grid, row)
		end
		return { query = query, cols = cols, rows = rows, cell = cell, origin = { center.X - size.X / 2, center.Y, center.Z - size.Z / 2 }, grid = grid }
	else
		error("unknown spatial query: " .. tostring(query))
	end
end
