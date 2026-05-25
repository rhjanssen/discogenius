import fs from "fs";
import path from "path";
import { db } from "../../../database.js";

export const METADATA_EXTRA_FILE_TYPES = new Set(["cover", "video_cover", "video_thumbnail", "nfo"]);
export const LYRIC_EXTRA_FILE_TYPES = new Set(["lyrics"]);
export const EXTRA_FILE_TYPES = new Set([...METADATA_EXTRA_FILE_TYPES, ...LYRIC_EXTRA_FILE_TYPES]);

export type ExtraFileUpsertInput = {
  artistId: string;
  albumId?: string | null;
  mediaId?: string | null;
  trackFileId?: number | null;
  filePath: string;
  libraryRoot: string;
  fileType: string;
  provider?: string | null;
  providerEntityType?: string | null;
  providerId?: string | null;
  librarySlot?: string | null;
  quality?: string | null;
  expectedPath?: string | null;
  canonicalArtistMbid?: string | null;
  canonicalReleaseGroupMbid?: string | null;
  canonicalReleaseMbid?: string | null;
  canonicalTrackMbid?: string | null;
  canonicalRecordingMbid?: string | null;
};

export type ExtraFileBaseRecord = {
  ArtistId: string;
  AlbumId: string | null;
  TrackFileId: number | null;
  MediaId: string | null;
  RelativePath: string;
  FilePath: string;
  LibraryRoot: string;
  Extension: string;
  Provider: string | null;
  ProviderEntityType: string | null;
  ProviderId: string | null;
  LibrarySlot: string;
  ExpectedPath: string | null;
  NeedsRename: number;
};

function nullableText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

export function isExtraFileType(fileType: string | null | undefined): boolean {
  return EXTRA_FILE_TYPES.has(String(fileType || "").trim());
}

export function isMetadataExtraFileType(fileType: string | null | undefined): boolean {
  return METADATA_EXTRA_FILE_TYPES.has(String(fileType || "").trim());
}

export function isLyricExtraFileType(fileType: string | null | undefined): boolean {
  return LYRIC_EXTRA_FILE_TYPES.has(String(fileType || "").trim());
}

export class ExtraFileService {
  static resolveTrackFileId(input: ExtraFileUpsertInput): number | null {
    if (input.trackFileId != null) {
      return Number(input.trackFileId);
    }

    const mediaId = nullableText(input.mediaId);
    if (!mediaId) {
      return null;
    }

    const row = db.prepare(`
      SELECT id
      FROM TrackFiles
      WHERE CAST(media_id AS TEXT) = CAST(? AS TEXT)
        AND file_type IN ('track', 'video')
      ORDER BY CASE file_type WHEN 'track' THEN 0 ELSE 1 END,
               verified_at DESC,
               id DESC
      LIMIT 1
    `).get(mediaId) as { id?: number } | undefined;

    return row?.id ?? null;
  }

  static buildBaseRecord(input: ExtraFileUpsertInput): ExtraFileBaseRecord {
    const relativePath = path.relative(input.libraryRoot, input.filePath);
    const extension = path.extname(input.filePath).replace(".", "");
    const expectedPath = input.expectedPath || input.filePath;

    return {
      ArtistId: input.artistId,
      AlbumId: nullableText(input.albumId),
      TrackFileId: this.resolveTrackFileId(input),
      MediaId: nullableText(input.mediaId),
      RelativePath: relativePath || path.basename(input.filePath),
      FilePath: input.filePath,
      LibraryRoot: input.libraryRoot,
      Extension: extension,
      Provider: nullableText(input.provider),
      ProviderEntityType: nullableText(input.providerEntityType),
      ProviderId: nullableText(input.providerId),
      LibrarySlot: nullableText(input.librarySlot) || "stereo",
      ExpectedPath: expectedPath,
      NeedsRename: expectedPath && expectedPath !== input.filePath ? 1 : 0,
    };
  }

  static upsert(input: ExtraFileUpsertInput): number {
    const base = this.buildBaseRecord(input);
    const info = db.prepare(`
      INSERT INTO ExtraFiles (
        ArtistId, AlbumId, TrackFileId, MediaId,
        RelativePath, FilePath, LibraryRoot, Extension,
        FileType, Provider, ProviderEntityType, ProviderId,
        LibrarySlot, ExpectedPath, NeedsRename, LastUpdated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(FilePath) DO UPDATE SET
        ArtistId = excluded.ArtistId,
        AlbumId = excluded.AlbumId,
        TrackFileId = excluded.TrackFileId,
        MediaId = excluded.MediaId,
        RelativePath = excluded.RelativePath,
        LibraryRoot = excluded.LibraryRoot,
        Extension = excluded.Extension,
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
      input.fileType,
      base.Provider,
      base.ProviderEntityType,
      base.ProviderId,
      base.LibrarySlot,
      base.ExpectedPath,
      base.NeedsRename,
    );

    return Number(info.lastInsertRowid || this.findIdByPath("ExtraFiles", input.filePath) || 0);
  }

  static findIdByPath(tableName: "MetadataFiles" | "LyricFiles" | "ExtraFiles", filePath: string): number | null {
    const row = db.prepare(`SELECT Id FROM ${tableName} WHERE FilePath = ? LIMIT 1`).get(filePath) as { Id?: number } | undefined;
    return row?.Id ?? null;
  }

  static deleteMissingRows(tableName: "MetadataFiles" | "LyricFiles" | "ExtraFiles", artistId?: string): number {
    const rows = db.prepare(`
      SELECT Id, FilePath
      FROM ${tableName}
      ${artistId ? "WHERE ArtistId = ?" : ""}
    `).all(...(artistId ? [artistId] : [])) as Array<{ Id: number; FilePath: string }>;

    const missingIds = rows.filter((row) => !fs.existsSync(row.FilePath)).map((row) => row.Id);
    if (missingIds.length === 0) {
      return 0;
    }

    const deleteStmt = db.prepare(`DELETE FROM ${tableName} WHERE Id = ?`);
    db.transaction(() => {
      for (const id of missingIds) {
        deleteStmt.run(id);
      }
    })();

    return missingIds.length;
  }
}
