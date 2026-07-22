import type { NavigateFunction, NavigateOptions } from "react-router-dom";

function normalizeRouteId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

/** Canonical video page path — prefer Recordings.id (API contract `id`). */
export function getVideoPath(videoId: string | number): string {
  return `/video/${videoId}`;
}

export function navigateToVideo(
  navigate: NavigateFunction,
  videoId: string | number,
  options?: NavigateOptions,
) {
  const id = normalizeRouteId(videoId);
  if (!id) return;
  navigate(getVideoPath(id), options);
}
