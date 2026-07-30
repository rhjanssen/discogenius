import type Database from "better-sqlite3";
import type { LibraryCurationResult } from "./library-curation-planner.js";

export type CreditedScope = "primary_only" | "release_credit" | "release_and_track_credit";
export type LibraryScopeType = "primary" | "release_credit" | "track_credit";

export interface LibraryBootstrapPaths {
  stereoRoot: string;
  spatialRoot: string;
}

export interface LibraryReleaseScopeInput {
  editionId: number;
  libraryArtistId: number;
  scopeType: LibraryScopeType;
  reason?: string | null;
}

export class LibraryCurationRepository {
  constructor(private readonly db: Database.Database) {}

  bootstrapDefaultLibraries(paths: LibraryBootstrapPaths): { stereoId: number; spatialId: number } {
    return this.db.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO MetadataProfiles (
          name, release_type_policy, explicit_policy,
          require_provider_availability, redundancy_enabled
        ) VALUES ('Default', '{}', 'allow', 1, 0)
      `).run();
      this.db.prepare(`
        INSERT INTO quality_profiles (
          name, allowed_source_formats, preference_order, cutoff,
          continue_upgrades, fallback_policy, output_format, transcode_policy
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          allowed_source_formats = excluded.allowed_source_formats,
          preference_order = excluded.preference_order,
          cutoff = excluded.cutoff,
          continue_upgrades = excluded.continue_upgrades,
          fallback_policy = excluded.fallback_policy,
          output_format = excluded.output_format,
          transcode_policy = excluded.transcode_policy,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        "High Quality",
        JSON.stringify(["lossless", "hires-lossless"]),
        JSON.stringify(["hires-lossless", "lossless"]),
        "lossless",
        0,
        "best_allowed",
        JSON.stringify({ codec: "flac", bitDepth: 16, sampleRate: 44100 }),
        "downconvert_hires",
      );
      this.db.prepare(`
        INSERT INTO quality_profiles (
          name, allowed_source_formats, preference_order, cutoff,
          continue_upgrades, fallback_policy, output_format, transcode_policy
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          allowed_source_formats = excluded.allowed_source_formats,
          preference_order = excluded.preference_order,
          cutoff = excluded.cutoff,
          continue_upgrades = excluded.continue_upgrades,
          fallback_policy = excluded.fallback_policy,
          output_format = excluded.output_format,
          transcode_policy = excluded.transcode_policy,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        "Spatial",
        JSON.stringify(["spatial"]),
        JSON.stringify(["spatial"]),
        "spatial",
        1,
        "unavailable",
        JSON.stringify({ spatial: true }),
        "preserve",
      );
      const metadataProfileId = (this.db.prepare(`
        SELECT id FROM MetadataProfiles WHERE name = 'Default'
      `).get() as { id: number }).id;
      const qualityProfileRows = this.db.prepare(`
        SELECT id, name FROM quality_profiles WHERE name IN ('High Quality', 'Spatial')
      `).all() as Array<{ id: number; name: string }>;
      const qualityProfileIdByName = new Map(
        qualityProfileRows.map((profile) => [profile.name, profile.id]),
      );
      const highQualityProfileId = qualityProfileIdByName.get("High Quality");
      const spatialQualityProfileId = qualityProfileIdByName.get("Spatial");
      if (highQualityProfileId == null || spatialQualityProfileId == null) {
        throw new Error("Default library quality profiles were not materialized");
      }
      const upsertLibrary = this.db.prepare(`
        INSERT INTO Libraries (name, root_path, metadata_profile_id, quality_profile_id, enabled)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(name) DO UPDATE SET
          root_path = excluded.root_path,
          metadata_profile_id = excluded.metadata_profile_id,
          quality_profile_id = excluded.quality_profile_id,
          enabled = excluded.enabled,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `);
      const stereoId = (upsertLibrary.get(
        "Stereo",
        paths.stereoRoot,
        metadataProfileId,
        highQualityProfileId,
      ) as { id: number }).id;
      const spatialId = (upsertLibrary.get(
        "Spatial",
        paths.spatialRoot,
        metadataProfileId,
        spatialQualityProfileId,
      ) as { id: number }).id;
      return { stereoId, spatialId };
    })();
  }

  upsertLibraryArtist(input: {
    libraryId: number;
    managedArtistId: number;
    monitored: boolean;
    creditedScope: CreditedScope;
  }): number {
    const row = this.db.prepare(`
      INSERT INTO LibraryArtists (
        library_id, managed_artist_id, monitored, credited_scope, updated_at
      ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(library_id, managed_artist_id) DO UPDATE SET
        monitored = excluded.monitored,
        credited_scope = excluded.credited_scope,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `).get(
      input.libraryId,
      input.managedArtistId,
      Number(input.monitored),
      input.creditedScope,
    ) as { id: number };
    return row.id;
  }

  replaceAutomaticCuration(input: {
    libraryId: number;
    result: LibraryCurationResult;
    releaseGroupIdByReleaseId: ReadonlyMap<number, number>;
    scopes: readonly LibraryReleaseScopeInput[];
    curationVersion: number;
  }): void {
    this.db.transaction(() => {
      const selectedReleaseIds = new Set(input.result.selectedReleaseIds);
      const selectedReleaseGroupIds = new Set<number>();
      for (const editionId of selectedReleaseIds) {
        const releaseGroupId = input.releaseGroupIdByReleaseId.get(editionId);
        if (releaseGroupId == null) throw new Error(`Missing release group for release ${editionId}`);
        selectedReleaseGroupIds.add(releaseGroupId);
      }

      // User-locked/manual rows are never flipped or removed by automation.
      this.db.prepare(`
        DELETE FROM LibraryEditionScopes
        WHERE library_edition_id IN (
          SELECT id FROM LibraryEditions
          WHERE library_id = ? AND selection_mode = 'auto' AND locked = 0
        )
      `).run(input.libraryId);
      this.db.prepare(`
        DELETE FROM LibraryEditions
        WHERE library_id = ? AND selection_mode = 'auto' AND locked = 0
      `).run(input.libraryId);
      this.db.prepare(`
        DELETE FROM LibraryAlbums
        WHERE library_id = ? AND selection_mode = 'auto' AND locked = 0
      `).run(input.libraryId);

      const insertGroup = this.db.prepare(`
        INSERT INTO LibraryAlbums (
          library_id, release_group_id, monitored, selection_mode, locked,
          reason, curation_version, updated_at
        ) VALUES (?, ?, 1, 'auto', 0, 'curation', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(library_id, release_group_id) DO UPDATE SET
          monitored = CASE WHEN LibraryAlbums.locked = 1
            THEN LibraryAlbums.monitored ELSE 1 END,
          curation_version = CASE WHEN LibraryAlbums.locked = 1
            THEN LibraryAlbums.curation_version ELSE excluded.curation_version END,
          updated_at = CURRENT_TIMESTAMP
      `);
      for (const releaseGroupId of [...selectedReleaseGroupIds].sort((a, b) => a - b)) {
        insertGroup.run(input.libraryId, releaseGroupId, input.curationVersion);
      }

      const insertRelease = this.db.prepare(`
        INSERT INTO LibraryEditions (
          library_id, edition_id, selection_mode, locked, reason,
          curation_version, selected_at, updated_at
        ) VALUES (?, ?, 'auto', 0, 'curation', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(library_id, edition_id) DO UPDATE SET
          curation_version = CASE WHEN LibraryEditions.locked = 1
            THEN LibraryEditions.curation_version ELSE excluded.curation_version END,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `);
      const libraryReleaseIdByReleaseId = new Map<number, number>();
      for (const editionId of [...selectedReleaseIds].sort((a, b) => a - b)) {
        const row = insertRelease.get(
          input.libraryId,
          editionId,
          input.curationVersion,
        ) as { id: number };
        libraryReleaseIdByReleaseId.set(editionId, row.id);
      }

      const insertScope = this.db.prepare(`
        INSERT OR IGNORE INTO LibraryEditionScopes (
          library_edition_id, library_artist_id, scope_type, reason
        ) VALUES (?, ?, ?, ?)
      `);
      for (const scope of input.scopes) {
        const libraryEditionId = libraryReleaseIdByReleaseId.get(scope.editionId)
          ?? (this.db.prepare(`
            SELECT id FROM LibraryEditions WHERE library_id = ? AND edition_id = ?
          `).get(input.libraryId, scope.editionId) as { id: number } | undefined)?.id;
        if (libraryEditionId == null) continue;
        insertScope.run(
          libraryEditionId,
          scope.libraryArtistId,
          scope.scopeType,
          scope.reason ?? null,
        );
      }
    })();
  }
}
