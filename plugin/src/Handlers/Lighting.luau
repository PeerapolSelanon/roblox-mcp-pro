--!strict
-- Handler for manage_lighting: read/write Lighting service properties.

local Lighting = game:GetService("Lighting")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Serialize = require(script.Parent.Parent.Serialize)

local LIGHTING_PROPS = {
	"Ambient", "OutdoorAmbient", "Brightness", "ClockTime", "GeographicLatitude",
	"FogColor", "FogStart", "FogEnd", "ExposureCompensation", "EnvironmentDiffuseScale",
	"EnvironmentSpecularScale", "GlobalShadows", "ShadowSoftness", "Technology",
}

return function(args: any): any
	local action = args.action or "get"
	if action == "get" then
		local props = {}
		for _, name in LIGHTING_PROPS do
			local ok, val = pcall(function()
				return (Lighting :: any)[name]
			end)
			if ok then
				props[name] = Serialize.value(val)
			end
		end
		return { ok = true, properties = props }
	elseif action == "set" then
		local recording = ChangeHistoryService:TryBeginRecording("MCP manage_lighting")
		local err = Serialize.applyProperties(Lighting, args.properties)
		if recording then
			ChangeHistoryService:FinishRecording(
				recording,
				err == nil and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
			)
		end
		return { ok = err == nil, error = err }
	else
		return { ok = false, error = "unknown manage_lighting action: " .. tostring(action) }
	end
end
