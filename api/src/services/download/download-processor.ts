import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { db } from '../../database.js';
import {CommandModel, CommandModelOf} from "../commands/command-model.js";
import { DOWNLOAD_COMMAND_NAMES, DOWNLOAD_OR_IMPORT_COMMAND_NAMES, CommandNames } from "../commands/command-names.js";
import { CommandQueueManager } from "../commands/command-queue-manager.js";
import { buildDurableQueueOrderClause } from "../commands/command-ordering.js";
import { getConfigSection, Config } from '../config/config.js';
import { downloadEvents } from './download-events.js';
import { DownloadWaitQueue } from './download-wait-queue.js';
import {
    invalidateAlbumDownloadStatus,
    invalidateAllDownloadState,
    invalidateArtistDownloadStatus,
    invalidateMediaDownloadState,
    invalidateReleaseGroupDownloadStatus,
    updateAlbumDownloadStatus,
} from './download-state.js';
import { isSqliteWriteMutexHeld, sqliteWriteMutexWorkerData } from "../../database/sqlite-write-mutex.js";
import { downloadBackendRegistry } from './download-backend.js';
import { readIntEnv } from '../../utils/env.js';
import fs from 'fs';
import path from 'path';
import {
    getDownloadWorkspacePath,
    getDefaultStreamingSource,
    buildStreamingMediaUrl,
} from '../download/download-routing.js';
import {
    isKnownProviderVideoOffer,
    resolvePreferredVideoOffer,
} from '../music/video-offer-resolver.js';
import {
    executeWithSameOfferRetries,
    formatFallbackSuccessMessage,
    formatProviderLabel,
    isDownloadCancellationError,
} from './download-failure-policy.js';
import {
    listRankedAlbumOffers,
    listRankedTrackOffers,
    listRankedVideoOffers,
    makeOfferAttemptKey,
    nextOfferAfterTried,
    type RankedDownloadOffer,
} from './download-offer-fallback.js';
import { AlbumQueryService } from "../music/album-query-service.js";
import { streamingProviderManager } from '../providers/index.js';
import type {
    DownloadAlbumCommand,
    DownloadMediaType,
    DownloadStatePayload,
    DownloadTrackOffer,
    DownloadTrackStateEntry,
    ImportDownloadCommand,
    DownloadTrackCommand,
    DownloadVideoCommand,
    ResolvedDownloadMetadata,
} from '../commands/command-bodies.js';
import { DownloadedTracksImportService } from '../mediafiles/downloaded-tracks-import-service.js';
import { removeEmptyParents } from '../mediafiles/library-files.js';
import { appEvents, AppEvent, type CommandEventPayload } from '../commands/app-events.js';
import { CommandWorkerPool } from '../commands/worker/command-worker-pool.js';
import type { CacheInvalidateTarget } from '../commands/worker/command-worker-protocol.js';
import {
    getDownloadQueueControlState,
    setDownloadQueuePaused,
} from './download-queue-control.js';

import {
    ensureMetadataReady as ensureDownloadMetadataReady,
    getCanonicalAlbumDownloadProgress as getCanonicalAlbumDownloadProgressFromMetadata,
    hasAlbumMetadataReady as hasAlbumMetadataReadyFromModule,
    hasTrackMetadataReady as hasTrackMetadataReadyFromModule,
    hasVideoMetadataReady as hasVideoMetadataReadyFromModule,
    isCanonicalProviderItemDownloaded as isCanonicalProviderItemDownloadedFromMetadata,
    resolveCanonicalProviderOffer as resolveCanonicalProviderOfferFromMetadata,
    resolveDownloadMetadata as resolveDownloadMetadataFromModule,
    resolveDownloadQuality as resolveDownloadQualityFromModule,
    resolvePayloadProvider as resolvePayloadProviderFromMetadata,
} from './download-metadata.js';

export type QueueTrackRow = {
    title: string;
    trackNum?: number;
    status: string;
    providerTrackId?: string;
};

/**
 * Re-resolve the exact provider rows an offer names after a fallback.
 *
 * A fallback swaps which provider actually supplies a track, so every id that
 * identified the original provider's row is now wrong: the item, its edition
 * and the audio variant all belong to the provider we just failed on. Carrying
 * them made the offer describe two different tracks at once, and the import
 * refused it — "Provider item 13547 does not identify tidal:track:506688457" —
 * after the audio had already been fetched and filed.
 *
 * Anything that cannot be resolved for the new provider is cleared rather than
 * inherited. A null is an honest "not known"; a stale id is a false claim, and
 * the import checks these precisely because provenance decides what the library
 * believes it holds.
 */
export function resolveFallbackProvenance(next: {
    provider: string;
    providerId: string;
    providerAlbumId?: string | null;
}): {
    providerTrackItemId?: number;
    providerEditionItemId?: number | null;
    providerAudioVariantId?: number | null;
    acquisitionPlanSourceId?: number | null;
} {
    const trackItem = db.prepare(`
        SELECT id FROM ProviderItems
        WHERE provider = ? AND entity_type = 'track' AND provider_id = ?
    `).get(next.provider, String(next.providerId)) as { id: number } | undefined;

    const editionItem = next.providerAlbumId
        ? db.prepare(`
            SELECT id FROM ProviderItems
            WHERE provider = ? AND entity_type = 'release' AND provider_id = ?
        `).get(next.provider, String(next.providerAlbumId)) as { id: number } | undefined
        : undefined;

    // The variant the new provider can actually deliver for this track. Best
    // available rather than the tier the plan chose from the old provider,
    // which is exactly what a fallback is conceding.
    const variant = trackItem
        ? db.prepare(`
            SELECT id FROM ProviderItemAudioVariants
            WHERE provider_item_id = ?
              AND availability NOT IN (
                'unavailable', 'no_longer_available', 'geography_restricted',
                'entitlement_restricted', 'explicit_policy_ineligible', 'quality_unavailable'
              )
            ORDER BY CASE quality_class
                WHEN 'spatial' THEN 0
                WHEN 'hires-lossless' THEN 1
                WHEN 'lossless' THEN 2
                ELSE 3
              END, id
            LIMIT 1
        `).get(trackItem.id) as { id: number } | undefined
        : undefined;

    return {
        providerTrackItemId: trackItem?.id,
        providerEditionItemId: editionItem?.id ?? null,
        providerAudioVariantId: variant?.id ?? null,
        // The plan source selected the *original* provider's release; a
        // fallback is by definition off-plan.
        acquisitionPlanSourceId: null,
    };
}

/**
 * Replace every provider-native field on a per-track offer after fallback.
 * Canonical MBIDs and track positions remain attached to the requested slot,
 * but no provider album, item, variant or plan-source id may survive from the
 * provider that failed.
 */
export function applyFallbackTrackOffer(
    current: DownloadTrackOffer,
    next: RankedDownloadOffer,
): DownloadTrackOffer {
    const resolved = resolveFallbackProvenance(next);
    return {
        ...current,
        provider: next.provider,
        providerTrackId: next.providerId,
        providerAlbumId: next.providerAlbumId ?? null,
        providerTrackItemId: next.providerItemId ?? resolved.providerTrackItemId,
        providerEditionItemId: next.providerAlbumItemId ?? resolved.providerEditionItemId,
        providerAudioVariantId: next.providerAudioVariantId ?? resolved.providerAudioVariantId,
        acquisitionPlanSourceId: null,
        quality: next.quality ?? null,
    };
}

export function resetTracksForImportState(
    tracks?: DownloadTrackStateEntry[],
): DownloadTrackStateEntry[] | undefined {
    if (!tracks?.length) {
        return undefined;
    }

    return tracks.map((track) => ({
        ...track,
        status: track.status === 'skipped' ? 'skipped' : 'queued',
    }));
}

export function isSqliteBusyError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const code = (error as { code?: string }).code;
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_LOCKED') {
        return true;
    }
    const message = (error as { message?: string }).message;
    return typeof message === 'string' && /database( table)? is locked/i.test(message);
}

export function applyTrackStatusByProviderId<T extends QueueTrackRow>(
    tracks: T[],
    statusByProviderTrackId: Record<string, string>,
): T[] | null {
    const updates = new Map<string, string>();
    for (const [providerTrackId, status] of Object.entries(statusByProviderTrackId)) {
        const key = String(providerTrackId || "").trim();
        if (key) {
            updates.set(key, status);
        }
    }

    if (updates.size === 0) {
        return null;
    }

    let changed = false;
    const next = tracks.map((track) => {
        const key = String(track.providerTrackId || "").trim();
        const status = key ? updates.get(key) : undefined;
        if (!status || track.status === status || (track.status === 'completed' && status !== 'completed')) {
            return track;
        }
        changed = true;
        return { ...track, status };
    });

    return changed ? next : null;
}

/**
 * Catalog-anchored X/Y for album jobs. Provider/tiddl queue totals must not
 * replace the MusicBrainz tracklist length (hybrids/edition mismatches).
 */
export function deriveCatalogFileProgress(
    tracks: Array<{ status?: string | null }> | null | undefined,
): { totalFiles: number; currentFileNum: number; completed: number } | null {
    if (!Array.isArray(tracks) || tracks.length === 0) {
        return null;
    }
    const totalFiles = tracks.length;
    const completed = tracks.filter((track) => {
        const status = String(track?.status || "");
        return status === "completed" || status === "skipped";
    }).length;
    if (completed >= totalFiles) {
        return { totalFiles, currentFileNum: totalFiles, completed: totalFiles };
    }
    const downloadingIndex = tracks.findIndex((track) => String(track?.status || "") === "downloading");
    if (downloadingIndex >= 0) {
        return { totalFiles, currentFileNum: downloadingIndex + 1, completed };
    }
    // Next queued/error row, else stay on completed count.
    const nextIndex = tracks.findIndex((track) => {
        const status = String(track?.status || "");
        return status === "queued" || status === "error" || !status;
    });
    if (nextIndex >= 0) {
        return { totalFiles, currentFileNum: nextIndex + 1, completed };
    }
    return { totalFiles, currentFileNum: Math.min(totalFiles, completed), completed };
}

export type ProviderAlbumFallbackTrackRow = {
    provider_id: string;
    title: string | null;
    version: string | null;
    track_number: number | null;
    volume_number: number | null;
};

/**
 * Last-resort tracklist for an album job whose canonical tracklist is unknown:
 * the provider release's own member tracks.
 *
 * Album membership is a ProviderEditionMembers occurrence, and a member's
 * canonical track comes from the accepted ProviderTrackMatches edge on that
 * occurrence — never from MBID shadow columns on the item, which no longer
 * exist. The release is resolved by the full provider identity (provider +
 * entity_type + provider_id), because a provider id alone is not unique across
 * providers.
 *
 * Emitted numbers stay canonical-only. The member's own medium/position is used
 * solely to order rows that have no accepted match, which beats lexical
 * provider-id order without ever becoming a track number.
 */
export function listProviderAlbumFallbackTracks(
    database: { prepare: (sql: string) => { all: (...args: any[]) => unknown[] } },
    input: { provider: string; providerAlbumId: string; releaseMbid: string | null },
): ProviderAlbumFallbackTrackRow[] {
    return database.prepare(`
        SELECT
            CAST(pi.provider_id AS TEXT) AS provider_id,
            COALESCE(NULLIF(TRIM(t.title), ''), pi.title) AS title,
            pi.version,
            t.position AS track_number,
            t.medium_position AS volume_number
        FROM ProviderEditionMembers member
        JOIN ProviderItems release_item
            ON release_item.id = member.provider_edition_item_id
           AND release_item.entity_type = 'release'
           AND release_item.provider = ?
           AND CAST(release_item.provider_id AS TEXT) = CAST(? AS TEXT)
        JOIN ProviderItems pi
            ON pi.id = member.member_item_id
           AND pi.entity_type = 'track'
           AND pi.provider = release_item.provider
        LEFT JOIN ProviderTrackMatches track_match
            ON track_match.provider_edition_member_id = member.id
           AND track_match.match_state = 'accepted'
        LEFT JOIN Tracks t
            ON t.id = track_match.track_id
           AND t.release_mbid = ?
        ORDER BY
            COALESCE(t.medium_position, member.medium_position, 1),
            COALESCE(t.position, member.position, 999999),
            pi.provider_id
    `).all(input.provider, input.providerAlbumId, input.releaseMbid) as ProviderAlbumFallbackTrackRow[];
}

/**
 * Normalize a reported or catalog track title for matching: drop a leading
 * "Artist - " prefix (import filenames), lowercase, and reduce punctuation
 * to spaces so "Save My Love - Acoustic Version" matches
 * "Save My Love (Acoustic Version)". Keep in sync with the client-side copy
 * in QueueStatusProvider.
 */
export function normalizeTrackTitleForMatch(value: string): string {
    return value
        .toLowerCase()
        .replace(/^[^-]+\s-\s/, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/**
 * Apply provider-reported per-title statuses to catalog track rows. Reported
 * titles are "<track title> <quality suffix>" (downloads) or file-derived
 * names (imports); match normalized prefixes and prefer the longest (most
 * specific) catalog title. Returns null when nothing matched so the caller
 * can fall back to index-based inference.
 */
export function applyTrackStatusByTitle<T extends QueueTrackRow>(
    tracks: T[],
    statusByTitle: Record<string, string>,
): T[] | null {
    const updates = new Map<number, string>();
    for (const [reportedTitle, status] of Object.entries(statusByTitle)) {
        const reported = normalizeTrackTitleForMatch(reportedTitle);
        if (!reported) continue;
        let bestIdx = -1;
        let bestLen = 0;
        tracks.forEach((track, idx) => {
            const title = normalizeTrackTitleForMatch(String(track.title || ""));
            if (title && (reported.startsWith(title) || title.startsWith(reported)) && title.length > bestLen) {
                bestIdx = idx;
                bestLen = title.length;
            }
        });
        if (bestIdx >= 0) {
            updates.set(bestIdx, status);
        }
    }

    if (updates.size === 0) {
        return null;
    }

    return tracks.map((track, idx) => {
        const status = updates.get(idx);
        if (!status) return track;
        // Never regress a row that already finished.
        if (track.status === 'completed' && status !== 'completed') return track;
        return { ...track, status };
    });
}

export function formatQueueTimestamp(value: unknown): string {
    if (!value) return "unknown";
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return "unknown";
    return date.toISOString();
}

type DownloadCommand = DownloadTrackCommand | DownloadVideoCommand | DownloadAlbumCommand;
type DownloadJobType = Extract<DownloadMediaType, 'track' | 'video' | 'album'>;

export function applyFallbackOfferToPayload(
    payload: DownloadCommand,
    type: DownloadJobType,
    offer: RankedDownloadOffer,
): DownloadCommand {
    let url: string | null = null;
    try {
        url = buildStreamingMediaUrl(type, offer.providerId, offer.provider);
    } catch {
        // A URL belongs to the provider that minted it. Clearing it is safer
        // than describing the fallback provider with the failed provider's URL.
    }
    return {
        ...payload,
        provider: offer.provider,
        streamingSource: offer.provider,
        providerId: offer.providerId,
        quality: offer.quality ?? null,
        url,
    } as unknown as DownloadCommand;
}
type DownloadOrImportCommand = DownloadCommand | ImportDownloadCommand;

/** State for a single in-flight download slot (keyed by command id). */
type ActiveDownload = {
    provider: string;
    type: DownloadJobType;
    providerId: string;
    /** Opaque ownership token for this exact durable execution attempt. */
    workerId: string;
    abortController: AbortController;
    downloadPath?: string;
    cancelRequested: boolean;
};

const MAX_RETRY_ATTEMPTS = readIntEnv('DISCOGENIUS_DOWNLOAD_MAX_RETRY_ATTEMPTS', 3, 1);
const BUSY_LOG_THROTTLE_MS = readIntEnv('DISCOGENIUS_DOWNLOAD_BUSY_LOG_THROTTLE_MS', 30_000, 0);
const MAX_CONCURRENT_IMPORTS = readIntEnv('DISCOGENIUS_MAX_CONCURRENT_IMPORTS', 2, 1);
const MAX_CONCURRENT_DOWNLOADS = readIntEnv('DISCOGENIUS_MAX_CONCURRENT_DOWNLOADS', 2, 1);
const DOWNLOAD_LEASE_MS = readIntEnv('DISCOGENIUS_DOWNLOAD_LEASE_MS', 90_000, 1_000);
const DOWNLOAD_HEARTBEAT_MS = readIntEnv(
    'DISCOGENIUS_DOWNLOAD_HEARTBEAT_MS',
    Math.max(1_000, Math.floor(DOWNLOAD_LEASE_MS / 3)),
    250,
);
const DOWNLOAD_NO_PROGRESS_MS = readIntEnv(
    'DISCOGENIUS_DOWNLOAD_NO_PROGRESS_MS',
    30 * 60_000,
    1_000,
);
const DOWNLOAD_WATCHDOG_MS = readIntEnv('DISCOGENIUS_DOWNLOAD_WATCHDOG_MS', 30_000, 250);
const DOWNLOAD_RECOVERY_MAX_ATTEMPTS = readIntEnv(
    'DISCOGENIUS_DOWNLOAD_RECOVERY_MAX_ATTEMPTS',
    3,
    1,
);
const DOWNLOAD_RECOVERY_RETRY_MS = readIntEnv(
    'DISCOGENIUS_DOWNLOAD_RECOVERY_RETRY_MS',
    5_000,
    0,
);
export const DOWNLOAD_WORKER_MARKER = "discogeniusDownloadWorker" as const;

type DurableImportHandoff = {
    importPayload: ImportDownloadCommand;
    resolved: { title: string; artist: string; cover: string | null };
    executionStartedAt?: string | null;
};

type InterruptedDownloadRow = {
    id: number;
    name: (typeof DOWNLOAD_OR_IMPORT_COMMAND_NAMES)[number];
    worker_id: string | null;
    attempt: number;
    payload: string | Record<string, unknown> | null;
};

function parseCommandPayload(value: InterruptedDownloadRow['payload']): Record<string, any> {
    if (!value) return {};
    if (typeof value === 'object') return value as Record<string, any>;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function isUnsafeInterruptedImport(payload: Record<string, any>): boolean {
    const state = String(payload.downloadState?.state || '');
    const handoff = payload.downloadImportHandoff as DurableImportHandoff | undefined;
    return state === 'importing' || Boolean(handoff?.executionStartedAt);
}

/**
 * Recover attempts owned by a dead dedicated download worker.
 *
 * Provider downloads and not-yet-started import handoffs are resumable. An
 * import that may already have moved/tagged bytes is deliberately failed
 * closed until the media lifecycle has an operation journal; replaying it
 * automatically could double-import or overwrite files.
 */
export function recoverInterruptedDownloadAttempts(
    reason: string,
    now: Date = new Date(),
): { requeued: number; failed: number; ignored: number } {
    const rows = db.prepare(`
        SELECT id, name, worker_id, attempt, payload
        FROM commands
        WHERE status = 'started'
          AND name IN (${DOWNLOAD_OR_IMPORT_COMMAND_NAMES.map(() => '?').join(',')})
        ORDER BY id ASC
    `).all(...DOWNLOAD_OR_IMPORT_COMMAND_NAMES) as InterruptedDownloadRow[];

    let requeued = 0;
    let failed = 0;
    let ignored = 0;

    for (const row of rows) {
        const payload = parseCommandPayload(row.payload);
        const owner = row.worker_id || `download-restart-recovery:${row.id}:${randomUUID()}`;
        if (!row.worker_id) {
            const adopted = db.prepare(`
                UPDATE commands
                SET worker_id = ?
                WHERE id = ? AND status = 'started' AND worker_id IS NULL
            `).run(owner, row.id);
            if (adopted.changes === 0) {
                ignored += 1;
                continue;
            }
        }

        const unsafeImport = isUnsafeInterruptedImport(payload);
        const recovery = CommandQueueManager.recoverOwnedCommand({
            id: row.id,
            workerId: owner,
            reason: unsafeImport
                ? `${reason}; import execution may have partially mutated library files and was not replayed`
                : reason,
            // Setting maxAttempts to the current attempt makes the recovery API
            // take its visible poison/fail branch for unsafe partial imports.
            maxAttempts: unsafeImport
                ? Math.max(1, Number(row.attempt) || 1)
                : DOWNLOAD_RECOVERY_MAX_ATTEMPTS,
            retryDelayMs: unsafeImport ? 0 : DOWNLOAD_RECOVERY_RETRY_MS,
            now,
        });
        if (recovery.outcome === 'requeued') requeued += 1;
        else if (recovery.outcome === 'failed') failed += 1;
        else ignored += 1;
    }

    return { requeued, failed, ignored };
}

// Docker: tiddl/ffmpeg installed globally via Dockerfile. Local dev resolves them from PATH (TIDDL_BIN override supported).

/**
 * Enhanced Download Processor with real-time progress tracking
 * Emits events for SSE streaming to frontend
 */

/** States that must be flushed to DB immediately (terminal / transition states). */
const IMMEDIATE_FLUSH_STATES = new Set<string>([
    'completed', 'failed', 'importFailed', 'importPending', 'importing',
]);

/** Minimum interval between DB writes for a single job's progress (ms). */
const PROGRESS_WRITE_INTERVAL_MS = 1_000;

export class DownloadProcessor {
    private isPaused: boolean = process.env.DISCOGENIUS_START_PAUSED === '1';
    private pollTimer?: NodeJS.Timeout;
    private heartbeatTimer?: NodeJS.Timeout;
    private lastBusyLogAt: number = 0;
    private queueEventsSubscribed: boolean = false;

    /**
     * Active download slots keyed by command id. Up to MAX_CONCURRENT_DOWNLOADS
     * run at once, but never two on the same provider — same-provider downloads
     * stay serialized to avoid rate-limit / auth contention (e.g. a YouTube
     * video can run alongside a TIDAL album, but two TIDAL albums do not).
     */
    private activeDownloads = new Map<number, ActiveDownload>();

    /** Tracks the active import phase per command (runs in its own slot alongside downloads, Tidarr-style). */
    private activeImports = new Map<number, {
        providerId: string;
        type: string;
        workerId: string;
        promise: Promise<void>;
    }>();
    private explicitlyCancelledDownloads = new Set<number>();
    /** Attempt owner retained across download → pending import → active import. */
    private attemptOwners = new Map<number, string>();

    // Download commands whose download phase finished and are waiting for an
    // import slot. The command stays 'started' throughout (one queue entity
    // spanning download → import, Lidarr TrackedDownload-style); it only leaves
    // the active queue for History when the import completes/fails. Rebuilt from
    // scratch on restart — interrupted commands are re-queued by crash recovery.
    private pendingImports: Array<{
        commandId: number;
        providerId: string;
        type: DownloadJobType;
        importPayload: ImportDownloadCommand;
        resolved: { title: string; artist: string; cover: string | null };
        workerId: string;
    }> = [];

    // ── Progress write coalescing ───────────────────────────────────
    // Buffers the latest in-flight progress state per job and flushes
    // to SQLite at most once per PROGRESS_WRITE_INTERVAL_MS, reducing
    // DB round-trips from every CLI progress tick to ≤1/s per job.
    // Terminal states (completed/failed/…) always flush immediately.
    private progressBuffer = new Map<number, {
        workerId?: string;
        state: Parameters<DownloadProcessor['writeDownloadState']>[1];
    }>();
    private progressFlushTimer?: NodeJS.Timeout;
    private lastProgressBusyLogAt: number = 0;

    private scheduleNext(): void {
        setImmediate(() => {
            this.processQueue().catch((error) => {
                console.error('[DOWNLOAD-PROCESSOR] Error scheduling next queue item:', error);
            });
        });
    }

    private startHeartbeatLoop(): void {
        if (this.heartbeatTimer) return;
        this.heartbeatTimer = setInterval(() => {
            this.renewOwnedAttemptLeases();
        }, DOWNLOAD_HEARTBEAT_MS);
        this.heartbeatTimer.unref();
    }

    private renewOwnedAttemptLeases(now: Date = new Date()): void {
        const owned = new Map<number, string>();
        for (const [commandId, entry] of this.activeDownloads) {
            owned.set(commandId, entry.workerId);
        }
        for (const [commandId, entry] of this.activeImports) {
            if (entry.workerId) owned.set(commandId, entry.workerId);
        }
        for (const entry of this.pendingImports) {
            owned.set(entry.commandId, entry.workerId);
        }

        for (const [commandId, workerId] of owned) {
            if (CommandQueueManager.renewLease(
                commandId,
                workerId,
                DOWNLOAD_LEASE_MS,
                now,
            )) {
                continue;
            }

            // Ownership was retired by cancellation/recovery. Provider work
            // can be aborted; import callbacks are ownership-guarded and the
            // main watchdog terminates this worker before retrying anything.
            const download = this.activeDownloads.get(commandId);
            if (download) {
                download.cancelRequested = true;
                download.abortController.abort();
            }
        }
    }

    private makeAttemptOwner(commandId: number): string {
        return `download-attempt:${process.pid}:${commandId}:${randomUUID()}`;
    }

    private claimDownloadJob(job: CommandModel): CommandModel | null {
        const workerId = this.makeAttemptOwner(job.id);
        const claimed = CommandQueueManager.claimForExecution(
            job.id,
            workerId,
            DOWNLOAD_LEASE_MS,
        );
        if (!claimed) return null;
        this.attemptOwners.set(job.id, workerId);
        return claimed;
    }

    private clearAttempt(commandId: number, workerId?: string): void {
        if (!workerId || this.attemptOwners.get(commandId) === workerId) {
            this.attemptOwners.delete(commandId);
        }
        const buffered = this.progressBuffer.get(commandId);
        if (!workerId || buffered?.workerId === workerId) {
            this.progressBuffer.delete(commandId);
        }
    }

    /**
     * Fire-and-forget an import job. Runs in a dedicated import slot alongside
     * the download slot (Lidarr/Tidarr-style: 1 download + 1 import in parallel).
     */
    private dispatchImportPhase(entry: {
        commandId: number;
        providerId: string;
        type: DownloadJobType;
        importPayload: ImportDownloadCommand;
        resolved: { title: string; artist: string; cover: string | null };
        workerId?: string;
    }): void {
        const { commandId, providerId, type, importPayload, resolved } = entry;

        const command = CommandQueueManager.get(commandId);
        const workerId = entry.workerId || command?.worker_id || this.attemptOwners.get(commandId);
        if (
            !command
            || command.status !== 'started'
            || (workerId && command.worker_id && command.worker_id !== workerId)
        ) {
            // Never let a retired attempt delete a workspace now owned by a
            // replacement. Explicit cancellation performs its own safe cleanup.
            this.scheduleNext();
            return;
        }
        if (workerId) this.attemptOwners.set(commandId, workerId);

        console.log(`[DOWNLOAD-PROCESSOR] Importing command #${commandId}: ${type} ${providerId} (${this.activeImports.size + 1}/${MAX_CONCURRENT_IMPORTS} slots)`);

        const emitImportProgress = (state: Parameters<typeof this.persistDownloadState>[1]) => {
            this.persistDownloadState(commandId, state, workerId);
            const currentJob = CommandQueueManager.get(commandId);
            const currentDownloadState = (currentJob?.payload?.downloadState as DownloadStatePayload | undefined) ?? {};
            const tracks = state.tracks ?? currentDownloadState.tracks;
            downloadEvents.emitProgress(commandId, {
                providerId,
                type,
                quality: importPayload?.quality ?? null,
                title: resolved.title,
                artist: resolved.artist,
                cover: resolved.cover,
                progress: state.progress !== undefined
                    ? state.progress
                    : (currentJob?.progress ?? null),
                currentFileNum: state.currentFileNum,
                totalFiles: state.totalFiles,
                currentTrack: state.currentTrack,
                currentProviderTrackId: state.currentProviderTrackId,
                currentTrackNum: state.currentTrackNum,
                currentVolumeNum: state.currentVolumeNum,
                trackProgress: state.trackProgress,
                trackStatus: state.trackStatus,
                statusMessage: state.statusMessage,
                state: state.state,
                tracks,
            });
        };

        // The import runs the ImportDownload handler on the same command id.
        // We pass a transient job whose NAME selects the import handler on the
        // worker (or the inline import service), while the persisted command row
        // stays the DownloadAlbum/Track/Video command in its import phase — so
        // there is exactly one queue entity for the whole lifecycle.
        const importJob = {
            ...command,
            name: CommandNames.ImportDownload,
            payload: importPayload,
        } as CommandModelOf<typeof CommandNames.ImportDownload>;

        const isCancelled = () => {
            return this.explicitlyCancelledDownloads.has(commandId);
        };

        const importPromise = (async () => {
            try {
                const handoff: DurableImportHandoff = {
                    importPayload,
                    resolved,
                    executionStartedAt: new Date().toISOString(),
                };
                const phaseUpdate = CommandQueueManager.updateState(commandId, {
                    workerId,
                    payloadPatch: { downloadImportHandoff: handoff } as any,
                    progressPhase: 'importing',
                    blockedReason: 'waiting on disk',
                });
                if (!phaseUpdate) {
                    throw new Error('Import attempt lost durable ownership before execution');
                }
                this.persistDownloadState(commandId, {
                    state: 'importing',
                    statusMessage: 'Importing downloaded media',
                }, workerId);

                if (CommandWorkerPool.isActive()) {
                    // Run the heavy import (metadata parse + matching + tagging +
                    // sync DB writes) on a worker thread so it never blocks the
                    // main thread's HTTP/SSE loop. Progress streams back via the
                    // bridge to the same emitImportProgress sink used inline.
                    await CommandWorkerPool.run(importJob, {
                        onProgress: (state: any) => emitImportProgress(state as Parameters<typeof emitImportProgress>[0]),
                        leaseMs: DOWNLOAD_LEASE_MS,
                        heartbeatMs: DOWNLOAD_HEARTBEAT_MS,
                    });
                } else {
                    await DownloadedTracksImportService.process(importJob, {
                        updateState: emitImportProgress,
                        isCancelled,
                    });
                }

                if (!CommandQueueManager.complete(commandId, workerId)) {
                    console.warn(`[DOWNLOAD-PROCESSOR] Ignoring late import completion for retired attempt ${workerId || 'legacy'} on command #${commandId}`);
                    return;
                }
                const waitJobId = DownloadWaitQueue.finishClaimed(commandId);
                this.activeImports.delete(commandId);
                this.clearAttempt(commandId, workerId);
                downloadEvents.emitCompleted(commandId, {
                    providerId,
                    type,
                    quality: importPayload?.quality ?? null,
                    title: resolved.title,
                    artist: resolved.artist,
                    cover: resolved.cover,
                }, waitJobId);
                console.log(`[DOWNLOAD-PROCESSOR] Completed download+import for ${type} ${providerId} (command #${commandId})`);
            } catch (error: any) {
                if (error?.name === 'ImportDownloadCancelledError' || error?.constructor?.name === 'ImportDownloadCancelledError') {
                    console.log(`[DOWNLOAD-PROCESSOR] Import command #${commandId} cancelled (${error.message})`);
                    CommandQueueManager.cancel(commandId);
                    DownloadWaitQueue.removeByCommandId(commandId);
                    this.clearAttempt(commandId, workerId);
                    
                    const downloadPath = importPayload.path;
                    if (downloadPath) {
                        await this.cleanupDownloadSourcePath(downloadPath);
                    }
                } else {
                    console.error(`[DOWNLOAD-PROCESSOR] Failed to import command #${commandId}:`, error);
                    this.persistDownloadState(commandId, {
                        progress: command.progress,
                        description: `Import: ${error?.message || 'Import failed'}`,
                        statusMessage: error?.message || 'Import failed',
                        state: 'importFailed',
                    }, workerId);
                    const failed = CommandQueueManager.fail(
                        commandId,
                        error?.message || 'Unknown import error',
                        workerId,
                    );
                    if (!failed) {
                        console.warn(`[DOWNLOAD-PROCESSOR] Ignoring late import failure for retired attempt ${workerId || 'legacy'} on command #${commandId}`);
                        return;
                    }
                    this.clearAttempt(commandId, workerId);
                    downloadEvents.emitFailed(commandId, {
                        providerId,
                        type,
                        quality: importPayload?.quality ?? null,
                        title: resolved.title,
                        artist: resolved.artist,
                        cover: resolved.cover,
                        error: error?.message || 'Unknown import error',
                        state: 'importFailed',
                    }, DownloadWaitQueue.getIdByCommandId(commandId));

                    // Preserve staging after an import error. The importer may
                    // already have moved/tagged a subset of files; without an
                    // operation journal, deleting or replaying the remainder is
                    // less safe than failing visibly for operator inspection.
                }
            } finally {
                this.activeImports.delete(commandId);
                const latest = CommandQueueManager.get(commandId);
                if (!latest || latest.status !== 'started' || latest.worker_id !== workerId) {
                    this.clearAttempt(commandId, workerId);
                }
                downloadEvents.emitQueueStatus(this.isPaused);
                // An import slot freed up — check for more pending imports/downloads.
                this.scheduleNext();
            }
        })();

        this.activeImports.set(commandId, {
            providerId,
            type,
            workerId: workerId || '',
            promise: importPromise,
        });
    }

    private logBusy(): void {
        if (BUSY_LOG_THROTTLE_MS <= 0) return;

        const now = Date.now();
        if (now - this.lastBusyLogAt >= BUSY_LOG_THROTTLE_MS) {
            this.lastBusyLogAt = now;
            console.log('[DOWNLOAD-PROCESSOR] Queue poll skipped: another download is still running');
        }
    }

    private async hasDownloadedMediaFiles(downloadPath?: string): Promise<boolean> {
        if (!downloadPath) return false;
        try {
            await fs.promises.access(downloadPath);
        } catch {
            return false;
        }

        const walk = async (dir: string): Promise<boolean> => {
            try {
                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if (await walk(fullPath)) return true;
                        continue;
                    }

                    const ext = path.extname(entry.name).toLowerCase();
                    if (['.flac', '.m4a', '.mp3', '.aac', '.wav', '.ogg', '.opus', '.aif', '.aiff', '.mp4', '.mkv', '.mov', '.m4v', '.webm', '.ts'].includes(ext)) {
                        return true;
                    }
                }
            } catch {
                // Ignore dir read errors
            }
            return false;
        };

        return walk(downloadPath);
    }

    private async cleanupDownloadSourcePath(downloadPath?: string): Promise<void> {
        if (!downloadPath) {
            return;
        }

        try {
            await fs.promises.rm(downloadPath, { recursive: true, force: true });
            console.log(`[DOWNLOAD-PROCESSOR] Cleaned up download source path: ${downloadPath}`);
            // job_* is gone; prune empty provider/id/type parents so /downloads does not bloat.
            removeEmptyParents(path.dirname(downloadPath), Config.getDownloadPath());
        } catch {
            // ignore cleanup errors
        }
    }

    private parseProviderData(value: unknown): Record<string, unknown> {
        if (!value) return {};
        if (typeof value === 'object' && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
        if (typeof value !== 'string') return {};

        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed as Record<string, unknown>
                : {};
        } catch {
            return {};
        }
    }

    private pickNestedString(record: Record<string, unknown>, key: string): string | null {
        const value = record[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            return String(value);
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            return trimmed.length > 0 ? trimmed : null;
        }
        return null;
    }

    private resolvePayloadProvider(payload?: DownloadCommand): string {
        return resolvePayloadProviderFromMetadata(payload);
    }

    private resolveCanonicalProviderOffer(
        providerId: string,
        type: DownloadJobType,
        payload?: DownloadCommand,
    ) {
        return resolveCanonicalProviderOfferFromMetadata(providerId, type, payload);
    }

    private hasAlbumMetadataReady(albumId: string, payload?: DownloadCommand): boolean {
        return hasAlbumMetadataReadyFromModule(albumId, payload);
    }

    private hasTrackMetadataReady(trackId: string, payload?: DownloadCommand): boolean {
        return hasTrackMetadataReadyFromModule(trackId, payload);
    }

    private hasVideoMetadataReady(videoId: string, payload?: DownloadCommand): boolean {
        return hasVideoMetadataReadyFromModule(videoId, payload);
    }

    private async ensureMetadataReady(
        providerId: string,
        type: 'track' | 'video' | 'album',
        payload?: DownloadCommand,
    ): Promise<void> {
        return ensureDownloadMetadataReady(providerId, type, payload);
    }

    private resolveDownloadMetadata(
        providerId: string,
        type: DownloadJobType,
        payload: DownloadCommand,
    ): Required<ResolvedDownloadMetadata> {
        return resolveDownloadMetadataFromModule(providerId, type, payload);
    }

    private resolveDownloadQuality(
        providerId: string,
        type: DownloadJobType,
        payload: DownloadCommand,
    ): string | null {
        return resolveDownloadQualityFromModule(providerId, type, payload);
    }

    private getCanonicalAlbumDownloadProgress(
        providerId: string,
        payload: DownloadCommand,
    ): { total: number; done: number } | null {
        return getCanonicalAlbumDownloadProgressFromMetadata(providerId, payload);
    }

    private isCanonicalProviderItemDownloaded(
        providerId: string,
        type: Extract<DownloadJobType, 'track' | 'video'>,
        payload: DownloadCommand,
    ): boolean {
        return isCanonicalProviderItemDownloadedFromMetadata(providerId, type, payload);
    }

    private persistDownloadState(commandId: number, state: {
        progress?: number | null;
        description?: string;
        currentFileNum?: number;
        totalFiles?: number;
        currentTrack?: string;
        currentProviderTrackId?: string;
        currentTrackNum?: number;
        currentVolumeNum?: number;
        trackProgress?: number;
        trackStatus?: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';
        trackStatusByProviderTrackId?: Record<string, 'queued' | 'downloading' | 'completed' | 'error' | 'skipped'>;
        trackStatusByTitle?: Record<string, 'queued' | 'downloading' | 'completed' | 'error' | 'skipped'>;
        statusMessage?: string;
        state?: 'queued' | 'downloading' | 'completed' | 'failed' | 'paused' | 'importPending' | 'importing' | 'importFailed';
        speed?: string;
        eta?: string;
        size?: number;
        sizeleft?: number;
        tracks?: { title: string; trackNum?: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped'; providerTrackId?: string }[];
        outcome?: 'ok' | 'completedWithWarning';
        warningMessage?: string;
        primaryProvider?: string;
        fallbackProvider?: string;
    }, workerId: string | undefined = this.attemptOwners.get(commandId)) {
        // Merge into any buffered snapshot instead of replacing it: progress
        // events are partial (a per-track update carries no statusMessage; a
        // status line carries no trackProgress), and only the state present at
        // the flush tick gets written. Replacement would let a later generic
        // line wipe the per-track fields before they ever persist.
        const bufferedEntry = this.progressBuffer.get(commandId);
        const buffered = bufferedEntry && bufferedEntry.workerId === workerId
            ? bufferedEntry.state
            : undefined;
        const merged: Record<string, unknown> = buffered ? { ...buffered } : {};
        // A new current track invalidates the previous track's progress; don't
        // let the old percent bleed onto the next track.
        if (
            (state.currentProviderTrackId !== undefined && state.currentProviderTrackId !== merged.currentProviderTrackId)
            || (state.currentProviderTrackId === undefined && state.currentTrack !== undefined && state.currentTrack !== merged.currentTrack)
        ) {
            delete merged.trackProgress;
            delete merged.trackStatus;
        }
        for (const [key, value] of Object.entries(state)) {
            if (value !== undefined) {
                merged[key] = value;
            }
        }
        // Accumulate per-title statuses across the buffer window: tiddl runs
        // parallel downloads, so several tracks can change state between two
        // flushes and only the latest scalar snapshot would survive otherwise.
        if (state.currentProviderTrackId && state.trackStatus) {
            const bufferedById = (buffered as { trackStatusByProviderTrackId?: Record<string, string> } | undefined)?.trackStatusByProviderTrackId;
            merged.trackStatusByProviderTrackId = {
                ...bufferedById,
                [state.currentProviderTrackId]: state.trackStatus,
            };
        }
        if (state.currentTrack && state.trackStatus) {
            const bufferedByTitle = (buffered as { trackStatusByTitle?: Record<string, string> } | undefined)?.trackStatusByTitle;
            merged.trackStatusByTitle = {
                ...bufferedByTitle,
                [state.currentTrack]: state.trackStatus,
            };
        }
        const snapshot = merged as typeof state;

        // Terminal / transition states bypass the buffer and write immediately.
        if (state.state && IMMEDIATE_FLUSH_STATES.has(state.state)) {
            // Flush any pending buffered state for this job first so the
            // immediate write always represents the latest snapshot.
            this.progressBuffer.delete(commandId);
            if (!this.tryWriteDownloadState(commandId, snapshot, workerId)) {
                this.progressBuffer.set(commandId, { workerId, state: snapshot });
                this.ensureProgressFlushTimer();
            }
            return;
        }

        // Buffer the latest in-flight progress for this job.
        this.progressBuffer.set(commandId, { workerId, state: snapshot });
        this.ensureProgressFlushTimer();
    }

    private getProgressTracksForEvent(commandId: number, stateTracks?: {
        title: string;
        trackNum?: number;
        status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';
        providerTrackId?: string;
    }[]): {
        title: string;
        trackNum?: number;
        status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';
        providerTrackId?: string;
    }[] | undefined {
        if (stateTracks?.length) {
            return stateTracks;
        }

        const bufferedTracks = this.progressBuffer.get(commandId)?.state.tracks;
        if (Array.isArray(bufferedTracks) && bufferedTracks.length > 0) {
            return bufferedTracks;
        }

        const currentJob = CommandQueueManager.get(commandId);
        const currentDownloadState = (currentJob?.payload?.downloadState as Record<string, unknown> | undefined) || {};
        const storedTracks = currentDownloadState.tracks;
        return Array.isArray(storedTracks) && storedTracks.length > 0
            ? storedTracks as ReturnType<DownloadProcessor['getProgressTracksForEvent']>
            : undefined;
    }

    /** Unconditionally write download state to the database. */
    private writeDownloadState(commandId: number, state: {
        progress?: number | null;
        description?: string;
        currentFileNum?: number;
        totalFiles?: number;
        currentTrack?: string;
        currentProviderTrackId?: string;
        currentTrackNum?: number;
        currentVolumeNum?: number;
        trackProgress?: number;
        trackStatus?: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';
        trackStatusByProviderTrackId?: Record<string, 'queued' | 'downloading' | 'completed' | 'error' | 'skipped'>;
        trackStatusByTitle?: Record<string, 'queued' | 'downloading' | 'completed' | 'error' | 'skipped'>;
        statusMessage?: string;
        state?: 'queued' | 'downloading' | 'completed' | 'failed' | 'paused' | 'importPending' | 'importing' | 'importFailed';
        speed?: string;
        eta?: string;
        size?: number;
        sizeleft?: number;
        tracks?: { title: string; trackNum?: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped'; providerTrackId?: string }[];
        outcome?: 'ok' | 'completedWithWarning';
        warningMessage?: string;
        primaryProvider?: string;
        fallbackProvider?: string;
    }, workerId?: string) {
        const currentJob = CommandQueueManager.get(commandId);
        const currentDownloadState = (currentJob?.payload?.downloadState as Record<string, unknown> | undefined) || {};

        let mergedTracks = state.tracks ?? currentDownloadState.tracks as any[];

        // Prefer provider-id updates from the tiddl wrapper. Title-level
        // updates remain as a fallback for legacy/partial progress events
        // because tiddl downloads tracks in parallel, so
        // "rows before currentFileNum are complete" mismarks in-flight rows).
        // Fall back to currentFileNum index inference only when the provider
        // count matches the catalog tracklist length.
        const providerAdjustedTracks = mergedTracks && state.trackStatusByProviderTrackId
            ? applyTrackStatusByProviderId(mergedTracks, state.trackStatusByProviderTrackId)
            : null;
        const titleAdjustedTracks = !providerAdjustedTracks && mergedTracks && state.trackStatusByTitle
            ? applyTrackStatusByTitle(mergedTracks, state.trackStatusByTitle)
            : null;

        const catalogLen = Array.isArray(mergedTracks) ? mergedTracks.length : 0;
        const incomingTotal = typeof state.totalFiles === "number" && state.totalFiles > 0
            ? state.totalFiles
            : null;
        const providerCountsMatchCatalog = catalogLen > 0
            && incomingTotal != null
            && incomingTotal === catalogLen;

        if (mergedTracks && state.state === 'completed') {
            // Terminal post-import completion only.
            mergedTracks = mergedTracks.map((track: any) => ({
                ...track,
                status: track.status === 'error' || track.status === 'skipped' ? track.status : 'completed',
            }));
        } else if (providerAdjustedTracks) {
            mergedTracks = providerAdjustedTracks;
        } else if (titleAdjustedTracks) {
            mergedTracks = titleAdjustedTracks;
        } else if (mergedTracks && providerCountsMatchCatalog && typeof state.currentFileNum === 'number') {
            const currentNum = state.currentFileNum;
            const statusState = state.state;
            mergedTracks = mergedTracks.map((t: any, idx: number) => {
                const trackIdx = idx + 1;
                let newStatus = t.status;
                if (trackIdx < currentNum) newStatus = 'completed';
                else if (trackIdx === currentNum && state.trackStatus === 'completed') newStatus = 'completed';
                else if (
                    trackIdx === currentNum
                    && (
                        statusState === 'downloading'
                        || statusState === 'importing'
                        || statusState === 'importPending'
                        || state.trackStatus === 'downloading'
                    )
                ) newStatus = 'downloading';
                return { ...t, status: newStatus };
            });
        }

        const catalogProgress = deriveCatalogFileProgress(mergedTracks);
        const nextTotalFiles = catalogProgress?.totalFiles
            ?? state.totalFiles
            ?? currentDownloadState.totalFiles;
        const nextCurrentFileNum = catalogProgress?.currentFileNum
            ?? (providerCountsMatchCatalog ? state.currentFileNum : undefined)
            ?? currentDownloadState.currentFileNum;
        // Catalog fraction owns album %, with optional in-file boost for the
        // active catalog row. Provider queue % is only trusted when counts match.
        // Explicit null means "unknown" — do not revive a prior fake percent.
        let nextProgress: number | null | undefined = state.progress !== undefined
            ? state.progress
            : (typeof currentDownloadState.progress === "number" || currentDownloadState.progress === null
                ? currentDownloadState.progress as number | null
                : undefined);
        if (catalogProgress && catalogProgress.totalFiles > 0) {
            if (providerCountsMatchCatalog && typeof state.progress === "number") {
                nextProgress = state.progress;
            } else {
                const base = catalogProgress.completed / catalogProgress.totalFiles;
                const trackFrac = typeof state.trackProgress === "number"
                    ? Math.min(1, Math.max(0, state.trackProgress / 100))
                    : 0;
                const inFlight = catalogProgress.currentFileNum > catalogProgress.completed
                    ? trackFrac / catalogProgress.totalFiles
                    : 0;
                nextProgress = Math.min(100, Math.round((base + inFlight) * 100));
            }
        }
        const payloadPatch: Record<string, unknown> = {
            downloadState: {
                ...currentDownloadState,
                progress: nextProgress,
                currentFileNum: nextCurrentFileNum,
                totalFiles: nextTotalFiles,
                currentTrack: state.currentTrack ?? currentDownloadState.currentTrack,
                currentProviderTrackId: state.currentProviderTrackId ?? currentDownloadState.currentProviderTrackId,
                currentTrackNum: state.currentTrackNum ?? currentDownloadState.currentTrackNum,
                currentVolumeNum: state.currentVolumeNum ?? currentDownloadState.currentVolumeNum,
                trackProgress: state.trackProgress ?? currentDownloadState.trackProgress,
                trackStatus: state.trackStatus ?? currentDownloadState.trackStatus,
                statusMessage: state.statusMessage ?? currentDownloadState.statusMessage,
                state: state.state ?? currentDownloadState.state,
                speed: state.speed ?? currentDownloadState.speed,
                eta: state.eta ?? currentDownloadState.eta,
                size: state.size ?? currentDownloadState.size,
                sizeleft: state.sizeleft ?? currentDownloadState.sizeleft,
                tracks: mergedTracks,
                outcome: state.outcome ?? currentDownloadState.outcome,
                warningMessage: state.warningMessage ?? currentDownloadState.warningMessage,
                primaryProvider: state.primaryProvider ?? currentDownloadState.primaryProvider,
                fallbackProvider: state.fallbackProvider ?? currentDownloadState.fallbackProvider,
            },
        };

        if (state.description) {
            payloadPatch.description = state.description;
        }

        const phase = state.state === 'importPending'
            ? 'waiting to import'
            : state.state === 'importing'
                ? 'importing'
                : state.state === 'downloading'
                    ? 'downloading'
                    : state.state;
        const progressChanged = state.progress !== undefined
            && state.progress !== currentJob?.progress;
        const phaseChanged = phase !== undefined
            && phase !== currentJob?.progress_phase;
        const positionChanged = nextCurrentFileNum !== currentDownloadState.currentFileNum
            || nextTotalFiles !== currentDownloadState.totalFiles
            || state.trackStatus !== undefined
                && state.trackStatus !== currentDownloadState.trackStatus;
        const blockedReason = state.state === 'importPending'
            ? 'waiting on import slot'
            : state.state === 'downloading'
                ? 'waiting on provider'
                : state.state === 'importing'
                    ? 'waiting on disk'
                    : state.state === 'failed' || state.state === 'importFailed'
                        ? 'failed'
                        : undefined;

        CommandQueueManager.updateState(commandId, {
            progress: progressChanged ? state.progress : undefined,
            payloadPatch,
            workerId,
            progressPhase: phaseChanged ? phase : undefined,
            progressCurrent: positionChanged
                ? (typeof nextProgress === 'number' ? nextProgress : currentJob?.progress ?? 0)
                : undefined,
            progressTotal: positionChanged ? 100 : undefined,
            blockedReason,
        });
    }

    private tryWriteDownloadState(
        commandId: number,
        state: Parameters<DownloadProcessor['writeDownloadState']>[1],
        workerId?: string,
    ): boolean {
        try {
            this.writeDownloadState(commandId, state, workerId);
            return true;
        } catch (error) {
            if (!isSqliteBusyError(error)) {
                throw error;
            }

            const now = Date.now();
            if (now - this.lastProgressBusyLogAt > 10_000) {
                this.lastProgressBusyLogAt = now;
                console.warn('[DOWNLOAD-PROCESSOR] Progress state write deferred because SQLite is busy');
            }
            return false;
        }
    }

    /** Start the periodic flush timer if not already running. */
    private ensureProgressFlushTimer(): void {
        if (this.progressFlushTimer) return;
        this.progressFlushTimer = setInterval(() => {
            this.flushProgressBuffer();
        }, PROGRESS_WRITE_INTERVAL_MS);
        this.progressFlushTimer.unref(); // Don't keep process alive just for this timer
    }

    /** Flush all buffered progress states to the database. */
    flushProgressBuffer(): void {
        if (this.progressBuffer.size === 0) {
            // Nothing left to flush — stop the timer.
            if (this.progressFlushTimer) {
                clearInterval(this.progressFlushTimer);
                this.progressFlushTimer = undefined;
            }
            return;
        }

        // better-sqlite3 can native-abort (v8::ToLocalChecked Empty MaybeLocal)
        // when stmt.run tries to throw SQLITE_BUSY while a worker holds a
        // multi-second write. Progress is lossy; skip this tick.
        if (isSqliteWriteMutexHeld()) {
            return;
        }

        for (const [commandId, entry] of Array.from(this.progressBuffer)) {
            if (this.tryWriteDownloadState(commandId, entry.state, entry.workerId)) {
                this.progressBuffer.delete(commandId);
            }
        }

        if (this.progressBuffer.size === 0 && this.progressFlushTimer) {
            clearInterval(this.progressFlushTimer);
            this.progressFlushTimer = undefined;
        }
    }

    /**
     * Rebuild durable download→import handoffs after a process/worker restart.
     * Only handoffs that never entered import execution are replayable.
     */
    private claimRecoveredImportHandoffs(): void {
        const available = MAX_CONCURRENT_IMPORTS
            - this.activeImports.size
            - this.pendingImports.length;
        if (available <= 0) return;

        const candidateIds = db.prepare(`
            SELECT id
            FROM commands
            WHERE status = 'queued'
              AND name IN (${DOWNLOAD_COMMAND_NAMES.map(() => '?').join(',')})
              AND (retry_after IS NULL OR julianday(retry_after) <= julianday('now'))
              AND json_valid(payload)
              AND json_extract(payload, '$.downloadState.state') = 'importPending'
            ORDER BY ${buildDurableQueueOrderClause()}
            LIMIT ?
        `).all(...DOWNLOAD_COMMAND_NAMES, available) as Array<{ id: number }>;
        const candidates = candidateIds
            .map((row) => CommandQueueManager.get(row.id))
            .filter((candidate): candidate is CommandModel => candidate != null);
        let claimedCount = 0;
        for (const candidate of candidates) {
            if (claimedCount >= available) break;
            const payload = candidate.payload as Record<string, any>;
            const state = String(payload.downloadState?.state || '');
            const handoff = payload.downloadImportHandoff as DurableImportHandoff | undefined;
            if (
                state !== 'importPending'
                || !handoff?.importPayload
                || handoff.executionStartedAt
            ) {
                continue;
            }

            const claimed = this.claimDownloadJob(candidate);
            if (!claimed) continue;
            const workerId = claimed.worker_id;
            if (!workerId) continue;

            const type: DownloadJobType = candidate.name === CommandNames.DownloadVideo
                ? 'video'
                : candidate.name === CommandNames.DownloadAlbum
                    ? 'album'
                    : 'track';
            this.pendingImports.push({
                commandId: candidate.id,
                providerId: String(
                    handoff.importPayload.providerId
                    || handoff.importPayload.provider
                    || candidate.ref_id
                    || '',
                ),
                type,
                importPayload: handoff.importPayload,
                resolved: handoff.resolved || {
                    title: String(payload.title || 'Unknown'),
                    artist: String(payload.artist || 'Unknown'),
                    cover: payload.cover ?? null,
                },
                workerId,
            });
            this.persistDownloadState(candidate.id, {
                state: 'importPending',
                statusMessage: 'Recovered download; waiting to import',
            }, workerId);
            claimedCount += 1;
        }
    }

    async initialize() {
        console.log('[DOWNLOAD-PROCESSOR] Initializing...');

        // A persisted operator choice wins over the startup default. Persist an
        // env-derived first-start pause so replacement workers and later API
        // restarts observe the same authoritative state.
        const pauseState = getDownloadQueueControlState();
        this.isPaused = pauseState.isPaused;
        if (!pauseState.persisted && this.isPaused) {
            setDownloadQueuePaused(true);
        }

        this.startHeartbeatLoop();

        // Recover durable ownership before any provider initialization can
        // block. No replacement work is dispatched until every old attempt is
        // either safely requeued or visibly failed closed.
        try {
            const recovered = recoverInterruptedDownloadAttempts(
                'Dedicated download worker restarted before the attempt completed',
            );
            if (recovered.requeued || recovered.failed || recovered.ignored) {
                console.warn(
                    '[DOWNLOAD-PROCESSOR] Restart recovery: '
                    + `${recovered.requeued} requeued, ${recovered.failed} failed closed, `
                    + `${recovered.ignored} already retired`,
                );
            }
        } catch (error) {
            console.error('[DOWNLOAD-PROCESSOR] Error during restart recovery:', error);
        }

        // Initialize download backends with current settings
        try {
            await streamingProviderManager.syncProviderCredentials();
            await streamingProviderManager.syncProviderSettings();
            console.log('[DOWNLOAD-PROCESSOR] Download backend settings initialized');
        } catch (error) {
            console.warn('[DOWNLOAD-PROCESSOR] Could not initialize download backend settings:', error);
            // Continue anyway - settings might already be configured
        }

        if (!this.queueEventsSubscribed) {
            appEvents.on(AppEvent.COMMAND_ADDED, (event: CommandEventPayload) => {
                if (DOWNLOAD_OR_IMPORT_COMMAND_NAMES.includes(event.type as (typeof DOWNLOAD_OR_IMPORT_COMMAND_NAMES)[number])) {
                    this.scheduleNext();
                }
            });
            appEvents.on(AppEvent.QUEUE_CLEARED, () => this.scheduleNext());
            this.queueEventsSubscribed = true;
        }

        // The download queue is event-driven, not polled: it runs on app
        // startup, when items are added, and when the previous item finishes.
        await this.processQueue();
    }

    async processQueue(): Promise<void> {
        if (process.env.DISCOGENIUS_DISABLE_DOWNLOADS === '1') {
            return;
        }

        // ── Import slot: imports run alongside downloads (Lidarr/Tidarr pattern) ──
        // Downloads and imports use separate slots so importing never blocks the
        // next download from starting. Import phases belong to download commands
        // that finished downloading (this.pendingImports) — there is no separate
        // ImportDownload queue row.
        this.claimRecoveredImportHandoffs();
        while (this.activeImports.size < MAX_CONCURRENT_IMPORTS && this.pendingImports.length > 0) {
            const entry = this.pendingImports.shift();
            if (!entry) break;
            if (this.activeImports.has(entry.commandId)) continue;
            this.dispatchImportPhase(entry);
        }

        // Pausing blocks new provider downloads, but a download that already
        // reached the safe import handoff may still import. Active imports also
        // finish. This keeps completed bytes from being stranded while the
        // provider-facing queue is paused.
        if (this.isPaused) {
            DownloadWaitQueue.releaseUnstartedClaims();
            return;
        }

        DownloadWaitQueue.recoverOrphanClaims();
        DownloadWaitQueue.dropUnclaimedDownloadCommands();

        // ── Download slots: up to MAX_CONCURRENT_DOWNLOADS in parallel, but at
        // most one per provider (same-provider downloads stay serialized). ──
        // Waiting work lives in DownloadQueue (Lidarr Queue / qBittorrent
        // transfer list). A free slot claims the next wait row into a
        // Download* command (Tidarr). Already-queued Download* commands are
        // only those claimed wait rows; never start a command with no wait row.
        while (this.activeDownloads.size < MAX_CONCURRENT_DOWNLOADS) {
            const activeProviders = new Set<string>();
            for (const entry of this.activeDownloads.values()) {
                activeProviders.add(entry.provider);
            }

            const candidates = CommandQueueManager.getTopPendingJobsByTypes(DOWNLOAD_COMMAND_NAMES, 20);
            let job = candidates.find((candidate) => {
                if (activeProviders.has(this.resolvePayloadProvider(candidate.payload as DownloadCommand))) {
                    return false;
                }
                return DownloadWaitQueue.getByCommandId(candidate.id) != null;
            });

            if (!job) {
                const claimed = DownloadWaitQueue.claimNext(activeProviders);
                if (claimed) {
                    job = CommandQueueManager.get(claimed.commandId) ?? undefined;
                }
            }

            if (!job) {
                if (candidates.length > 0) {
                    this.logBusy();
                }
                break;
            }

            void this.dispatchDownloadPhase(job);
        }
    }

    /**
     * Run one download job to completion in its own slot. Registers the slot in
     * `activeDownloads` synchronously (before the first await) so concurrent
     * scheduling treats the provider as busy, then runs the download and — on
     * success — queues the import phase. Always frees the slot and re-schedules
     * the queue in `finally`.
     */
    private async dispatchDownloadPhase(job: CommandModel): Promise<void> {
        // Check retry limit - if job has exceeded max attempts, fail permanently
        if (job.attempts >= MAX_RETRY_ATTEMPTS) {
            console.warn(`[DOWNLOAD-PROCESSOR] Job #${job.id} exceeded max retries (${job.attempts}/${MAX_RETRY_ATTEMPTS}), marking as permanently failed`);
            CommandQueueManager.fail(job.id, `Exceeded maximum retry attempts (${MAX_RETRY_ATTEMPTS})`);
            // Continue to next job without recursive await chains.
            this.scheduleNext();
            return;
        }

        let providerId = String(
            (job.payload as DownloadCommand | undefined)?.providerId
            || job.payload?.providerId
            || job.ref_id
            || '',
        );
        const type: DownloadJobType = job.name === CommandNames.DownloadVideo
            ? 'video'
            : job.name === CommandNames.DownloadAlbum
                ? 'album'
                : 'track';

        // Validate providerId before processing
        if (!providerId || providerId === 'undefined' || providerId === 'null') {
            console.warn(`[DOWNLOAD-PROCESSOR] Skipping job #${job.id} with invalid providerId: ${providerId}`);
            CommandQueueManager.fail(job.id, `Invalid providerId - cannot download`);
            // Process next item
            this.scheduleNext();
            return;
        }
        let payload = job.payload as DownloadOrImportCommand;

        console.log(`[DOWNLOAD-PROCESSOR] Processing Job #${job.id}: ${job.name} (ref: ${providerId})`);

        const claimedJob = this.claimDownloadJob(job);
        if (!claimedJob) {
            console.log(`[DOWNLOAD-PROCESSOR] Job #${job.id} is no longer pending; skipping dispatch.`);
            this.scheduleNext();
            return;
        }
        job = claimedJob;
        const workerId = claimedJob.worker_id!;

        // Claim the download slot synchronously so the scheduling loop sees this
        // provider as busy before it picks the next job.
        const entry: ActiveDownload = {
            provider: this.resolvePayloadProvider(payload as DownloadCommand),
            type,
            providerId,
            workerId,
            abortController: new AbortController(),
            downloadPath: undefined,
            cancelRequested: false,
        };
        this.activeDownloads.set(job.id, entry);
        console.log(`[DOWNLOAD-PROCESSOR] Download slot ${this.activeDownloads.size}/${MAX_CONCURRENT_DOWNLOADS} for command #${job.id} (${entry.provider})`);

        // Video references dedupe across providers, so payloads (including
        // retried ones persisted before an offer existed) may carry a canonical
        // Recordings id instead of a provider catalog id. Resolve to the
        // preferred provider's VIDEO offer before seeding or downloading.
        if (type === 'video') {
            const payloadProvider = (payload as any)?.streamingSource || (payload as any)?.provider || null;
            if (!isKnownProviderVideoOffer(payloadProvider, providerId)) {
                const offer = resolvePreferredVideoOffer(providerId);
                if (offer) {
                    console.log(`[DOWNLOAD-PROCESSOR] Resolved video reference ${providerId} to ${offer.provider} offer ${offer.providerId}`);
                    providerId = offer.providerId;
                    payload = {
                        ...((payload as DownloadCommand) || {}),
                        provider: offer.provider,
                        streamingSource: offer.provider,
                        providerId: offer.providerId,
                    } as unknown as DownloadOrImportCommand;
                    entry.provider = offer.provider;
                    entry.providerId = providerId;
                }
            }
        }

        let resolved = {
            title: payload?.title || 'Unknown',
            artist: payload?.artist || 'Unknown',
            cover: payload?.cover ?? null,
        };

        try {
            this.persistDownloadState(job.id, {
                progress: 0,
                state: 'queued',
                statusMessage: 'Preparing metadata...',
            });

            await this.ensureMetadataReady(providerId, type, payload as DownloadCommand);

            resolved = this.resolveDownloadMetadata(providerId, type, payload);
            const resolvedQuality = this.resolveDownloadQuality(providerId, type, payload);
            payload = {
                ...((payload as DownloadCommand) || {}),
                title: resolved.title,
                artist: resolved.artist,
                cover: resolved.cover,
                quality: payload.quality ?? resolvedQuality,
            };
            job.payload = payload as DownloadCommand;

            this.persistDownloadState(job.id, {
                progress: 0,
                state: 'downloading',
                statusMessage: 'Starting download...',
            });
            downloadEvents.emitStarted(job.id, {
                providerId,
                type,
                quality: payload.quality ?? null,
                title: resolved.title,
                artist: resolved.artist,
                cover: resolved.cover,
            });

            // Initialize the tracklist for UI indicators from the canonical
            // MusicBrainz release. Provider rows are still used for the hard
            // provider track id, but display text must stay catalog-native.
            // Catalog-anchored enqueue may already have seeded downloadState.tracks
            // (with completed markers for partial libraries) — prefer that.
            const seededTracks = Array.isArray((payload as DownloadAlbumCommand).downloadState?.tracks)
                ? (payload as DownloadAlbumCommand).downloadState!.tracks
                : undefined;
            let initialTracks: DownloadTrackStateEntry[] | undefined = seededTracks;
            try {
                const formatTrackDisplayTitle = (title: string | null | undefined, version?: string | null) => {
                    const baseTitle = String(title || '').trim() || 'Unknown Track';
                    const normalizedVersion = String(version || '').trim();
                    if (!normalizedVersion || baseTitle.toLowerCase().includes(normalizedVersion.toLowerCase())) {
                        return baseTitle;
                    }
                    return `${baseTitle} (${normalizedVersion})`;
                };

                if (!initialTracks?.length) {
                    if (type === 'track' || type === 'video') {
                        initialTracks = [{ title: resolved.title, status: 'queued', providerTrackId: providerId }];
                    } else if (type === 'album') {
                        if (payload.releaseGroupMbid) {
                            const albumTracks = await AlbumQueryService.getAlbumTracks(payload.releaseGroupMbid);
                            initialTracks = albumTracks.map(t => ({
                                title: formatTrackDisplayTitle(t.title, t.version),
                                trackNum: t.track_number,
                                volumeNum: t.volume_number || undefined,
                                status: 'queued' as const,
                                providerTrackId: t.preview_provider_track_id ?? undefined,
                                canonicalTrackMbid: t.musicbrainz_track_id || t.id,
                                canonicalRecordingMbid: t.musicbrainz_recording_id,
                            }));
                        }

                        if (!initialTracks?.length) {
                            // Catalog-first: order/number via Tracks on the canonical release
                            // when known, never via match_evidence disc/track numbers (native
                            // provider-album layout).
                            const fallbackReleaseMbid = String((payload as DownloadAlbumCommand).releaseMbid || '').trim() || null;
                            const providerRows = listProviderAlbumFallbackTracks(db, {
                                provider: this.resolvePayloadProvider(payload),
                                providerAlbumId: String(providerId),
                                releaseMbid: fallbackReleaseMbid,
                            });

                            initialTracks = providerRows.map((row) => ({
                                title: formatTrackDisplayTitle(row.title, row.version),
                                trackNum: row.track_number ?? undefined,
                                volumeNum: row.volume_number || undefined,
                                status: 'queued' as const,
                                providerTrackId: row.provider_id,
                            }));
                        }
                    }
                }
            } catch (error) {
                console.warn(`[DOWNLOAD-PROCESSOR] Failed to fetch initial tracks for job #${job.id}:`, error);
            }

            if (initialTracks && initialTracks.length > 0) {
                this.persistDownloadState(job.id, {
                    tracks: initialTracks,
                    currentFileNum: initialTracks.filter((track) => track.status === 'completed' || track.status === 'skipped').length,
                    totalFiles: initialTracks.length,
                });
            }

            await this.downloadItem(job.id, providerId, type, payload, entry);

            // Check if the item-specific download path has any media files before attempting organization.
            // tiddl may skip all items (already downloaded or unavailable) and exit successfully
            // without producing any new files.
            if (!await this.hasDownloadedMediaFiles(entry.downloadPath)) {
                // The downloader exited 0 but downloaded nothing.
                // Check if content already exists in library — if so, treat as already-imported.
                if (type === 'album') {
                    const row = this.getCanonicalAlbumDownloadProgress(providerId, payload as DownloadCommand);

                    if (payload?.reason !== 'upgrade' && row && row.total > 0 && row.done >= row.total) {
                        // Album already fully present in the library. The downloader
                        // couldn't add anything new (items skipped or unavailable).
                        const pct = Math.round(row.done / row.total * 100);
                        console.log(
                            `[DOWNLOAD-PROCESSOR] Download workspace empty but album ${providerId} already has ${row.done}/${row.total} tracks downloaded (${pct}%). ` +
                            `Treating as complete.`
                        );

                        // Mark undownloadable tracks so the queue doesn't re-queue endlessly
                        updateAlbumDownloadStatus(String(payload.releaseGroupMbid || providerId));

                        if (!CommandQueueManager.complete(job.id, workerId)) return;
                        const waitJobId = DownloadWaitQueue.finishClaimed(job.id);
                        this.clearAttempt(job.id, workerId);
                        await this.cleanupDownloadSourcePath(entry.downloadPath);

                        downloadEvents.emitCompleted(job.id, {
                            providerId, type,
                            quality: payload.quality ?? null,
                            title: resolved.title,
                            artist: resolved.artist,
                            cover: resolved.cover,
                        }, waitJobId);

                        return;
                    }
                } else if (type === 'track' || type === 'video') {
                    const alreadyDownloaded = this.isCanonicalProviderItemDownloaded(providerId, type, payload as DownloadCommand);

                    if (payload?.reason !== 'upgrade' && alreadyDownloaded) {
                        console.log(`[DOWNLOAD-PROCESSOR] Download workspace empty but ${type} ${providerId} is already downloaded — marking job as complete.`);
                        if (!CommandQueueManager.complete(job.id, workerId)) return;
                        const waitJobId = DownloadWaitQueue.finishClaimed(job.id);
                        this.clearAttempt(job.id, workerId);
                        await this.cleanupDownloadSourcePath(entry.downloadPath);

                        downloadEvents.emitCompleted(job.id, {
                            providerId, type,
                            quality: payload.quality ?? null,
                            title: resolved.title,
                            artist: resolved.artist,
                            cover: resolved.cover,
                        }, waitJobId);

                        return;
                    }
                }

                // Nothing in library either — something is genuinely wrong
                throw new Error(
                    `tiddl finished successfully but no files were downloaded for ${type} ${providerId}. ` +
                    `All items may have been skipped (already downloaded or unavailable on TIDAL).`
                );
            }

            const completedDownloadState = (CommandQueueManager.get(job.id)?.payload?.downloadState as DownloadStatePayload | undefined) ?? {};
            const importTracks = resetTracksForImportState(completedDownloadState.tracks ?? initialTracks);

            // Re-read the live queue payload so hybrid trackOffers fallbacks that
            // patched providerTrackIds during download are what organize matches
            // (basename = tip id). The in-memory `payload` can still hold the
            // pre-fallback tip list.
            const liveQueuePayload = CommandQueueManager.get(job.id)?.payload as DownloadAlbumCommand | undefined;
            const resolvedTrackOffers = Array.isArray(liveQueuePayload?.trackOffers)
              ? liveQueuePayload.trackOffers
              : (payload as DownloadAlbumCommand).trackOffers;

            // Download finished — transition THIS command into its import phase.
            // The command stays 'started' (one queue entity spans download →
            // import, Lidarr TrackedDownload-style); it moves to History only when
            // the import completes/fails. No separate ImportDownload row, so the UI
            // shows one row advancing by state instead of a download row vanishing
            // and an import row appearing.
            const importPayload: ImportDownloadCommand = {
                // Source the provider identity from the offer that actually
                // produced the files on disk. On a cross-provider fallback,
                // downloadItem() updates entry.provider/entry.providerId to the
                // used offer (and entry.downloadPath already points at its job
                // folder); the primary payload.provider/providerId are stale, so
                // using them made the organizer scope to the wrong provider's
                // track ids and match zero files (e.g. Deezer ids vs YouTube
                // file basenames). entry.* default to the payload values when no
                // fallback occurred, so this is safe for every download path.
                provider: entry.provider || payload.provider,
                providerId: entry.providerId || payload.providerId || providerId,
                releaseGroupMbid: payload.releaseGroupMbid,
                releaseMbid: payload.releaseMbid,
                canonicalTrackMbid: payload.canonicalTrackMbid,
                canonicalRecordingMbid: payload.canonicalRecordingMbid,
                slot: payload.slot,
                trackNumber: payload.trackNumber ?? null,
                volumeNumber: payload.volumeNumber ?? null,
                trackOffers: resolvedTrackOffers,
                acquisitionMode: (payload as DownloadAlbumCommand).acquisitionMode,
                type,
                path: entry.downloadPath,
                quality: payload.quality ?? null,
                qualityProfile: payload.qualityProfile,
                libraryId: payload.libraryId,
                acquisitionPlanId: payload.acquisitionPlanId,
                title: payload.title,
                artist: payload.artist,
                artists: payload.artists,
                artistId: payload.artistId,
                artist_id: payload.artist_id,
                albumId: payload.albumId,
                album_id: payload.album_id,
                albumTitle: payload.albumTitle,
                album_title: payload.album_title,
                cover: payload.cover,
                url: payload.url,
                resolved,
                downloadState: {
                    outcome: completedDownloadState.outcome,
                    warningMessage: completedDownloadState.warningMessage,
                    primaryProvider: completedDownloadState.primaryProvider,
                    fallbackProvider: completedDownloadState.fallbackProvider,
                },
            } as ImportDownloadCommand;

            const handoff: DurableImportHandoff = {
                importPayload,
                resolved,
                executionStartedAt: null,
            };
            if (!CommandQueueManager.updateState(job.id, {
                workerId,
                payloadPatch: { downloadImportHandoff: handoff } as any,
                progressPhase: 'waiting to import',
                blockedReason: 'waiting on import slot',
            })) {
                throw new Error('Download attempt lost durable ownership before import handoff');
            }

            this.persistDownloadState(job.id, {
                state: 'importPending',
                statusMessage: completedDownloadState.outcome === 'completedWithWarning'
                    && completedDownloadState.warningMessage
                    ? completedDownloadState.warningMessage
                    : 'Waiting to import',
                tracks: importTracks,
                totalFiles: completedDownloadState.totalFiles,
                outcome: completedDownloadState.outcome,
                warningMessage: completedDownloadState.warningMessage,
                primaryProvider: completedDownloadState.primaryProvider,
                fallbackProvider: completedDownloadState.fallbackProvider,
            }, workerId);

            // SSE so the queue UI can leave "Downloading" immediately instead of
            // waiting for the import slot to start (which can be near-instant and
            // look like a flicker, or leave a stale "completed" download state).
            downloadEvents.emitProgress(job.id, {
                providerId,
                type,
                quality: payload.quality ?? null,
                title: resolved.title,
                artist: resolved.artist,
                cover: resolved.cover,
                progress: completedDownloadState.progress ?? 100,
                currentFileNum: 0,
                totalFiles: completedDownloadState.totalFiles ?? importTracks?.length,
                statusMessage: 'Waiting to import',
                state: 'importPending',
                tracks: importTracks,
            });

            this.pendingImports.push({
                commandId: job.id,
                providerId,
                type,
                importPayload,
                resolved,
                workerId,
            });

            // Ownership of the workspace passes to the import phase, which cleans
            // it up after import. Clear the slot pointer so the finally block
            // does not delete this command's files.
            entry.downloadPath = undefined;

            console.log(`[DOWNLOAD-PROCESSOR] Downloaded ${type} ${providerId} — queued import phase for command #${job.id}`);
        } catch (error: any) {
            if (entry.cancelRequested && this.isPaused) {
                const current = CommandQueueManager.get(job.id);
                if (current?.status === 'started' && current.worker_id === workerId) {
                    console.log(`[DOWNLOAD-PROCESSOR] Download job #${job.id} interrupted by pause; returning to queue`);
                    CommandQueueManager.requeuePausedDownload(job.id, workerId);
                    this.clearAttempt(job.id, workerId);
                } else {
                    console.log(`[DOWNLOAD-PROCESSOR] Download job #${job.id} interrupted by pause; keeping status=${current?.status ?? 'unknown'}`);
                }
            } else {
                console.error(`[DOWNLOAD-PROCESSOR] Failed to download job #${job.id}:`, error);
                const currentJob = CommandQueueManager.get(job.id);
                this.persistDownloadState(job.id, {
                    progress: currentJob?.progress ?? job.progress,
                    state: 'failed',
                    statusMessage: error?.message || 'Unknown download error',
                }, workerId);
                const failed = CommandQueueManager.fail(
                    job.id,
                    error?.message || 'Unknown download error',
                    workerId,
                );
                if (!failed) {
                    console.warn(`[DOWNLOAD-PROCESSOR] Ignoring late download failure for retired attempt ${workerId} on command #${job.id}`);
                    return;
                }
                this.clearAttempt(job.id, workerId);

                // Emit failed event
                downloadEvents.emitFailed(job.id, {
                    providerId,
                    type,
                    quality: payload.quality ?? null,
                    title: resolved.title,
                    artist: resolved.artist,
                    cover: resolved.cover,
                    error: error?.message || 'Unknown download error',
                }, DownloadWaitQueue.getIdByCommandId(job.id));
            }

            // Keep the workspace across retries so the downloader resumes and
            // skips already-completed items; permanently failed or explicitly
            // cancelled jobs get their workspace cleaned (incl. empty video trees).
            const jobAttempts = CommandQueueManager.get(job.id)?.attempts ?? job.attempts;
            const cancelled = entry.cancelRequested
                && !this.isPaused
                && this.explicitlyCancelledDownloads.has(job.id);
            if (cancelled || jobAttempts >= MAX_RETRY_ATTEMPTS) {
                await this.cleanupDownloadSourcePath(entry.downloadPath);
            }
        } finally {
            this.activeDownloads.delete(job.id);

            // A download slot freed up — check for more pending downloads/imports.
            this.scheduleNext();
        }
    }

    private async downloadItem(
        commandId: number,
        id: string,
        type: DownloadJobType,
        payload: DownloadCommand,
        entry: ActiveDownload,
    ): Promise<void> {
        const albumPayload = payload as DownloadAlbumCommand;
        const acquisitionMode = albumPayload.acquisitionMode
            || (Array.isArray(albumPayload.trackOffers) && albumPayload.trackOffers.length > 0 ? "trackOffers" : "album");

        if (type === "album" && acquisitionMode === "trackOffers") {
            await this.downloadAlbumTrackOffers(commandId, albumPayload, entry);
            return;
        }

        // Download commands carry the slot's selected provider as `provider`
        // (queue-route payloads may use `streamingSource`); only fall back to
        // the default provider when neither is present.
        let activeProvider = String(
            (payload as any).streamingSource || (payload as any).provider || getDefaultStreamingSource(),
        );
        let activeProviderItemId = String(id);
        const primaryProvider = activeProvider;
        const primaryProviderItemId = activeProviderItemId;
        const triedOffers = new Set<string>([makeOfferAttemptKey(activeProvider, activeProviderItemId)]);
        let usedFallback = false;
        let fallbackProvider: string | null = null;
        let workingPayload = payload;

        const slot = (payload as any).slot || "stereo";
        const capability = type === "video" ? "video" : (slot === "spatial" ? "spatial" : "stereo");
        const controller = entry.abortController;
        const signal = controller.signal;
        const metadataConfig = getConfigSection("metadata");
        const rankedAlternates = this.listFallbackOffersForJob(type, workingPayload, activeProviderItemId);

        const checkCancelInterval = setInterval(() => {
            if (entry.cancelRequested) {
                console.log(`[DOWNLOAD-PROCESSOR] Job #${commandId} cancelled, aborting provider download...\n`);
                controller.abort();
                clearInterval(checkCancelInterval);
            }
        }, 500);

        try {
            while (true) {
                if (entry.cancelRequested || signal.aborted) {
                    throw new Error("Download cancelled");
                }

                const backend = downloadBackendRegistry.resolve(activeProvider, capability);
                if (!backend) {
                    const next = nextOfferAfterTried(rankedAlternates, triedOffers);
                    if (!next) {
                        throw new Error(`No download backend found for provider ${activeProvider} with capability ${capability}`);
                    }
                    triedOffers.add(makeOfferAttemptKey(next.provider, next.providerId));
                    usedFallback = true;
                    fallbackProvider = next.provider;
                    activeProvider = next.provider;
                    activeProviderItemId = next.providerId;
                    workingPayload = this.applyOfferToPayload(workingPayload, type, next);
                    entry.provider = activeProvider;
                    entry.providerId = activeProviderItemId;
                    continue;
                }

                const baseDownloadPath = getDownloadWorkspacePath(type, activeProviderItemId, activeProvider);
                const downloadPath = path.join(baseDownloadPath, `job_${commandId}`);
                entry.downloadPath = downloadPath;
                entry.provider = activeProvider;
                entry.providerId = activeProviderItemId;

                const onProgress = (state: any) => {
                    const sanitizedState = state?.state === "completed"
                        ? { ...state, state: "downloading" as const, statusMessage: state.statusMessage || "Download finished" }
                        : state;
                    this.persistDownloadState(commandId, sanitizedState);
                    downloadEvents.emitProgress(commandId, {
                        providerId: activeProviderItemId,
                        type,
                        quality: workingPayload.quality ?? null,
                        title: workingPayload.title,
                        artist: workingPayload.artist,
                        cover: workingPayload.cover,
                        progress: sanitizedState.progress,
                        currentFileNum: sanitizedState.currentFileNum,
                        totalFiles: sanitizedState.totalFiles,
                        currentTrack: sanitizedState.currentTrack,
                        currentProviderTrackId: sanitizedState.currentProviderTrackId,
                        currentTrackNum: sanitizedState.currentTrackNum,
                        currentVolumeNum: sanitizedState.currentVolumeNum,
                        trackProgress: sanitizedState.trackProgress,
                        trackStatus: sanitizedState.trackStatus,
                        statusMessage: sanitizedState.statusMessage,
                        state: sanitizedState.state,
                        speed: sanitizedState.speed,
                        eta: sanitizedState.eta,
                        size: sanitizedState.size,
                        sizeleft: sanitizedState.sizeleft,
                        tracks: this.getProgressTracksForEvent(commandId, sanitizedState.tracks),
                    });
                };

                try {
                    await executeWithSameOfferRetries(
                        {
                            signal,
                            onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
                                const message = error instanceof Error ? error.message : String(error);
                                console.warn(
                                    `[DOWNLOAD-PROCESSOR] Job #${commandId} same-offer retry ${attempt}/${maxAttempts} `
                                    + `for ${activeProvider}:${activeProviderItemId} in ${delayMs}ms — ${message}`,
                                );
                                this.persistDownloadState(commandId, {
                                    state: "downloading",
                                    statusMessage: `Retrying ${formatProviderLabel(activeProvider)} `
                                        + `(${attempt}/${maxAttempts})…`,
                                });
                            },
                        },
                        async () => {
                            await backend.download({
                                provider: activeProvider,
                                entityType: type as "album" | "track" | "video",
                                providerId: activeProviderItemId,
                                downloadPath,
                                quality: workingPayload.quality,
                                slot,
                                metadata: {
                                    artwork_preference: metadataConfig.artwork_preference,
                                    save_lyrics: metadataConfig.save_lyrics,
                                },
                            }, {
                                signal,
                                onProgress,
                            });
                        },
                    );

                    if (usedFallback && fallbackProvider) {
                        this.markFallbackSuccessWarning(
                            commandId,
                            primaryProvider,
                            fallbackProvider,
                        );
                    } else {
                        // Promote backend soft warnings (partial SoundCloud album,
                        // skipped DRM/SNIP tracks) into completedWithWarning.
                        const downloadState = (CommandQueueManager.get(commandId)?.payload?.downloadState
                            || {}) as DownloadStatePayload;
                        if (downloadState.warningMessage && downloadState.outcome !== "completedWithWarning") {
                            this.persistDownloadState(commandId, {
                                outcome: "completedWithWarning",
                                warningMessage: downloadState.warningMessage,
                                statusMessage: downloadState.warningMessage,
                            });
                        }
                    }
                    // Keep command payload aligned with the offer that actually downloaded.
                    if (
                        activeProvider !== primaryProvider
                        || activeProviderItemId !== primaryProviderItemId
                    ) {
                        CommandQueueManager.updateState(commandId, {
                            workerId: entry.workerId,
                            payloadPatch: {
                                ...workingPayload,
                                provider: activeProvider,
                                providerId: activeProviderItemId,
                            } as any,
                        });
                    }
                    return;
                } catch (error) {
                    if (isDownloadCancellationError(error) || entry.cancelRequested || signal.aborted) {
                        throw error;
                    }
                    const next = nextOfferAfterTried(rankedAlternates, triedOffers);
                    if (!next) {
                        throw error;
                    }
                    console.warn(
                        `[DOWNLOAD-PROCESSOR] Job #${commandId} falling back from `
                        + `${activeProvider}:${activeProviderItemId} to ${next.provider}:${next.providerId} `
                        + `after: ${error instanceof Error ? error.message : String(error)}`,
                    );
                    triedOffers.add(makeOfferAttemptKey(next.provider, next.providerId));
                    usedFallback = true;
                    fallbackProvider = next.provider;
                    activeProvider = next.provider;
                    activeProviderItemId = next.providerId;
                    workingPayload = this.applyOfferToPayload(workingPayload, type, next);
                    entry.provider = activeProvider;
                    entry.providerId = activeProviderItemId;
                    this.persistDownloadState(commandId, {
                        state: "downloading",
                        statusMessage: `Falling back to ${formatProviderLabel(next.provider)}…`,
                    });
                }
            }
        } finally {
            clearInterval(checkCancelInterval);
        }
    }

    private listFallbackOffersForJob(
        type: DownloadJobType,
        payload: DownloadCommand,
        providerItemId: string,
    ): RankedDownloadOffer[] {
        if (type === "album") {
            return listRankedAlbumOffers(
                payload.releaseGroupMbid || payload.albumId || null,
                payload.slot || null,
            );
        }
        if (type === "track") {
            return listRankedTrackOffers({
                trackMbid: payload.canonicalTrackMbid || null,
                recordingMbid: payload.canonicalRecordingMbid || null,
                librarySlot: payload.slot || "stereo",
            });
        }
        const recordingRef = String(
            payload.canonicalRecordingId
            || payload.canonicalRecordingMbid
            || providerItemId
            || "",
        ).trim();
        return listRankedVideoOffers(recordingRef);
    }

    private applyOfferToPayload(
        payload: DownloadCommand,
        type: DownloadJobType,
        offer: RankedDownloadOffer,
    ): DownloadCommand {
        return applyFallbackOfferToPayload(payload, type, offer);
    }

    private markFallbackSuccessWarning(
        commandId: number,
        primaryProvider: string,
        fallbackProvider: string,
    ): void {
        const warningMessage = formatFallbackSuccessMessage(fallbackProvider, primaryProvider);
        this.persistDownloadState(commandId, {
            outcome: "completedWithWarning",
            warningMessage,
            statusMessage: warningMessage,
            primaryProvider,
            fallbackProvider,
        });
        console.log(`[DOWNLOAD-PROCESSOR] Job #${commandId}: ${warningMessage}`);
    }

    /**
     * Hybrid / partial album fetch: download only the missing track offers into
     * one job workspace, keeping catalog-anchored downloadState.tracks in sync.
     */
    private async downloadAlbumTrackOffers(
        commandId: number,
        payload: DownloadAlbumCommand,
        entry: ActiveDownload,
    ): Promise<void> {
        const offers = Array.isArray(payload.trackOffers) ? payload.trackOffers : [];
        if (offers.length === 0) {
            throw new Error("DownloadAlbum trackOffers mode requires at least one track offer");
        }

        const defaultProvider = payload.provider || getDefaultStreamingSource();
        const workspaceKey = String(payload.releaseGroupMbid || payload.providerId || commandId);
        const baseDownloadPath = getDownloadWorkspacePath("album", workspaceKey, defaultProvider);
        const downloadPath = path.join(baseDownloadPath, `job_${commandId}`);
        entry.downloadPath = downloadPath;
        fs.mkdirSync(downloadPath, { recursive: true });

        const slot = payload.slot || "stereo";
        const capability = slot === "spatial" ? "spatial" : "stereo";
        const metadataConfig = getConfigSection("metadata");
        const controller = entry.abortController;
        const signal = controller.signal;

        const currentJob = CommandQueueManager.get(commandId);
        const currentPayload = (currentJob?.payload || payload) as DownloadAlbumCommand;
        const tracks: DownloadTrackStateEntry[] = Array.isArray(currentPayload.downloadState?.tracks)
            ? [...currentPayload.downloadState!.tracks!]
            : offers.map((offer) => ({
                title: offer.title || "Unknown Track",
                trackNum: offer.trackNum ?? undefined,
                volumeNum: offer.volumeNum ?? undefined,
                status: "queued" as const,
                providerTrackId: offer.providerTrackId,
                provider: offer.provider,
                quality: offer.quality,
                canonicalTrackMbid: offer.canonicalTrackMbid,
                canonicalRecordingMbid: offer.canonicalRecordingMbid,
            }));

        const totalFiles = Math.max(
            Number(currentPayload.downloadState?.totalFiles) || 0,
            tracks.length,
            offers.length,
        );
        let completedBefore = tracks.filter((track) => track.status === "completed" || track.status === "skipped").length;
        let fallbackPrimary: string | null = null;
        let fallbackUsed: string | null = null;

        const emitProgress = (partial: DownloadStatePayload) => {
            this.persistDownloadState(commandId, partial);
            downloadEvents.emitProgress(commandId, {
                providerId: String(payload.providerId || workspaceKey),
                type: "album",
                quality: payload.quality ?? null,
                title: payload.title,
                artist: payload.artist,
                cover: payload.cover,
                progress: partial.progress !== undefined ? partial.progress : null,
                currentFileNum: partial.currentFileNum ?? 0,
                totalFiles: partial.totalFiles ?? 0,
                currentTrack: partial.currentTrack,
                currentProviderTrackId: partial.currentProviderTrackId,
                currentTrackNum: partial.currentTrackNum,
                currentVolumeNum: partial.currentVolumeNum,
                trackProgress: partial.trackProgress,
                trackStatus: partial.trackStatus,
                statusMessage: partial.statusMessage,
                state: partial.state,
                speed: partial.speed,
                eta: partial.eta,
                size: partial.size,
                sizeleft: partial.sizeleft,
                tracks: this.getProgressTracksForEvent(commandId, partial.tracks),
            });
        };

        const checkCancelInterval = setInterval(() => {
            if (entry.cancelRequested) {
                console.log(`[DOWNLOAD-PROCESSOR] Job #${commandId} cancelled, aborting track-offer download...\n`);
                controller.abort();
                clearInterval(checkCancelInterval);
            }
        }, 500);

        try {
            const resolvedOffers: DownloadTrackOffer[] = [];

            for (let offerIndex = 0; offerIndex < offers.length; offerIndex++) {
                if (entry.cancelRequested || signal.aborted) {
                    throw new Error("Download cancelled");
                }

                let offer = { ...offers[offerIndex] };
                const primaryOfferProvider = offer.provider || defaultProvider;
                const tried = new Set<string>([
                    makeOfferAttemptKey(primaryOfferProvider, offer.providerTrackId),
                ]);
                const ranked = listRankedTrackOffers({
                    trackMbid: offer.canonicalTrackMbid,
                    recordingMbid: offer.canonicalRecordingMbid,
                    librarySlot: slot,
                });

                const trackIndex = tracks.findIndex((track) => {
                    if (offer.canonicalTrackMbid && track.canonicalTrackMbid === offer.canonicalTrackMbid) return true;
                    if (offer.canonicalRecordingMbid && track.canonicalRecordingMbid === offer.canonicalRecordingMbid) return true;
                    return track.providerTrackId === offer.providerTrackId;
                });

                let downloaded = false;
                while (!downloaded) {
                    const providerId = offer.provider || defaultProvider;
                    const backend = downloadBackendRegistry.resolve(providerId, capability);
                    if (!backend) {
                        const next = nextOfferAfterTried(ranked, tried);
                        if (!next) {
                            throw new Error(`No download backend found for provider ${providerId} with capability ${capability}`);
                        }
                        tried.add(makeOfferAttemptKey(next.provider, next.providerId));
                        fallbackPrimary ||= primaryOfferProvider;
                        fallbackUsed = next.provider;
                        offer = applyFallbackTrackOffer(offer, next);
                        continue;
                    }

                    if (trackIndex >= 0) {
                        tracks[trackIndex] = {
                            ...tracks[trackIndex],
                            status: "downloading",
                            providerTrackId: offer.providerTrackId,
                            provider: providerId,
                        };
                    }

                    const currentFileNum = completedBefore + offerIndex + 1;
                    emitProgress({
                        state: "downloading",
                        currentFileNum,
                        totalFiles,
                        progress: Math.round(((completedBefore + offerIndex) / totalFiles) * 100),
                        currentTrack: offer.title || tracks[trackIndex]?.title,
                        currentProviderTrackId: offer.providerTrackId,
                        currentTrackNum: offer.trackNum ?? tracks[trackIndex]?.trackNum,
                        currentVolumeNum: offer.volumeNum ?? tracks[trackIndex]?.volumeNum,
                        trackStatus: "downloading",
                        statusMessage: `Downloading track ${currentFileNum}/${totalFiles}`,
                        tracks,
                    });

                    const trackDownloadPath = path.join(downloadPath, `track_${offer.providerTrackId}`);
                    fs.mkdirSync(trackDownloadPath, { recursive: true });

                    try {
                        await executeWithSameOfferRetries(
                            {
                                signal,
                                onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
                                    const message = error instanceof Error ? error.message : String(error);
                                    console.warn(
                                        `[DOWNLOAD-PROCESSOR] Job #${commandId} track same-offer retry `
                                        + `${attempt}/${maxAttempts} for ${providerId}:${offer.providerTrackId} `
                                        + `in ${delayMs}ms — ${message}`,
                                    );
                                    emitProgress({
                                        state: "downloading",
                                        statusMessage: `Retrying ${formatProviderLabel(providerId)} `
                                            + `(${attempt}/${maxAttempts})…`,
                                        tracks,
                                    });
                                },
                            },
                            async () => {
                                await backend.download({
                                    provider: providerId,
                                    entityType: "track",
                                    providerId: offer.providerTrackId,
                                    downloadPath: trackDownloadPath,
                                    quality: offer.quality ?? payload.quality,
                                    slot,
                                    metadata: {
                                        artwork_preference: metadataConfig.artwork_preference,
                                        save_lyrics: metadataConfig.save_lyrics,
                                    },
                                }, {
                                    signal,
                                    onProgress: (state: any) => {
                                        emitProgress({
                                            state: "downloading",
                                            currentFileNum,
                                            totalFiles,
                                            progress: Math.round((((completedBefore + offerIndex) + ((state.progress || 0) / 100)) / totalFiles) * 100),
                                            currentTrack: offer.title || state.currentTrack || tracks[trackIndex]?.title,
                                            currentProviderTrackId: offer.providerTrackId,
                                            currentTrackNum: offer.trackNum ?? tracks[trackIndex]?.trackNum,
                                            currentVolumeNum: offer.volumeNum ?? tracks[trackIndex]?.volumeNum,
                                            trackProgress: state.progress,
                                            trackStatus: state.trackStatus || "downloading",
                                            statusMessage: state.statusMessage || `Downloading track ${currentFileNum}/${totalFiles}`,
                                            speed: state.speed,
                                            eta: state.eta,
                                            size: state.size,
                                            sizeleft: state.sizeleft,
                                            tracks,
                                        });
                                    },
                                });
                            },
                        );

                        this.flattenTrackOfferWorkspace(trackDownloadPath, downloadPath, offer.providerTrackId);

                        if (trackIndex >= 0) {
                            tracks[trackIndex] = {
                                ...tracks[trackIndex],
                                status: "queued",
                                providerTrackId: offer.providerTrackId,
                                provider: providerId,
                            };
                        }
                        resolvedOffers.push(offer);
                        downloaded = true;
                    } catch (error) {
                        if (isDownloadCancellationError(error) || entry.cancelRequested || signal.aborted) {
                            throw error;
                        }
                        const next = nextOfferAfterTried(ranked, tried);
                        if (!next) {
                            throw error;
                        }
                        console.warn(
                            `[DOWNLOAD-PROCESSOR] Job #${commandId} track falling back from `
                            + `${providerId}:${offer.providerTrackId} to ${next.provider}:${next.providerId}`,
                        );
                        tried.add(makeOfferAttemptKey(next.provider, next.providerId));
                        fallbackPrimary ||= primaryOfferProvider;
                        fallbackUsed = next.provider;
                        offer = applyFallbackTrackOffer(offer, next);
                        emitProgress({
                            state: "downloading",
                            statusMessage: `Falling back to ${formatProviderLabel(next.provider)}…`,
                            tracks,
                        });
                    }
                }
            }

            if (resolvedOffers.length > 0) {
                CommandQueueManager.updateState(commandId, {
                    workerId: entry.workerId,
                    payloadPatch: {
                        trackOffers: resolvedOffers,
                    } as any,
                });
            }

            completedBefore = tracks.filter((track) => track.status === "completed" || track.status === "skipped").length;
            const finishState: DownloadStatePayload = {
                state: "downloading",
                currentFileNum: Math.min(totalFiles, completedBefore + offers.length),
                totalFiles,
                progress: Math.round(((completedBefore + offers.length) / totalFiles) * 100),
                trackStatus: "completed",
                statusMessage: "Download finished, preparing import",
                tracks,
            };
            if (fallbackPrimary && fallbackUsed) {
                const warningMessage = formatFallbackSuccessMessage(fallbackUsed, fallbackPrimary);
                finishState.outcome = "completedWithWarning";
                finishState.warningMessage = warningMessage;
                finishState.statusMessage = warningMessage;
                finishState.primaryProvider = fallbackPrimary;
                finishState.fallbackProvider = fallbackUsed;
            }
            emitProgress(finishState);
        } finally {
            clearInterval(checkCancelInterval);
        }
    }

    private flattenTrackOfferWorkspace(
        trackDownloadPath: string,
        albumDownloadPath: string,
        providerTrackId?: string,
    ): void {
        if (!fs.existsSync(trackDownloadPath)) return;
        const preferredStem = String(providerTrackId || "").trim();
        const walk = (dir: string) => {
            for (const entryName of fs.readdirSync(dir)) {
                const fullPath = path.join(dir, entryName);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    walk(fullPath);
                    continue;
                }
                const ext = path.extname(entryName);
                // Hybrid tips must land as {providerTrackId}{ext} so organize can
                // basename-match regardless of which tip album directory tiddl used.
                const destName = preferredStem && this.isAudioExtension(ext)
                    ? `${preferredStem}${ext.toLowerCase()}`
                    : entryName;
                let dest = path.join(albumDownloadPath, destName);
                if (path.resolve(fullPath) === path.resolve(dest)) continue;
                if (fs.existsSync(dest) && path.resolve(fullPath) !== path.resolve(dest)) {
                    if (preferredStem && this.isAudioExtension(ext)) {
                        // Same tip id already flattened — keep the first copy.
                        try {
                            fs.rmSync(fullPath, { force: true });
                        } catch {
                            // ignore
                        }
                        continue;
                    }
                    const base = path.parse(entryName);
                    dest = path.join(albumDownloadPath, `${base.name}-${Date.now()}${base.ext}`);
                }
                fs.renameSync(fullPath, dest);
            }
        };
        walk(trackDownloadPath);
        try {
            fs.rmSync(trackDownloadPath, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup of the per-track staging folder.
        }
    }

    private isAudioExtension(ext: string): boolean {
        const normalized = String(ext || "").toLowerCase();
        return [".flac", ".m4a", ".mp3", ".aac", ".alac", ".wav", ".aiff", ".aif", ".ogg", ".opus"].includes(normalized);
    }

    /**
     * Cancel one queue item without pausing unrelated downloads.
     *
     * Provider downloads transition to cancelled before their AbortSignal is
     * fired. Active imports retain their started status as a duplicate-work
     * barrier while a persisted cancellation marker drains them to the next safe
     * checkpoint. Their cancellation only resolves after staging cleanup; files
     * already organized into a library root are deliberately not rolled back.
     */
    async cancelJob(commandId: number): Promise<void> {
        const currentJob = CommandQueueManager.get(commandId);
        if (!currentJob) {
            return;
        }

        const activeDownload = this.activeDownloads.get(commandId);
        if (activeDownload) {
            activeDownload.cancelRequested = true;
            this.explicitlyCancelledDownloads.add(commandId);
            activeDownload.abortController.abort();
            CommandQueueManager.cancel(commandId);
            DownloadWaitQueue.removeByCommandId(commandId);
        } else if (this.activeImports.has(commandId)) {
            // Cannot abort active import; mark as cancelled for when it finishes
            this.explicitlyCancelledDownloads.add(commandId);
            const activeImport = this.activeImports.get(commandId);
            CommandQueueManager.updateState(commandId, {
                workerId: activeImport?.workerId || undefined,
                payloadPatch: { importCancellationRequested: true } as any,
                blockedReason: 'cancellation requested',
            });
            await activeImport?.promise;
        } else if (currentJob.status === 'queued' || currentJob.status === 'started') {
            CommandQueueManager.cancel(commandId);
            DownloadWaitQueue.removeByCommandId(commandId);
        }
    }

    /**
     * Halt processing without recording an operator pause.
     *
     * Shutdown has to stop in-flight downloads, but it must not persist that
     * stop: a restart would then come back paused and never resume on its own.
     * Only an explicit operator pause is durable.
     */
    private haltProcessing(): void {
        this.isPaused = true;

        // Flush any buffered progress writes before pausing/shutdown.
        this.flushProgressBuffer();

        // Abort every in-flight download so the queue halts promptly.
        for (const [commandId, entry] of this.activeDownloads) {
            console.log(`[DOWNLOAD-PROCESSOR] Cancelling current job: ${commandId}`);
            entry.cancelRequested = true;
            entry.abortController.abort();
        }

        downloadEvents.emitQueueStatus(true);
    }

    async pause(): Promise<void> {
        console.log('[DOWNLOAD-PROCESSOR] Pausing queue...');
        setDownloadQueuePaused(true);
        this.haltProcessing();
        console.log('[DOWNLOAD-PROCESSOR] Queue paused');
    }

    /** Shutdown-only halt. Leaves the persisted pause state untouched. */
    async suspend(): Promise<void> {
        console.log('[DOWNLOAD-PROCESSOR] Suspending queue for shutdown...');
        this.haltProcessing();
        console.log('[DOWNLOAD-PROCESSOR] Queue suspended');
    }

    async resume(): Promise<void> {
        if (process.env.DISCOGENIUS_DISABLE_DOWNLOADS === '1') {
            // Ensure QA / LAN testing can't accidentally start real downloads.
            this.isPaused = true;
            downloadEvents.emitQueueStatus(true);
            return;
        }

        console.log('[DOWNLOAD-PROCESSOR] Resuming queue...');
        setDownloadQueuePaused(false);
        this.isPaused = false;

        downloadEvents.emitQueueStatus(false);
        // Wake the queue loop without blocking the caller on a full download lifecycle.
        this.scheduleNext();
    }

    isActivelyProcessingJob(commandId: number): boolean {
        return this.activeDownloads.has(commandId) || this.activeImports.has(commandId);
    }

    getStatus(): {
        isPaused: boolean;
        processing: boolean;
        currentJobId?: number;
        currentProviderId?: string;
        currentType?: string;
        activeDownloads: number;
        activeDownloadIds: number[];
        activeImports: number;
        activeImportIds: number[];
    } {
        // currentJobId/currentProviderId/currentType describe the first active
        // download slot for backward-compatible status display; use
        // activeDownloadIds for the full set.
        const first = this.activeDownloads.entries().next().value as [number, ActiveDownload] | undefined;
        return {
            isPaused: this.isPaused,
            processing: this.activeDownloads.size > 0 || this.activeImports.size > 0,
            currentJobId: first?.[0],
            currentProviderId: first?.[1].providerId,
            currentType: first?.[1].type,
            activeDownloads: this.activeDownloads.size,
            activeDownloadIds: Array.from(this.activeDownloads.keys()),
            activeImports: this.activeImports.size,
            activeImportIds: Array.from(this.activeImports.keys()),
        };
    }

    isActivelyImporting(commandId: number): boolean {
        return this.activeImports.has(commandId);
    }
}

type DownloadProcessorStatus = ReturnType<DownloadProcessor['getStatus']>;

type DownloadWorkerRequestKind = 'initialize' | 'processQueue' | 'pause' | 'suspend' | 'resume' | 'cancelJob';

type DownloadWorkerToMainMessage =
    | { kind: 'ready' }
    | { kind: 'status'; status: DownloadProcessorStatus }
    | { kind: 'downloadEvent'; event: string; payload: unknown }
    | { kind: 'event'; event: string; payload: unknown }
    | { kind: 'cacheInvalidate'; target: CacheInvalidateTarget; key?: string }
    | { kind: 'response'; requestId: number; ok: true }
    | { kind: 'response'; requestId: number; ok: false; error: string };

type DownloadWorkerRequest = {
    kind: DownloadWorkerRequestKind;
    requestId: number;
    commandId?: number;
};

function resolveDownloadWorkerSpawn(): { entry: string; workerData: Record<string, unknown> } {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const isCompiled = here.includes(`${path.sep}dist${path.sep}`) || here.endsWith(`${path.sep}dist`);
    const workerData: Record<string, unknown> = {
        [DOWNLOAD_WORKER_MARKER]: true,
        ...sqliteWriteMutexWorkerData(),
    };

    if (isCompiled) {
        return {
            entry: path.join(here, 'download-processor-worker-entry.js'),
            workerData,
        };
    }

    return {
        entry: path.join(here, '..', 'commands', 'worker', 'command-worker-bootstrap.mjs'),
        workerData: {
            ...workerData,
            __entry: pathToFileURL(path.join(here, 'download-processor-worker-entry.ts')).href,
        },
    };
}

export class DownloadProcessorWorkerProxy {
    private worker?: Worker;
    private nextRequestId = 1;
    private pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
    private initialized = false;
    private stopping = false;
    private watchdogTimer?: NodeJS.Timeout;
    private watchdogTerminationReason: string | null = null;
    private restartInFlight: Promise<void> | null = null;
    private queuedRestartReason: string | null = null;
    private status: DownloadProcessorStatus = {
        isPaused: process.env.DISCOGENIUS_START_PAUSED === '1',
        processing: false,
        activeDownloads: 0,
        activeDownloadIds: [],
        activeImports: 0,
        activeImportIds: [],
    };

    async initialize(): Promise<void> {
        this.initialized = true;
        this.subscribeToQueueEvents();
        this.startWatchdog();
        await this.request('initialize');
    }

    private startWatchdog(): void {
        if (this.watchdogTimer) return;
        this.watchdogTimer = setInterval(() => {
            void this.runWatchdogOnce().catch((error) => {
                console.error('[DOWNLOAD-PROCESSOR] Lease watchdog failed:', error);
            });
        }, DOWNLOAD_WATCHDOG_MS);
        this.watchdogTimer.unref();
    }

    /**
     * The dedicated worker can keep heartbeating while awaiting a provider or
     * importer promise that never resolves. Lease expiry catches a dead event
     * loop; last-progress expiry catches that healthier-looking hang.
     */
    async runWatchdogOnce(now: Date = new Date()): Promise<boolean> {
        const worker = this.worker;
        if (!worker || this.stopping || this.restartInFlight || this.watchdogTerminationReason) {
            return false;
        }
        const stale = CommandQueueManager.findStaleExecutionLeases({
            types: DOWNLOAD_OR_IMPORT_COMMAND_NAMES,
            now,
            noProgressMs: DOWNLOAD_NO_PROGRESS_MS,
        });
        if (stale.length === 0) return false;

        const summary = stale
            .slice(0, 5)
            .map((entry) => `#${entry.id} ${entry.reason}`)
            .join(', ');
        this.watchdogTerminationReason = `Download worker watchdog detected stale execution: ${summary}`;
        console.error(`[DOWNLOAD-PROCESSOR] ${this.watchdogTerminationReason}; terminating worker`);
        // Do not recover before terminate resolves: the old owner must be
        // physically retired before a replacement attempt can be claimed.
        void worker.terminate().catch((error) => {
            console.error('[DOWNLOAD-PROCESSOR] Failed to terminate stale worker:', error);
            // Keep the attempt owned and retry physical termination on the next
            // watchdog pass; never recover while the old worker may still run.
            this.watchdogTerminationReason = null;
        });
        return true;
    }

    // The worker's own COMMAND_ADDED listener only hears events emitted inside
    // that thread. Enqueues from the main thread (routes) and from command
    // workers (upgrader, monitoring) surface on the main appEvents emitter, so
    // the proxy must relay them into the download worker as a queue kick.
    private queueEventsSubscribed = false;

    private subscribeToQueueEvents(): void {
        if (this.queueEventsSubscribed) return;
        this.queueEventsSubscribed = true;
        appEvents.on(AppEvent.COMMAND_ADDED, (event: CommandEventPayload) => {
            if (!this.initialized || process.env.DISCOGENIUS_DISABLE_DOWNLOADS === '1') return;
            if (!DOWNLOAD_OR_IMPORT_COMMAND_NAMES.includes(event.type as (typeof DOWNLOAD_OR_IMPORT_COMMAND_NAMES)[number])) return;
            this.kickQueue();
        });
        // DownloadMissing writes wait-table rows with no command yet, then emits
        // QUEUE_CLEARED. Without this kick those rows sit forever: processQueue
        // is what claimNext()s a wait row into a Download* command.
        appEvents.on(AppEvent.QUEUE_CLEARED, () => {
            if (!this.initialized || process.env.DISCOGENIUS_DISABLE_DOWNLOADS === '1') return;
            this.kickQueue();
        });
    }

    private kickQueue(): void {
        void this.processQueue().catch((error) => {
            console.error('[DOWNLOAD-PROCESSOR] Failed to relay queue kick to download worker:', error);
        });
    }

    async processQueue(): Promise<void> {
        await this.request('processQueue');
    }

    async pause(): Promise<void> {
        await this.request('pause');
    }

    async suspend(): Promise<void> {
        await this.request('suspend');
    }

    async resume(): Promise<void> {
        await this.request('resume');
    }

    async cancelJob(commandId: number): Promise<void> {
        await this.request('cancelJob', commandId);
    }

    isActivelyProcessingJob(commandId: number): boolean {
        return this.status.activeDownloadIds.includes(commandId) || this.status.activeImportIds.includes(commandId);
    }

    getStatus(): DownloadProcessorStatus {
        return {
            ...this.status,
            activeDownloadIds: [...this.status.activeDownloadIds],
            activeImportIds: [...this.status.activeImportIds],
        };
    }

    isActivelyImporting(commandId: number): boolean {
        return this.status.activeImportIds.includes(commandId);
    }

    private request(kind: DownloadWorkerRequestKind, commandId?: number): Promise<void> {
        // Only initialize() may spawn the worker. Control calls before boot
        // (tests exercising the upgrader, shutdown with downloads disabled)
        // must not start a download thread — a live worker also keeps the
        // process alive, which hangs the node test runner.
        if (kind !== 'initialize' && !this.initialized) {
            return Promise.resolve();
        }

        const worker = this.ensureWorker();
        const requestId = this.nextRequestId++;
        return new Promise<void>((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject });
            worker.postMessage({ kind, requestId, commandId } satisfies DownloadWorkerRequest);
        });
    }

    private ensureWorker(): Worker {
        if (this.worker) {
            return this.worker;
        }

        const { entry, workerData } = resolveDownloadWorkerSpawn();
        const worker = new Worker(entry, { workerData });
        // The API server's HTTP listener keeps the process alive; the worker
        // must never be the thing pinning it (shutdown calls process.exit).
        worker.unref();
        this.worker = worker;
        this.stopping = false;

        worker.on('message', (message: DownloadWorkerToMainMessage) => this.handleMessage(message));
        worker.on('error', (error) => {
            console.error('[DOWNLOAD-PROCESSOR] Worker error:', error);
        });
        worker.on('exit', (code) => {
            if (this.worker !== worker) return;
            this.worker = undefined;
            const reason = this.watchdogTerminationReason
                || `Download processor worker exited unexpectedly with code ${code}`;
            this.watchdogTerminationReason = null;
            const error = new Error(reason);
            for (const pending of this.pending.values()) {
                pending.reject(error);
            }
            this.pending.clear();

            if (!this.stopping && this.initialized) {
                console.error(`[DOWNLOAD-PROCESSOR] ${reason}; recovering attempts before restart`);
                this.scheduleRecoverAndRestart(reason);
            }
        });

        return worker;
    }

    private scheduleRecoverAndRestart(reason: string): void {
        if (this.restartInFlight) {
            this.queuedRestartReason = reason;
            return;
        }

        const run = this.recoverAndRestart(reason);
        this.restartInFlight = run;
        const finished = () => {
            if (this.restartInFlight === run) {
                this.restartInFlight = null;
            }
            const queuedReason = this.queuedRestartReason;
            this.queuedRestartReason = null;
            if (queuedReason && !this.stopping && this.initialized) {
                this.scheduleRecoverAndRestart(queuedReason);
            }
        };
        void run.then(finished, (error) => {
            console.error('[DOWNLOAD-PROCESSOR] Unexpected restart failure:', error);
            finished();
        });
    }

    private async recoverAndRestart(reason: string): Promise<void> {
        try {
            const result = recoverInterruptedDownloadAttempts(reason);
            console.warn(
                '[DOWNLOAD-PROCESSOR] Worker-loss recovery: '
                + `${result.requeued} requeued, ${result.failed} failed closed, `
                + `${result.ignored} already retired`,
            );
        } catch (error) {
            console.error('[DOWNLOAD-PROCESSOR] Could not recover interrupted attempts:', error);
            // Do not spawn a replacement that could race rows still owned by
            // the dead worker. A later API restart can retry deterministic boot
            // recovery once the database is available again.
            return;
        }

        this.status = {
            isPaused: getDownloadQueueControlState().isPaused,
            processing: false,
            activeDownloads: 0,
            activeDownloadIds: [],
            activeImports: 0,
            activeImportIds: [],
        };
        try {
            await this.request('initialize');
        } catch (error) {
            console.error('[DOWNLOAD-PROCESSOR] Failed to restart download worker:', error);
        }
    }

    private handleMessage(message: DownloadWorkerToMainMessage): void {
        switch (message.kind) {
            case 'ready':
                break;
            case 'status':
                this.status = {
                    ...message.status,
                    activeDownloadIds: message.status.activeDownloadIds ?? [],
                    activeImportIds: message.status.activeImportIds ?? [],
                };
                break;
            case 'downloadEvent':
                downloadEvents.emit(message.event, message.payload);
                break;
            case 'event':
                appEvents.emit(message.event as AppEvent, message.payload as never);
                break;
            case 'cacheInvalidate':
                this.applyCacheInvalidate(message.target, message.key);
                break;
            case 'response': {
                const pending = this.pending.get(message.requestId);
                if (!pending) return;
                this.pending.delete(message.requestId);
                if (message.ok) {
                    pending.resolve();
                } else {
                    pending.reject(new Error(message.error));
                }
                break;
            }
        }
    }

    private applyCacheInvalidate(target: CacheInvalidateTarget, key?: string): void {
        switch (target) {
            case 'album':
                if (key) invalidateAlbumDownloadStatus(key);
                break;
            case 'releaseGroup':
                if (key) invalidateReleaseGroupDownloadStatus(key);
                break;
            case 'artist':
                if (key) invalidateArtistDownloadStatus(key);
                break;
            case 'media':
                if (key) invalidateMediaDownloadState(key);
                break;
            case 'all':
                invalidateAllDownloadState();
                break;
        }
    }
}

// Command workers must not run their own download loop: an enqueue there
// already bridges COMMAND_ADDED to the main thread, whose proxy kicks the
// dedicated download worker. This stub keeps accidental processQueue() calls
// (e.g. the upgrader) from claiming jobs inside a command worker.
class DownloadProcessorCommandWorkerStub {
    async initialize(): Promise<void> {}

    async processQueue(): Promise<void> {}

    async pause(): Promise<void> {
        throw new Error('Download processor controls are unavailable inside command workers');
    }

    async suspend(): Promise<void> {
        throw new Error('Download processor controls are unavailable inside command workers');
    }

    async resume(): Promise<void> {
        throw new Error('Download processor controls are unavailable inside command workers');
    }

    async cancelJob(_commandId: number): Promise<void> {
        throw new Error('Download processor controls are unavailable inside command workers');
    }

    isActivelyProcessingJob(_commandId: number): boolean {
        return false;
    }

    isActivelyImporting(_commandId: number): boolean {
        return false;
    }

    getStatus(): DownloadProcessorStatus {
        return {
            isPaused: false,
            processing: false,
            activeDownloads: 0,
            activeDownloadIds: [],
            activeImports: 0,
            activeImportIds: [],
        };
    }
}

const isDownloadWorkerThread = !isMainThread
    && (workerData as Record<string, unknown> | null)?.[DOWNLOAD_WORKER_MARKER] === true;

export const downloadProcessor = isMainThread
    ? new DownloadProcessorWorkerProxy()
    : isDownloadWorkerThread
        ? new DownloadProcessor()
        : new DownloadProcessorCommandWorkerStub();
