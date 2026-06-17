--!strict
-- Handler for manage_studio: Studio environment info + playtest control.
--
-- Two playtest flavors:
--   - "run"  : Run mode via RunService:Run() — same DataModel, server-only
--              simulation, the plugin keeps answering commands during it.
--   - "play" : real Play Solo (or multiplayer) via StudioTestService
--              (Studio Dec 2025+). The test runs in separate DataModels, so a
--              runner Script is injected that captures logs, runs the agent's
--              test_script, and ships a report back through EndTest(); the
--              launch call yields until the test ends, so it runs in its own
--              task and the agent polls action "playtest_status".

local RunService = game:GetService("RunService")

local RUNNER_NAME = "__RobloxMcpProPlaytestRunner"
-- Client-side LocalScript injected for `play` + test_script: it preloads the
-- `Test` helper, runs the agent's script in the client DataModel (where
-- PlayerGui / Character / VirtualInputManager actually live), and reports back
-- to the server runner over a RemoteEvent the server creates at runtime.
local CLIENT_NAME = "__RobloxMcpProPlaytestClient"
local CHANNEL_NAME = "__RobloxMcpProPlaytestChannel"

-- State of the (single) StudioTestService session this plugin launched.
local playtest: {
	running: boolean,
	kind: string?, -- "play" | "multiplayer"
	startedAt: number?,
	finishedAt: number?,
	report: any,
	error: string?,
} =
	{ running = false, kind = nil, startedAt = nil, finishedAt = nil, report = nil, error = nil }

local function runState(): string
	if RunService:IsEdit() then
		return "edit"
	elseif RunService:IsRunning() then
		return "running"
	else
		return "paused"
	end
end

local function studioTestService(): any?
	local ok, service = pcall(function()
		return (game :: any):GetService("StudioTestService")
	end)
	if ok and service then
		return service
	end
	return nil
end

-- Build the runner Script source. It runs inside the test session's server
-- DataModel: collects output, runs the agent's test code (if any), then ends
-- the test with a structured report. Without a test_script it simply lets the
-- game run for `duration` seconds while recording logs.
local function runnerSource(testScript: string?, duration: number): string
	local header = table.concat({
		"local STS = game:GetService(\"StudioTestService\")",
		"local LogService = game:GetService(\"LogService\")",
		"local logs = {}",
		"LogService.MessageOut:Connect(function(message, messageType)",
		"\ttable.insert(logs, { message = message, type = messageType.Name })",
		"end)",
		"local report = { ok = true, logs = logs }",
		"local ended = false",
		"local function finish()",
		"\tif ended then return end",
		"\tended = true",
		"\treport.logCount = #logs",
		-- Surface runtime errors the game itself raised during the playtest, not
		-- just test_script failures: an observe-only run must not report ok=true
		-- while game scripts were erroring. errorCount/hadErrors/errors come from
		-- the captured log; report.error stays the test_script pcall failure.
		"\tlocal errs = {}",
		"\tfor _, l in ipairs(logs) do",
		"\t\tif l.type == \"MessageError\" then errs[#errs + 1] = l.message end",
		"\tend",
		"\treport.errorCount = #errs",
		"\treport.hadErrors = #errs > 0",
		"\tlocal capped = {}",
		"\tfor i = 1, math.min(#errs, 10) do capped[i] = errs[i] end",
		"\treport.errors = capped",
		"\tif report.hadErrors then report.ok = false end",
		"\tSTS:EndTest(report)",
		"end",
		("task.delay(%d, function() report.timedOut = true finish() end)"):format(duration),
		"",
	}, "\n")

	if testScript and #testScript > 0 then
		return header
			.. "local ok, err = pcall(function()\n"
			.. testScript
			.. "\nend)\n"
			.. "report.ok = ok\n"
			.. "if not ok then report.error = tostring(err) end\n"
			.. "task.wait(0.5)\n" -- let trailing prints land in the log
			.. "finish()\n"
	end
	-- No test script: observe the game for the full duration.
	return header .. "-- observing only; ends on the timeout above\n"
end

-- The `Test` helper library, injected on the CLIENT for `play` + test_script.
-- It declares a local `Test` (and a local `LP` for the LocalPlayer) that the
-- agent's test_script can use; it intentionally does NOT `return`, so more code
-- can be concatenated after it in the same chunk. Runs in the play session's
-- client DataModel, so PlayerGui / Character are real. NOTE: Studio sandboxes
-- hardware input (VirtualInputManager / VirtualUser) in playtests — a
-- plugin-injected script lacks the RobloxScript/LocalUser capability they need,
-- so the helper drives gameplay through capability-free APIs instead (Humanoid
-- movement, focus-based text entry, firing the events controls are wired to).
local HELPER_SOURCE = [==[
local Players = game:GetService("Players")
local PathfindingService = game:GetService("PathfindingService")

local Test = {}
local LP = Players.LocalPlayer

local function humanoid(timeout)
	local char = LP.Character or LP.CharacterAdded:Wait()
	return char:WaitForChild("Humanoid", timeout or 10), char
end

-- Resolve a GuiObject/instance by a dotted path. "PlayerGui.X.Y" or a bare
-- "ScreenGui.Button" (looked up under PlayerGui), or a full game path like
-- "Workspace.Model.Part". Returns the instance or nil.
local function resolve(pathOrInst)
	if typeof(pathOrInst) == "Instance" then return pathOrInst end
	local parts = string.split(tostring(pathOrInst), ".")
	local first = parts[1]
	local root, startIdx
	if first == "PlayerGui" then
		root, startIdx = LP:WaitForChild("PlayerGui", 10), 2
	elseif first == "game" or first == "Game" then
		root, startIdx = game, 2
	else
		local pg = LP:WaitForChild("PlayerGui", 10)
		if pg and pg:FindFirstChild(first) then
			root, startIdx = pg, 1
		else
			root, startIdx = game, 1
		end
	end
	local node = root
	for i = startIdx, #parts do
		if not node then return nil end
		node = node:FindFirstChild(parts[i])
	end
	return node
end
Test.resolve = resolve
Test.find = resolve

-- Exercise the logic a control is wired to. Studio blocks synthetic mouse/key
-- input in playtests, so instead of "clicking" a button you fire the event its
-- handler listens on, or call the module it invokes.
function Test.fireRemote(path, ...)
	local r = resolve(path)
	assert(r, "Test.fireRemote: not found: " .. tostring(path))
	if r:IsA("RemoteEvent") or r:IsA("UnreliableRemoteEvent") then
		r:FireServer(...)
		return nil
	elseif r:IsA("RemoteFunction") then
		return r:InvokeServer(...)
	end
	error("Test.fireRemote: not a Remote: " .. tostring(path))
end

function Test.fireBindable(path, ...)
	local b = resolve(path)
	assert(b, "Test.fireBindable: not found: " .. tostring(path))
	if b:IsA("BindableEvent") then
		b:Fire(...)
		return nil
	elseif b:IsA("BindableFunction") then
		return b:Invoke(...)
	end
	error("Test.fireBindable: not a Bindable: " .. tostring(path))
end

function Test.invokeModule(path, fnName, ...)
	local m = resolve(path)
	assert(m and m:IsA("ModuleScript"), "Test.invokeModule: not a ModuleScript: " .. tostring(path))
	local mod = require(m)
	local fn = mod[fnName]
	assert(type(fn) == "function", "Test.invokeModule: no function '" .. tostring(fnName) .. "'")
	return fn(...)
end

-- Type into a TextBox without hardware input: focus, set the text, release
-- (pressEnter=true fires FocusLost(enterPressed=true), the usual submit path).
function Test.typeText(path, text, pressEnter)
	local box = resolve(path)
	assert(box, "Test.typeText: not found: " .. tostring(path))
	pcall(function() box:CaptureFocus() end)
	task.wait(0.05)
	box.Text = text
	task.wait(0.05)
	pcall(function() box:ReleaseFocus(pressEnter == true) end)
	return box
end

-- Synthetic hardware input is sandboxed in playtests; fail with a pointer to
-- the capability-free alternative rather than a cryptic capability error.
local function blocked(name, alt)
	return function()
		error(("Test.%s is unavailable: Studio sandboxes hardware input (VirtualInputManager/VirtualUser) in playtests. %s"):format(name, alt), 0)
	end
end
Test.click = blocked("click", "Fire the event the button is wired to with Test.fireRemote/fireBindable/invokeModule, or assert state directly.")
Test.clickAt = blocked("clickAt", "Fire the wired event with Test.fireRemote/fireBindable instead.")
Test.rightClick = blocked("rightClick", "Fire the wired event with Test.fireRemote/fireBindable instead.")
Test.doubleClick = blocked("doubleClick", "Fire the wired event with Test.fireRemote/fireBindable instead.")
Test.hover = blocked("hover", "Assert the hover target's state directly, or call its handler.")
Test.pressKey = blocked("pressKey", "Fire the action's bound event (Test.fireRemote/fireBindable) or move via Test.moveDir.")
Test.keyCombo = blocked("keyCombo", "Fire the action's bound event (Test.fireRemote/fireBindable) instead.")

local function targetPosition(target)
	if typeof(target) == "Vector3" then return target end
	local g = resolve(target)
	if not g then return nil end
	local ok, p = pcall(function() return g.Position end)
	if ok and typeof(p) == "Vector3" then return p end
	return g:GetPivot().Position
end

function Test.walkTo(target, timeout)
	local hum = humanoid()
	local pos = targetPosition(target)
	assert(pos, "Test.walkTo: bad target")
	local reached = false
	local conn = hum.MoveToFinished:Connect(function(r) reached = r end)
	hum:MoveTo(pos)
	local t0 = os.clock()
	while not reached and os.clock() - t0 < (timeout or 10) do
		task.wait()
	end
	conn:Disconnect()
	return reached
end

function Test.pathTo(target, timeout)
	local hum, char = humanoid()
	local pos = targetPosition(target)
	assert(pos, "Test.pathTo: bad target")
	timeout = timeout or 30
	local path = PathfindingService:CreatePath()
	path:ComputeAsync(char:GetPivot().Position, pos)
	if path.Status ~= Enum.PathStatus.Success then
		return false, tostring(path.Status)
	end
	local t0 = os.clock()
	for _, wp in ipairs(path:GetWaypoints()) do
		if os.clock() - t0 > timeout then return false, "timeout" end
		if wp.Action == Enum.PathWaypointAction.Jump then hum.Jump = true end
		local reached = false
		local conn = hum.MoveToFinished:Connect(function(r) reached = r end)
		hum:MoveTo(wp.Position)
		while not reached and os.clock() - t0 < timeout do
			task.wait()
		end
		conn:Disconnect()
	end
	return true
end

local DIRS = {
	w = Vector3.new(0, 0, -1), s = Vector3.new(0, 0, 1),
	a = Vector3.new(-1, 0, 0), d = Vector3.new(1, 0, 0),
}
function Test.moveDir(dir, seconds, relativeToCamera)
	local hum = humanoid()
	local v = typeof(dir) == "Vector3" and dir or DIRS[string.lower(tostring(dir))]
	assert(v, "Test.moveDir: bad dir (use w/a/s/d or a Vector3)")
	if relativeToCamera == nil then relativeToCamera = true end
	local t0 = os.clock()
	while os.clock() - t0 < (seconds or 1) do
		hum:Move(v, relativeToCamera)
		task.wait()
	end
	hum:Move(Vector3.zero, false)
end

function Test.jump()
	humanoid().Jump = true
end

function Test.wait(s)
	task.wait(s or 0.25)
end

-- assertions: raise an error tagged [assert] so it lands in report.error -----
function Test.expect(cond, msg)
	if not cond then error("[assert] " .. tostring(msg or "expectation failed"), 0) end
	return cond
end

function Test.assertExists(path)
	local g = resolve(path)
	Test.expect(g ~= nil, "does not exist: " .. tostring(path))
	return g
end

function Test.assertVisible(path)
	local g = Test.assertExists(path)
	Test.expect(g.Visible ~= false and g.AbsoluteSize.X > 0 and g.AbsoluteSize.Y > 0,
		"not visible: " .. tostring(path))
	return g
end

function Test.assertText(path, expected)
	local g = Test.assertExists(path)
	Test.expect(g.Text == expected,
		("text mismatch on %s: got %q want %q"):format(tostring(path), tostring(g.Text), tostring(expected)))
	return g
end

function Test.assertNear(target, point, tol)
	local pos
	if target == nil then
		local _, char = humanoid()
		pos = char:GetPivot().Position
	else
		pos = targetPosition(target)
	end
	Test.expect(pos ~= nil and (pos - point).Magnitude <= (tol or 4),
		"not near target (tol " .. tostring(tol or 4) .. ")")
end
]==]

-- Server-side runner pieces. The base owns log capture + EndTest; the timeout
-- guarantees the test ends; the client-wait block (added only when a client
-- driver is injected) finishes early once the client reports its result.
local SERVER_BASE = [==[
local STS = game:GetService("StudioTestService")
local LogService = game:GetService("LogService")
local logs = {}
LogService.MessageOut:Connect(function(message, messageType)
	table.insert(logs, { message = message, type = messageType.Name })
end)
local report = { ok = true, logs = logs }
local ended = false
local function finish()
	if ended then return end
	ended = true
	report.logCount = #logs
	STS:EndTest(report)
end
]==]

local function serverRunnerSource(duration: number, waitForClient: boolean): string
	local src = SERVER_BASE
		.. ("task.delay(%d, function() report.timedOut = true finish() end)\n"):format(duration)
	if waitForClient then
		src = src
			.. ('local channel = Instance.new("RemoteEvent")\n')
			.. ("channel.Name = %q\n"):format(CHANNEL_NAME)
			.. ('channel.Parent = game:GetService("ReplicatedStorage")\n')
			.. ("channel.OnServerEvent:Connect(function(_, clientReport)\n")
			.. ("\treport.client = clientReport\n")
			.. ("\treport.ok = clientReport.ok\n")
			.. ("\treport.error = clientReport.error\n")
			.. ("\ttask.wait(0.3)\n")
			.. ("\tfinish()\n")
			.. ("end)\n")
	end
	return src
end

-- The client LocalScript source: Test helper + the agent's test_script + the
-- report-back over the RemoteEvent the server created.
local function clientDriverSource(testScript: string): string
	return HELPER_SOURCE
		.. "\n"
		.. 'local LogService = game:GetService("LogService")\n'
		.. "local clientLogs = {}\n"
		.. "LogService.MessageOut:Connect(function(m, t) table.insert(clientLogs, { message = m, type = t.Name }) end)\n"
		.. "if not LP.Character then LP.CharacterAdded:Wait() end\n"
		.. 'LP:WaitForChild("PlayerGui", 10)\n'
		.. ('local channel = game:GetService("ReplicatedStorage"):WaitForChild(%q, 15)\n'):format(CHANNEL_NAME)
		.. 'local report = { ok = true, side = "client" }\n'
		.. "local ok, err = pcall(function()\n"
		.. testScript
		.. "\nend)\n"
		.. "report.ok = ok\n"
		.. "if not ok then report.error = tostring(err) end\n"
		.. "task.wait(0.3)\n"
		.. "report.logs = clientLogs\n"
		.. "report.logCount = #clientLogs\n"
		.. "if channel then channel:FireServer(report) end\n"
end

local function startPlaytest(kind: string, args: any): any
	local sts = studioTestService()
	if not sts then
		return {
			ok = false,
			error = "StudioTestService is not available in this Studio version — use action 'run' instead, or update Roblox Studio.",
		}
	end
	if playtest.running then
		return { ok = false, error = "a playtest is already running; poll action 'playtest_status'" }
	end
	if runState() ~= "edit" then
		return { ok = false, error = "Studio is already in run mode; 'stop' it first" }
	end

	local duration = math.floor(math.clamp(tonumber(args.duration) or 30, 1, 600))
	local testScript = if type(args.test_script) == "string" then args.test_script else nil
	local numPlayers = math.clamp(tonumber(args.num_players) or 1, 1, 8)

	-- `play` + a test_script runs the script (and the `Test` helper) on the
	-- CLIENT, where PlayerGui / Character / VirtualInputManager exist; the
	-- server runner just owns EndTest and waits for the client's report. Without
	-- a test_script (observe only) or in multiplayer, the original server-side
	-- runner is used unchanged.
	local useClientDriver = kind == "play" and testScript ~= nil and #testScript > 0

	-- Transient instances live in the edit DataModel only between creation and
	-- launch; they're cloned into the test session and removed here afterwards.
	-- The runner lives in Workspace (not a synced root) so the sync engine
	-- doesn't mirror this transient script to disk.
	local created: { Instance } = {}

	local runner = Instance.new("Script")
	runner.Name = RUNNER_NAME
	runner.Source = if useClientDriver
		then serverRunnerSource(duration, true)
		else runnerSource(testScript, duration)
	runner.Parent = game:GetService("Workspace")
	table.insert(created, runner)

	if useClientDriver then
		-- A LocalScript in StarterPlayerScripts runs once on the joining client.
		local sps = game:GetService("StarterPlayer"):WaitForChild("StarterPlayerScripts")
		local client = Instance.new("LocalScript")
		client.Name = CLIENT_NAME
		client.Source = clientDriverSource(testScript :: string)
		client.Parent = sps
		table.insert(created, client)
	end

	playtest.running = true
	playtest.kind = kind
	playtest.startedAt = os.time()
	playtest.finishedAt = nil
	playtest.report = nil
	playtest.error = nil

	task.spawn(function()
		-- ExecutePlayModeAsync(args) / ExecuteMultiplayerTestAsync(numPlayers, args)
		-- both REQUIRE a non-nil args (Variant); passing nil throws
		-- "Argument 1 missing or nil". args are readable in the test session via
		-- StudioTestService:GetTestArgs().
		local testArgs = { duration = duration }
		local ok, result = pcall(function()
			if kind == "multiplayer" then
				return sts:ExecuteMultiplayerTestAsync(numPlayers, testArgs)
			end
			return sts:ExecutePlayModeAsync(testArgs)
		end)
		playtest.running = false
		playtest.finishedAt = os.time()
		if ok then
			playtest.report = result
		else
			playtest.error = tostring(result)
		end
		-- Remove the transient runners from the edit DataModel.
		for _, inst in ipairs(created) do
			pcall(function()
				if inst and inst.Parent then
					inst:Destroy()
				end
			end)
		end
		pcall(function()
			local leftover = game:GetService("Workspace"):FindFirstChild(RUNNER_NAME)
			if leftover then
				leftover:Destroy()
			end
		end)
	end)

	return {
		ok = true,
		kind = kind,
		started_at = playtest.startedAt,
		duration = duration,
		players = if kind == "multiplayer" then numPlayers else nil,
		note = if useClientDriver
			then "playtest launched (client Test helper active); poll action 'playtest_status' for the report"
			else "playtest launched; poll action 'playtest_status' for the report",
	}
end

local function playtestStatus(): any
	return {
		ok = true,
		running = playtest.running,
		kind = playtest.kind,
		started_at = playtest.startedAt,
		finished_at = playtest.finishedAt,
		report = playtest.report,
		error = playtest.error,
	}
end

return function(args: any): any
	local action = args.action or "info"

	if action == "info" then
		local themeName: string? = nil
		pcall(function()
			themeName = settings().Studio.Theme.Name
		end)
		return {
			ok = true,
			studioVersion = version(),
			theme = themeName,
			runState = runState(),
			isRunning = RunService:IsRunning(),
			isEdit = RunService:IsEdit(),
			placeId = game.PlaceId,
			gameId = game.GameId,
			playtest = if playtest.running then "running" else nil,
			playSoloAvailable = studioTestService() ~= nil,
		}
	elseif action == "run" then
		local state = runState()
		if state == "running" then
			return { ok = false, error = "already running; use action 'stop' first" }
		end
		local startedAt = os.time()
		RunService:Run()
		return {
			ok = true,
			runState = "running",
			resumed = state == "paused",
			started_at = startedAt,
		}
	elseif action == "pause" then
		if runState() ~= "running" then
			return { ok = false, error = "not running (state: " .. runState() .. ")" }
		end
		RunService:Pause()
		return { ok = true, runState = "paused" }
	elseif action == "stop" then
		if runState() == "edit" then
			return { ok = false, error = "not in run mode" }
		end
		RunService:Stop()
		return {
			ok = true,
			runState = "edit",
			-- RunService:Stop() (unlike the Studio Stop button) does NOT revert
			-- DataModel changes made during the run; surface that to the agent.
			note = "changes made during the run persist; inspect/clean up if needed",
		}
	elseif action == "play" then
		return startPlaytest("play", args)
	elseif action == "multiplayer" then
		return startPlaytest("multiplayer", args)
	elseif action == "playtest_status" then
		return playtestStatus()
	else
		return { ok = false, error = "unknown manage_studio action: " .. tostring(action) }
	end
end
