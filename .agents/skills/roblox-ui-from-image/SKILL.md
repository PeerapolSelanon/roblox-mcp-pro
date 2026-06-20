---
name: roblox-ui-from-image
description: >-
  How to reproduce a UI design/mockup as a Roblox GUI through the roblox-mcp-pro tools — turning a
  pasted screenshot, Figma export, or reference image into a pixel-close ScreenGui. Use whenever
  the user supplies an image of a UI (HUD, menu, shop, popup, title screen, inventory, settings
  panel) and wants it built in Roblox Studio, or says things like "make this UI", "build this
  screen", "copy this layout", "match this design". Covers the build→preview→capture→compare→refine
  loop with manage_ui, ui_preview, and capture_studio, plus UDim2/Color3 conventions and component
  recipes. Read this before building UI from a reference.
---

# Building Roblox UI from an image

Goal: given a reference image of a UI, produce a Roblox `ScreenGui` that looks like it. The win
comes from a **visual feedback loop** — build, look at the real render, compare to the mockup, fix
— not from one-shot guessing.

## Two loops — design locally first, then verify in Studio

There are two ways to run the feedback loop. **Prefer the fast local loop** to nail layout, colors,
and structure without a Studio round-trip, then build the final tree in Studio once and verify.

**Fast local loop (no Studio):** when the mockup is a PNG **on disk**, render your candidate tree
right on the client and score it:
- `manage_ui action:"render_local", tree:{…}, outPath:"<tmp>/ui.png", width:W, height:H, mockupPath:"<mockup.png>"`
  rasterizes the *exact tree Studio would build* (UDim2/AnchorPoint/UIListLayout/UIPadding/UICorner/
  UIStroke), writes a PNG, and — because you passed `mockupPath` — returns the similarity % and worst
  regions in the same call. Iterate on the `tree` until similarity plateaus. No Studio needed.
- Match `width`/`height` to the mockup's pixel size so the comparison lines up.
- It's an approximation of the *paint* (text is a tinted bar, not glyphs; gradients/images are
  placeholders), so it's authoritative for **layout, color, sizing, structure** — not font shape.
- When happy, run the **full loop below once** in Studio (`create` the same tree) to verify the real
  render (fonts, gradients, images, text wrapping) and do any final touch-ups.

## The loop (in Studio)

1. **Get the image.** The user pastes/drags it into chat (you see it directly — no tool needed) or
   gives a file path you can read. Study it before building.
2. **Analyze the design** (see checklist below) — structure, sizes, colors, fonts, spacing.
3. **Build** with `manage_ui` (`action: "create"`, `replace: true` so re-runs don't stack copies).
4. **Preview clean**: `ui_preview` (`action: "show"`, `path:` your ScreenGui) renders it full-screen
   on a solid backdrop in edit mode (hides the 3D scene behind it).
5. **Capture to disk**: `capture_studio` with `savePath: "<tmp>/cap.png"` — you see your UI isolated
   AND get a PNG on disk for the next step.
6. **Compare (measured, not eyeballed)**: when the mockup is a PNG **file on disk**, call
   `manage_ui action:"compare", mockupPath:"<mockup.png>", capturePath:"<tmp>/cap.png"`. It returns a
   **similarity %** plus the **worst-matching regions** as `xPct,yPct` with a hint (e.g. "brighter,
   more red") — go fix those regions first. (Also look at the capture yourself for layout/font issues
   the color score can't see.)
7. **Refine** with `manage_ui` (`action: "set"`) on the paths covering the worst regions, then repeat
   5–6. Watch similarity climb; stop when it plateaus or looks right.
8. **Done**: `ui_preview` (`action: "hide"`) to remove the preview overlay.

> **compare** averages both images onto a grid and scores color distance — great for catching wrong
> colors, missing/extra elements, and gross position errors, and for telling you *where* to look. It
> can't judge font choice or sub-pixel alignment, so keep your own eye on the capture too. Only the
> mockup needs to be on disk for sample_color; **compare needs both** the mockup and a saved capture.

Always `system_info` first to confirm the plugin is connected. Studio renders `StarterGui` content
in the edit viewport, so a capture without `ui_preview` also works — but `ui_preview` gives a clean
backdrop for accurate comparison.

## Analyze the mockup (before building)

- **Hierarchy**: outermost container(s) → panels → elements. Map to ScreenGui → Frame(s) → children.
- **Anchoring/position**: is it centered, corner-pinned, edge-docked? Pick `AnchorPoint` + `Position`
  accordingly (center = `AnchorPoint [0.5,0.5]`, `Position [[0.5,0],[0.5,0]]`).
- **Sizing**: fixed px (offset) vs proportional (scale). Cards/buttons are usually offset; full-screen
  dim layers are scale.
- **Colors**: background, panel, accent, text. Convert to `[r,g,b]` 0–1. For an **exact** color
  when the mockup is a PNG **file on disk**, use the eyedropper instead of eyeballing:
  `manage_ui action:"sample_color", imagePath:"<path.png>", x:<px>, y:<px>` (or `xPct`/`yPct`
  fractions 0–1) → returns `rgb` (Color3 0–1), `hex`, and alpha. Only works on a real file path
  (a PNG pasted into chat isn't on disk); 8-bit non-interlaced PNG.
  - **Grab the whole palette in one call** with `points: [{x,y,label?}, …]` — decodes the image once.
  - **`w`,`h` averages a box** to kill single-pixel noise (stars, grain, anti-aliased edges). But
    averaging *dilutes* small bright features: use a **small box / single pixel at the center** for
    tiny saturated icons/accents, and a **larger box (~10–20px)** for flat panels/backgrounds.
- **Text**: content, font (GothamBold/Gotham/etc.), size, alignment, color.
- **Corners/strokes/gradients**: rounded → `UICorner`; outline → `UIStroke`; gradient → `UIGradient`.
- **Repetition/lists**: rows/grids → `UIListLayout`/`UIGridLayout` instead of hand-placing each item.

## Conventions (roblox-mcp-pro property formats)

- `Size`/`Position` are **UDim2**: `[[xScale,xOffset],[yScale,yOffset]]`.
  - Centered 360×200 card: `Size [[0,360],[0,200]]`, `AnchorPoint [0.5,0.5]`, `Position [[0.5,0],[0.5,0]]`.
- `BackgroundColor3`/`TextColor3` are **Color3** `[r,g,b]` 0–1 (e.g. `[0.12,0.14,0.2]`).
- `AnchorPoint` is `[x,y]` (Vector2, 0–1). `Font` is an enum name string (`"GothamBold"`).
- `UICorner.CornerRadius` is a **UDim**: `[scale,offset]` → `[0,16]` for 16px corners.
- Set `BorderSizePixel: 0` on Frames/buttons; `BackgroundTransparency: 1` on text-only labels.

## Component recipes

**Rounded panel**
```
{ className:"Frame", name:"Card",
  properties:{ Size:[[0,360],[0,220]], AnchorPoint:[0.5,0.5], Position:[[0.5,0],[0.5,0]],
               BackgroundColor3:[0.12,0.14,0.2], BorderSizePixel:0 },
  children:[ { className:"UICorner", properties:{ CornerRadius:[0,16] } } ] }
```

**Button (rounded, accent — with edge highlight + readable text)**
```
{ className:"TextButton", name:"Play",
  properties:{ Text:"PLAY", Font:"GothamBold", TextSize:20, TextColor3:[1,1,1],
               BackgroundColor3:[0.2,0.7,0.4], Size:[[0,160],[0,48]], BorderSizePixel:0 },
  children:[ { className:"UICorner", properties:{ CornerRadius:[0,10] } },
             // edge highlight — ApplyStrokeMode "Border" (see below); Color is a LIGHTER tint of
             // the fill ([0.2,0.7,0.4] → [0.4,0.95,0.5]) so the button pops
             { className:"UIStroke", name:"Border",
               properties:{ ApplyStrokeMode:"Border", Thickness:2, Color:[0.4,0.95,0.5] } },
             // text outline — a SECOND stroke, Contextual + dark, so white text stays legible
             { className:"UIStroke", name:"TextStroke",
               properties:{ ApplyStrokeMode:"Contextual", Thickness:2, Color:[0,0,0] } } ] }
```

**Button with a gradient background (gradient must NOT tint the text)**
A `UIGradient` on a `TextButton` recolors the **text too**, not just the fill. To keep the gradient
on the button only, give the button empty `Text` and move the label into a child `TextLabel`.
Also: `UIGradient` **multiplies** with the object's own color, so set the fill `BackgroundColor3` to
**white `[1,1,1]`** — otherwise the gradient comes out tinted/darker than the colors you specified:
```
{ className:"TextButton", name:"Play",
  properties:{ Text:"", BackgroundColor3:[1,1,1], Size:[[0,160],[0,48]], BorderSizePixel:0 },
  children:[ { className:"UICorner", properties:{ CornerRadius:[0,10] } },
             { className:"UIGradient", properties:{ Rotation:90 } },  // set .Color via execute_luau
             { className:"UIStroke", name:"Border",
               properties:{ ApplyStrokeMode:"Border", Thickness:2, Color:[0.4,0.95,0.5] } },
             // text in its OWN label → the button's gradient can't reach it
             { className:"TextLabel", name:"Label",
               properties:{ Text:"PLAY", Font:"GothamBold", TextSize:20, TextColor3:[1,1,1],
                            BackgroundTransparency:1, Size:[[1,0],[1,0]] },
               children:[ { className:"UIStroke", properties:{ Thickness:2, Color:[0,0,0] } } ] } ] }
```

**Vertical list (auto-stacked rows)**
```
{ className:"Frame", name:"List", properties:{ BackgroundTransparency:1, Size:[[1,0],[1,0]] },
  children:[ { className:"UIListLayout",
               properties:{ Padding:[0,8], FillDirection:"Vertical",
                            HorizontalAlignment:"Center", SortOrder:"LayoutOrder" } },
             /* row frames here */ ] }
```

## Notes & limits

- **One-call builds**: pass the whole nested `tree` to `manage_ui create` — don't create node-by-node.
- **Iterate with `set`**: once built, tweak single properties via `manage_ui set` on the exact path
  (cheaper than rebuilding) — unless restructuring, then `create` with `replace:true`.
- **ImageLabel/ImageButton** need a real `Image` asset id (`rbxassetid://…`). If the mockup has
  images you don't have ids for, build the layout with placeholder Frames and tell the user which
  images to upload.
- **Gradients/sequences**: `UIGradient.Color` (ColorSequence) and similar sequence properties may not
  coerce from simple arrays — set a solid color first, and use `execute_luau` for a true gradient if
  needed. A `UIGradient` on a `TextButton`/`TextLabel` also **tints the text**, not just the fill —
  to gradient the button only, give the button empty `Text` and move the label into a child
  `TextLabel` with `BackgroundTransparency:1` (see the gradient-button recipe above).
- **UIGradient multiplies with the base color**: the gradient is *multiplied over* the object's own
  color, so to get the exact ColorSequence colors you specified, first set the underlying property to
  **white** — `BackgroundColor3:[1,1,1]` for a fill gradient, `TextColor3:[1,1,1]` for a text
  gradient. A non-white base darkens/tints the whole gradient.
- **Rotated Elements (e.g. Diamonds) and Clipping/Overflows**: When rotating a square element (like a frame with `Rotation = 45` to make a diamond), its visual bounding box size increases. For a square of side length $S$ rotated by 45 degrees, the actual visual width and height become $S \times \sqrt{2} \approx 1.414 \times S$. Because Roblox layout and bounding calculations use the original non-rotated size, you must offset the element's position away from the container edges (by at least half of the visual width, i.e., $0.707 \times S$) to prevent the corners from clipping or overflowing the parent container.
- **Avoiding TextBounds Sizing Race Conditions**: When dynamically sizing a text container based on `TextLabel.TextBounds`, do NOT write `repeat task.wait() until label.TextBounds`. In Lua, `Vector2` values (even `Vector2.new(0,0)`) are always truthy, so this loop terminates immediately on the first frame before the engine measures the text. Instead, set `AutomaticSize = Enum.AutomaticSize.Y` on the label and its parent container (with initial `Size.Y = 0`) to natively scale heights without scripts, OR explicitly check the Y value in a loop: `while label.TextBounds.Y == 0 do task.wait() end`.
- **Responsive scale for fixed-offset modals — share the logic, don't duplicate it**: a window
  authored at a fixed pixel `Size` (offset) overflows small screens at a flat scale. Put the fit
  math in ONE shared `ModuleScript` (e.g. `ReplicatedStorage/UIScale`) that every modal `require`s —
  don't copy a Scale Controller into each UI (a game has many modals; copy-paste rots).
  `bindFit(uiScale, rootFrame, designSize, {base=1.0, pad=0.92})` computes
  `min(min(vp.X*pad/designW, vp.Y*pad/designH), base)` — `base 1.0` = 1:1 on PC, smaller viewports
  shrink to fit — and caches a `CurrentCamera.ViewportSize` listener so it re-fits on rotate/resize.
  Each modal's LocalScript keeps only its own animation/interaction and tweens open/close to the
  computed scale. This pattern is for **fixed-offset modals only** — edge-docked HUDs use
  Scale-`UDim2` + `AnchorPoint` and need no `UIScale`.
- **UIStroke on buttons/text — the two-stroke rule**: a `UIStroke` under a `TextButton`/`TextLabel`
  defaults to `ApplyStrokeMode = "Contextual"`, which outlines the **text glyphs, not the button
  border**. So a single default stroke gives you a text outline when you wanted an edge highlight.
  - For a button **edge/glow highlight**, set `ApplyStrokeMode:"Border"`.
  - **Highlight color = a lighter/whiter tint of the button's own fill**, not a contrasting accent.
    Push the `BackgroundColor3` toward white (raise each channel, e.g. green fill `[0.2,0.7,0.4]` →
    edge `[0.4,0.95,0.5]`) so the rim reads as a lit edge and the button visually pops off the panel.
  - To get **both** an edge highlight *and* a crisp text outline, add **two** UIStrokes on the same
    button: one `"Border"` (the lighter-tint edge) and one `"Contextual"` (the text). They target
    different parts and both render.
  - The **text** stroke should be a **dark/near-black** color so white button text stays legible.
- **Procedural Layered/Volumetric Borders (3-Layer Neon Glow with BorderOffset)**: To create a premium, volumetric glowing border (like a neon tube or rich glowing panels) without overlapping strokes or helper nested frames:
  - **Single Frame Placement**: Place three `UIStroke` instances directly under the same object, named `OuterStroke` (outermost shadow), `CenterStroke` (glow core), and `InnerStroke` (innermost shadow).
  - **Position & Mode Settings**:
    - Set `BorderStrokePosition = Enum.BorderStrokePosition.Inner` for all three.
    - Set `ApplyStrokeMode = Enum.ApplyStrokeMode.Border` for all three.
  - **Consecutive Offset Calculation**:
    - `OuterStroke`: `BorderOffset = UDim.new(0, 0)`. Set it thin (e.g. 1.5px) and dark (e.g. black/dark shadow).
    - `CenterStroke`: `BorderOffset = UDim.new(0, -OuterStroke.Thickness)`. Set it thick (e.g. 4.0px - 6.0px) and bright neon.
    - `InnerStroke`: `BorderOffset = UDim.new(0, -(OuterStroke.Thickness + CenterStroke.Thickness))`. Set it thin (e.g. 1.5px) and dark.
  - **Result & ScrollingFrame Clipping Protection**: They align perfectly side-by-side going inwards from the frame edge, creating a flawless 3-segment consecutive border (e.g. 1.5px black -> 6.0px neon pink -> 1.5px dark red). Crucially, because all strokes are set to `BorderStrokePosition.Inner`, **they are guaranteed not to be cut off or clipped by `ScrollingFrame` canvas edges or `ClipsDescendants`** (which always clips `Center` or `Outer` stroke boundaries that bleed outside the frame bounding box).
- **Gradient Strokes & Gradients**: You can place a `UIGradient` *inside* a `UIStroke` to make the border itself gradient-shaded. When setting UIGradients, set base colors/transparencies dynamically in a LocalScript if using ColorSequence or NumberSequence to avoid JSON coercion issues.
- **ScrollingFrame Best Practices**: When creating vertical lists, grids, or long text scroll areas inside a `ScrollingFrame`:
  - **Dynamic Canvas Sizing**: Set `AutomaticCanvasSize = Enum.AutomaticSize.Y` and `CanvasSize = UDim2.new(0, 0, 0, 0)`. This forces Roblox to automatically recalculate the canvas height based on the total height of child layouts (like `UIListLayout` or `UIGridLayout`) without manual script updates.
  - **Lock Scrolling Axis**: Set `ScrollingDirection = Enum.ScrollingDirection.Y` to lock scrolling vertically and prevent accidental horizontal scrolling/panning.
  - **UIStroke Padding Requirement**: If any child elements inside the `ScrollingFrame` have a `UIStroke` applied (regardless of element type), you must always add a `UIPadding` inside the `ScrollingFrame` and configure padding on all sides (`PaddingTop`, `PaddingBottom`, `PaddingLeft`, `PaddingRight`) to prevent the strokes from being cut off or clipped at the borders of the `ScrollingFrame`.
- After previewing, always `ui_preview hide` so the overlay doesn't linger in CoreGui.
