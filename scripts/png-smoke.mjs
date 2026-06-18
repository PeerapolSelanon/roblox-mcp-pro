// Self-check for the PNG eyedropper: encode a 2x2 RGBA PNG with known colors,
// sample each pixel, assert the decoded color matches. Hermetic, no Studio.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { samplePngColor, samplePngPoints } from "../dist/services/png.js";

// CRC32 for PNG chunks.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// 2x2 image, RGBA (color type 6), filter byte 0 per row.
const px = [
  [255, 0, 0, 255], [0, 255, 0, 255], // row 0: red, green
  [0, 0, 255, 255], [10, 20, 30, 128], // row 1: blue, dark+alpha
];
const stride = 2 * 4;
const raw = Buffer.alloc(2 * (stride + 1));
// Row 0: filter None (raw bytes). Row 1: filter Up (2) — store (pixel - above)
// so the decoder must reconstruct it, exercising the unfilter path, not just None.
raw[0] = 0;
for (let x = 0; x < 2; x++) raw.set(px[x], 1 + x * 4);
raw[stride + 1] = 2; // row 1 filter = Up
for (let x = 0; x < 2; x++) {
  for (let c = 0; c < 4; c++) {
    const above = px[x][c];
    raw[(stride + 1) + 1 + x * 4 + c] = (px[2 + x][c] - above) & 0xff;
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(2, 0); // width
ihdr.writeUInt32BE(2, 4); // height
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = Buffer.concat([
  sig,
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

const file = join(mkdtempSync(join(tmpdir(), "png-smoke-")), "t.png");
writeFileSync(file, png);

assert.deepEqual(samplePngColor(file, { x: 0, y: 0 }).rgb255, [255, 0, 0], "px(0,0) red");
assert.deepEqual(samplePngColor(file, { x: 1, y: 0 }).rgb255, [0, 255, 0], "px(1,0) green");
assert.deepEqual(samplePngColor(file, { x: 0, y: 1 }).rgb255, [0, 0, 255], "px(0,1) blue");
const last = samplePngColor(file, { x: 1, y: 1 });
assert.deepEqual(last.rgb255, [10, 20, 30], "px(1,1) color");
assert.equal(last.a, 128, "px(1,1) alpha");
assert.equal(last.hex, "#0a141e", "px(1,1) hex");
// Fraction coords resolve against size (1 = last index).
assert.deepEqual(samplePngColor(file, { xPct: 1, yPct: 1 }).rgb255, [10, 20, 30], "frac → last px");

// Box average over the whole 2x2: mean of the four pixels.
// r=(255+0+0+10)/4=66.25→66  g=(0+255+0+20)/4=68.75→69  b=(0+0+255+30)/4=71.25→71
assert.deepEqual(samplePngColor(file, { x: 0, y: 0, w: 2, h: 2 }).rgb255, [66, 69, 71], "2x2 box avg");

// Batch: decode once, sample many.
const batch = samplePngPoints(file, [
  { x: 0, y: 0, label: "red" },
  { x: 1, y: 0, label: "green" },
]);
assert.equal(batch.length, 2, "batch length");
assert.equal(batch[0].label, "red", "batch label preserved");
assert.deepEqual(batch[1].rgb255, [0, 255, 0], "batch px(1,0) green");

console.log("png-smoke OK");
