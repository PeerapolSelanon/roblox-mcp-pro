/**
 * Studio/inspection tools: manage_selection, manage_studio, manage_logs, workspace_state.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InstancePath } from "../schemas/common.js";
import { forwardTool } from "./_forward.js";
import { callStudio, describeError } from "../services/studio.js";
import { ok, fail } from "../services/format.js";

const Selection = z
  .object({
    action: z
      .enum(["get", "set", "add", "clear", "watch"])
      .describe(
        "Read or change the Explorer selection. 'watch' waits for the USER to change it — " +
          "ask them to click the instance(s) in Studio, then call watch.",
      ),
    paths: z.array(InstancePath).max(500).optional().describe("Instance paths for set/add."),
    timeout: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("For 'watch': seconds to wait for a selection change (default 10, max 20)."),
  })
  .strict();

const Studio = z
  .object({
    action: z
      .enum(["info", "run", "pause", "stop", "play", "multiplayer", "playtest_status"])
      .default("info")
      .describe(
        "'info' environment; 'run'/'pause'/'stop' Run mode (server sim, same DataModel); " +
          "'play' real Play Solo, 'multiplayer' server+N clients (StudioTestService), " +
          "'playtest_status' poll the play/multiplayer result.",
      ),
    duration: z
      .number()
      .int()
      .min(1)
      .max(600)
      .optional()
      .describe("For 'play'/'multiplayer': max seconds before the test auto-ends (default 30)."),
    test_script: z
      .string()
      .max(100_000)
      .optional()
      .describe(
        "For 'play': Luau run on the test session's CLIENT with a preloaded `Test` helper. Movement (drives real gameplay): " +
          "Test.walkTo(Vector3|path), pathTo(...), moveDir('w'|'a'|'s'|'d', seconds), jump(). " +
          "Text entry: typeText(path, text, pressEnter?). Trigger control logic (Studio sandboxes synthetic mouse/key input in playtests, " +
          "so fire the event a button/key is wired to): fireRemote(path, ...), fireBindable(path, ...), invokeModule(path, fnName, ...). " +
          "Assertions: assertExists/assertVisible/assertText/assertNear/expect (a failed assert ends the test with that error). " +
          "(Test.click/pressKey/etc. exist but throw a pointer to the above — hardware input can't be synthesized.) " +
          "For 'multiplayer': Luau run on the server (no Test helper). Prints/errors land in the report; the test ends when the script returns or 'duration' elapses.",
      ),
    num_players: z
      .number()
      .int()
      .min(1)
      .max(8)
      .optional()
      .describe("For 'multiplayer': simulated clients (default 1, max 8)."),
    capture: z
      .boolean()
      .optional()
      .describe(
        "For 'playtest_status': also attach a live screenshot of the running game (one rendered " +
          "frame) as visual proof. Adds capture latency — request it on a single poll, not every poll.",
      ),
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

const WorkspaceState = z
  .object({
    action: z
      .enum(["snapshot", "changes", "viewport"])
      .default("snapshot")
      .describe(
        "'snapshot': high-level session summary. 'changes': diff the instance tree against the " +
          "previous 'changes' call — what was added/removed since (first call only sets the baseline). " +
          "'viewport': what the Studio camera is looking at (pose, focus part, parts in view).",
      ),
  })
  .strict();

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const mut = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export function registerStudioInfoTools(server: McpServer): void {
  forwardTool(server, "manage_selection", {
    title: "Manage Explorer Selection",
    description:
      "Read or change which instances are selected in the Studio Explorer, or wait for the user " +
      "to select something ('watch') — a natural way for them to point at instances for you.\n" +
      "Args: action ('get'|'set'|'add'|'clear'|'watch'), paths?, timeout? (watch, default 10s).\n" +
      "Returns: { ok, selection: string[], changed? (watch) }.\n" +
      "Example: ask the user to click the broken part, then action: 'watch' -> selection has its path.",
    inputSchema: Selection.shape,
    annotations: mut,
  });

  server.registerTool(
    "manage_studio",
    {
      title: "Studio Info & Playtest",
      description:
        "Report Studio environment details, or run a playtest.\n" +
        "Args: action ('info'|'run'|'pause'|'stop'|'play'|'multiplayer'|'playtest_status'), duration?, test_script?, num_players?, capture?.\n" +
        "Run mode loop: run -> manage_logs {since: started_at} -> stop ('stop' does NOT revert changes).\n" +
        "Play Solo loop: play {test_script?, duration?} -> poll playtest_status until finished -> report has the test session's logs/errors/EndTest value (client report under report.client). report.ok is false if the test_script threw OR the game raised any runtime error during the playtest; report.hadErrors/errorCount/errors[] (first 10 messages) surface those runtime errors, while report.error is the test_script failure. So an observe-only run (no test_script) still reports ok:false when game scripts errored. The plugin suspends during the playtest; playtest_status still answers ({running:true, suspended:true}) — keep polling until running:false. Pass capture:true on a playtest_status poll to also get a live screenshot of the running game (visual proof, not just logs). For 'play', test_script runs on the client with a `Test` helper to walk the character, enter text, fire the events controls are wired to, and assert state (see test_script). 'multiplayer' is the same with num_players clients (server-side script, no Test helper).",
      inputSchema: Studio.shape,
      annotations: mut,
    },
    async (input) => {
      try {
        const args = Studio.parse(input);
        const result = await callStudio<Record<string, unknown>>("manage_studio", args);
        // A playtest_status frame rides back as base64; surface it as an image
        // block (and strip it from the text/structured payload — it's huge).
        if (typeof result.screenshot === "string") {
          const { screenshot, ...rest } = result;
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(rest) },
              { type: "image" as const, data: screenshot, mimeType: "image/png" },
            ],
            structuredContent: rest,
          };
        }
        return ok(result, JSON.stringify(result));
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

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
      "High-level read-only snapshot of the session, or a tree diff since the last check.\n" +
      "Args: action ('snapshot' [default] | 'changes').\n" +
      "Returns: snapshot -> { ok, placeId, placeName, isRunning, gravity, childCounts, selectionCount, camera }; " +
      "changes -> { ok, addedTotal, removedTotal, added:[{path,className}], removed:[paths] } " +
      "(first call returns baselineCreated; renames show as remove+add; property edits aren't tracked); " +
      "viewport -> { ok, position, lookVector, fieldOfView, viewportSize, focus:{instance,position,distance}, partsInView }.\n" +
      "Use snapshot to orient; changes to verify edits/spot user changes; viewport to see what's on the user's screen.",
    inputSchema: WorkspaceState.shape,
    annotations: read,
  });
}
