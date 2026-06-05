--!strict
-- UI: builds the Roblox MCP Pro plugin panel inside a DockWidget.
--
-- The root is a ScrollingFrame stacking cards: Connection, Settings, Sync,
-- Activity, plus a footer. Cards auto-size to content; the whole panel scrolls
-- when the dock is short. Colors come from the live Studio theme (so it matches
-- dark/light) with one accent color for primary actions and active states, kept
-- in sync with the web dashboard.

local StudioService = game:GetService("StudioService")
local HttpService = game:GetService("HttpService")

local UI = {}

-- Accent (matches the web dashboard's blue). Theme-independent on purpose.
local ACCENT = Color3.fromRGB(88, 166, 255)
local ACCENT_HOVER = Color3.fromRGB(115, 184, 255)
local WHITE = Color3.fromRGB(255, 255, 255)

-- Direction labels shown in the Sync card.
local MODE_LABELS: { [string]: string } = {
	["two-way"] = "Two-way",
	["studio-to-disk"] = "Studio → Disk",
	["disk-to-studio"] = "Disk → Studio",
}

-- State callbacks (wired up by init.server.luau)
UI.onSettingsSaved = nil :: ((url: string, token: string?) -> ())?
UI.onConnectionToggled = nil :: ((connect: boolean) -> ())?
UI.onAutoConnectChanged = nil :: ((enabled: boolean) -> ())?
UI.onSyncToggled = nil :: ((enabled: boolean, mode: string) -> ())?
UI.onSyncModeChanged = nil :: ((mode: string) -> ())?

-- UI references
local statusIndicator: Frame? = nil
local statusLabel: TextLabel? = nil
local toggleButton: TextButton? = nil
local urlInput: TextBox? = nil
local tokenInput: TextBox? = nil
local statsLabel: TextLabel? = nil
local logContainer: ScrollingFrame? = nil
local syncStatusLabel: TextLabel? = nil
local setSyncToggleVisual: ((on: boolean) -> ())? = nil
local setSegmentedVisual: ((value: string) -> ())? = nil

-- Activity stats
local isConnected = false
local syncRunning = false
local syncMode = "two-way"
local totalRequests = 0
local successRequests = 0

local MAX_LOG_ROWS = 60

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

-- A transparent row container (its own list layout) that auto-sizes its height.
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
		b.BackgroundColor3 = themeColor(Enum.StudioStyleGuideColor.Button, Enum.StudioStyleGuideModifier.Hover)
	end)
	b.MouseLeave:Connect(function()
		b.BackgroundColor3 = themeColor(Enum.StudioStyleGuideColor.Button, Enum.StudioStyleGuideModifier.Default)
	end)
	b.MouseButton1Down:Connect(function()
		b.BackgroundColor3 = themeColor(Enum.StudioStyleGuideColor.Button, Enum.StudioStyleGuideModifier.Pressed)
	end)
	return b
end

-- A full-width accent button for the primary action.
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
		b.BackgroundColor3 = ACCENT_HOVER
	end)
	b.MouseLeave:Connect(function()
		b.BackgroundColor3 = ACCENT
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
	local pad = Instance.new("UIPadding")
	pad.PaddingLeft = UDim.new(0, 8)
	pad.PaddingRight = UDim.new(0, 8)
	pad.Parent = box
	registerTheme(box, "BackgroundColor3", Enum.StudioStyleGuideColor.InputFieldBackground)
	registerTheme(box, "TextColor3", Enum.StudioStyleGuideColor.MainText)
	registerTheme(box, "PlaceholderColor3", Enum.StudioStyleGuideColor.DimmedText)
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
	registerTheme(c, "BackgroundColor3", Enum.StudioStyleGuideColor.MainBackground)

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

	local knob = Instance.new("Frame")
	knob.Name = "Knob"
	knob.Size = UDim2.new(0, 16, 0, 16)
	knob.BorderSizePixel = 0
	knob.BackgroundColor3 = WHITE
	knob.Parent = track
	corner(knob, 8)

	local state = initialOn

	local function apply()
		if state then
			track.BackgroundColor3 = ACCENT
			knob.Position = UDim2.new(1, -19, 0.5, -8)
		else
			track.BackgroundColor3 = themeColor(Enum.StudioStyleGuideColor.Border)
			knob.Position = UDim2.new(0, 3, 0.5, -8)
		end
	end
	apply()

	local hit = Instance.new("TextButton")
	hit.Text = ""
	hit.BackgroundTransparency = 1
	hit.Size = UDim2.new(1, 0, 1, 0)
	hit.Parent = track
	hit.MouseButton1Click:Connect(function()
		state = not state
		apply()
		onChange(state)
	end)

	return function(on: boolean)
		state = on
		apply()
	end
end

-- A segmented (single-choice) control. Returns a setter to update the selection.
local function segmented(
	parent: Instance,
	layoutOrder: number,
	options: { { label: string, value: string } },
	initial: string,
	onChange: (string) -> ()
): (string) -> ()
	local bar = Instance.new("Frame")
	bar.Name = "Segmented"
	bar.BackgroundTransparency = 1
	bar.BorderSizePixel = 0
	bar.Size = UDim2.new(1, 0, 0, 28)
	bar.LayoutOrder = layoutOrder
	bar.Parent = parent
	listLayout(bar, Enum.FillDirection.Horizontal, 6)

	local buttons: { [string]: TextButton } = {}
	local current = initial

	local function apply()
		for value, btn in buttons do
			if value == current then
				btn.BackgroundColor3 = ACCENT
				btn.TextColor3 = WHITE
			else
				btn.BackgroundColor3 = themeColor(Enum.StudioStyleGuideColor.Button)
				btn.TextColor3 = themeColor(Enum.StudioStyleGuideColor.ButtonText)
			end
		end
	end

	for i, opt in options do
		local b = Instance.new("TextButton")
		b.Text = opt.label
		b.TextSize = 11
		b.Font = Enum.Font.GothamMedium
		b.BorderSizePixel = 0
		b.AutoButtonColor = false
		b.Size = UDim2.new(0, 0, 1, 0)
		b.LayoutOrder = i
		b.Parent = bar
		corner(b, 5)
		fill(b)
		buttons[opt.value] = b
		b.MouseButton1Click:Connect(function()
			current = opt.value
			apply()
			onChange(opt.value)
		end)
	end
	apply()

	return function(value: string)
		current = value
		apply()
	end
end

-- ── Build the panel ─────────────────────────────────────────────────────────────
function UI.create(
	widget: DockWidgetPluginGui,
	initialSettings: { url: string, token: string?, autoConnect: boolean?, syncMode: string? }
)
	widget.Title = "Roblox MCP Pro"
	themeRegistry = {}
	syncMode = initialSettings.syncMode or "two-way"

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
	local header = row(root, 0, 24)
	listLayout(header, Enum.FillDirection.Horizontal, 8, Enum.VerticalAlignment.Center)
	label(header, "Roblox MCP Pro", 15, Enum.Font.GothamBold, Enum.StudioStyleGuideColor.MainText, 1)

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
	label(settingsCard, "SETTINGS", 10, Enum.Font.GothamBold, Enum.StudioStyleGuideColor.DimmedText, 1)

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

	-- ── Sync card ──
	local syncCard = card(root, 3)
	label(syncCard, "FILE SYNC", 10, Enum.Font.GothamBold, Enum.StudioStyleGuideColor.DimmedText, 1)

	local syncRow = row(syncCard, 2, 24)
	listLayout(syncRow, Enum.FillDirection.Horizontal, 8, Enum.VerticalAlignment.Center)
	label(syncRow, "Enable sync", 12, Enum.Font.Gotham, Enum.StudioStyleGuideColor.MainText, 1)
	spacer(syncRow, 2)
	setSyncToggleVisual = toggleSwitch(syncRow, 3, false, function(on: boolean)
		if UI.onSyncToggled then
			UI.onSyncToggled(on, syncMode)
		end
	end)

	label(syncCard, "Direction", 11, Enum.Font.Gotham, Enum.StudioStyleGuideColor.DimmedText, 3)
	setSegmentedVisual = segmented(syncCard, 4, {
		{ label = "Two-way", value = "two-way" },
		{ label = "Studio→Disk", value = "studio-to-disk" },
		{ label = "Disk→Studio", value = "disk-to-studio" },
	}, syncMode, function(value: string)
		syncMode = value
		if UI.onSyncModeChanged then
			UI.onSyncModeChanged(value)
		end
	end)

	syncStatusLabel = label(syncCard, "Off", 11, Enum.Font.Gotham, Enum.StudioStyleGuideColor.DimmedText, 5)

	-- ── Activity card ──
	local activityCard = card(root, 4)

	local activityHeader = row(activityCard, 1, 18)
	listLayout(activityHeader, Enum.FillDirection.Horizontal, 8, Enum.VerticalAlignment.Center)
	label(activityHeader, "ACTIVITY", 10, Enum.Font.GothamBold, Enum.StudioStyleGuideColor.DimmedText, 1)
	spacer(activityHeader, 2)
	statsLabel = label(activityHeader, "0 reqs · 100%", 10, Enum.Font.Gotham, Enum.StudioStyleGuideColor.DimmedText, 3)
	local clearBtn = button(activityHeader, "Clear", 52, 4)
	clearBtn.Size = UDim2.new(0, 52, 0, 18)
	clearBtn.TextSize = 10
	clearBtn.MouseButton1Click:Connect(function()
		UI.clearLogs()
	end)

	logContainer = Instance.new("ScrollingFrame")
	local log = logContainer :: ScrollingFrame
	log.Name = "Log"
	log.Size = UDim2.new(1, 0, 0, 150)
	log.BorderSizePixel = 0
	log.ScrollBarThickness = 6
	log.CanvasSize = UDim2.new(0, 0, 0, 0)
	log.AutomaticCanvasSize = Enum.AutomaticSize.Y
	log.ScrollingDirection = Enum.ScrollingDirection.Y
	log.LayoutOrder = 2
	log.Parent = activityCard
	corner(log, 5)
	registerTheme(log, "BackgroundColor3", Enum.StudioStyleGuideColor.InputFieldBackground)
	registerTheme(log, "ScrollBarImageColor3", Enum.StudioStyleGuideColor.ScrollBar)
	local logLayout = listLayout(log, Enum.FillDirection.Vertical, 3)
	logLayout.Padding = UDim.new(0, 3)
	uiPadding(log, 6)

	-- ── Footer (config helpers) ──
	local footer = row(root, 5, 26)
	listLayout(footer, Enum.FillDirection.Horizontal, 8, Enum.VerticalAlignment.Center)

	local copyJsonBtn = button(footer, "Copy config", 96, 1)
	copyJsonBtn.MouseButton1Click:Connect(function()
		local configTable = {
			mcpServers = {
				["roblox-mcp-pro"] = { command = "npx", args = { "-y", "roblox-mcp-pro" } },
			},
		}
		local okEncode, json = pcall(function()
			return HttpService:JSONEncode(configTable)
		end)
		if okEncode then
			pcall(function()
				StudioService:CopyToClipboard(json)
				print("[roblox-mcp-pro] Config JSON copied to clipboard.")
			end)
		end
	end)

	local copyCliBtn = button(footer, "Copy install cmd", 120, 2)
	copyCliBtn.MouseButton1Click:Connect(function()
		local cmd = 'gh api repos/PeerapolSelanon/roblox-mcp-pro/contents/install.ps1 -H "Accept: application/vnd.github.v3.raw" | Out-String | iex'
		pcall(function()
			StudioService:CopyToClipboard(cmd)
			print("[roblox-mcp-pro] Install command copied to clipboard.")
		end)
	end)

	applyTheme()
end

-- ── Public API ──────────────────────────────────────────────────────────────────

-- Update the connection status shown in the UI. statusLabel color is driven manually
-- here (not via registerTheme) so we never grow themeRegistry on repeated calls.
function UI.setStatus(status: string)
	if not statusLabel or not statusIndicator or not toggleButton then
		return
	end
	local lbl = statusLabel :: TextLabel
	local ind = statusIndicator :: Frame
	local btn = toggleButton :: TextButton

	lbl.Text = status

	if status == "Connected" then
		isConnected = true
		ind.BackgroundColor3 = Color3.fromRGB(46, 204, 113) -- green
		lbl.TextColor3 = Color3.fromRGB(46, 204, 113)
		btn.Text = "Disconnect"
	elseif status == "Connecting" or status == "Reconnecting" then
		isConnected = true
		ind.BackgroundColor3 = Color3.fromRGB(241, 196, 15) -- amber
		lbl.TextColor3 = Color3.fromRGB(241, 196, 15)
		btn.Text = "Disconnect"
	elseif status == "Offline" then
		-- Server unreachable but the poll loop is still retrying, so keep "Disconnect".
		isConnected = true
		ind.BackgroundColor3 = Color3.fromRGB(231, 76, 60) -- red
		lbl.TextColor3 = Color3.fromRGB(231, 76, 60)
		btn.Text = "Disconnect"
	else
		isConnected = false
		ind.BackgroundColor3 = Color3.fromRGB(149, 165, 166) -- muted
		lbl.TextColor3 = themeColor(Enum.StudioStyleGuideColor.DimmedText)
		btn.Text = "Connect"
	end
end

-- Reflect the broker's sync state in the Sync card.
function UI.setSyncStatus(running: boolean, mode: string?, scriptCount: number?)
	syncRunning = running
	if mode then
		syncMode = mode
		if setSegmentedVisual then
			(setSegmentedVisual :: (string) -> ())(mode)
		end
	end
	if setSyncToggleVisual then
		(setSyncToggleVisual :: (boolean) -> ())(running)
	end
	if syncStatusLabel then
		local lbl = syncStatusLabel :: TextLabel
		if running then
			local count = scriptCount or 0
			lbl.Text = ("Syncing %d scripts · %s"):format(count, MODE_LABELS[syncMode] or syncMode)
			lbl.TextColor3 = Color3.fromRGB(46, 204, 113)
		else
			lbl.Text = "Off"
			lbl.TextColor3 = themeColor(Enum.StudioStyleGuideColor.DimmedText)
		end
	end
end

function UI.updateStatsLabel()
	if not statsLabel then
		return
	end
	local rate = 100
	if totalRequests > 0 then
		rate = math.round((successRequests / totalRequests) * 100)
	end
	(statsLabel :: TextLabel).Text = ("%d reqs · %d%%"):format(totalRequests, rate)
end

-- Append a log entry to the activity console.
function UI.addLog(toolName: string, success: boolean, detail: string?)
	if not logContainer then
		return
	end
	local log = logContainer :: ScrollingFrame

	totalRequests += 1
	if success then
		successRequests += 1
	end
	UI.updateStatsLabel()

	local logRow = Instance.new("Frame")
	logRow.Name = "LogRow"
	logRow.Size = UDim2.new(1, 0, 0, 16)
	logRow.BackgroundTransparency = 1
	logRow.BorderSizePixel = 0
	logRow.Parent = log
	listLayout(logRow, Enum.FillDirection.Horizontal, 6, Enum.VerticalAlignment.Center)

	local badge = Instance.new("TextLabel")
	badge.Name = "Badge"
	badge.Size = UDim2.new(0, 28, 0, 13)
	badge.BorderSizePixel = 0
	badge.TextSize = 9
	badge.Font = Enum.Font.GothamBold
	badge.LayoutOrder = 1
	badge.Parent = logRow
	corner(badge, 3)
	if success then
		badge.Text = "OK"
		badge.BackgroundColor3 = Color3.fromRGB(39, 174, 96)
	else
		badge.Text = "ERR"
		badge.BackgroundColor3 = Color3.fromRGB(192, 57, 43)
	end
	badge.TextColor3 = WHITE

	local timestamp = os.date("%H:%M:%S")
	local entryText = ("[%s] %s"):format(timestamp, toolName)
	if detail and detail ~= "" then
		entryText = entryText .. " — " .. detail
	end
	-- Log rows are transient (trimmed after MAX_LOG_ROWS), so we set the color directly
	-- instead of via registerTheme — otherwise every entry would leak a registry item.
	local msg = Instance.new("TextLabel")
	msg.Text = entryText
	msg.TextSize = 11
	msg.Font = Enum.Font.Code
	msg.BackgroundTransparency = 1
	msg.BorderSizePixel = 0
	msg.TextXAlignment = Enum.TextXAlignment.Left
	msg.TextYAlignment = Enum.TextYAlignment.Center
	msg.TextTruncate = Enum.TextTruncate.AtEnd
	msg.Size = UDim2.new(1, -34, 1, 0)
	msg.LayoutOrder = 2
	msg.TextColor3 = themeColor(
		if success then Enum.StudioStyleGuideColor.MainText else Enum.StudioStyleGuideColor.WarningText
	)
	msg.Parent = logRow

	-- Keep the newest entry in view.
	task.defer(function()
		if logContainer then
			(logContainer :: ScrollingFrame).CanvasPosition =
				Vector2.new(0, (logContainer :: ScrollingFrame).AbsoluteCanvasSize.Y)
		end
	end)

	-- Trim old rows to bound memory.
	local rows = {}
	for _, child in log:GetChildren() do
		if child.Name == "LogRow" then
			table.insert(rows, child)
		end
	end
	if #rows > MAX_LOG_ROWS then
		for i = 1, #rows - MAX_LOG_ROWS do
			rows[i]:Destroy()
		end
	end
end

function UI.clearLogs()
	if not logContainer then
		return
	end
	for _, child in (logContainer :: ScrollingFrame):GetChildren() do
		if child.Name == "LogRow" then
			child:Destroy()
		end
	end
	totalRequests = 0
	successRequests = 0
	UI.updateStatsLabel()
end

return UI
