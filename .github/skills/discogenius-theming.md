# Discogenius Fluent UI Theming Skill

## Overview
This skill documents the consistent approach for theming in Discogenius using Fluent UI React v9.

## Core Principle
**All styling customizations should be done via theme tokens in `app/src/theme/theme.ts` whenever possible, and runtime theme state should flow through `app/src/providers/FluentThemeProvider.tsx` + `app/src/providers/themeContext.ts`.** This keeps styling centralized and avoids duplicate theme detection.

## Theme Structure

### 1. Brand Colors (`discogeniusTheme`)
The brand color palette (orange gradient) is defined as `BrandVariants` with shades 10-160:
```typescript
export const discogeniusTheme: BrandVariants = {
    10: "#060200",   // Darkest
    ...
    120: "#F67600",  // Primary brand color
    ...
    160: "#FFCEAE"   // Lightest
};
```

### 2. Semantic Colors
Define semantic color constants for specific use cases:
```typescript
// Tidal quality badge colors (custom - not in Fluent UI)
export const tidalBadgeColor = {
    YellowText: "#ffd432",      // Hi-Res 24-bit text
    YellowBackground: "#4d3c00", // Hi-Res 24-bit background
    TealText: "#33ffee",         // Lossless 16-bit text
    TealBackground: "#004d46",   // Lossless 16-bit background
    AtmosText: "#ffffff",        // Dolby Atmos text
    AtmosBackground: "#000000",  // Dolby Atmos background
} as const;
```

### 3. Built-in Fluent UI Palette Tokens
Fluent UI v9 includes status color palettes - use these instead of custom colors:
```typescript
// Badge colors (use color prop)
// - "brand" = Brand orange (our brand)
// - "warning" = Yellow palette (colorPaletteYellow*)
// - "severe" = Dark orange palette (colorPaletteDarkOrange*) 
// - "danger" = Red palette (colorPaletteRed*)
// - "success" = Green palette (colorPaletteGreen*)
// - "informative" = Neutral palette

// Use tokens in makeStyles:
import { tokens } from "@fluentui/react-components";
backgroundColor: tokens.colorPaletteDarkOrangeBackground3,
color: tokens.colorPaletteDarkOrangeForeground1,
```

### 3. Theme Token Overrides
Override Fluent UI tokens in `lightTheme` and `darkTheme` only when needed:
```typescript
export const lightTheme: Theme = {
    ...baseLightTheme,
    // Brand colors for buttons, links
    colorBrandForeground1: discogeniusTheme[120],
    colorBrandBackground: discogeniusTheme[120],
    // Compound brand for Switch, Radio, Checkbox
    colorCompoundBrandBackground: discogeniusTheme[120],
};
```

**Only override tokens when:**
- The default brand shade doesn't look right
- You need input controls (Switch, Radio) to use brand color
- A specific component needs a different shade

### 4. Theme State Ownership
- `app/src/providers/FluentThemeProvider.tsx` owns the current theme mode and dynamic brand key color.
- `app/src/providers/themeContext.ts` exposes `useTheme()` for consumers.
- Layout and page components should read `isDarkMode` from `useTheme()` instead of observing DOM classes or `prefers-color-scheme` directly.
- Dynamic page-level brand overrides should go through `setBrandKeyColor()` rather than ad hoc theme generation.

## When to Use Each Approach

### ✅ Use Built-in Badge Colors When:
- You need standard status colors (warning, danger, success)
- Use `color="severe"` for orange warnings (better contrast than "warning")
- Use `color="brand"` for brand-colored badges

### ✅ Use Theme Token Overrides When:
- The default brand shade doesn't match your brand
- Input controls need brand colors (Switch, Radio, Checkbox)

### ✅ Use Semantic Color Constants When:
- The color has a specific meaning not in Fluent UI (Tidal quality badges)
- Multiple components need the exact same custom color

### ✅ Use Component-Level `makeStyles` When:
- Layout/positioning specific to one component
- Size adjustments
- Custom colors that don't fit any semantic meaning

### ❌ Avoid:
- Inline `style` props for colors (use tokens or makeStyles)
- Creating custom status colors when Fluent UI has built-in options
- Overriding palette tokens unless absolutely necessary
- Duplicating dark-mode detection or `theme-color` ownership across multiple components

## Fluent UI v9 Token Categories

### Color Tokens
- `colorBrand*` - Primary brand colors
- `colorNeutral*` - Grays and neutrals
- `colorPalette*` - Status colors (red, green, yellow, etc.)
- `colorCompoundBrand*` - Checked states for inputs

### Spacing Tokens
- `spacingHorizontal*` / `spacingVertical*`
- Use instead of hardcoded px values

### Typography Tokens
- `fontFamily*`, `fontSize*`, `fontWeight*`, `lineHeight*`

### Border Tokens
- `borderRadius*`, `strokeWidth*`

## Example: Adding a New Status Color

1. **Define the color constant** (if it's semantic):
```typescript
// In theme.ts
export const myStatusColor = {
    light: { background: "#...", text: "#..." },
    dark: { background: "#...", text: "#..." }
} as const;
```

2. **Override palette tokens** (if it maps to Fluent semantics):
```typescript
export const lightTheme: Theme = {
    ...baseLightTheme,
    colorPaletteYellowBackground2: myStatusColor.light.background,
    colorPaletteYellowForeground2: myStatusColor.light.text,
};
```

3. **Use in components** via `makeStyles` referencing tokens:
```typescript
const useStyles = makeStyles({
    warningBadge: {
        backgroundColor: tokens.colorPaletteYellowBackground2,
        color: tokens.colorPaletteYellowForeground2,
    },
});
```

## Quality Badge Color Mapping (Tidal)
- **LOSSLESS (16-bit)**: Teal (`tidalBadgeColor.Teal*`)
- **HIRES_LOSSLESS (24-bit)**: Yellow/Gold (`tidalBadgeColor.Yellow*`)
- **DOLBY_ATMOS**: Black (`tidalBadgeColor.Atmos*`) - detected via `channels > 2`
- **HIGH/NORMAL (AAC)**: Neutral gray (tokens.colorNeutralBackground3)

### Quality Detection Logic
```typescript
// Atmos is detected by multi-channel audio (6+ channels typically)
const isMultiChannel = channels && channels > 2;
if (quality === "DOLBY_ATMOS" || isMultiChannel) {
    // Use Atmos styling
}

// Quality labels include codec: "24-bit/96kHz FLAC"
let label = `${bitDepth}-bit/${sampleRate}kHz`;
if (codec) label += ` ${codec.toUpperCase()}`;
```

## References
- [Fluent UI React v9 Theme Tokens](https://react.fluentui.dev/?path=/docs/theme-colors--page)
- [Fluent UI Color Tokens](https://react.fluentui.dev/?path=/docs/theme-color--page)
