/**
 * Single source of truth for numbered-tracklist display, mirroring Lidarr's
 * medium-aware numbering (MediumNumber + track): a single-disc release shows
 * "N"; a multi-disc release shows "V-N" (disc-track). Reused by the download
 * queue, the manual-import track dropdown, and anywhere else a compact track
 * position is rendered — do not re-derive this inline.
 */

export type TrackPositionLike = {
  trackNumber?: number | string | null;
  track_number?: number | string | null;
  trackNum?: number | string | null;
  rawTrackNumber?: number | string | null;
  position?: number | string | null;
  number?: number | string | null;
  volumeNumber?: number | null;
  volume_number?: number | null;
  volumeNum?: number | null;
  mediumPosition?: number | null;
  medium_position?: number | null;
  mediaCount?: number | null;
  media_count?: number | null;
};

function firstPositionValue(
  row: TrackPositionLike,
  keys: ReadonlyArray<keyof TrackPositionLike>,
): number | string | null | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value != null && String(value).trim() !== "") return value;
  }
  return undefined;
}

function trackNumberFrom(row: TrackPositionLike): number | string | null | undefined {
  return firstPositionValue(row, [
    "trackNumber",
    "track_number",
    "trackNum",
    "rawTrackNumber",
    "position",
    "number",
  ]);
}

function volumeNumberFrom(row: TrackPositionLike): number | null {
  const raw = firstPositionValue(row, [
    "volumeNumber",
    "volume_number",
    "volumeNum",
    "mediumPosition",
    "medium_position",
  ]);
  const volume = Number(raw || 0);
  return Number.isFinite(volume) && volume > 0 ? Math.trunc(volume) : null;
}

function mediaCountFrom(row: TrackPositionLike): number | null {
  const raw = firstPositionValue(row, ["mediaCount", "media_count"]);
  const count = Number(raw || 0);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : null;
}

/**
 * A release is multi-volume when any track sits on a volume > 1, tracks span
 * multiple volumes, or the canonical release reports multiple media. Pass the
 * album's full track set so every row is numbered consistently.
 */
export function isMultiVolumeTrackList(
  tracks: ReadonlyArray<TrackPositionLike>,
): boolean {
  const volumes = tracks
    .map(volumeNumberFrom)
    .filter((value): value is number => value != null);
  return tracks.some((row) => (mediaCountFrom(row) || 0) > 1)
    || (volumes.length > 0 && (new Set(volumes).size > 1 || volumes.some((value) => value > 1)));
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

/** Compact position label from any API/UI track shape. */
export function formatTrackPositionFrom(
  row: TrackPositionLike,
  options?: { multiVolume?: boolean; fallbackIndex?: number },
): string {
  return formatTrackPosition(trackNumberFrom(row), volumeNumberFrom(row), options);
}

/** Human-readable album association label: "Track 4" or "Disc 2 · Track 4". */
export function formatDescriptiveTrackPosition(
  row: TrackPositionLike,
  options?: { multiVolume?: boolean },
): string | null {
  const rawTrack = Number(trackNumberFrom(row));
  if (!Number.isFinite(rawTrack) || rawTrack <= 0) return null;

  const track = Math.trunc(rawTrack);
  const volume = volumeNumberFrom(row);
  const mediaCount = mediaCountFrom(row);
  const showDisc = volume != null
    && (volume > 1 || (mediaCount || 0) > 1 || options?.multiVolume === true);
  return showDisc ? `Disc ${volume} · Track ${track}` : `Track ${track}`;
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
