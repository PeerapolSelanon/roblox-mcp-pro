--!strict
-- Handler for execute_luau: compile and run Luau, capturing output and returns.

local LogService = game:GetService("LogService")
local Serialize = require(script.Parent.Parent.Serialize)

return function(args: any): any
	local code = args.code
	local timeoutMs = args.timeout_ms or 5000

	if type(code) ~= "string" or code == "" then
		return { ok = false, returns = {}, output = "", error = "No code provided" }
	end
	if type(loadstring) ~= "function" then
		return {
			ok = false,
			returns = {},
			output = "",
			error = "loadstring is unavailable in this Studio session. Enable it or run a different action.",
		}
	end

	local chunk, compileErr = loadstring(code)
	if not chunk then
		return { ok = false, returns = {}, output = "", error = "Compile error: " .. tostring(compileErr) }
	end

	-- Capture print/warn output for the duration of execution.
	local logs: { string } = {}
	local conn = LogService.MessageOut:Connect(function(message: string)
		table.insert(logs, message)
	end)

	local results: { any } = {}
	local runOk = false
	local runErr: string? = nil
	local finished = false

	local co = coroutine.create(function()
		local packed = table.pack(pcall(chunk))
		runOk = packed[1]
		if runOk then
			for i = 2, packed.n do
				table.insert(results, packed[i])
			end
		else
			runErr = tostring(packed[2])
		end
		finished = true
	end)

	coroutine.resume(co)

	-- Wait up to the deadline for non-yielding or briefly-yielding code.
	local deadline = os.clock() + (timeoutMs / 1000)
	while not finished and os.clock() < deadline do
		task.wait()
	end

	conn:Disconnect()

	if not finished then
		return {
			ok = false,
			returns = {},
			output = table.concat(logs, "\n"),
			error = ("Execution exceeded %dms (the code may be yielding)."):format(timeoutMs),
		}
	end

	local serialized: { any } = {}
	for _, v in results do
		table.insert(serialized, Serialize.value(v))
	end

	return {
		ok = runOk,
		returns = serialized,
		output = table.concat(logs, "\n"),
		error = runErr,
	}
end
