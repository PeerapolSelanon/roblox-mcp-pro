--!strict
-- Handler for manage_logs: return recent Studio output log history.

local LogService = game:GetService("LogService")

local TYPE_NAMES = {
	[Enum.MessageType.MessageOutput] = "output",
	[Enum.MessageType.MessageInfo] = "info",
	[Enum.MessageType.MessageWarning] = "warning",
	[Enum.MessageType.MessageError] = "error",
}

return function(args: any): any
	local limit = args.limit or 100
	local filter = args.message_type -- optional: "output"|"info"|"warning"|"error"
	local since = tonumber(args.since) -- optional: epoch seconds; only newer entries

	local history = LogService:GetLogHistory()
	local out = {}
	-- Walk newest-first.
	for i = #history, 1, -1 do
		local entry = history[i]
		if since and entry.timestamp < since then
			break -- history is chronological; everything earlier is older
		end
		local typeName = TYPE_NAMES[entry.messageType] or "output"
		if not filter or typeName == filter then
			table.insert(out, { message = entry.message, type = typeName, timestamp = entry.timestamp })
			if #out >= limit then
				break
			end
		end
	end
	return { ok = true, count = #out, logs = out }
end
