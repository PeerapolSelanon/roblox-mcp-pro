--!strict
-- Handler for manage_studio: Studio environment info + Run-mode playtest control.

local RunService = game:GetService("RunService")

local function runState(): string
	if RunService:IsEdit() then
		return "edit"
	elseif RunService:IsRunning() then
		return "running"
	else
		return "paused"
	end
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
	else
		return { ok = false, error = "unknown manage_studio action: " .. tostring(action) }
	end
end
