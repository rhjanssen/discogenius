/**
 * Video library placement modes (Settings → Naming → Video Folder Layout).
 *
 * - separated: every selected video lives in the dedicated video library
 * - inline: the winner of each Plex slot moves beside its exact audio track;
 *   every other selected video stays separated, never both
 * - inline_only: only slot winners are selected at all, so losing candidates
 *   stay visible as alternatives without being downloaded
 *
 * The mode says what curation is allowed to do. WHERE a given video actually
 * ends up is curation's decision, stored on `LibraryVideos` and read back
 * through `video-placement-resolver.ts` — never re-derived per consumer.
 */

import { videoIsPlacedInline } from "../music/video-placement-resolver.js";

export type VideoFolderLayout = "separated" | "inline" | "inline_only";

export function normalizeVideoFolderLayout(
  value: string | null | undefined,
): VideoFolderLayout {
  if (value === "inline" || value === "inline_only") return value;
  return "separated";
}

/** True when layout may place linked videos beside stereo audio. */
export function allowsInlineVideoPlacement(
  layout: string | null | undefined,
): boolean {
  const normalized = normalizeVideoFolderLayout(layout);
  return normalized === "inline" || normalized === "inline_only";
}

/** True when automation must skip videos that cannot place inline. */
export function requiresAlbumLinkedVideosOnly(
  layout: string | null | undefined,
): boolean {
  return normalizeVideoFolderLayout(layout) === "inline_only";
}

/**
 * Whether this video's file belongs beside an audio track right now.
 *
 * This used to re-derive the answer from relations and library state with its
 * own ranking, independently of the organizer's. It now reads the decision
 * curation stored on `LibraryVideos`, which is the only way every consumer can
 * agree about one file's location.
 */
export function canVideoPlaceInline(videoRecordingId: string | number | null | undefined): boolean {
  return videoIsPlacedInline(videoRecordingId);
}
