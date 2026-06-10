# Product

## Register

product

## Users

Game developers (and the AI agents they run: Claude Code, Codex, Antigravity) driving a live
Roblox Studio session through the roblox-mcp-pro broker. The dashboard at `127.0.0.1:3690` is
their second screen: open beside Studio and a terminal, glanced at to answer "is everything
connected, what is the agent doing, which place is synced where". The product is sold
commercially, so the dashboard is also the buyer's first impression of build quality.

## Product Purpose

A monitoring and control surface for the local MCP broker: connection state of the Studio plugin
and AI agents, command activity, and Studio ↔ disk sync control. One project = one universe with
many places; the dashboard must make it unmistakable which place Studio has open, which place is
syncing, and where each place mirrors on disk. Success: a glance answers "is it working", and
when it isn't, the page says exactly what to do.

## Brand Personality

Quiet mission control. Technical, precise, calm. Status is carried by a small disciplined color
code (green = healthy, amber = degraded, red = broken) on a warm dark ground; everything else
stays low-contrast and out of the way. No salesmanship inside the tool.

## Anti-references

- SaaS marketing dashboards: gradient heroes, big vanity metrics, confetti.
- Crypto-terminal maximalism: dense neon, ticker noise, glow everywhere.
- Generic admin templates (identical card grids, sidebar-with-avatar scaffolding).

## Design Principles

1. **State is the product.** Connected/disconnected/syncing must be impossible to misread, even
   peripherally. Color + label + dot, never color alone.
2. **Say what to do next.** Every broken state ships with the exact fix steps, not just a red light.
3. **One glance, one truth.** A fact appears in one canonical spot; panels don't repeat each other.
4. **Earned color.** Accent and status hues only where they carry meaning; the ground stays quiet.
5. **No build step.** The dashboard remains a single self-contained HTML string served by the
   broker; vanilla JS + SSE, no frameworks, no external assets.

## Accessibility & Inclusion

WCAG AA contrast on the dark theme (body text ≥4.5:1). Status never communicated by color alone
(always paired with a label). Honors `prefers-reduced-motion`. Keyboard-reachable controls with
visible focus; toggles carry proper ARIA roles.
