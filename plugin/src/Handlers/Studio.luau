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

	-- The runner lives in Workspace (not a synced root) so the sync engine
	-- doesn't mirror this transient script to disk.
	local runner = Instance.new("Script")
	runner.Name = RUNNER_NAME
	runner.Source = runnerSource(testScript, duration)
	runner.Parent = game:GetService("Workspace")

	playtest.running = true
	playtest.kind = kind
	playtest.startedAt = os.time()
	playtest.finishedAt = nil
	playtest.report = nil
	playtest.error = nil

	task.spawn(function()
		local ok, result = pcall(function()
			if kind == "multiplayer" then
				return sts:ExecuteMultiplayerTestAsync(numPlayers, nil)
			end
			return sts:ExecutePlayModeAsync(nil)
		end)
		playtest.running = false
		playtest.finishedAt = os.time()
		if ok then
			playtest.report = result
		else
			playtest.error = tostring(result)
		end
		-- Remove the transient runner from the edit DataModel.
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
		note = "playtest launched; poll action 'playtest_status' for the report",
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
