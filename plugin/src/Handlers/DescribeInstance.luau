--!strict
-- Handler for describe_instance: everything about one instance in a single call —
-- properties (optionally projected), child list, and ancestry — so an agent
-- doesn't need separate query/property/parent round-trips.

local Serialize = require(script.Parent.Parent.Serialize)

return function(args: any): any
	local path = args.path
	if not path then
		error("path is required")
	end
	local inst = Serialize.resolve(path)
	if not inst then
		error("Path not found: " .. tostring(path))
	end

	local props = args.props
	local hasProjection = type(props) == "table" and #props > 0

	local out: any = {
		path = Serialize.path(inst),
		name = inst.Name,
		className = inst.ClassName,
		childCount = #inst:GetChildren(),
		properties = Serialize.properties(inst, if hasProjection then props else nil),
	}

	-- Ancestry chain (name + class), root-first, excluding `game`.
	local ancestors: { any } = {}
	local cur: Instance? = inst.Parent
	while cur and cur ~= game do
		table.insert(ancestors, 1, { name = cur.Name, class = cur.ClassName })
		cur = cur.Parent
	end
	out.ancestors = ancestors

	if args.children ~= false then
		local kids = inst:GetChildren()
		local maxKids = args.max_children or 100
		local children: { any } = {}
		for i = 1, math.min(#kids, maxKids) do
			local k = kids[i]
			table.insert(children, { name = k.Name, class = k.ClassName, n = #k:GetChildren() })
		end
		out.children = children
		if #kids > maxKids then
			out.moreChildren = #kids - maxKids
		end
	end

	return out
end
