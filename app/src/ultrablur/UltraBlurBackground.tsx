import { makeStyles, shorthands } from "@fluentui/react-components";
import { UltraBlurColors } from "@/ultrablur/colors";
import { renderUltraBlurDataUrl } from "@/ultrablur/renderUltraBlurBitmap";
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
    // No CSS filter/vignette — blur + smoked dim are baked into the bitmap.
    // No overscale: that was only hiding transparent bake edges and exaggerated the edge halo.
    willChange: "opacity",
  },
});

interface UltraBlurBackgroundProps {
  colors: UltraBlurColors;
  isDarkMode: boolean;
  transitionDuration?: number;
}

export function UltraBlurBackground(props: UltraBlurBackgroundProps) {
  const styles = useStyles();

  const [frontUrl, setFrontUrl] = useState<string | null>(null);
  const [backUrl, setBackUrl] = useState<string | null>(null);
  const [frontVisible, setFrontVisible] = useState(true);
  const [skipTransition, setSkipTransition] = useState(false);

  const frontRef = useRef<string | null>(null);
  const cleanupTimerRef = useRef<number | null>(null);

  useEffect(() => {
    frontRef.current = frontUrl;
  }, [frontUrl]);

  useEffect(() => {
    return () => {
      if (cleanupTimerRef.current) {
        window.clearTimeout(cleanupTimerRef.current);
      }
    };
  }, []);

  const { colors, isDarkMode } = props;
  const transitionMs = props.transitionDuration ?? 500;

  // One-shot bake: static PNG with blur + smoked dim already in the pixels.
  const imageUrl = useMemo(
    () => renderUltraBlurDataUrl(colors, isDarkMode),
    [colors.bottomLeft, colors.bottomRight, colors.topLeft, colors.topRight, isDarkMode],
  );

  useEffect(() => {
    if (!imageUrl) return;
    let cancelled = false;
    const previousFront = frontRef.current;

    function startCrossfade() {
      if (cancelled || !imageUrl) return;

      if (previousFront && previousFront !== imageUrl) {
        setBackUrl(previousFront);
      }

      setSkipTransition(true);
      setFrontVisible(false);
      setFrontUrl(imageUrl);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (cancelled) return;
          setSkipTransition(false);
          setFrontVisible(true);
        });
      });

      if (cleanupTimerRef.current) {
        window.clearTimeout(cleanupTimerRef.current);
      }
      cleanupTimerRef.current = window.setTimeout(() => {
        if (!cancelled) setBackUrl(null);
      }, transitionMs + 50);
    }

    // Data URLs from our bake are already in memory — skip Image.decode latency.
    if (imageUrl.startsWith("data:")) {
      startCrossfade();
    } else {
      const img = new Image();
      img.src = imageUrl;
      if (typeof img.decode === "function") {
        img.decode().then(startCrossfade).catch(() => {
          if (img.complete) startCrossfade();
          else {
            img.onload = startCrossfade;
            img.onerror = startCrossfade;
          }
        });
      } else if (img.complete) {
        startCrossfade();
      } else {
        img.onload = startCrossfade;
        img.onerror = startCrossfade;
      }
    }

    return () => {
      cancelled = true;
    };
  }, [imageUrl, transitionMs]);

  return (
    <div
      className={styles.container}
      style={{ backgroundColor: isDarkMode ? "#12151c" : "#ffffff" }}
    >
      {backUrl && (
        <div
          className={styles.layer}
          style={{
            backgroundImage: `url("${backUrl}")`,
            opacity: 1,
          }}
        />
      )}

      {frontUrl && (
        <div
          className={styles.layer}
          style={{
            backgroundImage: `url("${frontUrl}")`,
            opacity: frontVisible ? 1 : 0,
            transition: skipTransition
              ? "none"
              : `opacity ${transitionMs}ms ease-in-out`,
          }}
        />
      )}
    </div>
  );
}
