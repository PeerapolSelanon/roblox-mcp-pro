/**
 * Resolve which Studio session a command should target. This is the single
 * place that enforces "never edit the wrong Place":
 *   - bound        → use it (sticky: kept even if the session is briefly gone).
 *   - unbound, 1   → use the only connected session, and signal auto-bind.
 *   - unbound, 0   → throw "not connected".
 *   - unbound, >1  → fail-closed: refuse and list the choices to attach to.
 */

import { StudioError } from "../services/errors.js";
import type { SessionStatus } from "../types.js";

export interface ResolveInput {
  /** The calling agent's bound sessionId, or null. */
  bound: string | null;
  /** Currently-connected sessions. */
  connected: SessionStatus[];
}

export interface ResolveResult {
  sessionId: string;
  /** True when the broker should record an auto-binding for the agent. */
  autoBind: boolean;
}

function label(s: SessionStatus): string {
  const name = s.placeName ?? "(unnamed place)";
  const pid = s.placeId ? ` placeId=${s.placeId}` : "";
  return `${name}${pid} [${s.sessionId}]`;
}

export function resolveTargetSession(input: ResolveInput): ResolveResult {
  const { bound, connected } = input;
  if (bound) {
    // Sticky: honor the binding even if the session is momentarily silent
    // (playtest / reconnect). enqueue surfaces a clear error if it never returns.
    return { sessionId: bound, autoBind: false };
  }
  if (connected.length === 0) {
    throw new StudioError(
      "Not connected: no Studio session is open. Open a Place, install the roblox-mcp-pro plugin, " +
        "and click Connect.",
    );
  }
  if (connected.length === 1) {
    return { sessionId: connected[0]!.sessionId, autoBind: true };
  }
  const choices = connected.map((s) => `  • ${label(s)}`).join("\n");
  throw new StudioError(
    `${connected.length} Studio Places are connected — refusing to guess which one to edit. ` +
      `Bind to one first with manage_agents { action:"attach", place:"<name>" }.\nConnected Places:\n${choices}`,
  );
}
