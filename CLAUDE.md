# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

roblox-mcp-pro is a **proprietary, paid** MCP server (npm package) that lets AI agents control a live Roblox Studio session, paired with a Roblox Studio plugin written in Luau. Clean-room original code — do not copy from other Roblox MCP projects.

## Commands

```powershell
npm run build        # compile TypeScript server to dist/
npm run docs         # regenerate .agents/skills/roblox-mcp-pro/references/tools.md from compiled schemas
npm test             # build + hermetic smokes: scripts/smoke.mjs (tool registry) + scripts/license-smoke.mjs
npm run lint         # biome lint (TypeScript; lint-only, no formatting)
npm run dev          # server with auto-reload (tsx watch src/index.ts)
npm run inspector    # exercise tools via MCP Inspector (needs dist/ built)
.\build.ps1          # build the Studio plugin (.rbxmx via rojo) and install to %LOCALAPPDATA%\Roblox\Plugins
.\build.ps1 -NoInstall  # plugin build only
```

**CI** (`.github/workflows/ci.yml`, on push/PR) gates merges with, in order: biome lint (TS) → `tsc` build → `scripts/smoke.mjs` (tool registry) → `scripts/license-smoke.mjs` (trial + offline-grace) → tool-docs freshness (`npm run docs` must produce no diff) → selene (plugin Luau) → rojo plugin build. Keep them green:
- After changing a tool's zod schema/description, run `npm run docs` and commit `tools.md` (the freshness gate fails otherwise).
- The smokes are hermetic — no Studio, license, network, or real `~/.roblox-mcp-pro` (license-smoke redirects `HOME` to a temp dir and points the proxy at a dead port). Add cases there when you change tool registration or licensing logic.
- selene config: `selene.toml` + `plugin.yml` (std extension for the `plugin`/`version` globals); `roblox.yml` is generated in CI and gitignored. Run `selene plugin/src` locally (needs the std: `selene generate-roblox-std`).

`scripts/test-*.mjs` are manual e2e helpers that need a live Studio session (e.g. `node scripts/test-search.mjs` spawns `dist/index.js` over stdio and calls a tool); they are excluded from biome and not run in CI. This repo includes `.mcp.json`, so the roblox-mcp-pro MCP tools are available in-session.

**Releasing:** `npm version patch` then `git push --follow-tags`. The `v*` tag triggers `.github/workflows/release.yml` (builds plugin, GitHub Release, npm publish). `prepublishOnly` runs `scripts/obfuscate.mjs`, which obfuscates `dist/` in place and strips source maps/.d.ts — published code is intentionally unreadable; local builds stay readable.

## Architecture

Three processes, two hops:

```
AI agent ─MCP stdio─▶ src/index.ts (client, one per agent)
                        │ HTTP 127.0.0.1:3690
                        ▼
                      Broker (src/broker/, shared singleton; queue + web dashboard at /)
                        ▲ long-poll /dequeue
                        │
                      Studio plugin (plugin/src/, Luau) → runs commands in Studio
```

- **Client mode** (`src/index.ts`): each agent spawns its own MCP stdio server. It does NOT bind the port; it connects to a shared broker via `src/client/transport.ts`, auto-spawning the broker (`src/broker/main.ts`) if none is running. This lets multiple agents drive one Studio session concurrently.
- **Broker** owns port 3690 (`ROBLOX_MCP_PORT`), queues commands, tracks agent registry and plugin liveness, serves the monitor dashboard.
- **Plugin** (`plugin/src/init.server.luau` → `Bridge.luau` long-polls → `Dispatcher.luau` routes to `Handlers/*.luau`). Handlers are loaded defensively: one broken handler disables only its own tool.

### Adding or changing a tool (spans both languages)

1. **Server side**: register in `src/tools/*.ts` — most tools just call `forwardTool()` (`src/tools/_forward.ts`), which validates input with zod and forwards to Studio via `callStudio(name, input)`. Wire new files into `src/tools/index.ts`.
2. **Plugin side**: add `Handlers/<Name>.luau` and map the tool name in `HANDLER_NAMES` in `plugin/src/Dispatcher.luau`.
3. If the tool is read-only or shouldn't create undo steps, also add it to `NO_WAYPOINT` in Dispatcher — every other command gets one ChangeHistoryService waypoint (= one Ctrl+Z step) per dispatch.
4. Rebuild/install the plugin with `.\build.ps1` and restart Studio (or toggle the MCP button) to test.

### Key conventions and constraints

- **stdout is reserved for the MCP protocol** — all server logging goes to stderr (see `log()` in `src/index.ts`).
- Tool responses return **compact JSON** (not pretty-printed) to save agent tokens; full object rides in `structuredContent`. Responses are truncated at `CHARACTER_LIMIT` (25k chars, `src/constants.ts`).
- `PROTECTED_SERVICES` in `src/constants.ts` lists services that must never be mutated (CoreGui etc.).
- Plugin Luau files use `--!strict`.
- **Licensing** (`src/licensing/`): LemonSqueezy key validation with 14-day local trial and offline grace; `installLicenseGate()` wraps the MCP server so locked sessions short-circuit before tools run. License resolution happens before tool registration in `src/index.ts`.
- On startup the server **auto-installs/updates** the bundled Studio plugin and agent skills (`src/install-plugin.ts`, `src/install-skills.ts`); opt-outs via `ROBLOX_MCP_NO_PLUGIN_AUTOINSTALL=1` / `ROBLOX_MCP_NO_SKILL_AUTOINSTALL=1`.
- Bidirectional Studio ↔ disk sync lives in `src/sync/` (engine, mirror, sourcemap) with plugin counterparts `SyncSnapshot/SyncWatch/SyncApply.luau`.
- The shipped agent skills under `.agents/skills/` (roblox-mcp-pro, roblox-studio-plugin, roblox-ui-animation, roblox-ui-from-image) are part of the published package (`files` in package.json). The per-parameter tool reference (`roblox-mcp-pro/references/tools.md`) is **generated** — run `npm run docs` after changing tool schemas (also runs in `prepublishOnly`). Only the curated workflow advice in SKILL.md needs manual updates.

## Code review graph

Per `AGENTS.md`: this project has a code-review-graph MCP knowledge graph. Prefer its tools (`semantic_search_nodes`, `query_graph`, `get_impact_radius`, `detect_changes`) before Grep/Glob/Read for exploration and review; fall back to file scanning only when the graph doesn't cover what you need.

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
