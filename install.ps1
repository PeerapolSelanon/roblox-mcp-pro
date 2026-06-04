# roblox-mcp-pro — One-line install script (Windows PowerShell)
#
# Usage:
#   irm https://raw.githubusercontent.com/PeerapolSelanon/roblox-mcp-pro/main/install.ps1 | iex
#

$ErrorActionPreference = "Stop"

# Title banner
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "     Roblox MCP Pro Installer for Windows     " -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

# [1/3] Detect Node.js
Write-Host "[1/3] Checking Prerequisites..." -ForegroundColor Cyan
try {
    $nodeVersion = node -v 2>$null
    if ($nodeVersion -match "^v(\d+)") {
        $major = [int]$Matches[1]
        if ($major -lt 18) {
            Write-Host "[WARN] Node.js version $nodeVersion is installed, but Node.js 18+ is recommended." -ForegroundColor Yellow
        } else {
            Write-Host "[OK] Node.js $nodeVersion detected." -ForegroundColor Green
        }
    } else {
        throw "Node.js not found"
    }
} catch {
    Write-Host "[ERROR] Node.js is not installed or not in PATH." -ForegroundColor Red
    Write-Host "  Please install Node.js 18+ from https://nodejs.org/ before running this installer." -ForegroundColor Yellow
    Read-Host "Press Enter to exit..."
    exit 1
}

# [2/3] Install Roblox Studio Plugin
Write-Host "`n[2/3] Installing Roblox Studio Plugin..." -ForegroundColor Cyan
$pluginsFolder = Join-Path $env:LOCALAPPDATA "Roblox\Plugins"
if (-not (Test-Path $pluginsFolder)) {
    New-Item -ItemType Directory -Path $pluginsFolder -Force | Out-Null
}

$destPath = Join-Path $pluginsFolder "RobloxMcpPro.rbxmx"
Write-Host "Fetching latest release information from GitHub..." -ForegroundColor Gray

try {
    $downloaded = $false

    # Try downloading using gh CLI if available (supports private repos automatically since user is logged in)
    $ghCommand = Get-Command gh -ErrorAction SilentlyContinue
    if ($ghCommand) {
        Write-Host "GitHub CLI (gh) detected. Attempting to download via gh CLI..." -ForegroundColor Gray
        try {
            $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
            New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
            
            # Download using gh
            & gh release download --repo PeerapolSelanon/roblox-mcp-pro --pattern "RobloxMcpPro.rbxmx" --dir $tempDir --clobber
            
            $downloadedFile = Join-Path $tempDir "RobloxMcpPro.rbxmx"
            if (Test-Path $downloadedFile) {
                Copy-Item $downloadedFile $destPath -Force
                Remove-Item $tempDir -Recurse -Force
                Write-Host "[OK] Installed plugin to $destPath" -ForegroundColor Green
                $downloaded = $true
            }
        } catch {
            Write-Host "[WARN] gh CLI download failed, falling back to public API..." -ForegroundColor Yellow
        }
    }

    if (-not $downloaded) {
        # Fetch latest release URL
        $releaseUrl = "https://api.github.com/repos/PeerapolSelanon/roblox-mcp-pro/releases/latest"
        # Set SecurityProtocol to TLS 1.2
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $response = Invoke-RestMethod -Uri $releaseUrl -Headers @{"User-Agent"="Roblox-Mcp-Pro-Installer"}
        
        $asset = $response.assets | Where-Object { $_.name -eq "RobloxMcpPro.rbxmx" }
        if (-not $asset) {
            throw "Could not find RobloxMcpPro.rbxmx asset in the latest release."
        }
        
        $downloadUrl = $asset.browser_download_url
        Write-Host "Downloading latest plugin version $($response.tag_name)..." -ForegroundColor Gray
        
        Invoke-WebRequest -Uri $downloadUrl -OutFile $destPath -Headers @{"User-Agent"="Roblox-Mcp-Pro-Installer"}
        Write-Host "[OK] Installed plugin to $destPath" -ForegroundColor Green
    }
} catch {
    Write-Host "[ERROR] Failed to download plugin: $_" -ForegroundColor Red
    Write-Host "  Please download RobloxMcpPro.rbxmx manually from:" -ForegroundColor Yellow
    Write-Host "  https://github.com/PeerapolSelanon/roblox-mcp-pro/releases" -ForegroundColor Yellow
}

# [3/3] Register MCP Server
Write-Host "`n[3/3] Registering MCP Server..." -ForegroundColor Cyan

# Define candidate config paths
$configs = @(
    @{
        Name = "Claude Desktop"
        Path = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
    },
    @{
        Name = "Claude CLI"
        Path = Join-Path $env:USERPROFILE ".claude.json"
    },
    @{
        Name = "Gemini / Antigravity"
        Path = Join-Path $env:USERPROFILE ".gemini\config\mcp_config.json"
    },
    @{
        Name = "Cursor"
        Path = Join-Path $env:APPDATA "Cursor\User\globalStorage\moose-coder.cursor-mcp\mcp.json"
    },
    @{
        Name = "Cline / VS Code Extension"
        Path = Join-Path $env:APPDATA "Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json"
    },
    @{
        Name = "Windsurf"
        Path = Join-Path $env:USERPROFILE ".codeium\windsurf\mcp_config.json"
    }
)

$registeredCount = 0

# Helper to inject config
function Register-Mcp($configPath, $appName) {
    try {
        $parentDir = Split-Path $configPath -Parent
        if (-not (Test-Path $parentDir)) {
            return $false
        }
        
        $config = @{ mcpServers = @{} }
        if (Test-Path $configPath) {
            $rawContent = Get-Content -Path $configPath -Raw
            if (-not [string]::IsNullOrWhiteSpace($rawContent)) {
                $config = ConvertFrom-Json $rawContent
            }
        }
        
        if ($null -eq $config.mcpServers) {
            $config | Add-Member -MemberType NoteProperty -Name "mcpServers" -Value @{} -Force
        }
        
        # Add server config
        $serverConfig = @{
            command = "npx"
            args = @("-y", "roblox-mcp-pro")
        }
        
        # Add to mcpServers
        if ($config.mcpServers.PSObject -ne $null) {
            $config.mcpServers | Add-Member -MemberType NoteProperty -Name "roblox-mcp-pro" -Value $serverConfig -Force
        } else {
            $config.mcpServers."roblox-mcp-pro" = $serverConfig
        }
        
        $json = ConvertTo-Json $config -Depth 10
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($configPath, $json, $utf8NoBom)
        Write-Host "[OK] Registered with $($appName) ($configPath)" -ForegroundColor Green
        return $true
    } catch {
        Write-Host "[WARN] Failed to register with $($appName). Error: $_" -ForegroundColor Yellow
        return $false
    }
}

foreach ($cfg in $configs) {
    # Check if app is likely installed by looking at the parent folder
    $parent = Split-Path $cfg.Path -Parent
    if (Test-Path $parent) {
        $registered = Register-Mcp $cfg.Path $cfg.Name
        if ($registered) {
            $registeredCount++
        }
    }
}

if ($registeredCount -eq 0) {
    Write-Host "[WARN] No active AI app directories found. Please configure manually or register using:" -ForegroundColor Yellow
    Write-Host "  claude mcp add roblox-mcp-pro -- npx -y roblox-mcp-pro" -ForegroundColor Yellow
} else {
    Write-Host "[OK] Registered MCP server in $registeredCount client configurations." -ForegroundColor Green
}

Write-Host "`n==============================================" -ForegroundColor Green
Write-Host "            Installation Complete!            " -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green
Write-Host "To connect:" -ForegroundColor Cyan
Write-Host "1. Restart your AI client (Claude Desktop, Cursor, etc.)." -ForegroundColor Gray
Write-Host "2. Open Roblox Studio, click the 'MCP' button so it's highlighted." -ForegroundColor Gray
Write-Host "3. Ask your AI agent to test using the 'system_info' tool." -ForegroundColor Gray
Write-Host "==============================================" -ForegroundColor Green
Write-Host ""
