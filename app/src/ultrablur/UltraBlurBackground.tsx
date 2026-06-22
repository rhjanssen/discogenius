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
    // Scaled up so the inline CSS blur can't pull the viewport edges in and reveal
    // a soft transparent border — the container clips the overflow.
    transform: "scale(1.12)",
    // Only opacity animates (the cross-fade); the colour-tuning + blur `filter` is
    // static, so it stays out of will-change.
    willChange: "opacity",
  },
  // Colour tuning lives as a plain `filter` on the static image layer (see
  // layerFilter), not as a `backdrop-filter` here — a full-viewport backdrop
  // filter re-samples on every repaint and is a constant GPU-load sink. These
  // overlays only paint the vignette gradient.
  overlayDark: {
    backgroundImage:
      `radial-gradient(circle at 50% 35%, transparent 0%, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 36%, transparent) 70%, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 60%, transparent) 100%), linear-gradient(180deg, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 20%, transparent) 0%, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 48%, transparent) 100%)`,
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

// Plex-style UltraBlur: request a TINY gradient and blur it client-side rather
// than shipping a screen-sized image. A 4-corner gradient carries no high-
// frequency detail, so a 320×180 PNG (a few KB, cached immutable per colour set)
// upscaled with `background-size: cover` + a CSS `blur()` looks identical to a
// 4K render — at a fraction of the payload and zero heavy server-side rendering.
const ULTRABLUR_SIZE = { width: 320, height: 180 };

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
  // Colour tuning + the Plex-style blur, applied directly to the static gradient
  // image (a plain `filter`, rasterised once — NOT a backdrop-filter). The blur
  // smooths the upscaled low-res gradient into a soft wash.
  const layerFilter = props.isDarkMode
    ? "blur(24px) saturate(0.98) brightness(0.74) contrast(1.1)"
    : "blur(24px) saturate(0.75) brightness(1.05) contrast(0.98)";
  const imageUrl = useMemo(() => {
    const params = new URLSearchParams({
      topLeft: colors.topLeft,
      topRight: colors.topRight,
      bottomLeft: colors.bottomLeft,
      bottomRight: colors.bottomRight,
      width: String(ULTRABLUR_SIZE.width),
      height: String(ULTRABLUR_SIZE.height),
    });
    return `${getApiBaseUrl()}/services/ultrablur/image?${params.toString()}`;
  }, [colors.bottomLeft, colors.bottomRight, colors.topLeft, colors.topRight]);

  useEffect(() => {
    let cancelled = false;

    // Keep the current image on screen as the back layer until the new one is
    // decoded, so an uncached page never flashes blank.
    const previousFront = frontRef.current;

    // Cross-fade only once the new image is decoded (cached or freshly fetched).
    // Fading before the bytes arrive lets the opacity tween finish over an empty
    // layer, so the image would pop in at full opacity instead of fading.
    function startCrossfade() {
      if (cancelled) return;

      if (previousFront && previousFront !== imageUrl) {
        setBackUrl(previousFront);
      }

      // Place the (now-decoded) image at opacity 0 with no transition…
      setSkipTransition(true);
      setFrontVisible(false);
      setFrontUrl(imageUrl);

      // …then fade it in after two frames so the opacity-0 state commits first.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (cancelled) return;
          setSkipTransition(false);
          setFrontVisible(true);
        });
      });

      // Drop the old back layer once the fade has finished.
      if (cleanupTimerRef.current) {
        window.clearTimeout(cleanupTimerRef.current);
      }
      cleanupTimerRef.current = window.setTimeout(() => {
        if (!cancelled) setBackUrl(null);
      }, transitionMs + 50);
    }

    const img = new Image();
    img.decoding = "async";
    img.src = imageUrl;

    if (typeof img.decode === "function") {
      img.decode().then(startCrossfade).catch(() => {
        // decode() can reject (some browsers / odd content) even when the image
        // is usable — fall back to load state.
        if (img.complete) startCrossfade();
        else {
          img.onload = startCrossfade;
          img.onerror = startCrossfade; // fade in anyway rather than hang
        }
      });
    } else if (img.complete) {
      startCrossfade();
    } else {
      img.onload = startCrossfade;
      img.onerror = startCrossfade;
    }

    return () => {
      cancelled = true;
    };
  }, [imageUrl, transitionMs]);

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
