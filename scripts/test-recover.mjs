// E2E: verify the client transport self-heals when the broker dies mid-session.
import { spawn, execSync } from "node:child_process";

const proc = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const pending = new Map();
let nextId = 1;
proc.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const call = () => rpc("tools/call", { name: "system_info", arguments: {} });
const text = (r) => r.result?.content?.[0]?.text?.slice(0, 80);

console.log("call 1 (broker fresh):", text(await call()));

// Kill whatever holds the broker port.
const pid = execSync(
  `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 3690 -State Listen).OwningProcess"`,
).toString().trim();
execSync(`powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force"`);
console.log("killed broker pid", pid);
await new Promise((r) => setTimeout(r, 1000));

const r2 = await call();
const ok = !r2.result?.isError;
console.log("call 2 (after kill):", text(r2));
console.log(ok ? "SELF-HEAL OK" : "SELF-HEAL FAILED");
proc.kill();
process.exit(ok ? 0 : 1);
