/**
 * The monitoring dashboard — a single self-contained HTML page (no build step,
 * no external assets) served by the broker at `/`. It opens an SSE stream to
 * `/api/stream` and re-renders on every update, falling back to polling
 * `/api/state` if the stream drops.
 *
 * Design goal: the connection state of the two things that can break — the
 * Studio plugin and the AI agents — must be impossible to misread, and when
 * either is down the page says exactly what to do about it. Everything the
 * broker knows (Studio session, broker, sync, agents, activity) is shown.
 */

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>roblox-mcp-pro · monitor</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%23e8633a'/><rect x='30' y='30' width='40' height='40' rx='6' fill='%23150f0c'/></svg>" />
<style>
  :root {
    --bg: oklch(0.165 0.012 45); --panel: oklch(0.205 0.014 45); --panel2: oklch(0.245 0.016 45);
    --border: oklch(0.30 0.016 45); --border-soft: oklch(0.26 0.015 45);
    --text: oklch(0.96 0.008 70); --muted: oklch(0.745 0.014 55); --faint: oklch(0.60 0.012 55);
    --accent: oklch(0.70 0.19 45);
    --green: oklch(0.80 0.15 155); --red: oklch(0.66 0.20 25); --amber: oklch(0.80 0.15 80);
    --green-bg: color-mix(in oklch, var(--green) 12%, transparent);
    --red-bg: color-mix(in oklch, var(--red) 12%, transparent);
    --amber-bg: color-mix(in oklch, var(--amber) 12%, transparent);
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.55 var(--sans); -webkit-font-smoothing: antialiased;
  }
  header {
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    padding: 14px 24px; border-bottom: 1px solid var(--border-soft);
    background: color-mix(in oklch, var(--bg) 80%, transparent); backdrop-filter: blur(10px);
    position: sticky; top: 0; z-index: 10;
  }
  header .mark { width: 22px; height: 22px; border-radius: 6px; background: var(--accent); display: grid; place-items: center; flex: none; }
  header .mark span { width: 9px; height: 9px; background: var(--bg); border-radius: 2px; }
  header h1 { font-size: 15px; margin: 0; font-weight: 700; letter-spacing: -.01em; }
  header small { font-size: 12px; font-family: var(--mono); }
  .badge { display: inline-flex; align-items: center; gap: 7px; padding: 4px 11px;
    border-radius: 999px; border: 1px solid var(--border-soft); font-size: 12px; font-family: var(--mono); color: var(--muted); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: none; }
  .dot.on { background: var(--green); box-shadow: 0 0 7px var(--green); }
  .dot.off { background: var(--red); box-shadow: 0 0 7px var(--red); }
  .dot.warn { background: var(--amber); box-shadow: 0 0 7px var(--amber); }
  .spacer { flex: 1; }
  main { padding: 24px; display: grid; gap: 22px; max-width: 1100px; margin: 0 auto; }

  /* Diagnostics banner */
  .banner { border: 1px solid var(--border); border-radius: 12px; padding: 15px 18px; }
  .banner.ok { background: var(--green-bg); border-color: color-mix(in oklch, var(--green) 45%, var(--border)); }
  .banner.bad { background: var(--red-bg); border-color: color-mix(in oklch, var(--red) 45%, var(--border)); }
  .banner.warn { background: var(--amber-bg); border-color: color-mix(in oklch, var(--amber) 45%, var(--border)); }
  .banner .head { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 10px; }
  .banner ul { margin: 10px 0 0; padding-left: 22px; }
  .banner li { margin: 3px 0; color: var(--muted); }
  .banner .problem { margin-top: 12px; }
  .banner .ptitle { font-weight: 600; }

  /* Hero status cards — full border + status tint (no side-stripe) */
  .heroes { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
  .hero { background: var(--panel); border: 1px solid var(--border-soft); border-radius: 14px; padding: 18px 20px; transition: border-color .2s; }
  .hero.ok { border-color: color-mix(in oklch, var(--green) 35%, var(--border)); background: color-mix(in oklch, var(--green) 5%, var(--panel)); }
  .hero.bad { border-color: color-mix(in oklch, var(--red) 35%, var(--border)); background: color-mix(in oklch, var(--red) 5%, var(--panel)); }
  .hero.warn { border-color: color-mix(in oklch, var(--amber) 35%, var(--border)); background: color-mix(in oklch, var(--amber) 5%, var(--panel)); }
  .hero .label { color: var(--muted); font-size: 12px; font-family: var(--mono); }
  .hero .state { display: flex; align-items: center; gap: 12px; margin: 10px 0 5px; }
  .hero .state .big { font-size: 27px; font-weight: 700; letter-spacing: -.01em; }
  .hero .state .big.ok { color: var(--green); }
  .hero .state .big.bad { color: var(--red); }
  .hero .state .big.warn { color: var(--amber); }
  .hero .bigdot { width: 13px; height: 13px; border-radius: 50%; flex: none; }
  .hero .sub { color: var(--muted); font-size: 13px; min-height: 20px; }
  .hero .sub b { color: var(--text); font-weight: 600; }

  .cards { display: grid; gap: 13px; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
  .card { background: var(--panel); border: 1px solid var(--border-soft); border-radius: 12px; padding: 13px 15px; }
  .card .clabel { color: var(--muted); font-size: 11px; font-family: var(--mono); letter-spacing: .02em; }
  .card .cvalue { font-size: 23px; font-weight: 700; margin-top: 3px; letter-spacing: -.01em; }

  /* Details panels */
  .details { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
  .panel { background: var(--panel); border: 1px solid var(--border-soft); border-radius: 12px; padding: 15px 17px; }
  .panel h3 { margin: 0 0 12px; font-size: 12px; font-family: var(--mono); letter-spacing: .02em; color: var(--accent); font-weight: 500; }
  .kv { display: grid; grid-template-columns: minmax(96px, auto) 1fr; gap: 6px 14px; font-size: 13px; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; color: var(--text); word-break: break-all; font-family: var(--mono); font-size: 12.5px; }
  .kv dd.good { color: var(--green); } .kv dd.bad2 { color: var(--red); }

  section h2 { font-size: 12px; font-family: var(--mono); letter-spacing: .02em; color: var(--muted); margin: 0 0 11px; font-weight: 500; }
  .pager { display: none; align-items: center; justify-content: flex-end; gap: 12px; margin-top: 10px; }
  .pgbtn { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 7px; color: var(--muted); font-family: var(--mono); font-size: 12px; padding: 5px 11px; cursor: pointer; transition: .15s; }
  .pgbtn:hover:not(:disabled) { color: var(--ink); border-color: var(--faint); }
  .pgbtn:disabled { opacity: .4; cursor: default; }
  .pginfo { font-family: var(--mono); font-size: 12px; color: var(--faint); }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border-soft); border-radius: 12px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border-soft); white-space: nowrap; }
  td { font-family: var(--mono); font-size: 12.5px; }
  th { color: var(--muted); font-weight: 500; font-size: 11px; font-family: var(--mono); letter-spacing: .02em; }
  tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: var(--panel2); }
  td.tool { color: var(--accent); }
  td.agentcell { display: flex; align-items: center; gap: 8px; }
  .ok { color: var(--green); } .err { color: var(--red); } .muted { color: var(--muted); }
  .empty { color: var(--faint); padding: 18px; text-align: center; font-family: var(--sans); }
  .control-input, select {
    width: 100%;
    padding: 8px 12px;
    background: var(--panel2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: var(--sans);
    margin-bottom: 10px;
    font-size: 13px;
  }
  .control-input:focus, select:focus {
    border-color: var(--accent);
    outline: none;
  }
  .btn-group {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    margin-top: 10px;
  }
  .btn {
    padding: 8px 12px;
    background: var(--border-soft);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: var(--sans);
    font-weight: 600;
    cursor: pointer;
    text-align: center;
    transition: background 0.2s, border-color 0.2s;
  }
  .btn:hover {
    background: var(--panel2);
    border-color: var(--accent);
  }
  .btn.primary {
    background: var(--accent);
    border-color: transparent;
    color: var(--bg);
  }
  .btn.primary:hover {
    background: color-mix(in oklch, var(--accent) 80%, white);
  }
  .btn.danger {
    background: var(--red-bg);
    border-color: color-mix(in oklch, var(--red) 45%, var(--border));
    color: var(--red);
  }
  .btn.danger:hover {
    background: color-mix(in oklch, var(--red) 20%, var(--panel));
  }
  /* Sync control: field labels, direction segmented, two-way switch, advanced */
  .flabel { display: block; font-size: 11px; font-family: var(--mono); color: var(--muted); margin: 12px 0 5px; }
  .wshint { font-size: 11px; color: var(--faint); margin: -5px 0 8px; min-height: 14px; }
  .wshint b { color: var(--muted); }
  .seg-group { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px; }
  .seg { padding: 8px; background: var(--panel2); border: 1px solid var(--border); border-radius: 6px; color: var(--muted); font-family: var(--sans); font-size: 12.5px; font-weight: 600; cursor: pointer; transition: .15s; }
  .seg:hover { color: var(--text); border-color: var(--faint); }
  .seg.active { background: color-mix(in oklch, var(--accent) 15%, var(--panel2)); border-color: color-mix(in oklch, var(--accent) 50%, var(--border)); color: var(--accent); }
  .switch-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 0; }
  .switch-label { font-size: 13px; font-weight: 600; }
  .switch-sub { font-size: 11px; color: var(--faint); }
  .switch { width: 40px; height: 22px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel2); position: relative; cursor: pointer; flex: none; transition: .18s; padding: 0; }
  .switch .knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--faint); transition: left .18s var(--ease), background .18s; }
  .switch[aria-checked="true"] { background: var(--accent); border-color: var(--accent); }
  .switch[aria-checked="true"] .knob { left: 20px; background: var(--bg); }
  .sync-adv summary { cursor: pointer; font-size: 12px; color: var(--muted); font-family: var(--mono); list-style: none; padding: 6px 0; }
  .sync-adv summary::-webkit-details-marker { display: none; }
  .sync-adv summary::before { content: "\\25b8  "; }
  .sync-adv[open] summary::before { content: "\\25be  "; }
  .sync-msg { font-size: 12px; margin-top: 8px; font-family: var(--mono); min-height: 18px; }
  .sync-live { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; color: var(--green); margin-bottom: 4px; }
  .sync-live-dir { font-family: var(--mono); font-size: 12px; color: var(--muted); margin: 0 0 12px; word-break: break-all; }
</style>
</head>
<body>
<header>
  <span class="mark"><span></span></span>
  <h1>Roblox MCP Pro</h1>
  <small id="hdrsub" class="muted">broker monitor</small>
  <div class="spacer"></div>
  <span class="badge muted" id="clock"></span>
  <span class="badge"><span id="streamDot" class="dot warn"></span><span id="streamText">connecting…</span></span>
</header>
<main>
  <div id="banner" class="banner warn"><div class="head">Loading…</div></div>

  <div class="heroes">
    <div id="pluginHero" class="hero">
      <div class="label">① Roblox Studio plugin</div>
      <div class="state"><span id="pluginBigDot" class="bigdot"></span><span id="pluginBig" class="big">—</span></div>
      <div id="pluginSub" class="sub"></div>
    </div>
    <div id="agentHero" class="hero">
      <div class="label">② AI agents</div>
      <div class="state"><span id="agentBigDot" class="bigdot"></span><span id="agentBig" class="big">—</span></div>
      <div id="agentSub" class="sub"></div>
    </div>
  </div>

  <div class="cards">
    <div class="card"><div class="clabel">Agents</div><div class="cvalue" id="mAgents">0</div></div>
    <div class="card"><div class="clabel">Queued</div><div class="cvalue" id="queued">0</div></div>
    <div class="card"><div class="clabel">In flight</div><div class="cvalue" id="inflight">0</div></div>
    <div class="card"><div class="clabel">Commands</div><div class="cvalue" id="totalCmds">0</div></div>
    <div class="card"><div class="clabel">Sync</div><div class="cvalue" id="syncState">off</div></div>
    <div class="card"><div class="clabel">Uptime</div><div class="cvalue" id="uptime">—</div></div>
  </div>

  <div class="details">
    <div class="panel">
      <h3>Studio session</h3>
      <dl class="kv">
        <dt>Plugin</dt><dd id="dPlugin">—</dd>
        <dt>Place</dt><dd id="dPlace">—</dd>
        <dt>Place ID</dt><dd id="dPlaceId">—</dd>
        <dt>Version</dt><dd id="dVer">—</dd>
        <dt>Mode</dt><dd id="dMode">—</dd>
        <dt>Last poll</dt><dd id="dPoll">—</dd>
      </dl>
    </div>
    <div class="panel">
      <h3>Broker</h3>
      <dl class="kv">
        <dt>Status</dt><dd class="good">running</dd>
        <dt>Port</dt><dd id="dPort">—</dd>
        <dt>Uptime</dt><dd id="dUptime">—</dd>
        <dt>Started</dt><dd id="dStarted">—</dd>
        <dt>Commands</dt><dd id="dCmds">0</dd>
        <dt>Queue</dt><dd id="dQueue">0 queued · 0 in flight</dd>
      </dl>
    </div>
    <div class="panel">
      <h3>Sync (Studio ↔ disk)</h3>
      <dl class="kv">
        <dt>State</dt><dd id="dSyncState">off</dd>
        <dt>Direction</dt><dd id="dSyncMode">—</dd>
        <dt>Roots</dt><dd id="dRoots">—</dd>
        <dt>Scripts</dt><dd id="dScripts">0</dd>
        <dt>Place ID</dt><dd id="dSyncPlace">—</dd>
        <dt>Folder</dt><dd id="dDir">—</dd>
      </dl>
    </div>
    <div class="panel">
      <h3>Sync Control</h3>

      <!-- Running view (compact) -->
      <div id="syncRunning" style="display:none;">
        <div class="sync-live"><span class="dot on"></span><span id="syncLiveText">Syncing</span></div>
        <div class="sync-live-dir" id="syncLiveDir">—</div>
        <div class="btn-group" style="grid-template-columns:1fr;">
          <button class="btn danger" onclick="doSyncAction('stop')">Stop sync</button>
        </div>
        <div class="btn-group">
          <button class="btn" onclick="doSyncAction('pull')">&#8595; Pull once</button>
          <button class="btn" onclick="doSyncAction('push')">&#8593; Push once</button>
        </div>
      </div>

      <!-- Setup view -->
      <div id="syncSetup">
        <label class="flabel">Project folder</label>
        <input type="text" id="inputSyncDir" placeholder="auto-detected from your AI client" class="control-input" />
        <div class="wshint" id="wsHint"></div>

        <label class="flabel">Direction</label>
        <div class="seg-group" id="segDir" role="group" aria-label="Sync direction">
          <button type="button" class="seg active" data-dir="studio-to-disk">Studio &#8594; Disk</button>
          <button type="button" class="seg" data-dir="disk-to-studio">Disk &#8594; Studio</button>
        </div>

        <div class="switch-row">
          <div>
            <div class="switch-label">Two-way sync</div>
            <div class="switch-sub">Keep Studio and files in step, live</div>
          </div>
          <button type="button" id="twoWayToggle" class="switch" role="switch" aria-checked="false" aria-label="Two-way sync"><span class="knob"></span></button>
        </div>

        <div class="btn-group" style="grid-template-columns:1fr;">
          <button class="btn primary" onclick="doSyncAction('start')">Start sync</button>
        </div>
        <div class="btn-group">
          <button class="btn" onclick="doSyncAction('pull')">&#8595; Pull once</button>
          <button class="btn" onclick="doSyncAction('push')">&#8593; Push once</button>
        </div>

        <details class="sync-adv">
          <summary>Advanced</summary>
          <label class="flabel">Roots (comma separated, optional)</label>
          <input type="text" id="inputRoots" placeholder="e.g. ServerScriptService, StarterGui" class="control-input" />
        </details>
      </div>

      <div id="syncControlMsg" class="sync-msg"></div>
    </div>
  </div>

  <section>
    <h2>Connected agents</h2>
    <table>
      <thead><tr><th>Agent</th><th>Version</th><th>PID</th><th>Client ID</th><th>Commands</th><th>Connected</th><th>Last seen</th></tr></thead>
      <tbody id="agents"><tr><td class="empty" colspan="7">No agents connected.</td></tr></tbody>
    </table>
    <div class="pager" id="agentsPager"></div>
  </section>

  <section>
    <h2>Activity</h2>
    <table>
      <thead><tr><th>Time</th><th>Agent</th><th>Tool</th><th>Result</th><th>ms</th></tr></thead>
      <tbody id="activity"><tr><td class="empty" colspan="5">No activity yet.</td></tr></tbody>
    </table>
    <div class="pager" id="activityPager"></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString();
const ago = (ts) => {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60); if (m < 60) return m + "m ago";
  return Math.floor(m / 60) + "h ago";
};
const dur = (ms) => {
  let s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return (h ? h + "h " : "") + (h || m ? m + "m " : "") + s + "s";
};
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const set = (id, v) => { $(id).textContent = v; };

// Client-side pagination for the agents/activity tables (5 rows per page).
const PAGE_SIZE = 5;
let agentsPage = 0, activityPage = 0;
function renderPaged(id, items, rowFn, page, colspan, emptyText) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > pages - 1) page = pages - 1;
  if (page < 0) page = 0;
  const start = page * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);
  $(id).innerHTML = slice.length
    ? slice.map(rowFn).join("")
    : "<tr><td class=empty colspan=" + colspan + ">" + emptyText + "</td></tr>";
  const pager = $(id + "Pager");
  if (total > PAGE_SIZE) {
    pager.style.display = "flex";
    pager.innerHTML =
      "<button class='pgbtn' data-pg='" + id + "' data-d='-1'" + (page === 0 ? " disabled" : "") + ">&#8249; Prev</button>" +
      "<span class='pginfo'>" + (page + 1) + " / " + pages + "  &#183;  " + total + " total</span>" +
      "<button class='pgbtn' data-pg='" + id + "' data-d='1'" + (page >= pages - 1 ? " disabled" : "") + ">Next &#8250;</button>";
  } else {
    pager.style.display = "none";
    pager.innerHTML = "";
  }
  return page;
}

// The Studio plugin long-polls every ~25s, so an age up to ~25s is healthy.
// Past ~28s with no poll, it's likely dropping; past the broker's liveness
// window pluginConnected itself flips false.
function pluginState(p) {
  const age = p && p.lastPollAt ? Date.now() - p.lastPollAt : null;
  if (!p || !p.pluginConnected) {
    return { level: "bad", label: "DISCONNECTED", never: !(p && p.lastPollAt), age };
  }
  if (age != null && age > 28000) return { level: "warn", label: "RECONNECTING…", age };
  return { level: "ok", label: "CONNECTED", age };
}

function setHero(prefix, level, big, sub) {
  $(prefix + "Hero").className = "hero " + level;
  const color = level === "ok" ? "var(--green)" : level === "warn" ? "var(--amber)" : "var(--red)";
  $(prefix + "BigDot").style.background = color;
  $(prefix + "BigDot").style.boxShadow = "0 0 8px " + color;
  $(prefix + "Big").className = "big " + level;
  $(prefix + "Big").textContent = big;
  $(prefix + "Sub").innerHTML = sub;
}

const PLUGIN_FIX = [
  "Open <b>Roblox Studio</b>.",
  "Click the <b>MCP</b> button on the toolbar so it's highlighted (or open the panel and Connect).",
  "Make sure <b>Game Settings → Security → Allow HTTP Requests</b> is ON.",
  "After restarting the server, allow ~5s for the plugin to auto-reconnect.",
];
const AGENT_FIX = [
  "Start or restart your AI client (Claude Code, Codex, Antigravity, …).",
  "It connects to this broker automatically on port 3690 — no extra setup.",
  "If it can't reach the broker, check nothing else is using port 3690.",
];

function renderBanner(problems) {
  const b = $("banner");
  if (problems.length === 0) {
    b.className = "banner ok";
    b.innerHTML = '<div class="head"><span class="dot on"></span>All systems connected — ready to drive Studio.</div>';
    return;
  }
  const worst = problems.some((p) => p.sev === "bad") ? "bad" : "warn";
  b.className = "banner " + worst;
  const head = '<div class="head"><span class="dot ' + (worst === "bad" ? "off" : "warn") +
    '"></span>' + (problems.length === 1 ? "1 issue needs attention" : problems.length + " issues need attention") + "</div>";
  const body = problems.map((p) =>
    '<div class="problem"><div class="ptitle">' + (p.sev === "bad" ? "✗ " : "⚠ ") + esc(p.title) + "</div>" +
    (p.detail ? '<div class="muted">' + p.detail + "</div>" : "") +
    "<ul>" + p.steps.map((s) => "<li>" + s + "</li>").join("") + "</ul></div>"
  ).join("");
  b.innerHTML = head + body;
}

function render(state) {
  const plugin = state.plugin || {};
  const studio = state.studio || null;
  const sync = state.sync || {};
  const agents = state.agents || [];
  const problems = [];

  // ① plugin hero + Studio details
  const ps = pluginState(plugin);
  const studioBits = studio
    ? "<b>" + esc(studio.placeName || "?") + "</b> · v" + esc(studio.studioVersion || "?") +
      " · " + (studio.isRunning ? "Play mode" : "Edit mode")
    : "";
  if (ps.level === "ok") {
    setHero("plugin", "ok", "CONNECTED", (studioBits ? studioBits + " · " : "") + "responding " + ago(plugin.lastPollAt));
  } else if (ps.level === "warn") {
    setHero("plugin", "warn", "RECONNECTING…", "No response for <b>" + ago(plugin.lastPollAt) + "</b> — Studio may be busy.");
    problems.push({ sev: "warn", title: "Studio plugin is slow to respond", detail: "Last response " + ago(plugin.lastPollAt) + ". If this persists, reconnect:", steps: PLUGIN_FIX });
  } else {
    setHero("plugin", "bad", "DISCONNECTED", ps.never ? "Has <b>never</b> connected since the broker started." : "Last response <b>" + ago(plugin.lastPollAt) + "</b>.");
    problems.push({ sev: "bad", title: ps.never ? "Studio plugin has never connected" : "Studio plugin disconnected", detail: ps.never ? "The broker is up but no plugin has attached." : "Studio may have closed or lost the connection.", steps: PLUGIN_FIX });
  }

  $("dPlugin").textContent = ps.label;
  $("dPlugin").className = ps.level === "ok" ? "good" : "bad2";
  set("dPlace", studio && studio.placeName ? studio.placeName : "—");
  set("dPlaceId", studio && studio.placeId != null ? String(studio.placeId) : "—");
  set("dVer", studio && studio.studioVersion ? studio.studioVersion : "—");
  set("dMode", studio ? (studio.isRunning ? "Play (running)" : "Edit") : "—");
  set("dPoll", plugin.lastPollAt ? ago(plugin.lastPollAt) : "never");

  // ② agents hero
  if (agents.length > 0) {
    const names = agents.map((a) => "<b>" + esc(a.name) + "</b>").join(", ");
    setHero("agent", "ok", agents.length + " CONNECTED", names);
  } else {
    setHero("agent", "bad", "NONE CONNECTED", "No AI agent is attached to the broker.");
    problems.push({ sev: "bad", title: "No AI agent connected", detail: "Nothing is driving Studio right now.", steps: AGENT_FIX });
  }

  renderBanner(problems);

  // metric cards
  set("mAgents", agents.length);
  set("queued", plugin.queued ?? 0);
  set("inflight", plugin.inflight ?? 0);
  set("totalCmds", state.totalCommands ?? 0);
  set("syncState", sync.running ? (sync.scriptCount + " scripts") : "off");
  set("uptime", state.brokerStartedAt ? dur(Date.now() - state.brokerStartedAt) : "—");

  // broker details
  set("dPort", state.port ?? "—");
  set("dUptime", state.brokerStartedAt ? dur(Date.now() - state.brokerStartedAt) : "—");
  set("dStarted", state.brokerStartedAt ? new Date(state.brokerStartedAt).toLocaleString() : "—");
  set("dCmds", state.totalCommands ?? 0);
  set("dQueue", (plugin.queued ?? 0) + " queued · " + (plugin.inflight ?? 0) + " in flight");

  // sync details
  const MODE_LABEL = { "two-way": "Two-way (disk ↔ Studio)", "studio-to-disk": "Studio → disk", "disk-to-studio": "disk → Studio" };
  $("dSyncState").textContent = sync.running ? "running" : "off";
  $("dSyncState").className = sync.running ? "good" : "";
  set("dSyncMode", sync.running ? (MODE_LABEL[sync.mode] || sync.mode || "—") : "—");
  set("dRoots", sync.roots && sync.roots.length ? sync.roots.join(", ") : "—");
  set("dScripts", sync.scriptCount ?? 0);
  set("dSyncPlace", sync.placeId != null ? String(sync.placeId) : "—");
  set("dDir", sync.syncDir || "—");

  // agents table (paginated, 5 per page)
  const agentRow = (a) =>
    "<tr><td class=agentcell><span class='dot on'></span>" + esc(a.name) + "</td><td class=muted>" + esc(a.version || "—") +
    "</td><td class=muted>" + (a.pid ?? "—") + "</td><td class=muted>" + esc((a.clientId || "").slice(0, 8)) +
    "</td><td>" + a.commandCount + "</td><td class=muted>" + ago(a.connectedAt) + "</td><td class=muted>" + ago(a.lastSeenAt) + "</td></tr>";
  agentsPage = renderPaged("agents", agents, agentRow, agentsPage, 7, "No agents connected.");

  // activity table (paginated, 5 per page)
  const recent = state.recent || [];
  const activityRow = (c) =>
    "<tr><td class=muted>" + fmtTime(c.ts) + "</td><td>" + esc(c.agent) +
    "</td><td class=tool>" + esc(c.tool) + "</td><td class=" + (c.ok ? "ok>ok" : "err>" + esc(c.error || "error")) +
    "</td><td class=muted>" + c.durationMs + "</td></tr>";
  activityPage = renderPaged("activity", recent, activityRow, activityPage, 5, "No activity yet.");

  $("hdrsub").textContent = "broker monitor · :" + (state.port ?? "3690");
  $("clock").textContent = "updated " + new Date().toLocaleTimeString();

  // Autofill the project folder from running sync or the active agent's workspace.
  if (!$('inputSyncDir').value) {
    if (sync.syncDir) {
      $('inputSyncDir').value = sync.syncDir;
    } else if (agents.length > 0) {
      const activeAgent = [...agents].sort((a, b) => b.lastSeenAt - a.lastSeenAt).find((a) => a.cwd);
      if (activeAgent && activeAgent.cwd) {
        $('inputSyncDir').value = activeAgent.cwd;
        $('wsHint').innerHTML = 'Detected from <b>' + esc(activeAgent.name) + '</b>';
      }
    }
  }

  // State-aware: compact "running" view vs the setup form.
  const DIR_LABEL = { "two-way": "Two-way", "studio-to-disk": "Studio \\u2192 Disk", "disk-to-studio": "Disk \\u2192 Studio" };
  $('syncSetup').style.display = sync.running ? 'none' : 'block';
  $('syncRunning').style.display = sync.running ? 'block' : 'none';
  if (sync.running) {
    set('syncLiveText', 'Syncing ' + (sync.scriptCount || 0) + ' scripts');
    const label = DIR_LABEL[sync.mode] || sync.mode || '';
    $('syncLiveDir').textContent = label + (sync.syncDir ? '  \\u00b7  ' + sync.syncDir : '');
  }
}

async function doSyncAction(action) {
  const elMsg = $('syncControlMsg');
  const showMsg = (msg, isErr = false) => {
    elMsg.textContent = msg;
    elMsg.style.color = isErr ? 'var(--red)' : 'var(--green)';
  };
  showMsg('Working...');

  const payload = { action };
  if (action === 'start') {
    const syncDir = $('inputSyncDir').value.trim();
    if (!syncDir) {
      showMsg('Pick a project folder first.', true);
      return;
    }
    const activeSeg = document.querySelector('#segDir .seg.active');
    const dir = activeSeg ? activeSeg.dataset.dir : 'studio-to-disk';
    const twoWay = $('twoWayToggle').getAttribute('aria-checked') === 'true';
    payload.syncDir = syncDir;
    // Two-way ON -> bidirectional live sync; OFF -> one-way in the chosen direction.
    payload.mode = twoWay ? 'two-way' : dir;
    payload.initialDirection = dir;
    const rootsText = $('inputRoots').value.trim();
    if (rootsText) {
      payload.roots = rootsText.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  
  try {
    const res = await fetch('/plugin/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.ok) {
      showMsg(action === 'start' ? 'Sync started.' : 'Done: ' + action + '.');
    } else {
      showMsg('Error: ' + data.error, true);
    }
  } catch (err) {
    showMsg('Failed to connect to broker: ' + err, true);
  }
}

function setStream(ok) {
  $("streamDot").className = "dot " + (ok ? "on" : "off");
  $("streamText").textContent = ok ? "live" : "disconnected — retrying";
}

let last = null;
function apply(s) { last = s; render(s); }

let es;
function connect() {
  es = new EventSource("/api/stream");
  es.onopen = () => setStream(true);
  es.onmessage = (e) => { try { apply(JSON.parse(e.data)); } catch {} };
  es.onerror = () => { setStream(false); es.close(); setTimeout(connect, 2000); };
}
// Sync Control: direction segmented + two-way toggle (vanilla, no framework).
document.querySelectorAll('#segDir .seg').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#segDir .seg').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
  });
});
const twToggle = $('twoWayToggle');
if (twToggle) {
  twToggle.addEventListener('click', () => {
    twToggle.setAttribute('aria-checked', twToggle.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
  });
}

// Table pagination: prev/next buttons (delegated, no inline handlers).
document.addEventListener('click', (e) => {
  const b = e.target.closest('.pgbtn');
  if (!b || b.disabled) return;
  const d = parseInt(b.getAttribute('data-d'), 10) || 0;
  if (b.getAttribute('data-pg') === 'agents') agentsPage += d;
  else activityPage += d;
  if (last) render(last);
});

connect();
// keep relative timestamps fresh between server pushes
setInterval(() => { if (last) render(last); }, 2000);
</script>
</body>
</html>`;
