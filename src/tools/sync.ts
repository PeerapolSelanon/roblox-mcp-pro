/**
 * manage_sync — control the bidirectional Studio <-> filesystem mirror.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callStudio, describeError } from "../services/studio.js";
import { ok, fail } from "../services/format.js";

/** Shape returned by the broker-side sync engine. */
interface SyncStatus {
  running: boolean;
  mode: string;
  roots: string[];
  placeId: number | null;
  scriptCount: number;
  syncDir: string;
  pushed?: number;
}

const InputSchema = z
  .object({
    action: z
      .enum(["start", "stop", "status", "pull", "push"])
      .describe(
        "start: snapshot + begin two-way watching · stop: end watching · " +
          "status: report state · pull: force Studio->disk · push: force disk->Studio.",
      ),
    roots: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe(
        "For 'start': instance paths to mirror (default: ServerScriptService, " +
          "ReplicatedStorage, StarterGui, StarterPlayer, ServerStorage). Add 'Workspace' to include it.",
      ),
    mode: z
      .enum(["two-way", "studio-to-disk", "disk-to-studio"])
      .optional()
      .describe(
        "For 'start': sync direction. two-way (default) = disk<->Studio; " +
          "studio-to-disk = Studio is source of truth (mirror live edits to files, ignore disk edits); " +
          "disk-to-studio = files are source of truth (push file edits to Studio, ignore Studio edits).",
      ),
    initialDirection: z
      .enum(["studio-to-disk", "disk-to-studio"])
      .optional()
      .describe("For 'start': initial synchronization direction (pull vs push) at startup."),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

export function registerSyncTools(server: McpServer): void {
  server.registerTool(
    "manage_sync",
    {
      title: "Manage Studio <-> Local Sync",
      description:
        "Mirror the Studio DataModel to local files and keep them in sync (scripts as " +
        ".server/.client/.module.luau under roblox-mcp-sync/place_{id}/explorer/, plus sourcemap.json " +
        "for luau-lsp). Runs in the shared broker.\n" +
        "Args: action (start|stop|status|pull|push), roots? (subtrees for 'start'; default the " +
        "script services), mode? (two-way [default] | studio-to-disk | disk-to-studio).\n" +
        "Returns: { running, mode, roots, placeId, scriptCount, syncDir, pushed? }. " +
        "pull/push/stop require sync to be started first.",
      inputSchema: InputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input: Input) => {
      try {
        // Sync runs in the shared broker process (one engine for all agents).
        const status = await callStudio<SyncStatus>("manage_sync", input);
        const structured = status as unknown as Record<string, unknown>;
        switch (input.action) {
          case "start":
            return ok(
              structured,
              `Sync started (${status.mode}). Mirroring ${status.roots.join(", ")} ` +
                `(${status.scriptCount} scripts) to ${status.syncDir}.`,
            );
          case "stop":
            return ok(structured, "Sync stopped.");
          case "status":
            return ok(
              structured,
              status.running
                ? `Sync running: ${status.roots.join(", ")} (${status.scriptCount} scripts) at ${status.syncDir}.`
                : "Sync is not running.",
            );
          case "pull":
            return ok(structured, "Pulled latest from Studio to disk.");
          case "push":
            return ok(structured, `Pushed ${status.pushed ?? 0} scripts from disk to Studio.`);
          default:
            return fail("Error: unknown action.");
        }
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );
}
