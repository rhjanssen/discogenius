import { db, runChunkedWrite } from "../../database.js";
import {CommandNames} from "../commands/command-names.js";
import {CommandQueueManager} from "../commands/command-queue-manager.js";
import { getConfigSection, type FilteringConfig } from "../config/config.js";
import { LibraryFilesService, resolvePlexVideoSuffix } from "../mediafiles/library-files.js";
import { buildStreamingMediaUrl } from "../download/download-routing.js";
import { isMusicBrainzReleaseGroupIncluded, parseMusicBrainzSecondaryTypes } from "../metadata/musicbrainz-release-group-filter.js";
import { MusicBrainzReleaseSelectionService } from "../metadata/musicbrainz-release-selection-service.js";
import { RefreshArtistService } from "./refresh-artist-service.js";
import { selectFewestReleaseGroupsForCoverage } from "./artist-coverage-optimizer.js";

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
    monitored: number;
    selected_provider?: string | null;
    selected_provider_id?: string | null;
    selected_release_mbid?: string | null;

    monitored_lock?: number | null;
};

type CurationTrack = {
    recordingMbid: string;
};

type PreferredReleaseRecordings = {
    releaseMbid: string;
    tracks: CurationTrack[];
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

            for (const row of rows) {
                const recId = row.recording_mbid ? String(row.recording_mbid).trim() : null;

                if (recId && this.looksLikeMusicBrainzMbid(recId)) {
                    tracks.push({ recordingMbid: recId });
                    recordingIds.add(recId);
                }
            }

            if (tracks.length > 0) {
                return { releaseMbid, tracks, recordingIds };
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

        const providerAlbumCounts = new Map<string, number>();
        const slotRows = db.prepare(`
            SELECT release_group_mbid, selected_provider_id
            FROM ReleaseGroupSlots
            WHERE slot = 'stereo'
              AND selected_provider_id IS NOT NULL
              AND TRIM(selected_provider_id) != ''
        `).all() as Array<{ release_group_mbid: string; selected_provider_id: string }>;
        for (const row of slotRows) {
            const count = String(row.selected_provider_id)
                .split(";")
                .map((part) => part.trim())
                .filter(Boolean).length;
            providerAlbumCounts.set(row.release_group_mbid, Math.max(1, count));
        }

        // Artist-wide fewest-releases cover: retain the minimal set of release
        // groups that still cover every filtered recording, preferring fewer
        // provider downloads and stronger release types on ties.
        const retainedMbids = selectFewestReleaseGroupsForCoverage(
            hydratedGroups.map(({ releaseGroup, preferredRelease }) => ({
                mbid: releaseGroup.mbid,
                recordingIds: preferredRelease.recordingIds,
                providerAlbumCount: providerAlbumCounts.get(releaseGroup.mbid) ?? 1,
                typePriority: this.getReleaseGroupPriority(releaseGroup),
            })),
        );

        const redundantReleaseGroupIds = new Set<string>();
        for (const { releaseGroup } of hydratedGroups) {
            if (!retainedMbids.has(releaseGroup.mbid)) {
                redundantReleaseGroupIds.add(releaseGroup.mbid);
            }
        }

        if (redundantReleaseGroupIds.size > 0) {
            console.log(
                `[Curation] Marked ${redundantReleaseGroupIds.size} release group(s) redundant by fewest-releases recording coverage.`
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
            const videoMonitorUpdates = this.updateCanonicalVideoMonitoring(artistMbid, curationConfig);
            console.log(`   No MusicBrainz release groups found for artist ${artistMbid}.`);
            if (videoMonitorUpdates > 0) {
                console.log(`   Updated ${videoMonitorUpdates} canonical video monitor state(s).`);
            }
            return { newAlbums: 0, upgradedAlbums: 0 };
        }

        this.ensureReleaseGroupSlotRows(releaseGroups);
        RefreshArtistService.syncProviderSelectionsFromStoredOffers(artistMbid);

        const releaseGroupMbids = releaseGroups.map((releaseGroup) => releaseGroup.mbid);
        const slotRows = db.prepare(`
            SELECT id, release_group_mbid, slot, monitored, selected_provider, selected_provider_id, selected_release_mbid, monitored_lock
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
            SET monitored = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);

        let slotUpdates = 0;
        let monitoredSlots = 0;

        // 1. Persist the curation context (included/reason) for each release group,
        //    chunked so the write lock isn't held for the whole artist at once.
        runChunkedWrite(releaseGroups, (releaseGroup) => {
            const included = includedReleaseGroupIds.has(releaseGroup.mbid);
            upsertContext.run(artistMbid, releaseGroup.mbid, included ? 1 : 0, included ? "included" : "filtered-or-redundant");
        });

        // 2. Resolve which release groups are monitored (included by any monitored
        //    source artist) with ONE read pass per chunk — never a JOIN-per-slot
        //    inside a write transaction (that held the lock for minutes on large
        //    libraries). Reads run outside any write section.
        const monitoredReleaseGroups = new Set<string>();
        const relevantReleaseGroupMbids = [...new Set(slotRows.map((slot) => slot.release_group_mbid))];
        for (let start = 0; start < relevantReleaseGroupMbids.length; start += 500) {
            const chunk = relevantReleaseGroupMbids.slice(start, start + 500);
            const placeholders = chunk.map(() => "?").join(", ");
            const rows = db.prepare(`
                SELECT DISTINCT context.release_group_mbid AS mbid
                FROM ArtistReleaseGroupCuration context
                JOIN Artists artist ON artist.mbid = context.source_artist_mbid
                WHERE context.included = 1
                  AND artist.monitored = 1
                  AND context.release_group_mbid IN (${placeholders})
            `).all(...chunk) as Array<{ mbid: string }>;
            for (const row of rows) {
                monitoredReleaseGroups.add(row.mbid);
            }
        }

        // 3. Compute slot monitor decisions in memory.
        const slotUpdatesToApply: Array<{ id: number; monitored: number }> = [];
        for (const slot of slotRows) {
            if (Number(slot.monitored_lock || 0) === 1) {
                if (Number(slot.monitored || 0) === 1) {
                    monitoredSlots++;
                }
                continue;
            }
            const slotName = String(slot.slot || "").toLowerCase();
            const hasProvider = slot.selected_provider_id != null && slot.selected_provider_id !== "";
            const monitoredVal = monitoredReleaseGroups.has(slot.release_group_mbid)
                && (slotName !== "spatial" || includeSpatial)
                && (!requireProvider || hasProvider)
                ? 1
                : 0;

            if (monitoredVal) {
                monitoredSlots++;
            }
            if (Number(slot.monitored || 0) !== monitoredVal) {
                slotUpdatesToApply.push({ id: slot.id, monitored: monitoredVal });
                slotUpdates++;
            }
        }

        // 4. Apply the slot updates in chunked writes.
        runChunkedWrite(slotUpdatesToApply, (update) => {
            updateSlot.run(update.monitored, update.id);
        });

        const videoMonitorUpdates = this.updateCanonicalVideoMonitoring(artistMbid, curationConfig);

        console.log(
            `   Release groups: ${includedReleaseGroupIds.size}/${releaseGroups.length} included, ` +
            `${monitoredSlots}/${slotRows.length} slots monitored, ${slotUpdates} slot updates, ` +
            `${videoMonitorUpdates} canonical video monitor updates.`
        );

        return { newAlbums: slotUpdates, upgradedAlbums: 0 };
    }

    private static updateCanonicalVideoMonitoring(
        artistMbid: string,
        curationConfig: FilteringConfig,
    ): number {
        const includeVideos = curationConfig.include_videos !== false;
        const requireProvider = curationConfig.require_provider_availability === true;
        const providerAvailableExpression = `EXISTS (
            SELECT 1
            FROM ProviderItems provider_item
            WHERE provider_item.entity_type = 'video'
              AND provider_item.artist_mbid = Recordings.artist_mbid
              AND (
                (Recordings.mbid IS NOT NULL AND provider_item.recording_mbid = Recordings.mbid)
                OR (Recordings.id IS NOT NULL AND provider_item.recording_id = Recordings.id)
              )
        )`;
        const targetMonitoredExpression = !includeVideos
            ? "0"
            : requireProvider
                ? `CASE WHEN ${providerAvailableExpression} THEN 1 ELSE 0 END`
                : "1";
        return db.prepare(`
            UPDATE Recordings
            SET monitored = ${targetMonitoredExpression},
                monitored_at = CASE
                  WHEN ${targetMonitoredExpression} = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP)
                  ELSE monitored_at
                END
            WHERE is_video = 1
              AND artist_mbid = ?
              AND (monitored_lock = 0 OR monitored_lock IS NULL)
              AND COALESCE(monitored, 0) != ${targetMonitoredExpression}
        `).run(artistMbid).changes;
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
                monitored,
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
