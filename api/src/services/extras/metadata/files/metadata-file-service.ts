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
        ArtistId, AlbumId, TrackFileId, MediaId,
        RelativePath, FilePath, LibraryRoot, Extension,
        Hash, Consumer, Type, FileType,
        Provider, ProviderEntityType, ProviderId,
        LibrarySlot, ExpectedPath, NeedsRename, LastUpdated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'Discogenius', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(FilePath) DO UPDATE SET
        ArtistId = excluded.ArtistId,
        AlbumId = excluded.AlbumId,
        TrackFileId = excluded.TrackFileId,
        MediaId = excluded.MediaId,
        RelativePath = excluded.RelativePath,
        LibraryRoot = excluded.LibraryRoot,
        Extension = excluded.Extension,
        Consumer = excluded.Consumer,
        Type = excluded.Type,
        FileType = excluded.FileType,
        Provider = excluded.Provider,
        ProviderEntityType = excluded.ProviderEntityType,
        ProviderId = excluded.ProviderId,
        LibrarySlot = excluded.LibrarySlot,
        ExpectedPath = excluded.ExpectedPath,
        NeedsRename = excluded.NeedsRename,
        LastUpdated = CURRENT_TIMESTAMP
    `).run(
      base.ArtistId,
      base.AlbumId,
      base.TrackFileId,
      base.MediaId,
      base.RelativePath,
      base.FilePath,
      base.LibraryRoot,
      base.Extension,
      metadataType,
      input.fileType,
      base.Provider,
      base.ProviderEntityType,
      base.ProviderId,
      base.LibrarySlot,
      base.ExpectedPath,
      base.NeedsRename,
    );

    return Number(info.lastInsertRowid || ExtraFileService.findIdByPath("MetadataFiles", input.filePath) || 0);
  }
}
