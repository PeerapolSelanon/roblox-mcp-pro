# Build the roblox-mcp-pro Studio plugin and install it into the local
# Roblox Studio plugins folder.
#
# Usage:  .\build.ps1            # build + install
#         .\build.ps1 -NoInstall # build only

param(
    [switch]$NoInstall
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$pluginDir = Join-Path $root "plugin"
$output = Join-Path $pluginDir "RobloxMcpPro.rbxmx"

Write-Host "Building Studio plugin with rojo..." -ForegroundColor Cyan
Push-Location $pluginDir
try {
    rojo build default.project.json --output RobloxMcpPro.rbxmx
}
finally {
    Pop-Location
}

if (-not (Test-Path $output)) {
    throw "Build failed: $output was not produced."
}
Write-Host "Built $output" -ForegroundColor Green

if ($NoInstall) {
    Write-Host "Skipping install (-NoInstall)." -ForegroundColor Yellow
    return
}

$pluginsFolder = Join-Path $env:LOCALAPPDATA "Roblox\Plugins"
if (-not (Test-Path $pluginsFolder)) {
    New-Item -ItemType Directory -Path $pluginsFolder -Force | Out-Null
}

$dest = Join-Path $pluginsFolder "RobloxMcpPro.rbxmx"
Copy-Item $output $dest -Force
Write-Host "Installed plugin to $dest" -ForegroundColor Green
Write-Host "Open Roblox Studio (or it will hot-reload) and click 'MCP: Off' on the toolbar to connect." -ForegroundColor Cyan
