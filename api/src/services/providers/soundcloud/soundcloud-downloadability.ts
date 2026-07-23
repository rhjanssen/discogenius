import type { SoundCloudTrackResource, SoundCloudTranscoding } from "./soundcloud-api.js";

/**
 * Discogenius download entitlement inferred from api-v2 `policy` +
 * `media.transcodings` (available on search/hydrate without resolving stream URLs).
 *
 * - progressive: non-snipped progressive MP3/AAC — preferred native path
 * - hls: plain HLS with no encrypted sibling (may resolve via ffmpeg)
 * - snip: account preview-only (policy=SNIP or only snipped streams)
 * - drm: encrypted-only, or plain HLS listed beside encrypted (phantom for downloaders)
 * - block: policy=BLOCK
 * - unknown: no policy/media evidence yet (stub track)
 */
export type SoundCloudDownloadability =
  | "progressive"
  | "hls"
  | "snip"
  | "drm"
  | "block"
  | "unknown";

function asTrackResource(
  track: SoundCloudTrackResource | { raw?: unknown; policy?: string | null } | null | undefined,
): SoundCloudTrackResource | null {
  if (!track || typeof track !== "object") return null;
  const withRaw = track as { raw?: unknown };
  if (withRaw.raw && typeof withRaw.raw === "object") {
    return withRaw.raw as SoundCloudTrackResource;
  }
  return track as SoundCloudTrackResource;
}

function transcodingsOf(track: SoundCloudTrackResource): SoundCloudTranscoding[] {
  return Array.isArray(track.media?.transcodings) ? track.media!.transcodings! : [];
}

function protocolOf(item: SoundCloudTranscoding): string {
  return String(item.format?.protocol || "").toLowerCase();
}

/**
 * Classify whether Discogenius can download this SoundCloud track for the
 * current account, without resolving stream URLs.
 *
 * Go+ often lists plain `hls` next to `*-encrypted-hls` for major-label tracks;
 * that plain HLS typically 404s on resolve — treat it as DRM at search time.
 */
export function classifySoundCloudTrackDownloadability(
  track: SoundCloudTrackResource | { raw?: unknown; policy?: string | null } | null | undefined,
): SoundCloudDownloadability {
  const resource = asTrackResource(track);
  if (!resource) return "unknown";

  const policy = String(resource.policy || "").toUpperCase();
  if (policy === "BLOCK") return "block";
  if (policy === "SNIP") return "snip";

  const transcodings = transcodingsOf(resource);
  if (transcodings.length === 0 && !policy) return "unknown";
  if (transcodings.length === 0) {
    // Policy present but no media — treat SNIP/BLOCK already handled; else unknown.
    return "unknown";
  }

  const hasEncrypted = transcodings.some((item) => protocolOf(item).includes("encrypted"));
  const hasProgressive = transcodings.some((item) =>
    protocolOf(item) === "progressive" && !item.snipped);
  const hasPlainHls = transcodings.some((item) => protocolOf(item) === "hls" && !item.snipped);
  const hasSnippedOnly = transcodings.length > 0
    && transcodings.every((item) => item.snipped || protocolOf(item).includes("encrypted"));

  // Progressive wins even when encrypted siblings exist (fan uploads sometimes
  // advertise both; progressive resolve works).
  if (hasProgressive) return "progressive";

  // Plain HLS beside encrypted is a phantom for Discogenius downloaders.
  if (hasEncrypted && hasPlainHls) return "drm";
  if (hasEncrypted) return "drm";

  if (hasPlainHls) return "hls";
  if (hasSnippedOnly || transcodings.some((item) => item.snipped)) return "snip";
  return "unknown";
}

/** True when Discogenius has a real progressive/plain-HLS download path. */
export function isSoundCloudTrackDownloadable(
  track: SoundCloudTrackResource | { raw?: unknown; policy?: string | null } | null | undefined,
): boolean {
  const kind = classifySoundCloudTrackDownloadability(track);
  return kind === "progressive" || kind === "hls";
}

/** True when search/hydrate evidence shows the track is undownloadable (not merely unknown). */
export function isSoundCloudTrackKnownUndownloadable(
  track: SoundCloudTrackResource | { raw?: unknown; policy?: string | null } | null | undefined,
): boolean {
  const kind = classifySoundCloudTrackDownloadability(track);
  return kind === "drm" || kind === "snip" || kind === "block";
}

/**
 * Drop DRM/SNIP/BLOCK/phantom-HLS tracks from search results when classification
 * evidence is present. Keep unknowns (stubs) so callers can hydrate later.
 */
export function filterDownloadableSoundCloudSearchTracks<T extends SoundCloudTrackResource>(
  tracks: T[],
): T[] {
  return tracks.filter((track) => {
    const kind = classifySoundCloudTrackDownloadability(track);
    if (kind === "unknown") return true;
    return kind === "progressive" || kind === "hls";
  });
}

export type SoundCloudDownloadableCoverage = {
  covered: number;
  downloadableCovered: number;
  knownUndownloadableCovered: number;
  unknownCovered: number;
  total: number;
  /** downloadableCovered / total */
  downloadableRatio: number;
};

/**
 * Among tracks assigned to the canonical tracklist, count how many Discogenius
 * can actually download. Unknown (unhydrated) tracks do not count as downloadable.
 */
export function scoreSoundCloudDownloadableCoverage(
  assignments: Array<{ playlistIndex: number }>,
  playlistTracks: Array<SoundCloudTrackResource | { raw?: unknown; policy?: string | null } | null | undefined>,
  canonicalTotal: number,
): SoundCloudDownloadableCoverage {
  let downloadableCovered = 0;
  let knownUndownloadableCovered = 0;
  let unknownCovered = 0;
  for (const assignment of assignments) {
    const track = playlistTracks[assignment.playlistIndex];
    const kind = classifySoundCloudTrackDownloadability(track);
    if (kind === "progressive" || kind === "hls") {
      downloadableCovered += 1;
    } else if (kind === "drm" || kind === "snip" || kind === "block") {
      knownUndownloadableCovered += 1;
    } else {
      unknownCovered += 1;
    }
  }
  const total = Math.max(0, canonicalTotal);
  return {
    covered: assignments.length,
    downloadableCovered,
    knownUndownloadableCovered,
    unknownCovered,
    total,
    downloadableRatio: total > 0 ? downloadableCovered / total : 0,
  };
}

/**
 * An offer is a real Discogenius match only when enough covering tracks are
 * downloadable. DRM-only (or SNIP-only) shells must not drive monitoring.
 *
 * When no track has classifiable media yet (stubs / pre-hydrate), defer to
 * title coverage alone — callers should hydrate before durable accept.
 */
export function soundCloudOfferHasDownloadableMatch(
  coverage: SoundCloudDownloadableCoverage,
  minRatio = 0.85,
): boolean {
  if (coverage.total <= 0) return false;
  const classifiable = coverage.downloadableCovered + coverage.knownUndownloadableCovered;
  if (classifiable === 0) return true;
  if (coverage.downloadableCovered <= 0) return false;
  if (coverage.downloadableCovered === coverage.total) return true;
  return coverage.downloadableCovered >= Math.ceil(coverage.total * minRatio);
}
