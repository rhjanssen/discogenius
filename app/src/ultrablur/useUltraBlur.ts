import { useState, useEffect, useRef } from 'react';
import { UltraBlurColors, getThemeDefaultColors } from '@/ultrablur/colors';
import { extractUltraBlurColorsFromImage, ultrablurSourceUrl } from '@/ultrablur/extractColorsFromImage';

interface UseUltraBlurOptions {
  imageUrl?: string;
  enabled?: boolean;
}

interface UseUltraBlurResult {
  colors: UltraBlurColors;
  isLoading: boolean;
  error: Error | null;
}

// Cache for extracted colors to avoid re-processing.
// Bump key prefix when extraction/bake algorithm changes so old muddy palettes
// are not reused across a hot reload of the SPA shell.
const COLOR_CACHE_VERSION = "ub8";
const colorCache = new Map<string, UltraBlurColors>();

function cacheKey(imageUrl: string): string {
  return `${COLOR_CACHE_VERSION}:${imageUrl}`;
}

/** Seed the client cache (e.g. from hero img onLoad) so ambience skips a second decode. */
export function seedUltraBlurColorCache(imageUrl: string, colors: UltraBlurColors): void {
  const key = String(imageUrl || "").trim();
  if (!key || !colors?.topLeft) return;
  colorCache.set(cacheKey(key), colors);
}

/**
 * Extract UltraBlur colours entirely in the browser (no backend round-trip).
 * Prefer seeding via setArtworkFromImage on hero onLoad (and complete-ref);
 * this hook only loads the image when only a URL is available.
 */
export function useUltraBlur({
  imageUrl,
  enabled = true,
}: UseUltraBlurOptions = {}): UseUltraBlurResult {
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof window === 'undefined') return true;
    return document.documentElement.classList.contains('dark') ||
      (!document.documentElement.classList.contains('light') &&
       window.matchMedia('(prefers-color-scheme: dark)').matches);
  });

  const [colors, setColors] = useState<UltraBlurColors>(() => getThemeDefaultColors(isDarkMode));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef(0);

  useEffect(() => {
    const checkTheme = () => {
      const isDark = document.documentElement.classList.contains('dark') ||
        (!document.documentElement.classList.contains('light') &&
         window.matchMedia('(prefers-color-scheme: dark)').matches);
      setIsDarkMode(isDark);
    };

    const observer = new MutationObserver(checkTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', checkTheme);

    return () => {
      observer.disconnect();
      mediaQuery.removeEventListener('change', checkTheme);
    };
  }, []);

  useEffect(() => {
    const defaultColors = getThemeDefaultColors(isDarkMode);
    const generation = ++abortRef.current;

    if (!imageUrl || !enabled) {
      setColors(defaultColors);
      setIsLoading(false);
      setError(null);
      return;
    }

    // Same URL as the hero so a cache/HTTP hit is shared (no cover-250 detour).
    const loadUrl = ultrablurSourceUrl(imageUrl);

    if (colorCache.has(cacheKey(imageUrl)) || colorCache.has(cacheKey(loadUrl))) {
      setColors(colorCache.get(cacheKey(imageUrl)) ?? colorCache.get(cacheKey(loadUrl))!);
      setIsLoading(false);
      setError(null);
      return;
    }

    // Keep the previous palette visible while the new cover loads — do not
    // snap to theme defaults between artist/album/video navigations.
    setIsLoading(true);
    setError(null);

    const img = new Image();
    img.decoding = "async";
    if (!loadUrl.startsWith("data:") && !loadUrl.startsWith("blob:")) {
      img.crossOrigin = "anonymous";
    }

    const finish = (extracted: UltraBlurColors | null, err?: Error) => {
      if (abortRef.current !== generation) return;
      if (extracted) {
        colorCache.set(cacheKey(imageUrl), extracted);
        colorCache.set(cacheKey(loadUrl), extracted);
        setColors(extracted);
        setError(null);
      } else {
        setColors(defaultColors);
        setError(err || new Error("Failed to extract UltraBlur colors"));
      }
      setIsLoading(false);
    };

    img.onload = () => {
      try {
        finish(extractUltraBlurColorsFromImage(img));
      } catch (e) {
        finish(null, e as Error);
      }
    };
    img.onerror = () => finish(null, new Error("UltraBlur image failed to load"));
    img.src = loadUrl;

    return () => {
      abortRef.current += 1;
      img.onload = null;
      img.onerror = null;
    };
  }, [imageUrl, enabled, isDarkMode]);

  return { colors, isLoading, error };
}

export function clearUltraBlurCache() {
  colorCache.clear();
}

export async function precacheUltraBlurColors(imageUrls: string[]): Promise<void> {
  await Promise.all(
    imageUrls
      .filter((url) => url && !colorCache.has(cacheKey(url)))
      .map(
        (url) =>
          new Promise<void>((resolve) => {
            const loadUrl = ultrablurSourceUrl(url);
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
              const extracted = extractUltraBlurColorsFromImage(img);
              if (extracted) {
                colorCache.set(cacheKey(url), extracted);
                colorCache.set(cacheKey(loadUrl), extracted);
              }
              resolve();
            };
            img.onerror = () => resolve();
            img.src = loadUrl;
          }),
      ),
  );
}
