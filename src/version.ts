/** The running package version, read from package.json at the package root. */
import { readFileSync } from "node:fs";

let version = "unknown";
try {
  // dist/version.js -> ../package.json (package root; always shipped by npm).
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: string };
  if (pkg.version) version = pkg.version;
} catch {
  // Leave "unknown" if package.json can't be read.
}

export const VERSION = version;
