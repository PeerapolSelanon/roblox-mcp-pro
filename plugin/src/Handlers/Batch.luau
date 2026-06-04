--!strict
-- Handler for batch_execute: run several sub-commands in one round-trip,
-- wrapped in a single undo recording.

local ChangeHistoryService = game:GetService("ChangeHistoryService")

return function(args: any): any
	-- Deferred require avoids a load-time cycle (Dispatcher requires this module).
	local Dispatcher = require(script.Parent.Parent.Dispatcher)

	local operations = args.operations or {}
	local stopOnError = args.stop_on_error == true

	local recording = ChangeHistoryService:TryBeginRecording("MCP batch_execute")
	local results: { any } = {}
	for _, op in operations do
		local ok, result, errMsg = Dispatcher.dispatch(op.tool, op.args)
		table.insert(results, { ok = ok, result = result, error = errMsg })
		if not ok and stopOnError then
			break
		end
	end
	if recording then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	end
	return { results = results }
end
