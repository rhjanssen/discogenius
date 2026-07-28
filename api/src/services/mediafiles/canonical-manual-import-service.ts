import type Database from "better-sqlite3";
import type { ManualImportSummary } from "./manual-import-service.js";

export interface CanonicalManualImportMapping {
  unmappedFileId: number;
  trackId: number;
  providerItemId?: number | null;
}

export interface CanonicalManualImportRequest {
  libraryId: number;
  releaseId: number;
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

interface ProviderProvenanceRow {
  id: number;
  provider: string;
  entity_type: string;
  provider_id: string;
}

export type LegacyManualImporter = (
  items: Array<{ id: number; providerId: string }>,
  options?: { libraryRootPath?: string },
) => Promise<ManualImportSummary>;

/**
 * Canonical manual import boundary.
 *
 * The selected Library, Release and Track rows are validated before any
 * filesystem work begins. The legacy file mover/tagger receives exact canonical
 * track MBIDs, then this service attaches schema-41 integer authority and
 * optional provider provenance to the imported TrackFiles.
 */
export class CanonicalManualImportService {
  constructor(
    private readonly db: Database.Database,
    private readonly importFiles: LegacyManualImporter,
  ) {}

  async import(request: CanonicalManualImportRequest): Promise<ManualImportSummary> {
    if (!Number.isInteger(request.libraryId) || request.libraryId <= 0) {
      throw new Error("A valid libraryId is required");
    }
    if (!Number.isInteger(request.releaseId) || request.releaseId <= 0) {
      throw new Error("A valid releaseId is required");
    }
    if (request.mappings.length === 0) {
      throw new Error("At least one canonical file mapping is required");
    }

    const library = this.db.prepare(`
      SELECT id, root_path FROM Libraries WHERE id = ? AND enabled = 1
    `).get(request.libraryId) as LibraryRow | undefined;
    if (!library) throw new Error(`Library ${request.libraryId} is unavailable`);

    const release = this.db.prepare(`
      SELECT id FROM AlbumReleases WHERE id = ?
    `).get(request.releaseId) as { id: number } | undefined;
    if (!release) throw new Error(`Canonical release ${request.releaseId} does not exist`);

    const unmappedIds = new Set<number>();
    const trackIds = new Set<number>();
    for (const mapping of request.mappings) {
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
        AND track.album_release_id = ?
        AND recording.is_video = 0
    `);
    const getProvenance = this.db.prepare(`
      SELECT id, provider, entity_type, provider_id
      FROM ProviderItems
      WHERE id = ?
    `);

    const trackById = new Map<number, CanonicalTrackRow>();
    const provenanceByTrackId = new Map<number, ProviderProvenanceRow | null>();
    for (const mapping of request.mappings) {
      if (!getUnmapped.get(mapping.unmappedFileId)) {
        throw new Error(`Unmapped file ${mapping.unmappedFileId} no longer exists`);
      }
      const track = getTrack.get(mapping.trackId, request.releaseId) as CanonicalTrackRow | undefined;
      if (!track) {
        throw new Error(
          `Canonical track ${mapping.trackId} is not an audio track on release ${request.releaseId}`,
        );
      }
      trackById.set(mapping.trackId, track);

      if (mapping.providerItemId == null) {
        provenanceByTrackId.set(mapping.trackId, null);
        continue;
      }
      const provenance = getProvenance.get(mapping.providerItemId) as ProviderProvenanceRow | undefined;
      if (!provenance || provenance.entity_type !== "track") {
        throw new Error(`Provider provenance ${mapping.providerItemId} is not a track item`);
      }
      provenanceByTrackId.set(mapping.trackId, provenance);
    }

    const summary = await this.importFiles(
      request.mappings.map((mapping) => ({
        id: mapping.unmappedFileId,
        providerId: trackById.get(mapping.trackId)!.mbid,
      })),
      { libraryRootPath: library.root_path },
    );

    const findImportedFile = this.db.prepare(`
      SELECT id
      FROM TrackFiles
      WHERE canonical_track_mbid = ?
      ORDER BY verified_at DESC, id DESC
      LIMIT 1
    `);
    const updateImportedFile = this.db.prepare(`
      UPDATE TrackFiles
      SET
        library_id = @libraryId,
        album_release_id = @releaseId,
        track_id = @trackId,
        recording_id = @recordingId,
        file_class = 'audio',
        provider = @provider,
        provider_entity_type = CASE WHEN @providerItemId IS NULL THEN NULL ELSE 'track' END,
        provider_id = @providerExternalId,
        source_audio_variant_id = (
          SELECT id
          FROM ProviderItemAudioVariants
          WHERE provider_item_id = @providerItemId
            AND availability NOT IN ('unavailable', 'restricted')
          ORDER BY verified_at DESC, id DESC
          LIMIT 1
        ),
        source_quality = COALESCE(source_quality, quality),
        imported_quality = COALESCE(imported_quality, quality),
        verified_at = CURRENT_TIMESTAMP
      WHERE id = @fileId
    `);

    this.db.transaction(() => {
      for (const mapping of request.mappings) {
        const track = trackById.get(mapping.trackId)!;
        const imported = findImportedFile.get(track.mbid) as { id: number } | undefined;
        if (!imported) continue;
        const provenance = provenanceByTrackId.get(mapping.trackId) ?? null;
        updateImportedFile.run({
          fileId: imported.id,
          libraryId: request.libraryId,
          releaseId: request.releaseId,
          trackId: track.id,
          recordingId: track.recording_id,
          provider: provenance?.provider ?? null,
          providerItemId: provenance?.id ?? null,
          providerExternalId: provenance?.provider_id ?? null,
        });
      }
    })();

    return summary;
  }
}
