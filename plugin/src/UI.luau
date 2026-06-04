--!strict
-- UI: Programmatically constructs the Roblox Studio Plugin UI panel inside a DockWidget.
-- Implements automatic theme-awareness (adapting to Dark/Light modes) and exposes
-- API endpoints for updating connection states, logging activity, and handling settings.

local StudioService = game:GetService("StudioService")
local HttpService = game:GetService("HttpService")

local UI = {}

-- State callbacks
UI.onSettingsSaved = nil :: ((url: string, token: string?) -> ())?
UI.onConnectionToggled = nil :: ((connect: boolean) -> ())?

-- UI references
local mainFrame: Frame? = nil
local statusIndicator: Frame? = nil
local statusLabel: TextLabel? = nil
local toggleButton: TextButton? = nil
local urlInput: TextBox? = nil
local tokenInput: TextBox? = nil
local statsLabel: TextLabel? = nil
local logContainer: ScrollingFrame? = nil

-- Configuration values
local isConnected = false
local totalRequests = 0
local successRequests = 0

-- Theme registry to dynamically update colors when Studio theme changes
type ThemeItem = {
	element: GuiObject,
	property: string,
	styleColor: Enum.StudioStyleGuideColor,
	modifier: Enum.StudioStyleGuideModifier?,
}
local themeRegistry: { ThemeItem } = {}

local function registerTheme(element: GuiObject, property: string, styleColor: Enum.StudioStyleGuideColor, modifier: Enum.StudioStyleGuideModifier?)
	table.insert(themeRegistry, {
		element = element,
		property = property,
		styleColor = styleColor,
		modifier = modifier,
	})
end

local function applyTheme()
	local theme = settings().Studio.Theme
	for _, item in themeRegistry do
		local ok, color = pcall(function()
			return theme:GetColor(item.styleColor, item.modifier or Enum.StudioStyleGuideModifier.Default)
		end)
		if ok then
			(item.element :: any)[item.property] = color
		end
	end
end

-- Hook theme change event
settings().Studio.ThemeChanged:Connect(applyTheme)

-- Helper to create basic frames and labels with theme registration
local function createFrame(parent: Instance, name: string, size: UDim2, position: UDim2?): Frame
	local frame = Instance.new("Frame")
	frame.Name = name
	frame.Size = size
	if position then frame.Position = position end
	frame.BorderSizePixel = 0
	frame.BackgroundTransparency = 0
	frame.Parent = parent
	registerTheme(frame, "BackgroundColor3", Enum.StudioStyleGuideColor.MainBackground)
	return frame
end

local function createLabel(parent: Instance, name: string, size: UDim2, text: string, fontSize: number?, font: Enum.Font?): TextLabel
	local label = Instance.new("TextLabel")
	label.Name = name
	label.Size = size
	label.Text = text
	label.TextSize = fontSize or 11
	label.Font = font or Enum.Font.Gotham
	label.BackgroundTransparency = 1
	label.BorderSizePixel = 0
	label.TextXAlignment = Enum.TextXAlignment.Left
	label.TextYAlignment = Enum.TextYAlignment.Center
	label.Parent = parent
	registerTheme(label, "TextColor3", Enum.StudioStyleGuideColor.MainText)
	return label
end

local function createButton(parent: Instance, name: string, size: UDim2, text: string): TextButton
	local button = Instance.new("TextButton")
	button.Name = name
	button.Size = size
	button.Text = text
	button.TextSize = 11
	button.Font = Enum.Font.GothamBold
	button.BorderSizePixel = 0
	button.AutoButtonColor = false
	button.Parent = parent
	
	local uiCorner = Instance.new("UICorner")
	uiCorner.CornerRadius = UDim.new(0, 4)
	uiCorner.Parent = button

	registerTheme(button, "BackgroundColor3", Enum.StudioStyleGuideColor.Button)
	registerTheme(button, "TextColor3", Enum.StudioStyleGuideColor.ButtonText)

	-- Hover effects
	button.MouseEnter:Connect(function()
		local theme = settings().Studio.Theme
		button.BackgroundColor3 = theme:GetColor(Enum.StudioStyleGuideColor.Button, Enum.StudioStyleGuideModifier.Hover)
	end)
	button.MouseLeave:Connect(function()
		local theme = settings().Studio.Theme
		button.BackgroundColor3 = theme:GetColor(Enum.StudioStyleGuideColor.Button, Enum.StudioStyleGuideModifier.Default)
	end)
	button.MouseButton1Down:Connect(function()
		local theme = settings().Studio.Theme
		button.BackgroundColor3 = theme:GetColor(Enum.StudioStyleGuideColor.Button, Enum.StudioStyleGuideModifier.Pressed)
	end)

	return button
end

local function createInput(parent: Instance, name: string, size: UDim2, placeholder: string): TextBox
	local input = Instance.new("TextBox")
	input.Name = name
	input.Size = size
	input.Text = ""
	input.PlaceholderText = placeholder
	input.TextSize = 11
	input.Font = Enum.Font.Gotham
	input.BorderSizePixel = 0
	input.TextXAlignment = Enum.TextXAlignment.Left
	input.ClearTextOnFocus = false
	input.Parent = parent

	local uiCorner = Instance.new("UICorner")
	uiCorner.CornerRadius = UDim.new(0, 4)
	uiCorner.Parent = input

	local padding = Instance.new("UIPadding")
	padding.PaddingLeft = UDim.new(0, 6)
	padding.PaddingRight = UDim.new(0, 6)
	padding.Parent = input

	registerTheme(input, "BackgroundColor3", Enum.StudioStyleGuideColor.InputFieldBackground)
	registerTheme(input, "TextColor3", Enum.StudioStyleGuideColor.InputFieldText)
	registerTheme(input, "PlaceholderColor3", Enum.StudioStyleGuideColor.DimmedText)

	return input
end

-- Initialize the GUI panel inside the widget container
function UI.create(widget: DockWidgetPluginGui, initialSettings: { url: string, token: string? })
	widget.Title = "Roblox MCP Pro"
	
	themeRegistry = {} -- Clear registry in case of rebuilds

	-- Main background wrapper
	local container = createFrame(widget, "MainContainer", UDim2.new(1, 0, 1, 0))
	mainFrame = container

	local mainLayout = Instance.new("UIListLayout")
	mainLayout.SortOrder = Enum.SortOrder.LayoutOrder
	mainLayout.Padding = UDim.new(0, 8)
	mainLayout.Parent = container

	local mainPadding = Instance.new("UIPadding")
	mainPadding.PaddingTop = UDim.new(0, 8)
	mainPadding.PaddingBottom = UDim.new(0, 8)
	mainPadding.PaddingLeft = UDim.new(0, 8)
	mainPadding.PaddingRight = UDim.new(0, 8)
	mainPadding.Parent = container

	-- ── HEADER SECTION ──
	local header = createFrame(container, "Header", UDim2.new(1, 0, 0, 32))
	header.LayoutOrder = 1
	
	local headerLayout = Instance.new("UIListLayout")
	headerLayout.FillDirection = Enum.FillDirection.Horizontal
	headerLayout.SortOrder = Enum.SortOrder.LayoutOrder
	headerLayout.VerticalAlignment = Enum.VerticalAlignment.Center
	headerLayout.Padding = UDim.new(0, 8)
	headerLayout.Parent = header

	local titleLabel = createLabel(header, "TitleLabel", UDim2.new(0, 120, 1, 0), "ROBLOX MCP PRO", 13, Enum.Font.GothamBold)
	titleLabel.LayoutOrder = 1
	registerTheme(titleLabel, "TextColor3", Enum.StudioStyleGuideColor.TitlebarText)

	-- Status indicator wrapper
	local statusWrapper = createFrame(header, "StatusWrapper", UDim2.new(0, 95, 1, 0))
	statusWrapper.BackgroundTransparency = 1
	statusWrapper.LayoutOrder = 2

	local statusWrapperLayout = Instance.new("UIListLayout")
	statusWrapperLayout.FillDirection = Enum.FillDirection.Horizontal
	statusWrapperLayout.SortOrder = Enum.SortOrder.LayoutOrder
	statusWrapperLayout.VerticalAlignment = Enum.VerticalAlignment.Center
	statusWrapperLayout.Padding = UDim.new(0, 6)
	statusWrapperLayout.Parent = statusWrapper

	statusIndicator = Instance.new("Frame")
	statusIndicator.Name = "Indicator"
	statusIndicator.Size = UDim2.new(0, 8, 0, 8)
	statusIndicator.BorderSizePixel = 0
	statusIndicator.BackgroundColor3 = Color3.fromRGB(150, 150, 150)
	statusIndicator.Parent = statusWrapper
	statusIndicator.LayoutOrder = 1

	local indicatorCorner = Instance.new("UICorner")
	indicatorCorner.CornerRadius = UDim.new(0.5, 0)
	indicatorCorner.Parent = statusIndicator

	statusLabel = createLabel(statusWrapper, "StatusLabel", UDim2.new(0, 80, 1, 0), "Disconnected", 10, Enum.Font.Gotham)
	statusLabel.LayoutOrder = 2
	registerTheme(statusLabel, "TextColor3", Enum.StudioStyleGuideColor.DimmedText)

	-- Fill space
	local headerSpacer = createFrame(header, "Spacer", UDim2.new(1, -300, 1, 0))
	headerSpacer.BackgroundTransparency = 1
	headerSpacer.LayoutOrder = 3

	toggleButton = createButton(header, "ToggleButton", UDim2.new(0, 75, 0, 24), "Connect")
	toggleButton.LayoutOrder = 4
	toggleButton.MouseButton1Click:Connect(function()
		if UI.onConnectionToggled then
			UI.onConnectionToggled(not isConnected)
		end
	end)

	-- ── SETTINGS CONFIG SECTION ──
	local settingsBox = createFrame(container, "SettingsBox", UDim2.new(1, 0, 0, 88))
	settingsBox.LayoutOrder = 2
	registerTheme(settingsBox, "BackgroundColor3", Enum.StudioStyleGuideColor.InputFieldBackground)
	
	local boxCorner = Instance.new("UICorner")
	boxCorner.CornerRadius = UDim.new(0, 4)
	boxCorner.Parent = settingsBox

	local boxPadding = Instance.new("UIPadding")
	boxPadding.PaddingTop = UDim.new(0, 6)
	boxPadding.PaddingBottom = UDim.new(0, 6)
	boxPadding.PaddingLeft = UDim.new(0, 8)
	boxPadding.PaddingRight = UDim.new(0, 8)
	boxPadding.Parent = settingsBox

	local boxLayout = Instance.new("UIListLayout")
	boxLayout.SortOrder = Enum.SortOrder.LayoutOrder
	boxLayout.Padding = UDim.new(0, 6)
	boxLayout.Parent = settingsBox

	local settingsHeader = createLabel(settingsBox, "SettingsHeader", UDim2.new(1, 0, 0, 14), "SERVER CONFIGURATION", 9, Enum.Font.GothamBold)
	settingsHeader.LayoutOrder = 1
	registerTheme(settingsHeader, "TextColor3", Enum.StudioStyleGuideColor.DimmedText)

	-- URL Input row
	local urlRow = createFrame(settingsBox, "UrlRow", UDim2.new(1, 0, 0, 24))
	urlRow.BackgroundTransparency = 1
	urlRow.LayoutOrder = 2

	local urlLabel = createLabel(urlRow, "UrlLabel", UDim2.new(0, 65, 1, 0), "Host URL:", 10)
	urlLabel.LayoutOrder = 1

	urlInput = createInput(urlRow, "UrlInput", UDim2.new(1, -145, 1, 0), "http://127.0.0.1:3690")
	urlInput.Text = initialSettings.url
	urlInput.LayoutOrder = 2

	-- Token Input row
	local tokenRow = createFrame(settingsBox, "TokenRow", UDim2.new(1, 0, 0, 24))
	tokenRow.BackgroundTransparency = 1
	tokenRow.LayoutOrder = 3

	local tokenLabel = createLabel(tokenRow, "TokenLabel", UDim2.new(0, 65, 1, 0), "Auth Token:", 10)
	tokenLabel.LayoutOrder = 1

	tokenInput = createInput(tokenRow, "TokenInput", UDim2.new(1, -145, 1, 0), "Optional shared secret")
	tokenInput.Text = initialSettings.token or ""
	tokenInput.LayoutOrder = 2

	-- Apply Button is positioned next to the URL/Token inputs
	local applyBtn = createButton(urlRow, "ApplyBtn", UDim2.new(0, 72, 1, 0), "Apply")
	applyBtn.Position = UDim2.new(1, -72, 0, 0)
	applyBtn.MouseButton1Click:Connect(function()
		if UI.onSettingsSaved and urlInput and tokenInput then
			local inputToken = tokenInput.Text
			local resolvedToken = if inputToken == "" then nil else inputToken
			UI.onSettingsSaved(urlInput.Text, resolvedToken)
		end
	end)

	-- ── STATS SECTION ──
	local statsBar = createFrame(container, "StatsBar", UDim2.new(1, 0, 0, 16))
	statsBar.LayoutOrder = 3
	statsBar.BackgroundTransparency = 1

	statsLabel = createLabel(statsBar, "StatsLabel", UDim2.new(1, 0, 1, 0), "Requests: 0  |  Success Rate: 100%", 10)
	registerTheme(statsLabel, "TextColor3", Enum.StudioStyleGuideColor.DimmedText)

	-- ── CONSOLE LOG SECTION ──
	local logHeader = createLabel(container, "LogHeader", UDim2.new(1, 0, 0, 12), "ACTIVITY LOG", 9, Enum.Font.GothamBold)
	logHeader.LayoutOrder = 4
	registerTheme(logHeader, "TextColor3", Enum.StudioStyleGuideColor.DimmedText)

	logContainer = Instance.new("ScrollingFrame")
	logContainer.Name = "LogContainer"
	logContainer.Size = UDim2.new(1, 0, 1, -214) -- Dynamically fills remaining space
	logContainer.BorderSizePixel = 0
	logContainer.ScrollBarThickness = 6
	logContainer.CanvasSize = UDim2.new(0, 0, 0, 0)
	logContainer.AutomaticCanvasSize = Enum.AutomaticSize.Y
	logContainer.LayoutOrder = 5
	logContainer.Parent = container
	registerTheme(logContainer, "BackgroundColor3", Enum.StudioStyleGuideColor.InputFieldBackground)
	registerTheme(logContainer, "ScrollBarImageColor3", Enum.StudioStyleGuideColor.ScrollBar)

	local logCorner = Instance.new("UICorner")
	logCorner.CornerRadius = UDim.new(0, 4)
	logCorner.Parent = logContainer

	local logLayout = Instance.new("UIListLayout")
	logLayout.SortOrder = Enum.SortOrder.LayoutOrder
	logLayout.Padding = UDim.new(0, 2)
	logLayout.Parent = logContainer

	local logPadding = Instance.new("UIPadding")
	logPadding.PaddingTop = UDim.new(0, 4)
	logPadding.PaddingBottom = UDim.new(0, 4)
	logPadding.PaddingLeft = UDim.new(0, 6)
	logPadding.PaddingRight = UDim.new(0, 6)
	logPadding.Parent = logContainer

	-- ── UTILITIES BAR ──
	local utilsBar = createFrame(container, "UtilsBar", UDim2.new(1, 0, 0, 24))
	utilsBar.LayoutOrder = 6
	utilsBar.BackgroundTransparency = 1

	local utilsLayout = Instance.new("UIListLayout")
	utilsLayout.FillDirection = Enum.FillDirection.Horizontal
	utilsLayout.SortOrder = Enum.SortOrder.LayoutOrder
	utilsLayout.Padding = UDim.new(0, 8)
	utilsLayout.Parent = utilsBar

	local copyJsonBtn = createButton(utilsBar, "CopyJsonBtn", UDim2.new(0, 110, 1, 0), "Copy Config JSON")
	copyJsonBtn.LayoutOrder = 1
	copyJsonBtn.MouseButton1Click:Connect(function()
		local configTable = {
			mcpServers = {
				["roblox-mcp-pro"] = {
					command = "npx",
					args = { "-y", "roblox-mcp-pro" },
				},
			},
		}
		local success, json = pcall(function()
			return HttpService:JSONEncode(configTable)
		end)
		if success then
			pcall(function()
				StudioService:CopyToClipboard(json)
				print("[roblox-mcp-pro] Config JSON copied to clipboard!")
			end)
		end
	end)

	local copyCliBtn = createButton(utilsBar, "CopyCliBtn", UDim2.new(0, 120, 1, 0), "Copy Install Command")
	copyCliBtn.LayoutOrder = 2
	copyCliBtn.MouseButton1Click:Connect(function()
		local cmd = 'gh api repos/PeerapolSelanon/roblox-mcp-pro/contents/install.ps1 -H "Accept: application/vnd.github.v3.raw" | Out-String | iex'
		pcall(function()
			StudioService:CopyToClipboard(cmd)
			print("[roblox-mcp-pro] PowerShell installation command copied to clipboard!")
		end)
	end)

	local clearLogBtn = createButton(utilsBar, "ClearLogBtn", UDim2.new(0, 60, 1, 0), "Clear Logs")
	clearLogBtn.LayoutOrder = 3
	clearLogBtn.MouseButton1Click:Connect(function()
		UI.clearLogs()
	end)

	-- Apply the theme initially
	applyTheme()
end

-- Update the connection status shown in the UI
function UI.setStatus(status: string)
	if not statusLabel or not statusIndicator or not toggleButton then return end

	statusLabel.Text = status

	if status == "Connected" then
		isConnected = true
		statusIndicator.BackgroundColor3 = Color3.fromRGB(46, 204, 113) -- Green
		statusLabel.TextColor3 = Color3.fromRGB(46, 204, 113)
		toggleButton.Text = "Disconnect"
		registerTheme(statusLabel, "TextColor3", Enum.StudioStyleGuideColor.MainText) -- Fallback reset if needed
	elseif status == "Reconnecting" or status == "Connecting" then
		isConnected = true
		statusIndicator.BackgroundColor3 = Color3.fromRGB(241, 196, 15) -- Yellow
		statusLabel.TextColor3 = Color3.fromRGB(241, 196, 15)
		toggleButton.Text = "Disconnect"
	else
		isConnected = false
		statusIndicator.BackgroundColor3 = Color3.fromRGB(149, 165, 166) -- Gray / Muted
		statusLabel.TextColor3 = settings().Studio.Theme:GetColor(Enum.StudioStyleGuideColor.DimmedText)
		toggleButton.Text = "Connect"
		registerTheme(statusLabel, "TextColor3", Enum.StudioStyleGuideColor.DimmedText)
	end
end

-- Add a log entry to the scroll console
function UI.addLog(toolName: string, success: boolean, detail: string?)
	if not logContainer then return end

	-- Update local request counts and stats label
	totalRequests += 1
	if success then
		successRequests += 1
	end
	UI.updateStatsLabel()

	local timestamp = os.date("%H:%M:%S")
	local entryText = ("[%s] %s"):format(timestamp, toolName:upper())
	if detail and detail ~= "" then
		entryText = entryText .. " (" .. detail .. ")"
	end

	-- Create log row container
	local logRow = Instance.new("Frame")
	logRow.Name = "LogRow"
	logRow.Size = UDim2.new(1, 0, 0, 16)
	logRow.BackgroundTransparency = 1
	logRow.BorderSizePixel = 0
	logRow.Parent = logContainer

	local logRowLayout = Instance.new("UIListLayout")
	logRowLayout.FillDirection = Enum.FillDirection.Horizontal
	logRowLayout.SortOrder = Enum.SortOrder.LayoutOrder
	logRowLayout.VerticalAlignment = Enum.VerticalAlignment.Center
	logRowLayout.Padding = UDim.new(0, 6)
	logRowLayout.Parent = logRow

	-- Success/Error Badge
	local badge = Instance.new("TextLabel")
	badge.Name = "Badge"
	badge.Size = UDim2.new(0, 26, 0, 12)
	badge.BorderSizePixel = 0
	badge.TextSize = 8
	badge.Font = Enum.Font.GothamBold
	badge.TextYAlignment = Enum.TextYAlignment.Center
	badge.LayoutOrder = 1
	badge.Parent = logRow

	local badgeCorner = Instance.new("UICorner")
	badgeCorner.CornerRadius = UDim.new(0, 2)
	badgeCorner.Parent = badge

	if success then
		badge.Text = "OK"
		badge.BackgroundColor3 = Color3.fromRGB(39, 174, 96) -- Green
		badge.TextColor3 = Color3.fromRGB(255, 255, 255)
	else
		badge.Text = "ERR"
		badge.BackgroundColor3 = Color3.fromRGB(192, 57, 43) -- Red
		badge.TextColor3 = Color3.fromRGB(255, 255, 255)
	end

	-- Text message
	local msg = createLabel(logRow, "Msg", UDim2.new(1, -32, 1, 0), entryText, 9, Enum.Font.Code)
	msg.LayoutOrder = 2
	registerTheme(msg, "TextColor3", if success then Enum.StudioStyleGuideColor.MainText else Enum.StudioStyleGuideColor.WarningText)

	-- Scroll to the bottom of the log container
	task.defer(function()
		if logContainer then
			logContainer.CanvasPosition = Vector2.new(0, logContainer.AbsoluteCanvasSize.Y)
		end
	end)

	-- Trim log list if too long to prevent overhead
	local children = logContainer:GetChildren()
	local logRows = {}
	for _, child in children do
		if child.Name == "LogRow" then
			table.insert(logRows, child)
		end
	end
	
	if #logRows > 50 then
		local excess = #logRows - 50
		for i = 1, excess do
			logRows[i]:Destroy()
		end
	end
end

-- Clear all logs from console
function UI.clearLogs()
	if not logContainer then return end
	for _, child in logContainer:GetChildren() do
		if child.Name == "LogRow" then
			child:Destroy()
		end
	end
	totalRequests = 0
	successRequests = 0
	UI.updateStatsLabel()
end

-- Update helper for stats labels
function UI.updateStatsLabel()
	if not statsLabel then return end
	local rate = 100
	if totalRequests > 0 then
		rate = math.round((successRequests / totalRequests) * 100)
	end
	statsLabel.Text = ("Requests: %d  |  Success Rate: %d%%"):format(totalRequests, rate)
end

return UI
