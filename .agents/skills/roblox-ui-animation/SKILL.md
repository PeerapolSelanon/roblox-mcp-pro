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

### 3. Animating 3-Layer Volumetric Borders (Neon Glow/Highlight)

When animating or hovering a 3-layer volumetric border (using `BorderStrokePosition` set to `Outer`, `Center`, and `Inner` directly on the parent frame):
- **Contrast Rule**: Keep the `OuterStroke` (Outer shadow) and `InnerStroke` (Inner shadow) thin and dark (e.g. `Thickness = 1.2` or `1.5`, very dark colors) to maintain high contrast and sharp border details.
- **Center Stroke Expansion**: Only expand and brighten the `CenterStroke` (Center position) on hover. For example, tweening `CenterStroke.Thickness` from `3.0` to `4.5` and its color to a brighter neon tint. Do not thicken the outer and inner strokes, as doing so will cause the dark shadows to bleed into the neon core, destroying the volumetric illusion.

Example LocalScript hover implementation:
```lua
local TweenService = game:GetService("TweenService")
local TWEEN_INFO = TweenInfo.new(0.15, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)

local function hookHover(button)
    local outerStroke = button:FindFirstChild("OuterStroke")
    local centerStroke = button:FindFirstChild("CenterStroke")
    local innerStroke = button:FindFirstChild("InnerStroke")

    button.MouseEnter:Connect(function()
        if centerStroke then
            TweenService:Create(centerStroke, TWEEN_INFO, {Thickness = 4.5, Color = Color3.fromRGB(220, 100, 255)}):Play()
        end
        -- Keep outerStroke and innerStroke at their thin 1.2px - 1.5px thickness
    end)

    button.MouseLeave:Connect(function()
        if centerStroke then
            TweenService:Create(centerStroke, TWEEN_INFO, {Thickness = 3.0, Color = Color3.fromRGB(160, 50, 240)}):Play()
        end
    end)
end
```

### 4. Spring-driven hover micro-interactions (the "juicy" HUD hover)

The hover that feels *premium* is never one property — it's a **stack of layers on a single hover
state**, driven by **springs, not fixed-duration tweens**. Why springs: a hover that re-fires while
still mid-animation must continue from its current velocity, not restart from zero — that
interruptibility is what makes a HUD feel physical. A `TweenService` tween (fixed time) visibly
restarts on rapid re-hover; a spring picks up where it is.

**Prefer Fusion springs when the project already uses Fusion** (most reactive Roblox UIs do — check
`ReplicatedStorage.Shared.Packages.Fusion`). Then `Scope:Spring(target, speed, damping)` is the
canonical driver, and you get motion **identical** to the rest of the game's UI for free — same code
path, impossible to drift. Don't add Fusion *just* for a hover, but if it's already a dependency,
matching it beats reinventing a spring. **You can layer Fusion onto a GUI built imperatively in
StarterGui** (not Fusion-authored): `FindFirstChild` the elements and `Scope:Hydrate(inst) { Prop =
spring }` — exactly how to retrofit premium motion onto an old TweenService screen. Only if the
project has **no** Fusion, hand-roll a damped spring stepped in `RenderStepped` (~15 lines), or
approximate with short `Back`/`Out` tweens (fine for most buttons, less fluid on fast re-hover).
(Want Fusion where it's absent? It's the open-source `elttob/fusion` package — add it via Wally or
drop the module into `ReplicatedStorage` **only if you'll build reactive UI broadly**; for one-off
motion, hand-roll instead.)

**Guard the dependency so a missing Fusion never crashes the script.** When you retrofit Fusion onto
a shipped UI, `pcall` the require and branch — Fusion path for the premium feel, TweenService path as
a fallback. A hard `require` that throws takes the *whole* controller down with it (the same cascade a
missing `WaitForChild` causes):
```lua
local fusionOk, Fusion = pcall(function() return require(ReplicatedStorage.Shared.Packages.Fusion) end)
local Scope = fusionOk and Fusion.scoped(Fusion) or nil
-- in the hover wiring:
if Scope then  -- Fusion springs (1:1 with the rest of the game)
else           -- TweenService Back/Out approximation; nothing breaks
end
```

**Spring params** (Fusion `Spring(value, speed, damping)`):
- **speed** — higher = snappier settle (HUDs here use 30–40).
- **damping** — `<1` overshoots/bounces (`0.45` = lively pop), `1` = critical (clean slide, no
  overshoot), `>1` = sluggish.

**Layer these on one `isHovered` state** (the magic is the stack, not any single line):

| Layer | Idle → Hover | Driver | Target property |
| --- | --- | --- | --- |
| Scale bounce | `1.0 → 1.12` (pressed `0.95`) | Spring `40, 0.45` | child `UIScale.Scale` |
| Stroke highlight | base color → **white** | Spring `30, 0.8` | `UIStroke.Color` |
| Gradient flash | default → **white** `ColorSequence` | Computed (no spring) | `UIGradient.Color` |
| Icon tilt | `0° → 16°` | Spring `35, 0.45` | `Icon.Rotation` |
| Shine sweep | offset `-1.5 → 1.5` | Spring `35, 1.0` | `ShineGradient.Offset` (a light streak crossing the button) |

Two extras that actually sell it:
- **Continuous rotation sweep** — a single value incremented in `RunService.RenderStepped`
  (`(v + dt*SPEED) % 360`, SPEED ~180°/s) bound to the stroke/icon `UIGradient.Rotation`. The border
  shimmer never stops, so even idle buttons read as "powered-on". **One loop drives every button's
  gradient** — never a loop per button.
- **Sound** — `UI_HOVER` at low volume (~0.25) on enter, `UI_CLICK` on activate. Audio is half the
  "feel"; a silent hover feels dead no matter how good the motion.

Fusion form (attach to a GUI authored in StarterGui via `Hydrate`, with `FindFirstChild` guards so a
missing layer just no-ops):
```lua
local isHovered = Scope:Value(false)
local scaleTarget = Scope:Computed(function(use) return use(isHovered) and 1.12 or 1.0 end)
Scope:Hydrate(button:FindFirstChildOfClass("UIScale")) { Scale = Scope:Spring(scaleTarget, 40, 0.45) }
Scope:Hydrate(button) {
    [Fusion.OnEvent "MouseEnter"] = function() isHovered:set(true); SoundService.play("UI_HOVER", { volume = 0.25 }) end,
    [Fusion.OnEvent "MouseLeave"] = function() isHovered:set(false) end,
    [Fusion.OnEvent "Activated"]  = function() SoundService.play("UI_CLICK") end,
}
```

No-Fusion fallback: on `MouseEnter` fire one `Back`/`Out` ~0.15s tween per property (Scale→1.12,
stroke→white, icon Rotation→16), reverse on `MouseLeave`; keep the continuous sweep in its
`RenderStepped` loop. Re-hovering mid-tween restarts — acceptable for most buttons.

**Press state**: fold into the scale computed — pressed `0.95` < idle `1.0` < hovered `1.12`. Set on
`InputBegan` (MouseButton1/Touch), clear on `InputEnded` and `MouseLeave`.

**Make it reusable, once.** Wrap this whole stack in a single component/helper that takes a button,
wires the hover/press state + spring layers + sounds, and returns it — so every button gets identical
feel from one definition. Don't copy the hover block per button (a HUD has dozens).

**Shine sweep — the exact recipe.** A light streak that crosses the button on hover. An overlay
`Frame` (white, full size, its own `UICorner` matching the button) with a `UIGradient` whose
**Transparency** is a wide soft band, fully opaque only at the core, invisible elsewhere:
```lua
sg.Rotation = 45                                  -- diagonal
sg.Transparency = NumberSequence.new({
    NumberSequenceKeypoint.new(0, 1), NumberSequenceKeypoint.new(0.18, 1),
    NumberSequenceKeypoint.new(0.5, 0),           -- core: fully white. A narrow band here reads as a thin streak; keep it WIDE (0.18→0.82) for the soft HUD glow
    NumberSequenceKeypoint.new(0.82, 1), NumberSequenceKeypoint.new(1, 1),
})
sg.Offset = Vector2.new(-1.5, 0)                  -- parked off the left edge; Spring the Offset.X to 1.5 on hover, back to -1.5 on leave
```
- **Render the shine UNDER the text, or it washes out labels.** How depends on the ScreenGui's
  `ZIndexBehavior`: with **Sibling**, place the overlay before the content in child order (or give
  content higher `ZIndex`); with **Global** (where `ZIndex` is absolute), the overlay at `ZIndex 2`
  still draws over same-`ZIndex` content — so **lift the button's content** (`for each GuiObject
  descendant: ZIndex = max(ZIndex, 3)`) and keep the shine at `2`. This Sibling-vs-Global difference
  is the #1 reason a copied shine "doesn't look like the reference."
- The gradient's **Color stays white**; the Transparency band is what you see. Drive `Offset` with the
  same `Spring(35, 1)` the source UI uses for a 1:1 match.

### 5. Ambient UI effects (always-on, no hover)

Decorative motion/look that makes a panel feel built, not flat. None of these need input.

- **Continuous shimmer on a stroke** — give a `UIStroke` a child `UIGradient` with a Transparency band
  (`1 → 0 → 1`) and rotate it forever (`(v + dt*SPEED) % 360` in one shared `RenderStepped`). A
  rotating transparent gap sweeps the border = a "powered-on" rim. One loop drives every element's
  gradient; never one loop each.
- **Glowing divider** — a thin (2px) **white** `Frame` with a child `UIGradient`: `Color` = your accent
  (e.g. `Color3.fromRGB(120,40,180)`), `Transparency` = `1 → 0 → 1`, `Rotation = 90`. White base ×
  colored gradient = a vertical line that's bright in the middle and fades at both ends — a soft neon
  separator. (White base is required: `UIGradient` multiplies, so a colored base would tint it dark.)
- **Halftone dot texture** (no asset) — Roblox has no tiling dot texture, so place a small grid of
  circular `Frame`s (`UICorner CornerRadius (1,0)`), **stagger alternate rows** by half the pitch for a
  real halftone look, and **set each dot's `BackgroundTransparency` per its x-position** to fade the
  field out toward one side. A single `UIGradient` on the container can't do the fade — it doesn't
  cascade into child `Frame` backgrounds, so fade per-dot. ~30–40 dots in a clipped container is enough.

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
