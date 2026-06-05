--!strict
-- Bridge: HTTP client that talks to the local roblox-mcp-pro server.
-- Long-polls GET /dequeue for commands and POSTs results to /respond.

local HttpService = game:GetService("HttpService")

local Bridge = {}

local baseUrl = "http://127.0.0.1:3690"
local authToken: string? = nil

function Bridge.configure(url: string, token: string?)
	baseUrl = url
	authToken = token
end

local function headers(): { [string]: string }
	local h = { ["Content-Type"] = "application/json" }
	if authToken and authToken ~= "" then
		h["x-auth-token"] = authToken
	end
	return h
end

-- Long-poll for the next command.
-- Returns: command table, or nil if the poll timed out (204), or false + message on error.
function Bridge.dequeue(): (any, string?)
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = baseUrl .. "/dequeue",
			Method = "GET",
			Headers = headers(),
		})
	end)
	if not ok then
		return false, tostring(response)
	end
	if response.StatusCode == 200 then
		local decoded = HttpService:JSONDecode(response.Body)
		return decoded, nil
	elseif response.StatusCode == 204 then
		return nil, nil
	else
		return false, ("HTTP %d: %s"):format(response.StatusCode, tostring(response.Body))
	end
end

-- Post a command result back to the server.
function Bridge.respond(id: string, success: boolean, result: any, errMsg: string?)
	local payload = {
		id = id,
		ok = success,
		result = result,
		error = errMsg,
	}
	pcall(function()
		HttpService:RequestAsync({
			Url = baseUrl .. "/respond",
			Method = "POST",
			Headers = headers(),
			Body = HttpService:JSONEncode(payload),
		})
	end)
end

-- Push a Studio->server change event (used by sync).
function Bridge.postEvent(event: { [string]: any })
	pcall(function()
		HttpService:RequestAsync({
			Url = baseUrl .. "/event",
			Method = "POST",
			Headers = headers(),
			Body = HttpService:JSONEncode(event),
		})
	end)
end

-- Drive the shared sync engine on the broker from the plugin UI.
--   action = "start" | "stop" | "status" | "pull" | "push"
--   mode   = "two-way" | "studio-to-disk" | "disk-to-studio"  (for "start")
-- Returns: result table (sync status) on success, or nil + error message.
function Bridge.syncControl(action: string, mode: string?, roots: { string }?): (any, string?)
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = baseUrl .. "/plugin/sync",
			Method = "POST",
			Headers = headers(),
			Body = HttpService:JSONEncode({ action = action, mode = mode, roots = roots }),
		})
	end)
	if not ok then
		return nil, tostring(response)
	end
	if response.StatusCode == 200 then
		local decoded = HttpService:JSONDecode(response.Body)
		if decoded.ok then
			return decoded.result, nil
		end
		return nil, tostring(decoded.error)
	elseif response.StatusCode == 404 then
		return nil, "This server version doesn't support plugin-driven sync (update the MCP server)."
	end
	return nil, ("HTTP %d"):format(response.StatusCode)
end

-- Fetch current sync status from the broker.
function Bridge.syncStatus(): (any, string?)
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = baseUrl .. "/plugin/sync",
			Method = "GET",
			Headers = headers(),
		})
	end)
	if not ok then
		return nil, tostring(response)
	end
	if response.StatusCode == 200 then
		local decoded = HttpService:JSONDecode(response.Body)
		return decoded.result, nil
	end
	return nil, ("HTTP %d"):format(response.StatusCode)
end

-- Tell the broker we just connected/disconnected so the dashboard updates
-- immediately instead of waiting out the long-poll liveness window.
function Bridge.notifyPresence(connected: boolean)
	pcall(function()
		HttpService:RequestAsync({
			Url = baseUrl .. "/plugin/status",
			Method = "POST",
			Headers = headers(),
			Body = HttpService:JSONEncode({ connected = connected }),
		})
	end)
end

-- Check server reachability. Returns true if /health responds.
function Bridge.health(): boolean
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = baseUrl .. "/health",
			Method = "GET",
			Headers = headers(),
		})
	end)
	return ok and response.StatusCode == 200
end

return Bridge
