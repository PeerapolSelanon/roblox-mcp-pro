/**
 * manage_sync — control the bidirectional Studio <-> filesystem mirror.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describeError } from "../services/studio.js";
import { ok, fail } from "../services/format.js";
import { syncEngine } from "../sync/engine.js";

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
        switch (input.action) {
          case "start": {
            const status = await syncEngine.start(input.roots);
            return ok(
              status as unknown as Record<string, unknown>,
              `Sync started. Mirroring ${status.roots.join(", ")} ` +
                `(${status.scriptCount} scripts) to ${status.syncDir}.`,
            );
          }
          case "stop": {
            await syncEngine.stop();
            return ok(
              syncEngine.status() as unknown as Record<string, unknown>,
              "Sync stopped.",
            );
          }
          case "status": {
            const status = syncEngine.status();
            return ok(
              status as unknown as Record<string, unknown>,
              status.running
                ? `Sync running: ${status.roots.join(", ")} (${status.scriptCount} scripts) at ${status.syncDir}.`
                : "Sync is not running.",
            );
          }
          case "pull": {
            if (!syncEngine.isRunning()) return fail("Error: start sync before pulling.");
            await syncEngine.pull();
            return ok(
              syncEngine.status() as unknown as Record<string, unknown>,
              "Pulled latest from Studio to disk.",
            );
          }
          case "push": {
            if (!syncEngine.isRunning()) return fail("Error: start sync before pushing.");
            const pushed = await syncEngine.push();
            return ok(
              { ...syncEngine.status(), pushed },
              `Pushed ${pushed} scripts from disk to Studio.`,
            );
          }
          default:
            return fail("Error: unknown action.");
        }
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );
}
