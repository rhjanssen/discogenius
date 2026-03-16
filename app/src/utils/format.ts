/**
 * Shared formatting utilities.
 */

/**
 * Format seconds into "m:ss" or "h:mm:ss" display.
 *
 * Handles undefined/NaN gracefully (returns "0:00").
 */
export function formatDurationSeconds(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return "0:00";

  const totalSeconds = Math.floor(seconds);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Format a time span between two epoch millisecond timestamps into
 * a human-readable elapsed string like "1m 23s" or "2h 05m".
 *
 * Used for job/download duration display.
 */
export function formatDurationMs(startMs: number, endMs: number): string {
  const diffMs = Math.abs(endMs - startMs);
  const totalSec = Math.floor(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
