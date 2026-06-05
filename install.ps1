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

# [1/5] Detect Node.js
Write-Host "[1/5] Checking Prerequisites..." -ForegroundColor Cyan
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

# [2/5] Install Roblox Studio Plugin
Write-Host "`n[2/5] Installing Roblox Studio Plugin..." -ForegroundColor Cyan
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

# [3/5] Install agent skills (so AI assistants know how to drive this server in
# any project — not just this repo). Skills live in ~/.claude/skills/<name>/ and
# ~/.codex/skills/<name>/ when those clients are present.
Write-Host "`n[3/5] Installing agent skills..." -ForegroundColor Cyan
$skills = @("roblox-mcp-pro", "roblox-ui-from-image")
$skillRoots = @(
    Join-Path $env:USERPROFILE ".claude\skills",
    Join-Path $env:USERPROFILE ".codex\skills"
)
$repo = "PeerapolSelanon/roblox-mcp-pro"
$skillCount = 0
$ghCommand = Get-Command gh -ErrorAction SilentlyContinue
foreach ($skill in $skills) {
    $apiPath = ".agents/skills/$skill/SKILL.md"
    try {
        $content = $null
        if ($ghCommand) {
            # gh api streams raw file content (works for the private repo).
            $content = & gh api "repos/$repo/contents/$apiPath" -H "Accept: application/vnd.github.v3.raw" 2>$null | Out-String
        }
        if (-not $content) {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $raw = "https://raw.githubusercontent.com/$repo/main/$apiPath"
            $content = (Invoke-WebRequest -Uri $raw -Headers @{"User-Agent"="Roblox-Mcp-Pro-Installer"}).Content
        }
        if ($content -and $content.Trim()) {
            foreach ($skillsRoot in $skillRoots) {
                $destDir = Join-Path $skillsRoot $skill
                $destFile = Join-Path $destDir "SKILL.md"
                if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
                # Write UTF-8 without BOM so the skill loader parses the frontmatter.
                [System.IO.File]::WriteAllText($destFile, $content, (New-Object System.Text.UTF8Encoding($false)))
                Write-Host "[OK] Installed skill '$skill' to $skillsRoot" -ForegroundColor Green
                $skillCount++
            }
        } else {
            Write-Host "[WARN] Could not fetch skill '$skill' (empty response)." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "[WARN] Failed to install skill '$skill': $_" -ForegroundColor Yellow
    }
}
if ($skillCount -gt 0) {
    Write-Host "[OK] $skillCount skill install(s) completed." -ForegroundColor Green
} else {
    Write-Host "[WARN] No skills installed (the AI will still work, just without the guides)." -ForegroundColor Yellow
}

# [4/5] Register MCP Server in JSON-based clients
Write-Host "`n[4/5] Registering MCP Server..." -ForegroundColor Cyan

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

# Node script that merges our server entry into an existing config and writes it back
# pretty-printed (2-space indent, UTF-8 no BOM, stable key order). We use Node — already
# verified as a prerequisite above — instead of PowerShell's ConvertTo-Json, which in
# Windows PowerShell 5.1 emits oddly-aligned output, reorders keys, and can mangle deeply
# nested existing config. Node round-trips the JSON losslessly. The script is written to a
# temp file and run as `node file.js` (not `node -e`) because PowerShell 5.1 strips the
# double quotes out of an inline -e string, which would corrupt the script.
$mergeScript = @'
const fs = require("fs");
const file = process.argv[2];
let cfg = {};
if (fs.existsSync(file)) {
  let raw = fs.readFileSync(file, "utf8");
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip UTF-8 BOM
  if (raw.trim()) {
    try {
      cfg = JSON.parse(raw);
    } catch (e) {
      // Existing file is not valid JSON. Do NOT overwrite it — abort so we never
      // destroy a user's config. Register-Mcp treats the non-zero exit as a skip.
      console.error("existing config is not valid JSON; left untouched");
      process.exit(2);
    }
  }
}
if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) cfg = {};
if (typeof cfg.mcpServers !== "object" || cfg.mcpServers === null || Array.isArray(cfg.mcpServers)) {
  cfg.mcpServers = {};
}
cfg.mcpServers["roblox-mcp-pro"] = { command: "npx", args: ["-y", "roblox-mcp-pro"] };
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
'@

$mergeScriptFile = Join-Path ([System.IO.Path]::GetTempPath()) ("rmp_merge_" + [System.Guid]::NewGuid().ToString() + ".js")
[System.IO.File]::WriteAllText($mergeScriptFile, $mergeScript, (New-Object System.Text.UTF8Encoding($false)))

# Helper to inject config
function Register-Mcp($configPath, $appName) {
    try {
        $parentDir = Split-Path $configPath -Parent
        if (-not (Test-Path $parentDir)) {
            return $false
        }

        & node $mergeScriptFile $configPath
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[WARN] Failed to register with $($appName) (node exited $LASTEXITCODE)." -ForegroundColor Yellow
            return $false
        }

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

# Clean up the temp merge script.
if (Test-Path $mergeScriptFile) {
    Remove-Item $mergeScriptFile -Force -ErrorAction SilentlyContinue
}

if ($registeredCount -eq 0) {
    Write-Host "[WARN] No active AI app directories found. Please configure manually or register using:" -ForegroundColor Yellow
    Write-Host "  claude mcp add roblox-mcp-pro -- npx -y roblox-mcp-pro" -ForegroundColor Yellow
} else {
    Write-Host "[OK] Registered MCP server in $registeredCount client configurations." -ForegroundColor Green
}

# [5/5] Register MCP Server in Codex
Write-Host "`n[5/5] Registering Codex MCP Server..." -ForegroundColor Cyan
$codexConfig = Join-Path $env:USERPROFILE ".codex\config.toml"
$codexDir = Split-Path $codexConfig -Parent
if (Test-Path $codexDir) {
    try {
        $codexBlock = @'
[mcp_servers.roblox-mcp-pro]
command = "npx"
args = ["-y", "roblox-mcp-pro"]
'@
        $existing = ""
        if (Test-Path $codexConfig) {
            $existing = [System.IO.File]::ReadAllText($codexConfig)
        }

        $pattern = '(?ms)^\[mcp_servers\.roblox-mcp-pro\]\r?\n.*?(?=^\[|\z)'
        $updated = [System.Text.RegularExpressions.Regex]::Replace($existing, $pattern, "")
        $updated = $updated.TrimEnd() + "`r`n`r`n" + $codexBlock + "`r`n"
        [System.IO.File]::WriteAllText($codexConfig, $updated, (New-Object System.Text.UTF8Encoding($false)))

        Write-Host "[OK] Registered with Codex ($codexConfig)" -ForegroundColor Green
        Write-Host "     Restart Codex for the new MCP server to load." -ForegroundColor Gray
    } catch {
        Write-Host "[WARN] Failed to register with Codex. Error: $_" -ForegroundColor Yellow
        Write-Host "  Add this to $codexConfig manually:" -ForegroundColor Yellow
        Write-Host '  [mcp_servers.roblox-mcp-pro]' -ForegroundColor Gray
        Write-Host '  command = "npx"' -ForegroundColor Gray
        Write-Host '  args = ["-y", "roblox-mcp-pro"]' -ForegroundColor Gray
    }
} else {
    Write-Host "[WARN] Codex config directory not found at $codexDir. Skipped Codex registration." -ForegroundColor Yellow
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
