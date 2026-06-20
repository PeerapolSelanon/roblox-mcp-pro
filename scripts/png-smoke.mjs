// Self-check for the PNG eyedropper: encode a 2x2 RGBA PNG with known colors,
// sample each pixel, assert the decoded color matches. Hermetic, no Studio.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { samplePngColor, samplePngPoints, compareImages } from "../dist/services/png.js";

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

// --- compare (auto-compare for image-to-UI) ---
// Encode a solid/whatever RGB (color type 2) image from a (x,y)->[r,g,b] fn.
function encodeRGB(w, h, fn) {
  const stride = w * 3;
  const rawc = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    rawc[y * (stride + 1)] = 0; // filter None
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const o = y * (stride + 1) + 1 + x * 3;
      rawc[o] = r;
      rawc[o + 1] = g;
      rawc[o + 2] = b;
    }
  }
  const h2 = Buffer.alloc(13);
  h2.writeUInt32BE(w, 0);
  h2.writeUInt32BE(h, 4);
  h2[8] = 8;
  h2[9] = 2; // RGB
  const out = Buffer.concat([
    sig,
    chunk("IHDR", h2),
    chunk("IDAT", deflateSync(rawc)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const f = join(mkdtempSync(join(tmpdir(), "png-cmp-")), "i.png");
  writeFileSync(f, out);
  return f;
}

const black = encodeRGB(20, 20, () => [0, 0, 0]);
const same = compareImages(black, black, { cols: 4, rows: 4 });
assert.ok(same.similarity > 99.5, "identical images ~100% similar");
assert.equal(same.regions[0].diff, 0, "identical → zero diff regions");

// mockup all black, capture white on the right half → right region is worst, brighter.
const halfWhite = encodeRGB(20, 20, (x) => (x >= 10 ? [255, 255, 255] : [0, 0, 0]));
const cmp = compareImages(black, halfWhite, { cols: 4, rows: 2 });
assert.ok(cmp.similarity < 80, "half-different → lower similarity");
assert.ok(cmp.regions[0].xPct > 0.5, "worst region on the changed (right) half");
assert.ok(/brighter/.test(cmp.regions[0].note), "note reports the capture is brighter");

// --- local UI renderer (image-to-UI without Studio) ---
import { renderUiTree } from "../dist/services/uirender.js";
import { decodePng } from "../dist/services/png.js";

const outDir = mkdtempSync(join(tmpdir(), "uirender-"));
const uiOut = join(outDir, "ui.png");
// A centered red 100x60 card on a dark backdrop, in a 200x120 viewport.
const tree = {
  className: "ScreenGui",
  children: [
    {
      className: "Frame",
      properties: {
        Size: [[0, 100], [0, 60]],
        AnchorPoint: [0.5, 0.5],
        Position: [[0.5, 0], [0.5, 0]],
        BackgroundColor3: [1, 0, 0],
      },
    },
  ],
};
const rr = renderUiTree(tree, { outPath: uiOut, width: 200, height: 120, background: [0, 0, 0] });
assert.equal(rr.width, 200, "render width");
const img = decodePng(uiOut);
// Center pixel sits inside the red card; a corner sits on the black backdrop.
const center = ((60 * 200) + 100) * 4;
assert.ok(img.rgba[center] > 200 && img.rgba[center + 1] < 60, "center is the red card");
assert.equal(img.rgba[0], 0, "corner is the black backdrop");
// Render compared to itself is ~identical.
const selfCmp = compareImages(uiOut, uiOut, { cols: 4, rows: 4 });
assert.ok(selfCmp.similarity > 99.5, "render vs itself ~100%");

console.log("png-smoke OK");
