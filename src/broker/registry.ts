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

const AGENT_TTL_MS = 30_000; // drop agents that haven't heartbeat in this long
const LOG_CAP = 200; // rolling activity feed size

export class BrokerState {
  private readonly agents = new Map<string, Agent>();
  private readonly log: CommandLogEntry[] = [];

  /** Set by the route layer to push a fresh snapshot to dashboard listeners. */
  onChange: (() => void) | null = null;

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
    if (this.agents.delete(clientId)) this.notify();
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
    if (removed) this.notify();
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
