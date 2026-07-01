import { db } from "../../../../database.js";
import { ExtraFileService, type ExtraFileUpsertInput } from "../../files/extra-file-service.js";

export type MetadataFileType =
  | "ArtistMetadata"
  | "TrackMetadata"
  | "ArtistImage"
  | "AlbumImage"
  | "TrackImage"
  | "AlbumMetadata"
  | "Unknown";

export function getMetadataType(input: Pick<ExtraFileUpsertInput,
  "fileType" |
  "providerEntityType" |
  "canonicalReleaseGroupMbid" |
  "canonicalReleaseMbid" |
  "canonicalTrackMbid" |
  "canonicalRecordingMbid"
>): MetadataFileType {
  const providerEntityType = String(input.providerEntityType || "").trim();
  const isAlbumScoped = Boolean(input.canonicalReleaseGroupMbid || input.canonicalReleaseMbid || providerEntityType === "album");
  const isTrackScoped = Boolean(input.canonicalTrackMbid || input.canonicalRecordingMbid || providerEntityType === "track" || providerEntityType === "video");

  if (input.fileType === "cover") {
    return isAlbumScoped ? "AlbumImage" : "ArtistImage";
  }

  if (input.fileType === "video_cover") {
    return "AlbumImage";
  }

  if (input.fileType === "video_thumbnail") {
    return "TrackImage";
  }

  if (input.fileType === "nfo") {
    if (isTrackScoped) {
      return "TrackMetadata";
    }
    return isAlbumScoped ? "AlbumMetadata" : "ArtistMetadata";
  }

  return "Unknown";
}

export class MetadataFileService {
  static upsert(input: ExtraFileUpsertInput): number {
    const base = ExtraFileService.buildBaseRecord(input);
    const metadataType = getMetadataType(input);

    const info = db.prepare(`
      INSERT INTO MetadataFiles (
        artist_id, track_file_id,
        relative_path, file_path, library_root, extension,
        hash, consumer, type, file_type,
        provider, provider_entity_type, provider_id,
        library_slot,
        canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
        canonical_track_mbid, canonical_recording_mbid,
        expected_path, needs_rename, last_updated
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'Discogenius', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(file_path) DO UPDATE SET
        artist_id = excluded.artist_id,
        track_file_id = excluded.track_file_id,
        relative_path = excluded.relative_path,
        library_root = excluded.library_root,
        extension = excluded.extension,
        consumer = excluded.consumer,
        type = excluded.type,
        file_type = excluded.file_type,
        provider = excluded.provider,
        provider_entity_type = excluded.provider_entity_type,
        provider_id = excluded.provider_id,
        library_slot = excluded.library_slot,
        canonical_artist_mbid = COALESCE(excluded.canonical_artist_mbid, MetadataFiles.canonical_artist_mbid),
        canonical_release_group_mbid = COALESCE(excluded.canonical_release_group_mbid, MetadataFiles.canonical_release_group_mbid),
        canonical_release_mbid = COALESCE(excluded.canonical_release_mbid, MetadataFiles.canonical_release_mbid),
        canonical_track_mbid = COALESCE(excluded.canonical_track_mbid, MetadataFiles.canonical_track_mbid),
        canonical_recording_mbid = COALESCE(excluded.canonical_recording_mbid, MetadataFiles.canonical_recording_mbid),
        expected_path = excluded.expected_path,
        needs_rename = excluded.needs_rename,
        last_updated = CURRENT_TIMESTAMP
    `).run(
      base.artist_id,
      base.track_file_id,
      base.relative_path,
      base.file_path,
      base.library_root,
      base.extension,
      metadataType,
      input.fileType,
      base.provider,
      base.provider_entity_type,
      base.provider_id,
      base.library_slot,
      base.canonical_artist_mbid,
      base.canonical_release_group_mbid,
      base.canonical_release_mbid,
      base.canonical_track_mbid,
      base.canonical_recording_mbid,
      base.expected_path,
      base.needs_rename,
    );

    return Number(info.lastInsertRowid || ExtraFileService.findIdByPath("MetadataFiles", input.filePath) || 0);
  }
}
