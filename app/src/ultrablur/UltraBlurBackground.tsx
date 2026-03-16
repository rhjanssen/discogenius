import { makeStyles, mergeClasses, shorthands, tokens } from "@fluentui/react-components";
import { UltraBlurColors } from "@/ultrablur/colors";
import { renderUltraBlur } from "@/ultrablur/renderUltraBlur";
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
    willChange: "opacity, filter",
  },
  overlayDark: {
    backgroundImage:
      `radial-gradient(circle at 50% 35%, transparent 0%, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 32%, transparent) 70%, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 55%, transparent) 100%), linear-gradient(180deg, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 16%, transparent) 0%, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 42%, transparent) 100%)`,
    backdropFilter: "saturate(0.9) brightness(0.8) contrast(1.06)",
    WebkitBackdropFilter: "saturate(0.9) brightness(0.8) contrast(1.06)",
  },
  overlayLight: {
    backgroundImage:
      `radial-gradient(circle at 50% 35%, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 28%, transparent) 0%, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 70%, transparent) 70%, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 90%, transparent) 100%), linear-gradient(180deg, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 70%, transparent) 0%, color-mix(in srgb, ${tokens.colorNeutralForegroundInverted} 88%, transparent) 100%)`,
    backdropFilter: "saturate(0.75) brightness(1.05) contrast(0.98)",
    WebkitBackdropFilter: "saturate(0.75) brightness(1.05) contrast(0.98)",
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
  transitionDuration?: number;
}

function canvasToObjectUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to create UltraBlur image blob"));
        return;
      }
      resolve(URL.createObjectURL(blob));
    }, "image/png");
  });
}

export function UltraBlurBackground(props: UltraBlurBackgroundProps) {
  const styles = useStyles();
  const [isDark, setIsDark] = useState(true);

  const [frontUrl, setFrontUrl] = useState<string | null>(null);
  const [backUrl, setBackUrl] = useState<string | null>(null);
  const [frontVisible, setFrontVisible] = useState(true);
  /** When true, the opacity change to 0 is instant (no CSS transition). */
  const [skipTransition, setSkipTransition] = useState(false);

  const frontRef = useRef<string | null>(null);
  const backRef = useRef<string | null>(null);
  const cleanupTimerRef = useRef<number | null>(null);

  // Detect theme changes
  useEffect(() => {
    const checkTheme = () => {
      const isDarkMode = document.documentElement.classList.contains('dark') ||
        (document.documentElement.classList.contains('system') &&
          window.matchMedia('(prefers-color-scheme: dark)').matches) ||
        (!document.documentElement.classList.contains('light') &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      setIsDark(isDarkMode);
    };

    checkTheme();

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
      if (frontRef.current) URL.revokeObjectURL(frontRef.current);
      if (backRef.current) URL.revokeObjectURL(backRef.current);
    };
  }, []);

  const { colors } = props;
  const transitionMs = props.transitionDuration ?? 500;
  const key = useMemo(() => {
    return `${colors.topLeft}|${colors.topRight}|${colors.bottomLeft}|${colors.bottomRight}`;
  }, [colors]);

  // Keep a ref so the async effect always reads the latest colors without
  // needing `colors` in the dependency array (object-reference instability
  // would cancel in-flight crossfade rAF callbacks).
  const colorsRef = useRef(colors);
  colorsRef.current = colors;

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const canvas = renderUltraBlur(colorsRef.current, {
        width: 1920,
        height: 1080,
        lowResScale: 0.18,
        blurPx: 42,
        overlayDarken: 0,
        vignette: 0,
        noiseAmount: 0.2,
        blobCount: 0,
        seed: key,
      });

      const url = await canvasToObjectUrl(canvas);
      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }

      const prevBack = backRef.current;
      if (prevBack) {
        URL.revokeObjectURL(prevBack);
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
        const b = backRef.current;
        if (b) URL.revokeObjectURL(b);
        backRef.current = null;
        setBackUrl(null);
      }, transitionMs + 50);
    }

    run().catch((e) => {
      console.error("UltraBlur generation failed:", e);
    });

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

      <div className={mergeClasses(styles.overlay, isDark ? styles.overlayDark : styles.overlayLight)} />
    </div>
  );
}
