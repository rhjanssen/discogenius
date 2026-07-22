import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

const STORAGE_KEY = "discogenius-scroll-positions";
const MAX_STORED_KEYS = 64;
const RESTORE_RETRY_MS = [50, 150, 400] as const;

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

    if (navigationType === "POP" && typeof saved === "number") {
      let cancelled = false;
      const restore = () => {
        if (cancelled) return;
        window.scrollTo({ top: saved, left: 0, behavior: "auto" });
      };

      // Content often arrives after Suspense / React Query; retry briefly.
      restore();
      const raf = window.requestAnimationFrame(restore);
      const timers = RESTORE_RETRY_MS.map((ms) => window.setTimeout(restore, ms));

      return () => {
        cancelled = true;
        window.cancelAnimationFrame(raf);
        for (const timer of timers) window.clearTimeout(timer);
      };
    }

    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [location.key, navigationType]);

  return null;
}
