--!strict
-- Handler for manage_terrain: generate and edit Workspace.Terrain.

local Workspace = game:GetService("Workspace")
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local function toVector3(t: any, default: Vector3?): Vector3
	if type(t) == "table" then
		return Vector3.new(t.x or t[1] or 0, t.y or t[2] or 0, t.z or t[3] or 0)
	end
	return default or Vector3.zero
end

local function material(name: any): Enum.Material
	if type(name) == "string" then
		for _, m in Enum.Material:GetEnumItems() do
			if m.Name == name then
				return m
			end
		end
	end
	return Enum.Material.Grass
end

return function(args: any): any
	local terrain = Workspace.Terrain
	local action = args.action or "fill_block"
	local recording = ChangeHistoryService:TryBeginRecording("MCP manage_terrain")

	local result: any
	if action == "fill_block" then
		local cf = CFrame.new(toVector3(args.position))
		local size = toVector3(args.size, Vector3.new(16, 16, 16))
		terrain:FillBlock(cf, size, material(args.material))
		result = { ok = true, action = action }
	elseif action == "fill_ball" then
		terrain:FillBall(toVector3(args.center), args.radius or 8, material(args.material))
		result = { ok = true, action = action }
	elseif action == "fill_region" then
		local min = toVector3(args.min)
		local max = toVector3(args.max)
		local region = Region3.new(min, max):ExpandToGrid(4)
		terrain:FillRegion(region, 4, material(args.material))
		result = { ok = true, action = action }
	elseif action == "fill_cylinder" then
		local cf = CFrame.new(toVector3(args.position or args.center))
		terrain:FillCylinder(cf, args.height or 8, args.radius or 8, material(args.material))
		result = { ok = true, action = action }
	elseif action == "fill_wedge" then
		local cf = CFrame.new(toVector3(args.position))
		if type(args.rotation) == "table" then
			local rot = toVector3(args.rotation)
			cf = cf * CFrame.Angles(math.rad(rot.X), math.rad(rot.Y), math.rad(rot.Z))
		end
		terrain:FillWedge(cf, toVector3(args.size, Vector3.new(16, 16, 16)), material(args.material))
		result = { ok = true, action = action }
	elseif action == "replace_material" then
		local min = toVector3(args.min)
		local max = toVector3(args.max)
		local region = Region3.new(min, max):ExpandToGrid(4)
		terrain:ReplaceMaterial(region, 4, material(args.from_material), material(args.material))
		result = { ok = true, action = action }
	elseif action == "smooth" then
		-- Box-blur the occupancy grid in a region: read voxels, average each
		-- cell with its 6 neighbours, write back. Softens blocky fill edges.
		local min = toVector3(args.min)
		local max = toVector3(args.max)
		local span = max - min
		if span.X > 128 or span.Y > 128 or span.Z > 128 then
			result = { ok = false, action = action, error = "smooth region too large (max 128 studs per axis)" }
		else
			local region = Region3.new(min, max):ExpandToGrid(4)
			local materials, occupancy = terrain:ReadVoxels(region, 4)
			local sx, sy, sz = #occupancy, #occupancy[1], #occupancy[1][1]
			local strength = math.clamp(args.strength or 0.5, 0, 1)
			local out = {}
			for x = 1, sx do
				out[x] = {}
				for y = 1, sy do
					out[x][y] = {}
					for z = 1, sz do
						local sum, n = occupancy[x][y][z], 1
						for _, d in { { 1, 0, 0 }, { -1, 0, 0 }, { 0, 1, 0 }, { 0, -1, 0 }, { 0, 0, 1 }, { 0, 0, -1 } } do
							local nx, ny, nz = x + d[1], y + d[2], z + d[3]
							if nx >= 1 and nx <= sx and ny >= 1 and ny <= sy and nz >= 1 and nz <= sz then
								sum += occupancy[nx][ny][nz]
								n += 1
							end
						end
						local blurred = sum / n
						local mixed = occupancy[x][y][z] + (blurred - occupancy[x][y][z]) * strength
						out[x][y][z] = mixed
						-- Newly-solid cells need a material; borrow Ground.
						if mixed > 0 and materials[x][y][z] == Enum.Material.Air then
							materials[x][y][z] = material(args.material or "Ground")
						end
					end
				end
			end
			terrain:WriteVoxels(region, 4, materials, out)
			result = { ok = true, action = action }
		end
	elseif action == "generate" then
		-- Procedural heightmap terrain from layered Perlin noise: column fills
		-- across position+size, height varying by amplitude/scale around base Y.
		local center = toVector3(args.position)
		local size = toVector3(args.size, Vector3.new(128, 0, 128))
		if size.X > 512 or size.Z > 512 then
			result = { ok = false, action = action, error = "generate area too large (max 512 studs per axis)" }
		else
			local amplitude = args.amplitude or 16
			local scale = args.noise_scale or 64
			local seed = args.seed or 0
			local mat = material(args.material)
			local cellSize = 4
			for x = -size.X / 2, size.X / 2 - cellSize, cellSize do
				for z = -size.Z / 2, size.Z / 2 - cellSize, cellSize do
					local wx, wz = center.X + x, center.Z + z
					local noise = math.noise(wx / scale, wz / scale, seed)
						+ 0.5 * math.noise(wx / (scale / 2), wz / (scale / 2), seed + 100)
					local height = math.max(cellSize, amplitude * (noise + 0.75))
					terrain:FillBlock(
						CFrame.new(wx + cellSize / 2, center.Y + height / 2, wz + cellSize / 2),
						Vector3.new(cellSize, height, cellSize),
						mat
					)
				end
			end
			result = { ok = true, action = action }
		end
	elseif action == "clear" then
		terrain:Clear()
		result = { ok = true, action = action }
	else
		result = { ok = false, action = action, error = "unknown terrain action" }
	end

	if recording then
		ChangeHistoryService:FinishRecording(
			recording,
			result.ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
		)
	end
	return result
end
