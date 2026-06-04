--!strict
-- Handler for sync_apply: apply a single filesystem->Studio change.
-- Currently supports setting a script's source.

local ScriptEditorService = game:GetService("ScriptEditorService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Serialize = require(script.Parent.Parent.Serialize)

local function setSource(inst: Instance, source: string): (boolean, string?)
	-- Prefer the editor service so open documents stay consistent.
	local ok = pcall(function()
		ScriptEditorService:UpdateSourceAsync(inst, function()
			return source
		end)
	end)
	if ok then
		return true, nil
	end
	-- Fall back to a direct assignment.
	local ok2, err = pcall(function()
		(inst :: any).Source = source
	end)
	if ok2 then
		return true, nil
	end
	return false, tostring(err)
end

return function(args: any): any
	local action = args.action or "set_source"
	local inst = args.path and Serialize.resolve(args.path) or nil
	if not inst then
		return { ok = false, error = "path not found: " .. tostring(args.path) }
	end

	if action == "set_source" then
		local recording = ChangeHistoryService:TryBeginRecording("MCP sync set_source")
		local ok, err = setSource(inst, tostring(args.source))
		if recording then
			ChangeHistoryService:FinishRecording(
				recording,
				ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
			)
		end
		return { ok = ok, path = Serialize.path(inst), error = err }
	end

	return { ok = false, error = "unknown sync_apply action: " .. tostring(action) }
end
