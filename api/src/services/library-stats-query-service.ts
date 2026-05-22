import { db } from "../database.js";
import { countManagedArtists, buildManagedArtistPredicate } from "./managed-artists.js";
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
                    SELECT (SELECT COUNT(*) FROM ProviderAlbums) +
                           (SELECT COUNT(*) FROM ProviderAlbums WHERE mbid NOT IN (SELECT mb_release_group_id FROM ProviderAlbums WHERE mb_release_group_id IS NOT NULL)) as count
                `).get() as { count: number }).count,
                monitored: (db.prepare(`
                    WITH artist_monitors AS (
                      SELECT a.mbid, CASE WHEN (${buildManagedArtistPredicate("a")}) THEN 1 ELSE 0 END as effective_monitor
                      FROM Artists a
                      WHERE a.mbid IS NOT NULL
                    )
                    SELECT
                      (SELECT COUNT(*) FROM ProviderAlbums WHERE monitor = 1) +
                      (
                        SELECT COUNT(DISTINCT rg.mbid)
                        FROM Albums rg
                        LEFT JOIN ReleaseGroupSlots rgs ON rgs.release_group_mbid = rg.mbid
                        LEFT JOIN artist_monitors am ON am.mbid = rg.artist_mbid
                        WHERE COALESCE(rgs.wanted, am.effective_monitor, 0) = 1
                          AND rg.mbid NOT IN (SELECT mb_release_group_id FROM ProviderAlbums WHERE mb_release_group_id IS NOT NULL)
                      ) as count
                `).get() as { count: number }).count,
                downloaded: countDownloadedAlbums(),
            },
            tracks: {
                total: (db.prepare("SELECT COUNT(*) as count FROM ProviderMedia WHERE album_id IS NOT NULL").get() as { count: number }).count,
                monitored: (db.prepare("SELECT COUNT(*) as count FROM ProviderMedia WHERE album_id IS NOT NULL AND monitor = 1").get() as { count: number }).count,
                downloaded: countDownloadedTracks(),
            },
            videos: {
                total: (db.prepare("SELECT COUNT(*) as count FROM ProviderMedia WHERE type = 'Music Video'").get() as { count: number }).count,
                monitored: (db.prepare("SELECT COUNT(*) as count FROM ProviderMedia WHERE type = 'Music Video' AND monitor = 1").get() as { count: number }).count,
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
