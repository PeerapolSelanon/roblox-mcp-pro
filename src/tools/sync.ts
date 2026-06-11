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
  content?: string;
  history?: { at: string; kind: string; detail: string }[];
}

const InputSchema = z
  .object({
    action: z
      .enum(["start", "stop", "status", "pull", "push", "progress", "history", "read_file", "write_file"])
      .describe(
        "start: snapshot + begin two-way watching · stop: end watching · " +
          "status: report state · pull: force Studio->disk · push: force disk->Studio · " +
          "progress: counts + last pull/push times · history: recent sync events · " +
          "read_file/write_file: read or edit a mirrored script by instance path (the watcher pushes writes to Studio).",
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
    syncDir: z
      .string()
      .optional()
      .describe("For 'start': the absolute path to the directory where files should be synced. Defaults to process.cwd()"),
    file: z
      .string()
      .max(500)
      .optional()
      .describe("For 'read_file'/'write_file': instance path (e.g. 'ReplicatedStorage.Util') or mirror-relative file path."),
    content: z
      .string()
      .max(500_000)
      .optional()
      .describe("For 'write_file': the new file content."),
    limit: z.number().int().min(1).max(100).optional().describe("For 'history': max events (default 30)."),
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
        ".server/.client/.module.luau under places/<Name>_<placeId>/explorer/, plus sourcemap.json " +
        "for luau-lsp; one project = one universe, one place folder per place). Runs in the shared broker.\n" +
        "Args: action (start|stop|status|pull|push), roots? (subtrees for 'start'; default the " +
        "script services), mode? (two-way [default] | studio-to-disk | disk-to-studio).\n" +
        "Returns: { running, mode, roots, placeId, placeName, scriptCount, syncDir, pushed? }. " +
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
        const payload = {
          ...input,
          syncDir: input.action === "start" ? (input.syncDir || process.cwd()) : undefined,
        };
        const status = await callStudio<SyncStatus>("manage_sync", payload);
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
          case "progress":
            return ok(structured, JSON.stringify(structured));
          case "history": {
            const events = status.history ?? [];
            const lines = events.map((e) => `${e.at} · ${e.kind} — ${e.detail}`);
            return ok(structured, lines.length ? lines.join("\n") : "No sync activity yet.");
          }
          case "read_file":
            return ok(structured, status.content ?? "(empty)");
          case "write_file":
            return ok(structured, "Wrote mirror file (the watcher pushes it to Studio if running).");
          default:
            return fail("Error: unknown action.");
        }
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );
}
