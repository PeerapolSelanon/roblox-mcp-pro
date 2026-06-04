--!strict
-- Handler for manage_tween: animate an instance's properties with TweenService.

local TweenService = game:GetService("TweenService")
local Serialize = require(script.Parent.Parent.Serialize)

local function enumFrom(enumType: Enum, name: any, default: EnumItem): EnumItem
	if type(name) == "string" then
		for _, item in enumType:GetEnumItems() do
			if item.Name == name then
				return item
			end
		end
	end
	return default
end

return function(args: any): any
	local inst = args.path and Serialize.resolve(args.path) or nil
	if not inst then
		return { ok = false, error = "path not found: " .. tostring(args.path) }
	end
	if type(args.properties) ~= "table" then
		return { ok = false, error = "tween requires a 'properties' goal map" }
	end

	-- Coerce each goal value to the property's current type.
	local goal: { [string]: any } = {}
	for key, raw in pairs(args.properties) do
		local ok, coerced = Serialize.coerce(inst, key, raw)
		if not ok then
			return { ok = false, error = ("goal '%s': %s"):format(key, tostring(coerced)) }
		end
		goal[key] = coerced
	end

	local info = TweenInfo.new(
		args.duration or 1,
		enumFrom(Enum.EasingStyle, args.easing_style, Enum.EasingStyle.Quad) :: Enum.EasingStyle,
		enumFrom(Enum.EasingDirection, args.easing_direction, Enum.EasingDirection.Out) :: Enum.EasingDirection,
		args.repeat_count or 0,
		args.reverses == true,
		args.delay_time or 0
	)

	local okCreate, tween = pcall(function()
		return TweenService:Create(inst, info, goal)
	end)
	if not okCreate or not tween then
		return { ok = false, error = "failed to create tween: " .. tostring(tween) }
	end
	tween:Play()
	return { ok = true, path = Serialize.path(inst), duration = args.duration or 1 }
end
