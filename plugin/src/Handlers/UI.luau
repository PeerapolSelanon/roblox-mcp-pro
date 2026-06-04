--!strict
-- Handler for manage_ui: build and edit GUI hierarchies.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Serialize = require(script.Parent.Parent.Serialize)

-- Recursively build a UI node spec: { className, name?, properties?, children? }
local function build(spec: any, parent: Instance): (Instance?, string?)
	local okNew, inst = pcall(function()
		return Instance.new(spec.className)
	end)
	if not okNew or not inst then
		return nil, "invalid ClassName: " .. tostring(spec.className)
	end
	if spec.name then
		inst.Name = spec.name
	end
	local propErr = Serialize.applyProperties(inst, spec.properties)
	if propErr then
		inst:Destroy()
		return nil, propErr
	end
	for _, childSpec in spec.children or {} do
		local _, childErr = build(childSpec, inst)
		if childErr then
			inst:Destroy()
			return nil, childErr
		end
	end
	inst.Parent = parent
	return inst, nil
end

return function(args: any): any
	local action = args.action or "create"
	local recording = ChangeHistoryService:TryBeginRecording("MCP manage_ui")
	local result: any

	if action == "create" then
		local parentPath = args.parent or "StarterGui"
		local parent = Serialize.resolve(parentPath)
		if not parent then
			result = { ok = false, error = "parent not found: " .. tostring(parentPath) }
		elseif type(args.tree) ~= "table" then
			result = { ok = false, error = "create requires a 'tree' spec" }
		else
			local inst, err = build(args.tree, parent)
			result = inst and { ok = true, rootPath = Serialize.path(inst) }
				or { ok = false, error = err }
		end
	elseif action == "set" then
		local inst = args.path and Serialize.resolve(args.path) or nil
		if not inst then
			result = { ok = false, error = "path not found: " .. tostring(args.path) }
		else
			local err = Serialize.applyProperties(inst, args.properties)
			result = { ok = err == nil, path = Serialize.path(inst), error = err }
		end
	elseif action == "delete" then
		local inst = args.path and Serialize.resolve(args.path) or nil
		if not inst then
			result = { ok = false, error = "path not found: " .. tostring(args.path) }
		else
			local p = Serialize.path(inst)
			inst:Destroy()
			result = { ok = true, path = p }
		end
	else
		result = { ok = false, error = "unknown manage_ui action: " .. tostring(action) }
	end

	if recording then
		ChangeHistoryService:FinishRecording(
			recording,
			result.ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
		)
	end
	return result
end
