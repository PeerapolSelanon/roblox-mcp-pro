// Manual e2e: a controllable Worker agent for testing Lead/Worker + multi-Place.
// Registers with the broker as "worker-bot", claims the worker role, polls its
// inbox, and when it receives a task it attaches to the named Place, creates a
// probe Part, reports back to the lead, and exits.
//
// Task body convention: include "place=<PlaceName>" (defaults to GamePlay).
// Run: node scripts/test-worker.mjs

const BASE = process.env.ROBLOX_MCP_BASE ?? "http://127.0.0.1:3690";

async function rpc(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function call(clientId, tool, args) {
  const res = await rpc("/rpc/call", { clientId, tool, args });
  return res;
}

const reg = await rpc("/rpc/register", { name: "worker-bot", pid: process.pid, cwd: process.cwd() });
const clientId = reg.clientId;
if (!clientId) {
  console.log("FAILED to register:", JSON.stringify(reg));
  process.exit(1);
}
const hb = setInterval(() => {
  fetch(BASE + "/rpc/heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId }),
  }).catch(() => {});
}, 2000);

await call(clientId, "manage_agents", { action: "set_role", role: "worker" });
console.log("[worker-bot] registered + role=worker, clientId=" + clientId);

for (let i = 0; i < 45; i++) {
  const inb = await call(clientId, "manage_agents", { action: "inbox", unreadOnly: true });
  const msgs = (inb.result && inb.result.messages) || [];
  if (msgs.length) {
    const m = msgs[0];
    console.log("[worker-bot] got task from " + m.fromName + ": " + m.body);
    const place = (m.body.match(/place=([^\s:,.]+)/) || [])[1] || "GamePlay";

    const at = await call(clientId, "manage_agents", { action: "attach", place });
    console.log("[worker-bot] attach " + place + " -> " + JSON.stringify(at.result || at.error));

    const ex = await call(clientId, "execute_luau", {
      code: 'local p=Instance.new("Part") p.Name="MCP_LeadWorker_Test" p.Anchored=true p.Parent=workspace return game.PlaceId, p.Name, (workspace:FindFirstChild("MCP_LeadWorker_Test")~=nil)',
    });
    console.log("[worker-bot] execute -> " + JSON.stringify(ex.result || ex.error));

    await call(clientId, "manage_agents", {
      action: "send",
      to: "lead",
      subject: "task done",
      body: "Done. attached=" + place + " execute=" + JSON.stringify(ex.result || ex.error),
    });
    await call(clientId, "manage_agents", { action: "done", messageId: m.id });
    console.log("[worker-bot] replied to lead + marked done. exiting.");
    clearInterval(hb);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("[worker-bot] no task received within timeout. exiting.");
clearInterval(hb);
process.exit(1);
