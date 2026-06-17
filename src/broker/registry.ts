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
  /** sessionId this agent is bound to (its target Place), or null if unbound. */
  boundSession: string | null;
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
  /** The Studio session the command was routed to (multi-Place feed column). */
  sessionId?: string;
  placeName?: string;
}

const AGENT_TTL_MS = 6_000; // drop agents that haven't heartbeat in this long (was 30s)
const LOG_CAP = 200; // rolling activity feed size

export class BrokerState {
  private readonly agents = new Map<string, Agent>();
  private readonly log: CommandLogEntry[] = [];

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
      boundSession: null,
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

  // --- agent → session binding ------------------------------------------

  /** Bind an agent to a Studio session (its target Place). False if unknown. */
  attach(clientId: string, sessionId: string): boolean {
    const agent = this.agents.get(clientId);
    if (!agent) return false;
    agent.boundSession = sessionId;
    this.notify();
    return true;
  }

  /** Clear an agent's binding. False if unknown. */
  detach(clientId: string): boolean {
    const agent = this.agents.get(clientId);
    if (!agent) return false;
    agent.boundSession = null;
    this.notify();
    return true;
  }

  /** The session an agent is bound to, or null. */
  boundSessionOf(clientId: string): string | null {
    return this.agents.get(clientId)?.boundSession ?? null;
  }

  /** Agents currently bound to a given session (dashboard: warn if >1). */
  agentsBoundTo(sessionId: string): Agent[] {
    return [...this.agents.values()].filter((a) => a.boundSession === sessionId);
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

  snapshot(): { agents: Agent[]; recent: CommandLogEntry[] } {
    return {
      agents: [...this.agents.values()].sort((a, b) => a.connectedAt - b.connectedAt),
      // newest first, capped for the feed
      recent: [...this.log].slice(-100).reverse(),
    };
  }

  private notify(): void {
    this.onChange?.();
  }
}
