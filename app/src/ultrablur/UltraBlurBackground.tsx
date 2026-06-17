import { makeStyles, mergeClasses, shorthands, tokens } from "@fluentui/react-components";
import { UltraBlurColors } from "@/ultrablur/colors";
import { getApiBaseUrl } from "@/utils/apiBaseUrl";
import { useEffect, useMemo, useRef, useState } from "react";

const useStyles = makeStyles({
  container: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 0,
    pointerEvents: "none",
    ...shorthands.overflow("hidden"),
  },
  layer: {
    position: "absolute",
    inset: 0,
    backgroundSize: "cover",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    transform: "scale(1.02)",
    // Only opacity animates (the cross-fade). The colour-tuning `filter` is set
    // inline and is static, so it does NOT belong in will-change.
    willChange: "opacity",
  },
  // NOTE: the colour tuning (saturate/brightness/contrast) used to live here as a
  // full-viewport `backdrop-filter`, which forced the GPU to re-sample and
  // re-filter the entire backdrop on every repaint (the app repaints constantly
  // from queue SSE updates) — a constant GPU-load sink. The gradient image is
  // static, so the same tuning is now applied as a plain `filter` on the image
  // layer (rasterised once, GPU-cached). These overlays now only paint their
  // vignette gradients.
  overlayDark: {
    backgroundImage:
      `radial-gradient(circle at 50% 35%, transparent 0%, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 32%, transparent) 70%, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 55%, transparent) 100%), linear-gradient(180deg, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 16%, transparent) 0%, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 42%, transparent) 100%)`,
  },
  overlayLight: {
    backgroundImage:
      `radial-gradient(circle at 50% 35%, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 28%, transparent) 0%, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 70%, transparent) 70%, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 90%, transparent) 100%), linear-gradient(180deg, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 70%, transparent) 0%, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 88%, transparent) 100%)`,
  },
  overlay: {
    position: "absolute",
    inset: 0,
    zIndex: 1,
    pointerEvents: "none",
  },
});

interface UltraBlurBackgroundProps {
  colors: UltraBlurColors;
  isDarkMode: boolean;
  transitionDuration?: number;
}

// Generate the gradient at (roughly) the client's physical screen resolution
// instead of a fixed 1280×720 that the browser then upscales. The image is a
// smooth gradient so it compresses tiny and is cached immutable per colour set;
// we use the *screen* size (stable across window resizes, so no refetch) and a
// QHD ceiling so the server-side per-pixel generation stays cheap. Anything
// above the cap is a sub-pixel-smooth upscale of a gradient — imperceptible.
const ULTRABLUR_MAX = { width: 2560, height: 1440 };
function computeUltraBlurSize(): { width: number; height: number } {
  if (typeof window === "undefined" || !window.screen) {
    return { width: 1920, height: 1080 };
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.min(ULTRABLUR_MAX.width, Math.max(640, Math.round(window.screen.width * dpr)));
  const height = Math.min(ULTRABLUR_MAX.height, Math.max(360, Math.round(window.screen.height * dpr)));
  return { width, height };
}

export function UltraBlurBackground(props: UltraBlurBackgroundProps) {
  const styles = useStyles();

  const [frontUrl, setFrontUrl] = useState<string | null>(null);
  const [backUrl, setBackUrl] = useState<string | null>(null);
  const [frontVisible, setFrontVisible] = useState(true);
  /** When true, the opacity change to 0 is instant (no CSS transition). */
  const [skipTransition, setSkipTransition] = useState(false);

  const frontRef = useRef<string | null>(null);
  const backRef = useRef<string | null>(null);
  const cleanupTimerRef = useRef<number | null>(null);

  useEffect(() => {
    frontRef.current = frontUrl;
  }, [frontUrl]);

  useEffect(() => {
    backRef.current = backUrl;
  }, [backUrl]);

  useEffect(() => {
    return () => {
      if (cleanupTimerRef.current) {
        window.clearTimeout(cleanupTimerRef.current);
      }
    };
  }, []);

  const { colors } = props;
  const transitionMs = props.transitionDuration ?? 500;
  // Colour tuning applied directly to the static gradient image (replaces the old
  // full-viewport backdrop-filter). Same values as before, just rasterised once.
  const layerFilter = props.isDarkMode
    ? "saturate(0.9) brightness(0.8) contrast(1.06)"
    : "saturate(0.75) brightness(1.05) contrast(0.98)";
  const key = useMemo(() => {
    return `${colors.topLeft}|${colors.topRight}|${colors.bottomLeft}|${colors.bottomRight}`;
  }, [colors]);

  useEffect(() => {
    let cancelled = false;

    function run() {
      const { width, height } = computeUltraBlurSize();
      const params = new URLSearchParams({
        topLeft: colors.topLeft,
        topRight: colors.topRight,
        bottomLeft: colors.bottomLeft,
        bottomRight: colors.bottomRight,
        width: String(width),
        height: String(height),
      });
      const url = `${getApiBaseUrl()}/services/ultrablur/image?${params.toString()}`;
      if (cancelled) {
        return;
      }

      const prevBack = backRef.current;
      if (prevBack) {
        backRef.current = null;
        setBackUrl(null);
      }

      const previousFront = frontRef.current;
      if (previousFront) {
        setBackUrl(previousFront);
      }

      // Instantly snap front to opacity 0 (no CSS transition) and set new image
      setSkipTransition(true);
      setFrontVisible(false);
      setFrontUrl(url);

      // Wait two frames so the browser commits the opacity-0 state, then
      // re-enable the CSS transition and fade front in.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!cancelled) {
            setSkipTransition(false);
            setFrontVisible(true);
          }
        });
      });

      if (cleanupTimerRef.current) {
        window.clearTimeout(cleanupTimerRef.current);
      }
      cleanupTimerRef.current = window.setTimeout(() => {
        backRef.current = null;
        setBackUrl(null);
      }, transitionMs + 50);
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [key, transitionMs]);

  return (
    <div className={styles.container}>
      {backUrl && (
        <div
          className={styles.layer}
          style={{
            backgroundImage: `url("${backUrl}")`,
            opacity: 1,
            filter: layerFilter,
          }}
        />
      )}

      {frontUrl && (
        <div
          className={styles.layer}
          style={{
            backgroundImage: `url("${frontUrl}")`,
            opacity: frontVisible ? 1 : 0,
            filter: layerFilter,
            transition: skipTransition
              ? "none"
              : `opacity ${transitionMs}ms ease-in-out`,
          }}
        />
      )}

      <div className={mergeClasses(styles.overlay, props.isDarkMode ? styles.overlayDark : styles.overlayLight)} />
    </div>
  );
}
