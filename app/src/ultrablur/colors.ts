export interface UltraBlurColors {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
}

/**
 * Default UltraBlur corner colours when no artwork is set (e.g. Library root).
 * Use chromatic logo-adjacent seeds — not greys — so the Fluent brand remap
 * still produces a tinted wash instead of a muddy neutral field.
 * Theme smoked-glass dimming lives in `renderUltraBlurDataUrl`.
 */
export function getThemeDefaultColors(isDarkMode: boolean): UltraBlurColors {
  if (isDarkMode) {
    return {
      topLeft: "#1a0f2e",
      topRight: "#0d1a2e",
      bottomLeft: "#1a1208",
      bottomRight: "#0a1a1c",
    };
  }
  return {
    topLeft: "#fc7134",
    topRight: "#8532ce",
    bottomLeft: "#2353ca",
    bottomRight: "#00bddf",
  };
}
