/**
 * Music-video type filters for download/monitor automation.
 * Unchecked types are skipped by download-missing and unmonitored by Apply
 * Curation (unlocked rows only). Existing imported files are kept on disk
 * unless remove_unmonitored_files is enabled.
 *
 * Exposed Settings checkboxes: Official, Live, Lyric, Visualiser.
 * Catalog `audio` ("(Official Audio)" / "(Audio)") shares the Visualiser
 * filter with `visualizer` cuts — one toggle covers both.
 */

import type { FilteringConfig } from "../config/config.js";
import {
  isMainVideoVariant,
  normalizeVideoVariant,
  type VideoVariant,
} from "./video-variant.js";

export type VideoTypeFilterKey =
  | "official"
  | "lyric"
  | "live"
  | "visualizer";

export function resolveVideoTypeFilterKey(
  variant: VideoVariant | string | null | undefined,
): VideoTypeFilterKey {
  const normalized = normalizeVideoVariant(variant);
  if (normalized === "lyric") return "lyric";
  if (normalized === "live") return "live";
  // Official Audio / Audio-only shares Visualiser — not the OMV bucket.
  if (normalized === "visualizer" || normalized === "audio") return "visualizer";
  // video / official → official OMV bucket
  return "official";
}

/**
 * Whether curation should monitor this variant and download-missing should
 * queue it. Does not delete already-imported files by itself.
 */
export function isVideoVariantDownloadAllowed(
  variant: VideoVariant | string | null | undefined,
  filtering: Pick<
    FilteringConfig,
    | "include_video_official"
    | "include_video_lyric"
    | "include_video_live"
    | "include_video_visualizer"
    | "include_video_official_audio"
  >,
): boolean {
  const key = resolveVideoTypeFilterKey(variant);
  if (key === "lyric") return filtering.include_video_lyric === true;
  if (key === "live") return filtering.include_video_live !== false;
  if (key === "visualizer") {
    // Visualiser checkbox is authoritative. Legacy `include_video_official_audio`
    // still enables Audio-only cuts when Visualiser is off (pre-merge configs).
    if (filtering.include_video_visualizer === true) return true;
    if (normalizeVideoVariant(variant) === "audio"
      && filtering.include_video_official_audio === true) {
      return true;
    }
    return false;
  }
  return filtering.include_video_official !== false;
}

/** True when the variant is the main OMV / unlabeled music-video class. */
export function isOfficialMusicVideoVariant(
  variant: VideoVariant | string | null | undefined,
): boolean {
  return isMainVideoVariant(normalizeVideoVariant(variant));
}
