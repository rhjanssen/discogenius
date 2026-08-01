import { normalizeVideoVariant, type VideoVariant } from "./video-variant.js";

/**
 * What a canonical video *is*, for organisation purposes.
 *
 * Providers label videos a dozen ways — Official Music Video, Visualizer,
 * Official Audio, Moving Artwork, MTV Unplugged — and those labels are real
 * matching evidence, kept on `Recordings.video_variant`. They are not, however,
 * distinct things to organise: a visualizer and an official video occupy the
 * same place beside the same track and compete for the same slot. Three
 * canonical types carry that distinction and nothing else:
 *
 *   video    an ordinary music video (incl. visualizer, official audio)
 *   live     a performance of a live recording
 *   lyrics   a lyric video
 *
 * Keeping this separate from the filename suffix matters: a live video stored
 * inline beside its exact live audio track is filling the track's video role and
 * is named `-video`, while the same video stored separately is named `-live`.
 * The type does not change; the role does.
 */
export type CanonicalVideoType = "video" | "live" | "lyrics";

/** Which inline role a canonical type competes for. */
export type InlineVideoSlot = "video" | "lyrics";

export function canonicalVideoType(
  variant: VideoVariant | string | null | undefined,
): CanonicalVideoType {
  const normalized = normalizeVideoVariant(variant);
  if (normalized === "lyric") return "lyrics";
  if (normalized === "live") return "live";
  // official, audio and visualizer are all ordinary videos for organisation.
  return "video";
}

/**
 * The inline slot a canonical type competes for.
 *
 * Plex gives a track one `-video` extra and one `-lyrics` extra, so live and
 * ordinary videos contend for the same place. One of each may coexist.
 */
export function inlineVideoSlot(type: CanonicalVideoType): InlineVideoSlot {
  return type === "lyrics" ? "lyrics" : "video";
}

/**
 * The Plex extras suffix for a canonical type in a given placement.
 *
 * Inline, the suffix names the role the file plays beside its track, so a live
 * video occupying the track's video slot is `-video`. Separated, there is no
 * track to be beside and the suffix names the video itself, so the same file is
 * `-live`.
 */
export function videoTypeSuffix(
  type: CanonicalVideoType,
  placement: "inline" | "separated",
): "-video" | "-live" | "-lyrics" {
  if (type === "lyrics") return "-lyrics";
  if (type === "live") return placement === "inline" ? "-video" : "-live";
  return "-video";
}
