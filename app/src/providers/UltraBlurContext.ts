import { createContext, useContext } from "react";
import type { UltraBlurColors } from "@/ultrablur/colors";

export interface UltraBlurContextValue {
  /** Current background colors */
  colors: UltraBlurColors;
  /** Optional artwork URL for blurred background layer */
  artworkUrl?: string;
  /** Set the current artwork (triggers color extraction) */
  setArtwork: (url?: string) => void;
  /** Loading state for color extraction */
  isLoading: boolean;
  /** Whether the app is in dark mode */
  isDarkMode: boolean;
}

export const UltraBlurContext = createContext<UltraBlurContextValue | undefined>(undefined);

export function useUltraBlurContext() {
  const context = useContext(UltraBlurContext);

  if (context === undefined) {
    throw new Error("useUltraBlurContext must be used within UltraBlurProvider");
  }

  return context;
}
