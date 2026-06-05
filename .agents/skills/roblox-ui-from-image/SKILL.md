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

## The loop

1. **Get the image.** The user pastes/drags it into chat (you see it directly — no tool needed) or
   gives a file path you can read. Study it before building.
2. **Analyze the design** (see checklist below) — structure, sizes, colors, fonts, spacing.
3. **Build** with `manage_ui` (`action: "create"`, `replace: true` so re-runs don't stack copies).
4. **Preview clean**: `ui_preview` (`action: "show"`, `path:` your ScreenGui) renders it full-screen
   on a solid backdrop in edit mode (hides the 3D scene behind it).
5. **Capture**: `capture_studio` — now you see your UI isolated, centered in the viewport.
6. **Compare** the capture to the mockup. Note differences (position, size, color, font, spacing).
7. **Refine** with `manage_ui` (`action: "set"`) on the specific paths, then repeat 5–6 until close.
8. **Done**: `ui_preview` (`action: "hide"`) to remove the preview overlay.

Always `system_info` first to confirm the plugin is connected. Studio renders `StarterGui` content
in the edit viewport, so a capture without `ui_preview` also works — but `ui_preview` gives a clean
backdrop for accurate comparison.

## Analyze the mockup (before building)

- **Hierarchy**: outermost container(s) → panels → elements. Map to ScreenGui → Frame(s) → children.
- **Anchoring/position**: is it centered, corner-pinned, edge-docked? Pick `AnchorPoint` + `Position`
  accordingly (center = `AnchorPoint [0.5,0.5]`, `Position [[0.5,0],[0.5,0]]`).
- **Sizing**: fixed px (offset) vs proportional (scale). Cards/buttons are usually offset; full-screen
  dim layers are scale.
- **Colors**: background, panel, accent, text. Convert to `[r,g,b]` 0–1.
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
- After previewing, always `ui_preview hide` so the overlay doesn't linger in CoreGui.
