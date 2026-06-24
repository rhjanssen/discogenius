import { db } from "../../database.js";

export interface ArtistStatisticsRow {
  artist_id: string;
  artist_mbid: string | null;
  album_count: number;
  monitored_album_count: number;
  track_count: number;
  monitored_track_count: number;
  track_file_count: number;
  size_on_disk: number;
  updated_at: string | null;
}

function normalizeArtistIds(artistIds?: Array<string | number | null | undefined>): string[] {
  return Array.from(new Set((artistIds ?? [])
    .map((artistId) => String(artistId ?? "").trim())
    .filter(Boolean)));
}

function buildArtistFilterClause(artistIds: string[], alias = "a") {
  if (artistIds.length === 0) {
    return { sql: "", params: [] as string[] };
  }

  return {
    sql: ` AND CAST(${alias}.id AS TEXT) IN (${artistIds.map(() => "?").join(",")})`,
    params: artistIds,
  };
}

function calculateArtistStatistics(artistIds?: string[]): ArtistStatisticsRow[] {
  const normalizedArtistIds = normalizeArtistIds(artistIds);
  const artistFilter = buildArtistFilterClause(normalizedArtistIds, "a");

  return db.prepare(`
    WITH selected_artists AS (
      SELECT CAST(a.id AS TEXT) AS artist_id,
             NULLIF(TRIM(CAST(a.mbid AS TEXT)), '') AS artist_mbid,
             metadata.id AS artist_metadata_id
      FROM Artists a
      LEFT JOIN ArtistMetadata metadata ON metadata.mbid = a.mbid
      WHERE 1 = 1
      ${artistFilter.sql}
    ),
    artist_scope AS (
      SELECT selected.artist_id,
             selected.artist_mbid,
             selected.artist_metadata_id,
             album.id AS release_group_id,
             album.mbid AS release_group_mbid
      FROM selected_artists selected
      JOIN Albums album
        ON album.artist_metadata_id = selected.artist_metadata_id
        OR (album.artist_metadata_id IS NULL AND album.artist_mbid = selected.artist_mbid)

      UNION

      SELECT selected.artist_id,
             selected.artist_mbid,
             selected.artist_metadata_id,
             related.release_group_id,
             related.release_group_mbid
      FROM selected_artists selected
      JOIN ArtistReleaseGroups related
        ON related.artist_metadata_id = selected.artist_metadata_id
        OR (related.artist_metadata_id IS NULL AND related.artist_mbid = selected.artist_mbid)
    ),
    release_group_stats AS (
      SELECT scope.artist_id,
             scope.artist_mbid,
             scope.release_group_id,
             scope.release_group_mbid,
             MAX(CASE WHEN slot.monitored = 1 THEN 1 ELSE 0 END) AS monitored,
             COALESCE(
               MAX(CASE WHEN selected_release.track_count IS NOT NULL THEN selected_release.track_count END),
               MAX(any_release.track_count),
               0
             ) AS track_count
      FROM artist_scope scope
      LEFT JOIN ReleaseGroupSlots slot
        ON slot.release_group_id = scope.release_group_id
       AND (slot.artist_metadata_id = scope.artist_metadata_id OR slot.artist_metadata_id IS NULL)
       AND slot.slot IN ('stereo', 'spatial')
      LEFT JOIN AlbumReleases selected_release
        ON selected_release.id = slot.selected_album_release_id
        OR (slot.selected_album_release_id IS NULL AND selected_release.mbid = slot.selected_release_mbid)
      LEFT JOIN AlbumReleases any_release
        ON any_release.release_group_id = scope.release_group_id
        OR (any_release.release_group_id IS NULL AND any_release.release_group_mbid = scope.release_group_mbid)
      GROUP BY scope.artist_id, scope.artist_mbid, scope.release_group_id, scope.release_group_mbid
    ),
    catalog_stats AS (
      SELECT artist_id,
             artist_mbid,
             COUNT(*) AS album_count,
             SUM(CASE WHEN monitored = 1 THEN 1 ELSE 0 END) AS monitored_album_count,
             SUM(track_count) AS track_count,
             SUM(CASE WHEN monitored = 1 THEN track_count ELSE 0 END) AS monitored_track_count
      FROM release_group_stats
      GROUP BY artist_id, artist_mbid
    ),
    file_stats AS (
      SELECT CAST(artist_id AS TEXT) AS artist_id,
             COUNT(DISTINCT COALESCE(
               CAST(track_id AS TEXT),
               canonical_track_mbid,
               CAST(recording_id AS TEXT),
               canonical_recording_mbid,
               CAST(provider_id AS TEXT),
               CAST(id AS TEXT)
             )) AS track_file_count,
             SUM(COALESCE(file_size, 0)) AS size_on_disk
      FROM TrackFiles
      WHERE file_type = 'track'
      GROUP BY CAST(artist_id AS TEXT)
    )
    SELECT selected.artist_id,
           selected.artist_mbid,
           COALESCE(catalog.album_count, 0) AS album_count,
           COALESCE(catalog.monitored_album_count, 0) AS monitored_album_count,
           COALESCE(catalog.track_count, 0) AS track_count,
           COALESCE(catalog.monitored_track_count, 0) AS monitored_track_count,
           COALESCE(files.track_file_count, 0) AS track_file_count,
           COALESCE(files.size_on_disk, 0) AS size_on_disk,
           CURRENT_TIMESTAMP AS updated_at
    FROM selected_artists selected
    LEFT JOIN catalog_stats catalog ON catalog.artist_id = selected.artist_id
    LEFT JOIN file_stats files ON files.artist_id = selected.artist_id
  `).all(...artistFilter.params) as ArtistStatisticsRow[];
}

export class ArtistStatisticsService {
  static getStatisticsMap(artistIds: string[]): Map<string, ArtistStatisticsRow> {
    const normalizedArtistIds = normalizeArtistIds(artistIds);
    if (normalizedArtistIds.length === 0) {
      return new Map();
    }

    const rows = db.prepare(`
      SELECT artist_id, artist_mbid, album_count, monitored_album_count,
             track_count, monitored_track_count, track_file_count,
             size_on_disk, updated_at
      FROM ArtistStatistics
      WHERE artist_id IN (${normalizedArtistIds.map(() => "?").join(",")})
    `).all(...normalizedArtistIds) as ArtistStatisticsRow[];

    return new Map(rows.map((row) => [String(row.artist_id), row]));
  }

  static refresh(artistIds?: Array<string | number | null | undefined>): ArtistStatisticsRow[] {
    const normalizedArtistIds = normalizeArtistIds(artistIds);
    const rows = calculateArtistStatistics(normalizedArtistIds.length > 0 ? normalizedArtistIds : undefined);

    const upsert = db.prepare(`
      INSERT INTO ArtistStatistics (
        artist_id, artist_mbid, album_count, monitored_album_count,
        track_count, monitored_track_count, track_file_count, size_on_disk, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(artist_id) DO UPDATE SET
        artist_mbid = excluded.artist_mbid,
        album_count = excluded.album_count,
        monitored_album_count = excluded.monitored_album_count,
        track_count = excluded.track_count,
        monitored_track_count = excluded.monitored_track_count,
        track_file_count = excluded.track_file_count,
        size_on_disk = excluded.size_on_disk,
        updated_at = CURRENT_TIMESTAMP
    `);

    db.transaction(() => {
      for (const row of rows) {
        upsert.run(
          row.artist_id,
          row.artist_mbid,
          Number(row.album_count || 0),
          Number(row.monitored_album_count || 0),
          Number(row.track_count || 0),
          Number(row.monitored_track_count || 0),
          Number(row.track_file_count || 0),
          Number(row.size_on_disk || 0),
        );
      }

      if (normalizedArtistIds.length === 0) {
        db.prepare(`
          DELETE FROM ArtistStatistics
          WHERE artist_id NOT IN (SELECT CAST(id AS TEXT) FROM Artists)
        `).run();
      }
    })();

    return rows;
  }
}
