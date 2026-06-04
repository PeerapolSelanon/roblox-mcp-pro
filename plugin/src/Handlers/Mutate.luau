--!strict
-- Handler for mutate_instances: create/edit/move/clone/delete instances.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Serialize = require(script.Parent.Parent.Serialize)

local PROTECTED = {
	CoreGui = true,
	CorePackages = true,
	CoreScripts = true,
}

local function isProtected(inst: Instance?): boolean
	local current = inst
	while current and current ~= game do
		if PROTECTED[current.Name] then
			return true
		end
		current = current.Parent
	end
	return false
end

local applyProperties = Serialize.applyProperties

local function doOperation(op: any): any
	local action = op.action

	if action == "create" then
		local className = op.class_name
		if type(className) ~= "string" then
			return { ok = false, action = action, error = "create requires class_name" }
		end
		local parentPath = op.parent or op.path
		local parent = parentPath and Serialize.resolve(parentPath) or nil
		if not parent then
			return { ok = false, action = action, error = "parent not found: " .. tostring(parentPath) }
		end
		if isProtected(parent) then
			return { ok = false, action = action, error = "parent is a protected service" }
		end
		local okNew, inst = pcall(function()
			return Instance.new(className)
		end)
		if not okNew then
			return { ok = false, action = action, error = "invalid ClassName: " .. tostring(className) }
		end
		if op.name then
			inst.Name = op.name
		end
		local propErr = applyProperties(inst, op.properties)
		inst.Parent = parent
		return {
			ok = propErr == nil,
			action = action,
			resultPath = Serialize.path(inst),
			error = propErr,
		}
	end

	-- All other actions need an existing target.
	local target = op.path and Serialize.resolve(op.path) or nil
	if not target then
		return { ok = false, action = action, error = "path not found: " .. tostring(op.path) }
	end
	if isProtected(target) then
		return { ok = false, action = action, path = op.path, error = "target is a protected service" }
	end

	if action == "set_properties" then
		local err = applyProperties(target, op.properties)
		return { ok = err == nil, action = action, path = Serialize.path(target), error = err }
	elseif action == "rename" then
		if type(op.name) ~= "string" then
			return { ok = false, action = action, error = "rename requires name" }
		end
		target.Name = op.name
		return { ok = true, action = action, resultPath = Serialize.path(target) }
	elseif action == "reparent" then
		local newParent = op.parent and Serialize.resolve(op.parent) or nil
		if not newParent then
			return { ok = false, action = action, error = "parent not found: " .. tostring(op.parent) }
		end
		target.Parent = newParent
		return { ok = true, action = action, resultPath = Serialize.path(target) }
	elseif action == "delete" then
		local p = Serialize.path(target)
		target:Destroy()
		return { ok = true, action = action, path = p }
	elseif action == "clone" then
		local clone = target:Clone()
		if not clone then
			return { ok = false, action = action, error = "instance is not Archivable" }
		end
		if op.name then
			clone.Name = op.name
		end
		local newParent = (op.parent and Serialize.resolve(op.parent)) or target.Parent
		clone.Parent = newParent
		return { ok = true, action = action, resultPath = Serialize.path(clone) }
	else
		return { ok = false, action = action, error = "unknown action: " .. tostring(action) }
	end
end

return function(args: any): any
	local operations = args.operations or {}
	local recording = ChangeHistoryService:TryBeginRecording("MCP mutate_instances")
	local results: { any } = {}
	for _, op in operations do
		local ok, res = pcall(doOperation, op)
		if ok then
			table.insert(results, res)
		else
			table.insert(results, { ok = false, action = op.action, error = tostring(res) })
		end
	end
	if recording then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	end
	return { results = results }
end
