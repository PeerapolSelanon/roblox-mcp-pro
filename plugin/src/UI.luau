--!strict
-- UI: builds the Roblox MCP Pro plugin panel inside a DockWidget.
--
-- Layout is fully responsive: a single vertical UIListLayout stacks three cards
-- (Connection / Server / Activity) plus a footer. Cards size to their content via
-- AutomaticSize, and the Activity card uses a UIFlexItem (Fill) so it consumes all
-- remaining vertical space — no hard-coded pixel offsets, so it never overlaps or
-- mis-aligns when the dock is resized. Colors come from the live Studio theme and
-- update automatically on ThemeChanged.

local StudioService = game:GetService("StudioService")
local HttpService = game:GetService("HttpService")

local UI = {}

-- State callbacks (wired up by init.server.luau)
UI.onSettingsSaved = nil :: ((url: string, token: string?) -> ())?
UI.onConnectionToggled = nil :: ((connect: boolean) -> ())?

-- UI references
local statusIndicator: Frame? = nil
local statusLabel: TextLabel? = nil
local toggleButton: TextButton? = nil
local urlInput: TextBox? = nil
local tokenInput: TextBox? = nil
local statsLabel: TextLabel? = nil
local logContainer: ScrollingFrame? = nil

-- Activity stats
local isConnected = false
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

-- A bordered card with a vertical inner layout. Pass `flexFill = true` to make it
-- stretch to fill the remaining height in the parent layout.
local function card(parent: Instance, layoutOrder: number, flexFill: boolean?): Frame
	local c = Instance.new("Frame")
	c.Name = "Card"
	c.BorderSizePixel = 0
	c.LayoutOrder = layoutOrder
	c.Size = UDim2.new(1, 0, 0, 0)
	if flexFill then
		fill(c)
	else
		c.AutomaticSize = Enum.AutomaticSize.Y
	end
	c.Parent = parent
	registerTheme(c, "BackgroundColor3", Enum.StudioStyleGuideColor.MainBackground)

	corner(c, 6)
	local stroke = Instance.new("UIStroke")
	stroke.Thickness = 1
	stroke.Parent = c
	registerTheme(stroke, "Color", Enum.StudioStyleGuideColor.Border)

	uiPadding(c, 10)
	listLayout(c, Enum.FillDirection.Vertical, 8)
	return c
end

-- ── Build the panel ─────────────────────────────────────────────────────────────
function UI.create(widget: DockWidgetPluginGui, initialSettings: { url: string, token: string? })
	widget.Title = "Roblox MCP Pro"
	themeRegistry = {}

	-- Clear any previous build (Studio reloads re-run this module).
	for _, child in widget:GetChildren() do
		child:Destroy()
	end

	local root = Instance.new("Frame")
	root.Name = "Root"
	root.Size = UDim2.new(1, 0, 1, 0)
	root.BorderSizePixel = 0
	root.Parent = widget
	registerTheme(root, "BackgroundColor3", Enum.StudioStyleGuideColor.MainBackground)
	uiPadding(root, 10)
	listLayout(root, Enum.FillDirection.Vertical, 10)

	-- ── Connection card ──
	local connCard = card(root, 1)
	local connRow = row(connCard, 1, 26)
	listLayout(connRow, Enum.FillDirection.Horizontal, 8, Enum.VerticalAlignment.Center)

	statusIndicator = Instance.new("Frame")
	statusIndicator.Name = "Dot"
	statusIndicator.Size = UDim2.new(0, 10, 0, 10)
	statusIndicator.BorderSizePixel = 0
	statusIndicator.BackgroundColor3 = Color3.fromRGB(149, 165, 166)
	statusIndicator.LayoutOrder = 1
	statusIndicator.Parent = connRow
	corner(statusIndicator, 5)

	statusLabel = label(connRow, "Disconnected", 13, Enum.Font.GothamMedium, Enum.StudioStyleGuideColor.MainText, 2)

	spacer(connRow, 3)

	toggleButton = button(connRow, "Connect", 96, 4)
	toggleButton.MouseButton1Click:Connect(function()
		if UI.onConnectionToggled then
			UI.onConnectionToggled(not isConnected)
		end
	end)

	-- ── Server card ──
	local serverCard = card(root, 2)
	label(serverCard, "SERVER", 10, Enum.Font.GothamBold, Enum.StudioStyleGuideColor.DimmedText, 1)

	label(serverCard, "Host URL", 11, Enum.Font.Gotham, Enum.StudioStyleGuideColor.DimmedText, 2)
	urlInput = input(serverCard, "http://127.0.0.1:3690", 3)
	urlInput.Text = initialSettings.url

	label(serverCard, "Auth Token (optional)", 11, Enum.Font.Gotham, Enum.StudioStyleGuideColor.DimmedText, 4)
	tokenInput = input(serverCard, "shared secret", 5)
	tokenInput.Text = initialSettings.token or ""

	local applyRow = row(serverCard, 6, 26)
	listLayout(applyRow, Enum.FillDirection.Horizontal, 8, Enum.VerticalAlignment.Center)
	spacer(applyRow, 1)
	local applyBtn = button(applyRow, "Apply", 80, 2)
	applyBtn.MouseButton1Click:Connect(function()
		if UI.onSettingsSaved and urlInput and tokenInput then
			local t = tokenInput.Text
			UI.onSettingsSaved(urlInput.Text, if t == "" then nil else t)
		end
	end)

	-- ── Activity card (fills remaining space) ──
	local activityCard = card(root, 3, true)

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
	logContainer.Name = "Log"
	logContainer.Size = UDim2.new(1, 0, 0, 0)
	logContainer.BorderSizePixel = 0
	logContainer.ScrollBarThickness = 6
	logContainer.CanvasSize = UDim2.new(0, 0, 0, 0)
	logContainer.AutomaticCanvasSize = Enum.AutomaticSize.Y
	logContainer.LayoutOrder = 2
	logContainer.Parent = activityCard
	fill(logContainer)
	corner(logContainer, 5)
	registerTheme(logContainer, "BackgroundColor3", Enum.StudioStyleGuideColor.InputFieldBackground)
	registerTheme(logContainer, "ScrollBarImageColor3", Enum.StudioStyleGuideColor.ScrollBar)
	local logLayout = listLayout(logContainer, Enum.FillDirection.Vertical, 3)
	logLayout.Padding = UDim.new(0, 3)
	uiPadding(logContainer, 6)

	-- ── Footer (config helpers) ──
	local footer = row(root, 4, 26)
	footer.LayoutOrder = 4
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

	statusLabel.Text = status

	if status == "Connected" then
		isConnected = true
		statusIndicator.BackgroundColor3 = Color3.fromRGB(46, 204, 113) -- green
		statusLabel.TextColor3 = Color3.fromRGB(46, 204, 113)
		toggleButton.Text = "Disconnect"
	elseif status == "Connecting" or status == "Reconnecting" then
		isConnected = true
		statusIndicator.BackgroundColor3 = Color3.fromRGB(241, 196, 15) -- amber
		statusLabel.TextColor3 = Color3.fromRGB(241, 196, 15)
		toggleButton.Text = "Disconnect"
	elseif status == "Offline" then
		-- Server unreachable but the poll loop is still retrying, so keep "Disconnect".
		isConnected = true
		statusIndicator.BackgroundColor3 = Color3.fromRGB(231, 76, 60) -- red
		statusLabel.TextColor3 = Color3.fromRGB(231, 76, 60)
		toggleButton.Text = "Disconnect"
	else
		isConnected = false
		statusIndicator.BackgroundColor3 = Color3.fromRGB(149, 165, 166) -- muted
		statusLabel.TextColor3 = themeColor(Enum.StudioStyleGuideColor.DimmedText)
		toggleButton.Text = "Connect"
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
	statsLabel.Text = ("%d reqs · %d%%"):format(totalRequests, rate)
end

-- Append a log entry to the activity console.
function UI.addLog(toolName: string, success: boolean, detail: string?)
	if not logContainer then
		return
	end

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
	logRow.Parent = logContainer
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
	badge.TextColor3 = Color3.fromRGB(255, 255, 255)

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
			logContainer.CanvasPosition = Vector2.new(0, logContainer.AbsoluteCanvasSize.Y)
		end
	end)

	-- Trim old rows to bound memory.
	local rows = {}
	for _, child in logContainer:GetChildren() do
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
	for _, child in logContainer:GetChildren() do
		if child.Name == "LogRow" then
			child:Destroy()
		end
	end
	totalRequests = 0
	successRequests = 0
	UI.updateStatsLabel()
end

return UI
