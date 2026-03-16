import { db } from "../database.js";
import { countManagedArtists } from "./managed-artists.js";
import {
    countDownloadedAlbums,
    countDownloadedManagedArtists,
    countDownloadedTracks,
    countDownloadedVideos,
} from "./download-state.js";

export interface LibraryStatsSnapshot {
    artists: {
        total: number;
        monitored: number;
        downloaded: number;
    };
    albums: {
        total: number;
        monitored: number;
        downloaded: number;
    };
    tracks: {
        total: number;
        monitored: number;
        downloaded: number;
    };
    videos: {
        total: number;
        monitored: number;
        downloaded: number;
    };
    files?: {
        total: number;
        totalSizeBytes: number;
    };
}

export class LibraryStatsQueryService {
    private static readonly SNAPSHOT_TTL_MS = 10_000;
    private static cachedSnapshot: { value: LibraryStatsSnapshot; createdAtMs: number } | null = null;

    static getSnapshot(): LibraryStatsSnapshot {
        const cached = this.cachedSnapshot;
        if (cached && Date.now() - cached.createdAtMs < this.SNAPSHOT_TTL_MS) {
            return cached.value;
        }

        const stats: LibraryStatsSnapshot = {
            artists: {
                total: (db.prepare("SELECT COUNT(*) as count FROM artists").get() as { count: number }).count,
                monitored: countManagedArtists(),
                downloaded: countDownloadedManagedArtists(),
            },
            albums: {
                total: (db.prepare("SELECT COUNT(*) as count FROM albums").get() as { count: number }).count,
                monitored: (db.prepare("SELECT COUNT(*) as count FROM albums WHERE monitor = 1").get() as { count: number }).count,
                downloaded: countDownloadedAlbums(),
            },
            tracks: {
                total: (db.prepare("SELECT COUNT(*) as count FROM media WHERE album_id IS NOT NULL").get() as { count: number }).count,
                monitored: (db.prepare("SELECT COUNT(*) as count FROM media WHERE album_id IS NOT NULL AND monitor = 1").get() as { count: number }).count,
                downloaded: countDownloadedTracks(),
            },
            videos: {
                total: (db.prepare("SELECT COUNT(*) as count FROM media WHERE type = 'Music Video'").get() as { count: number }).count,
                monitored: (db.prepare("SELECT COUNT(*) as count FROM media WHERE type = 'Music Video' AND monitor = 1").get() as { count: number }).count,
                downloaded: countDownloadedVideos(),
            },
        };

        try {
            const fileStats = db.prepare(`
        SELECT COUNT(*) as count, COALESCE(SUM(file_size), 0) as totalSize
        FROM library_files
      `).get() as { count: number; totalSize: number };

            stats.files = {
                total: fileStats.count,
                totalSizeBytes: fileStats.totalSize,
            };
        } catch {
            // library_files may not exist yet on a brand-new database.
        }

        this.cachedSnapshot = {
            value: stats,
            createdAtMs: Date.now(),
        };

        return stats;
    }
}