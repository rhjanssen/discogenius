import { db } from "../../database.js";
import type { LibraryStatsContract } from "../../contracts/catalog.js";
import {
    appEvents,
    AppEvent,
    type CommandEventPayload,
} from "../commands/app-events.js";
import { audioLibraryPredicate } from "./library-album-monitoring.js";

type CanonicalLibraryStatsRow = {
    artist_total: number;
    artist_monitored: number;
    artist_downloaded: number;
    album_total: number;
    album_monitored: number;
    album_downloaded: number;
    track_total: number;
    track_monitored: number;
    track_downloaded: number;
    video_total: number;
    video_monitored: number;
    video_downloaded: number;
};

export class LibraryStatsQueryService {
    private static readonly SNAPSHOT_TTL_MS = 10_000;
    private static cachedSnapshot: { value: LibraryStatsContract; createdAtMs: number } | null = null;
    private static refreshScheduled = false;

    static clearCache(): void {
        this.cachedSnapshot = null;
    }

    /**
     * Stale-while-revalidate: an expired snapshot is served immediately and
     * refreshed off the request path. Under load the refresh cost is paid at
     * most once per TTL instead of by every waiting request, and /stats
     * latency stays flat. Only a cold cache computes synchronously.
     */
    static getSnapshot(): LibraryStatsContract {
        const cached = this.cachedSnapshot;
        if (cached && Date.now() - cached.createdAtMs < this.SNAPSHOT_TTL_MS) {
            return cached.value;
        }

        if (cached) {
            this.scheduleRefresh();
            return cached.value;
        }

        return this.computeSnapshot();
    }

    private static scheduleRefresh(): void {
        if (this.refreshScheduled) {
            return;
        }
        this.refreshScheduled = true;
        setImmediate(() => {
            try {
                this.computeSnapshot();
            } catch (error) {
                console.warn('[STATS] Background stats refresh failed:', error);
            } finally {
                this.refreshScheduled = false;
            }
        });
    }

    private static computeSnapshot(): LibraryStatsContract {
        /*
         * These dashboard counters are global canonical entities, not sums of
         * per-artist projections or per-library occurrences.
         *
         * A collaboration legitimately makes one Album visible under several
         * Artists, and selecting the same Edition in Stereo and Spatial creates
         * two independent completion requirements. ArtistStatistics therefore
         * remains useful for an Artist page, but summing it cannot answer a
         * whole-library question without double-counting both relationships.
         *
         * Completion is deliberately strict:
         * - only row-existence monitoring in enabled Libraries contributes;
         * - every selected (Library, Track) occurrence must have its exact
         *   TrackFiles.library_id + track_id audio row;
         * - every selected video placement must have its exact
         *   TrackFiles.library_id + recording_id video row;
         * - the canonical Album/Track/Video is still counted only once.
         *
         * This also makes a partial Album remain partial and prevents duplicate
         * or unselected physical video files from inflating the video counter.
         */
        const canonical = db.prepare(`
            WITH
            enabled_audio_libraries AS (
                SELECT library.id
                FROM Libraries library
                WHERE library.enabled = 1
                  AND ${audioLibraryPredicate("library")}
            ),
            monitored_artist_rows AS (
                SELECT DISTINCT
                    local_artist.id AS local_artist_id,
                    canonical_artist.mbid AS artist_mbid
                FROM LibraryArtists library_artist
                JOIN Libraries library
                  ON library.id = library_artist.library_id
                 AND library.enabled = 1
                JOIN ManagedArtists managed_artist
                  ON managed_artist.id = library_artist.managed_artist_id
                JOIN ArtistMetadata canonical_artist
                  ON canonical_artist.id = managed_artist.artist_id
                JOIN Artists local_artist
                  ON local_artist.mbid = canonical_artist.mbid
                WHERE library_artist.monitored = 1
            ),
            monitored_audio_requirements AS (
                SELECT DISTINCT
                    library_album.library_id,
                    library_album.release_group_id,
                    track.id AS track_id
                FROM LibraryAlbums library_album
                JOIN enabled_audio_libraries enabled_library
                  ON enabled_library.id = library_album.library_id
                JOIN LibraryEditions library_edition
                  ON library_edition.library_id = library_album.library_id
                JOIN AlbumEditions edition
                  ON edition.id = library_edition.edition_id
                 AND edition.release_group_id = library_album.release_group_id
                JOIN Tracks track
                  ON track.album_edition_id = edition.id
                JOIN Recordings recording
                  ON recording.id = track.recording_id
                 AND recording.is_video = 0
            ),
            audio_requirement_completion AS (
                SELECT
                    requirement.library_id,
                    requirement.release_group_id,
                    requirement.track_id,
                    CASE WHEN EXISTS (
                        SELECT 1
                        FROM TrackFiles track_file INDEXED BY idx_track_files_audio_completion
                        WHERE track_file.library_id = requirement.library_id
                          AND track_file.track_id = requirement.track_id
                          AND track_file.file_class = 'audio'
                    ) THEN 1 ELSE 0 END AS completed
                FROM monitored_audio_requirements requirement
            ),
            completed_albums AS (
                SELECT release_group_id
                FROM audio_requirement_completion
                GROUP BY release_group_id
                HAVING COUNT(*) > 0
                   AND MIN(completed) = 1
            ),
            completed_tracks AS (
                SELECT track_id
                FROM audio_requirement_completion
                GROUP BY track_id
                HAVING COUNT(*) > 0
                   AND MIN(completed) = 1
            ),
            monitored_video_requirements AS (
                SELECT DISTINCT
                    selected.video_recording_id AS recording_id,
                    CASE
                      WHEN selected.placement_mode = 'inline'
                        THEN selected.placement_library_id
                      ELSE selected.library_id
                    END AS required_library_id
                FROM LibraryVideos selected
                JOIN Libraries selection_library
                  ON selection_library.id = selected.library_id
                 AND selection_library.enabled = 1
                JOIN Recordings recording
                  ON recording.id = selected.video_recording_id
                 AND recording.is_video = 1
                LEFT JOIN Libraries placement_library
                  ON placement_library.id = selected.placement_library_id
                WHERE selected.placement_mode = 'separated'
                   OR placement_library.enabled = 1
            ),
            video_requirement_completion AS (
                SELECT
                    requirement.recording_id,
                    requirement.required_library_id,
                    CASE WHEN EXISTS (
                        SELECT 1
                        FROM TrackFiles video_file INDEXED BY idx_track_files_video_completion
                        WHERE video_file.library_id = requirement.required_library_id
                          AND video_file.recording_id = requirement.recording_id
                          AND video_file.file_class = 'video'
                    ) THEN 1 ELSE 0 END AS completed
                FROM monitored_video_requirements requirement
            ),
            completed_videos AS (
                SELECT recording_id
                FROM video_requirement_completion
                GROUP BY recording_id
                HAVING COUNT(*) > 0
                   AND MIN(completed) = 1
            ),
            album_artist_scope AS (
                SELECT album.id AS release_group_id, album.artist_mbid
                FROM Albums album
                UNION
                SELECT album.id AS release_group_id, scope.artist_mbid
                FROM ArtistReleaseGroups scope
                JOIN Albums album
                  ON album.mbid = scope.release_group_mbid
            ),
            artist_requirement_completion AS (
                SELECT
                    monitored_artist.local_artist_id,
                    audio_completion.completed
                FROM monitored_artist_rows monitored_artist
                JOIN album_artist_scope artist_scope
                  ON artist_scope.artist_mbid = monitored_artist.artist_mbid
                JOIN audio_requirement_completion audio_completion
                  ON audio_completion.release_group_id = artist_scope.release_group_id
                UNION ALL
                SELECT
                    monitored_artist.local_artist_id,
                    video_completion.completed
                FROM monitored_artist_rows monitored_artist
                JOIN Recordings recording
                  ON recording.artist_mbid = monitored_artist.artist_mbid
                 AND recording.is_video = 1
                JOIN video_requirement_completion video_completion
                  ON video_completion.recording_id = recording.id
            ),
            completed_artists AS (
                SELECT local_artist_id
                FROM artist_requirement_completion
                GROUP BY local_artist_id
                HAVING COUNT(*) > 0
                   AND MIN(completed) = 1
            )
            SELECT
                (SELECT COUNT(*) FROM Artists) AS artist_total,
                (SELECT COUNT(*) FROM monitored_artist_rows) AS artist_monitored,
                (SELECT COUNT(*) FROM completed_artists) AS artist_downloaded,
                (SELECT COUNT(*) FROM Albums) AS album_total,
                (
                  SELECT COUNT(DISTINCT library_album.release_group_id)
                  FROM LibraryAlbums library_album
                  JOIN enabled_audio_libraries enabled_library
                    ON enabled_library.id = library_album.library_id
                ) AS album_monitored,
                (SELECT COUNT(*) FROM completed_albums) AS album_downloaded,
                (
                  SELECT COUNT(*)
                  FROM Tracks track
                  JOIN Recordings recording
                    ON recording.id = track.recording_id
                   AND recording.is_video = 0
                ) AS track_total,
                (
                  SELECT COUNT(DISTINCT track_id)
                  FROM monitored_audio_requirements
                ) AS track_monitored,
                (SELECT COUNT(*) FROM completed_tracks) AS track_downloaded,
                (
                  SELECT COUNT(*)
                  FROM Recordings
                  WHERE is_video = 1
                ) AS video_total,
                (
                  SELECT COUNT(DISTINCT recording_id)
                  FROM monitored_video_requirements
                ) AS video_monitored,
                (SELECT COUNT(*) FROM completed_videos) AS video_downloaded
        `).get() as CanonicalLibraryStatsRow;

        const stats: LibraryStatsContract = {
            artists: {
                total: Number(canonical.artist_total || 0),
                monitored: Number(canonical.artist_monitored || 0),
                downloaded: Number(canonical.artist_downloaded || 0),
            },
            albums: {
                total: Number(canonical.album_total || 0),
                monitored: Number(canonical.album_monitored || 0),
                downloaded: Number(canonical.album_downloaded || 0),
            },
            tracks: {
                total: Number(canonical.track_total || 0),
                monitored: Number(canonical.track_monitored || 0),
                downloaded: Number(canonical.track_downloaded || 0),
            },
            videos: {
                total: Number(canonical.video_total || 0),
                monitored: Number(canonical.video_monitored || 0),
                downloaded: Number(canonical.video_downloaded || 0),
            },
        };

        try {
            const fileStats = db.prepare(`
        SELECT COUNT(*) as count, COALESCE(SUM(file_size), 0) as totalSize
        FROM TrackFiles
      `).get() as { count: number; totalSize: number };

            stats.files = {
                total: fileStats.count,
                totalSizeBytes: fileStats.totalSize,
            };
        } catch {
            // track_files may not exist yet on a brand-new database.
        }

        this.cachedSnapshot = {
            value: stats,
            createdAtMs: Date.now(),
        };

        return stats;
    }
}

// Keep the server-side snapshot coherent with mutations performed by command
// workers as well as direct file/config operations. Worker events are bridged
// back onto this main-thread emitter by the worker protocol.
const invalidateLibraryStats = () => LibraryStatsQueryService.clearCache();
appEvents.on(AppEvent.ARTIST_REFRESH_COMPLETE, invalidateLibraryStats);
appEvents.on(AppEvent.ARTIST_SCANNED, invalidateLibraryStats);
appEvents.on(AppEvent.CONFIG_UPDATED, invalidateLibraryStats);
appEvents.on(AppEvent.FILE_ADDED, invalidateLibraryStats);
appEvents.on(AppEvent.FILE_DELETED, invalidateLibraryStats);
appEvents.on(AppEvent.FILE_UPGRADED, invalidateLibraryStats);
appEvents.on(AppEvent.COMMAND_UPDATED, (event: CommandEventPayload) => {
    if (
        event.status === "completed"
        || event.status === "failed"
        || event.status === "cancelled"
    ) {
        invalidateLibraryStats();
    }
});
