import { useState, useMemo, ReactNode, useCallback, useRef } from 'react';
import { getThemeDefaultColors, type UltraBlurColors } from '@/ultrablur/colors';
import { useUltraBlur, seedUltraBlurColorCache } from '@/ultrablur/useUltraBlur';
import { extractUltraBlurColorsFromImage, ultrablurSourceUrl } from '@/ultrablur/extractColorsFromImage';
import { UltraBlurContext, type UltraBlurContextValue } from '@/providers/UltraBlurContext';
import { useTheme } from '@/providers/themeContext';

interface UltraBlurProviderProps {
  children: ReactNode;
}

/**
 * Provider for global UltraBlur background state
 * Manages the current artwork and extracted colors for the app background
 * Uses theme-aware default colors when no artwork is provided
 */
export function UltraBlurProvider({ children }: UltraBlurProviderProps) {
  const [artworkUrl, setArtworkUrl] = useState<string | undefined>(undefined);
  // Hero onLoad can seed a palette for the same URL while useUltraBlur is still
  // loading cover-250 (or holding the previous page). Prefer the hero sample so
  // video thumbnails don't keep an artist/album blue ambience.
  const [heroOverride, setHeroOverride] = useState<{ url: string; colors: UltraBlurColors } | null>(null);
  const { isDarkMode } = useTheme();

  // Get theme-aware default colors — memoised so the reference stays stable
  // and downstream effects don't re-fire on every render.
  const defaultColors = useMemo(() => getThemeDefaultColors(isDarkMode), [isDarkMode]);

  // Extract colors from current artwork (cache hit is instant after hero onLoad seeds it)
  const { colors: extractedColors, isLoading } = useUltraBlur({
    imageUrl: artworkUrl,
    enabled: !!artworkUrl,
  });

  // Hold the last good palette across navigations while the next cover extracts
  // (artist → album must not dip to theme-neutral defaults mid-flight).
  const stickyColorsRef = useRef<UltraBlurColors>(defaultColors);
  const colors = useMemo(() => {
    if (!artworkUrl) {
      stickyColorsRef.current = defaultColors;
      return defaultColors;
    }
    if (heroOverride && heroOverride.url === artworkUrl) {
      stickyColorsRef.current = heroOverride.colors;
      return heroOverride.colors;
    }
    if (isLoading) {
      return stickyColorsRef.current;
    }
    stickyColorsRef.current = extractedColors;
    return extractedColors;
  }, [artworkUrl, extractedColors, defaultColors, heroOverride, isLoading]);

  const setArtwork = useCallback((url?: string) => {
    setHeroOverride((prev) => (prev && prev.url === url ? prev : null));
    setArtworkUrl(url);
  }, []);

  const setArtworkFromImage = useCallback((url: string, image: HTMLImageElement) => {
    const normalized = String(url || "").trim();
    if (!normalized) return;

    const applyExtracted = (extracted: UltraBlurColors | null) => {
      if (!extracted) return false;
      seedUltraBlurColorCache(normalized, extracted);
      seedUltraBlurColorCache(ultrablurSourceUrl(normalized), extracted);
      setHeroOverride({ url: normalized, colors: extracted });
      return true;
    };

    if (!applyExtracted(extractUltraBlurColorsFromImage(image))) {
      // Hero may have loaded without CORS (tainted canvas). Reload once with
      // crossOrigin so we still seed immediately instead of waiting on a
      // separate useUltraBlur fetch / media-cover resolve.
      const reload = new Image();
      reload.crossOrigin = "anonymous";
      reload.decoding = "async";
      reload.onload = () => {
        applyExtracted(extractUltraBlurColorsFromImage(reload));
      };
      reload.src = normalized;
    }
    setArtworkUrl(normalized);
  }, []);

  const value: UltraBlurContextValue = {
    colors,
    artworkUrl,
    setArtwork,
    setArtworkFromImage,
    isLoading,
    isDarkMode,
  };

  return (
    <UltraBlurContext.Provider value={value}>
      {children}
    </UltraBlurContext.Provider>
  );
}
