/**
 * Music-video type filters for download/monitor automation.
 * Unchecked types are skipped by download-missing; existing files are kept.
 *
 * Exposed Settings checkboxes: official/OMV, lyric, live, visualizer.
 * Catalog `audio` shares the OMV/Plex `-video` slot and follows the official
 * filter (not separately exposed).
 */

import type { FilteringConfig } from "../config/config.js";
import {
  isMainVideoVariant,
  normalizeVideoVariant,
  type VideoVariant,
} from "./video-variant.js";

export type VideoTypeFilterKey = "official" | "lyric" | "live" | "visualizer";

export function resolveVideoTypeFilterKey(
  variant: VideoVariant | string | null | undefined,
): VideoTypeFilterKey {
  const normalized = normalizeVideoVariant(variant);
  if (normalized === "lyric") return "lyric";
  if (normalized === "live") return "live";
  if (normalized === "visualizer") return "visualizer";
  // video / official / audio → official OMV bucket
  return "official";
}

/**
 * Whether download-missing (and similar automation) should queue this video.
 * Does not affect already-imported files.
 */
export function isVideoVariantDownloadAllowed(
  variant: VideoVariant | string | null | undefined,
  filtering: Pick<
    FilteringConfig,
    | "include_video_official"
    | "include_video_lyric"
    | "include_video_live"
    | "include_video_visualizer"
  >,
): boolean {
  const key = resolveVideoTypeFilterKey(variant);
  if (key === "lyric") return filtering.include_video_lyric !== false;
  if (key === "live") return filtering.include_video_live !== false;
  if (key === "visualizer") return filtering.include_video_visualizer !== false;
  return filtering.include_video_official !== false;
}

/** True when the variant is the main OMV / unlabeled music-video class. */
export function isOfficialMusicVideoVariant(
  variant: VideoVariant | string | null | undefined,
): boolean {
  const normalized = normalizeVideoVariant(variant);
  return isMainVideoVariant(normalized) || normalized === "audio";
}
