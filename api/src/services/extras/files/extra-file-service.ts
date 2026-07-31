import fs from "fs";
import path from "path";
import { db } from "../../../database.js";

export const METADATA_EXTRA_FILE_TYPES = new Set(["cover", "video_cover", "video_thumbnail", "nfo"]);
export const LYRIC_EXTRA_FILE_TYPES = new Set(["lyrics"]);
export const EXTRA_FILE_TYPES = new Set([...METADATA_EXTRA_FILE_TYPES, ...LYRIC_EXTRA_FILE_TYPES]);

export type ExtraFileUpsertInput = {
  artistId: string;
  libraryId?: number | null;
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

export type ExtraFileTableName = "MetadataFiles" | "LyricFiles" | "ExtraFiles";

const EXTRA_LIBRARY_ASSOCIATIONS: Record<ExtraFileTableName, {
  table: "MetadataFileLibraries" | "LyricFileLibraries" | "ExtraFileLibraries";
  fileIdColumn: "metadata_file_id" | "lyric_file_id" | "extra_file_id";
}> = {
  MetadataFiles: {
    table: "MetadataFileLibraries",
    fileIdColumn: "metadata_file_id",
  },
  LyricFiles: {
    table: "LyricFileLibraries",
    fileIdColumn: "lyric_file_id",
  },
  ExtraFiles: {
    table: "ExtraFileLibraries",
    fileIdColumn: "extra_file_id",
  },
};

export type ExtraFileBaseRecord = {
  artist_id: string;
  track_file_id: number | null;
  relative_path: string;
  file_path: string;
  library_root: string;
  extension: string;
  provider: string | null;
  provider_entity_type: string | null;
  provider_id: string | null;
  library_slot: string;
  canonical_artist_mbid: string | null;
  canonical_release_group_mbid: string | null;
  canonical_release_mbid: string | null;
  canonical_track_mbid: string | null;
  canonical_recording_mbid: string | null;
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
      const row = db.prepare(`
        SELECT id
        FROM TrackFiles
        WHERE id = ?
          AND (? IS NULL OR library_id = ?)
      `).get(
        Number(input.trackFileId),
        input.libraryId ?? null,
        input.libraryId ?? null,
      ) as { id?: number } | undefined;
      return row?.id ?? null;
    }

    const provider = nullableText(input.provider);
    const providerEntityType = nullableText(input.providerEntityType);
    const providerId = nullableText(input.providerId) ?? nullableText(input.mediaId);
    const canonicalTrackMbid = nullableText(input.canonicalTrackMbid);
    const canonicalRecordingMbid = nullableText(input.canonicalRecordingMbid);

    const predicates: string[] = ["file_type IN ('track', 'video')"];
    const values: unknown[] = [];
    if (provider && providerId) {
      predicates.push("provider = ?", "CAST(provider_id AS TEXT) = CAST(? AS TEXT)");
      values.push(provider, providerId);
      if (providerEntityType) {
        predicates.push("provider_entity_type = ?");
        values.push(providerEntityType);
      }
    }
    if (canonicalTrackMbid) {
      predicates.push("canonical_track_mbid = ?");
      values.push(canonicalTrackMbid);
    }
    if (canonicalRecordingMbid) {
      predicates.push("canonical_recording_mbid = ?");
      values.push(canonicalRecordingMbid);
    }
    if (input.libraryId != null) {
      predicates.push("library_id = ?");
      values.push(Number(input.libraryId));
    }

    if (predicates.length === 1) {
      return null;
    }

    const rows = db.prepare(`
      SELECT id
      FROM TrackFiles
      WHERE ${predicates.join(" AND ")}
      ORDER BY id
      LIMIT 2
    `).all(...values) as Array<{ id: number }>;

    return rows.length === 1 ? rows[0].id : null;
  }

  /**
   * Which Libraries own an extra, resolved by evidence rather than by root.
   *
   * Several Libraries may share one filesystem root, so root equality proves
   * only that a Library *could* own the file — it is not proof that it does.
   * Associating every root-matching Library made a track-specific lyric or a
   * spatial-only NFO appear to belong to Libraries that have nothing in that
   * folder, and shared-extra deletion then had no way to tell those apart.
   *
   * Order of authority:
   *   explicit library_id
   *     → the exact TrackFile's Library
   *     → Libraries that curated this canonical Album or Edition
   *     → Libraries with playable files in the same folder
   *     → every root-sharing Library, but only for album/folder-level extras
   *     → fail closed
   *
   * A single root-matching Library is unambiguous and needs no further
   * evidence; it is the ordinary single-Library installation.
   *
   * The last-resort broad association is deliberately unavailable to
   * track-scoped extras. A cover or NFO written before any audio lands in the
   * folder genuinely belongs to every Library sharing that album folder, and
   * per-Library release on deletion keeps that honest. A lyric or thumbnail
   * that names one canonical Track or Recording does not: guessing there is
   * what let one Library's deletion reach another Library's sidecar.
   */
  static resolveOwningLibraryIds(input: ExtraFileUpsertInput): number[] {
    if (input.libraryId != null) {
      const library = db.prepare(`
        SELECT id FROM Libraries WHERE id = ?
      `).get(Number(input.libraryId)) as { id?: number } | undefined;
      if (!library?.id) {
        throw new Error(`Library ${input.libraryId} is unavailable for ${input.filePath}`);
      }
      return [library.id];
    }

    const trackFileId = this.resolveTrackFileId(input);
    if (trackFileId != null) {
      const trackFile = db.prepare(`
        SELECT library_id FROM TrackFiles WHERE id = ?
      `).get(trackFileId) as { library_id?: number | null } | undefined;
      if (trackFile?.library_id != null) {
        return [Number(trackFile.library_id)];
      }
    }

    const normalizedRoot = path.resolve(input.libraryRoot);
    const rootLibraryIds = (db.prepare(`
      SELECT id, root_path FROM Libraries WHERE enabled = 1 ORDER BY id
    `).all() as Array<{ id: number; root_path: string }>)
      .filter((library) => path.resolve(library.root_path) === normalizedRoot)
      .map((library) => library.id);

    if (rootLibraryIds.length <= 1) {
      return rootLibraryIds;
    }

    const placeholders = rootLibraryIds.map(() => "?").join(",");
    const releaseGroupMbid = nullableText(input.canonicalReleaseGroupMbid);
    const editionMbid = nullableText(input.canonicalReleaseMbid);

    if (releaseGroupMbid || editionMbid) {
      const curated = (db.prepare(`
        SELECT DISTINCT library_id FROM (
          SELECT library_album.library_id AS library_id
          FROM LibraryAlbums library_album
          JOIN Albums album ON album.id = library_album.release_group_id
          WHERE ? IS NOT NULL AND album.mbid = ?
          UNION
          SELECT library_edition.library_id AS library_id
          FROM LibraryEditions library_edition
          JOIN AlbumEditions edition ON edition.id = library_edition.edition_id
          WHERE ? IS NOT NULL AND edition.mbid = ?
        )
        WHERE library_id IN (${placeholders})
        ORDER BY library_id
      `).all(
        releaseGroupMbid,
        releaseGroupMbid,
        editionMbid,
        editionMbid,
        ...rootLibraryIds,
      ) as Array<{ library_id: number }>).map((row) => row.library_id);
      if (curated.length > 0) {
        return curated;
      }
    }

    const folder = path.dirname(path.resolve(input.filePath));
    const owners = (db.prepare(`
      SELECT DISTINCT library_id, file_path
      FROM TrackFiles
      WHERE library_id IN (${placeholders})
        AND file_type IN ('track', 'video')
    `).all(...rootLibraryIds) as Array<{ library_id: number; file_path: string }>)
      .filter((row) => path.dirname(path.resolve(row.file_path)) === folder)
      .map((row) => row.library_id);

    const folderOwners = [...new Set(owners)].sort((left, right) => left - right);
    if (folderOwners.length > 0) {
      return folderOwners;
    }

    const isTrackScoped = input.trackFileId != null
      || nullableText(input.canonicalTrackMbid) != null
      || nullableText(input.canonicalRecordingMbid) != null
      || isLyricExtraFileType(input.fileType);
    return isTrackScoped ? [] : rootLibraryIds;
  }

  static associateLibraries(
    tableName: ExtraFileTableName,
    fileId: number,
    input: ExtraFileUpsertInput,
  ): number[] {
    const association = EXTRA_LIBRARY_ASSOCIATIONS[tableName];
    const libraryIds = new Set<number>(this.resolveOwningLibraryIds(input));

    if (libraryIds.size === 0) {
      throw new Error(`No library owns sidecar ${input.filePath}`);
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO ${association.table} (${association.fileIdColumn}, library_id)
      VALUES (?, ?)
    `);
    for (const libraryId of libraryIds) {
      insert.run(fileId, libraryId);
    }
    return [...libraryIds];
  }

  static libraryIds(tableName: ExtraFileTableName, fileId: number): number[] {
    const association = EXTRA_LIBRARY_ASSOCIATIONS[tableName];
    return (db.prepare(`
      SELECT library_id
      FROM ${association.table}
      WHERE ${association.fileIdColumn} = ?
      ORDER BY library_id
    `).all(fileId) as Array<{ library_id: number }>).map((row) => row.library_id);
  }

  static releaseLibrary(
    tableName: ExtraFileTableName,
    fileId: number,
    libraryId: number,
  ): { remainingLibraryIds: number[]; mayDeletePhysicalFile: boolean } {
    const association = EXTRA_LIBRARY_ASSOCIATIONS[tableName];
    db.prepare(`
      DELETE FROM ${association.table}
      WHERE ${association.fileIdColumn} = ?
        AND library_id = ?
    `).run(fileId, libraryId);
    const remainingLibraryIds = this.libraryIds(tableName, fileId);
    return {
      remainingLibraryIds,
      mayDeletePhysicalFile: remainingLibraryIds.length === 0,
    };
  }

  static mergeLibraryAssociations(
    tableName: ExtraFileTableName,
    fromFileId: number,
    intoFileId: number,
  ): void {
    if (fromFileId === intoFileId) return;
    const association = EXTRA_LIBRARY_ASSOCIATIONS[tableName];
    db.prepare(`
      INSERT OR IGNORE INTO ${association.table} (${association.fileIdColumn}, library_id)
      SELECT ?, library_id
      FROM ${association.table}
      WHERE ${association.fileIdColumn} = ?
    `).run(intoFileId, fromFileId);
  }

  static buildBaseRecord(input: ExtraFileUpsertInput): ExtraFileBaseRecord {
    const relativePath = path.relative(input.libraryRoot, input.filePath);
    const extension = path.extname(input.filePath).replace(".", "");
    const expectedPath = input.expectedPath || input.filePath;

    return {
      artist_id: input.artistId,
      track_file_id: this.resolveTrackFileId(input),
      relative_path: relativePath || path.basename(input.filePath),
      file_path: input.filePath,
      library_root: input.libraryRoot,
      extension: extension,
      provider: nullableText(input.provider),
      provider_entity_type: nullableText(input.providerEntityType),
      provider_id: nullableText(input.providerId),
      library_slot: nullableText(input.librarySlot) || "stereo",
      canonical_artist_mbid: nullableText(input.canonicalArtistMbid),
      canonical_release_group_mbid: nullableText(input.canonicalReleaseGroupMbid),
      canonical_release_mbid: nullableText(input.canonicalReleaseMbid),
      canonical_track_mbid: nullableText(input.canonicalTrackMbid),
      canonical_recording_mbid: nullableText(input.canonicalRecordingMbid),
      expected_path: expectedPath,
      needs_rename: expectedPath && expectedPath !== input.filePath ? 1 : 0,
    };
  }

  static upsert(input: ExtraFileUpsertInput): number {
    const base = this.buildBaseRecord(input);
    const row = db.prepare(`
      INSERT INTO ExtraFiles (
        artist_id, track_file_id,
        relative_path, file_path, library_root, extension,
        file_type, provider, provider_entity_type, provider_id,
        library_slot,
        canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
        canonical_track_mbid, canonical_recording_mbid,
        expected_path, needs_rename, last_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(file_path) DO UPDATE SET
        artist_id = excluded.artist_id,
        track_file_id = excluded.track_file_id,
        relative_path = excluded.relative_path,
        library_root = excluded.library_root,
        extension = excluded.extension,
        file_type = excluded.file_type,
        provider = excluded.provider,
        provider_entity_type = excluded.provider_entity_type,
        provider_id = excluded.provider_id,
        library_slot = excluded.library_slot,
        canonical_artist_mbid = COALESCE(excluded.canonical_artist_mbid, ExtraFiles.canonical_artist_mbid),
        canonical_release_group_mbid = COALESCE(excluded.canonical_release_group_mbid, ExtraFiles.canonical_release_group_mbid),
        canonical_release_mbid = COALESCE(excluded.canonical_release_mbid, ExtraFiles.canonical_release_mbid),
        canonical_track_mbid = COALESCE(excluded.canonical_track_mbid, ExtraFiles.canonical_track_mbid),
        canonical_recording_mbid = COALESCE(excluded.canonical_recording_mbid, ExtraFiles.canonical_recording_mbid),
        expected_path = excluded.expected_path,
        needs_rename = excluded.needs_rename,
        last_updated = CURRENT_TIMESTAMP
      RETURNING id
    `).get(
      base.artist_id,
      base.track_file_id,
      base.relative_path,
      base.file_path,
      base.library_root,
      base.extension,
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
    ) as { id: number };

    this.associateLibraries("ExtraFiles", row.id, {
      ...input,
      trackFileId: base.track_file_id,
    });
    return row.id;
  }

  static findIdByPath(tableName: ExtraFileTableName, filePath: string): number | null {
    const row = db.prepare(`SELECT id FROM ${tableName} WHERE file_path = ? LIMIT 1`).get(filePath) as { id?: number } | undefined;
    return row?.id ?? null;
  }

  static deleteMissingRows(tableName: ExtraFileTableName, artistId?: string): number {
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
