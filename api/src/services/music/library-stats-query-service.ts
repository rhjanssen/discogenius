import { db } from "../../database.js";
import { countManagedArtists } from "./managed-artists.js";
import {
    countDownloadedVideos,
} from "../download/download-state.js";
import type { LibraryStatsContract } from "../../contracts/catalog.js";

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
        const artistCount = (db.prepare("SELECT COUNT(*) as count FROM Artists").get() as { count: number }).count;

        // Read precomputed statistics only — the heavy whole-library aggregation
        // runs off the main thread (command workers refresh per artist on scan;
        // bulk handlers refresh the rest). Computing it here would block the
        // event loop for tens of seconds on a cold cache.
        const cachedArtistStats = db.prepare(`
            SELECT
                COALESCE(SUM(album_count), 0) AS album_total,
                COALESCE(SUM(monitored_album_count), 0) AS album_monitored,
                COALESCE(SUM(track_count), 0) AS track_total,
                COALESCE(SUM(monitored_track_count), 0) AS track_monitored,
                COALESCE(SUM(track_file_count), 0) AS track_downloaded,
                SUM(CASE
                    WHEN monitored_track_count > 0 AND track_file_count >= monitored_track_count THEN 1
                    ELSE 0
                END) AS artist_downloaded
            FROM ArtistStatistics
        `).get() as {
            album_total: number;
            album_monitored: number;
            track_total: number;
            track_monitored: number;
            track_downloaded: number;
            artist_downloaded: number;
        };

        const downloadedAlbums = (db.prepare(`
            SELECT COUNT(DISTINCT COALESCE(
                CAST(release_group_id AS TEXT),
                canonical_release_group_mbid,
                canonical_release_mbid
            )) AS count
            FROM TrackFiles
            WHERE file_type = 'track'
              AND (release_group_id IS NOT NULL OR canonical_release_group_mbid IS NOT NULL OR canonical_release_mbid IS NOT NULL)
        `).get() as { count: number } | undefined)?.count ?? 0;

        const stats: LibraryStatsContract = {
            artists: {
                total: artistCount,
                monitored: countManagedArtists(),
                downloaded: Number(cachedArtistStats.artist_downloaded || 0),
            },
            albums: {
                total: Number(cachedArtistStats.album_total || 0),
                monitored: Number(cachedArtistStats.album_monitored || 0),
                downloaded: Number(downloadedAlbums || 0),
            },
            tracks: {
                total: Number(cachedArtistStats.track_total || 0),
                monitored: Number(cachedArtistStats.track_monitored || 0),
                downloaded: Number(cachedArtistStats.track_downloaded || 0),
            },
            videos: {
                // is_video is NOT NULL DEFAULT 0, so the bare equality lets
                // SQLite use the partial idx_recordings_video index.
                total: (db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM Recordings
                    WHERE is_video = 1
                `).get() as { count: number }).count,
                // A LibraryVideos row IS the monitoring statement, so monitored
                // videos are counted by counting the distinct videos selected.
                monitored: (db.prepare(`
                    SELECT COUNT(DISTINCT selected.video_recording_id) AS count
                    FROM LibraryVideos selected
                    JOIN Libraries library
                      ON library.id = selected.library_id AND library.enabled = 1
                `).get() as { count: number }).count,
                downloaded: countDownloadedVideos(),
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
