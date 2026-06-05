--!strict
-- Handler for query_instances: search the DataModel and serialize matches.

local Serialize = require(script.Parent.Parent.Serialize)

return function(args: any): any
	local path = args.path or "game"
	local className = args.class_name
	local nameFilter = args.name
	local recursive = args.recursive
	if recursive == nil then
		recursive = true
	end
	local props = args.props -- optional { string } projection
	local hasProjection = type(props) == "table" and #props > 0
	local includeProps = args.include_properties == true or hasProjection
	local limit = args.limit or 100
	local offset = args.offset or 0

	local root = Serialize.resolve(path)
	if not root then
		error("Path not found: " .. tostring(path))
	end

	local candidates: { Instance } = recursive and root:GetDescendants() or root:GetChildren()

	local matched: { Instance } = {}
	for _, inst in candidates do
		if className and inst.ClassName ~= className then
			continue
		end
		if nameFilter and not string.find(inst.Name, nameFilter, 1, true) then
			continue
		end
		table.insert(matched, inst)
	end

	local total = #matched
	local instances: { any } = {}
	for i = offset + 1, math.min(offset + limit, total) do
		local inst = matched[i]
		local dto: any = {
			path = Serialize.path(inst),
			name = inst.Name,
			className = inst.ClassName,
			childCount = #inst:GetChildren(),
		}
		if includeProps then
			dto.properties = Serialize.properties(inst, if hasProjection then props else nil)
		end
		table.insert(instances, dto)
	end

	return { total = total, instances = instances }
end
