import type Database from "better-sqlite3";
import { db } from "../../database.js";
import { Config } from "../config/config.js";
import {CommandNames} from "../commands/command-names.js";
import { type DownloadTrackOffer, type DownloadAlbumCommand, type DownloadTrackCommand } from "../commands/command-bodies.js";
import { updateAlbumDownloadStatus } from "../download/download-state.js";
import { downloadProcessor } from "../download/download-processor.js";
import { DownloadWaitQueue, isSpatialQualityOrOffer } from "../download/download-wait-queue.js";
import { buildStreamingMediaUrl } from "../download/download-routing.js";
import { normalizeAudioQualityTag } from "../config/quality.js";
import { UpgradableSpecification, type QualityChangeEvaluation } from "../config/upgradable-specification.js";
import { conformExistingTrackFile } from "./library-quality-conform.js";
import { readIntEnv } from "../../utils/env.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";
import { acquisitionProfileSlot, buildAcquisitionDownloadCommand, type AcquisitionDownloadCommand } from "../music/acquisition-download-command.js";

export type UpgradeDetail = {
    mediaId: string;
    type: string;
    reason: string;
    provider: string;
    albumId: string | null;
    action?: "upgrade" | "downconvert";
    fileId?: number;
    slot?: "stereo" | "spatial" | "video";
    libraryId?: number | null;
    acquisitionPlanId?: number | null;
    libraryRoot?: string | null;
    fileProvider?: string | null;
    fileReleaseId?: string | null;
    trackId?: number | null;
};

export type UpgradeResult = {
    tracks: number;
    videos: number;
    albums: number;
    details: UpgradeDetail[];
};

type UpgradeCandidateRow = {
    file_id: number;
    file_type: "track" | "video";
    file_provider: string | null;
    file_provider_entity_type: string | null;
    file_provider_id: string | null;
    file_provider_item_id: number | null;
    track_id: number | null;
    recording_id: number | null;
    album_edition_id: number | null;
    release_group_id: number | null;
    artist_metadata_id: number | null;
    canonical_track_mbid: string | null;
    canonical_recording_mbid: string | null;
    canonical_release_mbid: string | null;
    current_quality: string | null;
    current_codec: string | null;
    current_extension: string | null;
    current_bit_depth: number | null;
    current_bitrate: number | null;
    current_sample_rate: number | null;
    file_path: string | null;
    relative_path: string | null;
    library_root: string | null;
    filename: string | null;
    library_slot: string | null;
    library_id: number | null;
    expected_path: string | null;
};

type AlbumUpgradeTarget = {
    provider: string;
    albumId: string;
    slot: "stereo" | "spatial";
    libraryId: number | null;
    acquisitionPlanId: number | null;
    libraryRoot: string | null;
};

type UpgradeDestination = {
    slot: "stereo" | "spatial" | "video" | null;
    libraryId: number | null;
    acquisitionPlanId: number | null;
    libraryRoot: string | null;
};

type WinningAlbumPlan = {
    planId: number | null;
    provider: string;
    albumId: string | null;
    providerEditionItemId: number | null;
    downloadMode: "album" | "tracks";
};

type WinningTrackItem = {
    provider_item_id: number;
    provider: string;
    provider_track_id: string;
};

type AudioVariantOffer = {
    id: number;
    quality_class: string;
    provider_quality_label: string | null;
    spatial_format: string | null;
    bit_depth: number | null;
    sample_rate: number | null;
    effective_quality: string | null;
};

type UpgradeContext = {
    selectVideoLibrary: Database.Statement;
    selectLibraryById: Database.Statement;
    selectLibraryByRoot: Database.Statement;
    selectSpatialLibrary: Database.Statement;
    selectStereoLibrary: Database.Statement;
    selectPlanByEdition: Database.Statement;
    selectPlanByTrack: Database.Statement;

    selectTrackCatalog: Database.Statement;
    selectTrackByMbid: Database.Statement;
    selectEditionByMbid: Database.Statement;
    selectRecordingByMbid: Database.Statement;

    selectSelectedPlan: Database.Statement;
    selectReleaseByMemberItemId: Database.Statement;
    selectReleaseByTrackProviderId: Database.Statement;
    selectReleaseByProviderId: Database.Statement;

    selectPlanTrackItem: Database.Statement;
    selectReleaseMemberTrackItem: Database.Statement;
    selectReleaseMemberDirect: Database.Statement;
    selectReleaseMemberTrackItemByProviderId: Database.Statement;

    selectVideoTrackItem: Database.Statement;
    selectVideoItemByIdOrProviderId: Database.Statement;

    selectTrackVariants: Database.Statement;
    selectAlbumStereoFallback: Database.Statement;

    countProviderAlbumTracksStmt: Database.Statement;
    selectWaitingQueueStmt: Database.Statement;
    selectRecentCommandsStmt: Database.Statement;
};

function resolveUpgradeDestination(
    row: UpgradeCandidateRow,
    context: UpgradeContext,
): UpgradeDestination {
    if (row.file_type === "video") {
        const videoLib = context.selectVideoLibrary.get() as { id: number; root_path: string } | undefined;
        return {
            slot: "video",
            libraryId: row.library_id ?? videoLib?.id ?? null,
            acquisitionPlanId: null,
            libraryRoot: row.library_root ?? videoLib?.root_path ?? null,
        };
    }

    let slot: "stereo" | "spatial" | null = null;
    let libraryId: number | null = null;
    let libraryRoot: string | null = null;

    if (row.library_id != null && Number.isInteger(row.library_id) && row.library_id > 0) {
        const rowLib = context.selectLibraryById.get(row.library_id) as {
            library_id: number;
            root_path: string;
            allowed_source_formats: string;
        } | undefined;
        if (rowLib) {
            const targetSlot = acquisitionProfileSlot(rowLib.allowed_source_formats);
            if (targetSlot) {
                slot = targetSlot;
                libraryId = rowLib.library_id;
                libraryRoot = rowLib.root_path;
            }
        }
    }

    if (!slot) {
        const normalizedSlot = String(row.library_slot || "").trim().toLowerCase();
        if (normalizedSlot === "stereo" || normalizedSlot === "spatial") {
            slot = normalizedSlot;
        } else if (row.library_root) {
            const rootLib = context.selectLibraryByRoot.get(row.library_root) as {
                id: number;
                root_path: string;
                allowed_source_formats: string;
            } | undefined;
            if (rootLib) {
                slot = acquisitionProfileSlot(rootLib.allowed_source_formats);
                libraryId = rootLib.id;
                libraryRoot = rootLib.root_path;
            }
        }
    }

    if (slot && !libraryId) {
        const libRow = (slot === "spatial"
            ? context.selectSpatialLibrary.get()
            : context.selectStereoLibrary.get()) as { id: number; root_path: string } | undefined;
        if (libRow) {
            libraryId = libRow.id;
            libraryRoot = libraryRoot ?? libRow.root_path;
        }
    }

    let acquisitionPlanId: number | null = null;
    if (libraryId != null) {
        if (row.album_edition_id != null) {
            const planRow = context.selectPlanByEdition.get(libraryId, row.album_edition_id) as { id: number } | undefined;
            acquisitionPlanId = planRow?.id ?? null;
        }
        if (acquisitionPlanId == null && row.track_id != null) {
            const planRow = context.selectPlanByTrack.get(row.track_id, libraryId) as { id: number } | undefined;
            acquisitionPlanId = planRow?.id ?? null;
        }
    }

    return {
        slot,
        libraryId,
        acquisitionPlanId,
        libraryRoot: libraryRoot ?? row.library_root ?? null,
    };
}

const UPGRADE_HISTORY_COOLDOWN_HOURS = 24;
const UPGRADE_SCAN_PAGE_SIZE = 2000;

export type CheckUpgradesOptions = {
    /** Cap on queue units (album downloads, track/video downloads, in-place
     * conversions) for one run. Unset = unlimited (manual full check). */
    maxUnits?: number;
};

/**
 * Source quality for the upgrade decision: what the provider really delivered
 * when we have measured it (delivered_quality_class), otherwise what it
 * advertises. A HIRES-labelled TIDAL track that streams 16/44.1 is therefore
 * not re-downloaded again and again.
 */
const EFFECTIVE_SOURCE_TAG_SQL = `COALESCE(
                      CASE variant.delivered_quality_class
                        WHEN 'hires-lossless' THEN 'HIRES_LOSSLESS'
                        WHEN 'lossless' THEN 'LOSSLESS'
                        WHEN 'lossy' THEN 'HIGH'
                      END,
                      variant.provider_quality_label)`;

function albumUpgradeKey(provider: string, albumId: string, slot?: string | null): string {
    return `${provider}\0${albumId}\0${slot || ""}`;
}

function hasRecentNoImprovementUpgradeAttempt(
    mediaId: string | null,
    albumId: string | null,
    mediaType: "track" | "video",
    context: UpgradeContext,
): boolean {
    if (!mediaId) return false;

    const downloadCommand = mediaType === "video" ? CommandNames.DownloadVideo : CommandNames.DownloadTrack;
    const refKey1 = mediaId;
    const refKey2 = albumId ?? mediaId;

    const waiting = context.selectWaitingQueueStmt.get(refKey1, refKey2) as { id?: number } | undefined;
    if (waiting?.id != null) {
        return true;
    }

    const recent = context.selectRecentCommandsStmt.get(
        `-${UPGRADE_HISTORY_COOLDOWN_HOURS} hours`,
        downloadCommand,
        CommandNames.ImportDownload,
        albumId ? CommandNames.DownloadAlbum : downloadCommand,
        refKey1,
        refKey2,
    ) as { id?: number } | undefined;

    return recent?.id != null;
}

function resolveWinningAlbum(
    row: UpgradeCandidateRow,
    destination: UpgradeDestination,
    editionId: number | null,
    context: UpgradeContext,
    cache: Map<string, WinningAlbumPlan | null>,
): WinningAlbumPlan | null {
    const cacheKey = `${destination.libraryId ?? ""}\0${editionId ?? ""}`;
    if (cache.has(cacheKey)) {
        return cache.get(cacheKey)!;
    }

    let winner: WinningAlbumPlan | null = null;

    // Only the selected (winning) plan may supply upgrades; no plan, no upgrade.
    if (destination.libraryId != null && editionId != null) {
        const selected = context.selectSelectedPlan.get(destination.libraryId, editionId) as {
            plan_id: number;
            provider: string;
            download_mode: string;
            provider_release_id: string | null;
            provider_edition_item_id: number | null;
        } | undefined;
        if (selected) {
            winner = {
                planId: selected.plan_id,
                provider: selected.provider,
                albumId: selected.provider_release_id ? String(selected.provider_release_id) : null,
                providerEditionItemId: selected.provider_edition_item_id ?? null,
                downloadMode: (selected.download_mode as "album" | "tracks") || "album",
            };
        }
    }

    if (winner && winner.albumId && winner.providerEditionItemId == null) {
        const byRel = context.selectReleaseByProviderId.get(winner.provider, winner.albumId) as {
            provider_edition_item_id: number | null;
        } | undefined;
        if (byRel?.provider_edition_item_id != null) {
            winner.providerEditionItemId = byRel.provider_edition_item_id;
        }
    }

    cache.set(cacheKey, winner);
    return winner;
}

function resolveWinningTrack(
    row: UpgradeCandidateRow,
    winningAlbum: WinningAlbumPlan,
    trackId: number | null,
    recordingId: number | null,
    context: UpgradeContext,
): WinningTrackItem | null {
    // 1. Plan tracks via AcquisitionPlanTracks
    if (winningAlbum.planId != null && trackId != null) {
        const item = context.selectPlanTrackItem.get(winningAlbum.planId, trackId) as WinningTrackItem | undefined;
        if (item) return item;
    }

    // 2. Member of the winning release item
    if (winningAlbum.providerEditionItemId != null) {
        if (trackId != null || recordingId != null) {
            const item = context.selectReleaseMemberTrackItem.get(
                winningAlbum.providerEditionItemId,
                trackId ?? null,
                trackId ?? null,
                recordingId ?? null,
                recordingId ?? null,
                trackId ?? null,
                trackId ?? null,
            ) as WinningTrackItem | undefined;
            if (item) return item;
        }

        if (row.file_provider_item_id != null) {
            const item = context.selectReleaseMemberDirect.get(
                winningAlbum.providerEditionItemId,
                row.file_provider_item_id,
            ) as WinningTrackItem | undefined;
            if (item) return item;
        }

        if (row.file_provider === winningAlbum.provider && row.file_provider_id != null) {
            const item = context.selectReleaseMemberTrackItemByProviderId.get(
                winningAlbum.providerEditionItemId,
                winningAlbum.provider,
                row.file_provider_id,
            ) as WinningTrackItem | undefined;
            if (item) return item;
        }

    }

    return null;
}

function resolveWinningVideo(
    row: UpgradeCandidateRow,
    recordingId: number | null,
    context: UpgradeContext,
): { provider_item_id: number; provider: string; provider_track_id: string; video_quality: string | null } | null {
    if (recordingId != null) {
        const item = context.selectVideoTrackItem.get(
            recordingId,
            recordingId,
            row.file_provider ?? null,
            row.file_provider ?? null,
        ) as { provider_item_id: number; provider: string; provider_track_id: string; video_quality: string | null } | undefined;
        if (item) return item;
    }

    if (row.file_provider_item_id != null || (row.file_provider && row.file_provider_id)) {
        const item = context.selectVideoItemByIdOrProviderId.get(
            row.file_provider_item_id ?? null,
            row.file_provider_item_id ?? null,
            row.file_provider ?? null,
            row.file_provider ?? null,
            row.file_provider_id ?? null,
        ) as { provider_item_id: number; provider: string; provider_track_id: string; video_quality: string | null } | undefined;
        if (item) return item;
    }

    return null;
}

export class UpgraderService {
    private static readonly UPGRADE_YIELD_EVERY = readIntEnv("DISCOGENIUS_UPGRADER_YIELD_EVERY", 100, 10);

    private static async yieldToEventLoop(): Promise<void> {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    private static async maybeYield(counter: number): Promise<void> {
        if (counter > 0 && counter % this.UPGRADE_YIELD_EVERY === 0) {
            await this.yieldToEventLoop();
        }
    }

    /**
     * Scans the library for files that don't meet the current quality settings
     * and queues them for re-download.
     *
     * @param force  Skip the `upgrade_existing_files` config check (used by manual trigger)
     * @param artistId Optional artist ID to restrict the scan
     * @param options  maxUnits caps queued albums/tracks/conversions for one paced run
     */
    /** Downloads still waiting, split into upgrades and everything else (missing
     * music). A paced pass waits until no missing download is left, then tops
     * upgrades up to a small ceiling. */
    static pendingDownloadCounts(): { upgrades: number; missing: number } {
        const row = db.prepare(`
            SELECT
              COALESCE(SUM(CASE WHEN json_valid(payload) AND json_extract(payload, '$.reason') = 'upgrade' THEN 1 ELSE 0 END), 0) AS upgrades,
              COUNT(*) AS total
            FROM DownloadQueue
        `).get() as { upgrades: number; total: number };
        return { upgrades: Number(row.upgrades), missing: Number(row.total) - Number(row.upgrades) };
    }

    /** Last TrackFiles.id a paced run looked at; the next paced run resumes after it. */
    private static pacedCursor = 0;

    static async checkUpgrades(force = false, artistId?: string, options: CheckUpgradesOptions = {}): Promise<UpgradeResult> {
        console.log(`🔍 [UPGRADER] Checking library for quality upgrades${artistId ? ` (Artist: ${artistId})` : ''}...`);

        // Without force and with automatic upgrades off, the pass still conforms
        // files above the audio quality setting; it only skips re-downloads.
        const qualityConfig = Config.getQualityConfig();
        const qualityProfile = UpgradableSpecification.buildEffectiveProfile(
            force ? { ...qualityConfig, upgrade_existing_files: true } : qualityConfig
        );

        // Apply quality settings to actual downloaded library files. Resolve the
        // provider resource to re-download from TrackFiles provider identity and
        // canonical ProviderItems. Never default a missing provider to TIDAL —
        // foreign album/track IDs must stay on their owning backend.
        // One row per file. The provider resource is resolved by internal identity
        // first (TrackFiles.provider_item_id), then by the full provider triple
        // snapshot, then through the typed match edge for the file's canonical
        // track/recording — never by a bare provider_id, and never by MBID shadow
        // columns on ProviderItems, which no longer exist.
        //
        // Source quality is the provider's SOURCE CAPABILITY: the best available
        // ProviderItemAudioVariants row for audio, video_quality for video. It is
        // deliberately not the file's imported quality — that is lf.quality below,
        // and comparing the two is the whole point of the upgrade check.
        const query = db.prepare(`
        SELECT
            lf.id AS file_id,
            lf.file_type AS file_type,
            lf.provider AS file_provider,
            lf.provider_entity_type AS file_provider_entity_type,
            CAST(lf.provider_id AS TEXT) AS file_provider_id,
            lf.provider_item_id AS file_provider_item_id,
            lf.track_id AS track_id,
            lf.recording_id AS recording_id,
            lf.album_edition_id AS album_edition_id,
            lf.release_group_id AS release_group_id,
            lf.artist_metadata_id AS artist_metadata_id,
            lf.canonical_track_mbid AS canonical_track_mbid,
            lf.canonical_recording_mbid AS canonical_recording_mbid,
            lf.canonical_release_mbid AS canonical_release_mbid,
            lf.quality AS current_quality,
            lf.codec AS current_codec,
            lf.extension AS current_extension,
            lf.bit_depth AS current_bit_depth,
            lf.bitrate AS current_bitrate,
            lf.sample_rate AS current_sample_rate,
            lf.file_path AS file_path,
            lf.relative_path AS relative_path,
            lf.library_root AS library_root,
            lf.filename AS filename,
            lf.library_slot AS library_slot,
            lf.library_id AS library_id,
            lf.expected_path AS expected_path
        FROM TrackFiles lf
        WHERE (lf.file_type = 'track' OR lf.file_type = 'video')
          ${artistId ? "AND lf.artist_metadata_id = ?" : ""}
          AND lf.id > ?
        ORDER BY lf.id ASC
        LIMIT ?
    `);

        const result: UpgradeResult = { tracks: 0, videos: 0, albums: 0, details: [] };
        const albumsNeedingUpgrade = new Map<string, AlbumUpgradeTarget>();
        const winningAlbumCache = new Map<string, WinningAlbumPlan | null>();

        // A paced (scheduled) run spends a small budget of queue units and
        // resumes after the last file it looked at on the next run, so the
        // whole library is covered gradually without flooding the queue.
        const budget = options.maxUnits && options.maxUnits > 0 ? options.maxUnits : Number.POSITIVE_INFINITY;
        const paced = Number.isFinite(budget) && !artistId;
        const startAfter = paced ? UpgraderService.pacedCursor : 0;
        let cursor = startAfter;
        let wrapped = false;
        let budgetSpent = false;
        let conversions = 0;
        const standaloneUnits = new Set<string>();
        const unitsUsed = () => albumsNeedingUpgrade.size + standaloneUnits.size + conversions;

        const resolverContext: UpgradeContext = {
            selectVideoLibrary: db.prepare(`
                SELECT library.id, library.root_path
                FROM Libraries library
                JOIN quality_profiles quality_profile ON quality_profile.id = library.quality_profile_id
                WHERE library.enabled = 1
                  AND EXISTS (
                    SELECT 1 FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
                    WHERE allowed.value = 'video'
                  )
                ORDER BY library.id
                LIMIT 1
            `),
            selectLibraryById: db.prepare(`
                SELECT
                  library.id AS library_id,
                  library.root_path,
                  quality_profile.allowed_source_formats
                FROM Libraries library
                JOIN quality_profiles quality_profile ON quality_profile.id = library.quality_profile_id
                WHERE library.id = ? AND library.enabled = 1
            `),
            selectLibraryByRoot: db.prepare(`
                SELECT library.id, library.root_path, quality_profile.allowed_source_formats
                FROM Libraries library
                JOIN quality_profiles quality_profile ON quality_profile.id = library.quality_profile_id
                WHERE library.enabled = 1 AND library.root_path = ?
            `),
            selectSpatialLibrary: db.prepare(`
                SELECT library.id, library.root_path
                FROM Libraries library
                JOIN quality_profiles quality_profile ON quality_profile.id = library.quality_profile_id
                WHERE library.enabled = 1
                  AND EXISTS (
                    SELECT 1 FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
                    WHERE allowed.value = 'spatial'
                  )
                ORDER BY library.id
                LIMIT 1
            `),
            selectStereoLibrary: db.prepare(`
                SELECT library.id, library.root_path
                FROM Libraries library
                JOIN quality_profiles quality_profile ON quality_profile.id = library.quality_profile_id
                WHERE library.enabled = 1
                  AND NOT EXISTS (
                    SELECT 1 FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
                    WHERE allowed.value IN ('spatial', 'video')
                  )
                ORDER BY library.id
                LIMIT 1
            `),
            selectPlanByEdition: db.prepare(`
                SELECT id FROM SelectedAcquisitionPlans
                WHERE library_id = ? AND edition_id = ? AND state = 'current'
                LIMIT 1
            `),
            selectPlanByTrack: db.prepare(`
                SELECT plan.id
                FROM AcquisitionPlanTracks plan_track
                JOIN SelectedAcquisitionPlans plan ON plan.id = plan_track.plan_id
                WHERE plan_track.track_id = ?
                  AND plan.library_id = ?
                  AND plan.state = 'current'
                ORDER BY plan.id DESC
                LIMIT 1
            `),
            selectTrackCatalog: db.prepare(`
                SELECT id, album_edition_id, recording_id FROM Tracks WHERE id = ?
            `),
            selectTrackByMbid: db.prepare(`
                SELECT id, album_edition_id, recording_id FROM Tracks WHERE mbid = ?
            `),
            selectEditionByMbid: db.prepare(`
                SELECT id FROM AlbumEditions WHERE mbid = ?
            `),
            selectRecordingByMbid: db.prepare(`
                SELECT id FROM Recordings WHERE mbid = ?
            `),
            selectSelectedPlan: db.prepare(`
                SELECT
                  plan.id AS plan_id,
                  plan.provider,
                  plan.download_mode,
                  release_item.provider_id AS provider_release_id,
                  release_item.id AS provider_edition_item_id
                FROM SelectedAcquisitionPlans plan
                LEFT JOIN AcquisitionPlanSources source
                  ON source.plan_id = plan.id
                LEFT JOIN ProviderEditionMatches release_match
                  ON release_match.id = source.provider_edition_match_id
                LEFT JOIN ProviderItems release_item
                  ON release_item.id = release_match.provider_edition_item_id
                WHERE plan.library_id = ?
                  AND plan.edition_id = ?
                  AND plan.state = 'current'
                ORDER BY CASE WHEN source.role = 'primary' THEN 0 ELSE 1 END, source.sort_order ASC
                LIMIT 1
            `),
            selectReleaseByMemberItemId: db.prepare(`
                SELECT
                  release_item.provider,
                  release_item.provider_id AS provider_release_id,
                  release_item.id AS provider_edition_item_id
                FROM ProviderEditionMembers member
                JOIN ProviderItems release_item
                  ON release_item.id = member.provider_edition_item_id
                LEFT JOIN ProviderEditionMatches rel_match
                  ON rel_match.provider_edition_item_id = release_item.id
                 AND rel_match.match_state = 'accepted'
                 AND (? IS NOT NULL AND rel_match.edition_id = ?)
                WHERE member.member_item_id = ?
                ORDER BY
                  CASE WHEN rel_match.id IS NOT NULL THEN 0 ELSE 1 END,
                  release_item.id ASC
                LIMIT 1
            `),
            selectReleaseByTrackProviderId: db.prepare(`
                SELECT
                  release_item.provider,
                  release_item.provider_id AS provider_release_id,
                  release_item.id AS provider_edition_item_id
                FROM ProviderItems track_item
                JOIN ProviderEditionMembers member
                  ON member.member_item_id = track_item.id
                JOIN ProviderItems release_item
                  ON release_item.id = member.provider_edition_item_id
                LEFT JOIN ProviderEditionMatches rel_match
                  ON rel_match.provider_edition_item_id = release_item.id
                 AND rel_match.match_state = 'accepted'
                 AND (? IS NOT NULL AND rel_match.edition_id = ?)
                WHERE track_item.provider = ?
                  AND track_item.entity_type = 'track'
                  AND CAST(track_item.provider_id AS TEXT) = CAST(? AS TEXT)
                ORDER BY
                  CASE WHEN rel_match.id IS NOT NULL THEN 0 ELSE 1 END,
                  release_item.id ASC
                LIMIT 1
            `),
            selectReleaseByProviderId: db.prepare(`
                SELECT
                  release_item.provider,
                  release_item.provider_id AS provider_release_id,
                  release_item.id AS provider_edition_item_id
                FROM ProviderItems release_item
                WHERE release_item.provider = ?
                  AND release_item.entity_type = 'release'
                  AND CAST(release_item.provider_id AS TEXT) = CAST(? AS TEXT)
                LIMIT 1
            `),
            selectPlanTrackItem: db.prepare(`
                SELECT
                  member_item.id AS provider_item_id,
                  member_item.provider,
                  member_item.provider_id AS provider_track_id
                FROM AcquisitionPlanTracks plan_track
                JOIN ProviderTrackMatches track_match
                  ON track_match.id = plan_track.provider_track_match_id
                JOIN ProviderEditionMembers member
                  ON member.id = track_match.provider_edition_member_id
                JOIN ProviderItems member_item
                  ON member_item.id = member.member_item_id
                WHERE plan_track.plan_id = ?
                  AND plan_track.track_id = ?
                LIMIT 1
            `),
            selectReleaseMemberTrackItem: db.prepare(`
                SELECT
                  member_item.id AS provider_item_id,
                  member_item.provider,
                  member_item.provider_id AS provider_track_id
                FROM ProviderEditionMembers member
                JOIN ProviderItems member_item
                  ON member_item.id = member.member_item_id
                 AND member_item.entity_type = 'track'
                JOIN ProviderTrackMatches track_match
                  ON (track_match.provider_edition_member_id = member.id OR track_match.provider_track_item_id = member_item.id)
                WHERE member.provider_edition_item_id = ?
                  AND track_match.match_state = 'accepted'
                  AND (
                    (? IS NOT NULL AND track_match.track_id = ?)
                    OR (? IS NOT NULL AND track_match.recording_id = ?)
                  )
                ORDER BY
                  CASE WHEN ? IS NOT NULL AND track_match.track_id = ? THEN 0 ELSE 1 END,
                  member.position ASC
                LIMIT 1
            `),
            selectReleaseMemberDirect: db.prepare(`
                SELECT
                  member_item.id AS provider_item_id,
                  member_item.provider,
                  member_item.provider_id AS provider_track_id
                FROM ProviderEditionMembers member
                JOIN ProviderItems member_item
                  ON member_item.id = member.member_item_id
                WHERE member.provider_edition_item_id = ?
                  AND member.member_item_id = ?
                LIMIT 1
            `),
            selectReleaseMemberTrackItemByProviderId: db.prepare(`
                SELECT
                  member_item.id AS provider_item_id,
                  member_item.provider,
                  member_item.provider_id AS provider_track_id
                FROM ProviderEditionMembers member
                JOIN ProviderItems member_item
                  ON member_item.id = member.member_item_id
                 AND member_item.entity_type = 'track'
                WHERE member.provider_edition_item_id = ?
                  AND member_item.provider = ?
                  AND CAST(member_item.provider_id AS TEXT) = CAST(? AS TEXT)
                LIMIT 1
            `),
            selectVideoTrackItem: db.prepare(`
                SELECT
                  matched.id AS provider_item_id,
                  matched.provider,
                  matched.provider_id AS provider_track_id,
                  matched.video_quality
                FROM ProviderVideoMatches typed_match
                JOIN ProviderItems matched
                  ON matched.id = typed_match.provider_video_item_id
                 AND matched.entity_type = 'video'
                WHERE typed_match.match_state = 'accepted'
                  AND (? IS NULL OR typed_match.recording_id = ?)
                  AND (? IS NULL OR matched.provider = ?)
                ORDER BY matched.id DESC
                LIMIT 1
            `),
            selectVideoItemByIdOrProviderId: db.prepare(`
                SELECT id AS provider_item_id, provider, provider_id AS provider_track_id, video_quality
                FROM ProviderItems
                WHERE entity_type = 'video'
                  AND (? IS NULL OR id = ?)
                  AND (? IS NULL OR (provider = ? AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)))
                LIMIT 1
            `),
            selectTrackVariants: db.prepare(`
                SELECT
                  variant.id,
                  variant.quality_class,
                  variant.provider_quality_label,
                  variant.spatial_format,
                  variant.bit_depth,
                  variant.sample_rate,
                  ${EFFECTIVE_SOURCE_TAG_SQL} AS effective_quality
                FROM ProviderItemAudioVariants variant
                WHERE variant.provider_item_id = ?
                  AND variant.availability NOT IN ('unavailable', 'restricted')
                  AND variant.provider_quality_label IS NOT NULL
                ORDER BY
                  CASE COALESCE(variant.delivered_quality_class, variant.quality_class)
                    WHEN 'spatial' THEN 0
                    WHEN 'hires-lossless' THEN 1
                    WHEN 'lossless' THEN 2
                    ELSE 3
                  END,
                  COALESCE(variant.bit_depth, 0) DESC,
                  COALESCE(variant.sample_rate, 0) DESC,
                  variant.id DESC
            `),
            selectAlbumStereoFallback: db.prepare(`
                SELECT
                  ${EFFECTIVE_SOURCE_TAG_SQL} AS effective_quality,
                  variant.quality_class,
                  variant.provider_quality_label,
                  variant.bit_depth,
                  variant.sample_rate
                FROM ProviderEditionMembers album_member
                JOIN ProviderItemAudioVariants variant
                  ON variant.provider_item_id = album_member.member_item_id
                WHERE album_member.provider_edition_item_id = ?
                  AND variant.availability NOT IN ('unavailable', 'restricted')
                  AND variant.provider_quality_label IS NOT NULL
                  AND variant.quality_class <> 'spatial'
                  AND variant.spatial_format IS NULL
                ORDER BY
                  CASE COALESCE(variant.delivered_quality_class, variant.quality_class)
                    WHEN 'hires-lossless' THEN 1
                    WHEN 'lossless' THEN 2
                    ELSE 3
                  END,
                  COALESCE(variant.bit_depth, 0) DESC,
                  COALESCE(variant.sample_rate, 0) DESC,
                  variant.id DESC
                LIMIT 1
            `),
            countProviderAlbumTracksStmt: db.prepare(`
                SELECT COUNT(DISTINCT member.member_item_id) AS cnt
                FROM ProviderItems release_item
                JOIN ProviderEditionMembers member
                  ON member.provider_edition_item_id = release_item.id
                JOIN ProviderItems member_item
                  ON member_item.id = member.member_item_id
                 AND member_item.entity_type = 'track'
                WHERE release_item.provider = ?
                  AND release_item.entity_type = 'release'
                  AND CAST(release_item.provider_id AS TEXT) = CAST(? AS TEXT)
            `),
            selectWaitingQueueStmt: db.prepare(`
                SELECT id
                FROM DownloadQueue
                WHERE ref_key IN (?, ?)
                LIMIT 1
            `),
            selectRecentCommandsStmt: db.prepare(`
                SELECT id
                FROM commands
                WHERE status = 'completed'
                  AND COALESCE(completed_at, updated_at, created_at) >= datetime('now', ?)
                  AND name IN (?, ?, ?)
                  AND ref_id IN (?, ?)
                LIMIT 1
            `),
        };

        let rowsLoopCounter = 0;
        scan: while (true) {
            const page = (artistId
                ? query.all(artistId, cursor, UPGRADE_SCAN_PAGE_SIZE)
                : query.all(cursor, UPGRADE_SCAN_PAGE_SIZE)) as UpgradeCandidateRow[];
            if (page.length === 0) {
                if (!paced || wrapped || startAfter === 0) break;
                wrapped = true;
                cursor = 0;
                continue;
            }
            await this.yieldToEventLoop();
        for (const row of page) {
            rowsLoopCounter++;
            await this.maybeYield(rowsLoopCounter);
            if (wrapped && row.file_id > startAfter) break scan;

            const destination = resolveUpgradeDestination(row, resolverContext);
            if (!destination.slot) {
                console.log(`[UPGRADER] Skipping ${row.file_type} file ${row.file_id}: no destination slot could be determined.`);
                cursor = row.file_id;
                continue;
            }

            // Resolve canonical IDs if null on TrackFiles
            let trackId = row.track_id;
            let recordingId = row.recording_id;
            let editionId = row.album_edition_id;

            if (trackId != null) {
                const cat = resolverContext.selectTrackCatalog.get(trackId) as { album_edition_id: number | null; recording_id: number | null } | undefined;
                if (cat) {
                    if (editionId == null) editionId = cat.album_edition_id;
                    if (recordingId == null) recordingId = cat.recording_id;
                }
            }
            if (trackId == null && row.canonical_track_mbid) {
                const cat = resolverContext.selectTrackByMbid.get(row.canonical_track_mbid) as { id: number; album_edition_id: number | null; recording_id: number | null } | undefined;
                if (cat) {
                    trackId = cat.id;
                    if (editionId == null) editionId = cat.album_edition_id;
                    if (recordingId == null) recordingId = cat.recording_id;
                }
            }
            if (editionId == null && row.canonical_release_mbid) {
                const ed = resolverContext.selectEditionByMbid.get(row.canonical_release_mbid) as { id: number } | undefined;
                if (ed) editionId = ed.id;
            }
            if (recordingId == null && row.canonical_recording_mbid) {
                const rec = resolverContext.selectRecordingByMbid.get(row.canonical_recording_mbid) as { id: number } | undefined;
                if (rec) recordingId = rec.id;
            }

            // --- VIDEO HANDLING ---
            if (row.file_type === "video") {
                const videoItem = resolveWinningVideo(row, recordingId, resolverContext);
                if (!videoItem) {
                    console.log(`[UPGRADER] Skipping video file ${row.file_id}: missing provider identity.`);
                    cursor = row.file_id;
                    continue;
                }

                if (unitsUsed() >= budget && !standaloneUnits.has(`${videoItem.provider}\0${videoItem.provider_track_id}`)) {
                    budgetSpent = true;
                    break scan;
                }
                cursor = row.file_id;

                const evaluation = UpgradableSpecification.evaluateVideoChange({
                    profile: qualityProfile,
                    currentQuality: row.current_quality,
                    extension: row.current_extension,
                });

                if (evaluation.needsChange) {
                    const expectedTarget = evaluation.targetQuality || qualityProfile.videoCutoff;
                    if (hasRecentNoImprovementUpgradeAttempt(videoItem.provider_track_id, null, "video", resolverContext)) {
                        console.log(`[UPGRADER] Skipping video ${videoItem.provider_track_id}: recent upgrade attempt did not satisfy cutoff (${expectedTarget}).`);
                        continue;
                    }

                    result.details.push({
                        mediaId: videoItem.provider_track_id,
                        type: "Music Video",
                        reason: evaluation.reason,
                        provider: videoItem.provider,
                        albumId: null,
                        action: "upgrade",
                        slot: destination.slot,
                        libraryId: destination.libraryId,
                        acquisitionPlanId: destination.acquisitionPlanId,
                        libraryRoot: destination.libraryRoot,
                    });
                    result.videos++;
                    standaloneUnits.add(`${videoItem.provider}\0${videoItem.provider_track_id}`);
                }
                continue;
            }

            // --- AUDIO TRACK HANDLING ---
            // A file above the audio quality setting is conformed locally, whatever plan it came from.
            const settingCheck = UpgradableSpecification.evaluateAudioChange({
                profile: qualityProfile,
                currentQuality: row.current_quality,
                sourceQuality: null,
                codec: row.current_codec,
                extension: row.current_extension,
                bitDepth: row.current_bit_depth,
                sampleRate: row.current_sample_rate,
            });
            if (settingCheck.direction === "downgrade") {
                if (unitsUsed() >= budget) {
                    budgetSpent = true;
                    break scan;
                }
                cursor = row.file_id;
                if (settingCheck.needsChange && row.file_path) {
                    try {
                        await conformExistingTrackFile({
                            fileId: row.file_id,
                            filePath: row.file_path,
                            relativePath: row.relative_path,
                            libraryRoot: row.library_root,
                            filename: row.filename,
                            expectedPath: row.expected_path,
                            codec: row.current_codec,
                            extension: row.current_extension,
                            quality: row.current_quality,
                            bitDepth: row.current_bit_depth,
                            sampleRate: row.current_sample_rate,
                            audioQuality: qualityConfig.audio_quality,
                        });
                        result.tracks++;
                        conversions++;
                        result.details.push({
                            mediaId: String(row.file_provider_id ?? row.file_id),
                            type: "track",
                            reason: settingCheck.reason,
                            provider: row.file_provider ?? "local",
                            albumId: null,
                            action: "downconvert",
                            slot: destination.slot,
                            libraryId: destination.libraryId,
                            acquisitionPlanId: destination.acquisitionPlanId,
                            libraryRoot: destination.libraryRoot,
                            trackId: trackId ?? row.track_id ?? null,
                        });
                    } catch (error) {
                        console.error(
                            `[UPGRADER] Downconvert failed for ${row.file_path}:`,
                            error instanceof Error ? error.message : error,
                        );
                    }
                }
                continue;
            }

            // Rule 1: Album-level winner. Resolve the winning album acquisition plan / release.
            const winningAlbum = resolveWinningAlbum(row, destination, editionId, resolverContext, winningAlbumCache);
            if (!winningAlbum) {
                console.log(`[UPGRADER] Skipping track file ${row.file_id}: no winning album plan could be determined.`);
                cursor = row.file_id;
                continue;
            }

            if (winningAlbum.planId != null) {
                destination.acquisitionPlanId = winningAlbum.planId;
            }

            const rowAlbumKey = winningAlbum.albumId && destination.slot
                ? albumUpgradeKey(winningAlbum.provider, winningAlbum.albumId, destination.slot) : null;
            if (unitsUsed() >= budget && !(rowAlbumKey && albumsNeedingUpgrade.has(rowAlbumKey))) {
                budgetSpent = true;
                break scan;
            }
            cursor = row.file_id;

            // Resolve track offer strictly within the winning album plan
            const winningTrack = resolveWinningTrack(row, winningAlbum, trackId, recordingId, resolverContext);
            if (!winningTrack) {
                console.log(`[UPGRADER] Skipping track file ${row.file_id}: track not found in winning album plan (${winningAlbum.provider}:${winningAlbum.albumId}).`);
                continue;
            }

            // Variants available on the winning track
            const variants = resolverContext.selectTrackVariants.all(winningTrack.provider_item_id) as AudioVariantOffer[];
            const spatialOffer = variants.find(v => isSpatialAudioQuality(v.effective_quality) || isSpatialQualityOrOffer(v.effective_quality) || v.quality_class === 'spatial' || Boolean(v.spatial_format));
            let stereoOffer = variants.find(v => !isSpatialAudioQuality(v.effective_quality) && !isSpatialQualityOrOffer(v.effective_quality) && v.quality_class !== 'spatial' && !v.spatial_format);

            if (!stereoOffer && variants.length === 0 && winningAlbum.providerEditionItemId != null) {
                const fallback = resolverContext.selectAlbumStereoFallback.get(winningAlbum.providerEditionItemId) as AudioVariantOffer | undefined;
                if (fallback) stereoOffer = fallback;
            }

            const normalizedCurrentQuality = normalizeAudioQualityTag(row.current_quality);
            const isCurrentSpatial = isSpatialAudioQuality(normalizedCurrentQuality);
            let evaluation: QualityChangeEvaluation;

            if (destination.slot === "spatial") {
                if (isCurrentSpatial) {
                    // Spatial files in spatial library are already satisfied
                    continue;
                }
                // File in spatial library is currently stereo
                if (spatialOffer) {
                    // Rule 3: Stereo-only track gains Atmos in the winning album plan
                    const targetQual = spatialOffer.effective_quality || "DOLBY_ATMOS";
                    evaluation = {
                        needsChange: qualityProfile.allowRedownloads,
                        direction: "upgrade" as const,
                        currentQuality: row.current_quality || "UNKNOWN",
                        targetQuality: targetQual,
                        qualityCutoffNotMet: true,
                        reason: `Spatial upgrade: ${row.current_quality || "UNKNOWN"} -> ${targetQual}`,
                    };
                } else if (stereoOffer) {
                    // Rule 2 & 5: Interlude with no Atmos offer. Evaluate genuine stereo upgrade
                    evaluation = UpgradableSpecification.evaluateAudioChange({
                        profile: qualityProfile,
                        currentQuality: row.current_quality,
                        sourceQuality: stereoOffer.effective_quality,
                        codec: row.current_codec,
                        extension: row.current_extension,
                        bitDepth: row.current_bit_depth,
                        sampleRate: row.current_sample_rate,
                    });
                } else {
                    evaluation = UpgradableSpecification.evaluateAudioChange({
                        profile: qualityProfile,
                        currentQuality: row.current_quality,
                        sourceQuality: null,
                        codec: row.current_codec,
                        extension: row.current_extension,
                        bitDepth: row.current_bit_depth,
                        sampleRate: row.current_sample_rate,
                    });
                }
            } else {
                // destination.slot === "stereo"
                if (isCurrentSpatial) {
                    // Rule 4: Atmos file sitting in stereo library replaced by stereo
                    if (stereoOffer) {
                        const targetQual = stereoOffer.effective_quality || "LOSSLESS";
                        evaluation = {
                            needsChange: qualityProfile.allowRedownloads,
                            direction: "upgrade" as const,
                            currentQuality: row.current_quality || "DOLBY_ATMOS",
                            targetQuality: targetQual,
                            qualityCutoffNotMet: true,
                            reason: `Quality upgrade: Stereo replacement of spatial file in stereo library (${targetQual})`,
                        };
                    } else {
                        // Real stereo version not available yet
                        continue;
                    }
                } else {
                    // Normal stereo file in stereo library
                    if (stereoOffer) {
                        evaluation = UpgradableSpecification.evaluateAudioChange({
                            profile: qualityProfile,
                            currentQuality: row.current_quality,
                            sourceQuality: stereoOffer.effective_quality,
                            codec: row.current_codec,
                            extension: row.current_extension,
                            bitDepth: row.current_bit_depth,
                            sampleRate: row.current_sample_rate,
                        });
                    } else if (spatialOffer) {
                        // Guard #123: Stereo library file cannot be upgraded with spatial offer
                        console.log(`[UPGRADER] Skipping track ${winningTrack.provider_track_id}: stereo file cannot be upgraded with a spatial offer.`);
                        continue;
                    } else {
                        // Fall back to evaluateAudioChange with sourceQuality = null when no variants present
                        evaluation = UpgradableSpecification.evaluateAudioChange({
                            profile: qualityProfile,
                            currentQuality: row.current_quality,
                            sourceQuality: null,
                            codec: row.current_codec,
                            extension: row.current_extension,
                            bitDepth: row.current_bit_depth,
                            sampleRate: row.current_sample_rate,
                        });
                    }
                }
            }

            // Only the quality setting decides a downconvert (handled above); a
            // provider offer below the file is no reason to touch it.
            if (evaluation.direction === "downgrade") continue;

            if (evaluation.needsChange) {
                const expectedTarget = evaluation.targetQuality || qualityProfile.audioCutoff;
                if (hasRecentNoImprovementUpgradeAttempt(winningTrack.provider_track_id, winningAlbum.albumId, "track", resolverContext)) {
                    console.log(`[UPGRADER] Skipping track ${winningTrack.provider_track_id}: recent upgrade attempt did not satisfy cutoff (${expectedTarget}).`);
                    continue;
                }

                let fileReleaseId: string | null = null;
                if (row.file_provider_entity_type === "release" && row.file_provider_id) {
                    fileReleaseId = String(row.file_provider_id);
                } else if (row.file_provider_item_id != null) {
                    const memRel = resolverContext.selectReleaseByMemberItemId.get(
                        editionId ?? null,
                        editionId ?? null,
                        row.file_provider_item_id,
                    ) as { provider_release_id: string | null } | undefined;
                    if (memRel?.provider_release_id) {
                        fileReleaseId = String(memRel.provider_release_id);
                    }
                } else if (row.file_provider && row.file_provider_id && row.file_provider_entity_type === "track") {
                    const trackRel = resolverContext.selectReleaseByTrackProviderId.get(
                        editionId ?? null,
                        editionId ?? null,
                        row.file_provider,
                        row.file_provider_id,
                    ) as { provider_release_id: string | null } | undefined;
                    if (trackRel?.provider_release_id) {
                        fileReleaseId = String(trackRel.provider_release_id);
                    }
                }

                result.details.push({
                    mediaId: winningTrack.provider_track_id,
                    type: "track",
                    reason: evaluation.reason,
                    provider: winningAlbum.provider,
                    albumId: winningAlbum.albumId,
                    action: "upgrade",
                    slot: destination.slot,
                    libraryId: destination.libraryId,
                    acquisitionPlanId: destination.acquisitionPlanId,
                    libraryRoot: destination.libraryRoot,
                    fileProvider: row.file_provider,
                    fileReleaseId,
                    trackId: trackId ?? row.track_id ?? null,
                });
                result.tracks++;

                const isStereoInSpatial = destination.slot === "spatial" && !isSpatialQualityOrOffer(evaluation.targetQuality);
                const isSpatialReplacementInStereo = destination.slot === "stereo" && isCurrentSpatial;
                const slot = destination.slot;
                const isAlbumLevelEligible = winningAlbum.albumId
                    && !isStereoInSpatial
                    && !isSpatialReplacementInStereo
                    && winningAlbum.downloadMode !== "tracks"
                    && (slot === "stereo" || slot === "spatial");

                if (isAlbumLevelEligible && (slot === "stereo" || slot === "spatial")) {
                    albumsNeedingUpgrade.set(albumUpgradeKey(winningAlbum.provider, winningAlbum.albumId!, slot), {
                        provider: winningAlbum.provider,
                        albumId: winningAlbum.albumId!,
                        slot,
                        libraryId: destination.libraryId,
                        acquisitionPlanId: destination.acquisitionPlanId,
                        libraryRoot: destination.libraryRoot,
                    });
                } else {
                    standaloneUnits.add(`${winningAlbum.provider}\0${winningTrack.provider_track_id}`);
                }
            }
        }
        }
        if (paced) {
            UpgraderService.pacedCursor = budgetSpent ? cursor : 0;
        }

        // Queue upgrades at album level where possible — more efficient than per-track downloads
        const trackMediaIdsQueuedViaAlbum = new Set<string>();
        let albumsLoopCounter = 0;
        let albumTrackTransferLoopCounter = 0;

        const planCommandCache = new Map<number, AcquisitionDownloadCommand | null>();
        const getOrBuildPlanCommand = (planId: number): AcquisitionDownloadCommand | null => {
            if (planCommandCache.has(planId)) return planCommandCache.get(planId)!;
            const cmd = buildAcquisitionDownloadCommand(db, planId);
            planCommandCache.set(planId, cmd);
            return cmd;
        };

        for (const target of albumsNeedingUpgrade.values()) {
            albumsLoopCounter++;
            await this.maybeYield(albumsLoopCounter);

            if (!target.slot) {
                console.log(`[UPGRADER] Skipping album-level upgrade for ${target.provider} album ${target.albumId}: no destination slot could be determined.`);
                continue;
            }

            const albumTracksToUpgrade = result.details.filter(
                d => d.type !== 'Music Video'
                    && d.action !== "downconvert"
                    && d.provider === target.provider
                    && d.albumId === target.albumId
                    && d.slot === target.slot
            );

            // Count tracks for THIS provider only. Never assume TIDAL — a foreign
            // album id with zero TIDAL tracks used to still enqueue DownloadAlbum.
            const totalAlbumTracks = Number((resolverContext.countProviderAlbumTracksStmt.get(target.provider, target.albumId) as { cnt: number } | undefined)?.cnt) || 0;
            if (totalAlbumTracks <= 0) {
                console.log(`[UPGRADER] Skipping album-level upgrade for ${target.provider} album ${target.albumId}: no provider tracks found.`);
                continue;
            }

            // Only queue as album if a significant portion needs upgrading (≥50% or ≥3 tracks)
            if (albumTracksToUpgrade.length >= 3 || albumTracksToUpgrade.length >= totalAlbumTracks * 0.5) {
                console.log(`[UPGRADER] Queuing ${target.provider} album ${target.albumId} (${target.slot}) for upgrade (${albumTracksToUpgrade.length}/${totalAlbumTracks} tracks need upgrade)`);

                let planCommand: AcquisitionDownloadCommand | null = null;
                if (target.acquisitionPlanId != null) {
                    planCommand = getOrBuildPlanCommand(target.acquisitionPlanId);
                    const planOffers = planCommand?.body.trackOffers ?? [];
                    const matchesProvider = planCommand?.body.provider === target.provider;
                    const matchesAlbum = planCommand?.body.providerId === target.albumId
                        || planOffers.some(o => o.providerAlbumId === target.albumId);
                    if (!planCommand || !matchesProvider || !matchesAlbum) {
                        console.log(`[UPGRADER] Skipping album-level upgrade for ${target.provider} album ${target.albumId}: cannot build matching offers from acquisition plan ${target.acquisitionPlanId}.`);
                        continue;
                    }
                }

                updateAlbumDownloadStatus(target.albumId);

                DownloadWaitQueue.enqueue({
                    refKey: target.albumId,
                    mediaKind: "album",
                    commandName: CommandNames.DownloadAlbum,
                    provider: target.provider,
                    providerId: target.albumId,
                    slot: target.slot,
                    payload: {
                        ...(planCommand ? planCommand.body : {}),
                        providerId: target.albumId,
                        provider: target.provider,
                        type: "album",
                        reason: "upgrade",
                        url: (planCommand && planCommand.body.url)
                            ? planCommand.body.url
                            : buildStreamingMediaUrl("album", target.albumId, target.provider),
                        slot: target.slot,
                        ...(target.libraryId ? { libraryId: target.libraryId } : {}),
                        ...(target.acquisitionPlanId ? { acquisitionPlanId: target.acquisitionPlanId } : {}),
                        ...(target.libraryRoot ? { libraryRoot: target.libraryRoot } : {}),
                    },
                    priority: -5,
                    position: "back",
                    notify: false,
                });
                result.albums++;

                for (const d of albumTracksToUpgrade) {
                    albumTrackTransferLoopCounter++;
                    await this.maybeYield(albumTrackTransferLoopCounter);
                    trackMediaIdsQueuedViaAlbum.add(`${d.provider}\0${d.mediaId}\0${d.slot}`);
                }
            }
        }

        // Queue remaining individual track/video upgrades (not covered by album downloads)
        let detailsLoopCounter = 0;
        const finalDetails: UpgradeDetail[] = [];
        for (const d of result.details) {
            detailsLoopCounter++;
            await this.maybeYield(detailsLoopCounter);

            if (d.action === "downconvert") {
                finalDetails.push(d);
                continue;
            }
            if (trackMediaIdsQueuedViaAlbum.has(`${d.provider}\0${d.mediaId}\0${d.slot}`)) {
                finalDetails.push(d);
                continue;
            }

            const isVideo = d.type === 'Music Video';
            const jobType = isVideo ? CommandNames.DownloadVideo : CommandNames.DownloadTrack;
            const mediaType = isVideo ? "video" : "track";

            if (!d.slot) {
                console.log(`[UPGRADER] Skipping ${jobType} upgrade for ${d.provider}:${d.mediaId}: no destination slot could be determined.`);
                result.tracks--;
                continue;
            }

            // Rule 1: A per-track upgrade must never come from a provider (or release) other than
            // the one the album's files came from.
            if (!isVideo) {
                if (d.fileProvider != null && d.fileProvider !== d.provider) {
                    console.log(`[UPGRADER] Skipping standalone ${jobType} upgrade for ${d.provider}:${d.mediaId}: cannot mix provider with existing file (${d.fileProvider}).`);
                    result.tracks--;
                    continue;
                }
                if (d.fileReleaseId != null && d.albumId != null && d.fileReleaseId !== d.albumId) {
                    console.log(`[UPGRADER] Skipping standalone ${jobType} upgrade for ${d.provider}:${d.mediaId}: cannot mix release ${d.albumId} with existing file release (${d.fileReleaseId}).`);
                    result.tracks--;
                    continue;
                }
            }

            let matchingOffer: DownloadTrackOffer | undefined;
            let planCommand: AcquisitionDownloadCommand | null = null;
            if (!isVideo && d.acquisitionPlanId != null) {
                planCommand = getOrBuildPlanCommand(d.acquisitionPlanId);
                const planOffers = planCommand?.body.trackOffers ?? [];
                const matchesProvider = planCommand?.body.provider === d.provider;
                if (!planCommand || !matchesProvider) {
                    console.log(`[UPGRADER] Skipping ${jobType} upgrade for ${d.provider}:${d.mediaId}: cannot resolve matching offer from acquisition plan ${d.acquisitionPlanId}.`);
                    result.tracks--;
                    continue;
                }
                matchingOffer = planOffers.find(o => String(o.providerTrackId) === String(d.mediaId));
                if (!matchingOffer) {
                    console.log(`[UPGRADER] Skipping ${jobType} upgrade for ${d.provider}:${d.mediaId}: cannot resolve matching offer from acquisition plan ${d.acquisitionPlanId}.`);
                    result.tracks--;
                    continue;
                }
            }

            console.log(`[UPGRADER] Queuing ${jobType} upgrade for ${d.provider}:${d.mediaId} (${d.slot}): ${d.reason}`);

            DownloadWaitQueue.enqueue({
                refKey: d.mediaId,
                mediaKind: mediaType,
                commandName: jobType,
                provider: d.provider,
                providerId: d.mediaId,
                slot: d.slot,
                payload: {
                    providerId: d.mediaId,
                    provider: d.provider,
                    type: mediaType,
                    reason: "upgrade",
                    url: buildStreamingMediaUrl(mediaType, d.mediaId, d.provider),
                    slot: d.slot,
                    ...(d.libraryId ? { libraryId: d.libraryId } : {}),
                    ...(d.acquisitionPlanId ? { acquisitionPlanId: d.acquisitionPlanId } : {}),
                    ...(matchingOffer ? {
                        trackOffers: [matchingOffer],
                        canonicalTrackMbid: matchingOffer.canonicalTrackMbid,
                        canonicalRecordingMbid: matchingOffer.canonicalRecordingMbid,
                        releaseMbid: planCommand?.body.releaseMbid,
                        releaseGroupMbid: planCommand?.body.releaseGroupMbid,
                    } : {}),
                    ...(d.libraryRoot ? { libraryRoot: d.libraryRoot } : {}),
                },
                priority: -5,
                position: "back",
                notify: false,
            });
            finalDetails.push(d);
        }
        result.details = finalDetails;

        console.log(`✅ [UPGRADER] Queued upgrades: ${result.albums} albums, ${result.tracks} tracks, ${result.videos} videos (${result.details.length} total items).`);

        DownloadWaitQueue.notifyChanged();

        // Kick the download processor
        downloadProcessor.processQueue().catch(err => {
            console.error('[UPGRADER] Error triggering download processor:', err);
        });

        return result;
    }
}
