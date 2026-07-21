import { useCallback, type RefCallback, type SyntheticEvent } from "react";
import { useUltraBlurContext } from "@/providers/UltraBlurContext";

/**
 * Wire a detail-page hero <img> to UltraBlur.
 *
 * Cached images often finish before React attaches `onLoad`, so we also sample
 * when the element is already `complete`. `crossOrigin` must be set before
 * `src` for canvas sampling — callers should put `crossOrigin="anonymous"` on
 * the img (same-origin /media-cover stays safe).
 */
export function useUltraBlurHero(imageUrl: string | null | undefined) {
  const { setArtworkFromImage } = useUltraBlurContext();
  const url = String(imageUrl || "").trim() || null;

  const apply = useCallback(
    (image: HTMLImageElement | null) => {
      if (!url || !image || !image.naturalWidth) return;
      setArtworkFromImage(url, image);
    },
    [url, setArtworkFromImage],
  );

  const ref = useCallback<RefCallback<HTMLImageElement>>(
    (node) => {
      if (node?.complete) apply(node);
    },
    [apply],
  );

  const onLoad = useCallback(
    (event: SyntheticEvent<HTMLImageElement>) => {
      apply(event.currentTarget);
    },
    [apply],
  );

  return {
    /** Spread onto the hero <img> after `src`. */
    heroProps: {
      crossOrigin: "anonymous" as const,
      decoding: "async" as const,
      ref,
      onLoad,
    },
  };
}
