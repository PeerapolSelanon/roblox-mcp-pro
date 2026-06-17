/**
 * Free vs Pro tier map. roblox-mcp-pro has a permanent free tier (core read +
 * basic editing + raw Luau, useful forever) and a Pro tier (advanced building,
 * spatial/terrain, bulk ops, bidirectional sync, playtest automation, the visual
 * toolset). New users get a 14-day trial of full Pro; after it lapses the free
 * tier keeps working and only Pro calls are gated.
 *
 * Gating is per call: a tool can be entirely Pro, or Pro only for some of its
 * `action` values (so e.g. manage_scripts.get_source stays free but its bulk
 * search/replace is Pro). Keep this in sync with the tool schemas.
 */

/** Tools whose every action requires Pro. */
const PRO_TOOLS = new Set<string>([
  "manage_ui", // UI Studio
  "ui_preview",
  "manage_terrain", // terrain generation
  "spatial_query", // spatial analysis
  "manage_tween",
  "manage_effects",
  "manage_animation",
  "manage_audio",
  "manage_camera",
  "manage_physics",
  "manage_assets",
]);

/**
 * Tools where only specific `action` values are Pro. Anything not listed here
 * (and not in PRO_TOOLS) is free. The empty-string key is unused; this is a
 * plain action allowlist of *Pro* actions per tool.
 */
const PRO_ACTIONS: Record<string, ReadonlySet<string>> = {
  manage_properties: new Set([
    "mass_get",
    "mass_set",
    "modify_children",
    "set_relative",
    "get_tagged",
  ]),
  manage_scripts: new Set([
    "edit_replace",
    "edit_insert",
    "edit_delete",
    "search",
    "replace",
    "get_dependencies",
    "analyze",
  ]),
  manage_selection: new Set(["watch"]),
  workspace_state: new Set(["changes", "viewport"]),
  // Playtest automation is a headline Pro feature; plain 'info' stays free.
  manage_studio: new Set(["run", "pause", "stop", "play", "multiplayer", "playtest_status"]),
};

/**
 * Decide whether a given tool call needs Pro. `input` is the parsed argument
 * object (post-validation), so `action`/`operations` are available.
 */
export function isProCall(toolName: string, input: unknown): boolean {
  if (PRO_TOOLS.has(toolName)) return true;

  const args = (input ?? {}) as Record<string, unknown>;

  const proActions = PRO_ACTIONS[toolName];
  if (proActions && typeof args.action === "string" && proActions.has(args.action)) {
    return true;
  }

  // mutate_instances gates per-operation: bulk 'duplicate' is Pro, the rest free.
  if (toolName === "mutate_instances" && Array.isArray(args.operations)) {
    if (args.operations.some((op) => (op as { action?: string })?.action === "duplicate")) {
      return true;
    }
  }

  // manage_sync: reading Studio -> disk is free (the hook); writing back to
  // Studio (push, or a start whose flow touches Studio) is Pro.
  if (toolName === "manage_sync") {
    const action = args.action;
    if (action === "push") return true;
    if (action === "start") {
      const mode = args.mode;
      if (mode === "two-way" || mode === "disk-to-studio") return true;
      if (args.initialDirection === "disk-to-studio") return true;
    }
  }

  return false;
}
