import type { CSSProperties } from "react";

export type StatusIconWeight = "color" | "filled";

/** Optical compensation for Color and Filled artwork in the same fixed slot. */
const GLYPH_PX = {
    color: { 16: 17, 24: 25 },
    filled: { 16: 15, 24: 22 },
} as const;

export function statusIconGlyphPx(weight: StatusIconWeight, size: 16 | 24 = 16): number {
    return GLYPH_PX[weight][size];
}

export function statusIconGlyphStyle(weight: StatusIconWeight, size: 16 | 24 = 16): CSSProperties {
    const px = statusIconGlyphPx(weight, size);
    return { width: px, height: px };
}
