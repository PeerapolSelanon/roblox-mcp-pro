/**
 * Local renderer for a manage_ui tree — no Studio, no dependency.
 *
 * Computes Roblox's own layout (UDim2 size/position, AnchorPoint, UIListLayout,
 * UIPadding) in JS, then rasterizes to an RGB buffer: solid fills, UICorner
 * rounding, UIStroke borders, vertical UIGradient, and text drawn as a tinted
 * coverage bar. This is NOT an HTML transpile — what we draw is exactly the tree
 * Studio will build, so the local preview has no translation loss. It's an
 * approximation of the *paint* (text is a bar, not glyphs), tuned so the coarse
 * box-average in compareImages lines up with a real capture/mockup.
 *
 * ponytail: text-as-coverage-bar (no font dep) — average color of a text cell is
 *           bg*(1-cov)+ink*cov, which is what the compare grid measures anyway.
 *           Glyph-accurate text needs a font rasterizer; add only if compare
 *           proves it necessary. ZIndex ignored (tree order); ColorSequence
 *           gradients beyond 2-stop and ImageLabel art are placeholders.
 */

import { writeFileSync } from "node:fs";
import { encodePng } from "./png.js";

interface UINode {
  className: string;
  name?: string;
  properties?: Record<string, unknown>;
  children?: UINode[];
}

type RGB = [number, number, number];
type Rect = { x: number; y: number; w: number; h: number };

const num = (v: unknown, def = 0): number => (typeof v === "number" ? v : def);

/** Color3 [r,g,b] 0-1 → 0-255 triple. */
function color(v: unknown, def: RGB): RGB {
  if (Array.isArray(v) && v.length >= 3) {
    return [
      Math.round(num(v[0]) * 255),
      Math.round(num(v[1]) * 255),
      Math.round(num(v[2]) * 255),
    ];
  }
  return def;
}

/** UDim2 [[xs,xo],[ys,yo]] → absolute {w,h} against a parent size. */
function udim2Size(v: unknown, pw: number, ph: number): { w: number; h: number } {
  if (Array.isArray(v) && v.length === 2) {
    const xs = v[0] as [number, number];
    const ys = v[1] as [number, number];
    return { w: num(xs?.[0]) * pw + num(xs?.[1]), h: num(ys?.[0]) * ph + num(ys?.[1]) };
  }
  return { w: 0, h: 0 };
}

/** UDim2 → absolute offset {x,y} against a parent size (Position). */
function udim2Pos(v: unknown, pw: number, ph: number): { x: number; y: number } {
  const s = udim2Size(v, pw, ph);
  return { x: s.w, y: s.h };
}

/** UDim [scale,offset] → px against a reference length. */
function udim(v: unknown, ref: number): number {
  if (Array.isArray(v) && v.length === 2) return num(v[0]) * ref + num(v[1]);
  return 0;
}

const findChild = (node: UINode, cls: string): UINode | undefined =>
  node.children?.find((c) => c.className === cls);

interface DrawCmd {
  rect: Rect;
  fill?: RGB;
  corner: number;
  stroke?: { color: RGB; thickness: number };
  gradient?: [RGB, RGB]; // top → bottom
  text?: { ink: RGB; size: number; len: number; alignX: string };
}

/** Walk the tree, resolving each node to an absolute draw command. */
function layout(node: UINode, parent: Rect, out: DrawCmd[]): void {
  // UIPadding insets the content area children lay out within.
  const pad = findChild(node, "UIPadding");
  let content = parent;
  if (pad) {
    const pp = pad.properties ?? {};
    const l = udim(pp.PaddingLeft, parent.w);
    const r = udim(pp.PaddingRight, parent.w);
    const t = udim(pp.PaddingTop, parent.h);
    const b = udim(pp.PaddingBottom, parent.h);
    content = { x: parent.x + l, y: parent.y + t, w: parent.w - l - r, h: parent.h - t - b };
  }

  const realChildren = (node.children ?? []).filter(
    (c) => !["UICorner", "UIStroke", "UIGradient", "UIPadding", "UIListLayout", "UIGridLayout"].includes(c.className),
  );
  const list = findChild(node, "UIListLayout");

  if (!list) {
    for (const child of realChildren) layoutPositioned(child, content, out);
    return;
  }

  // UIListLayout: stack children along FillDirection, ignoring their Position.
  const lp = list.properties ?? {};
  const vertical = (lp.FillDirection ?? "Vertical") !== "Horizontal";
  const gap = udim(lp.Padding, vertical ? content.h : content.w);
  const halign = String(lp.HorizontalAlignment ?? "Left");
  const valign = String(lp.VerticalAlignment ?? "Top");
  const ordered = realChildren
    .map((c, i) => ({ c, i, order: num(c.properties?.LayoutOrder) }))
    .sort((a, b) => a.order - b.order || a.i - b.i)
    .map((e) => e.c);

  // First measure sizes, then place from a cursor (with alignment for the cross axis).
  const sized = ordered.map((c) => ({ c, size: udim2Size(c.properties?.Size, content.w, content.h) }));
  const total =
    sized.reduce((s, e) => s + (vertical ? e.size.h : e.size.w), 0) + gap * Math.max(0, sized.length - 1);
  let cursor = vertical
    ? content.y + (valign === "Center" ? (content.h - total) / 2 : valign === "Bottom" ? content.h - total : 0)
    : content.x + (halign === "Center" ? (content.w - total) / 2 : halign === "Right" ? content.w - total : 0);

  for (const { c, size } of sized) {
    let rect: Rect;
    if (vertical) {
      const cx =
        content.x + (halign === "Center" ? (content.w - size.w) / 2 : halign === "Right" ? content.w - size.w : 0);
      rect = { x: cx, y: cursor, w: size.w, h: size.h };
      cursor += size.h + gap;
    } else {
      const cy =
        content.y + (valign === "Center" ? (content.h - size.h) / 2 : valign === "Bottom" ? content.h - size.h : 0);
      rect = { x: cursor, y: cy, w: size.w, h: size.h };
      cursor += size.w + gap;
    }
    emit(c, rect, out);
    layout(c, rect, out);
  }
}

/** Place a child by its own Size/Position/AnchorPoint, then recurse. */
function layoutPositioned(node: UINode, parent: Rect, out: DrawCmd[]): void {
  const p = node.properties ?? {};
  const size = udim2Size(p.Size, parent.w, parent.h);
  const pos = udim2Pos(p.Position, parent.w, parent.h);
  const anchor = Array.isArray(p.AnchorPoint) ? p.AnchorPoint : [0, 0];
  const rect: Rect = {
    x: parent.x + pos.x - num(anchor[0]) * size.w,
    y: parent.y + pos.y - num(anchor[1]) * size.h,
    w: size.w,
    h: size.h,
  };
  emit(node, rect, out);
  layout(node, rect, out);
}

/** Turn a node + its resolved rect into a draw command (no children). */
function emit(node: UINode, rect: Rect, out: DrawCmd[]): void {
  const p = node.properties ?? {};
  const isText = node.className === "TextLabel" || node.className === "TextButton";
  // Roblox default GUI bg is a light grey; text labels usually transparent.
  const fillDefault: RGB = [163, 162, 165];
  const cmd: DrawCmd = { rect, corner: 0 };
  if (!(num(p.BackgroundTransparency) >= 1)) cmd.fill = color(p.BackgroundColor3, fillDefault);

  const corner = findChild(node, "UICorner");
  if (corner) {
    const r = udim(corner.properties?.CornerRadius, Math.min(rect.w, rect.h));
    cmd.corner = Math.max(0, Math.min(r, Math.min(rect.w, rect.h) / 2));
  }
  const stroke = node.children?.find(
    (c) => c.className === "UIStroke" && (c.properties?.ApplyStrokeMode ?? "Contextual") === "Border",
  );
  if (stroke) {
    cmd.stroke = {
      color: color(stroke.properties?.Color, [0, 0, 0]),
      thickness: Math.max(1, num(stroke.properties?.Thickness, 1)),
    };
  }
  const grad = findChild(node, "UIGradient");
  if (grad && cmd.fill) {
    // ponytail: only the simple case — a vertical light→dark of the base fill.
    // A real ColorSequence isn't reliably JSON-coercible (set via execute_luau),
    // so approximate with the fill so the region still reads the right hue.
    cmd.gradient = [cmd.fill, cmd.fill];
  }
  if (isText && typeof p.Text === "string" && p.Text.length > 0) {
    cmd.text = {
      ink: color(p.TextColor3, [255, 255, 255]),
      size: num(p.TextSize, 14),
      len: p.Text.length,
      alignX: String(p.TextXAlignment ?? "Center"),
    };
  }
  out.push(cmd);
}

function blend(buf: Uint8Array, idx: number, c: RGB, a: number): void {
  const ia = 1 - a;
  buf[idx] = Math.round((buf[idx] ?? 0) * ia + c[0] * a);
  buf[idx + 1] = Math.round((buf[idx + 1] ?? 0) * ia + c[1] * a);
  buf[idx + 2] = Math.round((buf[idx + 2] ?? 0) * ia + c[2] * a);
}

/** Rounded-rect membership test for pixel (px,py) in rect with radius r. */
function inRounded(px: number, py: number, r: Rect, rad: number): boolean {
  if (px < r.x || px >= r.x + r.w || py < r.y || py >= r.y + r.h) return false;
  if (rad <= 0) return true;
  const cx = px < r.x + rad ? r.x + rad : px > r.x + r.w - rad ? r.x + r.w - rad : px;
  const cy = py < r.y + rad ? r.y + rad : py > r.y + r.h - rad ? r.y + r.h - rad : py;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= rad * rad;
}

function paint(cmds: DrawCmd[], W: number, H: number, bg: RGB): Uint8Array {
  const buf = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    buf[i * 3] = bg[0];
    buf[i * 3 + 1] = bg[1];
    buf[i * 3 + 2] = bg[2];
  }
  for (const c of cmds) {
    const r = c.rect;
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(W, Math.ceil(r.x + r.w));
    const y1 = Math.min(H, Math.ceil(r.y + r.h));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!inRounded(x, y, r, c.corner)) continue;
        const idx = (y * W + x) * 3;
        if (c.fill) {
          let fill = c.fill;
          if (c.gradient) {
            const t = r.h > 0 ? (y - r.y) / r.h : 0;
            fill = [
              Math.round(c.gradient[0][0] * (1 - t) + c.gradient[1][0] * t),
              Math.round(c.gradient[0][1] * (1 - t) + c.gradient[1][1] * t),
              Math.round(c.gradient[0][2] * (1 - t) + c.gradient[1][2] * t),
            ];
          }
          blend(buf, idx, fill, 1);
        }
        if (c.stroke) {
          const t = c.stroke.thickness;
          const edge =
            x < r.x + t || x >= r.x + r.w - t || y < r.y + t || y >= r.y + r.h - t;
          if (edge) blend(buf, idx, c.stroke.color, 1);
        }
      }
    }
    // Text bar: a tinted coverage rect sized to the glyph run, aligned in the rect.
    if (c.text) {
      const th = Math.min(r.h, c.text.size);
      const tw = Math.min(r.w, c.text.len * c.text.size * 0.5);
      const tx =
        c.text.alignX === "Left" ? r.x + 4 : c.text.alignX === "Right" ? r.x + r.w - tw - 4 : r.x + (r.w - tw) / 2;
      const ty = r.y + (r.h - th) / 2;
      const bx0 = Math.max(0, Math.floor(tx));
      const by0 = Math.max(0, Math.floor(ty));
      const bx1 = Math.min(W, Math.ceil(tx + tw));
      const by1 = Math.min(H, Math.ceil(ty + th));
      for (let y = by0; y < by1; y++) {
        for (let x = bx0; x < bx1; x++) {
          blend(buf, (y * W + x) * 3, c.text.ink, 0.45); // ~glyph coverage of the bbox
        }
      }
    }
  }
  return buf;
}

export interface RenderResult {
  path: string;
  width: number;
  height: number;
}

/**
 * Render a manage_ui tree to a PNG on disk. The root's own Size is ignored — it
 * fills the given viewport (like a ScreenGui), so a mockup-sized viewport lines
 * the preview up with the reference for compareImages.
 */
export function renderUiTree(
  tree: UINode,
  opts: { outPath: string; width?: number; height?: number; background?: RGB },
): RenderResult {
  const W = Math.max(1, Math.round(opts.width ?? 1280));
  const H = Math.max(1, Math.round(opts.height ?? 720));
  const bg = opts.background ?? [26, 26, 28];
  const root: Rect = { x: 0, y: 0, w: W, h: H };
  const cmds: DrawCmd[] = [];
  // The root container lays its children out directly in the viewport.
  layout(tree, root, cmds);
  const rgb = paint(cmds, W, H, bg);
  writeFileSync(opts.outPath, encodePng(rgb, W, H));
  return { path: opts.outPath, width: W, height: H };
}
