import { db } from "../../database.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";

export type library_slot = "stereo" | "spatial" | "video";

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
  librarySlot?: library_slot | string | null;
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
  librarySlot: library_slot;
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
  track_number: number | null;
  volume_number: number | null;
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
  library_slot: library_slot | string | null;
};
type ReleaseGroupSlotRow = {
  release_group_mbid: string;
  selected_release_mbid: string | null;
  selected_provider: string | null;
  slot: library_slot | string | null;
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

function inferLibrarySlot(input: LibraryFileIdentityInput): library_slot {
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

  return "stereo";
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
  // Canonical-only resolver: provider ids resolve through ProviderItems (keyed by
  // provider_id) + the canonical graph + ReleaseGroupSlots. The legacy
  // ProviderMedia/ProviderAlbums catalog reads were removed — ProviderItems is the
  // single provider-availability source.
  const albumId = nullableText(input.albumId);
  const artistId = nullableText(input.artistId);
  const artist = getRow<ArtistRow>(
    "SELECT mbid FROM Artists WHERE CAST(id AS TEXT) = ? LIMIT 1",
    artistId
  );

  const providerEntityType = inferProviderEntityType(input, null);
  const providerId = inferProviderId(input, providerEntityType);
  const provider = nullableText(input.provider);
  const providerAlbum = getProviderItem(provider, "album", albumId);
  const providerMedia = providerEntityType
    ? getProviderItem(provider, providerEntityType, providerId)
    : null;
  const preferredSlot = inferLibrarySlot({
    ...input,
    librarySlot: input.librarySlot ?? providerMedia?.library_slot ?? providerAlbum?.library_slot,
    quality: input.quality,
  });
  const releaseGroupSlot = albumId
    ? (db.prepare(`
        SELECT release_group_mbid, selected_release_mbid, selected_provider, slot
        FROM ReleaseGroupSlots
        WHERE selected_provider_id = ?
           OR selected_provider_id LIKE ?
           OR selected_provider_id LIKE ?
           OR selected_provider_id LIKE ?
        ORDER BY CASE WHEN slot = ? THEN 0 ELSE 1 END
        LIMIT 1
      `).get(albumId, `${albumId};%`, `%;${albumId};%`, `%;${albumId}`, preferredSlot) as ReleaseGroupSlotRow | undefined) ?? null
    : null;
  // Resolve the exact track for the selected release via the provider offer's
  // recording mbid (no provider-catalog position matching needed).
  const offerRecordingMbid = nullableText(input.canonicalRecordingMbid) ?? nullableText(providerMedia?.recording_mbid);
  const selectedTrack = releaseGroupSlot?.selected_release_mbid && offerRecordingMbid
    ? (db.prepare(`
        SELECT mbid, release_mbid, recording_mbid
        FROM Tracks
        WHERE release_mbid = ?
          AND recording_mbid = ?
        ORDER BY mbid ASC
        LIMIT 1
      `).get(releaseGroupSlot.selected_release_mbid, offerRecordingMbid) as MbTrackRow | undefined) ?? null
    : null;

  const legacyProvider = providerId ? "tidal" : null;

  return {
    canonicalArtistMbid:
      nullableText(input.canonicalArtistMbid)
      ?? nullableText(providerMedia?.artist_mbid)
      ?? nullableText(providerAlbum?.artist_mbid)
      ?? nullableText(artist?.mbid)
      ?? null,
    canonicalReleaseGroupMbid:
      nullableText(input.canonicalReleaseGroupMbid)
      ?? nullableText(providerMedia?.release_group_mbid)
      ?? nullableText(providerAlbum?.release_group_mbid)
      ?? nullableText(releaseGroupSlot?.release_group_mbid)
      ?? null,
    canonicalReleaseMbid:
      nullableText(input.canonicalReleaseMbid)
      ?? nullableText(releaseGroupSlot?.selected_release_mbid)
      ?? nullableText(providerMedia?.release_mbid)
      ?? nullableText(providerAlbum?.release_mbid)
      ?? null,
    canonicalTrackMbid:
      nullableText(input.canonicalTrackMbid)
      ?? nullableText(providerMedia?.track_mbid)
      ?? nullableText(selectedTrack?.mbid)
      ?? null,
    canonicalRecordingMbid:
      nullableText(input.canonicalRecordingMbid)
      ?? nullableText(providerMedia?.recording_mbid)
      ?? nullableText(selectedTrack?.recording_mbid)
      ?? null,
    provider: providerMedia?.provider ?? providerAlbum?.provider ?? provider ?? legacyProvider,
    providerEntityType,
    providerId,
    librarySlot: preferredSlot,
  };
}
