import { db, withSqliteWriteGate } from "../../database.js";

const ALBUM_INDEX_GROUP_CHUNK = 200;

/**
 * Join LibraryEditions through the album's own editions.
 *
 * `LibraryEditions` is keyed by `(library_id, edition_id)` with no album
 * column. Joining it on `library_id` alone multiplies every library album by
 * every edition in that library (~13k × ~14k here) before GROUP BY can
 * collapse it. Drive from `AlbumEditions.release_group_id` first.
 */
export const ALBUM_LIBRARY_INDEX_JOIN_SQL = `
          LEFT JOIN AlbumEditions release
            ON release.release_group_id = library_group.release_group_id
          LEFT JOIN LibraryEditions library_release
            ON library_release.library_id = library_group.library_id
           AND library_release.edition_id = release.id
`;

/**
 * Compact, album library read model.
 *
 * Canonical album metadata remains in Albums. LibraryAlbums own
 * monitoring, LibraryEditions own selected editions, and current acquisition
 * plans own provider/quality selection. This projection only denormalizes the
 * few fields needed to filter, sort and page the library without walking those
 * normalized graphs on every HTTP request.
 *
 * Rebuild inserts one row per library Album, never the whole catalog. A
 * 353k-row `FROM Albums LEFT JOIN library_state` rebuild held SQLite long
 * enough to fail UpdateLibraryMetadata with `database is locked`. Joining
 * LibraryEditions only on library_id then hung the gated rebuild for minutes
 * on a live library.
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
    // Library album/track pages read LibraryAlbums and LibraryEditions
    // directly. SQLite keeps those table indexes current on write, so a
    // denormalized rebuild is not part of the request path.
    return false;
  }

  static rebuild(): { rows: number } {
    return db.transaction(() => {
      db.prepare("DELETE FROM AlbumLibraryIndex").run();
      const rows = this.insertForGroupIds(this.listIndexedGroupIds());
      this.writeState(rows);
      return { rows };
    })();
  }

  static async rebuildGated(
    yieldToEventLoop?: () => Promise<void>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ rows: number }> {
    await withSqliteWriteGate(() => {
      db.prepare("DELETE FROM AlbumLibraryIndex").run();
    }, "album-library-index-delete");

    const groupIds = this.listIndexedGroupIds();
    let rows = 0;
    for (let start = 0; start < groupIds.length; start += ALBUM_INDEX_GROUP_CHUNK) {
      const chunk = groupIds.slice(start, start + ALBUM_INDEX_GROUP_CHUNK);
      await withSqliteWriteGate(() => {
        rows += this.insertForGroupIds(chunk);
      }, "album-library-index-rebuild");
      onProgress?.(Math.min(groupIds.length, start + chunk.length), groupIds.length);
      if (yieldToEventLoop) {
        await yieldToEventLoop();
      }
    }

    await withSqliteWriteGate(() => {
      this.writeState(rows);
    }, "album-library-index-state");
    return { rows };
  }

  private static listIndexedGroupIds(): number[] {
    return (db.prepare(`
      SELECT DISTINCT library_group.release_group_id AS id
      FROM LibraryAlbums library_group
      JOIN Libraries library
        ON library.id = library_group.library_id
       AND library.enabled = 1
    `).all() as Array<{ id: number }>).map((row) => Number(row.id));
  }

  private static insertForGroupIds(groupIds: number[]): number {
    if (groupIds.length === 0) {
      return 0;
    }
    const marks = groupIds.map(() => "?").join(", ");
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
      WITH library_class AS MATERIALIZED (
        SELECT
          library.id AS library_id,
          CASE WHEN EXISTS (
            SELECT 1
            FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
            WHERE allowed.value = 'spatial'
          ) THEN 1 ELSE 0 END AS is_spatial
        FROM Libraries library
        JOIN quality_profiles quality_profile
          ON quality_profile.id = library.quality_profile_id
        WHERE library.enabled = 1
      ),
      library_state AS MATERIALIZED (
        SELECT
          library_group.release_group_id,
          MAX(CASE WHEN library_group.locked = 1 THEN 1 ELSE 0 END) AS monitored_lock,
          MAX(CASE
            WHEN plan.state = 'current'
             AND release_match.match_state = 'accepted'
             AND library_class.is_spatial = 0
            THEN 1 ELSE 0
          END) AS has_stereo_provider,
          MAX(CASE
            WHEN plan.state = 'current'
             AND release_match.match_state = 'accepted'
             AND library_class.is_spatial = 1
            THEN 1 ELSE 0
          END) AS has_spatial_provider
        FROM LibraryAlbums library_group
        JOIN library_class
          ON library_class.library_id = library_group.library_id
        ${ALBUM_LIBRARY_INDEX_JOIN_SQL}
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
        WHERE library_group.release_group_id IN (${marks})
        GROUP BY library_group.release_group_id
      )
      SELECT
        album.id,
        album.artist_mbid,
        album.title,
        COALESCE(album.popularity, 0),
        album.first_release_date,
        album.updated_at,
        1,
        library_state.monitored_lock,
        library_state.has_stereo_provider,
        library_state.has_spatial_provider,
        CURRENT_TIMESTAMP
      FROM library_state
      JOIN Albums album ON album.id = library_state.release_group_id
    `).run(...groupIds);
    return Number(result.changes || 0);
  }

  private static writeState(rows: number): void {
    db.prepare(`
      INSERT INTO AlbumLibraryProjectionState (singleton_id, row_count, updated_at)
      VALUES (1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(singleton_id) DO UPDATE SET
        row_count = excluded.row_count,
        updated_at = CURRENT_TIMESTAMP
    `).run(rows);
  }
}
