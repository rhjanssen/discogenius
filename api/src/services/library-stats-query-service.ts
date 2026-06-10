import { db } from "../database.js";
import { countManagedArtists } from "./managed-artists.js";
import {
    countDownloadedAlbums,
    countDownloadedManagedArtists,
    countDownloadedTracks,
    countDownloadedVideos,
} from "./download-state.js";
import type { LibraryStatsContract } from "../contracts/catalog.js";

export class LibraryStatsQueryService {
    private static readonly SNAPSHOT_TTL_MS = 10_000;
    private static cachedSnapshot: { value: LibraryStatsContract; createdAtMs: number } | null = null;

    static clearCache(): void {
        this.cachedSnapshot = null;
    }

    static getSnapshot(): LibraryStatsContract {
        const cached = this.cachedSnapshot;
        if (cached && Date.now() - cached.createdAtMs < this.SNAPSHOT_TTL_MS) {
            return cached.value;
        }

        const stats: LibraryStatsContract = {
            artists: {
                total: (db.prepare("SELECT COUNT(*) as count FROM Artists").get() as { count: number }).count,
                monitored: countManagedArtists(),
                downloaded: countDownloadedManagedArtists(),
            },
            albums: {
                total: (db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM ReleaseGroupSlots
                    WHERE slot IN ('stereo', 'spatial')
                      AND selected_release_mbid IS NOT NULL
                `).get() as { count: number }).count,
                monitored: (db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM ReleaseGroupSlots
                    WHERE slot IN ('stereo', 'spatial')
                      AND selected_release_mbid IS NOT NULL
                      AND monitored = 1
                `).get() as { count: number }).count,
                downloaded: countDownloadedAlbums(),
            },
            tracks: {
                total: (db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM ReleaseGroupSlots rgs
                    JOIN Tracks t ON t.release_mbid = rgs.selected_release_mbid
                    WHERE rgs.slot IN ('stereo', 'spatial')
                      AND rgs.selected_release_mbid IS NOT NULL
                `).get() as { count: number }).count,
                monitored: (db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM ReleaseGroupSlots rgs
                    JOIN Tracks t ON t.release_mbid = rgs.selected_release_mbid
                    WHERE rgs.slot IN ('stereo', 'spatial')
                      AND rgs.selected_release_mbid IS NOT NULL
                      AND rgs.monitored = 1
                `).get() as { count: number }).count,
                downloaded: countDownloadedTracks(),
            },
            videos: {
                total: (db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM Recordings
                    WHERE COALESCE(IsVideo, 0) = 1
                `).get() as { count: number }).count,
                monitored: (db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM Recordings
                    WHERE COALESCE(IsVideo, 0) = 1
                      AND COALESCE(Monitored, 0) = 1
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
