---
name: roblox-mcp-pro-plugin
description: Roblox MCP Pro Studio Plugin UI design tokens
colors:
  primary: "#58a6ff"
  primary-hover: "#73b8ff"
  success: "#2ecc71"
  warning: "#f1c40f"
  error: "#e74c3c"
  neutral-white: "#ffffff"
  neutral-muted: "#95a5a6"
typography:
  display:
    fontFamily: "GothamBold"
    fontSize: "15px"
    fontWeight: 700
  title:
    fontFamily: "GothamBold"
    fontSize: "10px"
    fontWeight: 700
  body:
    fontFamily: "Gotham"
    fontSize: "12px"
    fontWeight: 400
  label:
    fontFamily: "GothamMedium"
    fontSize: "11px"
    fontWeight: 500
  code:
    fontFamily: "Code"
    fontSize: "11px"
    fontWeight: 400
rounded:
  sm: "5px"
  md: "8px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "12px"
---

# Design System: Roblox MCP Pro Plugin

## 1. Overview

**Creative North Star: "The Studio-Native Terminal"**

Roblox MCP Pro is integrated directly into the Roblox Studio DockWidget layout. The visual design system matches the active Studio theme (light or dark mode) to look cohesive and native to the professional creator environment. It avoids decorative elements and excessive spacing, prioritizing high information density and developer-centric utility.

**Key Characteristics:**
- Theme-adaptability (seamlessly shifts colors with Studio Theme changes).
- High information density with compact spacing (6px to 12px gaps) and neat alignments.
- Subtle tactile cues on interactions.
- Strong monospace accents for logs and console readouts.

## 2. Colors

The color palette dynamically blends Studio-native guide colors with a vibrant accent color strategy.

### Primary
- **Active Accent** (#58a6ff): Used for primary action buttons, active toggles, and highlighted states.
- **Active Accent Hover** (#73b8ff): Hover state for accent elements.

### Neutral
- **Studio Interface Backgrounds**: Dynamically mapped using `settings().Studio.Theme:GetColor`.
- **Pure White** (#ffffff): Used for text on primary action buttons and active status highlights.
- **Muted Slate** (#95a5a6): Neutral color for offline states and secondary metadata.

### Named Rules
**The Theme-Adaptability Rule.** Never hardcode text or container colors unless they are white/accent elements on a primary button. All interface colors must be fetched dynamically using `Enum.StudioStyleGuideColor`.

## 3. Typography

The typography uses Roblox Studio's built-in fonts, maintaining clear weight contrast and high legibility.

**Display Font:** GothamBold (with Gotham)
**Body Font:** Gotham (with GothamMedium)
**Label/Mono Font:** Code

### Hierarchy
- **Display** (Bold, 15px): Used for the main header title.
- **Title** (Bold, 10px): Used for section card uppercase headings.
- **Body** (Regular, 12px): Standard copy and setting labels.
- **Label** (Medium, 11px): UI options, segmented control buttons, and sub-status text.
- **Code** (Regular, 11px): Monospace font for logs, console rows, and text inputs.

## 4. Elevation

The system is flat by default to fit seamlessly within the DockWidget container. Depth is established through tonal layering (contrast between background and card backgrounds) rather than drop shadows.

### Named Rules
**The Flat-by-Default Rule.** Do not define shadows or glow effects. Layering is achieved solely through card backgrounds and borders to avoid visual noise.

## 5. Components

### Buttons
- **Shape:** Gently rounded (5px radius). Primary buttons have a 6px radius.
- **Primary:** Background color of accent (#58a6ff) with white text, 32px height.
- **Secondary:** Studio button theme color background with dark text, 26px height.

### Cards / Containers
- **Corner Style:** Rounded (8px radius).
- **Background:** Dynamic Studio background theme color.
- **Border:** Subtle 1px border.
- **Internal Padding:** Dense padding (12px).

### Inputs / Fields
- **Style:** Background color matching Studio InputFieldBackground with a 5px corner radius and 28px height.

### Navigation
- **Style:** Uses segmented buttons (5px corner radius) to toggle sync directions.

## 6. Do's and Don'ts

### Do:
- **Do** map all background and text colors to `Enum.StudioStyleGuideColor` to support light/dark modes.
- **Do** keep spacing tight (8px to 12px) to maximize the amount of information displayed in the dock.
- **Do** use uppercase and bold labels for card section headers.

### Don't:
- **Don't** use large card radii above 8px (avoid childish rounding).
- **Don't** use drop shadows or glassmorphism.
- **Don't** write side-stripe borders or gradient texts.
