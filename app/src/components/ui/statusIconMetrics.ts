import type { CSSProperties } from "react";

export type StatusIconWeight = "color" | "filled" | "regular";

/** Optical compensation for Color, Filled, and Regular artwork in the same fixed slot. */
const GLYPH_PX = {
    color: { 16: 18.5, 24: 24 },
    filled: { 16: 16, 24: 24 },
    regular: { 16: 16, 24: 24 },
} as const;

export function statusIconGlyphPx(weight: StatusIconWeight, size: 16 | 24 = 16): number {
    return GLYPH_PX[weight][size];
}

export function statusIconGlyphStyle(weight: StatusIconWeight, size: 16 | 24 = 16): CSSProperties {
    const px = statusIconGlyphPx(weight, size);
    return { width: px, height: px };
}
