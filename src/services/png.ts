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
import { inflateSync } from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
