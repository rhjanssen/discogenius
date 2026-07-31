import type Database from "better-sqlite3";
import type { ManualImportSummary } from "./manual-import-service.js";

export interface CanonicalManualImportMapping {
  unmappedFileId: number;
  trackId: number;
}

export interface CanonicalManualImportRequest {
  libraryId: number;
  editionId: number;
  mappings: readonly CanonicalManualImportMapping[];
}

interface CanonicalTrackRow {
  id: number;
  mbid: string;
  recording_id: number;
  recording_mbid: string;
}

interface LibraryRow {
  id: number;
  root_path: string;
}

/**
 * The legacy mover/tagger. `importedFileIds` maps each requested item id to the
 * TrackFiles row it actually created, so this service updates exactly that row.
 * Rediscovering the row by canonical_track_mbid would hit the same canonical
 * track already imported into ANOTHER library.
 */
export type LegacyManualImportResult = ManualImportSummary & {
  /**
   * Required — an importer that reports `imported > 0` must say which rows. The
   * Map form exists only so an importer keyed by numeric unmapped-file id can
   * report without stringifying; it is not permission to omit the result.
   */
  importedFileIds: Record<string, number> | Map<number, number>;
};

export type LegacyManualImporter = (
  items: Array<{ id: number; providerId: string }>,
  options?: { libraryRootPath?: string },
) => Promise<LegacyManualImportResult>;

/**
 * Canonical manual import boundary.
 *
 * The selected Library, Release and Track rows are validated before any
 * filesystem work begins. The legacy file mover/tagger receives exact canonical
 * track MBIDs, then this service attaches schema-41 integer authority to the
 * imported TrackFiles. Unknown-file import is canonical-only: provider
 * provenance belongs exclusively to the provider-download path.
 */
function normalizeForCompare(value: string): string {
  return value.split("\\").join("/").replace(/\/+$/, "").toLowerCase();
}

/** True when `filePath` sits under `rootPath` (both normalized). */
function isUnderLibraryRoot(filePath: string, rootPath: string): boolean {
  const file = normalizeForCompare(String(filePath || ""));
  const root = normalizeForCompare(String(rootPath || ""));
  if (!file || !root) return false;
  return file === root || file.startsWith(`${root}/`);
}

export class CanonicalManualImportService {
  constructor(
    private readonly db: Database.Database,
    private readonly importFiles: LegacyManualImporter,
  ) {}

  async import(request: CanonicalManualImportRequest): Promise<ManualImportSummary> {
    if (!Number.isInteger(request.libraryId) || request.libraryId <= 0) {
      throw new Error("A valid libraryId is required");
    }
    if (!Number.isInteger(request.editionId) || request.editionId <= 0) {
      throw new Error("A valid editionId is required");
    }
    if (request.mappings.length === 0) {
      throw new Error("At least one canonical file mapping is required");
    }

    const library = this.db.prepare(`
      SELECT id, root_path FROM Libraries WHERE id = ? AND enabled = 1
    `).get(request.libraryId) as LibraryRow | undefined;
    if (!library) throw new Error(`Library ${request.libraryId} is unavailable`);

    const release = this.db.prepare(`
      SELECT id, release_group_id FROM AlbumEditions WHERE id = ?
    `).get(request.editionId) as { id: number; release_group_id: number } | undefined;
    if (!release) throw new Error(`Canonical release ${request.editionId} does not exist`);

    const unmappedIds = new Set<number>();
    const trackIds = new Set<number>();
    for (const mapping of request.mappings) {
      if (Object.prototype.hasOwnProperty.call(mapping, "providerItemId")) {
        throw new Error(
          "Canonical manual import does not accept providerItemId; provider provenance is reserved for provider downloads",
        );
      }
      if (!Number.isInteger(mapping.unmappedFileId) || mapping.unmappedFileId <= 0) {
        throw new Error("Every mapping requires a valid unmappedFileId");
      }
      if (!Number.isInteger(mapping.trackId) || mapping.trackId <= 0) {
        throw new Error("Every mapping requires a valid trackId");
      }
      if (unmappedIds.has(mapping.unmappedFileId)) {
        throw new Error(`Unmapped file ${mapping.unmappedFileId} is assigned more than once`);
      }
      if (trackIds.has(mapping.trackId)) {
        throw new Error(`Canonical track ${mapping.trackId} is assigned more than once`);
      }
      unmappedIds.add(mapping.unmappedFileId);
      trackIds.add(mapping.trackId);
    }

    const getUnmapped = this.db.prepare("SELECT id FROM UnmappedFiles WHERE id = ?");
    const getTrack = this.db.prepare(`
      SELECT
        track.id,
        track.mbid,
        track.recording_id,
        recording.mbid AS recording_mbid
      FROM Tracks track
      JOIN Recordings recording ON recording.id = track.recording_id
      WHERE track.id = ?
        AND track.album_edition_id = ?
        AND recording.is_video = 0
    `);
    const trackById = new Map<number, CanonicalTrackRow>();
    for (const mapping of request.mappings) {
      if (!getUnmapped.get(mapping.unmappedFileId)) {
        throw new Error(`Unmapped file ${mapping.unmappedFileId} no longer exists`);
      }
      const track = getTrack.get(mapping.trackId, request.editionId) as CanonicalTrackRow | undefined;
      if (!track) {
        throw new Error(
          `Canonical track ${mapping.trackId} is not an audio track on release ${request.editionId}`,
        );
      }
      trackById.set(mapping.trackId, track);
    }

    const summary = await this.importFiles(
      request.mappings.map((mapping) => ({
        id: mapping.unmappedFileId,
        providerId: trackById.get(mapping.trackId)!.mbid,
      })),
      { libraryRootPath: library.root_path },
    );

    // Exact per-mapping operation identity from the importer, keyed by the
    // unmapped file id it was asked to import.
    const importedFileIdByUnmappedId = new Map<number, number>();
    const reported = summary.importedFileIds;
    if (reported instanceof Map) {
      for (const [unmappedId, fileId] of reported) {
        if (Number.isInteger(fileId)) importedFileIdByUnmappedId.set(Number(unmappedId), Number(fileId));
      }
    } else if (reported && typeof reported === "object") {
      for (const [unmappedId, fileId] of Object.entries(reported)) {
        if (Number.isInteger(fileId)) importedFileIdByUnmappedId.set(Number(unmappedId), Number(fileId));
      }
    }

    // `importFiles` is an injectable seam, so verify the contract here too rather
    // than trust it: the reported entries must agree with the summary's own count
    // and refer only to mappings we actually submitted. A summary that claims an
    // import it cannot identify would otherwise fall through the per-mapping
    // "nothing imported for this mapping" branch below and silently leave the
    // file without canonical authority.
    const submittedUnmappedIds = new Set(request.mappings.map((mapping) => mapping.unmappedFileId));
    for (const unmappedId of importedFileIdByUnmappedId.keys()) {
      if (!submittedUnmappedIds.has(unmappedId)) {
        throw new Error(
          `Legacy importer reported unmapped file ${unmappedId}, which was not part of this import request`,
        );
      }
    }
    if (importedFileIdByUnmappedId.size !== summary.imported) {
      throw new Error(
        `Legacy importer reported ${importedFileIdByUnmappedId.size} imported file id(s) but claims ${summary.imported} imported file(s); refusing to import without exact operation identity`,
      );
    }

    // The importer's reported row is authoritative. Validate it belongs to this
    // operation — it must exist and sit under the target library root — and fail
    // closed otherwise. There is no mbid-based rediscovery fallback: adopting an
    // arbitrary legacy row (including one with a NULL library_id) would silently
    // re-point another library's file.
    const loadReportedFile = this.db.prepare(`
      SELECT id, library_id, file_path FROM TrackFiles WHERE id = ?
    `);
    const updateImportedFile = this.db.prepare(`
      UPDATE TrackFiles
      SET
        library_id = @libraryId,
        album_edition_id = @editionId,
        track_id = @trackId,
        recording_id = @recordingId,
        file_class = 'audio',
        provider_item_id = NULL,
        provider = NULL,
        provider_entity_type = NULL,
        provider_id = NULL,
        source_audio_variant_id = NULL,
        source_quality = COALESCE(source_quality, quality),
        imported_quality = COALESCE(imported_quality, quality),
        verified_at = CURRENT_TIMESTAMP
      WHERE id = @fileId
    `);

    this.db.transaction(() => {
      // Importing establishes a CUSTOM selected release and monitors its group.
      // It deliberately does NOT lock: lock is a separate user intent
      // ("automatic curation may not change this outcome"), and silently
      // entrenching it is the selectRelease bug this cutover is removing. A row
      // that is already locked keeps its lock.
      this.db.prepare(`
        INSERT INTO LibraryAlbums (
          library_id, release_group_id, monitored, selection_mode, locked,
          reason, curation_version, updated_at
        ) VALUES (?, ?, 1, 'manual', 0, 'canonical_manual_import', 1, CURRENT_TIMESTAMP)
        ON CONFLICT(library_id, release_group_id) DO UPDATE SET
          monitored = 1,
          selection_mode = 'manual',
          reason = excluded.reason,
          updated_at = CURRENT_TIMESTAMP
      `).run(request.libraryId, release.release_group_id);
      this.db.prepare(`
        INSERT INTO LibraryEditions (
          library_id, edition_id, selection_mode, locked, reason,
          curation_version, selected_at, updated_at
        ) VALUES (?, ?, 'manual', 0, 'canonical_manual_import', 1,
                  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(library_id, edition_id) DO UPDATE SET
          selection_mode = 'manual',
          reason = excluded.reason,
          selected_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      `).run(request.libraryId, request.editionId);
      for (const mapping of request.mappings) {
        const track = trackById.get(mapping.trackId)!;
        const exactFileId = importedFileIdByUnmappedId.get(mapping.unmappedFileId);
        if (exactFileId == null) {
          // Nothing was imported for this mapping (duplicate/skipped) — the
          // importer's own summary already reports that. Never guess a row.
          continue;
        }
        const reported = loadReportedFile.get(exactFileId) as
          { id: number; library_id: number | null; file_path: string } | undefined;
        if (!reported) {
          throw new Error(
            `Importer reported TrackFiles ${exactFileId} for unmapped file ${mapping.unmappedFileId}, but no such row exists`,
          );
        }
        if (reported.library_id != null && reported.library_id !== request.libraryId) {
          throw new Error(
            `Importer reported TrackFiles ${exactFileId} in library ${reported.library_id}, expected ${request.libraryId}`,
          );
        }
        if (!isUnderLibraryRoot(reported.file_path, library.root_path)) {
          throw new Error(
            `Imported file ${reported.file_path} is outside library root ${library.root_path}`,
          );
        }
        updateImportedFile.run({
          fileId: reported.id,
          libraryId: request.libraryId,
          editionId: request.editionId,
          trackId: track.id,
          recordingId: track.recording_id,
        });
      }
    })();

    return summary;
  }
}
