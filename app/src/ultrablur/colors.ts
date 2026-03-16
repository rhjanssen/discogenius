import { discogeniusLogoColor } from "@/theme/theme";

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
 * @param _isDarkMode - Unused, kept for API compatibility
 * @returns UltraBlurColors based on the brand seed colors
 */
export function getThemeDefaultColors(_isDarkMode: boolean): UltraBlurColors {
  // Same colors for both themes - the overlay layer handles light/dark adaptation.
  if (_isDarkMode) {
    return {
      topLeft: "#0a0c10",
      topRight: "#12141a",
      bottomLeft: "#08090c",
      bottomRight: "#15181e",
    };
  }
  return {
    topLeft: "#e0e3e8",
    topRight: "#ebedf0",
    bottomLeft: "#d8dce2",
    bottomRight: "#f4f5f7",
  };
}
