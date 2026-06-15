# ดีไซน์: ปิด Broker แบบเรียลไทม์ตามจำนวน Agent + อัปเดตอัตโนมัติ

วันที่: 2026-06-15
สถานะ: รออนุมัติสเปก

## เป้าหมาย (จากผู้ใช้)

1. **เปิดแค่ Claude Code ตัวเดียว** — เวลา exit ต้องปิด broker ทันที ไม่ทิ้งให้ค้าง และถ้ามีเวอร์ชันใหม่ต้องอัปเดตตามอัตโนมัติ
2. **เปิด Claude Code + AI agent ตัวอื่น** — ถ้า agent ตัวอื่น exit broker ต้อง **ยังไม่ปิด** เพราะตัวอื่นยังเชื่อมต่ออยู่ ปิดเฉพาะตอน agent ตัวสุดท้ายออกเท่านั้น และอัปเดตเวอร์ชันใหม่อัตโนมัติเช่นกัน

## แนวคิดหลัก

อายุของ broker = ช่วงเวลาที่ยังมี agent เชื่อมต่ออยู่อย่างน้อย 1 ตัว (reference counting)
อยู่ต่อเมื่อ count ≥ 1 และปิดทันทีเมื่อ count แตะ 0

> ระบบนับจำนวน agent (`agentCount()`) และตรรกะ "ปิดเมื่อไม่มี agent" มีอยู่แล้วใน `src/broker/main.ts`
> งานนี้คือทำให้การปิด **เร็วทันที** และตรวจจับ "การออก" ให้ **แม่นยำ** — ไม่ใช่สร้างใหม่

## สถานะปัจจุบัน (ก่อนแก้)

- `IDLE_SHUTDOWN_MS = 20_000` — broker รอ 20 วิหลัง agent หมด ค่อยปิด (`src/broker/main.ts:39`)
- `AGENT_TTL_MS = 30_000` — ตัด agent ที่ไม่ heartbeat เกิน 30 วิ (`src/broker/registry.ts:61`)
- client heartbeat ทุก 10 วิ (`src/client/transport.ts`)
- `deregister()` ถูกเรียกเฉพาะตอนได้ `SIGINT`/`SIGTERM` (`src/index.ts:119-120`)

### ปัญหาสำคัญ

MCP host (เช่น Claude Code) มักหยุด server ด้วยการ **ปิดท่อ stdio** ไม่ได้ส่งสัญญาณ — โดยเฉพาะบน **Windows** ฉะนั้นตอนนี้ exit จริงมักไม่มี `deregister` เลย → broker รอครบ 20 วินาที → รู้สึกเหมือนค้าง ต้องแก้จุดนี้ถึงจะปิดทันทีได้จริง

## การออกแบบ (4 จุด)

### 1. ตรวจจับการออกให้แม่นยำ — `src/index.ts` + `src/client/transport.ts`

- เรียก `deregister()` เพิ่มเมื่อ MCP transport / `process.stdin` ถูกปิด (ทาง host ใช้หยุดจริง) ไม่ใช่แค่สัญญาณ
- ทำ `shutdown` ให้ idempotent (กันเรียกซ้ำเมื่อทั้ง stdin-close และ signal มาพร้อมกัน)
- เร่ง heartbeat จาก 10 วิ → ~2 วิ เพื่อให้ตรวจจับ crash (ที่ไม่มี deregister) ได้เร็ว

### 2. ตรวจจับ crash เร็ว + event "ว่าง" — `src/broker/registry.ts`

- ลด `AGENT_TTL_MS` 30 วิ → ~6 วิ (heartbeat 2 วิ → agent ตายถูกตัดออกภายใน ≤6 วิ)
- เพิ่ม callback `onEmpty` ยิงเมื่อจำนวน agent ลด 1→0 (จากทั้ง `deregister` และ `prune`)

### 3. ปิดทันที — `src/broker/main.ts`

- เลิกใช้การ poll รอ 20 วิ เปลี่ยนเป็น event-driven:
  - `onEmpty` ยิง → ตั้ง grace timer สั้นๆ (ค่าเริ่มต้น ~1.5 วิ; ปรับผ่าน env `ROBLOX_MCP_IDLE_SHUTDOWN_MS`; ตั้ง 0 ได้)
  - มี agent register ใหม่ → ยกเลิก timer
  - ครบเวลา → `stopAndExit()`
- grace 1.5 วิ มีไว้กันกรณี host รีสตาร์ท server แวบเดียว (count แตะ 0 ชั่วครู่)
- ผลลัพธ์: ออกสะอาด → ปิดใน ~1.5 วิ; crash → ปิดใน ~6–8 วิ
- การ "มีชีวิต" ยังดูจาก **agent เท่านั้น** — Studio plugin อย่างเดียวไม่ทำให้ broker ค้าง (เหมือนเดิม)

### 4. อัปเดตอัตโนมัติ — ส่วนใหญ่แค่ตรวจสอบ (มีอยู่แล้ว)

- **ไม่มี broker เก่าค้าง:** การปิดทันที (ข้อ 3) ปิดจุดนี้ + กลไกเดิม (client ใหม่ไล่ broker เก่าผ่าน `/rpc/shutdown` เมื่อ `brokerIsOlder`) ยังอยู่
- **Plugin + skills ใหม่เสมอ:** ติดตั้งอัตโนมัติตอน startup อยู่แล้ว (`src/install-plugin.ts`, `src/install-skills.ts`) — ตรวจสอบ คาดว่าไม่แก้โค้ด
- **npm `@latest`:** เป็นคำสั่งเปิดที่แนะนำอยู่แล้ว (`npx -y roblox-mcp-pro@latest`) — เขียนข้อควรระวังว่า คนที่ปักหมุดเวอร์ชันใน config เองจะไม่อัปเดตอัตโนมัติ (เลือกเอง)

## ตอบโจทย์ 2 สถานการณ์

- **กรณี 1 (Claude Code ตัวเดียว):** ออก → ปิดท่อ → `deregister` → count 0 → broker ปิดใน ~1.5 วิ คืน port → ครั้งหน้าเปิดดึง `@latest` สร้าง broker ใหม่ ✅
- **กรณี 2 (หลาย agent):** ตัวหนึ่งออก count เหลือ ≥1 → broker อยู่ต่อ; ปิดเฉพาะตอนตัวสุดท้ายออก ✅

## Edge cases / การจัดการข้อผิดพลาด

- รีสตาร์ทแวบเดียว → grace timer ดูดซับ ไม่ปิด-เปิดรัว
- หลาย agent → ปิดเฉพาะตอน count = 0 จริง
- plugin ยังต่อแต่ไม่มี agent → ยังปิด (ตามเจตนาเดิม)
- Windows → ไม่พึ่งสัญญาณ POSIX สำหรับการออกสะอาด (ใช้ stdin-close แทน)
- race ตอน upgrade (client เก่าออก ~ พร้อม client ใหม่เปิด) → `ensureBroker` เดิมจัดการ "down" ด้วยการ spawn ใหม่อยู่แล้ว

## การทดสอบ (manual e2e + ดู log `%TEMP%\roblox-mcp-pro-broker.log`)

1. agent ตัวเดียว: เชื่อม → ออก → broker ปิดในเวลาเผื่อ, `/rpc/ping` ล้มเหลว
2. สอง agent: ออกตัวหนึ่ง → broker อยู่ต่อ; ออกทั้งคู่ → broker ปิด
3. จำลอง crash: `kill -9` agent → broker ปิดภายใน ~TTL+เผื่อ
4. ยืนยันครั้งหน้าเปิดใหม่ broker เป็นเวอร์ชันปัจจุบัน

## ขอบเขตที่ไม่ทำ (YAGNI)

- ไม่ทำ self-update ที่รัน `npm i -g` เองในเบื้องหลัง (เสี่ยง/ก้าวก่าย) — พึ่ง `@latest` ตอนเปิดแทน
- ไม่ผูกอายุ broker กับ Studio plugin
- ไม่ refactor นอกเหนือจาก lifecycle
