import { db } from "../../database.js";

/**
 * Compact, album library read model.
 *
 * Canonical album metadata remains in Albums. LibraryAlbums own
 * monitoring, LibraryEditions own selected editions, and current acquisition
 * plans own provider/quality selection. This projection only denormalizes the
 * few fields needed to filter, sort and page the library without walking those
 * normalized graphs on every HTTP request.
 */
export class AlbumLibraryIndexService {
  static isReady(): boolean {
    return Boolean(db.prepare(`
      SELECT 1
      FROM AlbumLibraryProjectionState
      WHERE singleton_id = 1
    `).get());
  }

  static needsRebuild(): boolean {
    return !this.isReady();
  }

  static rebuild(): { rows: number } {
    const rebuild = db.transaction(() => {
      db.prepare("DELETE FROM AlbumLibraryIndex").run();

      const result = db.prepare(`
        INSERT INTO AlbumLibraryIndex (
          release_group_id,
          artist_mbid,
          title,
          popularity,
          first_release_date,
          album_updated_at,
          included,
          monitored_lock,
          has_stereo_provider,
          has_spatial_provider,
          updated_at
        )
        WITH library_state AS MATERIALIZED (
          SELECT
            library_group.release_group_id,
            1 AS included,
            MAX(CASE WHEN library_group.locked = 1 THEN 1 ELSE 0 END) AS monitored_lock,
            MAX(CASE
              WHEN plan.state = 'current'
               AND release_match.match_state = 'accepted'
               AND NOT EXISTS (
                 SELECT 1
                 FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
                 WHERE allowed.value = 'spatial'
               )
              THEN 1 ELSE 0
            END) AS has_stereo_provider,
            MAX(CASE
              WHEN plan.state = 'current'
               AND release_match.match_state = 'accepted'
               AND EXISTS (
                 SELECT 1
                 FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
                 WHERE allowed.value = 'spatial'
               )
              THEN 1 ELSE 0
            END) AS has_spatial_provider
          FROM LibraryAlbums library_group
          JOIN Libraries library
            ON library.id = library_group.library_id
           AND library.enabled = 1
          JOIN quality_profiles quality_profile
            ON quality_profile.id = library.quality_profile_id
          LEFT JOIN LibraryEditions library_release
            ON library_release.library_id = library_group.library_id
          LEFT JOIN AlbumEditions release
            ON release.id = library_release.edition_id
           AND release.release_group_id = library_group.release_group_id
          LEFT JOIN SelectedAcquisitionPlans plan
            ON plan.library_edition_id = library_release.id
          LEFT JOIN AcquisitionPlanSources plan_source
            ON plan_source.plan_id = plan.id
           AND plan_source.id = (
             SELECT preferred_source.id
             FROM AcquisitionPlanSources preferred_source
             WHERE preferred_source.plan_id = plan.id
             ORDER BY
               CASE preferred_source.role WHEN 'primary' THEN 0 ELSE 1 END,
               preferred_source.sort_order,
               preferred_source.id
             LIMIT 1
           )
          LEFT JOIN ProviderEditionMatches release_match
            ON release_match.id = plan_source.provider_edition_match_id
          GROUP BY library_group.release_group_id
        )
        SELECT
          album.id,
          album.artist_mbid,
          album.title,
          COALESCE(album.popularity, 0),
          album.first_release_date,
          album.updated_at,
          COALESCE(library_state.included, 0),
          COALESCE(library_state.monitored_lock, 0),
          COALESCE(library_state.has_stereo_provider, 0),
          COALESCE(library_state.has_spatial_provider, 0),
          CURRENT_TIMESTAMP
        FROM Albums album
        LEFT JOIN library_state ON library_state.release_group_id = album.id
      `).run();

      const rows = Number(result.changes || 0);
      db.prepare(`
        INSERT INTO AlbumLibraryProjectionState (singleton_id, row_count, updated_at)
        VALUES (1, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(singleton_id) DO UPDATE SET
          row_count = excluded.row_count,
          updated_at = CURRENT_TIMESTAMP
      `).run(rows);

      return { rows };
    });

    return rebuild();
  }
}
