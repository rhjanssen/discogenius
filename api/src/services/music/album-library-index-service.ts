import { db } from "../../database.js";

/**
 * Compact, Lidarr-style album library read model.
 *
 * Canonical album metadata remains in Albums and slot state remains in
 * ReleaseGroupSlots. This projection only denormalizes the few fields needed
 * to filter, sort and page the library without joining/sorting the full
 * curation and slot graphs on every HTTP request.
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
        WITH slot_state AS MATERIALIZED (
          SELECT
            release_group_id,
            MAX(CASE WHEN monitored = 1 THEN 1 ELSE 0 END) AS monitored,
            MAX(CASE WHEN monitored_lock = 1 THEN 1 ELSE 0 END) AS monitored_lock,
            MAX(CASE WHEN slot = 'stereo' AND selected_provider_id IS NOT NULL THEN 1 ELSE 0 END) AS has_stereo_provider,
            MAX(CASE WHEN slot = 'spatial' AND selected_provider_id IS NOT NULL THEN 1 ELSE 0 END) AS has_spatial_provider
          FROM ReleaseGroupSlots
          WHERE release_group_id IS NOT NULL
          GROUP BY release_group_id
        )
        SELECT
          album.id,
          album.artist_mbid,
          album.title,
          COALESCE(album.popularity, 0),
          album.first_release_date,
          album.updated_at,
          CASE WHEN
            EXISTS (
              SELECT 1
              FROM Artists imported_artist
              WHERE imported_artist.mbid = album.artist_mbid
            )
            AND EXISTS (
              SELECT 1
              FROM ArtistReleaseGroupCuration context
              JOIN Artists source_artist
                ON source_artist.mbid = context.source_artist_mbid
               AND source_artist.monitored = 1
              WHERE context.release_group_id = album.id
                AND context.included = 1
            ) THEN 1 ELSE 0 END,
          COALESCE(slot_state.monitored, 0),
          COALESCE(slot_state.monitored_lock, 0),
          COALESCE(slot_state.has_stereo_provider, 0),
          COALESCE(slot_state.has_spatial_provider, 0),
          CURRENT_TIMESTAMP
        FROM Albums album
        LEFT JOIN slot_state ON slot_state.release_group_id = album.id
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
