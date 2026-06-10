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
  artist_id: string;
  album_id: string | null;
  track_file_id: number | null;
  media_id: string | null;
  relative_path: string;
  file_path: string;
  library_root: string;
  extension: string;
  provider: string | null;
  provider_entity_type: string | null;
  provider_id: string | null;
  library_slot: string;
  expected_path: string | null;
  needs_rename: number;
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
      artist_id: input.artistId,
      album_id: nullableText(input.albumId),
      track_file_id: this.resolveTrackFileId(input),
      media_id: nullableText(input.mediaId),
      relative_path: relativePath || path.basename(input.filePath),
      file_path: input.filePath,
      library_root: input.libraryRoot,
      extension: extension,
      provider: nullableText(input.provider),
      provider_entity_type: nullableText(input.providerEntityType),
      provider_id: nullableText(input.providerId),
      library_slot: nullableText(input.librarySlot) || "stereo",
      expected_path: expectedPath,
      needs_rename: expectedPath && expectedPath !== input.filePath ? 1 : 0,
    };
  }

  static upsert(input: ExtraFileUpsertInput): number {
    const base = this.buildBaseRecord(input);
    const info = db.prepare(`
      INSERT INTO ExtraFiles (
        artist_id, album_id, track_file_id, media_id,
        relative_path, file_path, library_root, extension,
        file_type, provider, provider_entity_type, provider_id,
        library_slot, expected_path, needs_rename, last_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(file_path) DO UPDATE SET
        artist_id = excluded.artist_id,
        album_id = excluded.album_id,
        track_file_id = excluded.track_file_id,
        media_id = excluded.media_id,
        relative_path = excluded.relative_path,
        library_root = excluded.library_root,
        extension = excluded.extension,
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
      input.fileType,
      base.provider,
      base.provider_entity_type,
      base.provider_id,
      base.library_slot,
      base.expected_path,
      base.needs_rename,
    );

    return Number(info.lastInsertRowid || this.findIdByPath("ExtraFiles", input.filePath) || 0);
  }

  static findIdByPath(tableName: "MetadataFiles" | "LyricFiles" | "ExtraFiles", filePath: string): number | null {
    const row = db.prepare(`SELECT id FROM ${tableName} WHERE file_path = ? LIMIT 1`).get(filePath) as { id?: number } | undefined;
    return row?.id ?? null;
  }

  static deleteMissingRows(tableName: "MetadataFiles" | "LyricFiles" | "ExtraFiles", artistId?: string): number {
    const rows = db.prepare(`
      SELECT id, file_path
      FROM ${tableName}
      ${artistId ? "WHERE artist_id = ?" : ""}
    `).all(...(artistId ? [artistId] : [])) as Array<{ id: number; file_path: string }>;

    const missingIds = rows.filter((row) => !fs.existsSync(row.file_path)).map((row) => row.id);
    if (missingIds.length === 0) {
      return 0;
    }

    const deleteStmt = db.prepare(`DELETE FROM ${tableName} WHERE id = ?`);
    db.transaction(() => {
      for (const id of missingIds) {
        deleteStmt.run(id);
      }
    })();

    return missingIds.length;
  }
}
