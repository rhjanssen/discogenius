import type Database from "better-sqlite3";
import type { LibraryCurationResult } from "./library-curation-planner.js";
import {
  applyLibrarySettingsFromConfig,
  ensureDefaultQualityProfiles,
  stereoQualityProfileName,
  type StereoAudioQuality,
} from "./library-settings-sync.js";

export type CreditedScope = "primary_only" | "release_credit" | "release_and_track_credit";
export type LibraryScopeType = "primary" | "release_credit" | "track_credit";

export interface LibraryBootstrapPaths {
  stereoRoot: string;
  spatialRoot: string;
  videoRoot: string;
}

export interface LibraryBootstrapSettings {
  /** Settings → Audio quality. Defaults to max (product default). */
  audioQuality?: StereoAudioQuality;
  /** Settings → Spatial audio toggle. Defaults to false (product default). */
  includeSpatial?: boolean;
}

export interface LibraryReleaseScopeInput {
  editionId: number;
  libraryArtistId: number;
  scopeType: LibraryScopeType;
  reason?: string | null;
}

export class LibraryCurationRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Materialize the fixed Stereo / Spatial / Video libraries.
   *
   * Quality preference for Stereo and the Spatial enabled flag come from
   * Settings (`audioQuality` / `includeSpatial`), not hard-coded High Quality.
   * Path/metadata updates on restart never stomp those Settings-derived fields
   * — `applyLibrarySettingsFromConfig` is the only writer for them.
   */
  bootstrapDefaultLibraries(
    paths: LibraryBootstrapPaths,
    settings: LibraryBootstrapSettings = {},
  ): {
    stereoId: number;
    spatialId: number;
    videoId: number;
  } {
    const audioQuality = settings.audioQuality ?? "max";
    const includeSpatial = settings.includeSpatial === true;

    return this.db.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO MetadataProfiles (
          name, release_type_policy, explicit_policy,
          require_provider_availability, redundancy_enabled
        ) VALUES ('Default', '{}', 'allow', 1, 0)
      `).run();

      ensureDefaultQualityProfiles(this.db);

      const metadataProfileId = (this.db.prepare(`
        SELECT id FROM MetadataProfiles WHERE name = 'Default'
      `).get() as { id: number }).id;
      const qualityProfileRows = this.db.prepare(`
        SELECT id, name FROM quality_profiles
        WHERE name IN ('Max Quality', 'High Quality', 'Normal Quality', 'Low Quality', 'Spatial', 'Video')
      `).all() as Array<{ id: number; name: string }>;
      const qualityProfileIdByName = new Map(
        qualityProfileRows.map((profile) => [profile.name, profile.id]),
      );
      const stereoProfileName = stereoQualityProfileName(audioQuality);
      const stereoProfileId = qualityProfileIdByName.get(stereoProfileName)
        ?? qualityProfileIdByName.get("Max Quality");
      const spatialQualityProfileId = qualityProfileIdByName.get("Spatial");
      const videoQualityProfileId = qualityProfileIdByName.get("Video");
      if (
        stereoProfileId == null
        || spatialQualityProfileId == null
        || videoQualityProfileId == null
      ) {
        throw new Error("Default library quality profiles were not materialized");
      }

      // Paths/metadata refresh on every boot; quality_profile_id and enabled are
      // owned by Settings sync so a restart never rewrites Max→High.
      const upsertLibrary = this.db.prepare(`
        INSERT INTO Libraries (name, root_path, metadata_profile_id, quality_profile_id, enabled)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          root_path = excluded.root_path,
          metadata_profile_id = excluded.metadata_profile_id,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `);
      const stereoId = (upsertLibrary.get(
        "Stereo",
        paths.stereoRoot,
        metadataProfileId,
        stereoProfileId,
        1,
      ) as { id: number }).id;
      const spatialId = (upsertLibrary.get(
        "Spatial",
        paths.spatialRoot,
        metadataProfileId,
        spatialQualityProfileId,
        includeSpatial ? 1 : 0,
      ) as { id: number }).id;
      const videoId = (upsertLibrary.get(
        "Video",
        paths.videoRoot,
        metadataProfileId,
        videoQualityProfileId,
        1,
      ) as { id: number }).id;

      applyLibrarySettingsFromConfig(this.db, { audioQuality, includeSpatial });

      return { stereoId, spatialId, videoId };
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
    /**
     * Albums whose manual edition choice curation overruled, and why.
     *
     * Overruling is rare and always for one reason — the declined edition
     * carried canonical recordings the rest of the discography could not
     * supply — so the reason is written onto the rows curation replaces rather
     * than only logged. Their manual protection is withdrawn for this pass;
     * every other album's manual choice is untouched.
     */
    reasonByReleaseGroupId?: ReadonlyMap<number, string>;
  }): void {
    this.db.transaction(() => {
      const overruledReleaseGroupIds = [...(input.reasonByReleaseGroupId?.keys() ?? [])];
      const overruledPlaceholders = overruledReleaseGroupIds.map(() => "?").join(",");
      const selectedReleaseIds = new Set(input.result.selectedReleaseIds);
      const selectedReleaseGroupIds = new Set<number>();
      for (const editionId of selectedReleaseIds) {
        const releaseGroupId = input.releaseGroupIdByReleaseId.get(editionId);
        if (releaseGroupId == null) throw new Error(`Missing release group for release ${editionId}`);
        selectedReleaseGroupIds.add(releaseGroupId);
      }

      // Automation may only reconsider rows it created itself. A manual choice
      // is the user's, and a locked Album holds every Edition under it — the
      // lock lives on LibraryAlbums, which is the one authority on the subject.
      const overruledScope = overruledReleaseGroupIds.length === 0
        ? ""
        : `OR edition.release_group_id IN (${overruledPlaceholders})`;
      const automaticEditions = `
        SELECT monitored_edition.id
        FROM LibraryEditions monitored_edition
        JOIN AlbumEditions edition ON edition.id = monitored_edition.edition_id
        LEFT JOIN LibraryAlbums library_album
          ON library_album.library_id = monitored_edition.library_id
         AND library_album.release_group_id = edition.release_group_id
        WHERE monitored_edition.library_id = ?
          AND COALESCE(library_album.locked, 0) = 0
          AND (monitored_edition.selection_mode = 'auto' ${overruledScope})
      `;
      const automaticEditionParams = [input.libraryId, ...overruledReleaseGroupIds];
      this.db.prepare(`
        DELETE FROM LibraryEditionScopes
        WHERE library_edition_id IN (${automaticEditions})
      `).run(...automaticEditionParams);
      // Release the deferred plan reference before the rows go, and note that
      // the plans themselves survive: an Edition that stops being monitored
      // keeps its candidate offers so it can still be offered as an alternative.
      this.db.prepare(`
        UPDATE LibraryEditions
        SET preferred_plan_key = NULL
        WHERE id IN (${automaticEditions})
      `).run(...automaticEditionParams);
      this.db.prepare(`
        DELETE FROM LibraryEditions WHERE id IN (${automaticEditions})
      `).run(...automaticEditionParams);
      this.db.prepare(`
        DELETE FROM LibraryAlbums
        WHERE library_id = ? AND locked = 0
          AND (selection_mode = 'auto'
               ${overruledReleaseGroupIds.length === 0
                 ? ""
                 : `OR release_group_id IN (${overruledPlaceholders})`})
      `).run(input.libraryId, ...overruledReleaseGroupIds);

      const insertGroup = this.db.prepare(`
        INSERT INTO LibraryAlbums (
          library_id, release_group_id, selection_mode, locked,
          reason, curation_version, updated_at
        ) VALUES (?, ?, 'auto', 0, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(library_id, release_group_id) DO UPDATE SET
          reason = CASE WHEN LibraryAlbums.locked = 1
            THEN LibraryAlbums.reason ELSE excluded.reason END,
          curation_version = CASE WHEN LibraryAlbums.locked = 1
            THEN LibraryAlbums.curation_version ELSE excluded.curation_version END,
          updated_at = CURRENT_TIMESTAMP
      `);
      for (const releaseGroupId of [...selectedReleaseGroupIds].sort((a, b) => a - b)) {
        insertGroup.run(
          input.libraryId,
          releaseGroupId,
          input.reasonByReleaseGroupId?.get(releaseGroupId) ?? "curation",
          input.curationVersion,
        );
      }

      const insertRelease = this.db.prepare(`
        INSERT INTO LibraryEditions (
          library_id, edition_id, selection_mode, representative, reason,
          curation_version, selected_at, updated_at
        ) VALUES (?, ?, 'auto', 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(library_id, edition_id) DO UPDATE SET
          curation_version = excluded.curation_version,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `);
      const libraryReleaseIdByReleaseId = new Map<number, number>();
      for (const editionId of [...selectedReleaseIds].sort((a, b) => a - b)) {
        const row = insertRelease.get(
          input.libraryId,
          editionId,
          input.reasonByReleaseGroupId?.get(
            input.releaseGroupIdByReleaseId.get(editionId) ?? -1,
          ) ?? "curation",
          input.curationVersion,
        ) as { id: number };
        libraryReleaseIdByReleaseId.set(editionId, row.id);
      }

      // Exactly one Primary Edition per monitored Album. Curation only fills the
      // role when it is vacant — deleting a redundant Edition can leave an Album
      // with none, but a representative the user chose is never demoted here.
      this.db.prepare(`
        UPDATE LibraryEditions
        SET representative = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id IN (
          SELECT best.id FROM (
            SELECT
              monitored_edition.id,
              ROW_NUMBER() OVER (
                PARTITION BY edition.release_group_id
                ORDER BY edition.track_count DESC,
                         COALESCE(edition.date, '9999-99-99'), edition.id
              ) AS position
            FROM LibraryEditions monitored_edition
            JOIN AlbumEditions edition ON edition.id = monitored_edition.edition_id
            WHERE monitored_edition.library_id = ?
              AND NOT EXISTS (
                SELECT 1
                FROM LibraryEditions peer
                JOIN AlbumEditions peer_edition ON peer_edition.id = peer.edition_id
                WHERE peer.library_id = monitored_edition.library_id
                  AND peer_edition.release_group_id = edition.release_group_id
                  AND peer.representative = 1
              )
          ) best
          WHERE best.position = 1
        )
      `).run(input.libraryId);

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
