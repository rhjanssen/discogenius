export interface ReleaseIdentityAlbum {
  id: string | number;
  title?: string | null;
  version?: string | null;
  version_group_id?: string | number | null;
  mbid?: string | null;
  mb_release_group_id?: string | null;
  upc?: string | null;
}

export interface ReleaseIdentityTrack {
  isrc?: string | null;
  title?: string | null;
}

function normalizeIdentifier(value: string | number | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized.toLowerCase() : null;
}

export function normalizeReleaseText(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/[_./\\-]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTrackTitle(value: string | null | undefined): string {
  return normalizeReleaseText(value).replace(/\s+/g, "");
}

/**
 * Fine-grained edition identity used for selecting between equivalent provider
 * variants. Prefer shared exact-release identifiers so TIDAL, Apple Music, and
 * imported files can meet at the same key. Do not use MusicBrainz release-group
 * IDs here: MB release groups are intentionally broad and often combine standard,
 * deluxe, remaster, and bonus editions that Discogenius should keep as separately
 * curatable releases.
 */
export function buildEditionIdentityKey(album: ReleaseIdentityAlbum): string {
  const musicBrainzReleaseId = normalizeIdentifier(album.mbid);
  if (musicBrainzReleaseId) {
    return `mb-release:${musicBrainzReleaseId}`;
  }

  const upc = normalizeIdentifier(album.upc);
  if (upc) {
    return `upc:${upc}`;
  }

  const providerVersionGroupId = normalizeIdentifier(album.version_group_id);
  if (providerVersionGroupId) {
    return `provider-version:${providerVersionGroupId}`;
  }

  const title = normalizeReleaseText(album.title);
  const version = normalizeReleaseText(album.version);
  return `title-version:${title}:${version}`;
}

export function buildMusicBrainzReleaseGroupKey(album: ReleaseIdentityAlbum): string | null {
  const releaseGroupId = normalizeIdentifier(album.mb_release_group_id);
  return releaseGroupId ? `mb-release-group:${releaseGroupId}` : null;
}

export function buildIsrcSet(tracks: ReleaseIdentityTrack[]): Set<string> {
  return new Set(
    tracks
      .map((track) => normalizeIdentifier(track.isrc))
      .filter((value): value is string => Boolean(value)),
  );
}

export function buildNormalizedTrackTitleSet(tracks: ReleaseIdentityTrack[]): Set<string> {
  return new Set(
    tracks
      .map((track) => normalizeTrackTitle(track.title))
      .filter(Boolean),
  );
}
