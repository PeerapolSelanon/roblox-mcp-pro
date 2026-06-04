--!strict
-- Handler for workspace_state: a high-level read-only snapshot of the session.

local Workspace = game:GetService("Workspace")
local Selection = game:GetService("Selection")
local RunService = game:GetService("RunService")
local Serialize = require(script.Parent.Parent.Serialize)

local SUMMARY_SERVICES = {
	"Workspace", "ServerScriptService", "ServerStorage", "ReplicatedStorage",
	"ReplicatedFirst", "StarterGui", "StarterPack", "StarterPlayer", "Lighting",
}

return function(_args: any): any
	local services = {}
	for _, name in SUMMARY_SERVICES do
		local ok, svc = pcall(function()
			return game:GetService(name :: any)
		end)
		if ok and svc then
			services[name] = #svc:GetChildren()
		end
	end

	local camera = Workspace.CurrentCamera
	local selectionCount = #Selection:Get()

	return {
		ok = true,
		placeId = game.PlaceId,
		placeName = game.Name,
		isRunning = RunService:IsRunning(),
		gravity = Workspace.Gravity,
		childCounts = services,
		selectionCount = selectionCount,
		camera = camera and {
			position = Serialize.value(camera.CFrame.Position),
			fieldOfView = camera.FieldOfView,
		} or nil,
	}
end
