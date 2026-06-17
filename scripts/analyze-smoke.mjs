/**
 * Hermetic smoke for the Luau diagnostic parser (no analyzer binary needed).
 * Verifies parsing of both output styles, noise filtering, and the
 * "failed-but-unparsed" safety net.
 */
import assert from "node:assert/strict";
import { parseDiagnostics } from "../dist/services/analyze.js";

// Paren style (luau native / luau-lsp), with one real error and one noise line.
const out = [
  "source.luau(3,5): SyntaxError: Expected ')' but got 'end'",
  "source.luau(7,1): TypeError: Unknown global 'workspace'",
].join("\n");
const diags = parseDiagnostics(out, 1);
assert.equal(diags.length, 1, "noise (Unknown global) should be filtered out");
assert.equal(diags[0].line, 3);
assert.equal(diags[0].severity, "error");

// Colon style fallback.
const colon = parseDiagnostics("source.luau:10:2: unexpected symbol", 1);
assert.equal(colon.length, 1);
assert.equal(colon[0].line, 10);

// Clean run -> no diagnostics.
assert.equal(parseDiagnostics("", 0).length, 0, "clean exit = no diagnostics");

// Failed run we couldn't parse -> surface raw text, never a false all-clear.
const opaque = parseDiagnostics("luau-analyze: fatal: boom", 1);
assert.equal(opaque.length, 1, "unparsed failure must not report clean");

console.log("analyze-smoke: OK — diagnostic parsing + noise filter.");
