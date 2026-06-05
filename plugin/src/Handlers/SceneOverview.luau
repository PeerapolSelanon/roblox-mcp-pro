--!strict
-- Handler for scene_overview: one-call summary of the DataModel so an agent can
-- orient itself without many query_instances round-trips. Returns a full class
-- histogram (counting only — cheap) plus a shallow, breadth-capped tree.

local Serialize = require(script.Parent.Parent.Serialize)

return function(args: any): any
	local path = args.path or "game"
	local depth = args.depth or 2
	local maxPer = args.max_per_level or 50

	local root = Serialize.resolve(path)
	if not root then
		error("Path not found: " .. tostring(path))
	end

	-- Full class histogram of all descendants (count only, no serialization).
	local classCounts: { [string]: number } = {}
	local total = 0
	for _, d in root:GetDescendants() do
		classCounts[d.ClassName] = (classCounts[d.ClassName] or 0) + 1
		total += 1
	end

	-- Shallow structural tree (breadth-capped per node).
	local function buildTree(inst: Instance, d: number): any
		local kids = inst:GetChildren()
		local node: any = {
			name = if inst == game then "game" else inst.Name,
			class = inst.ClassName,
			n = #kids,
		}
		if d > 0 and #kids > 0 then
			local children: { any } = {}
			for i = 1, math.min(#kids, maxPer) do
				table.insert(children, buildTree(kids[i], d - 1))
			end
			node.children = children
			if #kids > maxPer then
				node.more = #kids - maxPer
			end
		end
		return node
	end

	return { total = total, classCounts = classCounts, tree = buildTree(root, depth) }
end
