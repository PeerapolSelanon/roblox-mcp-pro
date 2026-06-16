/**
 * manage_agents — coordinate with the other AI agents attached to this Studio
 * session: list who's connected and pass tasks/messages directly to a specific
 * agent's inbox. Handled entirely in the shared broker (no Studio round-trip),
 * since the broker is the one process that sees every agent.
 *
 * Note: MCP is request/response — a recipient only sees a message when it calls
 * `inbox`. Start a multi-agent task by checking `inbox` first, and poll it while
 * collaborating.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callStudio, describeError } from "../services/studio.js";
import { ok, fail } from "../services/format.js";

const InputSchema = z
  .object({
    action: z
      .enum(["list", "set_role", "send", "inbox", "read", "done", "sessions", "attach", "detach"])
      .describe(
        "list: connected agents (roles + bound Place) · set_role: claim lead/worker/idle · " +
          "send: deliver a task/message · inbox: messages addressed to you · " +
          "read: mark unread read · done: mark a message complete · " +
          "sessions: list connected Studio Places · attach: bind yourself to a Place (by name) · " +
          "detach: unbind.",
      ),
    role: z
      .enum(["lead", "worker", "idle"])
      .optional()
      .describe(
        "For 'set_role': lead = you plan & dispatch tasks · worker = you execute tasks others send · " +
          "idle = unassigned. Only one lead at a time (claiming lead demotes the previous lead).",
      ),
    to: z
      .string()
      .max(200)
      .optional()
      .describe(
        "For 'send': the recipient — a display name (e.g. 'claude-code'), an exact clientId, " +
          "or a group keyword: 'workers' (all worker agents), 'lead' (the current lead), 'all'.",
      ),
    subject: z.string().max(200).optional().describe("For 'send': a short subject line."),
    body: z.string().max(20_000).optional().describe("For 'send': the task/message body."),
    unreadOnly: z.boolean().optional().describe("For 'inbox': only return unread messages."),
    messageId: z.string().max(100).optional().describe("For 'done': the inbox message id to complete."),
    messageIds: z
      .array(z.string().max(100))
      .max(200)
      .optional()
      .describe("For 'read': specific message ids to mark read (default: all your unread)."),
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
  role?: string;
  self?: boolean;
}
interface Message {
  id: string;
  fromName: string;
  subject: string;
  body: string;
  status: string;
}

export function registerAgentTools(server: McpServer): void {
  server.registerTool(
    "manage_agents",
    {
      title: "Coordinate AI Agents (mailbox)",
      description:
        "Coordinate with the other AI agents driving this same Studio session: claim a role " +
        "(lead plans/dispatches, worker executes), see who's connected, and hand tasks directly " +
        "to a specific agent or a whole group. Runs in the shared broker.\n" +
        "Args: action (list|set_role|send|inbox|read|done), role? (for set_role), " +
        "to? (name, clientId, or 'workers'/'lead'/'all', for send), subject?/body? (for send), " +
        "unreadOnly? (for inbox), messageId? (for done), messageIds? (for read).\n" +
        "Returns: list → { lead, agents:[{clientId,name,role,self}] } · send → { sent:[{id,to}] } · " +
        "inbox → { count, messages:[{id,fromName,subject,body,status}] }.\n" +
        "Recipients only see a message when they call 'inbox' — poll it when collaborating.\n" +
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
            const lines = agents.map(
              (a) =>
                `${a.self ? "→ " : "  "}${a.name} [${a.role ?? "idle"}]  (${a.clientId})`,
            );
            const head = result.lead ? `Lead: ${String(result.lead)}` : "No lead claimed yet";
            return ok(result, agents.length ? `${head}\n${lines.join("\n")}` : "No agents connected.");
          }
          case "set_role":
            return ok(
              result,
              `You are now '${String(result.role)}'.` +
                (result.lead ? ` Lead: ${String(result.lead)}.` : ""),
            );
          case "send": {
            const sent = (result.sent as { to?: string }[]) ?? [];
            const names = sent.map((s) => s.to).filter(Boolean).join(", ");
            return ok(result, `Sent to ${sent.length} recipient(s)${names ? `: ${names}` : ""}.`);
          }
          case "inbox": {
            const messages = (result.messages as Message[]) ?? [];
            if (!messages.length) return ok(result, "Inbox empty.");
            const lines = messages.map(
              (m) =>
                `[${m.status}] ${m.id}\n  from ${m.fromName}: ${m.subject || "(no subject)"}\n  ${m.body}`,
            );
            return ok(result, `${messages.length} message(s):\n${lines.join("\n\n")}`);
          }
          case "read":
            return ok(result, `Marked ${result.marked ?? 0} message(s) read.`);
          case "done":
            return ok(result, `Marked ${String(result.done)} done.`);
          case "sessions": {
            const sessions = (result.sessions as { sessionId: string; placeName?: string; placeId?: number; boundAgents?: string[] }[]) ?? [];
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
