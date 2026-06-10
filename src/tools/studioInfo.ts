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
    action: z
      .enum(["info", "run", "pause", "stop"])
      .default("info")
      .describe("'info' reports environment; 'run'/'pause'/'stop' control Run-mode playtest."),
  })
  .strict();

const Logs = z
  .object({
    limit: z.number().int().min(1).max(500).default(100).describe("Max log entries (newest first)."),
    message_type: z
      .enum(["output", "info", "warning", "error"])
      .optional()
      .describe("Filter to one message type."),
    since: z
      .number()
      .optional()
      .describe("Only entries at/after this epoch-seconds timestamp (use started_at from manage_studio 'run')."),
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
    title: "Studio Info & Playtest",
    description:
      "Report Studio environment details, or control a Run-mode playtest (server simulation, no player).\n" +
      "Args: action ('info'|'run'|'pause'|'stop').\n" +
      "Returns: info -> { ok, studioVersion, theme, runState, placeId, gameId }; run -> { ok, runState, started_at }.\n" +
      "Playtest loop: run -> manage_logs {since: started_at} -> stop. Note: 'stop' does NOT revert changes made during the run.",
    inputSchema: Studio.shape,
    annotations: mut,
  });

  forwardTool(server, "manage_logs", {
    title: "Get Output Logs",
    description:
      "Return recent Studio Output log history (newest first), optionally filtered by type or time.\n" +
      "Args: limit (default 100), message_type? ('output'|'info'|'warning'|'error'), since? (epoch seconds).\n" +
      "Returns: { ok, count, logs: [{ message, type, timestamp }] }.\n" +
      "Use after execute_luau or a playtest (pass since: started_at from manage_studio 'run') to see what printed or errored.",
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
