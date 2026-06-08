--!strict
-- UI: the Roblox MCP Pro plugin panel inside a DockWidget.
--
-- Scope by design: the plugin's only job is to CONNECT. Status, the connect
-- button, and the connection settings (server URL, token, auto-connect) live
-- here. Everything else — sync, activity, configuration — is driven from the
-- web dashboard at http://127.0.0.1:3690/. Colors come from the live Studio
-- theme (dark/light) with one ember accent that matches the dashboard.

local TweenService = game:GetService("TweenService")

local UI = {}

-- Ember accent — matches the web dashboard and landing page. Theme-independent
-- so the brand color reads the same in dark or light Studio themes.
local ACCENT = Color3.fromRGB(232, 99, 58)
local ACCENT_HOVER = Color3.fromRGB(240, 124, 78)
local ACCENT_PRESSED = Color3.fromRGB(201, 80, 31)
local WHITE = Color3.fromRGB(255, 255, 255)

local DASHBOARD_URL = "http://127.0.0.1:3690/"

-- State callbacks (wired up by init.server.luau).
UI.onSettingsSaved = nil :: ((url: string, token: string?) -> ())?
UI.onConnectionToggled = nil :: ((connect: boolean) -> ())?
UI.onAutoConnectChanged = nil :: ((enabled: boolean) -> ())?

-- UI references
local statusIndicator: Frame? = nil
local statusLabel: TextLabel? = nil
local toggleButton: TextButton? = nil
local urlInput: TextBox? = nil
local tokenInput: TextBox? = nil

local isConnected = false

-- ── Theme registry ────────────────────────────────────────────────────────────
type ThemeItem = {
	element: Instance,
	property: string,
	styleColor: Enum.StudioStyleGuideColor,
	modifier: Enum.StudioStyleGuideModifier?,
}
local themeRegistry: { ThemeItem } = {}

local function registerTheme(
	element: Instance,
	property: string,
	styleColor: Enum.StudioStyleGuideColor,
	modifier: Enum.StudioStyleGuideModifier?
)
	table.insert(themeRegistry, {
		element = element,
		property = property,
		styleColor = styleColor,
		modifier = modifier,
	})
end

local function themeColor(styleColor: Enum.StudioStyleGuideColor, modifier: Enum.StudioStyleGuideModifier?): Color3
	return settings().Studio.Theme:GetColor(styleColor, modifier or Enum.StudioStyleGuideModifier.Default)
end

local function applyTheme()
	for _, item in themeRegistry do
		local ok, color = pcall(themeColor, item.styleColor, item.modifier)
		if ok then
			(item.element :: any)[item.property] = color
		end
	end
end

settings().Studio.ThemeChanged:Connect(applyTheme)

-- ── Small builder helpers ───────────────────────────────────────────────────────
local function fill(element: GuiObject): UIFlexItem
	local flex = Instance.new("UIFlexItem")
	flex.FlexMode = Enum.UIFlexMode.Fill
	flex.Parent = element
	return flex
end

local function listLayout(
	parent: Instance,
	direction: Enum.FillDirection,
	padding: number,
	vAlign: Enum.VerticalAlignment?
): UIListLayout
	local layout = Instance.new("UIListLayout")
	layout.FillDirection = direction
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Padding = UDim.new(0, padding)
	if vAlign then
		layout.VerticalAlignment = vAlign
	end
	layout.Parent = parent
	return layout
end

local function uiPadding(parent: Instance, amount: number)
	local pad = Instance.new("UIPadding")
	pad.PaddingTop = UDim.new(0, amount)
	pad.PaddingBottom = UDim.new(0, amount)
	pad.PaddingLeft = UDim.new(0, amount)
	pad.PaddingRight = UDim.new(0, amount)
	pad.Parent = parent
end

local function corner(parent: Instance, radius: number)
	local c = Instance.new("UICorner")
	c.CornerRadius = UDim.new(0, radius)
	c.Parent = parent
end

-- A transparent row container that auto-sizes its height.
local function row(parent: Instance, layoutOrder: number, height: number?): Frame
	local r = Instance.new("Frame")
	r.Name = "Row"
	r.BackgroundTransparency = 1
	r.BorderSizePixel = 0
	r.LayoutOrder = layoutOrder
	if height then
		r.Size = UDim2.new(1, 0, 0, height)
	else
		r.Size = UDim2.new(1, 0, 0, 0)
		r.AutomaticSize = Enum.AutomaticSize.Y
	end
	r.Parent = parent
	return r
end

local function label(
	parent: Instance,
	text: string,
	fontSize: number,
	font: Enum.Font,
	styleColor: Enum.StudioStyleGuideColor,
	layoutOrder: number?
): TextLabel
	local l = Instance.new("TextLabel")
	l.Text = text
	l.TextSize = fontSize
	l.Font = font
	l.BackgroundTransparency = 1
	l.BorderSizePixel = 0
	l.AutomaticSize = Enum.AutomaticSize.XY
	l.Size = UDim2.new(0, 0, 0, 0)
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.TextYAlignment = Enum.TextYAlignment.Center
	if layoutOrder then
		l.LayoutOrder = layoutOrder
	end
	l.Parent = parent
	registerTheme(l, "TextColor3", styleColor)
	return l
end

local function spacer(parent: Instance, layoutOrder: number): Frame
	local s = Instance.new("Frame")
	s.Name = "Spacer"
	s.BackgroundTransparency = 1
	s.BorderSizePixel = 0
	s.Size = UDim2.new(0, 0, 1, 0)
	s.LayoutOrder = layoutOrder
	s.Parent = parent
	fill(s)
	return s
end

local function tweenColor(instance: Instance, property: string, targetColor: Color3, duration: number)
	local info = TweenInfo.new(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
	TweenService:Create(instance, info, { [property] = targetColor }):Play()
end

-- A small themed button.
local function button(parent: Instance, text: string, width: number, layoutOrder: number): TextButton
	local b = Instance.new("TextButton")
	b.Text = text
	b.TextSize = 12
	b.Font = Enum.Font.GothamMedium
	b.BorderSizePixel = 0
	b.AutoButtonColor = false
	b.Size = UDim2.new(0, width, 0, 26)
	b.LayoutOrder = layoutOrder
	b.Parent = parent
	corner(b, 5)
	registerTheme(b, "BackgroundColor3", Enum.StudioStyleGuideColor.Button)
	registerTheme(b, "TextColor3", Enum.StudioStyleGuideColor.ButtonText)

	b.MouseEnter:Connect(function()
		tweenColor(b, "BackgroundColor3", themeColor(Enum.StudioStyleGuideColor.Button, Enum.StudioStyleGuideModifier.Hover), 0.15)
	end)
	b.MouseLeave:Connect(function()
		tweenColor(b, "BackgroundColor3", themeColor(Enum.StudioStyleGuideColor.Button, Enum.StudioStyleGuideModifier.Default), 0.15)
	end)
	return b
end

-- A full-width ember button for the primary action.
local function primaryButton(parent: Instance, text: string, layoutOrder: number): TextButton
	local b = Instance.new("TextButton")
	b.Text = text
	b.TextSize = 13
	b.Font = Enum.Font.GothamBold
	b.BorderSizePixel = 0
	b.AutoButtonColor = false
	b.Size = UDim2.new(1, 0, 0, 32)
	b.LayoutOrder = layoutOrder
	b.BackgroundColor3 = ACCENT
	b.TextColor3 = WHITE
	b.Parent = parent
	corner(b, 6)

	b.MouseEnter:Connect(function()
		tweenColor(b, "BackgroundColor3", ACCENT_HOVER, 0.15)
	end)
	b.MouseLeave:Connect(function()
		tweenColor(b, "BackgroundColor3", ACCENT, 0.15)
	end)
	b.MouseButton1Down:Connect(function()
		tweenColor(b, "BackgroundColor3", ACCENT_PRESSED, 0.08)
	end)
	b.MouseButton1Up:Connect(function()
		tweenColor(b, "BackgroundColor3", ACCENT_HOVER, 0.15)
	end)
	return b
end

local function input(parent: Instance, placeholder: string, layoutOrder: number): TextBox
	local box = Instance.new("TextBox")
	box.Text = ""
	box.PlaceholderText = placeholder
	box.TextSize = 12
	box.Font = Enum.Font.Code
	box.BorderSizePixel = 0
	box.ClearTextOnFocus = false
	box.TextXAlignment = Enum.TextXAlignment.Left
	box.TextTruncate = Enum.TextTruncate.AtEnd
	box.Size = UDim2.new(1, 0, 0, 28)
	box.LayoutOrder = layoutOrder
	box.Parent = parent
	corner(box, 5)

	local stroke = Instance.new("UIStroke")
	stroke.Thickness = 1
	stroke.Parent = box
	registerTheme(stroke, "Color", Enum.StudioStyleGuideColor.Border)

	local pad = Instance.new("UIPadding")
	pad.PaddingLeft = UDim.new(0, 8)
	pad.PaddingRight = UDim.new(0, 8)
	pad.Parent = box

	registerTheme(box, "BackgroundColor3", Enum.StudioStyleGuideColor.InputFieldBackground)
	registerTheme(box, "TextColor3", Enum.StudioStyleGuideColor.MainText)
	registerTheme(box, "PlaceholderColor3", Enum.StudioStyleGuideColor.DimmedText)

	box.Focused:Connect(function()
		TweenService:Create(stroke, TweenInfo.new(0.15, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { Color = ACCENT }):Play()
	end)
	box.FocusLost:Connect(function()
		TweenService:Create(stroke, TweenInfo.new(0.15, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { Color = themeColor(Enum.StudioStyleGuideColor.Border) }):Play()
	end)
	return box
end

-- A bordered card with a vertical inner layout, auto-sizing to its content.
local function card(parent: Instance, layoutOrder: number): Frame
	local c = Instance.new("Frame")
	c.Name = "Card"
	c.BorderSizePixel = 0
	c.LayoutOrder = layoutOrder
	c.Size = UDim2.new(1, 0, 0, 0)
	c.AutomaticSize = Enum.AutomaticSize.Y
	c.Parent = parent
	registerTheme(c, "BackgroundColor3", Enum.StudioStyleGuideColor.TableItem)

	corner(c, 8)
	local stroke = Instance.new("UIStroke")
	stroke.Thickness = 1
	stroke.Parent = c
	registerTheme(stroke, "Color", Enum.StudioStyleGuideColor.Border)

	uiPadding(c, 12)
	listLayout(c, Enum.FillDirection.Vertical, 9)
	return c
end

-- A sliding on/off switch. Returns a setter to update its visual state.
local function toggleSwitch(
	parent: Instance,
	layoutOrder: number,
	initialOn: boolean,
	onChange: (boolean) -> ()
): (boolean) -> ()
	local track = Instance.new("Frame")
	track.Name = "Toggle"
	track.Size = UDim2.new(0, 40, 0, 22)
	track.BorderSizePixel = 0
	track.LayoutOrder = layoutOrder
	track.Parent = parent
	corner(track, 11)

	local stroke = Instance.new("UIStroke")
	stroke.Thickness = 1
	stroke.Parent = track
	registerTheme(stroke, "Color", Enum.StudioStyleGuideColor.Border)

	local knob = Instance.new("Frame")
	knob.Name = "Knob"
	knob.Size = UDim2.new(0, 14, 0, 14)
	knob.BorderSizePixel = 0
	knob.BackgroundColor3 = WHITE
	knob.Parent = track
	corner(knob, 7)

	local state = initialOn

	local function apply(animate: boolean)
		local duration = if animate then 0.18 else 0
		local targetPos = if state then UDim2.new(1, -17, 0.5, -7) else UDim2.new(0, 3, 0.5, -7)
		local targetColor = if state then ACCENT else themeColor(Enum.StudioStyleGuideColor.InputFieldBackground)
		local targetBorderColor = if state then ACCENT else themeColor(Enum.StudioStyleGuideColor.Border)

		local info = TweenInfo.new(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
		TweenService:Create(knob, info, { Position = targetPos }):Play()
		TweenService:Create(track, info, { BackgroundColor3 = targetColor }):Play()
		TweenService:Create(stroke, info, { Color = targetBorderColor }):Play()
	end
	apply(false)

	local hit = Instance.new("TextButton")
	hit.Text = ""
	hit.BackgroundTransparency = 1
	hit.Size = UDim2.new(1, 0, 1, 0)
	hit.Parent = track
	hit.MouseButton1Click:Connect(function()
		state = not state
		apply(true)
		onChange(state)
	end)

	return function(on: boolean)
		if state == on then return end
		state = on
		apply(true)
	end
end

-- ── Build the panel ─────────────────────────────────────────────────────────────
function UI.create(
	widget: DockWidgetPluginGui,
	initialSettings: {
		url: string,
		token: string?,
		autoConnect: boolean?,
	}
)
	widget.Title = "Roblox MCP Pro"
	themeRegistry = {}

	-- Clear any previous build (Studio reloads re-run this module).
	for _, child in widget:GetChildren() do
		child:Destroy()
	end

	local root = Instance.new("ScrollingFrame")
	root.Name = "Root"
	root.Size = UDim2.new(1, 0, 1, 0)
	root.BorderSizePixel = 0
	root.ScrollBarThickness = 6
	root.CanvasSize = UDim2.new(0, 0, 0, 0)
	root.AutomaticCanvasSize = Enum.AutomaticSize.Y
	root.ScrollingDirection = Enum.ScrollingDirection.Y
	root.Parent = widget
	registerTheme(root, "BackgroundColor3", Enum.StudioStyleGuideColor.MainBackground)
	registerTheme(root, "ScrollBarImageColor3", Enum.StudioStyleGuideColor.ScrollBar)
	uiPadding(root, 10)
	listLayout(root, Enum.FillDirection.Vertical, 10)

	-- ── Header ──
	local header = row(root, 0, 32)
	listLayout(header, Enum.FillDirection.Horizontal, 6, Enum.VerticalAlignment.Center)

	local logo = Instance.new("Frame")
	logo.Name = "Logo"
	logo.Size = UDim2.new(0, 20, 0, 20)
	logo.BackgroundColor3 = ACCENT
	logo.LayoutOrder = 1
	logo.Parent = header
	corner(logo, 5)

	local logoMark = Instance.new("Frame")
	logoMark.Size = UDim2.new(0, 9, 0, 9)
	logoMark.Position = UDim2.new(0.5, -4, 0.5, -4)
	logoMark.BorderSizePixel = 0
	logoMark.BackgroundColor3 = Color3.fromRGB(21, 15, 12)
	logoMark.Parent = logo
	corner(logoMark, 2)

	label(header, "Roblox MCP Pro", 14, Enum.Font.GothamBold, Enum.StudioStyleGuideColor.MainText, 2)

	-- ── Connection card ──
	local connCard = card(root, 1)
	local connRow = row(connCard, 1, 24)
	listLayout(connRow, Enum.FillDirection.Horizontal, 8, Enum.VerticalAlignment.Center)

	statusIndicator = Instance.new("Frame")
	local dot = statusIndicator :: Frame
	dot.Name = "Dot"
	dot.Size = UDim2.new(0, 10, 0, 10)
	dot.BorderSizePixel = 0
	dot.BackgroundColor3 = Color3.fromRGB(149, 165, 166)
	dot.LayoutOrder = 1
	dot.Parent = connRow
	corner(dot, 5)

	statusLabel = label(connRow, "Disconnected", 14, Enum.Font.GothamMedium, Enum.StudioStyleGuideColor.MainText, 2)

	toggleButton = primaryButton(connCard, "Connect", 2)
	;(toggleButton :: TextButton).MouseButton1Click:Connect(function()
		if UI.onConnectionToggled then
			UI.onConnectionToggled(not isConnected)
		end
	end)

	-- ── Settings card ──
	local settingsCard = card(root, 2)
	label(settingsCard, "CONNECTION", 10, Enum.Font.GothamBold, Enum.StudioStyleGuideColor.DimmedText, 1)

	local autoRow = row(settingsCard, 2, 24)
	listLayout(autoRow, Enum.FillDirection.Horizontal, 8, Enum.VerticalAlignment.Center)
	label(autoRow, "Auto-connect on startup", 12, Enum.Font.Gotham, Enum.StudioStyleGuideColor.MainText, 1)
	spacer(autoRow, 2)
	toggleSwitch(autoRow, 3, initialSettings.autoConnect == true, function(on: boolean)
		if UI.onAutoConnectChanged then
			UI.onAutoConnectChanged(on)
		end
	end)

	label(settingsCard, "Server URL", 11, Enum.Font.Gotham, Enum.StudioStyleGuideColor.DimmedText, 3)
	urlInput = input(settingsCard, "http://127.0.0.1:3690", 4)
	;(urlInput :: TextBox).Text = initialSettings.url

	label(settingsCard, "Auth Token (optional)", 11, Enum.Font.Gotham, Enum.StudioStyleGuideColor.DimmedText, 5)
	tokenInput = input(settingsCard, "shared secret", 6)
	;(tokenInput :: TextBox).Text = initialSettings.token or ""

	local applyRow = row(settingsCard, 7, 26)
	listLayout(applyRow, Enum.FillDirection.Horizontal, 8, Enum.VerticalAlignment.Center)
	spacer(applyRow, 1)
	local applyBtn = button(applyRow, "Apply", 80, 2)
	applyBtn.MouseButton1Click:Connect(function()
		if UI.onSettingsSaved and urlInput and tokenInput then
			local t = tokenInput.Text
			UI.onSettingsSaved(urlInput.Text, if t == "" then nil else t)
		end
	end)

	-- ── Footer hint ──
	local hint = label(
		root,
		"Sync, activity & settings live in the dashboard:\n" .. DASHBOARD_URL,
		11,
		Enum.Font.Gotham,
		Enum.StudioStyleGuideColor.DimmedText,
		3
	)
	hint.TextWrapped = true
	hint.TextXAlignment = Enum.TextXAlignment.Left
	hint.Size = UDim2.new(1, 0, 0, 0)
	hint.AutomaticSize = Enum.AutomaticSize.Y

	applyTheme()
end

-- ── Public API ──────────────────────────────────────────────────────────────────

-- Update the connection status shown in the UI. statusLabel color is driven
-- manually here (not via registerTheme) so we never grow themeRegistry.
function UI.setStatus(status: string)
	if not statusLabel or not statusIndicator or not toggleButton then
		return
	end
	local lbl = statusLabel :: TextLabel
	local ind = statusIndicator :: Frame
	local btn = toggleButton :: TextButton

	lbl.Text = status

	local targetColor
	if status == "Connected" then
		isConnected = true
		targetColor = Color3.fromRGB(46, 204, 113) -- green
		btn.Text = "Disconnect"
	elseif status == "Connecting" or status == "Reconnecting" then
		isConnected = true
		targetColor = Color3.fromRGB(241, 196, 15) -- amber
		btn.Text = "Disconnect"
	elseif status == "Offline" then
		-- Server unreachable but the poll loop keeps retrying, so keep "Disconnect".
		isConnected = true
		targetColor = Color3.fromRGB(231, 76, 60) -- red
		btn.Text = "Disconnect"
	else
		isConnected = false
		targetColor = themeColor(Enum.StudioStyleGuideColor.DimmedText)
		btn.Text = "Connect"
	end

	local info = TweenInfo.new(0.2, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
	TweenService:Create(ind, info, { BackgroundColor3 = targetColor }):Play()
	TweenService:Create(lbl, info, { TextColor3 = targetColor }):Play()
end

return UI
