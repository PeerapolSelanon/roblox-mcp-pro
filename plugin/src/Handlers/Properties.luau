--!strict
-- Handler for manage_properties: read/write properties on any instance.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Serialize = require(script.Parent.Parent.Serialize)

return function(args: any): any
	local inst = args.path and Serialize.resolve(args.path) or nil
	if not inst then
		return { ok = false, error = "path not found: " .. tostring(args.path) }
	end
	local action = args.action or "get"

	if action == "get" then
		if type(args.names) == "table" then
			local props: { [string]: any } = {}
			for _, name in args.names do
				local ok, val = pcall(function()
					return (inst :: any)[name]
				end)
				props[name] = ok and Serialize.value(val) or nil
			end
			return { ok = true, path = Serialize.path(inst), properties = props }
		end
		return { ok = true, path = Serialize.path(inst), properties = Serialize.properties(inst) }
	elseif action == "set" then
		local recording = ChangeHistoryService:TryBeginRecording("MCP manage_properties")
		local err = Serialize.applyProperties(inst, args.properties)
		if recording then
			ChangeHistoryService:FinishRecording(
				recording,
				err == nil and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
			)
		end
		return { ok = err == nil, path = Serialize.path(inst), error = err }
	else
		return { ok = false, error = "unknown manage_properties action: " .. tostring(action) }
	end
end
