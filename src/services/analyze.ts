/**
 * Static Luau analysis. Shells out to a Luau analyzer (luau-lsp / luau-analyze)
 * found on PATH or in a Roblox toolchain bin dir (rokit/aftman/foreman), so an
 * agent can catch syntax/type errors BEFORE a full playtest — tightening the
 * write→verify loop. Degrades gracefully to `analyzer: "none"` when no analyzer
 * is installed anywhere we look, so it never hard-fails.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

export interface Diagnostic {
  line: number;
  column?: number;
  severity: "error" | "warning";
  message: string;
}

/** Analyzer CLIs we know how to drive, best first: [bin, args-before-file]. */
const ANALYZERS: [string, string[]][] = [
  ["luau-lsp", ["analyze"]],
  ["luau-analyze", []],
];

// A lone script has no DataModel or type defs, so a standalone analyzer flags
// every Roblox global (game/script/workspace…) and every unresolved require.
// Drop that noise so the real signal (syntax errors, obvious bugs) isn't buried.
// ponytail: regex denylist, swap for real Roblox type defs + sourcemap context
// (analyze the disk-synced file in project context) when these false positives
// start hiding real errors.
const NOISE = [
  /Unknown (global|require|type|symbol)/i,
  /Unknown (built-in|library)/i,
  /Cannot find name/i,
  /could not be resolved/i,
  /Unknown type ['"]/i,
];

// e.g.  source.luau(12,5): SyntaxError: Expected ')'   (luau native / luau-lsp)
const PAREN_RE = /\((\d+),(\d+)\):\s*(\w+)?:?\s*(.*)/;
// e.g.  source.luau:12:5: message                       (colon style fallback)
const COLON_RE = /:(\d+):(\d+):\s*(.*)/;

/**
 * Parse analyzer stdout/stderr into structured diagnostics. Pure (no I/O) so it
 * can be unit-tested with canned analyzer output. `status` is the process exit
 * code: if the analyzer failed but we parsed nothing, we surface the raw text as
 * one diagnostic rather than reporting a false all-clear.
 */
export function parseDiagnostics(
  text: string,
  status: number | null,
  filterNoise = true,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const paren = raw.match(PAREN_RE);
    const colon = paren ? null : raw.match(COLON_RE);
    const m = paren ?? colon;
    if (!m) continue;
    const message = ((paren ? m[4] : m[3]) ?? "").trim();
    if (!message) continue;
    if (filterNoise && NOISE.some((re) => re.test(message))) continue;
    diagnostics.push({
      line: Number(m[1]),
      column: Number(m[2]),
      severity: paren && !/error/i.test(m[3] ?? "error") ? "warning" : "error",
      message,
    });
  }
  // Analyzer reported failure but nothing parsed — don't hide it.
  if (diagnostics.length === 0 && status && status !== 0) {
    const trimmed = text.trim();
    if (trimmed) {
      diagnostics.push({ line: 0, severity: "error", message: trimmed.slice(0, 1000) });
    }
  }
  return diagnostics;
}

// Roblox devs usually install luau-lsp via a toolchain manager (rokit/aftman/
// foreman), whose bin dir is on the *shell* PATH but not on a GUI-launched
// process's PATH — so a PATH-only probe misses it. Also check these dirs.
const TOOLCHAIN_BINS = [".rokit/bin", ".aftman/bin", ".foreman/bin"].map((d) =>
  join(homedir(), d),
);
const EXE = process.platform === "win32" ? ".exe" : "";

/** Resolve an analyzer to a runnable command (bare name if on PATH, else a full
 *  toolchain path), or null if it isn't installed anywhere we look. */
function resolveBinary(bin: string): string | null {
  if (!spawnSync(bin, ["--version"], { stdio: "ignore" }).error) return bin;
  for (const dir of TOOLCHAIN_BINS) {
    const full = join(dir, bin + EXE);
    if (existsSync(full)) return full;
  }
  return null;
}

/** Run the first available analyzer over `source`. */
export function analyzeSource(
  source: string,
  filterNoise = true,
): { analyzer: string; diagnostics: Diagnostic[] } {
  let resolved: { cmd: string; preArgs: string[] } | undefined;
  for (const [bin, preArgs] of ANALYZERS) {
    const cmd = resolveBinary(bin);
    if (cmd) {
      resolved = { cmd, preArgs };
      break;
    }
  }
  if (!resolved) return { analyzer: "none", diagnostics: [] };

  const dir = mkdtempSync(join(tmpdir(), "rmp-analyze-"));
  const file = join(dir, "source.luau");
  try {
    writeFileSync(file, source, "utf8");
    const run = spawnSync(resolved.cmd, [...resolved.preArgs, file], { encoding: "utf8" });
    const text = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    return { analyzer: resolved.cmd, diagnostics: parseDiagnostics(text, run.status, filterNoise) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
