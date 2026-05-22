import { db } from "../database.js";
import { isSpatialAudioQuality } from "../utils/spatial-audio.js";

export type LibrarySlot = "stereo" | "spatial" | "video";

export type LibraryFileIdentityInput = {
  artistId?: string | number | null;
  albumId?: string | number | null;
  mediaId?: string | number | null;
  fileType?: string | null;
  quality?: string | null;
  libraryRoot?: string | null;
  provider?: string | null;
  providerEntityType?: string | null;
  providerId?: string | number | null;
  librarySlot?: LibrarySlot | string | null;
  canonicalArtistMbid?: string | null;
  canonicalReleaseGroupMbid?: string | null;
  canonicalReleaseMbid?: string | null;
  canonicalTrackMbid?: string | null;
  canonicalRecordingMbid?: string | null;
};

export type LibraryFileIdentity = {
  canonicalArtistMbid: string | null;
  canonicalReleaseGroupMbid: string | null;
  canonicalReleaseMbid: string | null;
  canonicalTrackMbid: string | null;
  canonicalRecordingMbid: string | null;
  provider: string | null;
  providerEntityType: string | null;
  providerId: string | null;
  librarySlot: LibrarySlot | null;
};

type ArtistRow = { mbid: string | null };
type AlbumRow = {
  artist_id: string | number | null;
  mbid: string | null;
  mb_release_group_id: string | null;
  quality: string | null;
};
type MediaRow = {
  artist_id: string | number | null;
  album_id: string | number | null;
  mbid: string | null;
  type: string | null;
  quality: string | null;
};
type MbTrackRow = { mbid: string; release_mbid: string; recording_mbid: string };
type MbReleaseRow = { mbid: string; release_group_mbid: string };
type ProviderItemRow = {
  provider: string;
  entity_type: string;
  provider_id: string;
  artist_mbid: string | null;
  release_group_mbid: string | null;
  release_mbid: string | null;
  track_mbid: string | null;
  recording_mbid: string | null;
  library_slot: LibrarySlot | string | null;
};

function nullableText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function getRow<T>(sql: string, value: unknown): T | null {
  const key = nullableText(value);
  if (!key) {
    return null;
  }
  return (db.prepare(sql).get(key) as T | undefined) ?? null;
}

function inferLibrarySlot(input: LibraryFileIdentityInput): LibrarySlot | null {
  const explicit = nullableText(input.librarySlot)?.toLowerCase();
  if (explicit === "stereo" || explicit === "spatial" || explicit === "video") {
    return explicit;
  }

  const fileType = nullableText(input.fileType)?.toLowerCase() ?? "";
  const root = nullableText(input.libraryRoot)?.toLowerCase() ?? "";
  const quality = nullableText(input.quality);

  if (fileType.includes("video") || root.includes("video")) {
    return "video";
  }

  if (isSpatialAudioQuality(quality) || root.includes("spatial") || root.includes("atmos")) {
    return "spatial";
  }

  if (["track", "cover", "nfo", "lyrics", "bio", "review"].includes(fileType)) {
    return "stereo";
  }

  return null;
}

function inferProviderEntityType(input: LibraryFileIdentityInput, media: MediaRow | null): string | null {
  const explicit = nullableText(input.providerEntityType);
  if (explicit) {
    return explicit;
  }

  const fileType = nullableText(input.fileType)?.toLowerCase() ?? "";
  const mediaType = nullableText(media?.type)?.toLowerCase() ?? "";
  if (fileType.includes("video") || mediaType.includes("video")) {
    return "video";
  }
  if (nullableText(input.mediaId)) {
    return "track";
  }
  if (nullableText(input.albumId)) {
    return "album";
  }
  if (nullableText(input.artistId)) {
    return "artist";
  }
  return null;
}

function inferProviderId(input: LibraryFileIdentityInput, providerEntityType: string | null): string | null {
  const explicit = nullableText(input.providerId);
  if (explicit) {
    return explicit;
  }

  if (providerEntityType === "track" || providerEntityType === "video") {
    return nullableText(input.mediaId);
  }
  if (providerEntityType === "album") {
    return nullableText(input.albumId);
  }
  if (providerEntityType === "artist") {
    return null;
  }
  return nullableText(input.mediaId) ?? nullableText(input.albumId) ?? nullableText(input.artistId);
}

function getProviderItem(provider: string | null, entityType: string, providerId: unknown): ProviderItemRow | null {
  const id = nullableText(providerId);
  if (!id) {
    return null;
  }

  const providerClause = provider ? "provider = ? AND" : "";
  const params = provider ? [provider, entityType, id] : [entityType, id];
  return (db.prepare(`
    SELECT provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
           track_mbid, recording_mbid, library_slot
    FROM ProviderItems
    WHERE ${providerClause} entity_type = ? AND provider_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(...params) as ProviderItemRow | undefined) ?? null;
}

export function resolveLibraryFileIdentity(input: LibraryFileIdentityInput): LibraryFileIdentity {
  const media = getRow<MediaRow>(
    "SELECT artist_id, album_id, mbid, type, quality FROM ProviderMedia WHERE CAST(id AS TEXT) = ? LIMIT 1",
    input.mediaId
  );
  const albumId = nullableText(input.albumId) ?? nullableText(media?.album_id);
  const album = getRow<AlbumRow>(
    "SELECT artist_id, mbid, mb_release_group_id, quality FROM ProviderAlbums WHERE CAST(id AS TEXT) = ? LIMIT 1",
    albumId
  );
  const artistId = nullableText(input.artistId) ?? nullableText(album?.artist_id) ?? nullableText(media?.artist_id);
  const artist = getRow<ArtistRow>(
    "SELECT mbid FROM Artists WHERE CAST(id AS TEXT) = ? LIMIT 1",
    artistId
  );

  const albumRelease = getRow<MbReleaseRow>(
    "SELECT mbid, release_group_mbid FROM AlbumReleases WHERE mbid = ? LIMIT 1",
    album?.mbid
  );
  const mediaTrack = getRow<MbTrackRow>(
    "SELECT mbid, release_mbid, recording_mbid FROM Tracks WHERE mbid = ? LIMIT 1",
    media?.mbid
  );
  const mediaRecording = getRow<{ mbid: string }>(
    "SELECT mbid FROM Recordings WHERE mbid = ? LIMIT 1",
    media?.mbid
  );
  const trackRelease = getRow<MbReleaseRow>(
    "SELECT mbid, release_group_mbid FROM AlbumReleases WHERE mbid = ? LIMIT 1",
    mediaTrack?.release_mbid
  );

  const providerEntityType = inferProviderEntityType(input, media);
  const providerId = inferProviderId(input, providerEntityType);
  const provider = nullableText(input.provider) ?? (providerId ? "tidal" : null);
  const providerAlbum = getProviderItem(provider, "album", albumId);
  const providerMedia = providerEntityType
    ? getProviderItem(provider, providerEntityType, providerId)
    : null;

  return {
    canonicalArtistMbid:
      nullableText(input.canonicalArtistMbid)
      ?? nullableText(artist?.mbid)
      ?? nullableText(providerMedia?.artist_mbid)
      ?? nullableText(providerAlbum?.artist_mbid)
      ?? null,
    canonicalReleaseGroupMbid:
      nullableText(input.canonicalReleaseGroupMbid)
      ?? nullableText(album?.mb_release_group_id)
      ?? nullableText(providerMedia?.release_group_mbid)
      ?? nullableText(providerAlbum?.release_group_mbid)
      ?? nullableText(albumRelease?.release_group_mbid)
      ?? nullableText(trackRelease?.release_group_mbid)
      ?? null,
    canonicalReleaseMbid:
      nullableText(input.canonicalReleaseMbid)
      ?? nullableText(albumRelease?.mbid)
      ?? nullableText(mediaTrack?.release_mbid)
      ?? nullableText(providerMedia?.release_mbid)
      ?? nullableText(providerAlbum?.release_mbid)
      ?? null,
    canonicalTrackMbid:
      nullableText(input.canonicalTrackMbid)
      ?? nullableText(mediaTrack?.mbid)
      ?? nullableText(providerMedia?.track_mbid)
      ?? null,
    canonicalRecordingMbid:
      nullableText(input.canonicalRecordingMbid)
      ?? nullableText(mediaTrack?.recording_mbid)
      ?? nullableText(mediaRecording?.mbid)
      ?? nullableText(providerMedia?.recording_mbid)
      ?? null,
    provider: providerMedia?.provider ?? providerAlbum?.provider ?? provider,
    providerEntityType,
    providerId,
    librarySlot: inferLibrarySlot({
      ...input,
      librarySlot: input.librarySlot ?? providerMedia?.library_slot ?? providerAlbum?.library_slot,
      quality: input.quality ?? media?.quality ?? album?.quality,
    }),
  };
}
