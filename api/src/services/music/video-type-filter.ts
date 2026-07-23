/**
 * Music-video type filters for download/monitor automation.
 * Unchecked types are skipped by download-missing and unmonitored by Apply
 * Curation (unlocked rows only). Existing imported files are kept on disk
 * unless remove_unmonitored_files is enabled.
 *
 * Exposed Settings checkboxes: official/OMV, lyric, live, visualizer,
 * official audio. Catalog `audio` ("(Official Audio)" / "(Audio)") is its own
 * filter — same pattern as Visualizer.
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
  | "visualizer"
  | "official_audio";

export function resolveVideoTypeFilterKey(
  variant: VideoVariant | string | null | undefined,
): VideoTypeFilterKey {
  const normalized = normalizeVideoVariant(variant);
  if (normalized === "lyric") return "lyric";
  if (normalized === "live") return "live";
  if (normalized === "visualizer") return "visualizer";
  if (normalized === "audio") return "official_audio";
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
  if (key === "lyric") return filtering.include_video_lyric !== false;
  if (key === "live") return filtering.include_video_live !== false;
  if (key === "visualizer") return filtering.include_video_visualizer !== false;
  if (key === "official_audio") return filtering.include_video_official_audio !== false;
  return filtering.include_video_official !== false;
}

/** True when the variant is the main OMV / unlabeled music-video class. */
export function isOfficialMusicVideoVariant(
  variant: VideoVariant | string | null | undefined,
): boolean {
  return isMainVideoVariant(normalizeVideoVariant(variant));
}
