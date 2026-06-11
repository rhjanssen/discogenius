import { useEffect, useMemo } from "react";
import { dominantUltraBlurColor } from "@/providers/DynamicBrandProvider";
import { useUltraBlurContext } from "@/providers/UltraBlurContext";

interface UseArtworkBrandColorOptions {
  artworkUrl?: string | null;
  brandKeyColor?: string | null;
  deriveBrandFromArtwork?: boolean;
}

export function useArtworkBrandColor({
  artworkUrl,
  brandKeyColor,
  deriveBrandFromArtwork = false,
}: UseArtworkBrandColorOptions): string | null {
  const { setArtwork, colors } = useUltraBlurContext();

  useEffect(() => {
    // Only push real artwork into the global UltraBlur state — and keep the
    // previous ambience alive on unmount. Resetting to the theme default here
    // made the background snap to neutral between page navigations (and on
    // dashboard/settings) while the brand accent persisted, which read as the
    // blur "disappearing" and the next page's blur "popping in".
    if (artworkUrl) {
      setArtwork(artworkUrl);
    }
  }, [artworkUrl, setArtwork]);

  return useMemo(() => {
    if (brandKeyColor) {
      return brandKeyColor;
    }

    if (deriveBrandFromArtwork && artworkUrl) {
      return dominantUltraBlurColor(colors);
    }

    return null;
  }, [artworkUrl, brandKeyColor, colors, deriveBrandFromArtwork]);
}
