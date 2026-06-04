--!strict
-- Handler for sync_snapshot: serialize whole subtrees (including script Source)
-- into a nested tree the server can mirror to disk.

local ScriptEditorService = game:GetService("ScriptEditorService")
local Serialize = require(script.Parent.Parent.Serialize)

local SCRIPT_CLASSES = {
	Script = true,
	LocalScript = true,
	ModuleScript = true,
}

local function isValueObject(className: string): boolean
	return string.sub(className, -5) == "Value"
end

local function readSource(inst: Instance): string?
	local ok, src = pcall(function()
		return ScriptEditorService:GetEditorSource(inst)
	end)
	if ok and type(src) == "string" then
		return src
	end
	local ok2, src2 = pcall(function()
		return (inst :: any).Source
	end)
	if ok2 and type(src2) == "string" then
		return src2
	end
	return nil
end

local function serializeNode(inst: Instance): any
	local node: any = {
		name = inst.Name,
		className = inst.ClassName,
		properties = Serialize.properties(inst),
	}
	if SCRIPT_CLASSES[inst.ClassName] then
		node.source = readSource(inst)
	elseif isValueObject(inst.ClassName) then
		local ok, val = pcall(function()
			return (inst :: any).Value
		end)
		if ok then
			node.value = Serialize.value(val)
		end
	end
	local children = {}
	for _, child in inst:GetChildren() do
		table.insert(children, serializeNode(child))
	end
	node.children = children
	return node
end

return function(args: any): any
	local roots = args.roots or {}
	local result: { any } = {}
	for _, rootPath in roots do
		local inst = Serialize.resolve(rootPath)
		if inst then
			table.insert(result, {
				path = Serialize.path(inst),
				tree = serializeNode(inst),
			})
		end
	end
	return { roots = result }
end
