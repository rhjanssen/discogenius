import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefCallback } from "react";
import { useNavigationType } from "react-router-dom";

const STORAGE_KEY = "discogenius-horizontal-scroll";
const MAX_STORED_KEYS = 64;
const RESTORE_RETRY_MS = [50, 150, 400, 800] as const;
/**
 * Carousel children (and card images) often finish layout after the first paint
 * on back-navigation. Keep re-applying until scrollWidth is ready or this
 * budget elapses — matching window ScrollRestoration's growth budget.
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
    // Private mode / quota.
  }
}

/**
 * Merge a single key into sessionStorage. Artist pages host many carousel hooks;
 * each previously kept a private in-memory map and the last unmount save wiped
 * sibling keys (videos save → albums scroll lost).
 */
function persistScrollLeft(key: string, scrollLeft: number) {
  if (!key) return;
  const positions = readStoredPositions();
  positions[key] = scrollLeft;
  writeStoredPositions(positions);
}

/**
 * Bind scroll persistence for one carousel node.
 *
 * On route changes React unmounts children first; scrollWidth collapses and the
 * browser clamps scrollLeft to 0, which fires a scroll event. Persisting that
 * clamp wiped the real offset (videos always restored to the start). Track the
 * last real offset and ignore collapse-clamped zeros.
 */
function bindScrollPersistence(key: string, node: HTMLDivElement): () => void {
  let lastGood = node.scrollLeft;

  const onScroll = () => {
    const left = node.scrollLeft;
    const collapsed = node.scrollWidth <= node.clientWidth + 1;
    if (left <= 0 && collapsed) {
      return;
    }
    lastGood = left;
    persistScrollLeft(key, left);
  };

  node.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    node.removeEventListener("scroll", onScroll);
    persistScrollLeft(key, lastGood);
  };
}

function applyScrollLeft(node: HTMLDivElement, left: number) {
  // Carousels use CSS scroll-behavior: smooth; prefer scrollTo(auto) when available.
  if (typeof node.scrollTo === "function") {
    try {
      node.scrollTo({ left, behavior: "auto" });
    } catch {
      node.scrollLeft = left;
    }
  } else {
    node.scrollLeft = left;
  }
  // Some test environments implement scrollTo as a no-op.
  if (Math.abs(node.scrollLeft - left) > RESTORE_SCROLL_TOLERANCE_PX) {
    node.scrollLeft = left;
  }
}

function startHorizontalRestore(
  node: HTMLDivElement,
  target: number,
  isCancelled: () => boolean,
): () => void {
  const restore = () => {
    if (isCancelled()) return;
    if (node.scrollWidth <= node.clientWidth + 1) return;
    applyScrollLeft(node, target);
  };
  const reachedTarget = () =>
    Math.abs(node.scrollLeft - target) <= RESTORE_SCROLL_TOLERANCE_PX;

  restore();
  const raf = window.requestAnimationFrame(restore);
  const timers = RESTORE_RETRY_MS.map((ms) => window.setTimeout(restore, ms));

  const startedAt = Date.now();
  let lastScrollWidth = node.scrollWidth;
  const growthTimer = window.setInterval(() => {
    if (isCancelled()) return;
    if (reachedTarget() || Date.now() - startedAt >= RESTORE_GROWTH_BUDGET_MS) {
      window.clearInterval(growthTimer);
      return;
    }
    const width = node.scrollWidth;
    if (width !== lastScrollWidth || node.scrollLeft < target - RESTORE_SCROLL_TOLERANCE_PX) {
      lastScrollWidth = width;
      restore();
    }
  }, 100);

  const resizeObserver =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (isCancelled() || reachedTarget()) return;
          restore();
        })
      : null;
  resizeObserver?.observe(node);

  return () => {
    window.cancelAnimationFrame(raf);
    for (const timer of timers) window.clearTimeout(timer);
    window.clearInterval(growthTimer);
    resizeObserver?.disconnect();
  };
}

/**
 * Persist and restore horizontal `scrollLeft` for carousel strips across
 * back/forward navigations (window ScrollRestoration only covers scrollY).
 *
 * Keys by the stable `storageKey` only — React Router `location.key` changes
 * on every push, so mixing it in made POP restores miss the saved position.
 *
 * Uses a callback ref so save/restore bind when the carousel DOM appears after
 * loading skeletons (a RefObject + mount-only effect left ref.current null).
 */
export function useHorizontalScrollRestore(
  storageKey: string,
): RefCallback<HTMLDivElement> {
  const navigationType = useNavigationType();
  const key = String(storageKey || "").trim();
  const [node, setNode] = useState<HTMLDivElement | null>(null);

  const ref = useCallback<RefCallback<HTMLDivElement>>((next) => {
    setNode((prev) => (prev === next ? prev : next));
  }, []);

  useEffect(() => {
    if (!key || !node) return;
    return bindScrollPersistence(key, node);
  }, [key, node]);

  useLayoutEffect(() => {
    if (!key || !node) return;
    // Always re-read storage — sibling hooks may have written since mount.
    const saved = readStoredPositions()[key];
    if (navigationType !== "POP" || typeof saved !== "number" || saved <= 0) {
      return;
    }

    let cancelled = false;
    const stop = startHorizontalRestore(node, saved, () => cancelled);
    return () => {
      cancelled = true;
      stop();
    };
  }, [key, node, navigationType]);

  return ref;
}

/**
 * Same as {@link useHorizontalScrollRestore}, but returns a stable per-suffix
 * callback so multiple carousels on one page (Albums / EPs / Singles) each keep
 * their own scroll position.
 */
export function useHorizontalScrollRestoreGroup(
  baseKey: string,
): (suffix: string) => RefCallback<HTMLDivElement> {
  const navigationType = useNavigationType();
  const base = String(baseKey || "").trim();
  const navigationTypeRef = useRef(navigationType);
  navigationTypeRef.current = navigationType;

  const cleanupsRef = useRef(new Map<string, () => void>());
  const callbacksRef = useRef(new Map<string, RefCallback<HTMLDivElement>>());
  const prevBaseRef = useRef(base);

  useLayoutEffect(() => {
    const prev = prevBaseRef.current;
    if (prev === base) return;
    prevBaseRef.current = base;
    const prefix = prev ? `${prev}:` : "";
    for (const [key, cleanup] of [...cleanupsRef.current.entries()]) {
      if (!prev || key === prev || (prefix && key.startsWith(prefix))) {
        cleanup();
        cleanupsRef.current.delete(key);
        callbacksRef.current.delete(key);
      }
    }
  }, [base]);

  useEffect(() => () => {
    for (const cleanup of cleanupsRef.current.values()) cleanup();
    cleanupsRef.current.clear();
    callbacksRef.current.clear();
  }, []);

  return useCallback((suffix: string) => {
    const normalizedSuffix = String(suffix || "").trim() || "default";
    const fullKey = base ? `${base}:${normalizedSuffix}` : normalizedSuffix;

    let callback = callbacksRef.current.get(fullKey);
    if (!callback) {
      callback = (node) => {
        const existing = cleanupsRef.current.get(fullKey);
        existing?.();
        cleanupsRef.current.delete(fullKey);

        if (!node) return;

        const unbind = bindScrollPersistence(fullKey, node);

        let cancelled = false;
        let stopRestore: (() => void) | undefined;
        const saved = readStoredPositions()[fullKey];
        if (
          navigationTypeRef.current === "POP"
          && typeof saved === "number"
          && saved > 0
        ) {
          stopRestore = startHorizontalRestore(node, saved, () => cancelled);
        }

        cleanupsRef.current.set(fullKey, () => {
          cancelled = true;
          stopRestore?.();
          unbind();
        });
      };
      callbacksRef.current.set(fullKey, callback);
    }
    return callback;
  }, [base]);
}
