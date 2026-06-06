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

# [1/4] Detect Node.js
Write-Host "[1/4] Checking Prerequisites..." -ForegroundColor Cyan
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

# [2/4] Install Roblox Studio Plugin
Write-Host "`n[2/4] Installing Roblox Studio Plugin..." -ForegroundColor Cyan
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

# --------------------------------------------------------------------------
# Supported AI agents — single source of truth for BOTH the skill install
# ([3/4]) and the MCP registration ([4/4]) below. Each entry is only acted on
# when the agent is actually present on this machine (we Test-Path the relevant
# parent dir), so nothing is created for agents the user doesn't have.
#   McpPath / McpFormat — where/how to register the MCP server ("json"|"toml").
#   SkillDir            — the agent's skills/ root, or $null if the agent has no
#                         skills mechanism (only Claude Code & Codex do today).
# --------------------------------------------------------------------------
$agents = @(
    @{
        Name = "Claude Desktop"
        McpPath = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
        McpFormat = "json"
        SkillDir = $null
    },
    @{
        Name = "Claude Code"
        McpPath = Join-Path $env:USERPROFILE ".claude.json"
        McpFormat = "json"
        SkillDir = Join-Path $env:USERPROFILE ".claude\skills"
    },
    @{
        Name = "Gemini / Antigravity"
        McpPath = Join-Path $env:USERPROFILE ".gemini\config\mcp_config.json"
        McpFormat = "json"
        SkillDir = $null
    },
    @{
        Name = "Cursor"
        McpPath = Join-Path $env:APPDATA "Cursor\User\globalStorage\moose-coder.cursor-mcp\mcp.json"
        McpFormat = "json"
        SkillDir = $null
    },
    @{
        Name = "Cline / VS Code Extension"
        McpPath = Join-Path $env:APPDATA "Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json"
        McpFormat = "json"
        SkillDir = $null
    },
    @{
        Name = "Windsurf"
        McpPath = Join-Path $env:USERPROFILE ".codeium\windsurf\mcp_config.json"
        McpFormat = "json"
        SkillDir = $null
    },
    @{
        Name = "Codex"
        McpPath = Join-Path $env:USERPROFILE ".codex\config.toml"
        McpFormat = "toml"
        SkillDir = Join-Path $env:USERPROFILE ".codex\skills"
    }
)

# [3/4] Install agent skills (so AI assistants know how to drive this server in
# any project — not just this repo). Only agents that (a) have a skills/ folder
# mechanism and (b) are actually installed get the skills.
Write-Host "`n[3/4] Installing agent skills..." -ForegroundColor Cyan
$skills = @("roblox-mcp-pro", "roblox-ui-from-image", "roblox-ui-animation", "roblox-studio-plugin")
# Skill destinations = skill-capable agents that are present on this machine.
$skillRoots = @()
foreach ($agent in $agents) {
    if ($agent.SkillDir -and (Test-Path (Split-Path $agent.SkillDir -Parent))) {
        $skillRoots += $agent.SkillDir
    }
}
if ($skillRoots.Count -eq 0) {
    Write-Host "[WARN] No skill-capable agents (Claude Code / Codex) found. Skipping skill install." -ForegroundColor Yellow
}
$repo = "PeerapolSelanon/roblox-mcp-pro"
$skillCount = 0
$ghCommand = Get-Command gh -ErrorAction SilentlyContinue
foreach ($skill in $(if ($skillRoots.Count -gt 0) { $skills } else { @() })) {
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

# [4/4] Register MCP Server in all supported clients (driven by the shared
# $agents list above). Most clients share the same JSON `mcpServers` shape;
# Codex uses a TOML config and needs a different writer — the loop dispatches on
# McpFormat so it's all one step.
Write-Host "`n[4/4] Registering MCP Server..." -ForegroundColor Cyan

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
cfg.mcpServers["roblox-mcp-pro"] = { command: "npx", args: ["-y", "roblox-mcp-pro@latest"] };
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

# Helper to inject config into Codex's TOML file. Codex uses a different format
# than the JSON clients above, so we splice the [mcp_servers.roblox-mcp-pro] block
# by regex (replacing any existing one) rather than reusing the Node JSON merge.
function Register-McpToml($configPath, $appName) {
    try {
        $codexBlock = @'
[mcp_servers.roblox-mcp-pro]
command = "npx"
args = ["-y", "roblox-mcp-pro@latest"]
'@
        $existing = ""
        if (Test-Path $configPath) {
            $existing = [System.IO.File]::ReadAllText($configPath)
        }

        $pattern = '(?ms)^\[mcp_servers\.roblox-mcp-pro\]\r?\n.*?(?=^\[|\z)'
        $updated = [System.Text.RegularExpressions.Regex]::Replace($existing, $pattern, "")
        $updated = $updated.TrimEnd() + "`r`n`r`n" + $codexBlock + "`r`n"
        [System.IO.File]::WriteAllText($configPath, $updated, (New-Object System.Text.UTF8Encoding($false)))

        Write-Host "[OK] Registered with $($appName) ($configPath)" -ForegroundColor Green
        Write-Host "     Restart Codex for the new MCP server to load." -ForegroundColor Gray
        return $true
    } catch {
        Write-Host "[WARN] Failed to register with $($appName). Error: $_" -ForegroundColor Yellow
        Write-Host "  Add this to $configPath manually:" -ForegroundColor Yellow
        Write-Host '  [mcp_servers.roblox-mcp-pro]' -ForegroundColor Gray
        Write-Host '  command = "npx"' -ForegroundColor Gray
        Write-Host '  args = ["-y", "roblox-mcp-pro@latest"]' -ForegroundColor Gray
        return $false
    }
}

foreach ($agent in $agents) {
    # Check if the agent is likely installed by looking at the parent folder
    $parent = Split-Path $agent.McpPath -Parent
    if (Test-Path $parent) {
        if ($agent.McpFormat -eq "toml") {
            $registered = Register-McpToml $agent.McpPath $agent.Name
        } else {
            $registered = Register-Mcp $agent.McpPath $agent.Name
        }
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
    Write-Host "  claude mcp add roblox-mcp-pro -- npx -y roblox-mcp-pro@latest" -ForegroundColor Yellow
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
