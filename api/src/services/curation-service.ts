import { db } from "../database.js";
import { getConfigSection } from "./config.js";
import { LidarrReleaseMonitoringService } from "./lidarr-release-monitoring-service.js";
import type { LidarrLibraryType } from "./lidarr-domain-schema.js";
import { WantedQueueService } from "./wanted-queue-service.js";

export type CurationLibraryRequest = "music" | "atmos" | "video";

export class CurationService {
    static async processRedundancy(
        artistId: string,
        libraryType: CurationLibraryRequest = "music",
    ): Promise<{ newAlbums: number; upgradedAlbums: number }> {
        if (libraryType === "video") {
            const updated = this.applyVideoMonitoring(artistId, true);
            console.log(`[Curation] Updated ${updated} video monitoring rows for artist ${artistId}.`);
            return { newAlbums: updated, upgradedAlbums: 0 };
        }

        const releaseLibraryType = mapLibraryType(libraryType);
        console.log(`[Curation] Applying Lidarr-style ${releaseLibraryType} release selection for artist ${artistId}...`);

        const curationConfig = getConfigSection("filtering");
        const result = LidarrReleaseMonitoringService.applyMonitoringDecisions({
            artistId,
            libraryTypes: [releaseLibraryType],
            redundancyEnabled: curationConfig?.enable_redundancy_filter !== false,
        });

        console.log(
            `[Curation] ${result.releaseGroups} release groups, ${result.monitored} monitored decisions, ` +
            `${result.redundant} redundant subsets.`
        );

        return { newAlbums: result.monitored, upgradedAlbums: 0 };
    }

    static async queueMonitoredItems(
        artistId?: string
    ): Promise<{ albums: number; tracks: number; videos: number }> {
        console.log(`[Queue] Queueing wanted release/video items${artistId ? ` for artist ${artistId}` : ""}...`);

        const result = WantedQueueService.queueWantedItems({ artistId });
        console.log(`[Queue] Ensured queue has ${result.albums} albums, ${result.tracks} tracks, ${result.videos} videos.`);
        return result;
    }

    static async processAll(
        artistId: string,
        options: { skipDownloadQueue?: boolean; forceDownloadQueue?: boolean } = {}
    ): Promise<{ newAlbums: number; upgradedAlbums: number }> {
        const curationConfig = getConfigSection("filtering");
        const libraryTypes: LidarrLibraryType[] = ["stereo"];

        if (curationConfig.include_atmos === true) {
            libraryTypes.push("atmos");
        } else {
            this.unmonitorLibraryType(artistId, "atmos");
        }

        const result = LidarrReleaseMonitoringService.applyMonitoringDecisions({
            artistId,
            libraryTypes,
            redundancyEnabled: curationConfig?.enable_redundancy_filter !== false,
        });

        const videoUpdates = this.applyVideoMonitoring(artistId);

        if (options.skipDownloadQueue !== undefined || options.forceDownloadQueue !== undefined) {
            console.log(
                `[Queue] Ignoring legacy curation auto-queue flags for artist ${artistId}; ` +
                "DownloadMissing remains the dedicated queueing path."
            );
        }

        console.log(
            `[Curation] Artist ${artistId}: ${result.releaseGroups} release groups, ` +
            `${result.monitored} monitored release decisions, ${result.redundant} redundant subsets, ` +
            `${videoUpdates} video updates.`
        );

        return { newAlbums: result.monitored, upgradedAlbums: 0 };
    }

    /**
     * Tracks are not monitored independently in the Lidarr-style model.
     * Wanted tracks are derived from the selected monitored album release.
     */
    static async cascadeToTracks(_artistId: string): Promise<void> {
        return;
    }

    private static applyVideoMonitoring(artistId: string, forceMonitor?: boolean): number {
        const curationConfig = getConfigSection("filtering");
        const shouldMonitorVideos = forceMonitor ?? curationConfig.include_videos !== false;

        const result = db.prepare(`
            UPDATE videos
            SET monitored = ?
            WHERE artist_metadata_id IN (
                SELECT artist_metadata_id
                FROM managed_artists
                WHERE CAST(id AS TEXT) = ?
                   OR CAST(artist_metadata_id AS TEXT) = ?
            )
              AND monitor_lock = 0
              AND monitored != ?
        `).run(
            shouldMonitorVideos ? 1 : 0,
            artistId,
            artistId,
            shouldMonitorVideos ? 1 : 0,
        );

        return Number(result.changes || 0);
    }

    private static unmonitorLibraryType(artistId: string, libraryType: LidarrLibraryType): number {
        const result = db.prepare(`
            UPDATE release_group_monitoring
            SET monitored = 0,
                redundancy_state = 'filtered',
                redundancy_reason = 'library_disabled'
            WHERE library_type = ?
              AND release_group_id IN (
                SELECT rg.id
                FROM release_groups rg
                LEFT JOIN managed_artists ma ON ma.artist_metadata_id = rg.artist_metadata_id
                WHERE CAST(ma.id AS TEXT) = ?
                   OR CAST(rg.artist_metadata_id AS TEXT) = ?
              )
              AND monitor_lock = 0
              AND monitored != 0
        `).run(libraryType, artistId, artistId);

        return Number(result.changes || 0);
    }
}

function mapLibraryType(libraryType: CurationLibraryRequest): LidarrLibraryType {
    if (libraryType === "atmos") {
        return "atmos";
    }

    return "stereo";
}
