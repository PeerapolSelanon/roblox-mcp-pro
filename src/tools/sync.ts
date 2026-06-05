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
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

export function registerSyncTools(server: McpServer): void {
  server.registerTool(
    "manage_sync",
    {
      title: "Manage Studio <-> Local Sync",
      description: `Mirror the Roblox Studio DataModel to local files and keep them in sync both ways.

Scripts are written as .server/.client/.module.luau, other instances as {Name}.props.json
under roblox-mcp-sync/place_{placeId}/explorer/, plus a sourcemap.json for luau-lsp.
Editing a .luau file updates the script in Studio; editing a script in Studio updates the file.

Args:
  - action ('start'|'stop'|'status'|'pull'|'push'): operation to perform.
  - roots (string[], optional): for 'start', which subtrees to mirror.

Returns (structured):
  { "running": boolean, "roots": string[], "placeId": number|null,
    "scriptCount": number, "syncDir": string, "pushed"?: number }

Examples:
  - Begin syncing defaults: action: "start"
  - Sync gameplay folder too: action: "start", roots: ["ServerScriptService","Workspace.Systems"]
  - Re-pull everything from Studio: action: "pull"

Error Handling:
  - Returns "Error: …not connected" if no Studio session is attached.
  - 'pull'/'push'/'stop' require sync to have been started first.`,
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
              `Sync started. Mirroring ${status.roots.join(", ")} ` +
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
