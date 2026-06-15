# Broker Real-time Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ทำให้ broker ปิดทันทีเมื่อ agent ตัวสุดท้ายออก และอยู่ต่อเมื่อยังมี agent อื่นเชื่อมต่อ พร้อมรองรับการอัปเดตเวอร์ชันอัตโนมัติ

**Architecture:** อายุของ broker ผูกกับจำนวน agent ที่เชื่อมต่อ (reference counting มีอยู่แล้ว) ฝั่ง client ตรวจจับการออกแบบสะอาดผ่านการปิดท่อ stdio + เร่ง heartbeat ฝั่ง broker ลด TTL ให้ตรวจ crash เร็ว และเพิ่ม event `onEmpty` ที่ยิงเมื่อ agent หมด → ตั้ง grace timer สั้นๆ แล้วปิด

**Tech Stack:** TypeScript (Node.js), `@modelcontextprotocol/sdk` (stdio transport), broker HTTP บน 127.0.0.1:3690

> **หมายเหตุการทดสอบ:** repo นี้ไม่มี test suite อัตโนมัติ (ดู CLAUDE.md) การตรวจในแต่ละ task คือ `npm run build` (จับ type error) + ทดสอบ e2e ด้วยมือกับ Studio/broker จริง โดยดู log ที่ `%TEMP%\roblox-mcp-pro-broker.log`

---

### Task 1: เร่ง heartbeat ฝั่ง client + ตรวจจับการออกแบบสะอาด

ทำให้ broker รู้เร็วเมื่อ agent ตาย (heartbeat ถี่ขึ้น) และเมื่อ MCP host ปิดท่อ stdio ให้ส่ง `deregister` (ไม่ใช่แค่ตอนได้สัญญาณ) — จุดนี้สำคัญเพราะ Claude Code มักปิด server ด้วยการปิดท่อ ไม่ส่ง SIGINT/SIGTERM โดยเฉพาะบน Windows

**Files:**
- Modify: `src/client/transport.ts:171-180` (heartbeat interval)
- Modify: `src/index.ts:114-120` (shutdown idempotent + hook stdio close)

- [ ] **Step 1: เร่ง heartbeat เป็น ~2 วินาที**

ใน `src/client/transport.ts` ฟังก์ชัน `register()` แก้ interval ของ heartbeat จาก `10_000` เป็น `2_000`:

```ts
  heartbeatTimer = setInterval(() => {
    if (!clientId) return;
    void fetch(`${BASE}/rpc/heartbeat`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ clientId }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
    // 2s (was 10s): a faster pulse lets the broker prune a crashed agent — one
    // that died without deregistering — within a few seconds, so it can free
    // the port promptly. Local HTTP, so the extra traffic is negligible.
  }, 2_000);
  heartbeatTimer.unref();
```

- [ ] **Step 2: ทำ shutdown ให้ idempotent และผูกกับการปิดท่อ stdio**

ใน `src/index.ts` แทนที่บล็อก shutdown เดิม (`src/index.ts:114-120`):

```ts
  const shutdown = async (): Promise<void> => {
    log("shutting down…");
    await deregister();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
```

ด้วย:

```ts
  // MCP hosts usually stop the server by closing the stdio pipe rather than
  // sending a signal (especially on Windows). Treat every one of these as the
  // same clean exit so the broker always hears our deregister and can free the
  // port promptly. Guarded so the duplicate triggers only deregister once.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutting down…");
    await deregister();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  server.server.onclose = () => void shutdown();
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
```

- [ ] **Step 3: Build เพื่อตรวจ type**

Run: `npm run build`
Expected: คอมไพล์ผ่าน ไม่มี error (โดยเฉพาะ `server.server.onclose` ต้องเป็น property ที่กำหนดค่าได้ เหมือน `oninitialized` ที่ใช้อยู่แล้วด้านบน)

- [ ] **Step 4: Commit**

```bash
git add src/client/transport.ts src/index.ts
git commit -m "feat(client): detect clean exit via stdio close + faster heartbeat"
```

---

### Task 2: ลด TTL + เพิ่ม event `onEmpty` ในรีจิสทรี

ให้ broker ตัด agent ที่ตายเร็วขึ้น และยิง callback เมื่อจำนวน agent ลดลงเหลือ 0 (ทั้งจากการ deregister ปกติ และจากการ prune ตอน crash)

**Files:**
- Modify: `src/broker/registry.ts:61` (TTL)
- Modify: `src/broker/registry.ts:65-72` (เพิ่ม field `onEmpty`)
- Modify: `src/broker/registry.ts:107-109` (`deregister`)
- Modify: `src/broker/registry.ts:215-226` (`prune`)

- [ ] **Step 1: ลด `AGENT_TTL_MS`**

ใน `src/broker/registry.ts` แก้บรรทัด 61:

```ts
const AGENT_TTL_MS = 6_000; // drop agents that haven't heartbeat in this long (was 30s)
```

- [ ] **Step 2: เพิ่ม field `onEmpty` ข้างๆ `onChange`**

ใน `src/broker/registry.ts` ในคลาส `BrokerState` ใต้บรรทัด `onChange` (ราว 71) เพิ่ม:

```ts
  /** Set by the route layer to push a fresh snapshot to dashboard listeners. */
  onChange: (() => void) | null = null;

  /** Fired when the connected-agent count transitions from 1 → 0. The broker
   *  uses this to start its prompt-teardown timer (see broker/main.ts). */
  onEmpty: (() => void) | null = null;
```

- [ ] **Step 3: ยิง `onEmpty` ใน `deregister`**

แก้ `deregister` (`src/broker/registry.ts:107-109`):

```ts
  deregister(clientId: string): void {
    if (this.agents.delete(clientId)) {
      this.notify();
      if (this.agents.size === 0) this.onEmpty?.();
    }
  }
```

- [ ] **Step 4: ยิง `onEmpty` ใน `prune`**

แก้ปลายเมธอด `prune` (`src/broker/registry.ts:215-226`):

```ts
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
    if (removed) {
      this.notify();
      if (this.agents.size === 0) this.onEmpty?.();
    }
  }
```

- [ ] **Step 5: Build เพื่อตรวจ type**

Run: `npm run build`
Expected: คอมไพล์ผ่าน ไม่มี error

- [ ] **Step 6: Commit**

```bash
git add src/broker/registry.ts
git commit -m "feat(broker): fast crash TTL + onEmpty event when last agent leaves"
```

---

### Task 3: เปลี่ยน broker เป็นปิดทันทีแบบ event-driven

เลิกใช้การ poll รอ 20 วิ เปลี่ยนเป็น: พอ `onEmpty` ยิง → ตั้ง grace timer สั้นๆ (ค่าเริ่มต้น 1.5 วิ, ปรับผ่าน env, ตั้ง 0 ได้) → ครบเวลาแล้วถ้ายังไม่มี agent ก็ปิด ส่วน tick เดิม (prune + refresh dashboard) ยังทำงานทุก 1 วิ และคอยยกเลิก timer ถ้ามี agent กลับมา

**Files:**
- Modify: `src/broker/main.ts:32-39` (คอมเมนต์ + ค่าคงที่)
- Modify: `src/broker/main.ts:82-132` (ฟังก์ชัน `main`)

- [ ] **Step 1: แทนคอมเมนต์และค่าคงที่ idle เดิม**

ใน `src/broker/main.ts` แทนบล็อกคอมเมนต์ + `const IDLE_SHUTDOWN_MS = 20_000;` (`src/broker/main.ts:32-39`) ด้วย:

```ts
/**
 * How long to wait after the LAST agent leaves before shutting down. Liveness is
 * driven by agents only (NOT the Studio plugin): when no MCP client is connected
 * there is nothing to drive Studio, so the broker frees the port and exits. The
 * grace is small by design — just enough to absorb an MCP host that restarts its
 * server (agents briefly hit zero then reconnect) so we don't kill+respawn the
 * broker on every reconnect. Tunable via ROBLOX_MCP_IDLE_SHUTDOWN_MS; set 0 for
 * immediate teardown. The Studio plugin reconnects automatically to the next broker.
 */
function idleShutdownMs(): number {
  const raw = Number(process.env.ROBLOX_MCP_IDLE_SHUTDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1500;
}
```

- [ ] **Step 2: แทนลูป heartbeat เดิมด้วย teardown แบบ event-driven**

ใน `src/broker/main.ts` ฟังก์ชัน `main()` แทนบล็อกตั้งแต่ `let idleSince: number | null = null;` จนจบ `heartbeat.unref();` (`src/broker/main.ts:106-121`) ด้วย:

```ts
  const graceMs = idleShutdownMs();
  let teardownTimer: NodeJS.Timeout | null = null;

  const cancelTeardown = (): void => {
    if (teardownTimer) {
      clearTimeout(teardownTimer);
      teardownTimer = null;
    }
  };

  const armTeardown = (): void => {
    cancelTeardown();
    teardownTimer = setTimeout(() => {
      // Re-check at fire time: an agent may have (re)connected during the grace.
      if (routes.state.agentCount() === 0) {
        log("last agent left — shutting down and freeing the port.");
        stopAndExit();
      }
    }, graceMs);
    // Don't let a pending teardown keep the event loop alive on its own.
    teardownTimer.unref();
  };

  // The registry fires onEmpty the moment the connected-agent count hits zero —
  // whether from a clean deregister or from pruning a crashed agent.
  routes.state.onEmpty = armTeardown;

  // Housekeeping: prune dead agents + refresh the dashboard. Also cancels any
  // pending teardown as soon as an agent is present again (belt-and-suspenders
  // alongside the re-check inside the timer).
  const heartbeat = setInterval(() => {
    routes.tick();
    if (routes.state.agentCount() > 0) cancelTeardown();
  }, 1000);
  heartbeat.unref();

  // If the broker spawned but no agent ever registers (rare race), don't linger.
  if (routes.state.agentCount() === 0) armTeardown();
```

- [ ] **Step 3: ตรวจว่า `shutdown` hook เดิมยังเคลียร์ timer/heartbeat ถูกต้อง**

บล็อก `shutdown` ที่ตามมา (`src/broker/main.ts:123-131`) เรียก `clearInterval(heartbeat)` อยู่แล้ว เพิ่ม `cancelTeardown()` เข้าไปด้วย:

```ts
  const shutdown = (): void => {
    log("shutting down…");
    clearInterval(heartbeat);
    cancelTeardown();
    stopAndExit();
  };
  // Let a newer client replace us via POST /rpc/shutdown.
  routes.setShutdownHook(shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
```

- [ ] **Step 4: Build เพื่อตรวจ type**

Run: `npm run build`
Expected: คอมไพล์ผ่าน ไม่มี error และไม่มีการอ้างถึง `IDLE_SHUTDOWN_MS`/`idleSince` ตัวเดิมหลงเหลือ

- [ ] **Step 5: Commit**

```bash
git add src/broker/main.ts
git commit -m "feat(broker): prompt event-driven teardown when last agent leaves"
```

---

### Task 4: เอกสารอัปเดตอัตโนมัติ + ยืนยันการติดตั้ง plugin/skills

กลไกอัปเดต (npm `@latest`, auto-install plugin/skills) มีอยู่แล้ว — task นี้แค่เพิ่มข้อควรระวังเรื่องการปักหมุดเวอร์ชัน และยืนยันว่า startup ยังติดตั้ง plugin/skills (ไม่แก้โค้ด)

**Files:**
- Modify: `README.md:83-86` (เพิ่มหมายเหตุ)
- Verify (no change): `src/index.ts:62-77`

- [ ] **Step 1: ยืนยันการ auto-install ตอน startup ยังทำงาน**

อ่าน `src/index.ts:62-77` ยืนยันว่ายังเรียก `ensurePluginInstalled()` และ `ensureSkillsInstalled()` ตอน startup (เว้นแต่ตั้ง opt-out env) — ไม่ต้องแก้โค้ด เป็นการยืนยันว่า facet "plugin + skills ใหม่เสมอ" ครอบคลุมแล้ว

- [ ] **Step 2: เพิ่มหมายเหตุเรื่องการปักหมุดเวอร์ชันใน README**

ใน `README.md` ต่อท้าย blockquote "Updates are automatic." (`README.md:83-86`) เพิ่มอีกบรรทัดในกล่อง blockquote เดียวกัน:

```markdown
> **Updates are automatic.** Because the command uses `@latest`, each time your AI client starts
> the server it fetches the newest release. The Studio plugin also self-updates: the server copies
> the latest bundled plugin into your Plugins folder on startup (just restart Studio when it tells
> you a new plugin was installed). You never have to reinstall anything by hand.
>
> If you pin a specific version in your MCP config (e.g. `roblox-mcp-pro@1.0.31` instead of
> `@latest`) you opt out of auto-update — you'll stay on that version until you change it. The
> broker also shuts down as soon as your last AI client disconnects, so the next launch always
> starts a fresh server on the newest version rather than reattaching to an old one.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: note pinned-version opt-out and prompt broker teardown"
```

---

### Task 5: ทดสอบ end-to-end ด้วยมือ

ตรวจพฤติกรรมจริงทั้ง 4 สถานการณ์กับ broker จริง การ build เสร็จแล้วใน task ก่อนหน้า รัน broker จาก `dist/`

**Files:**
- ไม่มีการแก้ไฟล์ (verification only) — ดู log `%TEMP%\roblox-mcp-pro-broker.log`

- [ ] **Step 1: เตรียม — build ล่าสุดและล้าง broker เก่า**

Run (PowerShell):
```powershell
npm run build
# ปิด broker เก่าถ้ายังรัน (best-effort)
try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3690/rpc/shutdown -TimeoutSec 2 } catch {}
```
Expected: build ผ่าน; ถ้ามี broker เก่ามันจะปิด

- [ ] **Step 2: สถานการณ์ 1 — agent ตัวเดียว ออกสะอาด**

เปิด MCP client (เช่น Claude Code) ที่ผูกกับ roblox-mcp-pro หนึ่งตัว ยืนยันว่า `Invoke-RestMethod http://127.0.0.1:3690/rpc/ping` ตอบ `{ broker: "roblox-mcp-pro", ... }` จากนั้นปิด client นั้น

Run หลังปิดประมาณ 2-3 วิ:
```powershell
try { Invoke-RestMethod -Uri http://127.0.0.1:3690/rpc/ping -TimeoutSec 1; "STILL UP" } catch { "DOWN (ok)" }
```
Expected: `DOWN (ok)` ภายใน ~1.5 วิหลังปิด (ดู log บรรทัด "last agent left — shutting down")

- [ ] **Step 3: สถานการณ์ 2 — สอง agent**

เปิด MCP client สองตัวพร้อมกัน ปิดตัวแรก แล้วเช็ค ping ทันที — ต้องยัง **UP** (เพราะตัวที่สองยังอยู่) จากนั้นปิดตัวที่สอง แล้วเช็คอีกครั้ง — ต้อง **DOWN**

Run (หลังปิดตัวแรก):
```powershell
try { Invoke-RestMethod -Uri http://127.0.0.1:3690/rpc/ping -TimeoutSec 1; "UP (ok)" } catch { "DOWN (bad)" }
```
Expected: `UP (ok)`

Run (หลังปิดตัวที่สอง, รอ ~2 วิ):
```powershell
try { Invoke-RestMethod -Uri http://127.0.0.1:3690/rpc/ping -TimeoutSec 1; "STILL UP" } catch { "DOWN (ok)" }
```
Expected: `DOWN (ok)`

- [ ] **Step 4: สถานการณ์ 3 — จำลอง crash (kill ดิบ)**

เปิด MCP client หนึ่งตัว หา PID ของ process `node` ที่รัน `dist/index.js` แล้ว kill แบบไม่ให้ deregister:
```powershell
Stop-Process -Id <PID-ของ-mcp-client> -Force
```
Run (รอ ~8 วิ):
```powershell
try { Invoke-RestMethod -Uri http://127.0.0.1:3690/rpc/ping -TimeoutSec 1; "STILL UP" } catch { "DOWN (ok)" }
```
Expected: `DOWN (ok)` ภายใน ~6-8 วิ (TTL 6s + prune ≤1s + grace 1.5s) — log แสดง prune แล้วตามด้วย "last agent left"

- [ ] **Step 5: ยืนยันการเปิดใหม่ได้ broker ใหม่**

เปิด MCP client อีกครั้ง ยืนยันว่า ping ตอบ และ `version` ตรงกับ `package.json` ปัจจุบัน:
```powershell
(Invoke-RestMethod -Uri http://127.0.0.1:3690/rpc/ping).version
```
Expected: ตรงกับ field `version` ใน `package.json` (ปัจจุบัน 1.0.31) — พิสูจน์ว่าไม่มี broker เก่าค้าง การเปิดครั้งใหม่ได้เวอร์ชันล่าสุด

- [ ] **Step 6: (ทางเลือก) ทดสอบ grace = 0**

ตั้ง `ROBLOX_MCP_IDLE_SHUTDOWN_MS=0` ในการเปิด broker/client แล้วทำซ้ำ Step 2 — broker ควรปิดเกือบทันทีหลังออก ไม่มี grace 1.5 วิ ยืนยันว่า env override ทำงาน
