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

  const providerClause = provider ? "provider_item.provider = ? AND" : "";
  const params = provider ? [provider, entityType, id] : [entityType, id];
  return (db.prepare(`
    SELECT
      provider_item.provider,
      provider_item.entity_type,
      provider_item.provider_id,
      COALESCE(provider_item.artist_mbid, recording.artist_mbid) AS artist_mbid,
      provider_item.release_group_mbid,
      provider_item.release_mbid,
      provider_item.track_mbid,
      COALESCE(provider_item.recording_mbid, recording.mbid) AS recording_mbid,
      provider_item.library_slot
    FROM ProviderItems provider_item
    LEFT JOIN Recordings recording ON recording.id = provider_item.recording_id
    WHERE ${providerClause} provider_item.entity_type = ? AND provider_item.provider_id = ?
    ORDER BY provider_item.updated_at DESC
    LIMIT 1
  `).get(...params) as ProviderItemRow | undefined) ?? null;
}

export function resolveLibraryFileIdentity(input: LibraryFileIdentityInput): LibraryFileIdentity {
  // Canonical-only resolver: provider ids resolve through ProviderItems (keyed by
  // provider_id) + the canonical graph + ReleaseGroupSlots. ProviderItems is the
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
  // Prefer an explicit job/import RG (hybrid composites) when looking up the slot,
  // then fall back to matching the native provider album id inside a composite id.
  const releaseGroupMbidHint = nullableText(input.canonicalReleaseGroupMbid);
  const releaseGroupSlot = releaseGroupMbidHint
    ? (db.prepare(`
        SELECT release_group_mbid, selected_release_mbid, selected_provider, slot
        FROM ReleaseGroupSlots
        WHERE release_group_mbid = ?
        ORDER BY CASE WHEN slot = ? THEN 0 ELSE 1 END
        LIMIT 1
      `).get(releaseGroupMbidHint, preferredSlot) as ReleaseGroupSlotRow | undefined) ?? null
    : albumId
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
  // Resolve the exact track for the selected (hybrid) release via recording mbid.
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

  // When a ReleaseGroupSlot is bound (especially composite hybrids), slot /
  // remapped track identity outranks native ProviderItems RG/track MBIDs so
  // organize/naming/tags follow the monitored hybrid, not the source albums.
  const slotReleaseGroupMbid = nullableText(releaseGroupSlot?.release_group_mbid);
  const slotReleaseMbid = nullableText(releaseGroupSlot?.selected_release_mbid);
  const slotTrackMbid = nullableText(selectedTrack?.mbid);
  const inputTrackMbid = nullableText(input.canonicalTrackMbid);
  // Explicit job track MBIDs win only when they belong on the selected
  // release. Hybrid downloads often carry the *native* source-album track
  // MBID (Pompeii=1 on its single); keeping that here produced `01 - Pompeii`
  // on Killing Me Softly instead of hybrid track 2.
  const inputTrackOnSelectedRelease = Boolean(
    inputTrackMbid
    && slotReleaseMbid
    && (db.prepare(`
      SELECT mbid FROM Tracks WHERE release_mbid = ? AND mbid = ? LIMIT 1
    `).get(slotReleaseMbid, inputTrackMbid) as MbTrackRow | undefined),
  );
  const resolvedTrackMbid = inputTrackOnSelectedRelease
    ? inputTrackMbid
    : (slotTrackMbid
      ?? (slotReleaseMbid ? null : inputTrackMbid)
      ?? nullableText(providerMedia?.track_mbid)
      ?? null);

  return {
    canonicalArtistMbid:
      nullableText(input.canonicalArtistMbid)
      ?? nullableText(providerMedia?.artist_mbid)
      ?? nullableText(providerAlbum?.artist_mbid)
      ?? nullableText(artist?.mbid)
      ?? null,
    canonicalReleaseGroupMbid:
      nullableText(input.canonicalReleaseGroupMbid)
      ?? slotReleaseGroupMbid
      // Prefer the album offer's RG over the track row's. Hybrid source tracks
      // are often mis-matched onto unrelated singles (Rehab vs Back to Black).
      ?? nullableText(providerAlbum?.release_group_mbid)
      ?? nullableText(providerMedia?.release_group_mbid)
      ?? null,
    canonicalReleaseMbid:
      nullableText(input.canonicalReleaseMbid)
      ?? slotReleaseMbid
      ?? nullableText(providerMedia?.release_mbid)
      ?? nullableText(providerAlbum?.release_mbid)
      ?? null,
    canonicalTrackMbid: resolvedTrackMbid,
    canonicalRecordingMbid:
      nullableText(input.canonicalRecordingMbid)
      ?? nullableText(selectedTrack?.recording_mbid)
      ?? nullableText(providerMedia?.recording_mbid)
      ?? null,
    provider: providerMedia?.provider ?? providerAlbum?.provider ?? provider ?? null,
    providerEntityType,
    providerId,
    librarySlot: preferredSlot,
  };
}
