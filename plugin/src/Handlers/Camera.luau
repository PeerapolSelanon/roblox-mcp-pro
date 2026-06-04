--!strict
-- Handler for manage_camera: read/control Workspace.CurrentCamera.

local Workspace = game:GetService("Workspace")
local Serialize = require(script.Parent.Parent.Serialize)

local function toVector3(t: any, default: Vector3?): Vector3
	if type(t) == "table" then
		return Vector3.new(t.x or t[1] or 0, t.y or t[2] or 0, t.z or t[3] or 0)
	end
	return default or Vector3.zero
end

return function(args: any): any
	local camera = Workspace.CurrentCamera
	if not camera then
		return { ok = false, error = "no CurrentCamera" }
	end
	local action = args.action or "get"

	if action == "get" then
		return {
			ok = true,
			cframe = Serialize.value(camera.CFrame),
			position = Serialize.value(camera.CFrame.Position),
			fieldOfView = camera.FieldOfView,
			cameraType = camera.CameraType.Name,
		}
	elseif action == "set" then
		local err = Serialize.applyProperties(camera, args.properties)
		return { ok = err == nil, error = err }
	elseif action == "focus" then
		-- Point the camera from `position` toward a target point or instance.
		local targetPos: Vector3
		if args.target_path then
			local inst = Serialize.resolve(args.target_path)
			if inst and inst:IsA("BasePart") then
				targetPos = inst.Position
			elseif inst and inst:IsA("Model") then
				targetPos = inst:GetPivot().Position
			else
				return { ok = false, error = "target_path not found or has no position" }
			end
		else
			targetPos = toVector3(args.look_at)
		end
		local fromPos = args.position and toVector3(args.position) or (targetPos + Vector3.new(0, 10, 20))
		camera.CFrame = CFrame.lookAt(fromPos, targetPos)
		return { ok = true, cframe = Serialize.value(camera.CFrame) }
	else
		return { ok = false, error = "unknown manage_camera action: " .. tostring(action) }
	end
end
