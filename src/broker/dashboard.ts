/**
 * The monitoring dashboard — a single self-contained HTML page (no build step,
 * no external assets) served by the broker at `/`. It opens an SSE stream to
 * `/api/stream` and re-renders on every update, falling back to polling
 * `/api/state` if the stream drops.
 */

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>roblox-mcp-pro · monitor</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d; --text: #e6edf3;
    --muted: #8b949e; --green: #3fb950; --red: #f85149; --amber: #d29922;
    --accent: #58a6ff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  header {
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    padding: 16px 24px; border-bottom: 1px solid var(--border); background: var(--panel);
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header h1 small { color: var(--muted); font-weight: 400; margin-left: 8px; }
  .badge {
    display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px;
    border-radius: 999px; border: 1px solid var(--border); font-size: 12px;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .dot.on { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .dot.off { background: var(--red); }
  .dot.warn { background: var(--amber); }
  .spacer { flex: 1; }
  main { padding: 24px; display: grid; gap: 24px; grid-template-columns: 1fr; max-width: 1100px; margin: 0 auto; }
  .cards { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .card .value { font-size: 26px; font-weight: 600; margin-top: 4px; }
  section h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; }
  tr:last-child td { border-bottom: none; }
  td.tool { color: var(--accent); }
  .ok { color: var(--green); } .err { color: var(--red); }
  .muted { color: var(--muted); }
  .empty { color: var(--muted); padding: 16px; text-align: center; }
  .err-msg { color: var(--red); font-size: 12px; max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
  .pill { font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px; }
</style>
</head>
<body>
<header>
  <h1>roblox-mcp-pro <small>broker monitor</small></h1>
  <span class="badge"><span id="brokerDot" class="dot on"></span><span id="brokerText">broker</span></span>
  <span class="badge"><span id="pluginDot" class="dot"></span><span id="pluginText">Studio plugin</span></span>
  <div class="spacer"></div>
  <span class="badge"><span id="streamDot" class="dot warn"></span><span id="streamText">connecting…</span></span>
</header>
<main>
  <div class="cards">
    <div class="card"><div class="label">Agents</div><div class="value" id="agentCount">0</div></div>
    <div class="card"><div class="label">Queued</div><div class="value" id="queued">0</div></div>
    <div class="card"><div class="label">In flight</div><div class="value" id="inflight">0</div></div>
    <div class="card"><div class="label">Commands</div><div class="value" id="totalCmds">0</div></div>
    <div class="card"><div class="label">Sync</div><div class="value" id="syncState">off</div></div>
  </div>

  <section>
    <h2>Connected agents</h2>
    <table>
      <thead><tr><th>Agent</th><th>Version</th><th>PID</th><th>Commands</th><th>Connected</th><th>Last seen</th></tr></thead>
      <tbody id="agents"><tr><td class="empty" colspan="6">No agents connected.</td></tr></tbody>
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
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.round(s / 60); return m + "m ago";
};
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function render(state) {
  const plugin = state.plugin || {};
  $("pluginDot").className = "dot " + (plugin.pluginConnected ? "on" : "off");
  $("pluginText").textContent = "Studio plugin: " + (plugin.pluginConnected ? "connected" : "offline");
  $("agentCount").textContent = (state.agents || []).length;
  $("queued").textContent = plugin.queued ?? 0;
  $("inflight").textContent = plugin.inflight ?? 0;
  $("totalCmds").textContent = state.totalCommands ?? 0;
  const sync = state.sync || {};
  $("syncState").textContent = sync.running ? (sync.scriptCount + " scripts") : "off";

  const agents = state.agents || [];
  $("agents").innerHTML = agents.length ? agents.map((a) =>
    "<tr><td>" + esc(a.name) + "</td><td class=muted>" + esc(a.version || "—") +
    "</td><td class=muted>" + (a.pid ?? "—") + "</td><td>" + a.commandCount +
    "</td><td class=muted>" + ago(a.connectedAt) + "</td><td class=muted>" + ago(a.lastSeenAt) + "</td></tr>"
  ).join("") : "<tr><td class=empty colspan=6>No agents connected.</td></tr>";

  const recent = state.recent || [];
  $("activity").innerHTML = recent.length ? recent.map((c) =>
    "<tr><td class=muted>" + fmtTime(c.ts) + "</td><td>" + esc(c.agent) +
    "</td><td class=tool>" + esc(c.tool) + "</td><td class=" + (c.ok ? "ok>ok" : "err>" + esc(c.error || "error")) +
    "</td><td class=muted>" + c.durationMs + "</td></tr>"
  ).join("") : "<tr><td class=empty colspan=5>No activity yet.</td></tr>";
}

function setStream(ok) {
  $("streamDot").className = "dot " + (ok ? "on" : "off");
  $("streamText").textContent = ok ? "live" : "disconnected";
}

let es;
function connect() {
  es = new EventSource("/api/stream");
  es.onopen = () => setStream(true);
  es.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch {} };
  es.onerror = () => { setStream(false); es.close(); setTimeout(connect, 2000); };
}
connect();
// refresh relative timestamps even without new events
setInterval(() => { if (window.__last) render(window.__last); }, 5000);
const _render = render;
render = (s) => { window.__last = s; _render(s); };
</script>
</body>
</html>`;
