/** Shared badge size tokens — provider pills and quality chips must match. */
export type DiscogeniusBadgeSize = "small" | "medium" | "large";

/**
 * Outer height for every badge in a size group (Fluent small/medium/large).
 * Provider circular marks and QualityBadge chips both use these values so a
 * TIDAL mark and a MAX chip line up in the same ProviderQualityRow.
 */
export const BADGE_HEIGHT_PX: Record<DiscogeniusBadgeSize, number> = {
  small: 16,
  medium: 20,
  large: 24,
};

/** Glyph size inside a circular provider mark (slightly inset from the pill). */
export const PROVIDER_GLYPH_SIZE_PX: Record<DiscogeniusBadgeSize, number> = {
  small: 12,
  medium: 14,
  large: 16,
};

/** Dolby Atmos lockup height inside a quality badge of the given size. */
export const ATMOS_LOGO_HEIGHT_PX: Record<DiscogeniusBadgeSize, number> = {
  small: 10,
  medium: 12,
  large: 14,
};
