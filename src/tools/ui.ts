/**
 * manage_ui — build and edit GUI hierarchies.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callStudio, describeError } from "../services/studio.js";
import { ok, fail } from "../services/format.js";
import { InstancePath } from "../schemas/common.js";
import { samplePngColor, samplePngPoints, compareImages, type Coord } from "../services/png.js";
import { renderUiTree } from "../services/uirender.js";

interface UINodeShape {
  className: string;
  name?: string;
  properties?: Record<string, unknown>;
  children?: UINodeShape[];
}

const UINode: z.ZodType<UINodeShape> = z.lazy(() =>
  z
    .object({
      className: z.string().min(1).describe("GUI ClassName, e.g. 'ScreenGui', 'Frame', 'TextLabel'."),
      name: z.string().max(200).optional().describe("Instance name."),
      properties: z
        .record(z.unknown())
        .optional()
        .describe(
          "Property map. UDim2 as [[xScale,xOffset],[yScale,yOffset]], Color3 as [r,g,b] (0-1).",
        ),
      children: z.array(UINode).optional().describe("Nested child nodes."),
    })
    .strict(),
);

const InputSchema = z
  .object({
    action: z
      .enum(["create", "set", "delete", "sample_color", "compare", "render_local"])
      .describe(
        "create: build a tree · set: apply properties to a path · delete: destroy a path · " +
          "sample_color: read the exact pixel color from a reference PNG on disk (eyedropper) · " +
          "compare: score a built-UI capture against a reference mockup (similarity + worst regions) · " +
          "render_local: rasterize a 'tree' to a PNG on disk WITHOUT Studio (fast preview; pair with compare).",
      ),
    parent: InstancePath.optional().describe("Parent for 'create' (default 'StarterGui')."),
    tree: UINode.optional().describe("UI tree spec for 'create'."),
    replace: z
      .boolean()
      .default(false)
      .describe("For 'create': if a child with the same name exists under parent, delete it first (clean rebuild while iterating)."),
    path: InstancePath.optional().describe("Target instance for 'set'/'delete'."),
    properties: z.record(z.unknown()).optional().describe("Properties for 'set'."),
    imagePath: z
      .string()
      .optional()
      .describe("For 'sample_color': filesystem path to a PNG reference image (8-bit, non-interlaced)."),
    x: z.number().int().optional().describe("For 'sample_color': pixel X (0-based). Use x/y OR xPct/yPct."),
    y: z.number().int().optional().describe("For 'sample_color': pixel Y (0-based)."),
    xPct: z.number().min(0).max(1).optional().describe("For 'sample_color': X as a fraction 0-1 of width."),
    yPct: z.number().min(0).max(1).optional().describe("For 'sample_color': Y as a fraction 0-1 of height."),
    w: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("For 'sample_color': average over a w×h box (default 1). Use ~5-15 to avoid single-pixel noise from stars/edges."),
    h: z.number().int().min(1).optional().describe("For 'sample_color': box height (default = w, else 1)."),
    points: z
      .array(
        z.object({
          x: z.number().int().optional(),
          y: z.number().int().optional(),
          xPct: z.number().min(0).max(1).optional(),
          yPct: z.number().min(0).max(1).optional(),
          w: z.number().int().min(1).optional(),
          h: z.number().int().min(1).optional(),
          label: z.string().optional(),
        }),
      )
      .optional()
      .describe("For 'sample_color': sample many points/boxes in one call (decodes the image once). Each: {x,y|xPct,yPct, w?, h?, label?}."),
    mockupPath: z
      .string()
      .optional()
      .describe("For 'compare': filesystem path to the reference mockup PNG (the target)."),
    capturePath: z
      .string()
      .optional()
      .describe("For 'compare': filesystem path to the built-UI capture PNG (save one with capture_studio savePath:...)."),
    cols: z.number().int().min(2).max(24).optional().describe("For 'compare': region grid columns (default 8)."),
    rows: z.number().int().min(2).max(24).optional().describe("For 'compare': region grid rows (default 6)."),
    top: z.number().int().min(1).max(50).optional().describe("For 'compare': how many worst regions to return (default 6)."),
    mockupRegion: z
      .array(z.number().min(0).max(1))
      .length(4)
      .optional()
      .describe("For 'compare': crop the mockup to [xPct,yPct,wPct,hPct] (0-1) before scoring."),
    captureRegion: z
      .array(z.number().min(0).max(1))
      .length(4)
      .optional()
      .describe("For 'compare': crop the capture to [xPct,yPct,wPct,hPct] (0-1) — e.g. the panel inside a full-window screenshot."),
    outPath: z
      .string()
      .optional()
      .describe("For 'render_local': filesystem path to write the rendered PNG."),
    width: z.number().int().min(1).max(8000).optional().describe("For 'render_local': viewport width px (default 1280; match the mockup)."),
    height: z.number().int().min(1).max(8000).optional().describe("For 'render_local': viewport height px (default 720; match the mockup)."),
    background: z
      .array(z.number())
      .length(3)
      .optional()
      .describe("For 'render_local': backdrop color [r,g,b] 0-1 (default dark grey)."),
  })
  .strict();

const PreviewSchema = z
  .object({
    action: z
      .enum(["show", "hide"])
      .default("show")
      .describe("show: render the GUI full-screen on a solid backdrop · hide: remove the preview."),
    path: InstancePath.optional().describe("GUI to preview (ScreenGui/Frame/...). Required for 'show'."),
    background: z
      .array(z.number())
      .length(3)
      .optional()
      .describe("Backdrop color [r,g,b] 0-1 (default dark grey)."),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

export function registerUITools(server: McpServer): void {
  server.registerTool(
    "manage_ui",
    {
      title: "Manage GUI / UI",
      description: `Build and edit Roblox GUI hierarchies (ScreenGui, Frame, TextLabel, buttons, …).

Args:
  - action ('create'|'set'|'delete'|'sample_color'|'compare').
  - parent (string): for 'create' (default 'StarterGui').
  - tree (object): for 'create' — { className, name?, properties?, children? } (recursive).
  - path (string): for 'set'/'delete'.
  - properties (object): for 'set'.
  - sample_color: imagePath + (x,y | xPct,yPct), optional w/h box or points[]; reads a PNG eyedropper.
  - compare: mockupPath + capturePath (PNGs on disk) -> similarity % + worst regions to fix.
  Property hints: Size/Position as UDim2 [[xS,xO],[yS,yO]]; BackgroundColor3/TextColor3 as [r,g,b] 0-1.

Image-to-UI loop: manage_ui create -> ui_preview show -> capture_studio savePath:"cap.png" ->
manage_ui compare mockupPath:"mock.png" capturePath:"cap.png" -> manage_ui set on the off regions -> repeat.

Returns (structured):
  { "ok": boolean, "rootPath"?: string, "path"?: string, "error"?: string }

Examples:
  - A label inside a screen:
      action: "create", parent: "StarterGui",
      tree: { className: "ScreenGui", name: "HUD", children: [
        { className: "TextLabel", name: "Title",
          properties: { Text: "Hello", Size: [[0,200],[0,50]], Position: [[0.5,-100],[0,20]],
                        BackgroundColor3: [0.1,0.1,0.1], TextColor3: [1,1,1] } } ] }

Error Handling:
  - Returns "Error: …not connected" if no Studio session is attached.
  - On a bad property the partial tree is rolled back and an 'error' is returned.`,
      inputSchema: InputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input: Input) => {
      try {
        // sample_color runs server-side (reads a local PNG); it never touches Studio.
        if (input.action === "sample_color") {
          if (!input.imagePath) return fail("sample_color requires 'imagePath'.");
          const fmt = (c: ReturnType<typeof samplePngColor>) =>
            `${c.label ? `${c.label}: ` : ""}(${c.x},${c.y})${c.w > 1 || c.h > 1 ? ` ${c.w}x${c.h}` : ""} ` +
            `${c.hex} → Color3 [${c.rgb.map((n) => n.toFixed(3)).join(",")}]` +
            (c.a < 255 ? ` alpha ${(c.a / 255).toFixed(3)}` : "");
          try {
            if (input.points?.length) {
              const rows = samplePngPoints(input.imagePath, input.points as Coord[]);
              return ok({ ok: true, points: rows }, rows.map(fmt).join("\n"));
            }
            if (input.x === undefined && input.xPct === undefined) {
              return fail("sample_color requires a coordinate (x/y or xPct/yPct) or a 'points' array.");
            }
            const c = samplePngColor(input.imagePath, {
              x: input.x,
              y: input.y,
              xPct: input.xPct,
              yPct: input.yPct,
              w: input.w,
              h: input.h ?? input.w,
            });
            return ok({ ok: true, ...c }, fmt(c));
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        }
        // render_local rasterizes the tree to a PNG on disk — no Studio. Optional
        // mockupPath folds the compare into the same call (the fast design loop).
        if (input.action === "render_local") {
          if (!input.tree) return fail("render_local requires 'tree' (the UI spec to rasterize).");
          if (!input.outPath) return fail("render_local requires 'outPath' (where to write the PNG).");
          try {
            const bg = input.background as [number, number, number] | undefined;
            const r = renderUiTree(input.tree as never, {
              outPath: input.outPath,
              width: input.width,
              height: input.height,
              background: bg,
            });
            if (input.mockupPath) {
              const cmp = compareImages(input.mockupPath, r.path, {
                cols: input.cols,
                rows: input.rows,
                top: input.top,
                mockupRegion: input.mockupRegion,
                captureRegion: input.captureRegion,
              });
              const text = [
                `Rendered ${r.width}x${r.height} → ${r.path}`,
                `Similarity ${cmp.similarity}% vs mockup (mean diff ${cmp.meanDiff}%). Worst regions:`,
                ...cmp.regions.map(
                  (g) => `  @ ${Math.round(g.xPct * 100)}%,${Math.round(g.yPct * 100)}% — ${g.diff}% off, ${g.note}`,
                ),
              ].join("\n");
              return ok({ ok: true, ...r, compare: cmp }, text);
            }
            return ok({ ok: true, ...r }, `Rendered ${r.width}x${r.height} → ${r.path}. Compare it to the mockup with action:'compare'.`);
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        }
        // compare runs server-side (reads two local PNGs); it never touches Studio.
        if (input.action === "compare") {
          if (!input.mockupPath || !input.capturePath) {
            return fail(
              "compare requires 'mockupPath' and 'capturePath' (PNGs on disk). " +
                "Save a capture with capture_studio savePath:..., then compare it to the mockup.",
            );
          }
          try {
            const r = compareImages(input.mockupPath, input.capturePath, {
              cols: input.cols,
              rows: input.rows,
              top: input.top,
              mockupRegion: input.mockupRegion,
              captureRegion: input.captureRegion,
            });
            const text = [
              `Similarity ${r.similarity}% (mean diff ${r.meanDiff}%).`,
              `mockup ${r.mockup.width}x${r.mockup.height} vs capture ${r.capture.width}x${r.capture.height}, grid ${r.grid.cols}x${r.grid.rows}.`,
              "Worst regions (how the capture differs from the mockup):",
              ...r.regions.map(
                (g) =>
                  `  (${g.col},${g.row}) @ ${Math.round(g.xPct * 100)}%,${Math.round(g.yPct * 100)}% — ${g.diff}% off, ${g.note}`,
              ),
            ].join("\n");
            return ok({ ok: true, ...r }, text);
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        }
        const result = await callStudio<Record<string, unknown>>("manage_ui", input);
        const text = result.ok
          ? `UI ${input.action} ok: ${result.rootPath ?? result.path ?? ""}`
          : `UI ${input.action} failed: ${result.error ?? "unknown"}`;
        return ok(result, text);
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );

  server.registerTool(
    "ui_preview",
    {
      title: "Preview GUI (clean capture)",
      description:
        "Render a GUI full-screen on a solid backdrop in edit mode so capture_studio gets a clean, " +
        "isolated shot (no 3D scene behind it) to compare against a mockup. The design loop: " +
        "manage_ui -> ui_preview show -> capture_studio -> compare to mockup -> manage_ui set -> repeat -> ui_preview hide.\n" +
        "Args: action (show[default]|hide), path (GUI to preview, required for show), background ([r,g,b] 0-1).\n" +
        "Returns: { ok, showing, cloned?, error? }. Originals are untouched (a clone is shown).",
      inputSchema: PreviewSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input: z.infer<typeof PreviewSchema>) => {
      try {
        const result = await callStudio<Record<string, unknown>>("ui_preview", input);
        const text = result.ok
          ? input.action === "hide"
            ? "Preview hidden."
            : `Preview shown (${result.cloned ?? 0} element(s)). Now call capture_studio, compare to the mockup, then ui_preview hide.`
          : `ui_preview failed: ${result.error ?? "unknown"}`;
        return ok(result, text);
      } catch (error) {
        return fail(describeError(error));
      }
    },
  );
}
