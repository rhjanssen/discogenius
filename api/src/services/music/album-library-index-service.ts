import { db } from "../../database.js";

/**
 * Compact, album library read model.
 *
 * Canonical album metadata remains in Albums. LibraryReleaseGroups own
 * monitoring, LibraryReleases own selected editions, and current acquisition
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
          monitored,
          monitored_lock,
          has_stereo_provider,
          has_spatial_provider,
          updated_at
        )
        WITH library_state AS MATERIALIZED (
          SELECT
            library_group.release_group_id,
            1 AS included,
            MAX(CASE WHEN library_group.monitored = 1 THEN 1 ELSE 0 END) AS monitored,
            MAX(CASE WHEN library_group.locked = 1 THEN 1 ELSE 0 END) AS monitored_lock,
            MAX(CASE
              WHEN plan.state = 'current'
               AND variant.quality_class <> 'spatial'
              THEN 1 ELSE 0
            END) AS has_stereo_provider,
            MAX(CASE
              WHEN plan.state = 'current'
               AND variant.quality_class = 'spatial'
              THEN 1 ELSE 0
            END) AS has_spatial_provider
          FROM LibraryReleaseGroups library_group
          LEFT JOIN LibraryReleases library_release
            ON library_release.library_id = library_group.library_id
          LEFT JOIN AlbumReleases release
            ON release.id = library_release.release_id
           AND release.release_group_id = library_group.release_group_id
          LEFT JOIN AcquisitionPlans plan
            ON plan.library_release_id = library_release.id
          LEFT JOIN AcquisitionPlanTracks plan_track
            ON plan_track.plan_id = plan.id
          LEFT JOIN ProviderItemAudioVariants variant
            ON variant.id = plan_track.provider_audio_variant_id
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
          COALESCE(library_state.monitored, 0),
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
