--!strict
-- Handler for ui_preview: render a GUI full-screen in EDIT mode on a solid
-- backdrop (via CoreGui) so capture_studio gets a clean, isolated shot to
-- compare against a mockup — without the 3D viewport behind it. Plugins are
-- allowed to parent a ScreenGui into CoreGui, and it renders over the viewport.
--   action = "show" (clone target onto backdrop) | "hide" (remove preview)

local CoreGui = game:GetService("CoreGui")
local Serialize = require(script.Parent.Parent.Serialize)

local PREVIEW_NAME = "MCP_UIPreview"

local function clearPreview()
	local existing = CoreGui:FindFirstChild(PREVIEW_NAME)
	if existing then
		existing:Destroy()
	end
end

return function(args: any): any
	local action = args.action or "show"
	if action == "hide" then
		clearPreview()
		return { ok = true, showing = false }
	end

	local path = args.path
	if not path then
		return { ok = false, error = "ui_preview 'show' needs a path to a GUI (ScreenGui/Frame/...)" }
	end
	local target = Serialize.resolve(path)
	if not target then
		return { ok = false, error = "path not found: " .. tostring(path) }
	end
	if not (target:IsA("LayerCollector") or target:IsA("GuiObject")) then
		return { ok = false, error = "target is not a GUI (need ScreenGui/Frame/TextLabel/...)" }
	end

	clearPreview()

	local holder = Instance.new("ScreenGui")
	holder.Name = PREVIEW_NAME
	holder.ResetOnSpawn = false
	holder.IgnoreGuiInset = true
	holder.DisplayOrder = 1000000 -- sit above other UI
	holder.ZIndexBehavior = Enum.ZIndexBehavior.Sibling

	local bg = Instance.new("Frame")
	bg.Name = "Backdrop"
	bg.Size = UDim2.fromScale(1, 1)
	bg.BorderSizePixel = 0
	local c = args.background -- optional [r,g,b] 0-1
	if type(c) == "table" then
		bg.BackgroundColor3 = Color3.new(tonumber(c[1]) or 0.12, tonumber(c[2]) or 0.12, tonumber(c[3]) or 0.14)
	else
		bg.BackgroundColor3 = Color3.fromRGB(30, 30, 36)
	end
	bg.Parent = holder

	-- Clone the visual content onto the backdrop (originals stay untouched).
	local cloned = 0
	if target:IsA("LayerCollector") then
		for _, child in target:GetChildren() do
			if child:IsA("GuiObject") then
				local copy = child:Clone()
				copy.Parent = bg
				cloned += 1
			end
		end
	else
		local copy = target:Clone()
		copy.Parent = bg
		cloned += 1
	end

	holder.Parent = CoreGui
	return { ok = true, showing = true, name = PREVIEW_NAME, cloned = cloned }
end
