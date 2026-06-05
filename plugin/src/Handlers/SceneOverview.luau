--!strict
-- Handler for scene_overview: one-call summary of the DataModel so an agent can
-- orient itself without many query_instances round-trips. Returns a class
-- histogram (counting only — cheap) plus a shallow, breadth-capped tree whose
-- duplicate leaves are collapsed (Tile x50 -> one entry with count).

local Serialize = require(script.Parent.Parent.Serialize)

-- User-facing services worth summarizing by default. The dozens of internal
-- Studio services (StatsItem, MemStorageConnection, ...) just bloat the output,
-- so at game root we scope to these unless include_internal is set.
local USER_SERVICES = {
	"Workspace", "Players", "Lighting", "ReplicatedFirst", "ReplicatedStorage",
	"ServerScriptService", "ServerStorage", "StarterGui", "StarterPack",
	"StarterPlayer", "SoundService", "Teams", "TextChatService", "MaterialService",
}

return function(args: any): any
	local path = args.path or "game"
	local depth = args.depth or 2
	local maxPer = args.max_per_level or 50
	local includeInternal = args.include_internal == true

	local root = Serialize.resolve(path)
	if not root then
		error("Path not found: " .. tostring(path))
	end

	-- Decide the set of roots to summarize. At `game` we default to user
	-- services; elsewhere (or with include_internal) we use the resolved root.
	local scopeRoots: { Instance } = {}
	local scopedToServices = false
	if root == game and not includeInternal then
		scopedToServices = true
		for _, name in USER_SERVICES do
			local ok, svc = pcall(function()
				return game:GetService(name :: any)
			end)
			if ok and svc then
				table.insert(scopeRoots, svc)
			end
		end
	else
		table.insert(scopeRoots, root)
	end

	-- Class histogram across the chosen scope (count only, no serialization).
	local classCounts: { [string]: number } = {}
	local total = 0
	for _, sr in scopeRoots do
		for _, d in sr:GetDescendants() do
			classCounts[d.ClassName] = (classCounts[d.ClassName] or 0) + 1
			total += 1
		end
	end

	-- Build a node for one instance, collapsing duplicate leaf children.
	local function buildNode(inst: Instance, d: number): any
		local kids = inst:GetChildren()
		local node: any = {
			name = inst.Name,
			class = inst.ClassName,
			n = #kids,
		}
		if d <= 0 or #kids == 0 then
			return node
		end

		-- Split children: branches (have their own children) are recursed and
		-- listed individually; leaves (no children) of identical class+name are
		-- collapsed into one entry carrying a `count`.
		local branches: { any } = {}
		local leafKeys: { string } = {}
		local leafGroups: { [string]: any } = {}
		for _, k in kids do
			if #k:GetChildren() > 0 then
				table.insert(branches, k)
			else
				local key = k.ClassName .. "\0" .. k.Name
				local g = leafGroups[key]
				if g then
					g.count += 1
				else
					g = { name = k.Name, class = k.ClassName, count = 1 }
					leafGroups[key] = g
					table.insert(leafKeys, key)
				end
			end
		end

		local children: { any } = {}
		local shown = 0
		for _, b in branches do
			if shown >= maxPer then
				break
			end
			table.insert(children, buildNode(b, d - 1))
			shown += 1
		end
		for _, key in leafKeys do
			if shown >= maxPer then
				break
			end
			local g = leafGroups[key]
			if g.count == 1 then
				g.count = nil -- singletons read like a normal node
			end
			table.insert(children, g)
			shown += 1
		end

		node.children = children
		local groupTotal = #branches + #leafKeys
		if groupTotal > shown then
			node.more = groupTotal - shown
		end
		return node
	end

	local tree: any
	if scopedToServices then
		-- Synthetic game node whose children are the user services.
		local children: { any } = {}
		for _, sr in scopeRoots do
			table.insert(children, buildNode(sr, depth - 1))
		end
		tree = { name = "game", class = "DataModel", n = #children, children = children, scoped = "user-services" }
	else
		tree = buildNode(root, depth)
	end

	return { total = total, classCounts = classCounts, tree = tree }
end
