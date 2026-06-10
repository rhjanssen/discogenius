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

export function getMetadataType(input: Pick<ExtraFileUpsertInput, "fileType" | "albumId" | "mediaId">): MetadataFileType {
  if (input.fileType === "cover") {
    return input.albumId ? "AlbumImage" : "ArtistImage";
  }

  if (input.fileType === "video_cover") {
    return "AlbumImage";
  }

  if (input.fileType === "video_thumbnail") {
    return "TrackImage";
  }

  if (input.fileType === "nfo") {
    if (input.mediaId) {
      return "TrackMetadata";
    }
    return input.albumId ? "AlbumMetadata" : "ArtistMetadata";
  }

  return "Unknown";
}

export class MetadataFileService {
  static upsert(input: ExtraFileUpsertInput): number {
    const base = ExtraFileService.buildBaseRecord(input);
    const metadataType = getMetadataType(input);

    const info = db.prepare(`
      INSERT INTO MetadataFiles (
        artist_id, album_id, track_file_id, media_id,
        relative_path, file_path, library_root, extension,
        hash, consumer, type, file_type,
        provider, provider_entity_type, provider_id,
        library_slot, expected_path, needs_rename, last_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'Discogenius', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(file_path) DO UPDATE SET
        artist_id = excluded.artist_id,
        album_id = excluded.album_id,
        track_file_id = excluded.track_file_id,
        media_id = excluded.media_id,
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
        expected_path = excluded.expected_path,
        needs_rename = excluded.needs_rename,
        last_updated = CURRENT_TIMESTAMP
    `).run(
      base.artist_id,
      base.album_id,
      base.track_file_id,
      base.media_id,
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
      base.expected_path,
      base.needs_rename,
    );

    return Number(info.lastInsertRowid || ExtraFileService.findIdByPath("MetadataFiles", input.filePath) || 0);
  }
}
