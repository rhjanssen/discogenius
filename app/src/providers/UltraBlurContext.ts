import { createContext, useContext } from "react";
import type { UltraBlurColors } from "@/ultrablur/colors";

export interface UltraBlurContextValue {
  /** Current background colors */
  colors: UltraBlurColors;
  /** Optional artwork URL for blurred background layer */
  artworkUrl?: string;
  /** Set the current artwork (triggers color extraction; uses cache when seeded) */
  setArtwork: (url?: string) => void;
  /**
   * Prefer on detail heroes: one-shot client extract from the painted image so
   * ultrablur switches with the cover (no backend /colors round-trip).
   */
  setArtworkFromImage: (url: string, image: HTMLImageElement) => void;
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
