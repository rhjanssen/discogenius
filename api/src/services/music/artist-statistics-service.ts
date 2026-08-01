import { db } from "../../database.js";
import { audioLibraryPredicate } from "./library-album-monitoring.js";

export interface ArtistStatisticsRow {
  artist_id: string;
  artist_mbid: string | null;
  album_count: number;
  monitored_album_count: number;
  downloaded_album_count: number;
  track_count: number;
  monitored_track_count: number;
  track_file_count: number;
  video_count: number;
  size_on_disk: number;
  updated_at: string | null;
}

const STATISTICS_COLUMNS = `artist_id, artist_mbid, album_count, monitored_album_count, downloaded_album_count,
             track_count, monitored_track_count, track_file_count, video_count,
             size_on_disk, updated_at`;

function normalizeArtistIds(artistIds?: Array<string | number | null | undefined>): string[] {
  return Array.from(new Set((artistIds ?? [])
    .map((artistId) => String(artistId ?? "").trim())
    .filter(Boolean)));
}

type ScopedArtist = {
  artistId: string;
  artistMbid: string | null;
  artistMetadataId: number | null;
};

/**
 * Port of Lidarr's ArtistStatistics rollup (NzbDrone.Core.ArtistStats):
 * compute per-album statistics, then sum them up to the artist. Lidarr rolls
 * Album → Artist; Discogenius rolls release-group → artist and adds a video
 * counter. The heavy per-release-group track/file counting (including the
 * stereo/spatial slot dedup) is delegated to download-state's
 * getReleaseGroupDownloadStatsMap — the single, already-tested source of truth —
 * rather than re-deriving it in a parallel query here.
 */
// Keeps every generated IN-list / VALUES clause well under SQLite's bound-
// parameter ceiling (SQLITE_MAX_VARIABLE_NUMBER). A full-library refresh
// enumerates all artists and processes them in chunks of this size.
const ARTIST_STATISTICS_CHUNK_SIZE = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

type ReleaseGroupProjectionStats = {
  totalTracks: number;
  downloadedTracks: number;
  isDownloaded: boolean;
};

/**
 * ArtistStatistics is a projection of persisted Library curation, not a
 * prediction of what the current filtering settings would curate next. Once an
 * enabled Library has selected an Edition, every exact (Library, Track)
 * occurrence remains a completion requirement until that row is withdrawn.
 *
 * The download-state helpers intentionally honour include_spatial/include_video
 * as acquisition-policy switches, so using them here made the projection
 * disagree with the canonical global dashboard whenever an existing Spatial
 * selection survived a later policy change.
 */
function getReleaseGroupProjectionStats(
  releaseGroupMbids: string[],
): Map<string, ReleaseGroupProjectionStats> {
  const result = new Map<string, ReleaseGroupProjectionStats>();
  for (const mbidChunk of chunk(releaseGroupMbids, 500)) {
    const rows = db.prepare(`
      WITH selected_requirements AS (
        SELECT DISTINCT
          album.mbid AS release_group_mbid,
          selected_album.library_id,
          track.id AS track_id
        FROM Albums album
        JOIN LibraryAlbums selected_album
          ON selected_album.release_group_id = album.id
        JOIN Libraries library
          ON library.id = selected_album.library_id
         AND library.enabled = 1
        JOIN LibraryEditions selected_edition
          ON selected_edition.library_id = selected_album.library_id
        JOIN AlbumEditions edition
          ON edition.id = selected_edition.edition_id
         AND edition.release_group_id = album.id
        JOIN Tracks track
          ON track.album_edition_id = edition.id
        JOIN Recordings recording
          ON recording.id = track.recording_id
         AND recording.is_video = 0
        WHERE album.mbid IN (${mbidChunk.map(() => "?").join(",")})
          AND ${audioLibraryPredicate("library")}
      )
      SELECT
        requirement.release_group_mbid,
        COUNT(*) AS total_tracks,
        SUM(CASE WHEN EXISTS (
          SELECT 1
          FROM TrackFiles file INDEXED BY idx_track_files_audio_completion
          WHERE file.library_id = requirement.library_id
            AND file.track_id = requirement.track_id
            AND file.file_class = 'audio'
        ) THEN 1 ELSE 0 END) AS downloaded_tracks
      FROM selected_requirements requirement
      GROUP BY requirement.release_group_mbid
    `).all(...mbidChunk) as Array<{
      release_group_mbid: string;
      total_tracks: number;
      downloaded_tracks: number;
    }>;
    for (const row of rows) {
      const totalTracks = Number(row.total_tracks || 0);
      const downloadedTracks = Number(row.downloaded_tracks || 0);
      result.set(String(row.release_group_mbid), {
        totalTracks,
        downloadedTracks,
        isDownloaded: totalTracks > 0 && downloadedTracks >= totalTracks,
      });
    }
  }
  for (const mbid of releaseGroupMbids) {
    if (!result.has(mbid)) {
      result.set(mbid, { totalTracks: 0, downloadedTracks: 0, isDownloaded: false });
    }
  }
  return result;
}

/** Compute statistics for an explicit, already-bounded set of artist ids. */
function calculateArtistStatisticsChunk(normalizedArtistIds: string[]): ArtistStatisticsRow[] {
  if (normalizedArtistIds.length === 0) {
    return [];
  }
  const artistFilter = ` WHERE CAST(a.id AS TEXT) IN (${normalizedArtistIds.map(() => "?").join(",")})`;

  const scopedArtists = (db.prepare(`
    SELECT CAST(a.id AS TEXT) AS artist_id,
           NULLIF(TRIM(CAST(a.mbid AS TEXT)), '') AS artist_mbid,
           metadata.id AS artist_metadata_id
    FROM Artists a
    LEFT JOIN ArtistMetadata metadata ON metadata.mbid = a.mbid
    ${artistFilter}
  `).all(...normalizedArtistIds) as Array<{
    artist_id: string;
    artist_mbid: string | null;
    artist_metadata_id: number | null;
  }>).map<ScopedArtist>((row) => ({
    artistId: String(row.artist_id),
    artistMbid: row.artist_mbid ? String(row.artist_mbid) : null,
    artistMetadataId: row.artist_metadata_id == null ? null : Number(row.artist_metadata_id),
  }));

  if (scopedArtists.length === 0) {
    return [];
  }

  const scopedMbids = Array.from(new Set(
    scopedArtists.map((artist) => artist.artistMbid).filter((mbid): mbid is string => Boolean(mbid)),
  ));
  const scopedMetadataIds = Array.from(new Set(
    scopedArtists.map((artist) => artist.artistMetadataId).filter((id): id is number => id != null),
  ));
  // release-group scope + monitored flag, one row per (artist_mbid, release group)
  const scopeRows = scopedMbids.length === 0 ? [] : db.prepare(`
    WITH scope(artist_mbid, release_group_mbid) AS (
      SELECT artist_mbid, mbid FROM Albums WHERE artist_mbid IN (${scopedMbids.map(() => "?").join(",")})
      UNION
      SELECT artist_mbid, release_group_mbid FROM ArtistReleaseGroups WHERE artist_mbid IN (${scopedMbids.map(() => "?").join(",")})
    ),
    library_state AS (
      SELECT
        library_group.release_group_id,
        1 AS monitored
      FROM LibraryAlbums library_group
      JOIN Libraries library
        ON library.id = library_group.library_id
       AND library.enabled = 1
      WHERE ${audioLibraryPredicate("library")}
      GROUP BY library_group.release_group_id
    )
    SELECT scope.artist_mbid,
           scope.release_group_mbid,
           COALESCE(library_state.monitored, 0) AS monitored
    FROM scope
    LEFT JOIN Albums scoped_group ON scoped_group.mbid = scope.release_group_mbid
    LEFT JOIN library_state ON library_state.release_group_id = scoped_group.id
  `).all(...scopedMbids, ...scopedMbids) as Array<{
    artist_mbid: string;
    release_group_mbid: string;
    monitored: number;
  }>;

  const releaseGroupMbids = Array.from(new Set(scopeRows.map((row) => String(row.release_group_mbid))));
  const releaseGroupStats = getReleaseGroupProjectionStats(releaseGroupMbids);

  const scopeByMbid = new Map<string, Array<{ releaseGroupMbid: string; monitored: boolean }>>();
  for (const row of scopeRows) {
    const list = scopeByMbid.get(String(row.artist_mbid)) ?? [];
    list.push({ releaseGroupMbid: String(row.release_group_mbid), monitored: Number(row.monitored) === 1 });
    scopeByMbid.set(String(row.artist_mbid), list);
  }

  // downloaded videos per artist link (mbid + metadata id)
  const videoRows = (scopedMbids.length === 0 && scopedMetadataIds.length === 0) ? [] : db.prepare(`
    SELECT recording.artist_mbid AS artist_mbid,
           recording.artist_metadata_id AS artist_metadata_id,
           COUNT(DISTINCT recording.id) AS video_count
    FROM Recordings recording
    JOIN TrackFiles tf
      ON tf.file_type = 'video'
     AND (tf.recording_id = recording.id OR tf.canonical_recording_mbid = recording.mbid)
    WHERE recording.is_video = 1
      AND (
        recording.artist_mbid IN (${scopedMbids.length > 0 ? scopedMbids.map(() => "?").join(",") : "NULL"})
        OR recording.artist_metadata_id IN (${scopedMetadataIds.length > 0 ? scopedMetadataIds.map(() => "?").join(",") : "NULL"})
      )
    GROUP BY recording.artist_mbid, recording.artist_metadata_id
  `).all(...scopedMbids, ...scopedMetadataIds) as Array<{
    artist_mbid: string | null;
    artist_metadata_id: number | null;
    video_count: number;
  }>;

  const videoCountByMbid = new Map<string, number>();
  const videoCountByMetadataId = new Map<number, number>();
  for (const row of videoRows) {
    if (row.artist_mbid) {
      videoCountByMbid.set(String(row.artist_mbid), (videoCountByMbid.get(String(row.artist_mbid)) ?? 0) + Number(row.video_count || 0));
    } else if (row.artist_metadata_id != null) {
      videoCountByMetadataId.set(Number(row.artist_metadata_id), (videoCountByMetadataId.get(Number(row.artist_metadata_id)) ?? 0) + Number(row.video_count || 0));
    }
  }

  // size on disk per artist (tracks + videos), keyed by canonical artist mbid
  const sizeByMbid = new Map<string, number>();
  if (scopedMbids.length > 0) {
    const sizeRows = db.prepare(`
      SELECT canonical_artist_mbid AS artist_mbid, SUM(COALESCE(file_size, 0)) AS size_on_disk
      FROM TrackFiles
      WHERE file_type IN ('track', 'video')
        AND canonical_artist_mbid IN (${scopedMbids.map(() => "?").join(",")})
      GROUP BY canonical_artist_mbid
    `).all(...scopedMbids) as Array<{ artist_mbid: string; size_on_disk: number }>;
    for (const row of sizeRows) {
      sizeByMbid.set(String(row.artist_mbid), Number(row.size_on_disk || 0));
    }
  }

  return scopedArtists.map((artist) => {
    const releaseGroups = artist.artistMbid ? (scopeByMbid.get(artist.artistMbid) ?? []) : [];

    let albumCount = 0;
    let monitoredAlbumCount = 0;
    let downloadedAlbumCount = 0;
    let trackCount = 0;
    let monitoredTrackCount = 0;
    let trackFileCount = 0;

    for (const releaseGroup of releaseGroups) {
      const stats = releaseGroupStats.get(releaseGroup.releaseGroupMbid);
      const totalTracks = Number(stats?.totalTracks ?? 0);
      const downloadedTracks = Number(stats?.downloadedTracks ?? 0);

      albumCount += 1;
      trackCount += totalTracks;

      // Progress-bar numerator/denominator count monitored albums only, matching
      // Lidarr (unmonitored albums do not weigh on the artist's completion).
      if (releaseGroup.monitored) {
        monitoredAlbumCount += 1;
        monitoredTrackCount += totalTracks;
        trackFileCount += downloadedTracks;
        if (stats?.isDownloaded) {
          downloadedAlbumCount += 1;
        }
      }
    }

    const videoCount = (artist.artistMbid ? videoCountByMbid.get(artist.artistMbid) ?? 0 : 0)
      + (artist.artistMetadataId != null ? videoCountByMetadataId.get(artist.artistMetadataId) ?? 0 : 0);
    const sizeOnDisk = artist.artistMbid ? sizeByMbid.get(artist.artistMbid) ?? 0 : 0;

    return {
      artist_id: artist.artistId,
      artist_mbid: artist.artistMbid,
      album_count: albumCount,
      monitored_album_count: monitoredAlbumCount,
      downloaded_album_count: downloadedAlbumCount,
      track_count: trackCount,
      monitored_track_count: monitoredTrackCount,
      track_file_count: trackFileCount,
      video_count: videoCount,
      size_on_disk: sizeOnDisk,
      updated_at: null,
    };
  });
}

export class ArtistStatisticsService {
  static getStatisticsMap(artistIds: string[]): Map<string, ArtistStatisticsRow> {
    const normalizedArtistIds = normalizeArtistIds(artistIds);
    if (normalizedArtistIds.length === 0) {
      return new Map();
    }

    const rows = db.prepare(`
      SELECT ${STATISTICS_COLUMNS}
      FROM ArtistStatistics
      WHERE artist_id IN (${normalizedArtistIds.map(() => "?").join(",")})
    `).all(...normalizedArtistIds) as ArtistStatisticsRow[];

    return new Map(rows.map((row) => [String(row.artist_id), row]));
  }

  static refresh(artistIds?: Array<string | number | null | undefined>): ArtistStatisticsRow[] {
    const explicitIds = normalizeArtistIds(artistIds);
    const isFullRefresh = artistIds === undefined || (Array.isArray(artistIds) && artistIds.length === 0);

    // Full refresh: enumerate every artist and process in bounded chunks so the
    // per-chunk IN-lists / VALUES clauses stay well under SQLite's parameter
    // ceiling. Scoped refresh: just chunk the caller's ids.
    const targetIds = isFullRefresh
      ? (db.prepare("SELECT CAST(id AS TEXT) AS artist_id FROM Artists").all() as Array<{ artist_id: string }>)
          .map((row) => String(row.artist_id))
      : explicitIds;

    const rows = chunk(targetIds, ARTIST_STATISTICS_CHUNK_SIZE)
      .flatMap((idsChunk) => calculateArtistStatisticsChunk(idsChunk));

    const upsert = db.prepare(`
      INSERT INTO ArtistStatistics (
        artist_id, artist_mbid, album_count, monitored_album_count, downloaded_album_count,
        track_count, monitored_track_count, track_file_count, video_count, size_on_disk, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(artist_id) DO UPDATE SET
        artist_mbid = excluded.artist_mbid,
        album_count = excluded.album_count,
        monitored_album_count = excluded.monitored_album_count,
        downloaded_album_count = excluded.downloaded_album_count,
        track_count = excluded.track_count,
        monitored_track_count = excluded.monitored_track_count,
        track_file_count = excluded.track_file_count,
        video_count = excluded.video_count,
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
          Number(row.downloaded_album_count || 0),
          Number(row.track_count || 0),
          Number(row.monitored_track_count || 0),
          Number(row.track_file_count || 0),
          Number(row.video_count || 0),
          Number(row.size_on_disk || 0),
        );
      }

      if (isFullRefresh) {
        db.prepare(`
          DELETE FROM ArtistStatistics
          WHERE artist_id NOT IN (SELECT CAST(id AS TEXT) FROM Artists)
        `).run();
      }
    })();

    return rows;
  }

  /**
   * Refresh every Artist projection whose canonical discography contains one
   * of these Albums. A release-group selection affects primary and credited
   * Artists alike, so refreshing only Albums.artist_mbid would leave
   * collaboration rows stale.
   */
  static refreshForReleaseGroupMbids(
    releaseGroupMbids: Array<string | number | null | undefined>,
  ): ArtistStatisticsRow[] {
    const normalizedMbids = normalizeArtistIds(releaseGroupMbids);
    if (normalizedMbids.length === 0) {
      return [];
    }

    const artistIds = new Set<string>();
    for (const mbidChunk of chunk(normalizedMbids, ARTIST_STATISTICS_CHUNK_SIZE)) {
      const placeholders = mbidChunk.map(() => "?").join(",");
      const rows = db.prepare(`
        WITH affected_artist_mbids(artist_mbid) AS (
          SELECT album.artist_mbid
          FROM Albums album
          WHERE album.mbid IN (${placeholders})

          UNION

          SELECT scope.artist_mbid
          FROM ArtistReleaseGroups scope
          WHERE scope.release_group_mbid IN (${placeholders})
        )
        SELECT CAST(artist.id AS TEXT) AS artist_id
        FROM Artists artist
        JOIN affected_artist_mbids affected
          ON affected.artist_mbid = artist.mbid
      `).all(...mbidChunk, ...mbidChunk) as Array<{ artist_id: string }>;
      for (const row of rows) {
        artistIds.add(String(row.artist_id));
      }
    }
    if (artistIds.size === 0) {
      return [];
    }
    return this.refresh([...artistIds]);
  }
}
