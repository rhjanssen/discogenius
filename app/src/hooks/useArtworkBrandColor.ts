import { useEffect, useMemo } from "react";
import { dominantUltraBlurColor } from "@/providers/DynamicBrandProvider";
import { useUltraBlurContext } from "@/providers/UltraBlurContext";
import { useTheme } from "@/providers/themeContext";

interface UseArtworkBrandColorOptions {
  /**
   * Cover URL for ambience.
   * - string: apply this artwork
   * - null: page resolved and has no cover — clear to theme defaults when ownsAmbience
   * - undefined: still loading — hold the previous page's ultrablur (no neutral dip)
   */
  artworkUrl?: string | null;
  brandKeyColor?: string | null;
  deriveBrandFromArtwork?: boolean;
  /**
   * When true (album/artist/video detail), clear ambience only once artwork is
   * known missing (`null`). While `artworkUrl` is `undefined` (data still
   * loading), keep the previous blur so artist→album does not flash neutral.
   * List/dashboard pages leave this false.
   */
  ownsAmbience?: boolean;
}

export function useArtworkBrandColor({
  artworkUrl,
  brandKeyColor,
  deriveBrandFromArtwork = false,
  ownsAmbience = false,
}: UseArtworkBrandColorOptions): string | null {
  const { setArtwork, colors } = useUltraBlurContext();
  const { setBrandKeyColor } = useTheme();

  useEffect(() => {
    if (artworkUrl) {
      setArtwork(artworkUrl);
      return;
    }
    // Only clear when the page has settled with no cover. `undefined` means
    // still loading — hold the prior page's ultrablur until the new cover is ready.
    if (ownsAmbience && artworkUrl === null) {
      setArtwork(undefined);
    }
  }, [artworkUrl, ownsAmbience, setArtwork]);

  const resolvedBrandColor = useMemo(() => {
    if (brandKeyColor) {
      return brandKeyColor;
    }

    if (deriveBrandFromArtwork && artworkUrl) {
      return dominantUltraBlurColor(colors);
    }

    return null;
  }, [artworkUrl, brandKeyColor, colors, deriveBrandFromArtwork]);

  useEffect(() => {
    if (!ownsAmbience || artworkUrl === undefined) {
      return;
    }
    setBrandKeyColor(resolvedBrandColor);
  }, [artworkUrl, ownsAmbience, resolvedBrandColor, setBrandKeyColor]);

  return resolvedBrandColor;
}
