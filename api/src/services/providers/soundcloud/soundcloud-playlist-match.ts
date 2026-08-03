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
import {
  isSoundCloudTrackKnownUndownloadable,
  scoreSoundCloudDownloadableCoverage,
  soundCloudOfferHasDownloadableMatch,
  type SoundCloudDownloadableCoverage,
} from "./soundcloud-downloadability.js";

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

/**
 * Fan mixtape sets often omit one unavailable/mashup track. Require strong
 * coverage (ceil 85%) rather than a brittle 100% identity check.
 */
export const PLAYLIST_TRACKLIST_COVERAGE_MIN_RATIO = 0.85;

export type CanonicalTrackForCoverage = {
  title: string;
  durationSec?: number | null;
  trackNumber?: number | null;
};

export type PlaylistTrackForCoverage = {
  title?: string | null;
  duration?: number | null;
  trackNumber?: number | null;
  /** SoundCloud api-v2 track resource (or ProviderTrack carrying it in raw). */
  raw?: unknown;
  policy?: string | null;
};

export type PlaylistTrackAssignment = {
  canonicalIndex: number;
  playlistIndex: number;
  score: number;
};

export type PlaylistCoverageResult = {
  covered: number;
  total: number;
  ratio: number;
  downloadable?: SoundCloudDownloadableCoverage;
};

/**
 * Title/duration coverage plus Discogenius downloadability. DRM/SNIP-only
 * shells that cover titles still fail this gate so they cannot monitor.
 */
export function playlistCoversCanonicalTracklistDownloadable(
  canonicalTracks: CanonicalTrackForCoverage[],
  playlistTracks: PlaylistTrackForCoverage[],
): boolean {
  if (!playlistCoversCanonicalTracklist(canonicalTracks, playlistTracks)) {
    return false;
  }
  const assignments = matchPlaylistTracksToCanonical(canonicalTracks, playlistTracks);
  const downloadable = scoreSoundCloudDownloadableCoverage(
    assignments,
    playlistTracks,
    canonicalTracks.length,
  );
  return soundCloudOfferHasDownloadableMatch(
    downloadable,
    PLAYLIST_TRACKLIST_COVERAGE_MIN_RATIO,
  );
}

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

  // Fan playlist permalinks are often truncated ("other-peoples-her" for
  // "Other People's Heartache"). Score shared significant word stems so wide
  // mixtape search can still hydrate them for tracklist coverage.
  const leftTokens = left.split(/\s+/u).filter((token) => token.length >= 3);
  const rightTokens = right.split(/\s+/u).filter((token) => token.length >= 3);
  if (leftTokens.length > 0 && rightTokens.length > 0) {
    const shorter = leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
    const longer = leftTokens.length <= rightTokens.length ? rightTokens : leftTokens;
    let matched = 0;
    for (const token of shorter) {
      if (longer.some((candidate) =>
        candidate === token
        || candidate.startsWith(token)
        || token.startsWith(candidate))) {
        matched += 1;
      }
    }
    const stemRatio = matched / shorter.length;
    if (stemRatio >= 0.75 && matched >= 2) {
      return Math.max(stringSimilarity(left, right), 0.78);
    }
  }

  return stringSimilarity(left, right);
}

/** Search query variants for mixtape playlist discovery (drop Pt./Part suffixes). */
export function soundCloudMixtapeSearchTitles(releaseGroupTitle: string): string[] {
  const title = String(releaseGroupTitle || "").trim();
  if (!title) return [];
  const variants = new Set<string>([title]);
  const withoutPart = title
    .replace(/,?\s*pt\.?\s*\d+\s*$/iu, "")
    .replace(/,?\s*part\s*\d+\s*$/iu, "")
    .trim();
  if (withoutPart && withoutPart.toLowerCase() !== title.toLowerCase()) {
    variants.add(withoutPart);
  }
  return Array.from(variants);
}

/**
 * SoundCloud fan uploads decorate titles as `Artist - Title`,
 * `Artist & Guest - Title`, or `Title - Artist feat. X`. Return variants so
 * playlist coverage can score the bare song title.
 */
export function soundCloudPlaylistTrackTitleVariants(title: string): string[] {
  const cleaned = String(title || "").trim().replace(/^\.+\s*/u, "");
  if (!cleaned) return [];

  const variants = new Set<string>([cleaned]);

  // Bastille "No Angels" (ft. Ella) → No Angels (ft. Ella)
  const quotedCore = cleaned.match(/^.{0,60}?"([^"]{1,120})"\s*(.*)$/u);
  if (quotedCore) {
    const core = quotedCore[1]!.trim();
    const trailing = String(quotedCore[2] || "").trim();
    variants.add(trailing ? `${core} ${trailing}` : core);
  }

  for (const candidate of Array.from(variants)) {
    // Split on the first dash / em-dash / en-dash (optional spaces).
    const dashed = candidate.match(/^(.{1,80}?)\s*[-–—]\s*(.+)$/u);
    if (!dashed) continue;
    const left = dashed[1]!.trim();
    const right = dashed[2]!.trim();
    if (!left || !right) continue;

    const leftLooksLikeCredit = /(\bfeat\b|\bft\b|\bfeaturing\b|&|,)/iu.test(left)
      || left.split(/\s+/u).length <= 4;
    if (leftLooksLikeCredit) {
      variants.add(right);
    }

    const rightLooksLikeCredit = /(\bfeat\b|\bft\b|\bfeaturing\b)/iu.test(right);
    if (rightLooksLikeCredit) {
      // Drop trailing mashup parenthetical from the left side when present.
      const leftBare = left.replace(/\s*\([^)]*\)\s*$/u, "").trim();
      if (leftBare) variants.add(leftBare);
      variants.add(left);
    }
  }

  return Array.from(variants).map((value) => value.trim()).filter(Boolean);
}

function bestPlaylistTrackMatchScore(
  target: MatchTargetTrack,
  playlistTitle: string,
  durationSec: number | null,
): number {
  let best = 0;
  for (const variant of soundCloudPlaylistTrackTitleVariants(playlistTitle)) {
    const provider: MatchProviderTrack = {
      mbid: null,
      isrc: null,
      title: variant,
      // Ignore playlist positions — fan sets rarely preserve MB order.
      trackNumber: null,
      volumeNumber: null,
      durationSec,
    };
    const score = scoreTrackMatch(target, provider);
    if (score > best) best = score;
  }
  return best;
}

/**
 * Assign SoundCloud playlist tracks to canonical tracks one-to-one using the
 * same title/duration matcher that gates playlist coverage. Positions are
 * intentionally excluded: fan playlists commonly reorder the release.
 *
 * Known undownloadable rows (DRM / SNIP / BLOCK) are never assignable — they
 * must not count as coverage or become ProviderTrackMatches / plan sources.
 * Unhydrated stubs (`unknown`) stay eligible so callers can hydrate later.
 */
export function matchPlaylistTracksToCanonical(
  canonicalTracks: CanonicalTrackForCoverage[],
  playlistTracks: PlaylistTrackForCoverage[],
): PlaylistTrackAssignment[] {
  const used = new Set<number>();
  const assignments: PlaylistTrackAssignment[] = [];

  for (let canonicalIndex = 0; canonicalIndex < canonicalTracks.length; canonicalIndex += 1) {
    const canonical = canonicalTracks[canonicalIndex]!;
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
      if (isSoundCloudTrackKnownUndownloadable(row)) continue;
      const score = bestPlaylistTrackMatchScore(
        target,
        String(row.title || ""),
        typeof row.duration === "number" ? row.duration : null,
      );
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex >= 0 && bestScore >= TRACK_MATCH_THRESHOLD) {
      used.add(bestIndex);
      assignments.push({
        canonicalIndex,
        playlistIndex: bestIndex,
        score: bestScore,
      });
    }
  }

  return assignments;
}

/**
 * Coverage of a MusicBrainz tracklist by a SoundCloud playlist/set.
 * Playlist supersets are OK: every canonical track must match some playlist
 * track (title + duration); extras on the playlist are ignored.
 * Playlist order is ignored — fan sets rearrange freely.
 */
export function scorePlaylistTracklistCoverage(
  canonicalTracks: CanonicalTrackForCoverage[],
  playlistTracks: PlaylistTrackForCoverage[],
): PlaylistCoverageResult {
  const total = canonicalTracks.length;
  if (total === 0) {
    return { covered: 0, total: 0, ratio: 0 };
  }
  const assignments = matchPlaylistTracksToCanonical(canonicalTracks, playlistTracks);
  const covered = assignments.length;
  const downloadable = scoreSoundCloudDownloadableCoverage(
    assignments,
    playlistTracks,
    total,
  );
  return {
    covered,
    total,
    ratio: covered / total,
    downloadable,
  };
}

export function playlistCoversCanonicalTracklist(
  canonicalTracks: CanonicalTrackForCoverage[],
  playlistTracks: Array<{ title?: string | null; duration?: number | null; trackNumber?: number | null }>,
): boolean {
  const coverage = scorePlaylistTracklistCoverage(canonicalTracks, playlistTracks);
  if (coverage.total <= 0) return false;
  if (coverage.covered === coverage.total) return true;
  // Near-complete fan sets (e.g. 6/7 or 10/11) are good enough for mixtapes.
  return coverage.covered >= Math.ceil(coverage.total * PLAYLIST_TRACKLIST_COVERAGE_MIN_RATIO);
}

export function rankSoundCloudPlaylistCandidates(
  albums: ProviderAlbum[],
  releaseGroupTitle: string,
  preferredTrackCount?: number | null,
): ProviderAlbum[] {
  // When we will verify tracklist coverage, keep a lower title floor so
  // truncated fan-set names (e.g. "other-peoples-her") still get hydrated.
  const minTitleScore = Number(preferredTrackCount || 0) > 0 ? 0.55 : 0.72;
  const preferred = Number(preferredTrackCount || 0);
  return albums
    .map((album) => {
      const titleScore = scoreReleaseTitleSimilarity(album.title, releaseGroupTitle);
      // Preserve null (unknown) vs explicit 0 (empty stub).
      const rawTrackCount = album.trackCount;
      const trackCount = typeof rawTrackCount === "number" ? rawTrackCount : -1;
      const isEmptyStub = rawTrackCount === 0;
      const coversFloor = preferred <= 0
        || trackCount < 0
        || trackCount >= preferred;
      const extras = preferred > 0 && trackCount > preferred ? trackCount - preferred : 0;
      return { album, titleScore, coversFloor, extras, trackCount, isEmptyStub };
    })
    // Empty official SC album shells must not outrank covering fan playlists.
    .filter((row) => row.titleScore >= minTitleScore && !row.isEmptyStub && row.coversFloor)
    .sort((left, right) =>
      right.titleScore - left.titleScore
      || left.extras - right.extras
      || right.trackCount - left.trackCount
      || String(left.album.providerId).localeCompare(String(right.album.providerId)))
    .map((row) => row.album);
}
