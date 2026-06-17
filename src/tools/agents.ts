/**
 * manage_agents — see the other AI agents attached to this Studio session and
 * bind yourself to a specific Place. Handled entirely in the shared broker (no
 * Studio round-trip), since the broker is the one process that sees every agent
 * and every connected Place.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callStudio, describeError } from "../services/studio.js";
import { ok, fail } from "../services/format.js";

const InputSchema = z
  .object({
    action: z
      .enum(["list", "sessions", "attach", "detach"])
      .describe(
        "list: connected agents (+ bound Place) · sessions: connected Studio Places · " +
          "attach: bind yourself to a Place (by name) · detach: unbind.",
      ),
    place: z
      .string()
      .max(200)
      .optional()
      .describe(
        "For 'attach': the Place name to bind to (e.g. 'Lobby'). Case-insensitive; " +
          "if the name is ambiguous, attach by 'session' instead.",
      ),
    session: z
      .string()
      .max(100)
      .optional()
      .describe("For 'attach': an exact sessionId (use when Place names collide)."),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface AgentInfo {
  clientId: string;
  name: string;
  self?: boolean;
}

export function registerAgentTools(server: McpServer): void {
  server.registerTool(
    "manage_agents",
    {
      title: "List Agents & Bind to a Place",
      description:
        "See the other AI agents driving this same Studio session and bind yourself to a Place. " +
        "Runs in the shared broker.\n" +
        "Args: action (list|sessions|attach|detach), place? (Place name, for attach), " +
        "session? (exact sessionId, for attach).\n" +
        "Returns: list → { agents:[{clientId,name,self}] } · sessions → { sessions:[{sessionId,placeName,placeId,boundAgents}] }.\n" +
        "Multi-Place: when several Studio Places are connected, run action:'sessions' to see them, " +
        "then action:'attach' with place:'<name>' to bind yourself before editing — commands refuse to " +
        "run while you're unbound and more than one Place is connected.",
      inputSchema: InputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input: Input) => {
      try {
        const result = await callStudio<Record<string, unknown>>("manage_agents", input);
        switch (input.action) {
          case "list": {
            const agents = (result.agents as AgentInfo[]) ?? [];
            const lines = agents.map((a) => `${a.self ? "→ " : "  "}${a.name}  (${a.clientId})`);
            return ok(result, agents.length ? lines.join("\n") : "No agents connected.");
          }
          case "sessions": {
            const sessions =
              (result.sessions as {
                sessionId: string;
                placeName?: string;
                placeId?: number;
                boundAgents?: string[];
              }[]) ?? [];
            if (!sessions.length) return ok(result, "No Studio Places connected.");
            const lines = sessions.map((s) => {
              const who = s.boundAgents?.length ? `  ← ${s.boundAgents.join(", ")}` : "";
              return `• ${s.placeName ?? "(unnamed)"}${s.placeId ? ` (placeId ${s.placeId})` : ""}  [${s.sessionId}]${who}`;
            });
            return ok(result, `${sessions.length} Place(s) connected:\n${lines.join("\n")}`);
          }
          case "attach": {
            const at = result.attached as { placeName?: string; sessionId?: string } | undefined;
            return ok(result, `Bound to '${at?.placeName ?? at?.sessionId ?? "?"}'. Your commands now target this Place.`);
          }
          case "detach":
            return ok(result, "Unbound. With >1 Place connected, attach before running commands.");
          default:
            return ok(result, JSON.stringify(result));
        }
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );
}
