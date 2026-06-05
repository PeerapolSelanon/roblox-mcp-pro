--!strict
-- Handler for find_instances: a targeted search that cuts round-trips by
-- filtering on several criteria at once and returning a compact, grouped result
-- (or paths / full) instead of dumping every match.

local CollectionService = game:GetService("CollectionService")
local Serialize = require(script.Parent.Parent.Serialize)

-- Compare a live property value against a JSON-supplied expected value.
-- Only primitives are compared directly; everything else goes through
-- Serialize.value so e.g. Material "Neon" or Color [r,g,b] can match.
local function propMatches(inst: Instance, key: string, expected: any): boolean
	local ok, val = pcall(function()
		return (inst :: any)[key]
	end)
	if not ok then
		return false
	end
	local t = typeof(val)
	if t == "boolean" or t == "number" or t == "string" then
		return val == expected
	end
	-- Structured value: compare serialized form (string compare via JSON-ish).
	local sv = Serialize.value(val)
	return Serialize.shallowEqual(sv, expected)
end

return function(args: any): any
	local rootPath = args.path or "game"
	local className = args.class_name
	local nameSub = args.name
	local namePattern = args.name_pattern
	local tag = args.tag
	local matchProps = args.match_props
	local recursive = args.recursive
	if recursive == nil then
		recursive = true
	end
	local mode = args.mode or "grouped"
	local limit = args.limit or 200
	local projection = args.props

	local root = Serialize.resolve(rootPath)
	if not root then
		error("Path not found: " .. tostring(rootPath))
	end

	local candidates: { Instance }
	if tag then
		-- Tag search is global; intersect with the root subtree below.
		candidates = CollectionService:GetTagged(tag)
	else
		candidates = recursive and root:GetDescendants() or root:GetChildren()
	end

	local matched: { Instance } = {}
	for _, inst in candidates do
		if tag and inst ~= root and not inst:IsDescendantOf(root) then
			continue
		end
		if className and inst.ClassName ~= className then
			continue
		end
		if nameSub and not string.find(inst.Name, nameSub, 1, true) then
			continue
		end
		if namePattern and not string.match(inst.Name, namePattern) then
			continue
		end
		if matchProps then
			local allOk = true
			for k, expected in matchProps do
				if not propMatches(inst, k, expected) then
					allOk = false
					break
				end
			end
			if not allOk then
				continue
			end
		end
		table.insert(matched, inst)
	end

	local total = #matched

	if mode == "count" then
		local byClass: { [string]: number } = {}
		for _, inst in matched do
			byClass[inst.ClassName] = (byClass[inst.ClassName] or 0) + 1
		end
		return { total = total, byClass = byClass }
	elseif mode == "paths" then
		local paths: { string } = {}
		for i = 1, math.min(limit, total) do
			table.insert(paths, Serialize.path(matched[i]))
		end
		return { total = total, paths = paths, truncated = total > limit }
	elseif mode == "full" then
		local instances: { any } = {}
		local hasProj = type(projection) == "table" and #projection > 0
		for i = 1, math.min(limit, total) do
			local inst = matched[i]
			table.insert(instances, {
				path = Serialize.path(inst),
				name = inst.Name,
				className = inst.ClassName,
				properties = Serialize.properties(inst, if hasProj then projection else nil),
			})
		end
		return { total = total, instances = instances, truncated = total > limit }
	else
		-- grouped (default): collapse by (parent path + class) -> count + sample.
		local order: { string } = {}
		local groups: { [string]: any } = {}
		for _, inst in matched do
			local parent = inst.Parent and Serialize.path(inst.Parent) or "?"
			local key = parent .. "\0" .. inst.ClassName
			local g = groups[key]
			if g then
				g.count += 1
			else
				g = { parent = parent, class = inst.ClassName, count = 1, sample = inst.Name }
				groups[key] = g
				table.insert(order, key)
			end
		end
		local out: { any } = {}
		for i = 1, math.min(limit, #order) do
			table.insert(out, groups[order[i]])
		end
		return { total = total, groups = out, truncated = #order > limit }
	end
end
