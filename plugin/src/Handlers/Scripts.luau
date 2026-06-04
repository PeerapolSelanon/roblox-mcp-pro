--!strict
-- Handler for manage_scripts: read/write script source and create scripts.

local ScriptEditorService = game:GetService("ScriptEditorService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Serialize = require(script.Parent.Parent.Serialize)

local SCRIPT_CLASSES = { Script = true, LocalScript = true, ModuleScript = true }

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
	return ok2 and src2 or nil
end

local function writeSource(inst: Instance, source: string): (boolean, string?)
	local ok = pcall(function()
		ScriptEditorService:UpdateSourceAsync(inst, function()
			return source
		end)
	end)
	if ok then
		return true, nil
	end
	local ok2, err = pcall(function()
		(inst :: any).Source = source
	end)
	return ok2, ok2 and nil or tostring(err)
end

return function(args: any): any
	local action = args.action or "get_source"

	if action == "get_source" then
		local inst = args.path and Serialize.resolve(args.path) or nil
		if not inst or not SCRIPT_CLASSES[inst.ClassName] then
			return { ok = false, error = "script not found at: " .. tostring(args.path) }
		end
		return { ok = true, path = Serialize.path(inst), className = inst.ClassName, source = readSource(inst) }
	elseif action == "set_source" then
		local inst = args.path and Serialize.resolve(args.path) or nil
		if not inst or not SCRIPT_CLASSES[inst.ClassName] then
			return { ok = false, error = "script not found at: " .. tostring(args.path) }
		end
		local recording = ChangeHistoryService:TryBeginRecording("MCP manage_scripts set_source")
		local ok, err = writeSource(inst, tostring(args.source))
		if recording then
			ChangeHistoryService:FinishRecording(
				recording,
				ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
			)
		end
		return { ok = ok, path = Serialize.path(inst), error = err }
	elseif action == "create" then
		local className = args.class_name or "ModuleScript"
		if not SCRIPT_CLASSES[className] then
			return { ok = false, error = "class_name must be Script/LocalScript/ModuleScript" }
		end
		local parent = args.parent and Serialize.resolve(args.parent) or nil
		if not parent then
			return { ok = false, error = "parent not found: " .. tostring(args.parent) }
		end
		local recording = ChangeHistoryService:TryBeginRecording("MCP manage_scripts create")
		local inst = Instance.new(className)
		if args.name then
			inst.Name = args.name
		end
		if args.source then
			pcall(function()
				(inst :: any).Source = tostring(args.source)
			end)
		end
		inst.Parent = parent
		if recording then
			ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
		end
		return { ok = true, path = Serialize.path(inst) }
	else
		return { ok = false, error = "unknown manage_scripts action: " .. tostring(action) }
	end
end
