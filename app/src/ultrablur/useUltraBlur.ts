import { useState, useEffect, useRef } from 'react';
import { UltraBlurColors, getThemeDefaultColors } from '@/ultrablur/colors';
import { getApiBaseUrl } from '@/utils/apiBaseUrl';

interface UseUltraBlurOptions {
  imageUrl?: string;
  enabled?: boolean;
}

interface UseUltraBlurResult {
  colors: UltraBlurColors;
  isLoading: boolean;
  error: Error | null;
}

// Cache for extracted colors to avoid re-processing
const colorCache = new Map<string, UltraBlurColors>();

/**
 * Hook to extract and manage UltraBlur colors from images
 * 
 * @param options.imageUrl - URL of the image to extract colors from
 * @param options.enabled - Whether to extract colors (default: true)
 * @returns colors, loading state, and error
 * 
 * @example
 * ```tsx
 * const { colors, isLoading } = useUltraBlur({
 *   imageUrl: albumArt,
 *   enabled: !!albumArt
 * });
 * ```
 */
export function useUltraBlur({ 
  imageUrl, 
  enabled = true 
}: UseUltraBlurOptions = {}): UseUltraBlurResult {
  // Detect dark mode for theme-aware defaults
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof window === 'undefined') return true;
    return document.documentElement.classList.contains('dark') ||
      (!document.documentElement.classList.contains('light') &&
       window.matchMedia('(prefers-color-scheme: dark)').matches);
  });
  
  const [colors, setColors] = useState<UltraBlurColors>(() => getThemeDefaultColors(isDarkMode));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Listen for theme changes
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
      attributeFilter: ['class']
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
    
    // If no image URL or extraction disabled, use theme-aware default colors
    if (!imageUrl || !enabled) {
      setColors(defaultColors);
      setIsLoading(false);
      setError(null);
      return;
    }

    // Check cache first
    if (colorCache.has(imageUrl)) {
      const cachedColors = colorCache.get(imageUrl)!;
      setColors(cachedColors);
      setIsLoading(false);
      setError(null);
      return;
    }

    // Cancel any pending extraction
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create new abort controller for this request
    abortControllerRef.current = new AbortController();
    const currentAbortController = abortControllerRef.current;

    // Extract colors from the image
    setIsLoading(true);
    setError(null);

    const apiBaseUrl = getApiBaseUrl();

    // Plex-aligned flow only: always ask the backend service to extract colors.
    // If it fails, fall back to theme defaults (no client-side extraction).
    const colorsUrl = `${apiBaseUrl}/services/ultrablur/colors?url=${encodeURIComponent(imageUrl)}`;

    fetch(colorsUrl, { signal: currentAbortController.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`UltraBlur colors service error: ${r.status}`);
        const data = await r.json();
        const maybeColors: UltraBlurColors = {
          topLeft: data?.topLeft,
          topRight: data?.topRight,
          bottomLeft: data?.bottomLeft,
          bottomRight: data?.bottomRight,
        };
        if (!maybeColors.topLeft || !maybeColors.topRight || !maybeColors.bottomLeft || !maybeColors.bottomRight) {
          throw new Error('UltraBlur colors service returned invalid payload');
        }
        return maybeColors;
      })
      .then((extractedColors) => {
        if (currentAbortController.signal.aborted) return;
        colorCache.set(imageUrl, extractedColors);
        setColors(extractedColors);
        setIsLoading(false);
      })
      .catch((err) => {
        if (currentAbortController.signal.aborted) return;
        console.error('Failed to extract UltraBlur colors:', err);
        setError(err);
        setColors(defaultColors);
        setIsLoading(false);
      });

    // Cleanup function
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [imageUrl, enabled, isDarkMode]);

  return { colors, isLoading, error };
}

/**
 * Clear the color extraction cache
 * Useful for memory management or forcing re-extraction
 */
export function clearUltraBlurCache() {
  colorCache.clear();
}

/**
 * Pre-cache colors for multiple images
 * Useful for pre-loading colors for a list of albums
 */
export async function precacheUltraBlurColors(imageUrls: string[]): Promise<void> {
  const apiBaseUrl = getApiBaseUrl();

  const promises = imageUrls
    .filter(url => !colorCache.has(url))
    .map(async (url) => {
      try {
        const colorsUrl = `${apiBaseUrl}/services/ultrablur/colors?url=${encodeURIComponent(url)}`;

        const r = await fetch(colorsUrl);
        if (!r.ok) throw new Error(String(r.status));
        const data = await r.json();
        const colors: UltraBlurColors = {
          topLeft: data?.topLeft,
          topRight: data?.topRight,
          bottomLeft: data?.bottomLeft,
          bottomRight: data?.bottomRight,
        };

        if (!colors.topLeft || !colors.topRight || !colors.bottomLeft || !colors.bottomRight) {
          throw new Error('invalid payload');
        }

        colorCache.set(url, colors);
      } catch (err) {
        console.error(`Failed to precache colors for ${url}:`, err);
      }
    });

  await Promise.all(promises);
}
