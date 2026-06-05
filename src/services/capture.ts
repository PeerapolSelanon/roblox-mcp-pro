/**
 * Screen capture of the Roblox Studio window.
 *
 * This runs entirely in the MCP server process (it does NOT go through the Studio
 * plugin) because the Roblox plugin sandbox cannot read viewport pixels. On Windows
 * we drive a short PowerShell script that locates the Studio window via Win32, brings
 * it to the foreground, and grabs its pixels with System.Drawing — giving the agent a
 * real rendered image (materials, lighting, meshes, textures), not a reconstruction.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CaptureResult {
  base64: string;
  width: number;
  height: number;
  windowTitle: string;
}

/** PowerShell that captures the Studio window (or the primary screen) to a PNG. */
const PS_SCRIPT = String.raw`
param([string]$OutPath, [int]$Fullscreen = 0)
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[void][W]::SetProcessDPIAware()
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$procs = @(Get-Process -Name RobloxStudioBeta -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 })
# Prefer the place-editor window (title "<Place> - Roblox Studio") over the
# Start/Home page (title exactly "Roblox Studio"), which has no viewport/UI.
$proc = $procs | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -ne "Roblox Studio" } | Select-Object -First 1
if (-not $proc) { $proc = $procs | Select-Object -First 1 }
if (-not $proc) { Write-Error "Roblox Studio window not found (is Studio open with a place loaded?)"; exit 3 }
$h = $proc.MainWindowHandle
$title = $proc.MainWindowTitle
if ([W]::IsIconic($h)) { [void][W]::ShowWindow($h, 9); Start-Sleep -Milliseconds 250 }  # SW_RESTORE

if ($Fullscreen -eq 1) {
  # Whole primary screen — captures whatever is actually on screen.
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $w = $b.Width; $hh = $b.Height
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, (New-Object System.Drawing.Size($w, $hh)))
} else {
  # Capture the Studio window's own pixels via PrintWindow, which reads the
  # window's content directly — no need to bring it to the foreground (Windows
  # 10/11 blocks SetForegroundWindow from a background process, which made the
  # old CopyFromScreen approach grab whatever window was covering Studio).
  # PW_RENDERFULLCONTENT (2) captures hardware-accelerated content too.
  $r = New-Object W+RECT
  [void][W]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
  if ($w -le 0 -or $hh -le 0) { Write-Error "invalid window bounds"; exit 4 }
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $okPrint = $false
  try { $okPrint = [W]::PrintWindow($h, $hdc, 2) } finally { $g.ReleaseHdc($hdc) }
  if (-not $okPrint) {
    # Fallback: copy the screen region (works when Studio isn't covered).
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $hh)))
  }
}
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
[Console]::Out.Write((@{ width = $w; height = $hh; title = $title } | ConvertTo-Json -Compress))
`;

/**
 * Capture the Roblox Studio window and return the PNG as base64.
 * @throws Error with an actionable message if Studio isn't found or capture fails.
 */
export function captureStudioWindow(
  opts: { fullscreen?: boolean } = {},
): Promise<CaptureResult> {
  const dir = mkdtempSync(join(tmpdir(), "rmp-cap-"));
  const scriptPath = join(dir, "capture.ps1");
  const pngPath = join(dir, "studio.png");
  writeFileSync(scriptPath, PS_SCRIPT, "utf8");

  return new Promise<CaptureResult>((resolve, reject) => {
    const ps = spawn(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-OutPath",
        pngPath,
        "-Fullscreen",
        opts.fullscreen ? "1" : "0",
      ],
      { windowsHide: true },
    );

    let stdout = "";
    let stderr = "";
    ps.stdout.on("data", (d) => (stdout += d.toString()));
    ps.stderr.on("data", (d) => (stderr += d.toString()));
    ps.on("error", (err) => {
      cleanup();
      reject(new Error(`failed to launch PowerShell: ${err.message}`));
    });
    ps.on("close", (code) => {
      try {
        if (code !== 0) {
          const msg = stderr.trim() || `PowerShell exited with code ${code}`;
          reject(new Error(msg.split("\n")[0]));
          return;
        }
        const meta = JSON.parse(stdout.trim() || "{}") as {
          width?: number;
          height?: number;
          title?: string;
        };
        const buf = readFileSync(pngPath);
        resolve({
          base64: buf.toString("base64"),
          width: meta.width ?? 0,
          height: meta.height ?? 0,
          windowTitle: meta.title ?? "",
        });
      } catch (err) {
        reject(
          new Error(
            `capture produced no image: ${(err as Error).message}` +
              (stderr ? ` (${stderr.trim().split("\n")[0]})` : ""),
          ),
        );
      } finally {
        cleanup();
      }
    });

    function cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  });
}
