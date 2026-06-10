// Keep a fake agent registered against a test broker so the dashboard can be
// inspected with realistic state (universe with places, no Studio plugin).
const PORT = process.env.ROBLOX_MCP_PORT ?? "3699";
const base = `http://127.0.0.1:${PORT}`;
const cwd = process.argv[2];
if (!cwd) {
  console.error("usage: node test-dashboard.mjs <universe-dir>");
  process.exit(1);
}

const reg = await fetch(`${base}/rpc/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "test-agent", version: "0.0.0", pid: process.pid, cwd }),
}).then((r) => r.json());
console.log("registered:", reg.clientId);

setInterval(() => {
  fetch(`${base}/rpc/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: reg.clientId }),
  }).catch(() => {});
}, 3000);
