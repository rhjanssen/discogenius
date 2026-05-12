import { useState, useMemo, ReactNode, useCallback } from 'react';
import { getThemeDefaultColors } from '@/ultrablur/colors';
import { useUltraBlur } from '@/ultrablur/useUltraBlur';
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
  const { isDarkMode } = useTheme();

  // Get theme-aware default colors — memoised so the reference stays stable
  // and downstream effects don't re-fire on every render.
  const defaultColors = useMemo(() => getThemeDefaultColors(isDarkMode), [isDarkMode]);

  // Extract colors from current artwork
  const { colors: extractedColors, isLoading } = useUltraBlur({
    imageUrl: artworkUrl,
    enabled: !!artworkUrl,
  });

  // Use extracted colors if we have artwork, otherwise use theme defaults.
  // Memoised to keep a stable reference when values haven't changed.
  const colors = useMemo(
    () => (artworkUrl ? extractedColors : defaultColors),
    [artworkUrl, extractedColors, defaultColors],
  );

  const setArtwork = useCallback((url?: string) => {
    setArtworkUrl(url);
  }, []);

  const value: UltraBlurContextValue = {
    colors,
    artworkUrl,
    setArtwork,
    isLoading,
    isDarkMode,
  };

  return (
    <UltraBlurContext.Provider value={value}>
      {children}
    </UltraBlurContext.Provider>
  );
}
