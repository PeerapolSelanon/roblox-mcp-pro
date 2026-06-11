--!strict
-- Handler for manage_properties: read/write properties, attributes, and
-- CollectionService tags on any instance.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local CollectionService = game:GetService("CollectionService")
local Serialize = require(script.Parent.Parent.Serialize)

-- Attribute values arrive as JSON: pass primitives through, turn a 3-number
-- array into a Vector3, and a {r,g,b} (0..1) table into a Color3.
local function coerceAttribute(raw: any): any
	if type(raw) == "table" then
		if #raw == 3 and type(raw[1]) == "number" then
			return Vector3.new(raw[1], raw[2], raw[3])
		end
		if type(raw.r) == "number" and type(raw.g) == "number" and type(raw.b) == "number" then
			return Color3.new(raw.r, raw.g, raw.b)
		end
	end
	return raw
end

local function withRecording(label: string, fn: () -> any): any
	local recording = ChangeHistoryService:TryBeginRecording("MCP manage_properties " .. label)
	local ok, result = pcall(fn)
	if recording then
		ChangeHistoryService:FinishRecording(
			recording,
			ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
		)
	end
	if not ok then
		return { ok = false, error = tostring(result) }
	end
	return result
end

return function(args: any): any
	local action = args.action or "get"

	-- get_tagged is the one action that takes a tag, not a path.
	if action == "get_tagged" then
		if type(args.tag) ~= "string" or args.tag == "" then
			return { ok = false, error = "get_tagged requires tag" }
		end
		local limit = tonumber(args.limit) or 100
		local out = {}
		for i, tagged in CollectionService:GetTagged(args.tag) do
			if i > limit then
				break
			end
			table.insert(out, { path = Serialize.path(tagged), className = tagged.ClassName })
		end
		return { ok = true, tag = args.tag, count = #out, instances = out }
	end

	if action == "mass_get" then
		if type(args.paths) ~= "table" then
			return { ok = false, error = "mass_get requires paths (array)" }
		end
		local results = {}
		for _, p in args.paths do
			local target = Serialize.resolve(tostring(p))
			if target then
				local propList = if type(args.names) == "table" then args.names else nil
				table.insert(results, {
					ok = true,
					path = Serialize.path(target),
					properties = Serialize.properties(target, propList),
				})
			else
				table.insert(results, { ok = false, path = tostring(p), error = "not found" })
			end
		end
		return { ok = true, results = results }
	elseif action == "mass_set" then
		if type(args.paths) ~= "table" or type(args.properties) ~= "table" then
			return { ok = false, error = "mass_set requires paths (array) and properties (map)" }
		end
		return withRecording("mass_set", function()
			local results = {}
			local okCount = 0
			for _, p in args.paths do
				local target = Serialize.resolve(tostring(p))
				if target then
					local err = Serialize.applyProperties(target, args.properties)
					if err == nil then
						okCount += 1
					end
					table.insert(results, { ok = err == nil, path = Serialize.path(target), error = err })
				else
					table.insert(results, { ok = false, path = tostring(p), error = "not found" })
				end
			end
			return { ok = okCount > 0, applied = okCount, results = results }
		end)
	end

	local inst = args.path and Serialize.resolve(args.path) or nil
	if not inst then
		return { ok = false, error = "path not found: " .. tostring(args.path) }
	end

	if action == "get" then
		if type(args.names) == "table" then
			local props: { [string]: any } = {}
			for _, name in args.names do
				local ok, val = pcall(function()
					return (inst :: any)[name]
				end)
				props[name] = ok and Serialize.value(val) or nil
			end
			return { ok = true, path = Serialize.path(inst), properties = props }
		end
		return { ok = true, path = Serialize.path(inst), properties = Serialize.properties(inst) }
	elseif action == "set" then
		local recording = ChangeHistoryService:TryBeginRecording("MCP manage_properties")
		local err = Serialize.applyProperties(inst, args.properties)
		if recording then
			ChangeHistoryService:FinishRecording(
				recording,
				err == nil and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
			)
		end
		return { ok = err == nil, path = Serialize.path(inst), error = err }
	elseif action == "modify_children" then
		-- Apply one property map to every (matching) child in a single undo
		-- step — "make all parts in this folder Neon" without N calls.
		if type(args.properties) ~= "table" then
			return { ok = false, error = "modify_children requires properties (map)" }
		end
		local className = args.class_name
		local nameFilter = args.name
		local pool = if args.recursive == true then inst:GetDescendants() else inst:GetChildren()
		return withRecording("modify_children", function()
			local applied = 0
			local failed = 0
			local firstError: string? = nil
			for _, child in pool do
				local classOk = className == nil or child:IsA(tostring(className))
				local nameOk = nameFilter == nil or string.find(child.Name, tostring(nameFilter), 1, true) ~= nil
				if classOk and nameOk then
					local err = Serialize.applyProperties(child, args.properties)
					if err == nil then
						applied += 1
					else
						failed += 1
						firstError = firstError or err
					end
				end
			end
			return { ok = applied > 0 or failed == 0, applied = applied, failed = failed, error = firstError }
		end)
	elseif action == "set_relative" then
		-- new = current * scale + delta, for number and Vector3 properties —
		-- "raise it 5 studs" / "double the size" without reading first.
		local propName = args.property
		if type(propName) ~= "string" then
			return { ok = false, error = "set_relative requires property" }
		end
		local okRead, current = pcall(function()
			return (inst :: any)[propName]
		end)
		if not okRead then
			return { ok = false, error = "cannot read property: " .. propName }
		end
		local scale = tonumber(args.scale) or 1
		local newValue: any
		if type(current) == "number" then
			newValue = current * scale + (tonumber(args.delta) or 0)
		elseif typeof(current) == "Vector3" then
			local d = args.delta
			local deltaVec = if type(d) == "table"
				then Vector3.new(tonumber(d[1]) or 0, tonumber(d[2]) or 0, tonumber(d[3]) or 0)
				else Vector3.zero
			newValue = current * scale + deltaVec
		else
			return { ok = false, error = "set_relative supports number and Vector3 properties (got " .. typeof(current) .. ")" }
		end
		return withRecording("set_relative", function()
			(inst :: any)[propName] = newValue
			return { ok = true, path = Serialize.path(inst), property = propName, value = Serialize.value(newValue) }
		end)
	elseif action == "get_attributes" then
		local attrs: { [string]: any } = {}
		for name, value in inst:GetAttributes() do
			attrs[name] = Serialize.value(value)
		end
		return { ok = true, path = Serialize.path(inst), attributes = attrs }
	elseif action == "set_attributes" then
		if type(args.attributes) ~= "table" then
			return { ok = false, error = "set_attributes requires attributes (name -> value map)" }
		end
		return withRecording("set_attributes", function()
			for name, value in args.attributes do
				inst:SetAttribute(name, coerceAttribute(value))
			end
			return { ok = true, path = Serialize.path(inst) }
		end)
	elseif action == "remove_attributes" then
		if type(args.names) ~= "table" then
			return { ok = false, error = "remove_attributes requires names (array)" }
		end
		return withRecording("remove_attributes", function()
			for _, name in args.names do
				inst:SetAttribute(tostring(name), nil)
			end
			return { ok = true, path = Serialize.path(inst) }
		end)
	elseif action == "get_tags" then
		return { ok = true, path = Serialize.path(inst), tags = CollectionService:GetTags(inst) }
	elseif action == "add_tags" or action == "remove_tags" then
		if type(args.tags) ~= "table" then
			return { ok = false, error = action .. " requires tags (array)" }
		end
		return withRecording(action, function()
			for _, tag in args.tags do
				if action == "add_tags" then
					CollectionService:AddTag(inst, tostring(tag))
				else
					CollectionService:RemoveTag(inst, tostring(tag))
				end
			end
			return { ok = true, path = Serialize.path(inst), tags = CollectionService:GetTags(inst) }
		end)
	else
		return { ok = false, error = "unknown manage_properties action: " .. tostring(action) }
	end
end
