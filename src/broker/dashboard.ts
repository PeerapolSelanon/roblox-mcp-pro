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
 *
 * Project-folder fields auto-detect from (in order) the running sync, the most
 * recently active agent's cwd, and the recent-projects list — and offer a real
 * "Browse…" picker backed by /api/fs/browse on the localhost-only broker.
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
    --text: oklch(0.96 0.008 70); --muted: oklch(0.745 0.014 55); --faint: oklch(0.65 0.012 55);
    --accent: oklch(0.70 0.19 45);
    --green: oklch(0.80 0.15 155); --red: oklch(0.66 0.20 25); --amber: oklch(0.80 0.15 80);
    --green-bg: color-mix(in oklch, var(--green) 12%, transparent);
    --red-bg: color-mix(in oklch, var(--red) 12%, transparent);
    --amber-bg: color-mix(in oklch, var(--amber) 12%, transparent);
    --accent-bg: color-mix(in oklch, var(--accent) 12%, transparent);
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
    padding: 14px 24px 0; border-bottom: 1px solid var(--border-soft);
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
  button.badge { background: none; cursor: pointer; }
  button.badge:hover { border-color: var(--faint); color: var(--text); }
  main { padding: 24px; display: grid; gap: 22px; max-width: 1100px; margin: 0 auto; }

  /* Scrollbars: thin and tinted to the dark surfaces so they don't read as
     bright OS chrome on the panels. Native behaviour kept — not a drawn scrollbar. */
  * { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); background-clip: padding-box;
    border: 2px solid transparent; border-radius: 8px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--faint); }
  ::-webkit-scrollbar-corner { background: transparent; }

  /* Respect reduced-motion: collapse the short state transitions to instant. */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      transition-duration: .001ms !important; animation-duration: .001ms !important;
      animation-iteration-count: 1 !important; scroll-behavior: auto !important;
    }
  }

  /* Tab navigation (second header row, stays visible with the sticky header) */
  .tabs { display: flex; gap: 2px; width: 100%; overflow-x: auto; margin-top: 6px; }
  .tab { position: relative; background: none; border: none; border-bottom: 2px solid transparent;
    color: var(--muted); font: 600 13px var(--sans); padding: 9px 14px 11px; cursor: pointer; white-space: nowrap; transition: color .15s; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tabdot { position: absolute; top: 5px; right: 3px; width: 7px; height: 7px; border-radius: 50%; display: none; }
  .tabdot.bad { display: block; background: var(--red); box-shadow: 0 0 6px var(--red); }
  .tabdot.warn { display: block; background: var(--amber); box-shadow: 0 0 6px var(--amber); }
  .tabpane { display: none; }
  .tabpane.active { display: grid; gap: 22px; }

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

  /* Hero status cards */
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

  /* Panels */
  .details { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
  .panel { background: var(--panel); border: 1px solid var(--border-soft); border-radius: 12px; padding: 16px 18px; }
  .phead { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 14px; }
  .phead h3 { margin: 0; font-size: 12px; font-family: var(--mono); letter-spacing: .02em; color: var(--accent); font-weight: 500; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px;
    border: 1px solid var(--border); font-family: var(--mono); font-size: 11px; color: var(--muted); white-space: nowrap; }
  .pill .dot { width: 6px; height: 6px; }
  .pill.on { color: var(--green); border-color: color-mix(in oklch, var(--green) 45%, var(--border)); background: var(--green-bg); }
  .pill.warn2 { color: var(--amber); border-color: color-mix(in oklch, var(--amber) 45%, var(--border)); background: var(--amber-bg); }
  .pill.off2 { color: var(--red); border-color: color-mix(in oklch, var(--red) 45%, var(--border)); background: var(--red-bg); }
  .kv { display: grid; grid-template-columns: minmax(96px, auto) 1fr; gap: 7px 14px; font-size: 13px; margin: 0; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; color: var(--text); word-break: break-all; font-family: var(--mono); font-size: 12.5px; }
  .kv dd.good { color: var(--green); } .kv dd.bad2 { color: var(--red); }

  section h2 { font-size: 12px; font-family: var(--mono); letter-spacing: .02em; color: var(--muted); margin: 0 0 11px; font-weight: 500; }
  .pager { display: none; align-items: center; justify-content: flex-end; gap: 12px; margin-top: 10px; }
  .pgbtn { background: var(--panel); border: 1px solid var(--border-soft); border-radius: 7px; color: var(--muted); font-family: var(--mono); font-size: 12px; padding: 5px 11px; cursor: pointer; transition: .15s; }
  .pgbtn:hover:not(:disabled) { color: var(--text); border-color: var(--faint); }
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
  .rolesel { font-family: var(--mono); font-size: 11.5px; padding: 3px 6px; border-radius: 7px;
    background: var(--panel2); color: var(--text); border: 1px solid var(--border); cursor: pointer; }
  .rolesel:hover { border-color: var(--faint); }
  .rolesel.lead { border-color: color-mix(in oklch, var(--accent) 60%, var(--border)); color: var(--accent); }
  .rolesel.worker { border-color: color-mix(in oklch, var(--green) 55%, var(--border)); color: var(--green); }
  .ok { color: var(--green); } .err { color: var(--red); } .muted { color: var(--muted); }
  .empty { color: var(--faint); padding: 18px; text-align: center; font-family: var(--sans); }

  /* Form controls */
  .control-input, select {
    width: 100%;
    padding: 9px 12px;
    background: var(--panel2);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-family: var(--mono);
    font-size: 12.5px;
  }
  .control-input:focus, select:focus { border-color: var(--accent); outline: none; }
  .btn {
    padding: 9px 12px;
    background: var(--border-soft);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-family: var(--sans);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    text-align: center;
    transition: background .2s, border-color .2s;
    white-space: nowrap;
  }
  .btn:hover { background: var(--panel2); border-color: var(--accent); }
  .btn.primary { background: var(--accent); border-color: transparent; color: var(--bg); }
  .btn.primary:hover { background: color-mix(in oklch, var(--accent) 80%, white); }
  .btn.danger { background: var(--red-bg); border-color: color-mix(in oklch, var(--red) 45%, var(--border)); color: var(--red); }
  .btn.danger:hover { background: color-mix(in oklch, var(--red) 20%, var(--panel)); }
  .btn-group { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 10px; }
  .flabel { display: block; font-size: 11px; font-family: var(--mono); color: var(--muted); margin: 12px 0 5px; }
  .flabel:first-child { margin-top: 0; }
  .folder-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
  .wshint { font-size: 11px; color: var(--faint); margin: 5px 0 0; min-height: 14px; }
  .wshint b { color: var(--muted); }
  .seg-group { display: grid; gap: 6px; }
  .seg-group.cols3 { grid-template-columns: repeat(3, 1fr); }
  .seg-group.cols2 { grid-template-columns: repeat(2, 1fr); }
  .seg { padding: 8px 6px; background: var(--panel2); border: 1px solid var(--border); border-radius: 8px; color: var(--muted); font-family: var(--sans); font-size: 12.5px; font-weight: 600; cursor: pointer; transition: .15s; }
  .seg:hover { color: var(--text); border-color: var(--faint); }
  .seg.active { background: var(--accent-bg); border-color: color-mix(in oklch, var(--accent) 50%, var(--border)); color: var(--accent); }
  .seg .segsub { display: block; font-weight: 400; font-size: 10.5px; color: var(--faint); margin-top: 1px; }
  .sync-adv summary { cursor: pointer; font-size: 12px; color: var(--muted); font-family: var(--mono); list-style: none; padding: 6px 0; }
  .sync-adv summary::-webkit-details-marker { display: none; }
  .sync-adv summary::before { content: "\\25b8  "; }
  .sync-adv[open] summary::before { content: "\\25be  "; }
  .sync-msg { font-size: 12px; margin-top: 8px; font-family: var(--mono); min-height: 18px; }
  .panel-note { font-size: 12px; color: var(--muted); margin: 0 0 12px; line-height: 1.5; }
  .panel-note b { color: var(--text); }

  /* Sync: running facts strip */
  .syncfacts { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-bottom: 12px; }
  .syncfact { background: var(--panel2); border: 1px solid var(--border-soft); border-radius: 9px; padding: 9px 12px; }
  .syncfact .fl { font-size: 10.5px; font-family: var(--mono); color: var(--faint); letter-spacing: .02em; }
  .syncfact .fv { font-size: 13px; font-weight: 600; margin-top: 2px; word-break: break-all; }
  .syncfact .fv.mono { font-family: var(--mono); font-weight: 400; font-size: 12px; color: var(--muted); }

  /* Folder picker modal */
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.55); backdrop-filter: blur(3px);
    display: none; align-items: center; justify-content: center; z-index: 50; padding: 24px; }
  .modal-overlay.open { display: flex; }
  .modal { background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
    width: min(640px, 100%); max-height: min(640px, 90vh); display: flex; flex-direction: column; overflow: hidden;
    box-shadow: 0 24px 64px rgba(0,0,0,.5); }
  .modal .mhead { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border-soft); }
  .modal .mhead h4 { margin: 0; font-size: 14px; font-weight: 700; flex: 1; }
  .modal .mclose { background: none; border: none; color: var(--muted); font-size: 18px; cursor: pointer; padding: 2px 8px; border-radius: 6px; }
  .modal .mclose:hover { color: var(--text); background: var(--panel2); }
  .modal .mpath { display: flex; align-items: center; gap: 8px; padding: 10px 18px; border-bottom: 1px solid var(--border-soft); background: var(--panel2); }
  .modal .mpath .cur { flex: 1; font-family: var(--mono); font-size: 12px; color: var(--muted); word-break: break-all; }
  .modal .mlist { flex: 1; overflow-y: auto; padding: 8px; min-height: 180px; }
  .mitem { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 9px 12px;
    background: none; border: none; border-radius: 8px; color: var(--text); font: 13px var(--sans); cursor: pointer; }
  .mitem:hover { background: var(--panel2); }
  .mitem .ico { flex: none; width: 18px; text-align: center; color: var(--accent); }
  .mitem .nm { flex: 1; word-break: break-all; }
  .mitem .tag { font-family: var(--mono); font-size: 10.5px; color: var(--faint); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; white-space: nowrap; }
  .mitem .tag.proj { color: var(--green); border-color: color-mix(in oklch, var(--green) 45%, var(--border)); background: var(--green-bg); }
  .msection { font-size: 10.5px; font-family: var(--mono); color: var(--faint); letter-spacing: .04em; padding: 10px 12px 4px; text-transform: uppercase; }
  .modal .mfoot { display: flex; align-items: center; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--border-soft); }
  .modal .mfoot .newf { display: none; flex: 1; gap: 8px; }
  .modal .mfoot .newf.open { display: flex; }
  .modal .mfoot .newf input { flex: 1; }
  .modal .merr { color: var(--red); font-family: var(--mono); font-size: 11.5px; padding: 0 18px 10px; min-height: 0; }
  .mempty { color: var(--faint); padding: 24px; text-align: center; font-size: 13px; }

  /* Per-Place session cards */
  .session-card { display: flex; flex-direction: column; gap: 5px; }
  .session-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .dot-green { background: var(--green); box-shadow: 0 0 7px var(--green); }
  .dot-red { background: var(--red); box-shadow: 0 0 7px var(--red); }
  .badge-amber { background: var(--amber-bg); color: var(--amber); border: 1px solid color-mix(in oklch, var(--amber) 45%, var(--border)); border-radius: 999px; padding: 2px 9px; font-size: 11px; font-family: var(--mono); }
  .faint { color: var(--faint); }
  #sessionsSection { display: none; }
</style>
</head>
<body>
<header>
  <span class="mark"><span></span></span>
  <h1>Roblox MCP Pro</h1>
  <small id="hdrsub" class="muted">broker monitor</small>
  <div class="spacer"></div>
  <button class="badge" id="hdrStudio" onclick="switchTab('overview')" title="Studio plugin — details on Overview"><span id="hdrStudioDot" class="dot"></span>Studio</button>
  <button class="badge" id="hdrAgents" onclick="switchTab('overview')" title="AI agents — details on Overview"><span id="hdrAgentsDot" class="dot"></span><span id="hdrAgentsText">agents</span></button>
  <span class="badge muted" id="clock"></span>
  <span class="badge"><span id="streamDot" class="dot warn"></span><span id="streamText">connecting…</span></span>
  <nav class="tabs" role="tablist">
    <button class="tab active" data-tab="overview" role="tab" id="tabBtn-overview" aria-controls="tab-overview" aria-selected="true">Overview<span class="tabdot" id="dotOverview"></span></button>
    <button class="tab" data-tab="project" role="tab" id="tabBtn-project" aria-controls="tab-project" aria-selected="false">Sync<span class="tabdot" id="dotSync"></span></button>
    <button class="tab" data-tab="agents" role="tab" id="tabBtn-agents" aria-controls="tab-agents" aria-selected="false">Agents</button>
    <button class="tab" data-tab="license" role="tab" id="tabBtn-license" aria-controls="tab-license" aria-selected="false">License<span class="tabdot" id="dotLicense"></span></button>
  </nav>
</header>
<main>
  <div id="banner" class="banner warn"><div class="head">Loading…</div></div>

  <div class="tabpane active" id="tab-overview" role="tabpanel" aria-labelledby="tabBtn-overview">
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

  <div id="sessionsSection">
    <div class="phead" style="margin-bottom:11px;"><h3>Connected Places</h3></div>
    <div class="cards" id="sessionsCards"></div>
  </div>

  <div class="details">
    <div class="panel">
      <div class="phead"><h3>Studio session</h3><span class="pill" id="studioPill"><span class="dot"></span><span id="studioPillText">—</span></span></div>
      <dl class="kv">
        <dt>Place</dt><dd id="dPlace">—</dd>
        <dt>Place ID</dt><dd id="dPlaceId">—</dd>
        <dt>Version</dt><dd id="dVer">—</dd>
        <dt>Mode</dt><dd id="dMode">—</dd>
        <dt>Last poll</dt><dd id="dPoll">—</dd>
      </dl>
    </div>
    <div class="panel">
      <div class="phead"><h3>Broker</h3><span class="pill on"><span class="dot on"></span>running</span></div>
      <dl class="kv">
        <dt>Port</dt><dd id="dPort">—</dd>
        <dt>Uptime</dt><dd id="dUptime">—</dd>
        <dt>Started</dt><dd id="dStarted">—</dd>
        <dt>Commands</dt><dd id="dCmds">0</dd>
        <dt>Queue</dt><dd id="dQueue">0 queued · 0 in flight</dd>
      </dl>
    </div>
  </div>
  </div><!-- /tab-overview -->

  <div class="tabpane" id="tab-project" role="tabpanel" aria-labelledby="tabBtn-project">
  <div class="panel" id="syncPanel">
    <div class="phead"><h3>Sync · Studio ↔ disk</h3><span class="pill" id="syncPill"><span class="dot" id="syncPillDot"></span><span id="syncPillText">off</span></span></div>

    <!-- Running view -->
    <div id="syncRunning" style="display:none;">
      <div class="syncfacts">
        <div class="syncfact"><div class="fl">DIRECTION</div><div class="fv" id="rDir">—</div></div>
        <div class="syncfact"><div class="fl">PLACE</div><div class="fv" id="rPlace">—</div></div>
        <div class="syncfact"><div class="fl">SCRIPTS</div><div class="fv" id="rScripts">0</div></div>
        <div class="syncfact"><div class="fl">FOLDER</div><div class="fv mono" id="rDirPath">—</div></div>
      </div>
      <div class="btn-group" style="grid-template-columns:1fr 1fr 1fr;">
        <button class="btn" onclick="doSyncAction('pull')">&#8595; Pull once</button>
        <button class="btn" onclick="doSyncAction('push')">&#8593; Push once</button>
        <button class="btn danger" onclick="doSyncAction('stop')">&#9632; Stop sync</button>
      </div>
    </div>

    <!-- Setup view (folder picker + sync options) -->
    <div id="syncSetup">
      <label class="flabel">Project folder</label>
      <div class="folder-row">
        <input type="text" id="projDirInput" class="control-input" readonly placeholder="detecting…" />
        <button class="btn" onclick="changeProjectDir()">Browse…</button>
      </div>

      <label class="flabel">Direction</label>
      <div class="seg-group cols3" id="segDir" role="group" aria-label="Sync direction">
        <button type="button" class="seg active" data-dir="studio-to-disk">Studio &#8594; Disk<span class="segsub">snapshot to files</span></button>
        <button type="button" class="seg" data-dir="disk-to-studio">Disk &#8594; Studio<span class="segsub">files into Studio</span></button>
        <button type="button" class="seg" data-dir="two-way">Two-way<span class="segsub">live, both ways</span></button>
      </div>

      <div id="firstCopyRow" style="display:none;">
        <label class="flabel">First copy (which side wins initially)</label>
        <div class="seg-group cols2" id="segFirst" role="group" aria-label="Initial copy direction">
          <button type="button" class="seg active" data-dir="studio-to-disk">Studio &#8594; Disk</button>
          <button type="button" class="seg" data-dir="disk-to-studio">Disk &#8594; Studio</button>
        </div>
      </div>

      <details class="sync-adv">
        <summary>Advanced</summary>
        <label class="flabel">Roots (comma separated, optional)</label>
        <input type="text" id="inputRoots" placeholder="e.g. ServerScriptService, StarterGui" class="control-input" />
      </details>

      <div class="btn-group" style="grid-template-columns:1fr;">
        <button class="btn primary" onclick="doSyncAction('start')">&#9654; Start sync</button>
      </div>
      <div class="wshint" style="margin-top:6px;">Syncs the project folder selected above.</div>
    </div>

    <div id="syncControlMsg" class="sync-msg"></div>
  </div>

  </div><!-- /tab-project -->

  <div class="tabpane" id="tab-license" role="tabpanel" aria-labelledby="tabBtn-license">
    <div class="panel">
      <div class="phead"><h3>License</h3></div>
      <div id="licStatus" style="font-size:14px;margin-bottom:10px;">Checking…</div>
      <label class="flabel">License key</label>
      <div class="folder-row">
        <input id="inputLicense" type="text" placeholder="ROBLOXAI-…" class="control-input" />
        <button class="btn primary" onclick="saveLicense()">Save key</button>
      </div>
      <div id="licMsg" class="sync-msg"></div>
      <div style="color:var(--muted);font-size:11px;margin-top:7px;">
        No license? <a id="buyLink" href="#" target="_blank" rel="noopener" style="color:var(--green);">Get one</a>.
        After saving, restart your AI client so it picks up the key.
      </div>
    </div>
  </div><!-- /tab-license -->

  <div class="tabpane" id="tab-agents" role="tabpanel" aria-labelledby="tabBtn-agents">
  <section>
    <h2>Connected agents</h2>
    <table>
      <thead><tr><th>Agent</th><th>Role</th><th>Version</th><th>PID</th><th>Client ID</th><th>Commands</th><th>Connected</th><th>Last seen</th></tr></thead>
      <tbody id="agents"><tr><td class="empty" colspan="8">No agents connected.</td></tr></tbody>
    </table>
    <div class="pager" id="agentsPager"></div>
  </section>

  <section>
    <h2>Agent mailbox</h2>
    <p class="muted" style="margin:-4px 0 10px;font-size:12px;">Direct tasks/messages passed between agents via <b>manage_agents</b>. Recipients read these by calling <b>inbox</b>.</p>
    <table>
      <thead><tr><th>Time</th><th>From</th><th>To</th><th>Subject</th><th>Message</th><th>Status</th></tr></thead>
      <tbody id="mailbox"><tr><td class="empty" colspan="6">No messages yet.</td></tr></tbody>
    </table>
    <div class="pager" id="mailboxPager"></div>
  </section>

  <section>
    <h2>Activity</h2>
    <table>
      <thead><tr><th>Time</th><th>Agent</th><th>Tool</th><th>Place</th><th>Result</th><th>ms</th></tr></thead>
      <tbody id="activity"><tr><td class="empty" colspan="6">No activity yet.</td></tr></tbody>
    </table>
    <div class="pager" id="activityPager"></div>
  </section>
  </div><!-- /tab-agents -->
</main>

<!-- Folder picker modal -->
<div class="modal-overlay" id="pickerOverlay">
  <div class="modal" role="dialog" aria-modal="true" aria-label="Choose project folder">
    <div class="mhead">
      <h4>Choose project folder</h4>
      <button class="mclose" onclick="closePicker()" aria-label="Close">&#10005;</button>
    </div>
    <div class="mpath">
      <button class="btn" id="pkUp" style="padding:5px 11px;font-size:12px;">&#8593; Up</button>
      <span class="cur" id="pkPath">Suggestions</span>
    </div>
    <div class="mlist" id="pkList"></div>
    <div class="merr" id="pkErr"></div>
    <div class="mfoot">
      <button class="btn" id="pkNewBtn">+ New folder</button>
      <span class="newf" id="pkNewRow">
        <input type="text" class="control-input" id="pkNewName" placeholder="folder name" />
        <button class="btn" id="pkNewOk">Create</button>
      </span>
      <div class="spacer"></div>
      <button class="btn primary" id="pkUse" disabled>Use this folder</button>
    </div>
  </div>
</div>

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
let last = null; // latest SSE state snapshot (declared early — used across sections)

// Client-side pagination for the agents/activity tables (5 rows per page).
const PAGE_SIZE = 5;
let agentsPage = 0, activityPage = 0, mailboxPage = 0;
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

function setPill(id, textId, level, text) {
  $(id).className = "pill " + (level === "ok" ? "on" : level === "warn" ? "warn2" : level === "bad" ? "off2" : "");
  const dot = $(id).querySelector(".dot");
  if (dot) dot.className = "dot " + (level === "ok" ? "on" : level === "warn" ? "warn" : level === "bad" ? "off" : "");
  $(textId).textContent = text;
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

  setPill("studioPill", "studioPillText", ps.level, ps.label.toLowerCase());
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

  // header pills (visible on every tab) + tab indicator dots
  $('hdrStudioDot').className = 'dot ' + (ps.level === 'ok' ? 'on' : ps.level === 'warn' ? 'warn' : 'off');
  $('hdrAgentsDot').className = 'dot ' + (agents.length ? 'on' : 'off');
  $('hdrAgentsText').textContent = agents.length === 1 ? '1 agent' : agents.length + ' agents';
  $('dotOverview').className = 'tabdot' + (problems.length ? (problems.some((p) => p.sev === 'bad') ? ' bad' : ' warn') : '');

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

  // agents table (paginated, 5 per page)
  const ROLES = ['idle', 'lead', 'worker'];
  const roleSelect = (a) => {
    const role = a.role || 'idle';
    return "<select class='rolesel " + role + "' data-cid='" + a.clientId + "'>" +
      ROLES.map((r) => "<option value='" + r + "'" + (role === r ? " selected" : "") + ">" + r + "</option>").join("") +
      "</select>";
  };
  const agentRow = (a) =>
    "<tr><td class=agentcell><span class='dot on'></span>" + esc(a.name) + "</td><td>" + roleSelect(a) +
    "</td><td class=muted>" + esc(a.version || "—") +
    "</td><td class=muted>" + (a.pid ?? "—") + "</td><td class=muted>" + esc((a.clientId || "").slice(0, 8)) +
    "</td><td>" + a.commandCount + "</td><td class=muted>" + ago(a.connectedAt) + "</td><td class=muted>" + ago(a.lastSeenAt) + "</td></tr>";
  // Don't rebuild the agents table while a role dropdown is open: re-rendering
  // the tbody innerHTML would destroy the focused <select> and snap it shut
  // before the user can pick. Skip this cycle; it refreshes on the next update
  // once focus leaves the dropdown.
  const ae = document.activeElement;
  const editingRole = ae && ae.classList && ae.classList.contains('rolesel');
  if (!editingRole) {
    agentsPage = renderPaged("agents", agents, agentRow, agentsPage, 8, "No agents connected.");
  }

  // mailbox table (agent-to-agent messages, paginated)
  const mailbox = state.mailbox || [];
  const liveIds = new Set(agents.map((a) => a.clientId));
  const statusPill = (m) => {
    if (!liveIds.has(m.toClientId)) return "<span class=err>recipient offline</span>";
    if (m.status === "done") return "<span class=ok>done</span>";
    if (m.status === "read") return "<span class=muted>read</span>";
    return "<span style='color:var(--accent)'>unread</span>";
  };
  const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };
  const mailRow = (m) =>
    "<tr><td class=muted>" + fmtTime(m.ts) + "</td><td>" + esc(m.fromName) +
    "</td><td>" + esc(m.toName) + "</td><td>" + esc(clip(m.subject, 40) || "—") +
    "</td><td class=muted title='" + esc(m.body) + "'>" + esc(clip(m.body, 60)) +
    "</td><td>" + statusPill(m) + "</td></tr>";
  mailboxPage = renderPaged("mailbox", mailbox, mailRow, mailboxPage, 6, "No messages yet.");

  // activity table (paginated, 5 per page)
  const recent = state.recent || [];
  const activityRow = (c) =>
    "<tr><td class=muted>" + fmtTime(c.ts) + "</td><td>" + esc(c.agent) +
    "</td><td class=tool>" + esc(c.tool) +
    "</td><td class=muted>" + esc(c.placeName || c.sessionId || "—") +
    "</td><td class=" + (c.ok ? "ok>ok" : "err>" + esc(c.error || "error")) +
    "</td><td class=muted>" + c.durationMs + "</td></tr>";
  activityPage = renderPaged("activity", recent, activityRow, activityPage, 6, "No activity yet.");

  // Connected Places section (multi-session cards)
  var sessions = state.sessions || [];
  var ssEl = $("sessionsSection");
  var ssCards = $("sessionsCards");
  if (ssEl && ssCards) {
    if (sessions.length >= 2) {
      ssEl.style.display = "block";
      ssCards.innerHTML = sessions.map(function(s) {
        var dot = s.connected ? "dot-green" : "dot-red";
        var warn = (s.boundAgents && s.boundAgents.length > 1)
          ? "<span class='badge-amber'>&#9888; " + s.boundAgents.length + " agents bound — expected 1</span>" : "";
        var who = (s.boundAgents || []).map(function(a) { return esc(a.name); }).join(", ") || "<span class='faint'>unbound</span>";
        return "<div class='card session-card'>"
          + "<div class='session-head'><span class='dot " + dot + "'></span>"
          + "<b>" + esc(s.placeName || "(unnamed Place)") + "</b> " + warn + "</div>"
          + "<div class='faint'>placeId " + esc(s.placeId != null ? String(s.placeId) : "—") + " · queued " + (s.queued || 0) + "</div>"
          + "<div>agents: " + who + "</div>"
          + "</div>";
      }).join("");
    } else {
      ssEl.style.display = "none";
    }
  }

  $("hdrsub").textContent = "broker monitor · :" + (state.port ?? "3690");
  $("clock").textContent = "updated " + new Date().toLocaleTimeString();

  // Sync panel: pill + compact "running" view vs the setup form.
  const DIR_LABEL = { "two-way": "Two-way (live)", "studio-to-disk": "Studio \\u2192 Disk", "disk-to-studio": "Disk \\u2192 Studio" };
  $('syncSetup').style.display = sync.running ? 'none' : 'block';
  $('syncRunning').style.display = sync.running ? 'block' : 'none';
  if (sync.running) {
    const paused = !!sync.playtestActive;
    setPill("syncPill", "syncPillText", paused ? "warn" : "ok", paused ? "playtest \\u00b7 paused" : "syncing");
    set('rDir', DIR_LABEL[sync.mode] || sync.mode || '\\u2014');
    set('rPlace', sync.placeName || (sync.placeId != null ? String(sync.placeId) : '\\u2014'));
    set('rScripts', sync.scriptCount ?? 0);
    set('rDirPath', sync.syncDir || '\\u2014');
  } else {
    setPill("syncPill", "syncPillText", "", "off");
  }
  $('dotSync').className = 'tabdot' + (sync.running && sync.playtestActive ? ' warn' : '');
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
    // One source of truth: the project folder in the IDE bar below.
    const syncDir = projDir || '';
    if (!syncDir) {
      showMsg('Pick a project folder first (Browse\\u2026 above).', true);
      return;
    }
    const activeSeg = document.querySelector('#segDir .seg.active');
    const sel = activeSeg ? activeSeg.dataset.dir : 'studio-to-disk';
    payload.syncDir = syncDir;
    payload.mode = sel;
    if (sel === 'two-way') {
      const firstSeg = document.querySelector('#segFirst .seg.active');
      payload.initialDirection = firstSeg ? firstSeg.dataset.dir : 'studio-to-disk';
    } else {
      payload.initialDirection = sel;
    }
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

const BUY_URL = 'https://buy.polar.sh/polar_cl_ZOs8s5PTV2KAyj0y71A7xtBzIpPbdclQfrQBP3IHCyH';

function renderLicense(data) {
  const el = $('licStatus');
  if (!el) return;
  const s = (data && data.status) || 'unknown';
  const tint = s === 'licensed' ? 'var(--green)' : (s === 'trial' ? '#e0a82e' : 'var(--red)');
  const label = s === 'licensed' ? 'Licensed ✅' : (s === 'trial' ? 'Free trial (full Pro)' : (s === 'locked' ? 'Free tier (Pro locked)' : s));
  // The server message may start with the same word as the label — drop the echo.
  let msg = (data && data.message) || '';
  if (s === 'licensed') msg = msg.replace(/^Licensed\\s*\\u2705?\\s*/i, '');
  el.innerHTML = '<b style="color:' + tint + '">' + label + '</b>' + (msg ? ' — ' + esc(msg) : '');
  const dot = $('dotLicense');
  if (dot) dot.className = 'tabdot' + (s === 'locked' ? ' bad' : s === 'trial' ? ' warn' : '');
}

async function loadLicense() {
  const buy = $('buyLink');
  if (buy) buy.href = BUY_URL;
  try {
    const res = await fetch('/api/license');
    renderLicense(await res.json());
  } catch (err) {
    const el = $('licStatus');
    if (el) el.textContent = 'Could not read license status.';
  }
}

async function saveLicense() {
  const elMsg = $('licMsg');
  const showMsg = (msg, isErr = false) => {
    elMsg.textContent = msg;
    elMsg.style.color = isErr ? 'var(--red)' : 'var(--green)';
  };
  const key = $('inputLicense').value.trim();
  if (!key) { showMsg('Paste your license key first.', true); return; }
  showMsg('Validating…');
  try {
    const res = await fetch('/api/license', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const data = await res.json();
    if (data.ok) {
      showMsg('Saved & validated — restart your AI client to apply.');
      $('inputLicense').value = '';
      renderLicense(data);
    } else {
      showMsg('Error: ' + (data.error || data.message || 'invalid key'), true);
      renderLicense(data);
    }
  } catch (err) {
    showMsg('Failed to connect to broker: ' + err, true);
  }
}

// ---- Folder picker (Browse… modal backed by /api/fs/browse) ---------------
let pickerTargetInput = null;
let pickerTargetHint = null;
let pickerOnDone = null;
let pickerPath = null; // null = top level (suggestions + drives)

function openPicker(inputId, hintId, onDone) {
  pickerTargetInput = inputId;
  pickerTargetHint = hintId;
  pickerOnDone = onDone || null;
  $('pickerOverlay').classList.add('open');
  $('pkErr').textContent = '';
  $('pkNewRow').classList.remove('open');
  const current = $(inputId).value.trim();
  pkNavigate(current || null);
}

function closePicker() {
  $('pickerOverlay').classList.remove('open');
  pickerTargetInput = null;
  pickerOnDone = null;
}

async function pkNavigate(path) {
  $('pkErr').textContent = '';
  $('pkList').innerHTML = '<div class="mempty">Loading\\u2026</div>';
  try {
    const url = path ? '/api/fs/browse?path=' + encodeURIComponent(path) : '/api/fs/browse';
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) {
      // e.g. a stale path that no longer exists — fall back to top level.
      if (path) { pkNavigate(null); return; }
      $('pkErr').textContent = data.error || 'Could not browse.';
      $('pkList').innerHTML = '';
      return;
    }
    if (path) {
      pickerPath = data.path;
      $('pkPath').textContent = data.path;
      // From a drive root (no parent) Up returns to the drives/suggestions view.
      $('pkUp').disabled = false;
      $('pkUp').onclick = () => { if (data.parent) pkNavigate(data.parent); else pkNavigate(null); };
      $('pkUse').disabled = false;
      $('pkNewBtn').style.display = '';
      const rows = data.dirs.map((d) =>
        "<button class='mitem' data-path='" + esc(d.path).replace(/'/g, '&#39;') + "'><span class='ico'>&#128193;</span><span class='nm'>" + esc(d.name) + "</span>" +
        (d.isProject ? "<span class='tag proj'>roblox project</span>" : "") + "</button>"
      ).join("");
      $('pkList').innerHTML = rows || '<div class="mempty">No sub-folders here. Click "Use this folder" to pick it.</div>';
    } else {
      pickerPath = null;
      $('pkPath').textContent = 'Suggestions & drives';
      $('pkUp').disabled = true;
      $('pkUse').disabled = true;
      $('pkNewBtn').style.display = 'none';
      let html = '';
      if ((data.suggestions || []).length) {
        html += "<div class='msection'>Detected</div>" + data.suggestions.map((s) =>
          "<button class='mitem' data-path='" + esc(s.path).replace(/'/g, '&#39;') + "' data-pick='1'><span class='ico'>&#10022;</span><span class='nm'>" + esc(s.path) + "</span><span class='tag'>" + esc(s.source) + "</span></button>"
        ).join("");
      }
      html += "<div class='msection'>Drives</div>" + (data.roots || []).map((r) =>
        "<button class='mitem' data-path='" + esc(r.path).replace(/'/g, '&#39;') + "'><span class='ico'>&#128190;</span><span class='nm'>" + esc(r.name) + "</span></button>"
      ).join("");
      $('pkList').innerHTML = html || '<div class="mempty">Nothing to show.</div>';
    }
  } catch (err) {
    $('pkErr').textContent = 'Failed to reach broker: ' + err;
    $('pkList').innerHTML = '';
  }
}

function pkChoose(path) {
  if (pickerTargetInput && $(pickerTargetInput)) {
    $(pickerTargetInput).value = path;
    if (pickerTargetHint && $(pickerTargetHint)) $(pickerTargetHint).innerHTML = 'Chosen via <b>Browse</b>';
  }
  const done = pickerOnDone;
  closePicker();
  if (done) done(path);
}

// List clicks: suggestions pick directly (double duty: single click navigates
// into a folder; a suggestion is already a full project path so picking it
// immediately is the fast path users want).
$('pkList').addEventListener('click', (e) => {
  const item = e.target.closest('.mitem');
  if (!item) return;
  const p = item.getAttribute('data-path');
  if (!p) return;
  if (item.getAttribute('data-pick')) pkChoose(p);
  else pkNavigate(p);
});
$('pkUse').addEventListener('click', () => { if (pickerPath) pkChoose(pickerPath); });
$('pickerOverlay').addEventListener('click', (e) => { if (e.target === $('pickerOverlay')) closePicker(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });

// New folder: reveal name input, create via /api/fs/mkdir, then enter it.
$('pkNewBtn').addEventListener('click', () => {
  $('pkNewRow').classList.toggle('open');
  $('pkNewName').focus();
});
$('pkNewOk').addEventListener('click', async () => {
  const name = $('pkNewName').value.trim();
  if (!name || !pickerPath) return;
  $('pkErr').textContent = '';
  try {
    const res = await fetch('/api/fs/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: pickerPath, name })
    });
    const data = await res.json();
    if (data.ok) {
      $('pkNewName').value = '';
      $('pkNewRow').classList.remove('open');
      pkNavigate(data.path);
    } else {
      $('pkErr').textContent = data.error || 'Could not create folder.';
    }
  } catch (err) {
    $('pkErr').textContent = 'Failed to reach broker: ' + err;
  }
});
$('pkNewName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pkNewOk').click(); });

// ---- Project tab: folder selector for Sync --------------------------------
// The mini-IDE was removed - edit scripts in your own editor (VS Code). This
// just tracks which folder Sync reads/writes and shows it in the panel.
let projDir = null;

// Where Sync looks: user's explicit choice > running sync > active agent
// cwd > broker suggestions (recents work even before any agent connects).
async function resolveProjectDir() {
  try {
    const saved = localStorage.getItem('rmp-projdir');
    if (saved) return saved;
  } catch {}
  if (last && last.sync && last.sync.syncDir) return last.sync.syncDir;
  if (last && last.agents && last.agents.length) {
    const a = [...last.agents].sort((x, y) => y.lastSeenAt - x.lastSeenAt).find((x) => x.cwd);
    if (a && a.cwd) return a.cwd;
  }
  try {
    const d = await (await fetch('/api/fs/browse')).json();
    if (d.ok && d.suggestions && d.suggestions.length) return d.suggestions[0].path;
  } catch {}
  return null;
}

async function projectShow() {
  const dir = await resolveProjectDir();
  projDir = dir;
  $('projDirInput').value = dir || '';
}

function changeProjectDir() {
  openPicker('projDirInput', null, (p) => {
    try { localStorage.setItem('rmp-projdir', p); } catch {}
    projectShow();
  });
}

// ---- Tabs: hash-based, last tab remembered, Overview by default ------------
const TAB_NAMES = ['overview', 'project', 'agents', 'license'];
function switchTab(name) {
  if (name === 'sync') name = 'project'; // old bookmark/hash compatibility
  if (!TAB_NAMES.includes(name)) name = 'overview';
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  try { localStorage.setItem('rmp-tab', name); } catch {}
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  if (name === 'project') projectShow();
}
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});
window.addEventListener('hashchange', () => switchTab(location.hash.slice(1)));
(function initTab() {
  let name = location.hash.slice(1);
  if (!TAB_NAMES.includes(name)) {
    try { name = localStorage.getItem('rmp-tab') || 'overview'; } catch { name = 'overview'; }
  }
  switchTab(name);
})();

function setStream(ok) {
  $("streamDot").className = "dot " + (ok ? "on" : "off");
  $("streamText").textContent = ok ? "live" : "disconnected — retrying";
}

function apply(s) { last = s; render(s); }

let es;
function connect() {
  es = new EventSource("/api/stream");
  es.onopen = () => setStream(true);
  es.onmessage = (e) => { try { apply(JSON.parse(e.data)); } catch {} };
  es.onerror = () => { setStream(false); es.close(); setTimeout(connect, 2000); };
}

// Sync Control: direction segments (vanilla, no framework). Picking "Two-way"
// reveals the first-copy choice.
document.querySelectorAll('#segDir .seg').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#segDir .seg').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('firstCopyRow').style.display = b.dataset.dir === 'two-way' ? 'block' : 'none';
  });
});
document.querySelectorAll('#segFirst .seg').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#segFirst .seg').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
  });
});

// Table pagination: prev/next buttons (delegated, no inline handlers).
document.addEventListener('click', (e) => {
  const b = e.target.closest('.pgbtn');
  if (!b || b.disabled) return;
  const d = parseInt(b.getAttribute('data-d'), 10) || 0;
  const pg = b.getAttribute('data-pg');
  if (pg === 'agents') agentsPage += d;
  else if (pg === 'mailbox') mailboxPage += d;
  else activityPage += d;
  if (last) render(last);
});

// Agent role dropdowns (delegated — rows are re-rendered on every SSE update).
document.addEventListener('change', (e) => {
  const sel = e.target.closest('.rolesel');
  if (!sel) return;
  setAgentRole(sel.getAttribute('data-cid'), sel.value);
});

// Assign an agent's coordination role from the dashboard (human-driven).
// The broker enforces a single lead; the SSE stream re-renders with the result.
function setAgentRole(clientId, role) {
  fetch('/api/agents/role', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, role }),
  })
    .then((r) => r.json())
    .then((d) => { if (d && d.ok === false && d.error) alert('Could not set role: ' + d.error); })
    .catch(() => {});
}

connect();
loadLicense();

// keep relative timestamps fresh between server pushes
setInterval(() => { if (last) render(last); }, 2000);
</script>
</body>
</html>`;
