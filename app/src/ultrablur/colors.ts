export interface UltraBlurColors {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
}

/**
 * Generate default colors for UltraBlur background
 * Uses the Discogenius logo colors.
 * 
 * NOTE: The same colors are used for both light and dark mode.
 * Theme adaptation is handled by the overlay layer in UltraBlurBackground.tsx
 * (overlayDark/overlayLight, vignette, noise, etc.)
 * 
 * @param _isDarkMode - Whether the active Fluent theme is dark
 * @returns UltraBlurColors based on the brand seed colors
 */
export function getThemeDefaultColors(_isDarkMode: boolean): UltraBlurColors {
  // Same colors for both themes - the overlay layer handles light/dark adaptation.
  if (_isDarkMode) {
    return {
      topLeft: "#20125f",
      topRight: "#071f3d",
      bottomLeft: "#1238e8",
      bottomRight: "#8f243d",
    };
  }
  return {
    topLeft: "#d9ccff",
    topRight: "#b8f0ff",
    bottomLeft: "#6f8dff",
    bottomRight: "#ffc0a0",
  };
}
