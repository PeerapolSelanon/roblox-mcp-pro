/**
 * Broker state: the set of connected MCP clients (AI agents) and a rolling log
 * of the commands they've run. Drives the monitoring dashboard.
 *
 * Each AI agent (Claude Code, Codex, Antigravity, …) spawns its own MCP server
 * process, which registers here as a client. The broker multiplexes their
 * commands onto the single Studio plugin, so this is the one place that sees
 * every agent and every command.
 */

import { randomUUID } from "node:crypto";

/** Coordination role an agent claims for multi-agent work. */
export type AgentRole = "lead" | "worker" | "idle";

/** A connected MCP client (one per AI agent process). */
export interface Agent {
  clientId: string;
  /** Display name from the MCP client handshake, e.g. "claude-code". */
  name: string;
  version?: string;
  pid?: number;
  cwd?: string;
  connectedAt: number;
  lastSeenAt: number;
  commandCount: number;
  /** lead = plans & dispatches · worker = executes tasks · idle = unassigned. */
  role: AgentRole;
}

/** One executed command, for the dashboard activity feed. */
export interface CommandLogEntry {
  ts: number;
  clientId: string;
  agent: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

/**
 * A direct message/task from one agent to another, routed through the broker.
 * The broker is the only process that sees every agent, so the mailbox lives
 * here — no Studio round-trip involved.
 */
export interface MailboxMessage {
  id: string;
  fromClientId: string;
  fromName: string;
  /** Resolved recipient (a single connected agent at send time). */
  toClientId: string;
  toName: string;
  subject: string;
  body: string;
  status: "unread" | "read" | "done";
  ts: number;
  doneAt?: number;
}

const AGENT_TTL_MS = 6_000; // drop agents that haven't heartbeat in this long (was 30s)
const LOG_CAP = 200; // rolling activity feed size
const MAILBOX_CAP = 500; // rolling cap on stored messages

export class BrokerState {
  private readonly agents = new Map<string, Agent>();
  private readonly log: CommandLogEntry[] = [];
  private readonly messages: MailboxMessage[] = [];

  /** Set by the route layer to push a fresh snapshot to dashboard listeners. */
  onChange: (() => void) | null = null;
  /** Fired when the connected-agent count transitions from 1 → 0. The broker
   *  uses this to start its prompt-teardown timer (see broker/main.ts). */
  onEmpty: (() => void) | null = null;

  register(name: string, version: string | undefined, pid: number | undefined, cwd?: string): string {
    const clientId = randomUUID();
    const now = Date.now();
    this.agents.set(clientId, {
      clientId,
      name: name || "agent",
      version,
      pid,
      cwd,
      connectedAt: now,
      lastSeenAt: now,
      commandCount: 0,
      role: "idle",
    });
    this.notify();
    return clientId;
  }

  /** Update an agent's display name once the MCP handshake reveals it. */
  identify(clientId: string, name: string, version?: string): void {
    const agent = this.agents.get(clientId);
    if (!agent) return;
    agent.name = name || agent.name;
    if (version) agent.version = version;
    this.notify();
  }

  heartbeat(clientId: string): boolean {
    const agent = this.agents.get(clientId);
    if (!agent) return false;
    agent.lastSeenAt = Date.now();
    return true;
  }

  deregister(clientId: string): void {
    if (this.agents.delete(clientId)) {
      this.notify();
      if (this.agents.size === 0) this.onEmpty?.();
    }
  }

  agentName(clientId: string): string {
    return this.agents.get(clientId)?.name ?? "unknown";
  }

  recordCommand(entry: CommandLogEntry): void {
    this.log.push(entry);
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
    const agent = this.agents.get(entry.clientId);
    if (agent) {
      agent.commandCount += 1;
      agent.lastSeenAt = entry.ts;
    }
    this.notify();
  }

  // --- coordination roles ------------------------------------------------

  /** Claim a role. Claiming 'lead' demotes any current lead (single lead). */
  setRole(clientId: string, role: AgentRole): Agent | null {
    const agent = this.agents.get(clientId);
    if (!agent) return null;
    if (role === "lead") {
      for (const a of this.agents.values()) {
        if (a.clientId !== clientId && a.role === "lead") a.role = "worker";
      }
    }
    agent.role = role;
    this.notify();
    return agent;
  }

  /** The current lead, if any. */
  lead(): Agent | null {
    for (const a of this.agents.values()) if (a.role === "lead") return a;
    return null;
  }

  /** All agents currently in the worker role. */
  workers(): Agent[] {
    return [...this.agents.values()].filter((a) => a.role === "worker");
  }

  // --- agent-to-agent mailbox -------------------------------------------

  /** Agents matching a target: an exact clientId, else a case-insensitive name. */
  matchAgents(to: string): Agent[] {
    const t = to.trim();
    const byId = this.agents.get(t);
    if (byId) return [byId];
    const lower = t.toLowerCase();
    return [...this.agents.values()].filter((a) => a.name.toLowerCase() === lower);
  }

  /** File a message for a single resolved recipient. */
  sendMessage(fromClientId: string, to: Agent, subject: string, body: string): MailboxMessage {
    const msg: MailboxMessage = {
      id: randomUUID(),
      fromClientId,
      fromName: this.agents.get(fromClientId)?.name ?? "unknown",
      toClientId: to.clientId,
      toName: to.name,
      subject,
      body,
      status: "unread",
      ts: Date.now(),
    };
    this.messages.push(msg);
    if (this.messages.length > MAILBOX_CAP) {
      this.messages.splice(0, this.messages.length - MAILBOX_CAP);
    }
    this.notify();
    return msg;
  }

  /** Messages addressed to an agent, newest first. */
  inbox(clientId: string, unreadOnly = false): MailboxMessage[] {
    return this.messages
      .filter((m) => m.toClientId === clientId && (!unreadOnly || m.status === "unread"))
      .reverse();
  }

  /** Mark an agent's unread messages read (all, or the given ids). Returns count. */
  markRead(clientId: string, ids?: string[]): number {
    let n = 0;
    for (const m of this.messages) {
      if (m.toClientId !== clientId || m.status !== "unread") continue;
      if (ids && !ids.includes(m.id)) continue;
      m.status = "read";
      n += 1;
    }
    if (n) this.notify();
    return n;
  }

  /** Mark one of an agent's messages done. Returns false if not found/not theirs. */
  markDone(clientId: string, id: string): boolean {
    const m = this.messages.find((x) => x.id === id && x.toClientId === clientId);
    if (!m) return false;
    m.status = "done";
    m.doneAt = Date.now();
    this.notify();
    return true;
  }

  /** Drop agents that stopped heartbeating (process died without deregistering). */
  prune(): void {
    const cutoff = Date.now() - AGENT_TTL_MS;
    let removed = false;
    for (const [id, agent] of this.agents) {
      if (agent.lastSeenAt < cutoff) {
        this.agents.delete(id);
        removed = true;
      }
    }
    if (removed) {
      this.notify();
      if (this.agents.size === 0) this.onEmpty?.();
    }
  }

  agentCount(): number {
    return this.agents.size;
  }

  snapshot(): { agents: Agent[]; recent: CommandLogEntry[]; mailbox: MailboxMessage[] } {
    return {
      agents: [...this.agents.values()].sort((a, b) => a.connectedAt - b.connectedAt),
      // newest first, capped for the feed
      recent: [...this.log].slice(-100).reverse(),
      mailbox: [...this.messages].slice(-100).reverse(),
    };
  }

  private notify(): void {
    this.onChange?.();
  }
}
