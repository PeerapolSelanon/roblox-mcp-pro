--!strict
-- Serialize: convert between Roblox instances/datatypes and JSON-safe tables,
-- and resolve dotted instance paths.

local Serialize = {}

-- Common properties we attempt to read when include_properties is requested.
local CANDIDATE_PROPS = {
	"Anchored", "CanCollide", "Transparency", "Reflectance",
	"Size", "Position", "Orientation", "CFrame",
	"Color", "BrickColor", "Material",
	"Value", "Text", "Enabled", "Visible",
	"Locked", "CastShadow", "Massless",
}

-- Round to ~4 decimals to drop float noise (0.14901961... -> 0.149,
-- 6.199999809 -> 6.2). Whole numbers stay exact. Big token saver: a float
-- component shrinks from ~18 chars to ~5 with no meaningful precision loss.
local function r(n: number): number
	if n ~= n or n == math.huge or n == -math.huge then
		return n -- leave NaN/inf as-is
	end
	return math.floor(n * 10000 + 0.5) / 10000
end

-- Convert a Roblox value into something JSON-encodable.
function Serialize.value(v: any): any
	local t = typeof(v)
	if t == "number" then
		return r(v)
	elseif t == "nil" or t == "boolean" or t == "string" then
		return v
	elseif t == "Vector3" then
		return { r(v.X), r(v.Y), r(v.Z) } -- compact [x,y,z]; coerce accepts this back
	elseif t == "Vector2" then
		return { r(v.X), r(v.Y) } -- [x,y]
	elseif t == "CFrame" then
		local c = { v:GetComponents() }
		for i, n in c do
			c[i] = r(n)
		end
		return c
	elseif t == "Color3" then
		return { r(v.R), r(v.G), r(v.B) } -- [r,g,b]
	elseif t == "BrickColor" then
		return v.Name
	elseif t == "UDim" then
		return { scale = r(v.Scale), offset = v.Offset }
	elseif t == "UDim2" then
		return { { r(v.X.Scale), v.X.Offset }, { r(v.Y.Scale), v.Y.Offset } }
	elseif t == "EnumItem" then
		return v.Name
	elseif t == "Instance" then
		return Serialize.path(v)
	else
		return tostring(v)
	end
end

-- Shallow structural equality for comparing a serialized value to an expected
-- JSON value (used by find_instances match_props). Handles primitives and
-- flat arrays like [r,g,b] / [x,y,z].
function Serialize.shallowEqual(a: any, b: any): boolean
	if type(a) ~= type(b) then
		return false
	end
	if type(a) ~= "table" then
		return a == b
	end
	if #a ~= #b then
		return false
	end
	for i = 1, #a do
		if a[i] ~= b[i] then
			return false
		end
	end
	return true
end

-- Build the full dotted path of an instance, rooted at "game".
function Serialize.path(inst: Instance): string
	local segments = {}
	local current: Instance? = inst
	while current and current ~= game do
		table.insert(segments, 1, current.Name)
		current = current.Parent
	end
	return "game." .. table.concat(segments, ".")
end

-- Resolve a dotted path to an instance, or nil. Accepts an optional leading "game".
function Serialize.resolve(path: string): Instance?
	local segments = string.split(path, ".")
	local current: Instance = game
	local startIndex = 1
	if segments[1] == "game" then
		startIndex = 2
	end
	for i = startIndex, #segments do
		local name = segments[i]
		local nextInst: Instance?
		-- Try service first (handles Workspace, ServerStorage, etc.).
		local ok, svc = pcall(function()
			return game:GetService(name :: any)
		end)
		if current == game and ok and svc then
			nextInst = svc
		else
			nextInst = current:FindFirstChild(name)
		end
		if not nextInst then
			return nil
		end
		current = nextInst
	end
	return current
end

-- Read readable properties from an instance. Pass `propList` to read only those
-- (field projection — fewer tokens); otherwise a curated common set is read.
function Serialize.properties(inst: Instance, propList: { string }?): { [string]: any }
	local names = (propList and #propList > 0) and propList or CANDIDATE_PROPS
	local out: { [string]: any } = {}
	for _, name in names do
		local ok, val = pcall(function()
			return (inst :: any)[name]
		end)
		if ok and val ~= nil then
			out[name] = Serialize.value(val)
		end
	end
	return out
end

-- Coerce a JSON value into the right Roblox type for setting `prop` on `inst`.
-- Uses the current property value's type as the target.
function Serialize.coerce(inst: Instance, prop: string, raw: any): (boolean, any)
	local ok, current = pcall(function()
		return (inst :: any)[prop]
	end)
	if not ok then
		-- Property doesn't exist or isn't readable; pass raw through.
		return true, raw
	end
	local t = typeof(current)
	if t == "Vector3" and type(raw) == "table" then
		local x = raw.x or raw[1] or 0
		local y = raw.y or raw[2] or 0
		local z = raw.z or raw[3] or 0
		return true, Vector3.new(x, y, z)
	elseif t == "Color3" and type(raw) == "table" then
		local r = raw.r or raw[1] or 0
		local g = raw.g or raw[2] or 0
		local b = raw.b or raw[3] or 0
		return true, Color3.new(r, g, b)
	elseif t == "BrickColor" and type(raw) == "string" then
		return true, BrickColor.new(raw)
	elseif t == "EnumItem" and type(raw) == "string" then
		-- Match against the current enum's items.
		local enumType = (current :: EnumItem).EnumType
		for _, item in enumType:GetEnumItems() do
			if item.Name == raw then
				return true, item
			end
		end
		return false, ("'%s' is not a valid %s"):format(raw, tostring(enumType))
	elseif t == "UDim2" and type(raw) == "table" then
		local xs, xo, ys, yo
		if type(raw[1]) == "table" then
			xs, xo = raw[1][1] or 0, raw[1][2] or 0
			ys, yo = raw[2][1] or 0, raw[2][2] or 0
		else
			xs, xo, ys, yo = raw[1] or 0, raw[2] or 0, raw[3] or 0, raw[4] or 0
		end
		return true, UDim2.new(xs, xo, ys, yo)
	elseif t == "UDim" and type(raw) == "table" then
		return true, UDim.new(raw.scale or raw[1] or 0, raw.offset or raw[2] or 0)
	elseif t == "Vector2" and type(raw) == "table" then
		return true, Vector2.new(raw.x or raw[1] or 0, raw.y or raw[2] or 0)
	elseif t == "CFrame" and type(raw) == "table" and type(raw[1]) == "number" then
		local ok2, cf = pcall(function()
			return CFrame.new(table.unpack(raw, 1, #raw))
		end)
		if ok2 then
			return true, cf
		end
		return false, "invalid CFrame components"
	elseif t == "number" and type(raw) == "number" then
		return true, raw
	elseif t == "boolean" and type(raw) == "boolean" then
		return true, raw
	elseif t == "string" and type(raw) == "string" then
		return true, raw
	else
		-- Best effort: pass raw through and let the assignment validate.
		return true, raw
	end
end

-- Apply a property map to an instance. Returns an error string, or nil on success.
function Serialize.applyProperties(inst: Instance, properties: any): string?
	if type(properties) ~= "table" then
		return nil
	end
	for key, raw in pairs(properties) do
		local okCoerce, coerced = Serialize.coerce(inst, key, raw)
		if not okCoerce then
			return ("property '%s': %s"):format(key, tostring(coerced))
		end
		local okSet, setErr = pcall(function()
			(inst :: any)[key] = coerced
		end)
		if not okSet then
			return ("property '%s': %s"):format(key, tostring(setErr))
		end
	end
	return nil
end

return Serialize
