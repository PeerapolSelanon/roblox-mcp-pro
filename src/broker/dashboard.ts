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
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --panel2: #1c2330; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --green: #3fb950; --red: #f85149;
    --amber: #d29922; --accent: #58a6ff;
    --green-bg: rgba(63,185,80,.12); --red-bg: rgba(248,81,73,.12); --amber-bg: rgba(210,153,34,.12);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  header {
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    padding: 14px 24px; border-bottom: 1px solid var(--border); background: var(--panel);
  }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .02em; }
  header small { font-size: 12px; }
  header .spacer { flex: 1; }
  .badge { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px;
    border-radius: 999px; border: 1px solid var(--border); font-size: 12px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
  .dot.on { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .dot.off { background: var(--red); box-shadow: 0 0 6px var(--red); }
  .dot.warn { background: var(--amber); box-shadow: 0 0 6px var(--amber); }
  .spacer { flex: 1; }
  main { padding: 24px; display: grid; gap: 22px; max-width: 1100px; margin: 0 auto; }

  /* Diagnostics banner */
  .banner { border: 1px solid var(--border); border-radius: 10px; padding: 14px 18px; }
  .banner.ok { background: var(--green-bg); border-color: var(--green); }
  .banner.bad { background: var(--red-bg); border-color: var(--red); }
  .banner.warn { background: var(--amber-bg); border-color: var(--amber); }
  .banner .head { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 10px; }
  .banner ul { margin: 10px 0 0; padding-left: 22px; }
  .banner li { margin: 3px 0; }
  .banner .problem { margin-top: 12px; }
  .banner .ptitle { font-weight: 600; }

  /* Hero status cards */
  .heroes { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
  .hero { background: var(--panel); border: 1px solid var(--border); border-left-width: 5px;
    border-radius: 12px; padding: 18px 20px; }
  .hero.ok { border-left-color: var(--green); }
  .hero.bad { border-left-color: var(--red); }
  .hero.warn { border-left-color: var(--amber); }
  .hero .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
  .hero .state { display: flex; align-items: center; gap: 12px; margin: 8px 0 4px; }
  .hero .state .big { font-size: 26px; font-weight: 700; letter-spacing: .01em; }
  .hero .state .big.ok { color: var(--green); }
  .hero .state .big.bad { color: var(--red); }
  .hero .state .big.warn { color: var(--amber); }
  .hero .bigdot { width: 14px; height: 14px; border-radius: 50%; flex: none; }
  .hero .sub { color: var(--muted); font-size: 13px; min-height: 20px; }
  .hero .sub b { color: var(--text); font-weight: 600; }

  .cards { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .card .clabel { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .card .cvalue { font-size: 22px; font-weight: 600; margin-top: 2px; }

  /* Details panels */
  .details { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .panel h3 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .kv { display: grid; grid-template-columns: minmax(96px, auto) 1fr; gap: 4px 14px; font-size: 13px; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; color: var(--text); word-break: break-all; }
  .kv dd.good { color: var(--green); } .kv dd.bad2 { color: var(--red); }

  section h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; }
  tr:last-child td { border-bottom: none; }
  td.tool { color: var(--accent); }
  td.agentcell { display: flex; align-items: center; gap: 8px; }
  .ok { color: var(--green); } .err { color: var(--red); } .muted { color: var(--muted); }
  .empty { color: var(--muted); padding: 16px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>roblox-mcp-pro</h1>
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
  </div>

  <section>
    <h2>Connected agents</h2>
    <table>
      <thead><tr><th>Agent</th><th>Version</th><th>PID</th><th>Client ID</th><th>Commands</th><th>Connected</th><th>Last seen</th></tr></thead>
      <tbody id="agents"><tr><td class="empty" colspan="7">No agents connected.</td></tr></tbody>
    </table>
  </section>

  <section>
    <h2>Activity</h2>
    <table>
      <thead><tr><th>Time</th><th>Agent</th><th>Tool</th><th>Result</th><th>ms</th></tr></thead>
      <tbody id="activity"><tr><td class="empty" colspan="5">No activity yet.</td></tr></tbody>
    </table>
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

  // agents table
  $("agents").innerHTML = agents.length ? agents.map((a) =>
    "<tr><td class=agentcell><span class='dot on'></span>" + esc(a.name) + "</td><td class=muted>" + esc(a.version || "—") +
    "</td><td class=muted>" + (a.pid ?? "—") + "</td><td class=muted>" + esc((a.clientId || "").slice(0, 8)) +
    "</td><td>" + a.commandCount + "</td><td class=muted>" + ago(a.connectedAt) + "</td><td class=muted>" + ago(a.lastSeenAt) + "</td></tr>"
  ).join("") : "<tr><td class=empty colspan=7>No agents connected.</td></tr>";

  // activity table
  const recent = state.recent || [];
  $("activity").innerHTML = recent.length ? recent.map((c) =>
    "<tr><td class=muted>" + fmtTime(c.ts) + "</td><td>" + esc(c.agent) +
    "</td><td class=tool>" + esc(c.tool) + "</td><td class=" + (c.ok ? "ok>ok" : "err>" + esc(c.error || "error")) +
    "</td><td class=muted>" + c.durationMs + "</td></tr>"
  ).join("") : "<tr><td class=empty colspan=5>No activity yet.</td></tr>";

  $("hdrsub").textContent = "broker monitor · :" + (state.port ?? "3690");
  $("clock").textContent = "updated " + new Date().toLocaleTimeString();
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
connect();
// keep relative timestamps fresh between server pushes
setInterval(() => { if (last) render(last); }, 2000);
</script>
</body>
</html>`;
