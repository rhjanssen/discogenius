import { db } from "../database.js";
import { JobTypes, TaskQueueService } from "./queue.js";
import { getConfigSection } from "./config.js";
import { LibraryFilesService } from "./library-files.js";
import { lidarrMetadataService } from "./metadata/lidarr-metadata-service.js";
import { buildStreamingMediaUrl } from "./download-routing.js";

type ReleaseGroupForCuration = {
    mbid: string;
    title: string;
    primary_type?: string | null;
    secondary_types?: string | null;
};

type ReleaseGroupSlotRow = {
    id: number;
    release_group_mbid: string;
    slot: string;
    wanted: number;
    selected_provider?: string | null;
    selected_provider_id?: string | null;
    provider_data?: string | null;
};

type PreferredReleaseRecordings = {
    releaseMbid: string;
    recordingIds: Set<string>;
};

type ArtistCurationIdentity = {
    artistId: string | null;
    artistMbid: string | null;
};

export class CurationService {
    private static resolveArtistCurationIdentity(artistIdOrMbid: string): ArtistCurationIdentity {
        const input = String(artistIdOrMbid || "").trim();
        if (!input) {
            return { artistId: null, artistMbid: null };
        }

        const row = db.prepare(`
            SELECT id, mbid
            FROM Artists
            WHERE id = ? OR mbid = ?
            LIMIT 1
        `).get(input, input) as { id: string | number; mbid: string | null } | undefined;

        return {
            artistId: row?.id != null ? String(row.id) : null,
            artistMbid: row?.mbid ? String(row.mbid) : this.looksLikeMusicBrainzMbid(input) ? input : null,
        };
    }

    private static parseSecondaryTypes(value: unknown): string[] {
        try {
            const parsed = JSON.parse(String(value || "[]"));
            return Array.isArray(parsed)
                ? parsed.map((type) => String(type).trim().toLowerCase()).filter(Boolean)
                : [];
        } catch {
            return [];
        }
    }

    private static isReleaseGroupIncluded(
        releaseGroup: ReleaseGroupForCuration,
        curationConfig: Record<string, any>,
    ): boolean {
        const secondaryTypes = this.parseSecondaryTypes(releaseGroup.secondary_types);
        if (secondaryTypes.includes("compilation")) return curationConfig.include_compilation !== false;
        if (secondaryTypes.includes("soundtrack")) return curationConfig.include_soundtrack !== false;
        if (secondaryTypes.includes("live")) return curationConfig.include_live !== false;
        if (secondaryTypes.includes("remix") || secondaryTypes.includes("dj-mix")) return curationConfig.include_remix !== false;
        if (secondaryTypes.includes("demo")) return false;

        const primary = String(releaseGroup.primary_type || "album").trim().toLowerCase();
        if (primary === "single") return curationConfig.include_single !== false;
        if (primary === "ep") return curationConfig.include_ep !== false;
        return curationConfig.include_album !== false;
    }

    private static primaryType(releaseGroup: Pick<ReleaseGroupForCuration, "primary_type">): string {
        return String(releaseGroup.primary_type || "album").trim().toLowerCase();
    }

    private static isSingleOrEp(releaseGroup: ReleaseGroupForCuration): boolean {
        const primary = this.primaryType(releaseGroup);
        return primary === "single" || primary === "ep";
    }

    private static looksLikeMusicBrainzMbid(value: string): boolean {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    }

    private static hasCachedReleaseTracks(releaseGroupMbid: string): boolean {
        const row = db.prepare(`
            SELECT 1
            FROM AlbumReleases r
            JOIN Tracks t ON t.release_mbid = r.mbid
            WHERE r.release_group_mbid = ?
            LIMIT 1
        `).get(releaseGroupMbid);
        return Boolean(row);
    }

    private static async ensureReleaseGroupTrackCache(
        artistMbid: string,
        releaseGroupMbid: string,
    ): Promise<void> {
        if (
            !this.looksLikeMusicBrainzMbid(artistMbid)
            || !this.looksLikeMusicBrainzMbid(releaseGroupMbid)
            || this.hasCachedReleaseTracks(releaseGroupMbid)
        ) {
            return;
        }

        try {
            await lidarrMetadataService.syncReleaseGroup(releaseGroupMbid, artistMbid);
        } catch (error) {
            console.warn(`[Curation] Failed to hydrate release-group tracks for ${releaseGroupMbid}:`, error);
        }
    }

    private static getPreferredReleaseRecordings(releaseGroupMbid: string): PreferredReleaseRecordings | null {
        const release = db.prepare(`
            SELECT
                r.mbid,
                CASE
                  WHEN EXISTS (
                    SELECT 1 FROM AlbumReleaseMedia m
                    WHERE m.release_mbid = r.mbid
                      AND LOWER(COALESCE(m.format, '')) LIKE '%digital%'
                  ) THEN 1 ELSE 0
                END AS digital_score
            FROM AlbumReleases r
            WHERE r.release_group_mbid = ?
            ORDER BY
                digital_score DESC,
                CASE LOWER(COALESCE(r.status, '')) WHEN 'official' THEN 0 ELSE 1 END ASC,
                COALESCE(r.track_count, 0) DESC,
                (r.date IS NULL) ASC,
                r.date DESC,
                r.mbid ASC
            LIMIT 1
        `).get(releaseGroupMbid) as { mbid: string } | undefined;
        if (!release?.mbid) {
            return null;
        }

        const rows = db.prepare(`
            SELECT DISTINCT recording_mbid
            FROM Tracks
            WHERE release_mbid = ?
              AND recording_mbid IS NOT NULL
              AND recording_mbid != ''
        `).all(release.mbid) as Array<{ recording_mbid: string }>;
        const recordingIds = new Set(rows.map((row) => String(row.recording_mbid)).filter(Boolean));
        if (recordingIds.size === 0) {
            return null;
        }

        return { releaseMbid: release.mbid, recordingIds };
    }

    private static recordingOverlapRatio(candidate: Set<string>, album: Set<string>): number {
        if (candidate.size === 0 || album.size === 0) {
            return 0;
        }

        let overlap = 0;
        for (const recordingMbid of candidate) {
            if (album.has(recordingMbid)) {
                overlap++;
            }
        }

        return overlap / candidate.size;
    }

    private static async findReleaseGroupsContainedByAlbums(
        artistMbid: string,
        releaseGroups: ReleaseGroupForCuration[],
        includedReleaseGroupIds: Set<string>,
    ): Promise<Set<string>> {
        const included = releaseGroups.filter((releaseGroup) => includedReleaseGroupIds.has(releaseGroup.mbid));
        const albumReleaseGroups = included.filter((releaseGroup) =>
            !this.isSingleOrEp(releaseGroup)
        );
        const candidateReleaseGroups = included.filter((releaseGroup) =>
            this.isSingleOrEp(releaseGroup)
        );

        if (albumReleaseGroups.length === 0 || candidateReleaseGroups.length === 0) {
            return new Set();
        }

        const releaseGroupIdsToHydrate = new Set([
            ...albumReleaseGroups.map((releaseGroup) => releaseGroup.mbid),
            ...candidateReleaseGroups.map((releaseGroup) => releaseGroup.mbid),
        ]);
        for (const releaseGroupMbid of releaseGroupIdsToHydrate) {
            await this.ensureReleaseGroupTrackCache(artistMbid, releaseGroupMbid);
        }

        const albumRecordingSets = albumReleaseGroups
            .map((releaseGroup) => ({
                releaseGroup,
                preferredRelease: this.getPreferredReleaseRecordings(releaseGroup.mbid),
            }))
            .filter((entry): entry is { releaseGroup: ReleaseGroupForCuration; preferredRelease: PreferredReleaseRecordings } =>
                Boolean(entry.preferredRelease)
            );
        if (albumRecordingSets.length === 0) {
            return new Set();
        }

        const redundantReleaseGroupIds = new Set<string>();
        for (const candidate of candidateReleaseGroups) {
            const candidateRelease = this.getPreferredReleaseRecordings(candidate.mbid);
            if (!candidateRelease) {
                continue;
            }

            const isContained = albumRecordingSets.some(({ preferredRelease }) => {
                if (candidateRelease.recordingIds.size > preferredRelease.recordingIds.size) {
                    return false;
                }
                const overlapRatio = this.recordingOverlapRatio(candidateRelease.recordingIds, preferredRelease.recordingIds);
                return overlapRatio >= 0.8;
            });
            if (isContained) {
                redundantReleaseGroupIds.add(candidate.mbid);
            }
        }

        if (redundantReleaseGroupIds.size > 0) {
            console.log(
                `[Curation] Marked ${redundantReleaseGroupIds.size} EP/single release group(s) redundant by MusicBrainz recording overlap.`
            );
        }

        return redundantReleaseGroupIds;
    }

    private static async processReleaseGroupSlots(
        artistIdOrMbid: string,
    ): Promise<{ newAlbums: number; upgradedAlbums: number }> {
        const identity = this.resolveArtistCurationIdentity(artistIdOrMbid);
        const artistMbid = identity.artistMbid;

        if (!artistMbid) {
            console.log(`⚖️ [Curation] Skipping release-group slots for artist ${artistIdOrMbid}: missing MusicBrainz artist MBID.`);
            return { newAlbums: 0, upgradedAlbums: 0 };
        }

        console.log(`⚖️ [Curation] Processing MusicBrainz release-group slots for artist ${artistMbid}...`);

        const curationConfig = getConfigSection("filtering");
        const includeSpatial = curationConfig.include_spatial === true;
        const enableRedundancyFilter = curationConfig.enable_redundancy_filter !== false;
        const releaseGroups = db.prepare(`
            SELECT mbid, title, primary_type, secondary_types
            FROM Albums
            WHERE artist_mbid = ?
        `).all(artistMbid) as ReleaseGroupForCuration[];

        if (releaseGroups.length === 0) {
            console.log(`   No MusicBrainz release groups found for artist ${artistMbid}.`);
            return { newAlbums: 0, upgradedAlbums: 0 };
        }

        this.ensureReleaseGroupSlotRows(artistMbid, releaseGroups, includeSpatial);

        const includedReleaseGroupIds = new Set<string>();
        for (const releaseGroup of releaseGroups) {
            if (this.isReleaseGroupIncluded(releaseGroup, curationConfig)) {
                includedReleaseGroupIds.add(releaseGroup.mbid);
            }
        }

        const slotRows = db.prepare(`
            SELECT id, release_group_mbid, slot, wanted, selected_provider, selected_provider_id, provider_data
            FROM ReleaseGroupSlots
            WHERE artist_mbid = ?
        `).all(artistMbid) as ReleaseGroupSlotRow[];

        if (enableRedundancyFilter) {
            const redundantReleaseGroupIds = await this.findReleaseGroupsContainedByAlbums(
                artistMbid,
                releaseGroups,
                includedReleaseGroupIds,
            );
            for (const releaseGroupMbid of redundantReleaseGroupIds) {
                includedReleaseGroupIds.delete(releaseGroupMbid);
            }
        }

        const updateSlot = db.prepare(`
            UPDATE ReleaseGroupSlots
            SET wanted = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);

        let slotUpdates = 0;
        let wantedSlots = 0;
        db.transaction(() => {
            for (const slot of slotRows) {
                const slotName = String(slot.slot || "").toLowerCase();
                const wanted = includedReleaseGroupIds.has(slot.release_group_mbid)
                    && (slotName !== "spatial" || includeSpatial)
                    ? 1
                    : 0;
                if (wanted) {
                    wantedSlots++;
                }
                if (Number(slot.wanted || 0) !== wanted) {
                    updateSlot.run(wanted, slot.id);
                    slotUpdates++;
                }
            }
        })();

        // Synchronize albums and tracks monitor status based on release group slot wanted status
        let albumMonitorUpdates = 0;
        let mediaMonitorUpdates = 0;

        if (identity.artistId) {
            const artistId = identity.artistId;
            const artistAlbumRows = db.prepare(`
                SELECT DISTINCT id
                FROM ProviderAlbums
                WHERE artist_id = ?
                UNION
                SELECT DISTINCT album_id AS id
                FROM ProviderAlbumArtists
                WHERE artist_id = ?
            `).all(artistId, artistId) as Array<{ id: string | number }>;

            const wantedAlbums = db.prepare(`
                SELECT selected_provider_id
                FROM ReleaseGroupSlots
                WHERE artist_mbid = ?
                  AND wanted = 1
                  AND selected_provider_id IS NOT NULL
            `).all(artistMbid) as Array<{ selected_provider_id: string }>;
            const wantedAlbumIds = new Set(wantedAlbums.map((r) => String(r.selected_provider_id)));

            db.transaction(() => {
                const updateAlbumMonitor = db.prepare(`
                    UPDATE ProviderAlbums
                    SET monitor = ?, monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE NULL END
                    WHERE id = ? AND (monitor_lock = 0 OR monitor_lock IS NULL) AND COALESCE(monitor, 0) != ?
                `);

                const updateMediaMonitor = db.prepare(`
                    UPDATE ProviderMedia
                    SET monitor = ?, monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE NULL END
                    WHERE album_id = ? AND type != 'Music Video' AND (monitor_lock = 0 OR monitor_lock IS NULL) AND COALESCE(monitor, 0) != ?
                `);

                for (const album of artistAlbumRows) {
                    const albumId = String(album.id);
                    const wanted = wantedAlbumIds.has(albumId) ? 1 : 0;
                    const albRes = updateAlbumMonitor.run(wanted, wanted, albumId, wanted);
                    const medRes = updateMediaMonitor.run(wanted, wanted, albumId, wanted);
                    albumMonitorUpdates += albRes.changes;
                    mediaMonitorUpdates += medRes.changes;
                }
            })();
        }

        const videoWanted = curationConfig.include_videos !== false ? 1 : 0;
        const videoMonitorUpdates = identity.artistId
            ? db.prepare(`
                UPDATE ProviderMedia
                SET monitor = ?
                WHERE artist_id = ?
                  AND type = 'Music Video'
                  AND (monitor_lock = 0 OR monitor_lock IS NULL)
                  AND COALESCE(monitor, 0) != ?
            `).run(videoWanted, identity.artistId, videoWanted).changes
            : 0;

        console.log(
            `   Release groups: ${includedReleaseGroupIds.size}/${releaseGroups.length} included, ` +
            `${wantedSlots}/${slotRows.length} slots wanted, ${slotUpdates} slot updates, ` +
            `${albumMonitorUpdates} album monitor updates, ${mediaMonitorUpdates} track monitor updates, ` +
            `${videoMonitorUpdates} video monitor updates.`
        );

        return { newAlbums: slotUpdates, upgradedAlbums: 0 };
    }

    private static ensureReleaseGroupSlotRows(
        artistMbid: string,
        releaseGroups: ReleaseGroupForCuration[],
        includeSpatial: boolean,
    ): void {
        const slots = includeSpatial ? ["stereo", "spatial"] : ["stereo"];
        const insertMissingSlot = db.prepare(`
            INSERT INTO ReleaseGroupSlots (
                artist_mbid,
                release_group_mbid,
                slot,
                wanted,
                match_status,
                checked_at,
                updated_at
            )
            VALUES (?, ?, ?, 0, 'unmatched', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(release_group_mbid, slot) DO NOTHING
        `);

        db.transaction(() => {
            for (const releaseGroup of releaseGroups) {
                for (const slot of slots) {
                    insertMissingSlot.run(artistMbid, releaseGroup.mbid, slot);
                }
            }
        })();
    }

    static async queueMonitoredItems(
        artistId?: string
    ): Promise<{ albums: number; tracks: number; videos: number }> {
        console.log(`[Queue] Queueing monitored items${artistId ? ` for artist ${artistId}` : ''}...`);

        const filteringConfig = getConfigSection("filtering");
        const allowVideos = filteringConfig?.include_videos !== false;

        const hasActiveJob = (types: string[], refId: string) => {
            const placeholders = types.map(() => '?').join(', ');
            const existing = db.prepare(`
                SELECT id FROM job_queue
                WHERE type IN (${placeholders}) AND ref_id = ? AND status IN ('pending', 'processing')
            `).get(...types, refId);
            return Boolean(existing);
        };

        const hasActiveAlbumWork = (albumId: string) => {
            if (hasActiveJob([JobTypes.DownloadAlbum, JobTypes.ImportDownload], albumId)) {
                return true;
            }

            const trackWork = db.prepare(`
                SELECT 1
                FROM job_queue jq
                JOIN ProviderMedia m ON m.id = jq.ref_id
                WHERE m.album_id = ?
                  AND jq.type IN ('DownloadTrack', 'ImportDownload')
                  AND jq.status IN ('pending', 'processing')
                LIMIT 1
            `).get(albumId);

            return Boolean(trackWork);
        };

        const hasImportedVideoFile = (mediaIdColumn: string) => `
            EXISTS (
                SELECT 1
                FROM TrackFiles lf
                WHERE lf.media_id = ${mediaIdColumn}
                  AND lf.file_type = 'video'
            )
        `;

        const formatAlbumTitle = (title: string, version?: string | null) => {
            const base = title || 'Unknown Album';
            const v = (version || '').trim();
            if (!v) return base;
            if (base.toLowerCase().includes(v.toLowerCase())) return base;
            return `${base} (${v})`;
        };

        const shouldIncludeReleaseGroup = (row: {
            slot?: string | null;
            primary_type?: string | null;
            secondary_types?: string | null;
            album_type?: string | null;
        }): boolean => {
            if (String(row.slot || "").toLowerCase() === "spatial" && filteringConfig.include_spatial !== true) {
                return false;
            }

            let secondaryTypes: string[] = [];
            try {
                const parsed = JSON.parse(String(row.secondary_types || "[]"));
                secondaryTypes = Array.isArray(parsed) ? parsed.map((type) => String(type).toLowerCase()) : [];
            } catch {
                secondaryTypes = [];
            }

            if (secondaryTypes.includes("compilation")) return filteringConfig.include_compilation !== false;
            if (secondaryTypes.includes("soundtrack")) return filteringConfig.include_soundtrack !== false;
            if (secondaryTypes.includes("live")) return filteringConfig.include_live !== false;
            if (secondaryTypes.includes("remix") || secondaryTypes.includes("dj-mix")) return filteringConfig.include_remix !== false;

            const primary = String(row.primary_type || row.album_type || "album").trim().toLowerCase();
            if (primary === "single") return filteringConfig.include_single !== false;
            if (primary === "ep") return filteringConfig.include_ep !== false;
            return filteringConfig.include_album !== false;
        };

        let albumJobs = 0;
        const trackJobs = 0;
        let videoJobs = 0;
        const albumQueuedAsAlbum = new Set<string>();

        const queueAlbumDownload = (album: {
            id: string | number;
            title: string;
            version?: string | null;
            cover?: string | null;
            quality?: string | null;
            artist_name?: string | null;
            provider?: string | null;
            releaseGroupMbid?: string | null;
            slot?: string | null;
        }, artistNames: string[] = []): boolean => {
            const albumId = String(album.id);
            const slotName = String(album.slot || "album").toLowerCase();
            const releaseGroupMbid = album.releaseGroupMbid ? String(album.releaseGroupMbid) : null;
            const queueRefId = releaseGroupMbid ? `${releaseGroupMbid}:${slotName}` : albumId;
            if (
                !albumId
                || albumQueuedAsAlbum.has(queueRefId)
                || hasActiveAlbumWork(albumId)
                || hasActiveJob([JobTypes.DownloadAlbum, JobTypes.ImportDownload], queueRefId)
            ) {
                return false;
            }

            const albumTitleFull = formatAlbumTitle(album.title, album.version);
            const artistName = album.artist_name || artistNames[0] || 'Unknown';
            const provider = album.provider || "tidal";
            TaskQueueService.addJob(JobTypes.DownloadAlbum, {
                url: buildStreamingMediaUrl("album", albumId, provider as any),
                type: 'album',
                provider,
                providerId: albumId,
                releaseGroupMbid: album.releaseGroupMbid || undefined,
                albumId: album.releaseGroupMbid || undefined,
                libraryRoot: album.slot === "spatial" ? "spatial" : "music",
                slot: album.slot || undefined,
                tidalId: albumId,
                title: albumTitleFull,
                artist: artistName,
                cover: album.cover || null,
                quality: album.quality || null,
                artists: artistNames,
                description: `${albumTitleFull} by ${artistName}`,
            }, queueRefId);
            albumQueuedAsAlbum.add(queueRefId);
            albumJobs++;
            return true;
        };

        // Prefer selected MusicBrainz release-group slots when they exist. This is the
        // Discogenius extension of Lidarr's "monitored release group + selected release"
        // model: each slot resolves to a provider album ID that can be downloaded.
        const slotParams: any[] = [];
        let slotArtistWhere = "COALESCE(monitored_artist.monitor, 0) = 1";
        if (artistId) {
            slotArtistWhere = "monitored_artist.id = ?";
            slotParams.push(artistId);
        }

        const selectedSlots = db.prepare(`
            SELECT
                rgs.slot,
                rgs.release_group_mbid,
                rgs.selected_provider,
                rgs.selected_provider_id AS id,
                rgs.quality,
                rgs.provider_data,
                rg.primary_type,
                rg.secondary_types,
                rg.title,
                monitored_artist.name as artist_name
            FROM ReleaseGroupSlots rgs
            JOIN Albums rg ON rg.mbid = rgs.release_group_mbid
            JOIN Artists monitored_artist ON monitored_artist.mbid = rgs.artist_mbid
            WHERE rgs.wanted = 1
              AND rgs.selected_provider IS NOT NULL
              AND rgs.selected_provider_id IS NOT NULL
              AND ${slotArtistWhere}
            ORDER BY rg.first_release_date DESC, rg.title ASC, rgs.slot ASC
        `).all(...slotParams) as any[];

        for (const slot of selectedSlots) {
            if (!shouldIncludeReleaseGroup(slot)) {
                continue;
            }

            const albumId = String(slot.id);
            const hasImportedTracks = db.prepare(`
                SELECT 1
                FROM TrackFiles lf
                WHERE lf.album_id = ?
                  AND lf.file_type = 'track'
                LIMIT 1
            `).get(albumId);
            if (hasImportedTracks) {
                continue;
            }

            let providerData: any = null;
            try {
                providerData = slot.provider_data ? JSON.parse(String(slot.provider_data)) : null;
            } catch {
                providerData = null;
            }
            const artistNames = [slot.artist_name || providerData?.artist?.name].filter(Boolean);
            queueAlbumDownload({
                id: albumId,
                title: providerData?.title || slot.title,
                version: providerData?.version || null,
                cover: providerData?.cover || null,
                quality: slot.quality || providerData?.quality || null,
                artist_name: slot.artist_name || providerData?.artist?.name || null,
                provider: slot.selected_provider || null,
                releaseGroupMbid: slot.release_group_mbid || null,
                slot: slot.slot || null,
            }, artistNames);
        }

        // Videos are still provider-discovered, but they are queued separately from
        // MusicBrainz release-group slots because MusicBrainz video relationships are
        // incomplete and provider video IDs remain the actionable download resource.
        if (allowVideos) {
            let videosQuery = `
                SELECT
                    m.id as video_id,
                    m.title as video_title,
                    m.quality as video_quality,
                    m.artist_id as artist_id,
                    ar.name as artist_name,
                    a.cover as album_cover
                FROM ProviderMedia m
                LEFT JOIN Artists ar ON ar.id = m.artist_id
                LEFT JOIN ProviderAlbums a ON a.id = m.album_id
                WHERE m.type = 'Music Video'
                  AND m.monitor = 1
                  AND NOT ${hasImportedVideoFile('m.id')}
            `;
            const videoParams: any[] = [];
            if (artistId) {
                videosQuery += " AND m.artist_id = ?";
                videoParams.push(artistId);
            }

            const videos = db.prepare(videosQuery).all(...videoParams) as any[];
            for (const video of videos) {
                const videoId = String(video.video_id);
                if (!videoId) continue;
                if (hasActiveJob([JobTypes.DownloadVideo, JobTypes.ImportDownload], videoId)) continue;

                const artistName = video.artist_name || 'Unknown';
                const title = video.video_title || 'Unknown Video';

                TaskQueueService.addJob(JobTypes.DownloadVideo, {
                    url: buildStreamingMediaUrl("video", videoId),
                    type: 'video',
                    provider: "tidal",
                    providerId: videoId,
                    tidalId: videoId,
                    title,
                    artist: artistName,
                    cover: video.album_cover || null,
                    quality: video.video_quality || null,
                    artists: [artistName],
                    description: `${title} by ${artistName}`,
                }, videoId);
                videoJobs++;
            }
        }

        console.log(`[Queue] Ensured queue has ${albumJobs} albums, ${trackJobs} tracks, ${videoJobs} videos.`);
        return { albums: albumJobs, tracks: trackJobs, videos: videoJobs };
    }

    /**
     * Process release-group slot curation based on config.
     * Spatial audio is handled by separate release-group slots.
     * 
     * @param artistId - Local artist ID to process. MusicBrainz MBID input is tolerated for direct/test callers.
     * @param options.skipDownloadQueue - If true, apply curation only and do not queue downloads
     */
    static async processAll(
        artistId: string,
        options: { skipDownloadQueue?: boolean; forceDownloadQueue?: boolean } = {}
    ): Promise<{ newAlbums: number; upgradedAlbums: number }> {
        const monitoringConfig = getConfigSection("monitoring");
        const identity = this.resolveArtistCurationIdentity(artistId);

        const result = await this.processReleaseGroupSlots(artistId);
        const cleanupArtistId = identity.artistId ?? (this.looksLikeMusicBrainzMbid(artistId) ? null : artistId);

        if (cleanupArtistId && monitoringConfig.remove_unmonitored_files === true) {
            const cleanup = LibraryFilesService.pruneUnmonitoredFiles(cleanupArtistId);
            if (cleanup.deleted > 0 || cleanup.missing > 0 || cleanup.errors > 0) {
                console.log(`[TrackFiles] Cleanup for artist ${cleanupArtistId}: ${cleanup.deleted} deleted, ${cleanup.missing} missing, ${cleanup.errors} errors.`);
            }
        }

        // Always prune metadata files whose type was disabled in config
        // (independent of remove_unmonitored_files — this is about settings, not monitoring)
        if (cleanupArtistId) {
            const metaCleanup = LibraryFilesService.pruneDisabledMetadataFiles(cleanupArtistId);
            if (metaCleanup.deleted > 0 || metaCleanup.missing > 0 || metaCleanup.errors > 0) {
                console.log(`[TrackFiles] Disabled metadata cleanup for artist ${cleanupArtistId}: ${metaCleanup.deleted} deleted, ${metaCleanup.missing} missing, ${metaCleanup.errors} errors.`);
            }
        }

        // Intentionally avoid a full empty-directory sweep per artist here.
        // Prune methods already perform targeted parent cleanup, and repeated full-tree scans
        // can block API responsiveness when curation backlogs process many artists.

        if (options.skipDownloadQueue !== undefined || options.forceDownloadQueue !== undefined) {
            console.log(
                `[Queue] Ignoring curation auto-queue flags for artist ${artistId}; ` +
                `DownloadMissing remains the dedicated queueing path.`
            );
        }

        return result;
    }

}
