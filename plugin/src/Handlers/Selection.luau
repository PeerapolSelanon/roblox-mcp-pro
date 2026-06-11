--!strict
-- Handler for manage_selection: read/control the Studio Explorer selection.

local Selection = game:GetService("Selection")
local Serialize = require(script.Parent.Parent.Serialize)

local function resolveMany(paths: any): { Instance }
	local out: { Instance } = {}
	if type(paths) == "table" then
		for _, p in paths do
			local inst = Serialize.resolve(p)
			if inst then
				table.insert(out, inst)
			end
		end
	end
	return out
end

local function currentPaths(): { string }
	local out = {}
	for _, inst in Selection:Get() do
		table.insert(out, Serialize.path(inst))
	end
	return out
end

return function(args: any): any
	local action = args.action or "get"

	if action == "get" then
		return { ok = true, selection = currentPaths() }
	elseif action == "set" then
		Selection:Set(resolveMany(args.paths))
		return { ok = true, selection = currentPaths() }
	elseif action == "add" then
		local current = Selection:Get()
		for _, inst in resolveMany(args.paths) do
			table.insert(current, inst)
		end
		Selection:Set(current)
		return { ok = true, selection = currentPaths() }
	elseif action == "clear" then
		Selection:Set({})
		return { ok = true, selection = {} }
	elseif action == "watch" then
		-- Wait for the user to change the Explorer selection — lets a person
		-- "point at" instances for the agent by clicking them in Studio.
		-- Capped well under the server's 30s command timeout; note the poll
		-- loop is blocked while waiting, so keep timeouts short.
		local timeout = math.clamp(tonumber(args.timeout) or 10, 1, 20)
		local before = table.concat(currentPaths(), "\n")
		local deadline = os.clock() + timeout
		while os.clock() < deadline do
			task.wait(0.25)
			local now = table.concat(currentPaths(), "\n")
			if now ~= before then
				return { ok = true, changed = true, selection = currentPaths() }
			end
		end
		return { ok = true, changed = false, selection = currentPaths() }
	else
		return { ok = false, error = "unknown manage_selection action: " .. tostring(action) }
	end
end
