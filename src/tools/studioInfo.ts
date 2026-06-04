/**
 * Studio/inspection tools: manage_selection, manage_studio, manage_logs, workspace_state.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InstancePath } from "../schemas/common.js";
import { forwardTool } from "./_forward.js";

const Selection = z
  .object({
    action: z.enum(["get", "set", "add", "clear"]).describe("Read or change the Explorer selection."),
    paths: z.array(InstancePath).max(500).optional().describe("Instance paths for set/add."),
  })
  .strict();

const Studio = z
  .object({
    action: z.enum(["info"]).default("info").describe("Report Studio environment info."),
  })
  .strict();

const Logs = z
  .object({
    limit: z.number().int().min(1).max(500).default(100).describe("Max log entries (newest first)."),
    message_type: z
      .enum(["output", "info", "warning", "error"])
      .optional()
      .describe("Filter to one message type."),
  })
  .strict();

const WorkspaceState = z.object({}).strict();

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const mut = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export function registerStudioInfoTools(server: McpServer): void {
  forwardTool(server, "manage_selection", {
    title: "Manage Explorer Selection",
    description:
      "Read or change which instances are selected in the Studio Explorer.\n" +
      "Args: action ('get'|'set'|'add'|'clear'), paths?.\n" +
      "Returns: { ok, selection: string[] }.\n" +
      "Example: action: 'set', paths: ['Workspace.Model.Part1', 'Workspace.Model.Part2'].",
    inputSchema: Selection.shape,
    annotations: mut,
  });

  forwardTool(server, "manage_studio", {
    title: "Studio Info",
    description:
      "Report Studio environment details (version, theme, run/edit state, place/game ids).\n" +
      "Args: action ('info').\n" +
      "Returns: { ok, studioVersion, theme, isRunning, isEdit, placeId, gameId }.",
    inputSchema: Studio.shape,
    annotations: read,
  });

  forwardTool(server, "manage_logs", {
    title: "Get Output Logs",
    description:
      "Return recent Studio Output log history (newest first), optionally filtered by type.\n" +
      "Args: limit (default 100), message_type? ('output'|'info'|'warning'|'error').\n" +
      "Returns: { ok, count, logs: [{ message, type, timestamp }] }.\n" +
      "Use after execute_luau or a playtest to see what was printed or errored.",
    inputSchema: Logs.shape,
    annotations: read,
  });

  forwardTool(server, "workspace_state", {
    title: "Workspace State Snapshot",
    description:
      "High-level read-only snapshot of the session.\n" +
      "Args: none.\n" +
      "Returns: { ok, placeId, placeName, isRunning, gravity, childCounts, selectionCount, camera }.\n" +
      "Use to orient before making changes.",
    inputSchema: WorkspaceState.shape,
    annotations: read,
  });
}
