import { db } from "../../database.js";
import { streamingProviderManager } from "../providers/index.js";

export const ARTIST_TOP_TRACK_LIMIT = 100;

type ArtistProjectionIdentity = {
  artistMetadataId: number;
  artistMbid: string;
};

function resolveArtistProjectionIdentity(artistId: string, artistMbid?: string | null): ArtistProjectionIdentity | null {
  const resolvedMbid = String(artistMbid || "").trim();
  const row = db.prepare(`
    SELECT metadata.id AS artistMetadataId, metadata.mbid AS artistMbid
    FROM ArtistMetadata metadata
    LEFT JOIN Artists artist ON artist.mbid = metadata.mbid
    WHERE metadata.mbid = @artistMbid
       OR artist.id = @artistId
    ORDER BY CASE WHEN metadata.mbid = @artistMbid THEN 0 ELSE 1 END
    LIMIT 1
  `).get({
    artistId,
    artistMbid: resolvedMbid || artistId,
  }) as ArtistProjectionIdentity | undefined;

  return row ?? null;
}

export class ArtistTopTrackService {
  static countMissingMonitoredArtists(): number {
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM Artists artist
      JOIN ArtistMetadata metadata ON metadata.mbid = artist.mbid
      LEFT JOIN ArtistTopTrackProjectionState state ON state.artist_metadata_id = metadata.id
      WHERE artist.monitored = 1
        AND state.artist_metadata_id IS NULL
    `).get() as { count?: number } | undefined;
    return Number(row?.count || 0);
  }

  static rebuildMissingMonitoredArtists(
    onProgress?: (progress: { index: number; total: number; artistName: string; rowCount: number }) => void,
  ): { artists: number; rows: number } {
    const artists = db.prepare(`
      SELECT artist.id AS artistId, metadata.mbid AS artistMbid, metadata.name AS artistName
      FROM Artists artist
      JOIN ArtistMetadata metadata ON metadata.mbid = artist.mbid
      LEFT JOIN ArtistTopTrackProjectionState state ON state.artist_metadata_id = metadata.id
      WHERE artist.monitored = 1
        AND state.artist_metadata_id IS NULL
      ORDER BY (artist.last_scanned IS NULL) ASC, artist.last_scanned DESC, metadata.name ASC
    `).all() as Array<{ artistId: string | number; artistMbid: string; artistName: string }>;

    let rows = 0;
    for (let index = 0; index < artists.length; index += 1) {
      const artist = artists[index];
      const rowCount = this.rebuildForArtist(String(artist.artistId), artist.artistMbid);
      rows += rowCount;
      onProgress?.({
        index: index + 1,
        total: artists.length,
        artistName: artist.artistName,
        rowCount,
      });
    }

    return { artists: artists.length, rows };
  }

  static rebuildForReleaseGroup(releaseGroupMbid: string): number {
    const artist = db.prepare(`
      SELECT artist.id AS artistId, metadata.mbid AS artistMbid
      FROM Albums album
      JOIN ArtistMetadata metadata
        ON metadata.id = album.artist_metadata_id OR metadata.mbid = album.artist_mbid
      LEFT JOIN Artists artist ON artist.mbid = metadata.mbid
      WHERE album.mbid = ?
      LIMIT 1
    `).get(releaseGroupMbid) as { artistId?: string | number | null; artistMbid: string } | undefined;

    if (!artist) {
      return 0;
    }

    return this.rebuildForArtist(String(artist.artistId || artist.artistMbid), artist.artistMbid);
  }

  static ensureForArtist(artistId: string, artistMbid?: string | null): ArtistProjectionIdentity | null {
    const identity = resolveArtistProjectionIdentity(artistId, artistMbid);
    if (!identity) {
      return null;
    }

    const state = db.prepare(`
      SELECT 1
      FROM ArtistTopTrackProjectionState
      WHERE artist_metadata_id = ?
    `).get(identity.artistMetadataId);

    if (!state) {
      this.rebuildForArtist(artistId, identity.artistMbid);
    }

    return identity;
  }

  static rebuildForArtist(artistId: string, artistMbid?: string | null): number {
    const identity = resolveArtistProjectionIdentity(artistId, artistMbid);
    if (!identity) {
      return 0;
    }

    const rebuild = db.transaction(() => {
      db.prepare("DELETE FROM ArtistTopTracks WHERE artist_metadata_id = ?")
        .run(identity.artistMetadataId);

      const result = db.prepare(`
        INSERT INTO ArtistTopTracks (
          artist_metadata_id,
          track_id,
          recording_id,
          popularity,
          release_date,
          rank,
          updated_at
        )
        WITH preferred_provider(id) AS (VALUES (@preferredProvider)),
        artist_rgs(id) AS (
          SELECT album.id
          FROM Albums album
          WHERE album.artist_metadata_id = @artistMetadataId
             OR album.artist_mbid = @artistMbid

          UNION

          SELECT scope.release_group_id
          FROM ArtistReleaseGroups scope
          WHERE scope.artist_metadata_id = @artistMetadataId
            AND scope.release_group_id IS NOT NULL

          UNION

          SELECT album.id
          FROM ArtistReleaseGroups scope
          JOIN Albums album ON album.mbid = scope.release_group_mbid
          WHERE scope.artist_mbid = @artistMbid
        ),
        artist_releases(id) AS (
          SELECT DISTINCT library_release.release_id
          FROM artist_rgs
          JOIN LibraryReleaseGroups library_group
            ON library_group.release_group_id = artist_rgs.id
          JOIN LibraryReleases library_release
            ON library_release.library_id = library_group.library_id
          JOIN AlbumReleases selected_release
            ON selected_release.id = library_release.release_id
           AND selected_release.release_group_id = library_group.release_group_id
        ),
        edition_tracks AS (
          SELECT
            track.id AS track_id,
            track.mbid AS track_mbid,
            track.recording_id,
            COALESCE(release.date, release_group.first_release_date) AS release_date,
            COALESCE(
              (
                SELECT provider_score.popularity
                FROM ProviderItems provider_score INDEXED BY idx_provider_items_recording_id
                WHERE recording.id IS NOT NULL
                  AND provider_score.recording_id = recording.id
                  AND provider_score.entity_type = 'track'
                  AND provider_score.popularity IS NOT NULL
                ORDER BY
                  CASE WHEN provider_score.provider = (SELECT id FROM preferred_provider) THEN 0 ELSE 1 END,
                  provider_score.updated_at DESC,
                  provider_score.provider ASC,
                  provider_score.provider_id ASC
                LIMIT 1
              ),
              (
                SELECT provider_score.popularity
                FROM ProviderItems provider_score INDEXED BY idx_provider_items_track_id
                WHERE provider_score.track_id = track.id
                  AND provider_score.entity_type = 'track'
                  AND provider_score.popularity IS NOT NULL
                ORDER BY
                  CASE WHEN provider_score.provider = (SELECT id FROM preferred_provider) THEN 0 ELSE 1 END,
                  provider_score.updated_at DESC,
                  provider_score.provider ASC,
                  provider_score.provider_id ASC
                LIMIT 1
              ),
              recording.popularity,
              0
            ) AS popularity,
            ROW_NUMBER() OVER (
              PARTITION BY COALESCE(track.recording_id, track.id)
              ORDER BY
                COALESCE(release.date, release_group.first_release_date) ASC,
                track.id ASC
            ) AS recording_rank
          FROM artist_releases
          JOIN Tracks track INDEXED BY idx_tracks_album_release_position
            ON track.album_release_id = artist_releases.id
          JOIN AlbumReleases release ON release.id = track.album_release_id
          JOIN Albums release_group ON release_group.id = release.release_group_id
          LEFT JOIN Recordings recording ON recording.id = track.recording_id
          WHERE recording.artist_metadata_id = @artistMetadataId
             OR recording.artist_mbid = @artistMbid
             OR release_group.artist_metadata_id = @artistMetadataId
             OR release_group.artist_mbid = @artistMbid
        ),
        deduplicated AS (
          SELECT track_id, track_mbid, recording_id, release_date, popularity
          FROM edition_tracks
          WHERE recording_rank = 1
        ),
        ranked AS (
          SELECT
            track_id,
            recording_id,
            popularity,
            release_date,
            ROW_NUMBER() OVER (
              ORDER BY popularity DESC, release_date DESC, track_mbid ASC
            ) AS rank
          FROM deduplicated
        )
        SELECT
          @artistMetadataId,
          track_id,
          recording_id,
          popularity,
          release_date,
          rank,
          CURRENT_TIMESTAMP
        FROM ranked
        WHERE rank <= @limit
        ORDER BY rank
      `).run({
        artistMetadataId: identity.artistMetadataId,
        artistMbid: identity.artistMbid,
        preferredProvider: streamingProviderManager.getDefaultProviderId(),
        limit: ARTIST_TOP_TRACK_LIMIT,
      });

      const rowCount = Number(result.changes || 0);
      db.prepare(`
        INSERT INTO ArtistTopTrackProjectionState (artist_metadata_id, row_count, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(artist_metadata_id) DO UPDATE SET
          row_count = excluded.row_count,
          updated_at = CURRENT_TIMESTAMP
      `).run(identity.artistMetadataId, rowCount);

      return rowCount;
    });

    return rebuild();
  }
}
