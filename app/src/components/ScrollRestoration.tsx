import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

const STORAGE_KEY = "discogenius-scroll-positions";
const MAX_STORED_KEYS = 64;
/** Immediate retries while Suspense / React Query paint the first shell. */
const RESTORE_RETRY_MS = [50, 150, 400, 800] as const;
/**
 * Artist/album pages often grow for seconds after POP (local-MB library hydrate).
 * Keep re-applying the saved offset until the document is tall enough or this
 * budget elapses — otherwise the browser clamps scrollY to ~0 and leaves the
 * user at the top after back-navigation.
 */
const RESTORE_GROWTH_BUDGET_MS = 4_000;
const RESTORE_SCROLL_TOLERANCE_PX = 8;

function readStoredPositions(): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeStoredPositions(positions: Record<string, number>) {
  try {
    const keys = Object.keys(positions);
    if (keys.length > MAX_STORED_KEYS) {
      for (const key of keys.slice(0, keys.length - MAX_STORED_KEYS)) {
        delete positions[key];
      }
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // Private mode / quota — in-memory map still works for the session.
  }
}

/**
 * Window scroll restoration for BrowserRouter (data-router ScrollRestoration
 * is unavailable). Saves per history `location.key`, restores on POP (back/
 * forward), scrolls to top on PUSH/REPLACE.
 *
 * Scroll parent is the document/window — Layout does not use a nested
 * overflow pane for normal routes.
 */
export default function ScrollRestoration() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const positionsRef = useRef<Record<string, number>>(readStoredPositions());

  useEffect(() => {
    if (!("scrollRestoration" in window.history)) return;
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => {
      window.history.scrollRestoration = previous;
    };
  }, []);

  // Keep the current entry's position updated while the user scrolls. Do not
  // re-read window.scrollY in the cleanup after a navigation — the new route
  // may already have clamped scroll when content height collapsed.
  useEffect(() => {
    const key = location.key;
    const save = () => {
      positionsRef.current[key] = window.scrollY;
    };
    window.addEventListener("scroll", save, { passive: true });
    return () => {
      window.removeEventListener("scroll", save);
      writeStoredPositions(positionsRef.current);
    };
  }, [location.key]);

  useLayoutEffect(() => {
    const key = location.key;
    const saved = positionsRef.current[key];

    if (navigationType === "POP" && typeof saved === "number" && saved > 0) {
      let cancelled = false;
      const target = saved;
      const restore = () => {
        if (cancelled) return;
        window.scrollTo({ top: target, left: 0, behavior: "auto" });
      };
      const reachedTarget = () => Math.abs(window.scrollY - target) <= RESTORE_SCROLL_TOLERANCE_PX;
      const canReachTarget = () =>
        document.documentElement.scrollHeight >= target + Math.min(window.innerHeight, 64);

      // Content often arrives after Suspense / React Query; retry briefly, then
      // keep watching document growth until the saved offset is reachable.
      restore();
      const raf = window.requestAnimationFrame(restore);
      const timers = RESTORE_RETRY_MS.map((ms) => window.setTimeout(restore, ms));

      const startedAt = Date.now();
      let lastHeight = document.documentElement.scrollHeight;
      const growthTimer = window.setInterval(() => {
        if (cancelled) return;
        if (reachedTarget() || Date.now() - startedAt >= RESTORE_GROWTH_BUDGET_MS) {
          window.clearInterval(growthTimer);
          return;
        }
        const height = document.documentElement.scrollHeight;
        if (height !== lastHeight || !canReachTarget() || window.scrollY < target - RESTORE_SCROLL_TOLERANCE_PX) {
          lastHeight = height;
          restore();
        }
      }, 100);

      const resizeObserver =
        typeof ResizeObserver !== "undefined"
          ? new ResizeObserver(() => {
              if (cancelled || reachedTarget()) return;
              restore();
            })
          : null;
      resizeObserver?.observe(document.documentElement);

      return () => {
        cancelled = true;
        window.cancelAnimationFrame(raf);
        for (const timer of timers) window.clearTimeout(timer);
        window.clearInterval(growthTimer);
        resizeObserver?.disconnect();
      };
    }

    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [location.key, navigationType]);

  return null;
}
