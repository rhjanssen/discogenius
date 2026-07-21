import type { DiscogeniusBadgeSize } from "./badgeSizes";

/** Shared glass alpha for quality pills, provider glyph chips, and explicit marks.
 * Fluent's colorNeutralBackgroundAlpha* tokens target large Mica/layer surfaces
 * (~50% light / ~30% dark). Small chips on cover art need higher fill for contrast. */
export const BADGE_GLASS_ALPHA = {
  dark: 0.70,
  light: 0.80,
} as const;
export function transparentHex(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  if (!/^[\da-f]{6}$/i.test(normalized)) {
    return hex;
  }
  const value = Number.parseInt(normalized, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function badgeGlassAlpha(isDarkMode: boolean): number {
  return isDarkMode ? BADGE_GLASS_ALPHA.dark : BADGE_GLASS_ALPHA.light;
}

export function badgeGlassFill(hex: string, isDarkMode: boolean): string {
  return transparentHex(hex, badgeGlassAlpha(isDarkMode));
}

/**
 * Dolby Atmos SVG viewBox is optically top-heavy (content ends ~y=12 of 15.6).
 * Nudge the mask down so it reads centered inside the pill at every size.
 */
export const ATMOS_OPTICAL_NUDGE_PX: Record<DiscogeniusBadgeSize, number> = {
  small: 1,
  medium: 1,
  large: 1.5,
};
