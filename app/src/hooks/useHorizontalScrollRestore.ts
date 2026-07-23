import { useEffect, useLayoutEffect, useRef } from "react";
import type React from "react";
import { useNavigationType } from "react-router-dom";

const STORAGE_KEY = "discogenius-horizontal-scroll";
const MAX_STORED_KEYS = 64;
const RESTORE_RETRY_MS = [50, 150, 400, 800] as const;

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
 * Persist and restore horizontal `scrollLeft` for carousel strips across
 * back/forward navigations (window ScrollRestoration only covers scrollY).
 *
 * Keys by the stable `storageKey` only — React Router `location.key` changes
 * on every push, so mixing it in made POP restores miss the saved position.
 * Save on scroll and on unmount; restore when content has a scrollable width.
 */
export function useHorizontalScrollRestore(
  storageKey: string,
): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement | null>(null);
  const navigationType = useNavigationType();
  const positionsRef = useRef<Record<string, number>>(readStoredPositions());
  const key = String(storageKey || "").trim();

  useEffect(() => {
    if (!key) return;
    const node = ref.current;
    if (!node) return;
    const positions = positionsRef.current;
    const save = () => {
      positions[key] = node.scrollLeft;
      writeStoredPositions(positions);
    };
    node.addEventListener("scroll", save, { passive: true });
    return () => {
      save();
      node.removeEventListener("scroll", save);
    };
  }, [key]);

  useLayoutEffect(() => {
    if (!key) return;
    const saved = positionsRef.current[key];
    if (navigationType !== "POP" || typeof saved !== "number" || saved <= 0) {
      return;
    }

    let cancelled = false;
    const restore = () => {
      if (cancelled || !ref.current) return;
      const node = ref.current;
      // Wait until children have laid out a scrollable strip.
      if (node.scrollWidth <= node.clientWidth + 1) return;
      node.scrollLeft = saved;
    };
    restore();
    const raf = window.requestAnimationFrame(restore);
    const timers = RESTORE_RETRY_MS.map((ms) => window.setTimeout(restore, ms));
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [key, navigationType]);

  return ref as React.RefObject<HTMLDivElement>;
}
