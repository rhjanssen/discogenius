/**
 * Single source of truth for numbered-tracklist display, mirroring Lidarr's
 * medium-aware numbering (MediumNumber + track): a single-disc release shows
 * "N"; a multi-disc release shows "V-N" (disc-track). Reused by the download
 * queue, the manual-import track dropdown, and anywhere else a compact track
 * position is rendered — do not re-derive this inline.
 */

/**
 * A release is multi-volume when any track sits on a volume > 1 (or the tracks
 * span more than one distinct volume). Pass the album's full track set so every
 * row in that album is numbered consistently (disc 1 tracks also get the "1-"
 * prefix once any disc 2 exists), exactly like the queue does today.
 */
export function isMultiVolumeTrackList(
  tracks: ReadonlyArray<{ volumeNumber?: number | null }>,
): boolean {
  const volumes = tracks
    .map((row) => Number(row.volumeNumber || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  return volumes.length > 0 && (new Set(volumes).size > 1 || volumes.some((value) => value > 1));
}

/**
 * Compact position label: "1" (single disc) or "2-1" (disc 2, track 1). Empty
 * string when no track number is known. `multiVolume` should come from
 * isMultiVolumeTrackList over the album's tracks.
 */
export function formatTrackPosition(
  trackNumber: number | string | null | undefined,
  volumeNumber: number | null | undefined,
  options?: { multiVolume?: boolean; fallbackIndex?: number },
): string {
  const track = trackNumber != null && String(trackNumber).trim() !== ""
    ? String(trackNumber)
    : (options?.fallbackIndex != null ? String(options.fallbackIndex) : "");
  const volume = Number(volumeNumber || 0);
  if (options?.multiVolume && volume > 0 && track) {
    return `${volume}-${track}`;
  }
  return track;
}

/** "1. " / "2-1. " prefix (compact position + separator) for a tracklist row; "" when unknown. */
export function formatTrackPositionPrefix(
  trackNumber: number | string | null | undefined,
  volumeNumber: number | null | undefined,
  options?: { multiVolume?: boolean; fallbackIndex?: number },
): string {
  const position = formatTrackPosition(trackNumber, volumeNumber, options);
  return position ? `${position}. ` : "";
}
