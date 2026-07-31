import type Database from "better-sqlite3";
import type { ManualImportSummary } from "./manual-import-service.js";
import type {
  LegacyManualImporter,
  LegacyManualImportResult,
} from "./canonical-manual-import-service.js";

export interface CanonicalManualVideoImportRequest {
  libraryId: number;
  mappings: ReadonlyArray<{
    unmappedFileId: number;
    recordingId: number;
  }>;
}

function normalizePath(value: string): string {
  return String(value || "").split("\\").join("/").replace(/\/+$/, "").toLowerCase();
}

function isUnderRoot(filePath: string, rootPath: string): boolean {
  const file = normalizePath(filePath);
  const root = normalizePath(rootPath);
  return Boolean(file && root && (file === root || file.startsWith(`${root}/`)));
}

function reportedFileIds(summary: LegacyManualImportResult): Map<number, number> {
  const output = new Map<number, number>();
  if (summary.importedFileIds instanceof Map) {
    for (const [unmappedId, fileId] of summary.importedFileIds) {
      if (Number.isInteger(fileId)) output.set(Number(unmappedId), Number(fileId));
    }
  } else {
    for (const [unmappedId, fileId] of Object.entries(summary.importedFileIds || {})) {
      if (Number.isInteger(fileId)) output.set(Number(unmappedId), Number(fileId));
    }
  }
  return output;
}

/**
 * Canonical-only video import. A local video is attached directly to a
 * MusicBrainz Recording; no Provider Video is created or required.
 */
export class CanonicalManualVideoImportService {
  constructor(
    private readonly db: Database.Database,
    private readonly importFiles: LegacyManualImporter,
  ) {}

  async import(request: CanonicalManualVideoImportRequest): Promise<ManualImportSummary> {
    if (!Number.isInteger(request.libraryId) || request.libraryId <= 0) {
      throw new Error("A valid libraryId is required");
    }
    if (!Array.isArray(request.mappings) || request.mappings.length === 0) {
      throw new Error("At least one canonical video mapping is required");
    }
    const library = this.db.prepare(`
      SELECT id, root_path FROM Libraries WHERE id = ? AND enabled = 1
    `).get(request.libraryId) as { id: number; root_path: string } | undefined;
    if (!library) throw new Error(`Library ${request.libraryId} is unavailable`);

    const unmappedIds = new Set<number>();
    const recordings = new Map<number, {
      id: number;
      mbid: string;
      artist_mbid: string | null;
    }>();
    const getUnmapped = this.db.prepare("SELECT id FROM UnmappedFiles WHERE id = ?");
    const getRecording = this.db.prepare(`
      SELECT
        recording.id,
        recording.mbid,
        COALESCE(artist.mbid, recording.artist_mbid) AS artist_mbid
      FROM Recordings recording
      LEFT JOIN ArtistMetadata artist ON artist.id = recording.artist_metadata_id
      WHERE recording.id = ? AND recording.is_video = 1
    `);

    for (const mapping of request.mappings) {
      if (
        !Number.isInteger(mapping.unmappedFileId)
        || mapping.unmappedFileId <= 0
        || !Number.isInteger(mapping.recordingId)
        || mapping.recordingId <= 0
      ) {
        throw new Error("Every video mapping requires valid unmappedFileId and recordingId values");
      }
      if (unmappedIds.has(mapping.unmappedFileId)) {
        throw new Error(`Unmapped file ${mapping.unmappedFileId} is assigned more than once`);
      }
      if (!getUnmapped.get(mapping.unmappedFileId)) {
        throw new Error(`Unmapped file ${mapping.unmappedFileId} no longer exists`);
      }
      const recording = getRecording.get(mapping.recordingId) as {
        id: number;
        mbid: string;
        artist_mbid: string | null;
      } | undefined;
      if (!recording) {
        throw new Error(`Canonical Recording ${mapping.recordingId} is not a video`);
      }
      unmappedIds.add(mapping.unmappedFileId);
      recordings.set(mapping.recordingId, recording);
    }

    const summary = await this.importFiles(
      request.mappings.map((mapping) => ({
        id: mapping.unmappedFileId,
        providerId: recordings.get(mapping.recordingId)!.mbid,
      })),
      { libraryRootPath: library.root_path },
    );
    const fileIds = reportedFileIds(summary as LegacyManualImportResult);
    const submitted = new Set(request.mappings.map((mapping) => mapping.unmappedFileId));
    if (
      fileIds.size !== summary.imported
      || [...fileIds.keys()].some((unmappedId) => !submitted.has(unmappedId))
    ) {
      throw new Error(
        `Importer reported ${fileIds.size} exact file id(s) but claims ${summary.imported} imported file(s)`,
      );
    }

    const loadFile = this.db.prepare(`
      SELECT id, library_id, file_path FROM TrackFiles WHERE id = ?
    `);
    const updateFile = this.db.prepare(`
      UPDATE TrackFiles
      SET
        library_id = @libraryId,
        recording_id = @recordingId,
        canonical_recording_mbid = @recordingMbid,
        canonical_artist_mbid = @artistMbid,
        canonical_track_mbid = NULL,
        canonical_release_mbid = NULL,
        canonical_release_group_mbid = NULL,
        track_id = NULL,
        album_edition_id = NULL,
        release_group_id = NULL,
        file_class = 'video',
        file_type = 'video',
        provider_item_id = NULL,
        provider = NULL,
        provider_entity_type = NULL,
        provider_id = NULL,
        source_audio_variant_id = NULL,
        source_quality = NULL,
        imported_quality = COALESCE(imported_quality, quality),
        verified_at = CURRENT_TIMESTAMP
      WHERE id = @fileId
    `);

    this.db.transaction(() => {
      for (const mapping of request.mappings) {
        const fileId = fileIds.get(mapping.unmappedFileId);
        if (fileId == null) continue;
        const file = loadFile.get(fileId) as {
          id: number;
          library_id: number | null;
          file_path: string;
        } | undefined;
        if (!file) {
          throw new Error(`Importer reported missing TrackFiles ${fileId}`);
        }
        if (file.library_id != null && file.library_id !== request.libraryId) {
          throw new Error(
            `Importer reported TrackFiles ${fileId} in library ${file.library_id}, expected ${request.libraryId}`,
          );
        }
        if (!isUnderRoot(file.file_path, library.root_path)) {
          throw new Error(`Imported file ${file.file_path} is outside library root ${library.root_path}`);
        }
        const recording = recordings.get(mapping.recordingId)!;
        updateFile.run({
          fileId,
          libraryId: request.libraryId,
          recordingId: recording.id,
          recordingMbid: recording.mbid,
          artistMbid: recording.artist_mbid,
        });
        this.db.prepare(`
          UPDATE Recordings
          SET monitored = 1,
              monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(recording.id);
      }
    })();

    return summary;
  }
}
