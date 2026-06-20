/**
 * Minimal PNG eyedropper for UI-from-image work.
 *
 * Decodes a PNG with the stdlib `zlib` (no image dependency) into an RGBA buffer,
 * then samples exact pixel colors — a single point, an averaged box (robust
 * against noise/stars/edges), or many points in one call. Supports the formats
 * real UI mockups ship as: 8-bit depth, non-interlaced, color types 0/2/3/4/6.
 * 16-bit, sub-8-bit, and Adam7-interlaced PNGs are rejected with a clear message.
 *
 * ponytail: full-image decode (a 1600x1000 image is ~6MB RGBA — fine). Box
 *           average kills single-pixel noise; batch decodes once for N points.
 *           Skipped edge/bbox detection — the build→capture→compare loop already
 *           converges layout; add it only if that loop proves insufficient.
 */

import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode an opaque RGB buffer (3 bytes/px, row-major) to a PNG Buffer. */
export function encodePng(rgb: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    for (let i = 0; i < stride; i++) raw[y * (stride + 1) + 1 + i] = rgb[y * stride + i] ?? 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  return Buffer.concat([
    SIG,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export interface DecodedPng {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  rgba: Uint8Array;
}

export interface SampledColor {
  /** Color3 form, 0-1 per channel. */
  rgb: [number, number, number];
  /** 0-255 per channel. */
  rgb255: [number, number, number];
  /** Alpha 0-255 (255 if the image has no alpha). */
  a: number;
  hex: string;
  x: number;
  y: number;
  /** Box size averaged over (1x1 = single pixel). */
  w: number;
  h: number;
  width: number;
  height: number;
  label?: string;
}

export interface Coord {
  x?: number;
  y?: number;
  xPct?: number;
  yPct?: number;
  /** Box width/height to average over (default 1 = single pixel). */
  w?: number;
  h?: number;
  label?: string;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode a PNG file to an RGBA buffer. Throws with a clear message on unsupported formats. */
export function decodePng(path: string): DecodedPng {
  const buf = readFileSync(path);
  if (!buf.subarray(0, 8).equals(SIG)) {
    throw new Error("Not a PNG (bad signature). Eyedropper supports PNG only.");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];

  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len; // length(4) + type(4) + data(len) + crc(4)
  }

  if (bitDepth !== 8) throw new Error(`Unsupported PNG: bit depth ${bitDepth} (need 8-bit).`);
  if (interlace !== 0)
    throw new Error("Unsupported PNG: interlaced (Adam7). Re-export non-interlaced.");
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}.`);

  const bpp = channels; // bytes per pixel at 8-bit
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));

  // Unfilter every scanline in place into `raw`'s logical rows.
  const lines = Buffer.alloc(height * stride);
  let inPos = 0;
  for (let row = 0; row < height; row++) {
    const filter = raw[inPos++] ?? 0;
    const cur = row * stride;
    const up = (row - 1) * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[inPos + i] ?? 0;
      const a = i >= bpp ? (lines[cur + i - bpp] ?? 0) : 0; // left
      const b = row > 0 ? (lines[up + i] ?? 0) : 0; // up
      const c = i >= bpp && row > 0 ? (lines[up + i - bpp] ?? 0) : 0; // up-left
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error(`Bad PNG filter byte ${filter} on row ${row}.`);
      }
      lines[cur + i] = v & 0xff;
    }
    inPos += stride;
  }

  // Expand to RGBA.
  const rgba = new Uint8Array(width * height * 4);
  const px = (i: number): number => lines[i] ?? 0;
  for (let p = 0; p < width * height; p++) {
    const s = p * bpp;
    const d = p * 4;
    let r: number;
    let g: number;
    let b: number;
    let al = 255;
    switch (colorType) {
      case 0: r = g = b = px(s); break;
      case 4: r = g = b = px(s); al = px(s + 1); break;
      case 2: r = px(s); g = px(s + 1); b = px(s + 2); break;
      case 6: r = px(s); g = px(s + 1); b = px(s + 2); al = px(s + 3); break;
      case 3: {
        if (!palette) throw new Error("Palette PNG missing PLTE chunk.");
        const idx = px(s) * 3;
        r = palette[idx] ?? 0;
        g = palette[idx + 1] ?? 0;
        b = palette[idx + 2] ?? 0;
        break;
      }
      default: throw new Error(`Unsupported PNG color type ${colorType}.`);
    }
    rgba[d] = r;
    rgba[d + 1] = g;
    rgba[d + 2] = b;
    rgba[d + 3] = al;
  }

  return { width, height, rgba };
}

/** Sample one point or an averaged box from an already-decoded image. */
export function sampleDecoded(img: DecodedPng, coord: Coord): SampledColor {
  const { width, height, rgba } = img;
  const cx = coord.x ?? Math.round((coord.xPct ?? 0) * (width - 1));
  const cy = coord.y ?? Math.round((coord.yPct ?? 0) * (height - 1));
  const w = Math.max(1, coord.w ?? 1);
  const h = Math.max(1, coord.h ?? 1);
  if (cx < 0 || cx >= width || cy < 0 || cy >= height) {
    throw new Error(`Coordinate (${cx},${cy}) out of bounds for ${width}x${height} image.`);
  }

  // Average over the box centered-ish on (cx,cy), clamped to image bounds.
  const x0 = Math.max(0, cx - ((w - 1) >> 1));
  const y0 = Math.max(0, cy - ((h - 1) >> 1));
  const x1 = Math.min(width - 1, x0 + w - 1);
  const y1 = Math.min(height - 1, y0 + h - 1);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sa = 0;
  let n = 0;
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const d = (yy * width + xx) * 4;
      sr += rgba[d] ?? 0;
      sg += rgba[d + 1] ?? 0;
      sb += rgba[d + 2] ?? 0;
      sa += rgba[d + 3] ?? 0;
      n++;
    }
  }
  const r = Math.round(sr / n);
  const g = Math.round(sg / n);
  const b = Math.round(sb / n);
  const a = Math.round(sa / n);
  const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  return {
    rgb: [r / 255, g / 255, b / 255],
    rgb255: [r, g, b],
    a,
    hex,
    x: cx,
    y: cy,
    w,
    h,
    width,
    height,
    ...(coord.label ? { label: coord.label } : {}),
  };
}

/** Sample a single point/box from a PNG file. */
export function samplePngColor(path: string, coord: Coord): SampledColor {
  return sampleDecoded(decodePng(path), coord);
}

/** Sample many points/boxes from a PNG file, decoding it once. */
export function samplePngPoints(path: string, coords: Coord[]): SampledColor[] {
  const img = decodePng(path);
  return coords.map((c) => sampleDecoded(img, c));
}

/** Average an image down to a gw×gh grid of mean RGB (0-255), in one pass. */
export function downscaleAvg(img: DecodedPng, gw: number, gh: number): Float64Array {
  const { width, height, rgba } = img;
  const acc = new Float64Array(gw * gh * 3);
  const cnt = new Float64Array(gw * gh);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(gh - 1, Math.floor((y * gh) / height));
    for (let x = 0; x < width; x++) {
      const gx = Math.min(gw - 1, Math.floor((x * gw) / width));
      const k = (gy * gw + gx) * 3;
      const d = (y * width + x) * 4;
      acc[k] = (acc[k] ?? 0) + (rgba[d] ?? 0);
      acc[k + 1] = (acc[k + 1] ?? 0) + (rgba[d + 1] ?? 0);
      acc[k + 2] = (acc[k + 2] ?? 0) + (rgba[d + 2] ?? 0);
      cnt[gy * gw + gx] = (cnt[gy * gw + gx] ?? 0) + 1;
    }
  }
  for (let c = 0; c < gw * gh; c++) {
    const n = cnt[c] || 1;
    acc[c * 3] = (acc[c * 3] ?? 0) / n;
    acc[c * 3 + 1] = (acc[c * 3 + 1] ?? 0) / n;
    acc[c * 3 + 2] = (acc[c * 3 + 2] ?? 0) / n;
  }
  return acc;
}

export interface CompareRegion {
  col: number;
  row: number;
  /** Cell-center position as fractions 0-1 (feed back as xPct/yPct). */
  xPct: number;
  yPct: number;
  /** 0-100, higher = more different. */
  diff: number;
  /** How the capture differs from the mockup in this cell. */
  note: string;
}

export interface CompareResult {
  /** 0-100, 100 = identical. */
  similarity: number;
  meanDiff: number;
  grid: { cols: number; rows: number };
  mockup: { width: number; height: number };
  capture: { width: number; height: number };
  /** Worst-matching regions first. */
  regions: CompareRegion[];
}

const MAX_DIST = Math.sqrt(3) * 255;

/** Describe how the capture cell differs from the mockup cell (signed = capture - mockup). */
function regionNote(dr: number, dg: number, db: number): string {
  const parts: string[] = [];
  const bright = (dr + dg + db) / 3;
  if (Math.abs(bright) > 8) parts.push(bright < 0 ? "darker" : "brighter");
  const chans: Array<[number, string]> = [
    [dr, "red"],
    [dg, "green"],
    [db, "blue"],
  ];
  chans.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]));
  const [dv, name] = chans[0] ?? [0, "red"];
  if (Math.abs(dv) > 14) parts.push(`${dv < 0 ? "less" : "more"} ${name}`);
  return parts.join(", ") || "slightly off";
}

/**
 * Compare a built-UI capture against a reference mockup. Both are averaged to a
 * common grid (so different sizes/aspect still line up coarsely), then scored —
 * an overall similarity plus the worst-matching regions and a hint at what's
 * wrong. Turns the build→capture→compare→refine loop from eyeballing into a
 * measured one. ponytail: RGB box-average + Euclidean distance, no SSIM/dep;
 * good enough to point the agent at the off regions. Reuses decodePng (8-bit
 * non-interlaced PNG only — same limits as the eyedropper).
 */
export function compareImages(
  mockupPath: string,
  capturePath: string,
  opts: { cols?: number; rows?: number; top?: number } = {},
): CompareResult {
  const m = decodePng(mockupPath);
  const c = decodePng(capturePath);
  const cols = Math.max(2, Math.min(24, opts.cols ?? 8));
  const rows = Math.max(2, Math.min(24, opts.rows ?? 6));
  const top = Math.max(1, Math.min(cols * rows, opts.top ?? 6));
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const at = (a: Float64Array, i: number) => a[i] ?? 0;

  // Fine grid → headline score; coarse grid → actionable regions. Cap the fine
  // grid to the smaller image's dimensions so we never create empty cells (which
  // would read as a false match) when comparing tiny images.
  const fw = Math.max(2, Math.min(48, m.width, c.width));
  const fh = Math.max(2, Math.min(48, m.height, c.height));
  const mf = downscaleAvg(m, fw, fh);
  const cf = downscaleAvg(c, fw, fh);
  let sum = 0;
  for (let i = 0; i < fw * fh; i++) {
    const dr = at(cf, i * 3) - at(mf, i * 3);
    const dg = at(cf, i * 3 + 1) - at(mf, i * 3 + 1);
    const db = at(cf, i * 3 + 2) - at(mf, i * 3 + 2);
    sum += Math.sqrt(dr * dr + dg * dg + db * db);
  }
  const meanDiff = (sum / (fw * fh) / MAX_DIST) * 100;

  const mc = downscaleAvg(m, cols, rows);
  const cc = downscaleAvg(c, cols, rows);
  const regions: CompareRegion[] = [];
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const i = gy * cols + gx;
      const dr = at(cc, i * 3) - at(mc, i * 3);
      const dg = at(cc, i * 3 + 1) - at(mc, i * 3 + 1);
      const db = at(cc, i * 3 + 2) - at(mc, i * 3 + 2);
      regions.push({
        col: gx,
        row: gy,
        xPct: Math.round(((gx + 0.5) / cols) * 1000) / 1000,
        yPct: Math.round(((gy + 0.5) / rows) * 1000) / 1000,
        diff: round1((Math.sqrt(dr * dr + dg * dg + db * db) / MAX_DIST) * 100),
        note: regionNote(dr, dg, db),
      });
    }
  }
  regions.sort((a, b) => b.diff - a.diff);
  return {
    similarity: round1(Math.max(0, 100 - meanDiff)),
    meanDiff: round1(meanDiff),
    grid: { cols, rows },
    mockup: { width: m.width, height: m.height },
    capture: { width: c.width, height: c.height },
    regions: regions.slice(0, top),
  };
}
