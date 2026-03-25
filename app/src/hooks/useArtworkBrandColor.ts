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
    setArtwork(artworkUrl || undefined);
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
