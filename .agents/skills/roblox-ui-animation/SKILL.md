---
name: roblox-ui-animation
description: >-
  How to animate a Roblox GUI through the roblox-mcp-pro tools — open/close transitions, slide-ins,
  fades, scale "pops", button hover/press feedback, and reproducing a motion you see in a reference
  video. Covers TweenService/TweenInfo, which GUI properties to tween (Size, Position, transparency,
  UIScale, Rotation), easing choices, and a growing library of reusable motion patterns. Use this
  whenever the task involves animating UI in Roblox Studio — phrases like "animate this popup",
  "make the menu slide in", "add an open/close animation", "tween the panel", "button hover effect",
  "match the animation in this clip/video", or whenever a UI should move/fade/scale rather than just
  appear. Pairs with manage_ui (build the GUI) and manage_tween/execute_luau (drive the motion).
  Read this before writing any UI tween.
---

# Animating Roblox UI

UI motion in Roblox is almost always `TweenService` interpolating GUI properties over time. The
craft is picking **what** to tween, over **how long**, with **which easing**, so the result reads
the way the reference does. Build the static UI first (see the `roblox-ui-from-image` skill), then
layer motion on top.

Drive tweens with `execute_luau` (full control, can `:Wait()` on completion) or the `manage_tween`
tool for simple single-property tweens. Tweens **run in Studio edit mode** (Heartbeat advances), so
you can build and watch them without entering Play mode.

## Decode an animation from a reference video

When the user gives you a clip/video of the motion they want, don't guess from memory — **extract
frames and read the motion**. You can view images directly, so turn the video into images:

1. **Probe** it: `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,duration -of default=noprint_wrappers=1 <file>`.
2. **Survey montage** — one image, whole clip at a glance, to find the animation windows and how
   many cycles there are:
   ```bash
   ffmpeg -v error -i <file> -vf "fps=3,scale=300:-1,tile=6x7" -frames:v 1 survey.png
   ```
3. **Zoom in** on one transition at high fps to read direction + easing frame-by-frame:
   ```bash
   ffmpeg -v error -ss <start> -t <dur> -i <file> -vf "fps=15,scale=480:-1,tile=5x3" -frames:v 1 open.png
   ```
4. **Write the frames to a Windows-readable path** (e.g. `C:/Users/<you>/Downloads/_anim/`) so the
   Read tool can open them — `/tmp` (bash) isn't visible to Read on Windows.
5. **Read the montages** and write a **spec**: what element moves, which property changes (size /
   position / transparency / scale / rotation), start→end values, duration, easing
   (accelerate-in / decelerate-out / overshoot), and any delay/stagger between elements.

Gotchas reading video: `drawtext` needs fontconfig (often missing) — skip frame-number overlays and
track frames by tile position instead. A montage tile is low-res; zoom tighter (higher `-ss`/`-t`,
fewer tiles, bigger `scale`) when you need to nail easing or see small elements.

State the spec back to the user and note easing values are estimates from the footage (tunable).

## Fundamentals

**TweenInfo** is the recipe: `TweenInfo.new(time, easingStyle, easingDirection, repeatCount,
reverses, delayTime)`.

- **Time**: UI snaps best at **0.15–0.35s**. Longer feels sluggish; shorter is imperceptible.
- **EasingStyle** — match the feel:
  | Feel | Style / Direction |
  | --- | --- |
  | Smooth, neutral settle (default choice) | `Quad`/`Quint` + `Out` |
  | Snappy, energetic settle | `Quint`/`Expo` + `Out` |
  | Playful overshoot (pops past then back) | `Back` + `Out` |
  | Bouncy landing | `Bounce` + `Out` |
  | Elastic wobble | `Elastic` + `Out` |
  | Symmetric in-and-out (e.g. a pulse) | `Sine` + `InOut` |
  - `Out` decelerates into the end (best for things appearing). `In` accelerates (best for things
    leaving). `InOut` for moves between two on-screen states.

**What to tween** (and how):
- **Size** — grow/shrink. For a "scale pop" prefer a child **`UIScale`** (`Scale` 0→1) over tweening
  `Size` directly: it scales children too and won't fight layout. **A scale pivots around the
  object's `AnchorPoint`** — set it to `[0.5,0.5]` for a symmetric pop from the center; an edge anchor
  (e.g. `[1,0.5]`) makes it grow toward that edge, which looks lopsided. This applies to *every*
  scale animation (panel open, hover pop): the anchor is the pivot. For an element that must stay
  edge-pinned for layout, re-center it first (preserve its rect by reading `AbsolutePosition`/
  `AbsoluteSize`) or scale an inner wrapper instead.
- **Position** — slide in/out. Tween a `UDim2`; pair with `AnchorPoint` so it slides from the right edge.
- **Transparency** — fade. `BackgroundTransparency` + `TextTransparency`/`ImageTransparency`. To fade
  a whole panel as one unit, wrap it in a **`CanvasGroup`** and tween `GroupTransparency` (one value
  fades everything, including strokes/gradients).
- **Rotation** — spin/settle (e.g. an icon, or a slight tilt-in).
- **UICorner / UIStroke.Thickness** — secondary polish.

**Sequencing / stagger**: animate list items with a small increasing `delayTime` (e.g. 0.04s × index)
so rows cascade instead of popping together — reads as "alive".

## Pattern library

### 1. Scale-pop panel + staggered children

The popup **scales up from its center** (a small box that grows to full size with a slight overshoot
"pop"); on close it scales back down. Its contents (cards/rows) then **fade in one by one** in a
cascade. This is the classic "juicy" game HUD popup — what most reference clips of menus opening show.

Two independent layers:
- **Panel scale** via a `UIScale` (`Scale` 0→1). The panel **must be center-anchored**
  (`AnchorPoint = [0.5,0.5]`) so it grows from the middle — the anchor is the pivot of the scale.
  `Back`/`Out` gives the overshoot pop.
- **Child stagger** via per-item **transparency** with an increasing `delayTime`. Fade — *not* Size
  or UIScale — because items in a `UIListLayout` reflow when their `AbsoluteSize` changes, making the
  list jump. Transparency doesn't touch layout.

```lua
local TweenService = game:GetService("TweenService")
local panel = script.Parent:WaitForChild("Panel")
panel.AnchorPoint = Vector2.new(0.5, 0.5)            -- pivot of the scale = center
panel.Position = UDim2.new(0.5, 0, 0.5, 0)
local scale = Instance.new("UIScale"); scale.Parent = panel

local OPEN  = TweenInfo.new(0.30, Enum.EasingStyle.Back, Enum.EasingDirection.Out)
local CLOSE = TweenInfo.new(0.20, Enum.EasingStyle.Quad, Enum.EasingDirection.In)

-- every transparency-bearing prop of a subtree, so we can hide → fade it back in
local FADE = { BackgroundTransparency = true, TextTransparency = true, ImageTransparency = true }
local function faders(root)
    local out, scan = {}, root:GetDescendants(); table.insert(scan, root)
    for _, d in ipairs(scan) do
        for p in pairs(FADE) do
            local ok, v = pcall(function() return d[p] end)
            if ok and typeof(v) == "number" and v < 1 then table.insert(out, { d, p, v }) end
        end
        if d:IsA("UIStroke") then table.insert(out, { d, "Transparency", d.Transparency }) end
    end
    return out
end

local rows = {}                                       -- the cards, in layout order
for _, r in ipairs(panel.List:GetChildren()) do
    if r:IsA("GuiObject") then table.insert(rows, r) end
end
table.sort(rows, function(a, b) return a.LayoutOrder < b.LayoutOrder end)

local function open()
    scale.Scale = 0
    for _, r in ipairs(rows) do
        for _, f in ipairs(faders(r)) do f[1][f[2]] = 1 end          -- hide cards
    end
    panel.Visible = true
    TweenService:Create(scale, OPEN, { Scale = 1 }):Play()           -- pop the panel
    for i, r in ipairs(rows) do                                      -- cascade the cards
        local delay = (i - 1) * 0.05
        for _, f in ipairs(faders(r)) do
            TweenService:Create(f[1],
                TweenInfo.new(0.22, Enum.EasingStyle.Quad, Enum.EasingDirection.Out, 0, false, delay),
                { [f[2]] = f[3] }):Play()
        end
    end
end

local function close()
    return TweenService:Create(scale, CLOSE, { Scale = 0 })          -- :Play() then hide on .Completed
end
```

The cards also *rise* a little as they fade in the reference. A true positional rise inside a
`UIListLayout` fights the layout — wrap each card in a `CanvasGroup` and tween `GroupTransparency`
plus an inner offset, rather than moving the card frame itself.

For **hover pop** on the buttons, the same pivot rule bites: a button anchored `[1,0.5]` pops toward
its right edge. Re-center it before adding the hover `UIScale`:
```lua
local function recenter(o)                 -- preserve the rect, move the anchor to the middle
    local rel = o.AbsolutePosition - o.Parent.AbsolutePosition
    o.AnchorPoint = Vector2.new(0.5, 0.5)
    o.Position = UDim2.fromOffset(math.round(rel.X + o.AbsoluteSize.X/2),
                                  math.round(rel.Y + o.AbsoluteSize.Y/2))
end                                        -- run after layout settles (RunService.Heartbeat:Wait())
```

### 2. Clip-reveal panel (vertical "unroll")

The panel keeps full width and **grows in height from its top edge**; a `ClipsDescendants` container
reveals its contents top-to-bottom like unrolling a scroll. Close is the reverse. Snappy and clean —
common in game HUD popups.

**Critical rule — anchor every child to the TOP** (position by offset from the top edge). A child
anchored to the panel's *bottom* edge (`AnchorPoint.Y = 1`, `Position [[..],[1,..]]`) will **slide up
with the shrinking edge instead of being revealed in place**, breaking the illusion. Convert any
bottom-pinned child to a top offset at the same visual Y before animating.

```lua
local TweenService = game:GetService("TweenService")

-- one-time rig: clip + re-anchor to the top so a height tween unrolls downward.
local function setupReveal(panel)
    local fullH = panel.Size.Y.Offset            -- assumes a fixed-offset height
    panel.ClipsDescendants = true
    panel.AnchorPoint = Vector2.new(0.5, 0)
    panel.Position = UDim2.new(0.5, 0, 0.5, -fullH / 2)   -- same visual center as a centered panel
    panel:SetAttribute("FullH", fullH)
end

local OPEN  = TweenInfo.new(0.32, Enum.EasingStyle.Quint, Enum.EasingDirection.Out)
local CLOSE = TweenInfo.new(0.26, Enum.EasingStyle.Quint, Enum.EasingDirection.In)

local function open(panel)
    local h = panel:GetAttribute("FullH")
    panel.Size = UDim2.new(panel.Size.X.Scale, panel.Size.X.Offset, 0, 0)
    panel.Visible = true
    TweenService:Create(panel, OPEN,
        { Size = UDim2.new(panel.Size.X.Scale, panel.Size.X.Offset, 0, h) }):Play()
end

local function close(panel)
    local t = TweenService:Create(panel, CLOSE,
        { Size = UDim2.new(panel.Size.X.Scale, panel.Size.X.Offset, 0, 0) })
    t.Completed:Connect(function() panel.Visible = false end)
    t:Play()
end
```

Optional flourish seen in reference clips: a **burst/sparkle** sprite that scales up and fades at the
center on open/close — an `ImageLabel` with a starburst asset, `UIScale` 0.5→1.4 + `ImageTransparency`
0→1 over ~0.25s. Needs a real `rbxassetid://` image.

<!-- Append new patterns here as they're decoded: scale-pop, slide-in, fade+blur backdrop, stagger list, etc. -->

## Gotchas

- **Verifying motion with a single screenshot is impossible.** `capture_studio` is one frame. To
  sanity-check a transition, set the element to a **mid-state** (e.g. 45% of the way) and capture
  that, or `:Wait()` on the tween and capture the settled end state. Tell the user to watch the live
  tween in Studio for the motion itself.
- **`ui_preview` shows a clone.** Tweening the StarterGui original won't animate the preview overlay.
  Hide the preview and run the tween on the real GUI (Studio renders StarterGui in the edit viewport).
- **ColorSequence (UIGradient.Color) can't be tweened by TweenService.** Tween `UIGradient.Offset` or
  `Rotation` for motion, or step the color in a `RenderStepped`/`Heartbeat` loop.
- **Reuse, don't recreate.** Define `open`/`close` once (a ModuleScript or LocalScript) and call them;
  don't rebuild tweens per click.
- **Clean up on close.** Disconnect `Completed`/input connections and set `Visible=false` after a
  close tween so a hidden panel doesn't eat clicks.
