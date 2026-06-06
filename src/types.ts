/**
 * Core type definitions shared across the MCP server and the Studio bridge.
 */

/** A command queued by a tool, to be executed by the Studio plugin. */
export interface Command {
  /** Unique correlation id. */
  id: string;
  /** Tool/handler name the plugin should dispatch to (e.g. "execute_luau"). */
  tool: string;
  /** Arbitrary JSON-serializable arguments for the handler. */
  args: unknown;
  /** Epoch ms the command was created. */
  createdAt: number;
  /**
   * True for broker-internal probes (e.g. the dashboard's periodic system_info).
   * The plugin still runs them but omits them from its activity log so the log
   * only shows real AI-agent commands.
   */
  internal?: boolean;
}

/** The plugin's reply to a command, posted back to /respond. */
export interface CommandResponse {
  id: string;
  ok: boolean;
  /** Present when ok === true. */
  result?: unknown;
  /** Present when ok === false — a human-readable error string. */
  error?: string;
}

/** Snapshot of bridge state for /health and the system_info tool. */
export interface BridgeStatus {
  ok: boolean;
  pluginConnected: boolean;
  queued: number;
  inflight: number;
  lastPollAt: number | null;
}

/** A change event pushed from Studio -> server (used by sync). */
export interface StudioEvent {
  /** Event kind, e.g. "added" | "removing" | "changed". */
  kind: string;
  /** Full path of the affected instance. */
  path: string;
  /** Optional payload (serialized instance, changed property, etc.). */
  data?: unknown;
}
