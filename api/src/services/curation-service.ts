import { db } from "../database.js";
import { JobTypes, TaskQueueService } from "./queue.js";
import { getConfigSection, type FilteringConfig } from "./config.js";
import { LibraryFilesService } from "./library-files.js";
import { buildStreamingMediaUrl } from "./download-routing.js";
import { isMusicBrainzReleaseGroupIncluded, parseMusicBrainzSecondaryTypes } from "./musicbrainz-release-group-filter.js";
import { MusicBrainzReleaseSelectionService } from "./musicbrainz-release-selection-service.js";

type ReleaseGroupForCuration = {
    mbid: string;
    artist_mbid: string;
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
    selected_release_mbid?: string | null;
    provider_data?: string | null;
};

type CurationTrack = {
    recordingMbid: string | null;
    normalizedTitle: string;
};

type PreferredReleaseRecordings = {
    releaseMbid: string;
    tracks: CurationTrack[];
    recordingIds: Set<string>;
    normalizedTitles: Set<string>;
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

    private static isReleaseGroupIncluded(
        releaseGroup: ReleaseGroupForCuration,
        curationConfig: FilteringConfig,
    ): boolean {
        return isMusicBrainzReleaseGroupIncluded(releaseGroup, curationConfig);
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

    private static normalizeTrackTitle(title: string): string {
        return String(title || "")
            .toLowerCase()
            .replace(/[.,/#!$%^&*;:{}=\-_`~()?'"’…]/g, "")
            .replace(/\s+/g, "")
            .trim();
    }

    private static getPreferredReleaseRecordings(
        releaseGroupMbid: string,
        representativeReleaseMbid?: string | null,
        restrictToRepresentative = false,
    ): PreferredReleaseRecordings | null {
        const mapTracks = (releaseMbid: string): PreferredReleaseRecordings | null => {
            const rows = db.prepare(`
                SELECT recording_mbid, title
                FROM Tracks
                WHERE release_mbid = ?
            `).all(releaseMbid) as Array<{ recording_mbid: string | null; title: string | null }>;

            if (rows.length === 0) {
                return null;
            }

            const tracks: CurationTrack[] = [];
            const recordingIds = new Set<string>();
            const normalizedTitles = new Set<string>();

            for (const row of rows) {
                const title = String(row.title || "").trim();
                const normTitle = this.normalizeTrackTitle(title);
                const recId = row.recording_mbid ? String(row.recording_mbid).trim() : null;

                tracks.push({
                    recordingMbid: recId && this.looksLikeMusicBrainzMbid(recId) ? recId : null,
                    normalizedTitle: normTitle,
                });

                if (recId && this.looksLikeMusicBrainzMbid(recId)) {
                    recordingIds.add(recId);
                }
                if (normTitle) {
                    normalizedTitles.add(normTitle);
                }
            }

            if (tracks.length > 0) {
                return { releaseMbid, tracks, recordingIds, normalizedTitles };
            }
            return null;
        };

        if (restrictToRepresentative && !representativeReleaseMbid) {
            return null;
        }

        const release = representativeReleaseMbid
            ? { mbid: representativeReleaseMbid }
            : MusicBrainzReleaseSelectionService.selectRepresentativeRelease(releaseGroupMbid);

        if (release?.mbid) {
            const mapped = mapTracks(release.mbid);
            if (mapped) {
                return mapped;
            }
        }

        if (restrictToRepresentative) {
            return null;
        }

        const fallbackRelease = db.prepare(`
            SELECT r.mbid, COUNT(t.mbid) as track_count
            FROM AlbumReleases r
            JOIN Tracks t ON t.release_mbid = r.mbid
            WHERE r.release_group_mbid = ?
            GROUP BY r.mbid
            ORDER BY track_count DESC
            LIMIT 1
        `).get(releaseGroupMbid) as { mbid: string } | undefined;

        if (fallbackRelease?.mbid) {
            const mapped = mapTracks(fallbackRelease.mbid);
            if (mapped) {
                return mapped;
            }
        }

        return null;
    }

    private static getReleaseGroupPriority(rg: ReleaseGroupForCuration): number {
        const primary = String(rg.primary_type || "album").trim().toLowerCase();
        let score = 0;

        if (primary === "album") {
            score += 100;
        } else if (primary === "ep") {
            score += 80;
        } else if (primary === "single") {
            score += 60;
        } else if (primary === "broadcast") {
            score += 40;
        } else {
            score += 20;
        }

        const secondary = parseMusicBrainzSecondaryTypes(rg.secondary_types);
        if (secondary.includes("compilation")) {
            score -= 10;
        }
        if (secondary.includes("live")) {
            score -= 5;
        }
        if (secondary.includes("remix")) {
            score -= 5;
        }
        if (secondary.includes("soundtrack")) {
            score -= 5;
        }

        return score;
    }

    private static async findReleaseGroupsContainedByAlbums(
        releaseGroups: ReleaseGroupForCuration[],
        includedReleaseGroupIds: Set<string>,
        representativeReleaseMbids?: Map<string, string>,
        restrictToRepresentatives = false,
    ): Promise<Set<string>> {
        const included = releaseGroups.filter((releaseGroup) => includedReleaseGroupIds.has(releaseGroup.mbid));
        if (included.length === 0) {
            return new Set();
        }

        const hydratedGroups = included
            .map((releaseGroup) => ({
                releaseGroup,
                preferredRelease: this.getPreferredReleaseRecordings(
                    releaseGroup.mbid,
                    representativeReleaseMbids?.get(releaseGroup.mbid),
                    restrictToRepresentatives,
                ),
            }))
            .filter((entry): entry is { releaseGroup: ReleaseGroupForCuration; preferredRelease: PreferredReleaseRecordings } =>
                Boolean(entry.preferredRelease)
            );

        if (hydratedGroups.length === 0) {
            return new Set();
        }

        // Sort all release groups:
        // 1. By track count descending (larger groups first)
        // 2. By custom type priority descending to break ties (Album > EP > Single > Broadcast > Other)
        // 3. By MusicBrainz ID comparison for stable sorting
        hydratedGroups.sort((a, b) => {
            const sizeA = a.preferredRelease.tracks.length;
            const sizeB = b.preferredRelease.tracks.length;
            if (sizeB !== sizeA) {
                return sizeB - sizeA;
            }

            const priorityA = this.getReleaseGroupPriority(a.releaseGroup);
            const priorityB = this.getReleaseGroupPriority(b.releaseGroup);
            if (priorityB !== priorityA) {
                return priorityB - priorityA;
            }

            return a.releaseGroup.mbid.localeCompare(b.releaseGroup.mbid);
        });

        const retainedGroups: Array<{ releaseGroup: ReleaseGroupForCuration; preferredRelease: PreferredReleaseRecordings }> = [];
        const redundantReleaseGroupIds = new Set<string>();

        for (const entry of hydratedGroups) {
            const isContained = retainedGroups.some(({ releaseGroup, preferredRelease }) => {
                if (entry.preferredRelease.tracks.length > preferredRelease.tracks.length) {
                    return false;
                }

                // Check containment: for every track in entry, we must find a match in preferredRelease
                // either by recording ID or by normalized title.
                let overlap = 0;
                for (const track of entry.preferredRelease.tracks) {
                    const hasMatch = (track.recordingMbid && preferredRelease.recordingIds.has(track.recordingMbid))
                        || (track.normalizedTitle && preferredRelease.normalizedTitles.has(track.normalizedTitle));
                    if (hasMatch) {
                        overlap++;
                    }
                }
                return overlap === entry.preferredRelease.tracks.length;
            });

            if (isContained) {
                redundantReleaseGroupIds.add(entry.releaseGroup.mbid);
            } else {
                retainedGroups.push(entry);
            }
        }

        if (redundantReleaseGroupIds.size > 0) {
            console.log(
                `[Curation] Marked ${redundantReleaseGroupIds.size} release group(s) redundant by MusicBrainz recording/title overlap.`
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
            SELECT DISTINCT rg.mbid, rg.artist_mbid, rg.title, rg.primary_type, rg.secondary_types
            FROM Albums rg
            LEFT JOIN ArtistReleaseGroups scope ON scope.release_group_mbid = rg.mbid
            WHERE rg.artist_mbid = ? OR scope.artist_mbid = ?
        `).all(artistMbid, artistMbid) as ReleaseGroupForCuration[];

        if (releaseGroups.length === 0) {
            console.log(`   No MusicBrainz release groups found for artist ${artistMbid}.`);
            return { newAlbums: 0, upgradedAlbums: 0 };
        }

        this.ensureReleaseGroupSlotRows(releaseGroups);

        const releaseGroupMbids = releaseGroups.map((releaseGroup) => releaseGroup.mbid);
        const slotRows = db.prepare(`
            SELECT id, release_group_mbid, slot, wanted, selected_provider, selected_provider_id, selected_release_mbid, provider_data
            FROM ReleaseGroupSlots
            WHERE release_group_mbid IN (${releaseGroupMbids.map(() => "?").join(",")})
        `).all(...releaseGroupMbids) as ReleaseGroupSlotRow[];

        // 1. Identify which release groups are included based on MusicBrainz filters alone (metadata-only curation)
        const includedReleaseGroupIds = new Set<string>();
        for (const releaseGroup of releaseGroups) {
            if (this.isReleaseGroupIncluded(releaseGroup, curationConfig)) {
                includedReleaseGroupIds.add(releaseGroup.mbid);
            }
        }

        const requireProvider = curationConfig.require_provider_availability === true;
        const representativeReleaseMbids = new Map<string, string>();

        if (requireProvider) {
            const providerAvailableReleaseGroupIds = new Set<string>();
            for (const slot of slotRows) {
                if (!slot.selected_provider_id) {
                    continue;
                }
                providerAvailableReleaseGroupIds.add(slot.release_group_mbid);
                if (slot.selected_release_mbid && !representativeReleaseMbids.has(slot.release_group_mbid)) {
                    representativeReleaseMbids.set(slot.release_group_mbid, slot.selected_release_mbid);
                }
            }

            for (const releaseGroupMbid of includedReleaseGroupIds) {
                if (!providerAvailableReleaseGroupIds.has(releaseGroupMbid)) {
                    includedReleaseGroupIds.delete(releaseGroupMbid);
                }
            }
        }

        // 2. Compare the already-selected representatives across release groups.
        if (enableRedundancyFilter) {
            const redundantReleaseGroupIds = await this.findReleaseGroupsContainedByAlbums(
                releaseGroups,
                includedReleaseGroupIds,
                representativeReleaseMbids,
                requireProvider,
            );
            for (const releaseGroupMbid of redundantReleaseGroupIds) {
                includedReleaseGroupIds.delete(releaseGroupMbid);
            }
        }

        const upsertContext = db.prepare(`
            INSERT INTO ArtistReleaseGroupCuration (
                source_artist_mbid, release_group_mbid, included, reason, updated_at
            )
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(source_artist_mbid, release_group_mbid) DO UPDATE SET
                included = excluded.included,
                reason = excluded.reason,
                updated_at = CURRENT_TIMESTAMP
        `);
        const updateSlot = db.prepare(`
            UPDATE ReleaseGroupSlots
            SET wanted = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);

        let slotUpdates = 0;
        let wantedSlots = 0;
        db.transaction(() => {
            for (const releaseGroup of releaseGroups) {
                const included = includedReleaseGroupIds.has(releaseGroup.mbid);
                upsertContext.run(artistMbid, releaseGroup.mbid, included ? 1 : 0, included ? "included" : "filtered-or-redundant");
            }

            for (const slot of slotRows) {
                const slotName = String(slot.slot || "").toLowerCase();
                const hasProvider = slot.selected_provider_id != null && slot.selected_provider_id !== "";
                const monitoredContext = db.prepare(`
                    SELECT 1
                    FROM ArtistReleaseGroupCuration context
                    JOIN Artists artist ON artist.mbid = context.source_artist_mbid
                    WHERE context.release_group_mbid = ?
                      AND context.included = 1
                      AND artist.monitor = 1
                    LIMIT 1
                `).get(slot.release_group_mbid);
                const wanted = Boolean(monitoredContext)
                    && (slotName !== "spatial" || includeSpatial)
                    && (!requireProvider || hasProvider)
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
                SELECT DISTINCT slot.selected_provider_id
                FROM ReleaseGroupSlots slot
                JOIN ArtistReleaseGroupCuration context
                  ON context.release_group_mbid = slot.release_group_mbid
                WHERE context.source_artist_mbid = ?
                  AND slot.wanted = 1
                  AND slot.selected_provider_id IS NOT NULL
            `).all(artistMbid) as Array<{ selected_provider_id: string }>;
            const wantedAlbumIds = new Set(
                wantedAlbums.flatMap((r) => String(r.selected_provider_id || "").split(";").filter(Boolean))
            );

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
        releaseGroups: ReleaseGroupForCuration[],
    ): void {
        const slots = ["stereo", "spatial"];
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
                        insertMissingSlot.run(releaseGroup.artist_mbid, releaseGroup.mbid, slot);
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
            const albumIds = (albumId || "").split(";").filter(Boolean);
            if (albumIds.length === 0) return false;

            for (const id of albumIds) {
                if (hasActiveJob([JobTypes.DownloadAlbum, JobTypes.ImportDownload], id)) {
                    return true;
                }
            }

            const placeholders = albumIds.map(() => '?').join(', ');
            const trackWork = db.prepare(`
                SELECT 1
                FROM job_queue jq
                JOIN ProviderMedia m ON m.id = jq.ref_id
                WHERE m.album_id IN (${placeholders})
                  AND jq.type IN ('DownloadTrack', 'ImportDownload')
                  AND jq.status IN ('pending', 'processing')
                LIMIT 1
            `).get(...albumIds);

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
        }): boolean => isMusicBrainzReleaseGroupIncluded(row, filteringConfig);

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
                rgs.selected_release_mbid,
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
            const albumIds = albumId.split(";").filter(Boolean);
            
            // Check if all target tracks of the preferred release are imported.
            // First find the preferred release MBID for this release group
            const preferredReleaseRow = slot.selected_release_mbid
                ? { mbid: String(slot.selected_release_mbid) }
                : MusicBrainzReleaseSelectionService.selectRepresentativeRelease(slot.release_group_mbid);

            let allTracksImported = false;
            if (preferredReleaseRow) {
                const targetTracks = db.prepare(`
                    SELECT t.mbid as track_mbid, t.recording_mbid
                    FROM Tracks t
                    WHERE t.release_mbid = ?
                `).all(preferredReleaseRow.mbid) as Array<{ track_mbid: string; recording_mbid: string | null }>;

                if (targetTracks.length > 0) {
                    let importedCount = 0;
                    for (const track of targetTracks) {
                        const fileExists = db.prepare(`
                            SELECT 1 FROM TrackFiles
                            WHERE (canonical_track_mbid = ? OR (canonical_recording_mbid = ? AND canonical_recording_mbid IS NOT NULL))
                              AND file_type = 'track'
                            LIMIT 1
                        `).get(track.track_mbid, track.recording_mbid);
                        if (fileExists) {
                            importedCount++;
                        }
                    }
                    if (importedCount === targetTracks.length) {
                        allTracksImported = true;
                    }
                }
            } else {
                // Fallback to basic has-any-imported check if no preferred release exists
                if (albumIds.length > 0) {
                    const placeholders = albumIds.map(() => '?').join(', ');
                    allTracksImported = Boolean(db.prepare(`
                        SELECT 1
                        FROM TrackFiles lf
                        WHERE lf.album_id IN (${placeholders})
                          AND lf.file_type = 'track'
                        LIMIT 1
                    `).get(...albumIds));
                }
            }

            if (allTracksImported) {
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
