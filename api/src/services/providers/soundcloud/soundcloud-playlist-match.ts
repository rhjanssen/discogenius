import {
  normalizeComparableText,
  stringSimilarity,
} from "../../mediafiles/import-matching-utils.js";
import {
  normalizeMusicBrainzType,
  parseMusicBrainzSecondaryTypes,
} from "../../metadata/musicbrainz-release-group-filter.js";
import {
  scoreTrackMatch,
  TRACK_MATCH_THRESHOLD,
  type MatchProviderTrack,
  type MatchTargetTrack,
} from "../../music/provider-track-matcher.js";
import type { ProviderAlbum } from "../streaming-provider.js";

/**
 * Secondary MusicBrainz types that may only exist as user playlists/sets on
 * SoundCloud (not under the matched artist’s official album catalog).
 *
 * Intentionally excludes compilation / soundtrack / live / remix — those are
 * often official releases and wide playlist search would create noisy false
 * positives against Album/EP/Single catalogs.
 */
export const SOUNDCLOUD_WIDE_PLAYLIST_SECONDARY_TYPES = new Set([
  "mixtape/street",
  "dj-mix",
  "demo",
]);

/** Match method stored on ProviderItems for fan-set / mixtape playlist covers. */
export const PLAYLIST_TRACKLIST_COVERAGE_METHOD = "playlist-tracklist-coverage";

export type CanonicalTrackForCoverage = {
  title: string;
  durationSec?: number | null;
  trackNumber?: number | null;
};

export type PlaylistCoverageResult = {
  covered: number;
  total: number;
  ratio: number;
};

/** True for mixtape/street, dj-mix, demo, or primary type Other. */
export function shouldWideSearchSoundCloudPlaylists(
  primaryType?: string | null,
  secondaryTypes?: string[] | string | null,
): boolean {
  const primary = normalizeMusicBrainzType(primaryType);
  if (primary === "other") return true;
  const secondaries = Array.isArray(secondaryTypes)
    ? secondaryTypes.map(normalizeMusicBrainzType)
    : parseMusicBrainzSecondaryTypes(secondaryTypes);
  return secondaries.some((type) => SOUNDCLOUD_WIDE_PLAYLIST_SECONDARY_TYPES.has(type));
}

export function scoreReleaseTitleSimilarity(providerTitle: string, releaseTitle: string): number {
  const left = normalizeComparableText(providerTitle);
  const right = normalizeComparableText(releaseTitle);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.startsWith(`${right} `) || right.startsWith(`${left} `)) return 0.9;
  return stringSimilarity(left, right);
}

/**
 * Coverage of a MusicBrainz tracklist by a SoundCloud playlist/set.
 * Playlist supersets are OK: every canonical track must match some playlist
 * track (title + duration); extras on the playlist are ignored.
 * Playlist order is ignored — fan sets rearrange freely.
 */
export function scorePlaylistTracklistCoverage(
  canonicalTracks: CanonicalTrackForCoverage[],
  playlistTracks: Array<{ title?: string | null; duration?: number | null; trackNumber?: number | null }>,
): PlaylistCoverageResult {
  const total = canonicalTracks.length;
  if (total === 0) {
    return { covered: 0, total: 0, ratio: 0 };
  }

  const used = new Set<number>();
  let covered = 0;

  for (const canonical of canonicalTracks) {
    const target: MatchTargetTrack = {
      recordingMbid: null,
      isrcs: new Set(),
      title: canonical.title,
      trackNumber: Number(canonical.trackNumber || 0),
      volumeNumber: 1,
      durationSec: canonical.durationSec ?? null,
    };

    let bestIndex = -1;
    let bestScore = 0;
    for (let index = 0; index < playlistTracks.length; index += 1) {
      if (used.has(index)) continue;
      const row = playlistTracks[index]!;
      const provider: MatchProviderTrack = {
        mbid: null,
        isrc: null,
        title: String(row.title || ""),
        // Ignore playlist positions — fan sets rarely preserve MB order.
        trackNumber: null,
        volumeNumber: null,
        durationSec: typeof row.duration === "number" ? row.duration : null,
      };
      const score = scoreTrackMatch(target, provider);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex >= 0 && bestScore >= TRACK_MATCH_THRESHOLD) {
      used.add(bestIndex);
      covered += 1;
    }
  }

  return {
    covered,
    total,
    ratio: covered / total,
  };
}

export function playlistCoversCanonicalTracklist(
  canonicalTracks: CanonicalTrackForCoverage[],
  playlistTracks: Array<{ title?: string | null; duration?: number | null; trackNumber?: number | null }>,
): boolean {
  const coverage = scorePlaylistTracklistCoverage(canonicalTracks, playlistTracks);
  return coverage.total > 0 && coverage.covered === coverage.total;
}

export function rankSoundCloudPlaylistCandidates(
  albums: ProviderAlbum[],
  releaseGroupTitle: string,
  preferredTrackCount?: number | null,
): ProviderAlbum[] {
  const minTitleScore = 0.72;
  const preferred = Number(preferredTrackCount || 0);
  return albums
    .map((album) => {
      const titleScore = scoreReleaseTitleSimilarity(album.title, releaseGroupTitle);
      const trackCount = Number(album.trackCount || 0);
      const coversFloor = preferred <= 0 || trackCount <= 0 || trackCount >= preferred;
      const extras = preferred > 0 && trackCount > preferred ? trackCount - preferred : 0;
      return { album, titleScore, coversFloor, extras, trackCount };
    })
    .filter((row) => row.titleScore >= minTitleScore && row.coversFloor)
    .sort((left, right) =>
      right.titleScore - left.titleScore
      || left.extras - right.extras
      || right.trackCount - left.trackCount
      || String(left.album.providerId).localeCompare(String(right.album.providerId)))
    .map((row) => row.album);
}
