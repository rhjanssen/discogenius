import fs from "fs";
import path from "path";
import { db, isSqliteBusyError, withSqliteWriteGate } from "../../database.js";
import { OrganizerService, type OrganizeResult } from "./organizer.js";
import {
    updateAlbumDownloadStatus,
    updateArtistDownloadStatusFromMedia,
} from "../download/download-state.js";
import {
    AudioTagService,
    isAudioTagMaintenanceEnabled,
    type RetagApplyResult,
} from "./audio-tag-service.js";
import { VideoTagService } from "./video-tag-service.js";
import { getDownloadWorkspacePath, validateDownloadWorkspacePath } from "../download/download-routing.js";
import { getExistingLibraryFiles } from "../download/download-recovery.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "../commands/history-events.js";
import {type CommandModelOf} from "../commands/command-model.js";
import type { DownloadTrackOffer } from "../commands/command-bodies.js";
import {CommandNames} from "../commands/command-names.js";
import { CommandQueueManager } from "../commands/command-queue-manager.js";
import { MetadataIdentityService } from "../metadata/metadata-identity-service.js";
import { ArtistStatisticsService } from "../music/artist-statistics-service.js";
import { ProviderTrackTagSupplementService } from "./provider-track-tag-supplement-service.js";
import { TrackLyricsMaterializer, type TrackLyricsMaterializeResult } from "./track-lyrics-materializer.js";
import { LibraryFilesService, removeEmptyParents } from "./library-files.js";
import { Config } from "../config/config.js";
import {
    decideImportedQuality,
    QualityProfileRepository,
    type ImportQualityDecision,
} from "../music/quality-profile-policy.js";
import { classifyNeutralAudio } from "../providers/provider-quality.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";
import { deriveQuality, parseAudioFile } from "./audioUtils.js";
import { transcodeForQualityProfile } from "./quality-profile-transcoder.js";
import { SQL_JSON_LIST, jsonList } from "../../utils/sql-id-list.js";
import { recordArtworkMaterializeFollowUp } from "../metadata/artwork-materialize-followup.js";

type ImportDownloadJob = CommandModelOf<typeof CommandNames.ImportDownload>;

/** YouTube also downloads exact plan URLs for album-mode jobs. */
function downloadsSelectedOffers(payload: { acquisitionMode?: string | null; provider?: string }): boolean {
    return payload.acquisitionMode === 'trackOffers' || payload.provider === 'youtube-music';
}

/** A selected track subset need not cover its provider's entire edition. */
export function expectedImportedTrackCount(payload: Pick<ImportDownloadJob['payload'], 'acquisitionMode' | 'trackOffers'> & { provider?: string }, providerCount: number | undefined): number | undefined {
    return downloadsSelectedOffers(payload) && Array.isArray(payload.trackOffers) && payload.trackOffers.length > 0
        ? new Set(payload.trackOffers.map(offer => `${offer.provider}:${offer.providerTrackId}`)).size
        : providerCount;
}

/** Full-album provenance is not exhaustive unless the backend downloads exact offers. */
export function shouldHardFailIncompleteAlbumImport(options: {
  type?: string;
  acquisitionMode?: string | null;
  provider?: string;
  processedCount: number;
  trackOfferCount: number;
}): boolean {
  return options.type === "album"
    && downloadsSelectedOffers(options)
    && options.trackOfferCount > 0
    && options.processedCount < options.trackOfferCount;
}

function rememberImportTouchedFiles(commandId: number, fileIds: readonly number[]): void {
    const ids = Array.from(new Set(
        fileIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0),
    ));
    if (ids.length === 0) return;
    withSqliteWriteGate(() => {
        const current = CommandQueueManager.get(commandId);
        if (!current || current.status !== "started") return;
        const payload = (current.payload ?? {}) as Record<string, any>;
        const handoff = payload.downloadImportHandoff && typeof payload.downloadImportHandoff === "object"
            ? payload.downloadImportHandoff
            : {};
        CommandQueueManager.updateState(commandId, {
            workerId: current.worker_id || undefined,
            payloadPatch: {
                downloadImportHandoff: {
                    ...handoff,
                    importTouchedFileIds: ids,
                },
            } as any,
        });
    }, "import:touched-files");
}

/** Durable point of no return: from here the import changes the staged files or
 * the library. A worker killed before this mark is replayed on restart instead
 * of failed closed. */
function markImportLibraryMutationStarted(commandId: number): void {
    withSqliteWriteGate(() => {
        const current = CommandQueueManager.get(commandId);
        if (!current || current.status !== "started") return;
        const payload = (current.payload ?? {}) as Record<string, any>;
        const handoff = payload.downloadImportHandoff && typeof payload.downloadImportHandoff === "object"
            ? payload.downloadImportHandoff
            : null;
        if (!handoff || handoff.libraryMutationStartedAt) return;
        CommandQueueManager.updateState(commandId, {
            workerId: current.worker_id || undefined,
            payloadPatch: {
                downloadImportHandoff: { ...handoff, libraryMutationStartedAt: new Date().toISOString() },
            } as any,
        });
    }, "import:mutation-start");
}

/** Offered tracks the organizer did not place, labelled for logs and history. */
export function describeUnorganizedTrackOffers(
    offers: readonly { provider: string; providerTrackId: string; title?: string; trackNum?: number | null; volumeNum?: number | null }[],
    processedTrackIds: readonly string[],
): string[] {
    const processed = new Set(processedTrackIds.map(String));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const offer of offers) {
        const key = `${offer.provider}:${offer.providerTrackId}`;
        if (processed.has(String(offer.providerTrackId)) || seen.has(key)) continue;
        seen.add(key);
        const position = offer.trackNum != null ? `${offer.volumeNum ?? 1}-${offer.trackNum} ` : "";
        out.push(`${position}${offer.title ? `"${offer.title}" ` : ""}(${key})`);
    }
    return out;
}

function importedLibraryFileIds(organizeResult: OrganizeResult): number[] {
    return Array.from(new Set(
        Object.values(organizeResult.importedTrackFileIds || {})
            .map((id) => Number(id))
            .filter((id) => Number.isInteger(id) && id > 0),
    ));
}

export function assertImportedAudioTagsApplied(
    result: RetagApplyResult,
    context: string,
): void {
    if (result.missing === 0 && result.errors.length === 0) return;
    const firstError = result.errors[0]?.error;
    const details = [
        result.missing > 0 ? `${result.missing} file(s) missing` : "",
        result.errors.length > 0 ? `${result.errors.length} write or verification error(s)` : "",
        firstError ? `first error: ${firstError}` : "",
    ].filter(Boolean).join(", ");
    throw new Error(`[ImportDownload] Canonical audio tags were not applied for ${context}: ${details}`);
}

/**
 * The destination edition's artwork must be in MediaCover before tag write.
 * Organizer and embed both read that cache; if it is empty they leave the
 * downloader's cover (Apple 540px covr, tiddl album art) on the library copy.
 * Fetch/store via the same resolver the UI uses, then rewrite dest cover.jpg
 * from that cache so folder sidecar and embed agree.
 */
export async function ensureDestAlbumArtworkForFileIds(
    fileIds: readonly number[],
    onFileStart?: (index: number, total: number) => void,
): Promise<void> {
    const ids = Array.from(new Set(
        fileIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0),
    ));
    if (ids.length === 0) return;

    const rows = db.prepare(`
        SELECT canonical_release_mbid AS release_mbid, album_edition_id, library_id,
               file_path, library_root, relative_path
        FROM TrackFiles
        WHERE id IN ${SQL_JSON_LIST}
          AND file_type = 'track'
    `).all(jsonList(ids)) as Array<{
        release_mbid: string | null;
        album_edition_id: number | null;
        library_id: number | null;
        file_path: string;
        library_root: string | null;
        relative_path: string | null;
    }>;

    const {
        albumMbidForEdition,
        discardEditionCoverIfDuplicateOfAlbum,
        releaseGroupHasMultipleMonitoredEditions,
        resolveAlbumArtwork,
        resolveEditionArtwork,
    } = await import("../metadata/media-cover-service.js");
    const { materializeMediaCoverToFile } = await import("../metadata/media-cover-materialization.js");
    const { resolveStoredLibraryPath } = await import("./library-paths.js");
    const { getConfigSection } = await import("../config/config.js");
    const metadataConfig = getConfigSection("metadata");
    const coverName = metadataConfig.album_cover_name || "cover.jpg";

    const editions = new Map<string, { releaseMbid: string; libraryId: number | null }>();
    const sidecars: Array<{ releaseMbid: string; outputPath: string }> = [];
    for (const row of rows) {
        const releaseMbid = String(row.release_mbid || "").trim();
        if (!releaseMbid) continue;
        editions.set(`${row.library_id ?? ""}:${row.album_edition_id ?? releaseMbid}`, {
            releaseMbid,
            libraryId: row.library_id,
        });
        const resolved = resolveStoredLibraryPath({
            filePath: row.file_path,
            libraryRoot: row.library_root,
            relativePath: row.relative_path,
        });
        if (!resolved) continue;
        if (metadataConfig.save_album_cover) {
            sidecars.push({ releaseMbid, outputPath: path.join(path.dirname(resolved), coverName) });
        }
    }

    const resolvedCovers = new Set<string>();
    const failures: string[] = [];
    const stepTotal = Math.max(1, editions.size + sidecars.length);
    let step = 0;
    const tick = (): void => {
        step += 1;
        onFileStart?.(step, stepTotal);
    };
    for (const { releaseMbid, libraryId } of editions.values()) {
        tick();
        try {
            const albumMbid = albumMbidForEdition(releaseMbid);
            if (albumMbid) {
                const albumUrl = await resolveAlbumArtwork({ albumMbid });
                if (albumUrl) resolvedCovers.add(releaseMbid);
            }
            if (albumMbid && releaseGroupHasMultipleMonitoredEditions(albumMbid)) {
                const editionUrl = await resolveEditionArtwork({ releaseMbid, libraryId });
                if (editionUrl) {
                    discardEditionCoverIfDuplicateOfAlbum(releaseMbid, albumMbid);
                    resolvedCovers.add(releaseMbid);
                }
            }
        } catch (error) {
            failures.push(`edition ${releaseMbid}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    for (const { releaseMbid, outputPath } of sidecars) {
        tick();
        try {
            let result = await materializeMediaCoverToFile({
                entityId: releaseMbid,
                coverEntity: "Edition",
                coverTypes: "cover",
                outputPath,
            });
            if (result === "missing") {
                const albumMbid = albumMbidForEdition(releaseMbid);
                if (albumMbid) {
                    result = await materializeMediaCoverToFile({
                        entityId: albumMbid,
                        coverEntity: "Album",
                        coverTypes: "cover",
                        outputPath,
                    });
                }
            }
            // A locked database records its own follow-up and must not fail the import.
            if (result === "deferred") continue;
            if (resolvedCovers.has(releaseMbid) && result === "missing") {
                failures.push(`edition ${releaseMbid}: resolved artwork was not present in the media-cover cache`);
            }
        } catch (error) {
            if (isSqliteBusyError(error)) {
                recordArtworkMaterializeFollowUp({
                    entityId: releaseMbid,
                    coverEntity: "Edition",
                    coverTypes: ["cover"],
                    outputPath,
                    reason: "database is locked",
                });
                continue;
            }
            failures.push(`${outputPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // Artwork is decoration on imported media. The audio is already in place
    // and tracked, so a cover problem is reported and left to the metadata
    // backfill instead of failing (and later re-downloading) the whole album.
    for (const failure of failures) {
        console.warn(`[ImportDownload] Album artwork not materialized; import kept: ${failure}`);
    }
}

/**
 * Import tagging reads Albums.genres. The artist-summary upsert does not write
 * genres; only full release-group detail does. Hydrate any dest album whose
 * genres are still empty so the tagger sees catalog genres, not the downloader's
 * leftover single genre. Does not change the tagger.
 */
export async function ensureAlbumCatalogGenresForFileIds(fileIds: readonly number[]): Promise<void> {
    const ids = Array.from(new Set(
        fileIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0),
    ));
    if (ids.length === 0) return;

    const rows = db.prepare(`
        SELECT DISTINCT
          album.mbid AS mbid,
          album.artist_mbid AS artistMbid,
          album.genres AS genres
        FROM TrackFiles file
        JOIN Albums album ON album.mbid = file.canonical_release_group_mbid
        WHERE file.id IN ${SQL_JSON_LIST}
          AND file.file_type = 'track'
          AND album.mbid IS NOT NULL
    `).all(jsonList(ids)) as Array<{ mbid: string; artistMbid: string | null; genres: string | null }>;

    const missing = rows.filter((row) => {
        const raw = String(row.genres || "").trim();
        return !raw || raw === "[]" || raw === "null";
    });
    if (missing.length === 0) return;

    const { servarrMetadata } = await import("../metadata/servarr-metadata.js");
    const byArtist = new Map<string, string[]>();
    for (const row of missing) {
        const artistMbid = String(row.artistMbid || "").trim();
        const mbid = String(row.mbid || "").trim();
        if (!artistMbid || !mbid) continue;
        const bucket = byArtist.get(artistMbid) ?? [];
        bucket.push(mbid);
        byArtist.set(artistMbid, bucket);
    }
    for (const [artistMbid, mbids] of byArtist) {
        try {
            await servarrMetadata.syncArtistReleaseGroups(artistMbid, mbids);
        } catch (error) {
            console.warn(`[ImportDownload] Failed to hydrate catalog genres for ${mbids.length} album(s) of ${artistMbid}:`, error);
        }
    }
}

export class ImportDownloadCancelledError extends Error {
    constructor(phase: string) {
        super(`Import cancelled at safe boundary: ${phase}`);
        this.name = "ImportDownloadCancelledError";
    }
}

export function isImportDownloadCancelledError(error: unknown): error is ImportDownloadCancelledError {
    return error instanceof ImportDownloadCancelledError;
}

/**
 * Read the persisted cancellation marker as well as terminal/missing command
 * state. Command workers have their own JS heap, so the database marker is the
 * cross-thread half of cooperative import cancellation.
 */
export function isImportDownloadCancellationRequested(commandId: number): boolean {
    const command = CommandQueueManager.get(commandId);
    return !command
        || command.status !== "started"
        || command.payload.importCancellationRequested === true;
}

export type ImportDownloadState = {
    progress?: number;
    description?: string;
    currentFileNum?: number;
    totalFiles?: number;
    currentTrack?: string;
    currentTrackNum?: number | null;
    currentVolumeNum?: number | null;
    currentProviderTrackId?: string | null;
    trackProgress?: number;
    trackStatus?: "queued" | "downloading" | "completed" | "error" | "skipped";
    statusMessage?: string;
    state?: "queued" | "downloading" | "completed" | "failed" | "paused" | "importPending" | "importing" | "importFailed";
    /** Renews liveness without changing the displayed percent. Set at the start of each file. */
    subphaseTick?: boolean;
    outcome?: "ok" | "completedWithWarning";
    warningMessage?: string;
    primaryProvider?: string;
    fallbackProvider?: string;
};

type ImportHistoryContext = {
    artistId: string | null;
    albumId: string | null;
    mediaId: string | null;
    quality: string | null;
};

type ImportHistoryContextRow = {
    artist_id?: string | null;
    album_id?: string | null;
    media_id?: string | null;
    quality?: string | null;
};

const MEDIA_EXTENSIONS = new Set([
    ".flac",
    ".mp3",
    ".m4a",
    ".mp4",
    ".aac",
    ".ogg",
    ".opus",
    ".wav",
    ".wma",
    ".ape",
    ".mp2",
    ".mkv",
    ".mov",
    ".webm",
    ".avi",
]);

function workspaceContainsMediaFiles(dir: string): boolean {
    if (!fs.existsSync(dir)) {
        return false;
    }

    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
            continue;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const fullPath = `${current}/${entry.name}`;
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }

            if (entry.isFile() && MEDIA_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase())) {
                return true;
            }
        }
    }

    return false;
}

const AUDIO_IMPORT_EXTENSIONS = new Set([
    ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".wma", ".ape", ".mp2",
]);

function listWorkspaceAudioFiles(dir: string): string[] {
    const files: string[] = [];
    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) continue;
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(fullPath);
            else if (entry.isFile() && AUDIO_IMPORT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                files.push(fullPath);
            }
        }
    }
    return files.sort((left, right) => left.localeCompare(right));
}

interface PreparedImportQuality {
    sourceQuality: string;
    importedQuality: string;
}

async function prepareWorkspaceForLibraryProfile(
    downloadPath: string,
    libraryId: number,
    isCancelled?: () => boolean,
): Promise<Map<string, PreparedImportQuality>> {
    const library = db.prepare(`
        SELECT quality_profile_id FROM Libraries WHERE id = ? AND enabled = 1
    `).get(libraryId) as { quality_profile_id: number } | undefined;
    if (!library) throw new Error(`Import library ${libraryId} is unavailable`);
    const profile = new QualityProfileRepository(db).get(library.quality_profile_id);
    const outcomes = new Map<string, PreparedImportQuality>();

    const files = listWorkspaceAudioFiles(downloadPath);
    const assessed: Array<{ filePath: string; decision: ImportQualityDecision }> = [];
    for (const filePath of files) {
        if (isCancelled?.()) throw new ImportDownloadCancelledError("quality-profile conversion");
        const metrics = await parseAudioFile(filePath);
        const legacyQuality = deriveQuality(path.extname(filePath), metrics);
        const normalizedQuality = isSpatialAudioQuality(legacyQuality)
            ? "spatial"
            : classifyNeutralAudio(legacyQuality);
        if (!metrics.codec || !normalizedQuality) {
            throw new Error(`Cannot verify audio quality for ${path.basename(filePath)} from its stream codec/profile`);
        }
        assessed.push({
            filePath,
            decision: decideImportedQuality(profile, {
                quality: normalizedQuality,
                codec: metrics.codec,
                extension: path.extname(filePath),
                bitDepth: metrics.bitDepth,
                sampleRate: metrics.sampleRate,
                bitrate: metrics.bitrate,
                spatialFormat: normalizedQuality === "spatial" ? legacyQuality : null,
            }),
        });
    }

    /**
     * An album is one product, and a provider that has Atmos for fourteen of
     * fifteen tracks is normal. Rejecting the odd stereo track file-by-file
     * failed the entire album import, which leaves the spatial library with
     * nothing at all rather than with one track at a lower tier — and a gap in
     * an album nobody asked for is worse than an honest tier badge on one
     * track. Such a track belongs in this library by virtue of being on this
     * album; its real quality is still what gets recorded.
     *
     * The gate itself stays. If *nothing* here satisfies the profile then the
     * download was wrong for this library, and that is a failure worth having.
     */
    const satisfying = assessed.filter(({ decision }) => decision.accepted && decision.importedQuality);
    if (satisfying.length === 0) {
        const first = assessed[0];
        throw new Error(
            first
                ? `Source ${path.basename(first.filePath)} does not satisfy ${profile.name}: ${first.decision.reason}`
                : `No audio files to import for ${profile.name}`,
        );
    }
    for (const { filePath, decision } of assessed) {
        if (isCancelled?.()) throw new ImportDownloadCancelledError("quality-profile conversion");
        if (!decision.accepted || !decision.importedQuality) {
            console.warn(
                `[ImportDownload] ${path.basename(filePath)} does not satisfy ${profile.name} `
                + `(${decision.reason}); importing it anyway because the rest of the album does, `
                + "rather than leaving a hole in the album",
            );
            continue;
        }
        const result = await transcodeForQualityProfile(filePath, decision, { isCancelled });
        const providerKey = path.basename(result.outputPath, path.extname(result.outputPath));
        outcomes.set(providerKey, {
            sourceQuality: decision.sourceQuality,
            importedQuality: decision.importedQuality,
        });
    }
    return outcomes;
}

/**
 * Attach each prepared quality decision to the exact TrackFiles row the organize
 * produced for that provider track.
 *
 * The previous version updated `WHERE provider_id = ?` with no provider and no
 * entity type, so a colliding id from another provider could be rewritten, and
 * `library_id IS NULL` let it adopt an arbitrary unassigned legacy row. Worse, an
 * outcome whose key did not match a processed id fell through to a POSITIONAL
 * fallback that zipped the two lists by index — silently stamping one track's
 * quality onto another track's file whenever the counts happened to agree.
 *
 * Both are gone. Every decision is applied by row id, the row is verified to be
 * the audio track file this operation touched, and anything unresolved or
 * ambiguous throws instead of guessing.
 */
export function persistPreparedImportQuality(
    libraryId: number,
    outcomes: ReadonlyMap<string, PreparedImportQuality>,
    organizeResult: OrganizeResult,
    provider: string | null,
): void {
    const importedTrackFileIds = organizeResult.importedTrackFileIds ?? {};
    const processed = new Set(organizeResult.processedTrackIds.map(String));

    // Decisions are prepared by scanning the download workspace, which can hold
    // debris from an earlier download that failed part-way (an Apple decrypt
    // error leaves its partial files behind). Those files are not ours, so a
    // decision keyed to one simply has nothing to apply — dropping it is the
    // whole correction. Failing the import instead let one stale file from a
    // previous operation abort an otherwise complete one: a real download of 12
    // tracks died reporting 18 unorganized ids spanning three providers.
    //
    // This does NOT relax the check below. What made the old positional
    // fallback dangerous was *guessing* which row a decision belonged to; a
    // decision for a track we organized but cannot resolve is still a bug and
    // still throws.
    const applicable = new Map<string, PreparedImportQuality>();
    const foreignKeys: string[] = [];
    for (const [key, outcome] of outcomes) {
        if (processed.has(String(key))) {
            applicable.set(String(key), outcome);
        } else {
            foreignKeys.push(String(key));
        }
    }
    if (foreignKeys.length > 0) {
        console.warn(
            `[ImportDownload] Ignoring ${foreignKeys.length} prepared quality decision(s) for files this operation did not organize`
            + ` (stale download workspace content): ${foreignKeys.join(", ")}`,
        );
    }

    // Every remaining decision must resolve to exactly one TrackFiles row.
    const missingRows = [...applicable.keys()].filter((key) => importedTrackFileIds[key] == null);
    if (missingRows.length > 0) {
        throw new Error(
            `[ImportDownload] No imported TrackFiles row reported for ${missingRows.length} track(s) with prepared quality: ${missingRows.join(", ")}`,
        );
    }

    const distinctRowIds = new Set(
        [...applicable.keys()].map((key) => importedTrackFileIds[key]),
    );
    if (distinctRowIds.size !== applicable.size) {
        throw new Error(
            `[ImportDownload] ${applicable.size} prepared quality decision(s) map onto only ${distinctRowIds.size} distinct TrackFiles row(s); refusing to guess`,
        );
    }

    // Provider identity is still checked on the row itself: the reported id must
    // belong to this provider's track file, not merely exist.
    const loadRow = db.prepare(`
        SELECT id, provider, provider_entity_type, file_type, library_id
        FROM TrackFiles
        WHERE id = ?
    `);
    const update = db.prepare(`
        UPDATE TrackFiles
        SET
          library_id = @libraryId,
          file_class = 'audio',
          source_quality = @sourceQuality,
          imported_quality = @importedQuality
        WHERE id = @fileId
    `);

    db.transaction(() => {
        for (const [providerTrackId, outcome] of applicable) {
            const fileId = importedTrackFileIds[providerTrackId];
            const row = loadRow.get(fileId) as {
                id: number;
                provider: string | null;
                provider_entity_type: string | null;
                file_type: string | null;
                library_id: number | null;
            } | undefined;
            if (!row) {
                throw new Error(
                    `[ImportDownload] Reported TrackFiles row ${fileId} for track ${providerTrackId} does not exist`,
                );
            }
            if (row.file_type !== "track") {
                throw new Error(
                    `[ImportDownload] Reported TrackFiles row ${fileId} for track ${providerTrackId} is a ${row.file_type ?? "null"} file, not a track`,
                );
            }
            // Quality is applied by the organizer's TrackFiles.id. A composite
            // or mid-album fallback stamps the *supplying* provider on the file
            // while the command still names the album's provider. That mismatch
            // is not an identity error — provenance rewrites the stamp from the
            // offer next. Failing here left correctly-filed files with a failed
            // command (`tidal` vs `apple-music` on Aerosmith spatial).
            if (provider && row.provider && row.provider !== provider) {
                console.warn(
                    `[ImportDownload] TrackFiles row ${fileId} is stamped ${row.provider} while the command provider is ${provider}; applying quality by row id`,
                );
            }
            if (row.library_id != null && row.library_id !== libraryId) {
                throw new Error(
                    `[ImportDownload] Reported TrackFiles row ${fileId} already belongs to library ${row.library_id}, not ${libraryId}`,
                );
            }
            update.run({
                libraryId,
                sourceQuality: outcome.sourceQuality,
                importedQuality: outcome.importedQuality,
                fileId,
            });
        }
    })();
}

/**
 * Persist the provider resource and source variant selected before download on
 * the exact TrackFiles rows reported by the organizer.
 *
 * No provider-id lookup is used to find a file row. The external id is only a
 * consistency check between the operation result and the exact internal
 * ProviderItems row carried by the acquisition command.
 */
/**
 * One provider item on two editions of the same recording is one provenance.
 * Contexts that name different recordings stay ambiguous.
 * The edition being imported picks which of the same-recording contexts is stamped.
 */
export function selectProvenanceOffer(
    providerTrackId: string,
    candidates: readonly DownloadTrackOffer[],
    releaseMbid?: string | null,
): DownloadTrackOffer {
    if (candidates.length === 1) return candidates[0];
    const recordingIds = candidates.map((offer) => String(offer.canonicalRecordingMbid || "").trim());
    const sameRecording = recordingIds.every((id) => id.length > 0) && new Set(recordingIds).size === 1;
    const refuse = (): never => {
        throw new Error(
            `[ImportDownload] Downloaded track ${providerTrackId} has ${candidates.length} exact offer contexts; refusing ambiguous provenance`,
        );
    };
    if (!sameRecording) refuse();

    const release = String(releaseMbid || "").trim();
    if (release) {
        const onRelease = new Set((db.prepare(`
            SELECT track.mbid AS mbid
            FROM Tracks track
            JOIN AlbumEditions edition ON edition.id = track.album_edition_id
            WHERE edition.mbid = ?
        `).all(release) as Array<{ mbid: string | null }>)
            .map((row) => String(row.mbid || ""))
            .filter(Boolean));
        const planned = candidates.filter((offer) =>
            offer.canonicalTrackMbid && onRelease.has(offer.canonicalTrackMbid));
        if (planned.length === 1) return planned[0];
        if (planned.length > 1 && new Set(planned.map((offer) => offer.providerTrackItemId)).size === 1) {
            return planned[0];
        }
    }
    if (new Set(candidates.map((offer) => offer.providerTrackItemId)).size === 1) return candidates[0];
    refuse();
}

export function persistDownloadedProviderProvenance(
    libraryId: number | null | undefined,
    organizeResult: OrganizeResult,
    trackOffers: readonly DownloadTrackOffer[],
    acquisitionPlanId?: number | null,
    releaseMbid?: string | null,
): void {
    if (trackOffers.length === 0) {
        if (acquisitionPlanId != null && organizeResult.processedTrackIds.length > 0) {
            throw new Error(
                `[ImportDownload] Acquisition plan ${acquisitionPlanId} imported tracks without exact provider offer identity`,
            );
        }
        return;
    }

    const loadFile = db.prepare(`
        SELECT id, provider, provider_entity_type, provider_id, file_type, library_id
        FROM TrackFiles
        WHERE id = ?
    `);
    const loadProviderItem = db.prepare(`
        SELECT id, provider, entity_type, provider_id
        FROM ProviderItems
        WHERE id = ?
    `);
    const loadVariant = db.prepare(`
        SELECT id, provider_item_id
        FROM ProviderItemAudioVariants
        WHERE id = ?
    `);
    const hasSourceOccurrence = db.prepare(`
        SELECT 1 FROM ProviderEditionMembers
        WHERE provider_edition_item_id = ? AND member_item_id = ?
        LIMIT 1
    `);
    const update = db.prepare(`
        UPDATE TrackFiles
        SET
          library_id = COALESCE(@libraryId, library_id),
          provider_item_id = @providerItemId,
          source_audio_variant_id = @sourceAudioVariantId,
          provider = @provider,
          provider_entity_type = 'track',
          provider_id = @providerExternalId
        WHERE id = @fileId
    `);

    db.transaction(() => {
        for (const providerTrackId of organizeResult.processedTrackIds) {
            const fileId = organizeResult.importedTrackFileIds[String(providerTrackId)];
            if (fileId == null) {
                throw new Error(
                    `[ImportDownload] No imported TrackFiles row reported for downloaded track ${providerTrackId}`,
                );
            }
            const file = loadFile.get(fileId) as {
                id: number;
                provider: string | null;
                provider_entity_type: string | null;
                provider_id: string | null;
                file_type: string;
                library_id: number | null;
            } | undefined;
            if (!file || file.file_type !== "track") {
                throw new Error(
                    `[ImportDownload] Reported TrackFiles row ${fileId} for ${providerTrackId} is not an audio track`,
                );
            }
            if (libraryId != null && file.library_id != null && file.library_id !== libraryId) {
                throw new Error(
                    `[ImportDownload] Reported TrackFiles row ${fileId} belongs to library ${file.library_id}, not ${libraryId}`,
                );
            }

            /**
             * The offer is the authority on where a track came from; the file's
             * stamped provider is only a tie-breaker.
             *
             * A composite plan draws its tracks from several provider releases,
             * so a download queued against an Apple Music album can legitimately
             * carry a TIDAL-sourced track. The organizer stamps such a file with
             * the *command's* provider, and using that to filter offers then
             * excluded the one real candidate and failed an import whose files
             * were already correctly placed. Provider narrows a genuine
             * ambiguity; it never removes the only answer.
             */
            const byTrackId = trackOffers.filter((offer) =>
                String(offer.providerTrackId) === String(providerTrackId));
            const narrowed = byTrackId.length > 1 && file.provider
                ? byTrackId.filter((offer) => offer.provider === file.provider)
                : byTrackId;
            const candidates = narrowed.length > 0 ? narrowed : byTrackId;
            if (candidates.length === 0) {
                throw new Error(
                    `[ImportDownload] Downloaded track ${providerTrackId} has 0 exact offer contexts; refusing ambiguous provenance`,
                );
            }
            const offer = selectProvenanceOffer(String(providerTrackId), candidates, releaseMbid);
            if (!Number.isInteger(offer.providerTrackItemId) || Number(offer.providerTrackItemId) <= 0) {
                throw new Error(
                    `[ImportDownload] Downloaded track ${providerTrackId} has no exact provider_item_id`,
                );
            }
            const providerItem = loadProviderItem.get(offer.providerTrackItemId) as {
                id: number;
                provider: string;
                entity_type: string;
                provider_id: string;
            } | undefined;
            if (
                !providerItem
                || providerItem.entity_type !== "track"
                || providerItem.provider !== offer.provider
                || String(providerItem.provider_id) !== String(offer.providerTrackId)
            ) {
                throw new Error(
                    `[ImportDownload] Provider item ${offer.providerTrackItemId} does not identify ${offer.provider}:track:${offer.providerTrackId}`,
                );
            }
            // The file's stamped provider is the command's, which for a
            // composite plan is not necessarily the track's. Once the offer is
            // unambiguous it is the authority, and the update below rewrites
            // the stamp to match. Only a *contested* track id could redirect
            // provenance, and the narrowing above already settles that.
            if (file.provider && file.provider !== providerItem.provider && byTrackId.length > 1) {
                throw new Error(
                    `[ImportDownload] Reported TrackFiles row ${fileId} belongs to provider ${file.provider}, not ${providerItem.provider}`,
                );
            }
            if (file.provider_entity_type && file.provider_entity_type !== "track") {
                throw new Error(
                    `[ImportDownload] Reported TrackFiles row ${fileId} has provider entity type ${file.provider_entity_type}, not track`,
                );
            }
            // Same reasoning: the id the organizer stamped can be the album's.
            if (file.provider_id
                && String(file.provider_id) !== String(providerItem.provider_id)
                && byTrackId.length > 1) {
                throw new Error(
                    `[ImportDownload] Reported TrackFiles row ${fileId} identifies provider track ${file.provider_id}, not ${providerItem.provider_id}`,
                );
            }

            let sourceAudioVariantId: number | null = null;
            if (offer.providerAudioVariantId != null) {
                const variant = loadVariant.get(offer.providerAudioVariantId) as {
                    id: number;
                    provider_item_id: number;
                } | undefined;
                let belongsToSource = variant?.provider_item_id === providerItem.id;
                if (variant && !belongsToSource && offer.providerEditionItemId === variant.provider_item_id) {
                    const parent = loadProviderItem.get(variant.provider_item_id) as {
                        id:number;provider:string;entity_type:string;provider_id:string;
                    } | undefined;
                    belongsToSource = parent?.provider === providerItem.provider && parent.entity_type === 'release'
                        && parent.provider_id === offer.providerAlbumId
                        && hasSourceOccurrence.get(parent.id,providerItem.id) != null;
                }
                if (!variant || !belongsToSource) {
                    throw new Error(
                        `[ImportDownload] Audio variant ${offer.providerAudioVariantId} does not belong to provider item ${providerItem.id} or its exact source edition`,
                    );
                }
                sourceAudioVariantId = variant.id;
                if (variant.provider_item_id === providerItem.id) {
                    recordDeliveredQuality(fileId, variant.id);
                }
            }

            update.run({
                fileId,
                libraryId: libraryId ?? null,
                providerItemId: providerItem.id,
                sourceAudioVariantId,
                provider: providerItem.provider,
                providerExternalId: providerItem.provider_id,
            });
        }
    })();
}

function recoverExistingLibraryImport(
    type: string,
    providerId: string,
    provider: string,
    libraryId?: number | null,
): OrganizeResult | null {
    const recovered = getExistingLibraryFiles(type as any, providerId, provider, libraryId);
    if (recovered.length === 0) {
        return null;
    }

    // Recovery reports the SAME exact operation identity a fresh organize would,
    // so downstream per-file writes never fall back to id-shaped guessing.
    const importedTrackFileIds: Record<string, number> = {};
    for (const entry of recovered) {
        importedTrackFileIds[entry.mediaId] = entry.trackFileId;
    }

    const expectedTracks = resolveExpectedRecoveredTracks(type, providerId, recovered.length, provider);
    return {
        type,
        providerId,
        processedTrackIds: recovered.map((entry) => entry.mediaId),
        totalTracksInStaging: recovered.length,
        expectedTracks,
        importedTrackFileIds,
    } as OrganizeResult;
}

function providerImportEntityType(type: string): "release" | "track" | "video" {
    return type === "album" ? "release" : type === "video" ? "video" : "track";
}

/**
 * Resolve the canonical identity a provider download maps to, entirely through
 * the typed match authority (ProviderEditionMatches / ProviderEditionMembers →
 * ProviderTrackMatches / ProviderVideoMatches → canonical rows). ProviderItems
 * no longer stores canonical MBIDs or scalar quality, so nothing here reads a
 * provider-shadow column; quality is best-effort from the normalized audio
 * variant boundary. Values feed diagnostic import-history events only.
 */
function resolveImportHistoryContext(
    type: string,
    providerId: string,
    provider: string,
): ImportHistoryContext {
    const entityType = providerImportEntityType(type);
    const rows = db.prepare(`
        SELECT
            COALESCE(managed_artist.id, artist.mbid) AS artist_id,
            COALESCE(direct_group.mbid, track_group.mbid) AS album_id,
            COALESCE(track_recording.mbid, video_recording.mbid) AS media_id,
            (
                SELECT COALESCE(variant.provider_quality_label, variant.quality_class)
                FROM ProviderItemAudioVariants variant
                WHERE variant.provider_item_id = pi.id
                  AND variant.availability = 'available'
                ORDER BY
                  CASE variant.quality_class
                    WHEN 'spatial' THEN 0
                    WHEN 'hires-lossless' THEN 1
                    WHEN 'lossless' THEN 2
                    ELSE 3
                  END,
                  variant.id
                LIMIT 1
            ) AS quality
        FROM ProviderItems pi
        LEFT JOIN ProviderEditionMatches release_match
          ON pi.entity_type = 'release'
         AND release_match.provider_edition_item_id = pi.id
         AND release_match.match_state = 'accepted'
        LEFT JOIN AlbumEditions direct_release ON direct_release.id = release_match.edition_id
        LEFT JOIN Albums direct_group ON direct_group.id = direct_release.release_group_id
        LEFT JOIN ProviderTrackMatches track_match
          ON pi.entity_type = 'track'
         AND track_match.provider_track_item_id = pi.id
         AND track_match.match_state = 'accepted'
        LEFT JOIN Tracks track ON track.id = track_match.track_id
        LEFT JOIN Recordings track_recording ON track_recording.id = track_match.recording_id
        LEFT JOIN AlbumEditions track_release ON track_release.id = track.album_edition_id
        LEFT JOIN Albums track_group ON track_group.id = track_release.release_group_id
        LEFT JOIN ProviderVideoMatches video_match
          ON pi.entity_type = 'video'
         AND video_match.provider_video_item_id = pi.id
         AND video_match.match_state = 'accepted'
        LEFT JOIN Recordings video_recording ON video_recording.id = video_match.recording_id
        LEFT JOIN ArtistMetadata artist
          ON artist.id = COALESCE(
            direct_group.artist_metadata_id,
            track_group.artist_metadata_id,
            track_recording.artist_metadata_id,
            video_recording.artist_metadata_id
          )
        LEFT JOIN ArtistMetadata managed_artist ON managed_artist.mbid = artist.mbid
        WHERE pi.provider_id = ?
          AND pi.entity_type = ?
          AND pi.provider = ?
    `).all(
        providerId,
        entityType,
        provider,
    ) as ImportHistoryContextRow[];

    const agreedValue = (values: Array<string | null | undefined>): string | null => {
        const distinct = new Set(
            values
                .map((value) => value == null ? "" : String(value).trim())
                .filter(Boolean),
        );
        return distinct.size === 1 ? [...distinct][0] : null;
    };

    return {
        artistId: agreedValue(rows.map((row) => row.artist_id)),
        albumId: agreedValue(rows.map((row) => row.album_id)),
        mediaId: type === "album" ? null : agreedValue(rows.map((row) => row.media_id)),
        quality: agreedValue(rows.map((row) => row.quality)),
    };
}

function resolveAffectedArtistId(type: string, providerId: string, provider: string): string | null {
    return resolveImportHistoryContext(type, providerId, provider).artistId;
}

function resolveExpectedRecoveredTracks(
    type: string,
    providerId: string,
    fallbackCount: number,
    provider: string,
): number {
    if (type !== "album") {
        return Math.max(1, fallbackCount);
    }

    const normalizedProviderId = String(providerId || "").trim();
    if (!normalizedProviderId) {
        return fallbackCount;
    }

    const row = db.prepare(`
        SELECT COUNT(DISTINCT member.member_item_id) AS count
        FROM ProviderItems provider_release
        JOIN ProviderEditionMembers member
          ON member.provider_edition_item_id = provider_release.id
        JOIN ProviderItems provider_track
          ON provider_track.id = member.member_item_id
         AND provider_track.provider = provider_release.provider
         AND provider_track.entity_type = 'track'
        WHERE provider_release.provider_id = ?
          AND provider_release.entity_type = 'release'
          AND provider_release.provider = ?
    `).get(
        normalizedProviderId,
        provider,
    ) as { count?: number } | undefined;

    return Number(row?.count || fallbackCount);
}

/** The job's own canonical context, when the acquisition plan supplied one. */
type ImportReconcileContext = {
    releaseGroupMbid?: string | null;
    releaseMbid?: string | null;
};

/**
 * The release group this job belongs to, from the job's OWN canonical context.
 *
 * The plan already decided which release group it was acquiring, so prefer that
 * over re-deriving it from provider matches. `releaseMbid` is resolved to its
 * group; a release MBID that is not in the catalogue yields null rather than a
 * guess.
 */
export function releaseGroupMbidFromJobContext(context: ImportReconcileContext): string | null {
    const explicitGroup = String(context.releaseGroupMbid || "").trim();
    if (explicitGroup) {
        return explicitGroup;
    }
    const explicitRelease = String(context.releaseMbid || "").trim();
    if (!explicitRelease) {
        return null;
    }
    const row = db.prepare(`
        SELECT release_group.mbid AS release_group_mbid
        FROM AlbumEditions release
        JOIN Albums release_group ON release_group.id = release.release_group_id
        WHERE release.mbid = ?
        LIMIT 1
    `).get(explicitRelease) as { release_group_mbid?: string | null } | undefined;
    return row?.release_group_mbid ?? null;
}

/**
 * The release group implied by a provider RELEASE's accepted matches, returned
 * only when every one of them agrees.
 *
 * One provider release can be accepted against several canonical releases (an
 * edition superset), and `ORDER BY confidence LIMIT 1` would silently pick a
 * winner — reconciling download state onto the wrong album. Disagreement yields
 * null so the caller falls back to something it can justify.
 */
function agreedReleaseGroupMbidForProviderRelease(
    providerId: string,
    provider: string | null,
): string | null {
    const row = db.prepare(`
        SELECT CASE
            WHEN COUNT(DISTINCT release_group.mbid) = 1 THEN MAX(release_group.mbid)
        END AS release_group_mbid
        FROM ProviderItems provider_release
        JOIN ProviderEditionMatches release_match
          ON release_match.provider_edition_item_id = provider_release.id
         AND release_match.match_state = 'accepted'
        JOIN AlbumEditions release
          ON release.id = release_match.edition_id
        JOIN Albums release_group
          ON release_group.id = release.release_group_id
        WHERE provider_release.entity_type = 'release'
          AND CAST(provider_release.provider_id AS TEXT) = CAST(? AS TEXT)
          AND (? IS NULL OR provider_release.provider = ?)
    `).get(providerId, provider, provider) as { release_group_mbid?: string | null } | undefined;
    return row?.release_group_mbid ?? null;
}

/** Same agree-or-null rule for a provider TRACK, via its typed track edges. */
function agreedReleaseGroupMbidForProviderTrack(
    providerId: string,
    provider: string | null,
): string | null {
    const row = db.prepare(`
        SELECT CASE
            WHEN COUNT(DISTINCT release_group.mbid) = 1 THEN MAX(release_group.mbid)
        END AS release_group_mbid
        FROM ProviderItems provider_track
        JOIN ProviderEditionMembers member
          ON member.member_item_id = provider_track.id
        JOIN ProviderTrackMatches track_match
          ON track_match.provider_edition_member_id = member.id
         AND track_match.match_state = 'accepted'
        JOIN Tracks track ON track.id = track_match.track_id
        JOIN AlbumEditions release ON release.id = track.album_edition_id
        JOIN Albums release_group ON release_group.id = release.release_group_id
        WHERE CAST(provider_track.provider_id AS TEXT) = CAST(? AS TEXT)
          AND provider_track.entity_type = 'track'
          AND (? IS NULL OR provider_track.provider = ?)
    `).get(providerId, provider, provider) as { release_group_mbid?: string | null } | undefined;
    return row?.release_group_mbid ?? null;
}

export function reconcileImportedDownload(
    type: string,
    providerId: string,
    organizeResult: OrganizeResult,
    provider?: string | null,
    context: ImportReconcileContext = {},
) {
    const normalizedProvider = provider || null;

    if (type === "album") {
        const processedIds = organizeResult.processedTrackIds;
        if (processedIds.length === 0) {
            throw new Error(`No tracks were successfully organized for album ${providerId}`);
        }

        const expected = organizeResult.expectedTracks || 0;
        if (processedIds.length < expected) {
            console.warn(`[ImportDownload] Album ${providerId}: only ${processedIds.length}/${expected} tracks were imported. Partial download.`);
        }

        const releaseGroupMbid = releaseGroupMbidFromJobContext(context)
            ?? agreedReleaseGroupMbidForProviderRelease(providerId, normalizedProvider);
        if (releaseGroupMbid) {
            updateAlbumDownloadStatus(releaseGroupMbid);
        } else {
            // No canonical group we can name. Recompute from the provider resource
            // instead of invalidating whatever album happens to share this id.
            updateArtistDownloadStatusFromMedia(String(providerId), normalizedProvider);
        }
        return;
    }

    if (type === "video") {
        updateArtistDownloadStatusFromMedia(String(providerId), normalizedProvider);
        return;
    }

    const releaseGroupMbid = releaseGroupMbidFromJobContext(context)
        ?? agreedReleaseGroupMbidForProviderTrack(providerId, normalizedProvider);
    if (releaseGroupMbid) {
        updateAlbumDownloadStatus(releaseGroupMbid);
    } else {
        updateArtistDownloadStatusFromMedia(String(providerId), normalizedProvider);
    }
}

export class DownloadedTracksImportService {
    static async process(
        job: ImportDownloadJob,
        options: {
            updateState: (state: ImportDownloadState) => void;
            /** Checked only at boundaries where stopping cannot roll back or corrupt an in-flight file move. */
            isCancelled?: () => boolean;
        },
    ): Promise<void> {
    const { type, providerId, resolved, originalJobId, path: payloadPath } = job.payload;
    const provider = String(job.payload.provider || "").trim();

    if (!type || !provider || !providerId) {
        throw new Error("ImportDownload job is missing the provider, type, or provider ID required to finish import.");
    }

    if (type !== "album" && type !== "track" && type !== "video") {
        throw new Error(`ImportDownload job has unsupported media type: ${type}`);
    }

    if (type === "video" && !Config.getFilteringConfig().include_videos) {
        console.log(`[ImportDownload] Skipping video import ${providerId} because music video monitoring (include_videos) is disabled in settings.`);
        const downloadPath = payloadPath
            ? validateDownloadWorkspacePath(payloadPath)
            : getDownloadWorkspacePath(type, providerId, provider || undefined);
        if (downloadPath && fs.existsSync(downloadPath)) {
            try { fs.rmSync(downloadPath, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
        options.updateState({
            progress: 100,
            description: "Video import skipped (music videos disabled in settings)",
            state: "completed",
            outcome: "ok",
        });
        return;
    }

    const downloadPath = payloadPath
        ? validateDownloadWorkspacePath(payloadPath)
        : getDownloadWorkspacePath(type, providerId, provider || undefined);
    let shouldCleanupDownloadPath = false;

    const cancellationCheckpoint = (phase: string): void => {
        if (options.isCancelled?.()) {
            throw new ImportDownloadCancelledError(phase);
        }
    };

    options.updateState({
        progress: 5,
        description: "ImportDownload: preparing import",
        statusMessage: "Preparing import",
        state: "importing",
    });

    try {
        cancellationCheckpoint("preparing import");
        let organizeResult: OrganizeResult;
        let preparedImportQuality = new Map<string, PreparedImportQuality>();
        const workspaceHasMedia = workspaceContainsMediaFiles(downloadPath);
        if (!workspaceHasMedia) {
            const recovered = recoverExistingLibraryImport(type, providerId, provider, job.payload.libraryId);
            if (!recovered) {
                throw new Error(`Import files for ${type} ${providerId} are no longer available. Re-download the item to retry import.`);
            }

            organizeResult = recovered;
            organizeResult.expectedTracks = expectedImportedTrackCount(job.payload, organizeResult.expectedTracks);

            options.updateState({
                progress: 70,
                description: "ImportDownload: recovering existing library files",
                currentFileNum: recovered.processedTrackIds.length,
                totalFiles: recovered.expectedTracks,
                statusMessage: "Recovering import from existing library files",
                state: "importing",
            });
            console.warn(`[ImportDownload] Download workspace missing or empty for ${type} ${providerId}, but imported library file(s) already exist. Recovering import job.`);
        } else {
            cancellationCheckpoint("before organizing downloaded files");
            markImportLibraryMutationStarted(job.id);
            if (type !== "video" && job.payload.libraryId != null) {
                options.updateState({
                    progress: 10,
                    description: "ImportDownload: applying quality profile",
                    statusMessage: "Applying library quality profile",
                    state: "importing",
                });
                preparedImportQuality = await prepareWorkspaceForLibraryProfile(
                    downloadPath,
                    job.payload.libraryId,
                    options.isCancelled,
                );
            }
            options.updateState({
                progress: 15,
                description: "ImportDownload: importing downloaded files",
                statusMessage: "Importing downloaded files",
                state: "importing",
            });
            organizeResult = await OrganizerService.organizeDownload({
                type,
                libraryId: job.payload.libraryId ?? null,
                providerId,
                provider: job.payload.provider || null,
                releaseGroupMbid: job.payload.releaseGroupMbid || null,
                releaseMbid: job.payload.releaseMbid || null,
                canonicalTrackMbid: job.payload.canonicalTrackMbid || null,
                canonicalRecordingMbid: job.payload.canonicalRecordingMbid || null,
                albumId: job.payload.albumId || null,
                albumTitle: job.payload.albumTitle || job.payload.album_title || null,
                slot: job.payload.slot || null,
                trackNumber: job.payload.trackNumber ?? null,
                volumeNumber: job.payload.volumeNumber ?? null,
                trackOffers: Array.isArray(job.payload.trackOffers) ? job.payload.trackOffers : undefined,
                downloadPath,
                onProgress: (progress) => {
                    // Organizer progress is emitted before each album track move
                    // and after a completed track. Those are safe boundaries:
                    // already-organized library files stay in place, while the
                    // untouched remainder can be removed with the staging root.
                    cancellationCheckpoint(`organizing downloaded files (${progress.phase})`);
                    const normalizedProgress = progress.phase === "finalizing"
                        ? 72
                        : progress.totalFiles && progress.currentFileNum !== undefined
                            ? Math.max(15, Math.min(70, 15 + Math.round((progress.currentFileNum / Math.max(progress.totalFiles, 1)) * 55)))
                            : 35;

                    options.updateState({
                        progress: normalizedProgress,
                        description: `ImportDownload: ${progress.statusMessage || "Importing downloaded files"}`,
                        currentFileNum: progress.currentFileNum,
                        totalFiles: progress.totalFiles,
                        currentTrack: progress.currentTrack,
                        currentTrackNum: progress.currentTrackNum,
                        currentVolumeNum: progress.currentVolumeNum,
                        currentProviderTrackId: progress.currentProviderTrackId,
                        trackProgress: progress.totalFiles === 1 && progress.currentFileNum === 1 ? 100 : undefined,
                        trackStatus: progress.trackStatus ?? (progress.phase === "finalizing" ? "completed" : progress.currentTrack ? "downloading" : undefined),
                        statusMessage: progress.statusMessage,
                        state: "importing",
                    });
                },
            });
        }

        organizeResult.expectedTracks = expectedImportedTrackCount(job.payload, organizeResult.expectedTracks);
        // Retries can leave several formats of one provider track in staging.
        // Count track identities, not the number of files organized for them.
        organizeResult.processedTrackIds = [...new Set(organizeResult.processedTrackIds)];
        cancellationCheckpoint("after organizing downloaded files");
        if (type !== "video") {
            await withSqliteWriteGate(() => persistDownloadedProviderProvenance(
                job.payload.libraryId,
                organizeResult,
                Array.isArray(job.payload.trackOffers) ? job.payload.trackOffers : [],
                job.payload.acquisitionPlanId,
                job.payload.releaseMbid,
            ), "import:provenance");
        }
        const importLibraryId = job.payload.libraryId;
        if (importLibraryId != null && preparedImportQuality.size > 0) {
            await withSqliteWriteGate(() => persistPreparedImportQuality(
                importLibraryId,
                preparedImportQuality,
                organizeResult,
                provider,
            ), "import:quality");
        }

        options.updateState({
            progress: 78,
            description: "ImportDownload: reconciling library state",
            currentFileNum: organizeResult.processedTrackIds.length,
            totalFiles: organizeResult.expectedTracks || organizeResult.totalTracksInStaging,
            statusMessage: "Reconciling imported library state",
            state: "importing",
        });

        await withSqliteWriteGate(() => reconcileImportedDownload(type, providerId, organizeResult, provider, {
            releaseGroupMbid: job.payload.releaseGroupMbid || null,
            releaseMbid: job.payload.releaseMbid || null,
        }), "import:reconcile");
        cancellationCheckpoint("after reconciling library state");

        const affectedArtistId = resolveAffectedArtistId(type, providerId, provider);
        if (affectedArtistId) {
            cancellationCheckpoint("before refreshing artist statistics");
            options.updateState({
                progress: 82,
                description: "ImportDownload: verifying library file records",
                currentFileNum: organizeResult.processedTrackIds.length,
                totalFiles: organizeResult.expectedTracks || organizeResult.totalTracksInStaging,
                statusMessage: "Verifying library file records",
                state: "importing",
            });

            // The organizer already creates track_files records for every file
            // it processes (tracks, videos, covers, lyrics, etc.) via upsertLibraryFile().
            // A full DiskScanService.scan() here is unnecessary — it would re-walk the
            // entire artist directory and re-parse every unmapped audio file (1-5s per FLAC).
            // Instead, just verify the imported files are tracked.
            const trackedCount = (db.prepare(
                `SELECT COUNT(*) as count FROM TrackFiles WHERE artist_metadata_id = ? AND verified_at IS NOT NULL`,
            ).get(String(affectedArtistId)) as { count: number }).count;

            console.log(`[ImportDownload] Artist ${affectedArtistId}: ${trackedCount} library files tracked after import (skipped full disk scan)`);
            await ArtistStatisticsService.refreshAsync([affectedArtistId]);
            cancellationCheckpoint("after refreshing artist statistics");
        }

        if ((type === "album" || type === "track") && organizeResult.processedTrackIds.length > 0) {
            // Catalog identity / album refresh and provider tag supplements are
            // network work. They run outside the disk-exclusive import slot:
            // supplements + lyrics are prefetched at download completion
            // (prefetchImportNetworkData) and identity is resolved after the
            // import released its acquisition plan (resolveImportedCatalogIdentity).
            // Running identity here also always failed with
            // AcquisitionPlanInUseError, because this import owns that plan.
            const importedFileIds = importedLibraryFileIds(organizeResult);
            if (importedFileIds.length === 0) {
                throw new Error(
                    `[ImportDownload] Organizer reported ${organizeResult.processedTrackIds.length} processed audio item(s) without exact TrackFiles row identity`,
                );
            }
            rememberImportTouchedFiles(job.id, importedFileIds);
            const reportFile = (index: number, total: number, progress: number, description: string): void => {
                options.updateState({
                    progress,
                    description,
                    statusMessage: description,
                    currentFileNum: index,
                    totalFiles: total,
                    state: "importing",
                    subphaseTick: true,
                });
            };
            const metadataConfig = Config.getMetadataConfig();
            const qualityConfig = Config.getQualityConfig();
            if (metadataConfig.save_album_cover || qualityConfig.embed_cover) {
                options.updateState({ progress: 90, description: "ImportDownload: caching artwork", statusMessage: "Caching artwork", state: "importing" });
                cancellationCheckpoint("before caching dest album artwork");
                await ensureDestAlbumArtworkForFileIds(importedFileIds, (index, total) => {
                    reportFile(index, total, 90, "ImportDownload: caching artwork");
                });
            }

            let lyricResult: TrackLyricsMaterializeResult | null = null;
            options.updateState({ progress: 92, description: "ImportDownload: preparing lyrics", statusMessage: "Preparing lyrics", state: "importing" });
            cancellationCheckpoint("before materializing lyrics");
            try {
                lyricResult = importedFileIds.length > 0
                    ? await TrackLyricsMaterializer.materializeForFileIds(
                        importedFileIds,
                        null,
                        job.payload.prefetchedLyrics as any,
                        (index, total) => reportFile(index, total, 92, "ImportDownload: preparing lyrics"),
                    )
                    : await TrackLyricsMaterializer.materializeForMediaIds(
                        organizeResult.processedTrackIds,
                        provider,
                    );
                if (lyricResult.discovered > 0) {
                    console.log(
                        `[ImportDownload] Lyrics resolved for ${lyricResult.discovered} track(s); ` +
                        `${lyricResult.saved} new sidecar(s) saved`,
                    );
                }
            } catch (error) {
                // Lyrics are optional media extras. A provider outage must not
                // roll back otherwise valid audio already placed in the library.
                console.warn(`[ImportDownload] Failed to materialize lyrics for ${type} ${providerId}:`, error);
            }
            cancellationCheckpoint("after materializing lyrics");

            options.updateState({
                progress: 94,
                description: "ImportDownload: applying audio tag rules",
                currentFileNum: organizeResult.processedTrackIds.length,
                totalFiles: organizeResult.expectedTracks || organizeResult.totalTracksInStaging,
                statusMessage: "Applying audio tag rules",
                state: "importing",
            });

            cancellationCheckpoint("before applying audio tag rules");
            await ensureAlbumCatalogGenresForFileIds(importedFileIds);
            if (isAudioTagMaintenanceEnabled(metadataConfig, qualityConfig)) {
                const retagResult = await AudioTagService.apply(importedFileIds, {
                    includeExternalLyrics: lyricResult !== null,
                    lyricsByProviderMedia: lyricResult?.lyricsByProviderMedia,
                    onFileStart: (index, total) => reportFile(index, total, 94, "ImportDownload: applying audio tag rules"),
                });
                assertImportedAudioTagsApplied(retagResult, `${type} ${providerId}`);
            }
            cancellationCheckpoint("after applying audio tag rules");
        }

        if (type === "video" && organizeResult.processedTrackIds.length > 0) {
            cancellationCheckpoint("before applying video tag rules");
            options.updateState({
                progress: 94,
                description: "ImportDownload: applying video tag rules",
                currentFileNum: organizeResult.processedTrackIds.length,
                totalFiles: organizeResult.totalTracksInStaging,
                statusMessage: "Applying video tag rules",
                state: "importing",
            });
            const videoFileIds = importedLibraryFileIds(organizeResult);
            if (videoFileIds.length === 0) throw new Error("Video importer did not report exact TrackFiles identities");
            rememberImportTouchedFiles(job.id, videoFileIds);
            const retagResult = await VideoTagService.apply(videoFileIds, {
                onFileStart: (index, total) => options.updateState({
                    progress: 94,
                    description: "ImportDownload: applying video tag rules",
                    statusMessage: "Applying video tag rules",
                    currentFileNum: index,
                    totalFiles: total,
                    state: "importing",
                    subphaseTick: true,
                }),
            });
            if (retagResult.errors.length > 0 || retagResult.missing > 0) {
                throw new Error(`Video tagging failed for ${providerId}: ${retagResult.errors.map(item => item.error).join("; ") || "imported file is missing"}`);
            }
            cancellationCheckpoint("after applying video tag rules");
        }

        try {
            const settledFileIds = importedLibraryFileIds(organizeResult);
            if (settledFileIds.length > 0) {
                const recordingIds = (db.prepare(`
                    SELECT DISTINCT recording_id AS id
                    FROM TrackFiles
                    WHERE id IN ${SQL_JSON_LIST}
                      AND recording_id IS NOT NULL
                `).all(jsonList(settledFileIds)) as Array<{ id: number }>).map((row) => row.id);
                LibraryFilesService.settleImportedRecordings(recordingIds);
            }
        } catch (settleError) {
            console.warn("[ImportDownload] Unmonitored-file settlement failed:", settleError);
        }

        cancellationCheckpoint("before recording import history");
        const historyContext = resolveImportHistoryContext(type, providerId, provider);
        try {
            await withSqliteWriteGate(() => recordHistoryEvent({
                artistId: historyContext.artistId,
                albumId: historyContext.albumId,
                mediaId: historyContext.mediaId,
                eventType: HISTORY_EVENT_TYPES.DownloadImported,
                quality: historyContext.quality,
                sourceTitle: String(resolved?.title || providerId),
                data: {
                    type,
                    providerId,
                    originalJobId: originalJobId ?? null,
                    processedTrackIds: {
                        count: organizeResult.processedTrackIds.length,
                        expected: organizeResult.expectedTracks ?? organizeResult.totalTracksInStaging ?? null,
                    },
                },
            }), "import:history");
        } catch (historyError) {
            console.warn(`[ImportDownload] Failed to write DownloadImported history event for ${type} ${providerId}:`, historyError);
        }

        const expectedProcessedTracks = organizeResult.expectedTracks ?? 0;
        const trackOfferCount = Array.isArray(job.payload.trackOffers) ? job.payload.trackOffers.length : 0;
        const acquisitionMode = String(job.payload.acquisitionMode || "").trim();
        const isTrackOffersJob = downloadsSelectedOffers(job.payload) && trackOfferCount > 0;
        // Soft-incomplete for normal full-album downloads (bonus files, etc.).
        // Hybrid trackOffers must not green-check when most catalog tracks never landed.
        const softIncomplete = type === "album"
            && !isTrackOffersJob
            && expectedProcessedTracks > 0
            && organizeResult.processedTrackIds.length < expectedProcessedTracks;
        const hardIncomplete = shouldHardFailIncompleteAlbumImport({
            type,
            acquisitionMode,
            provider,
            processedCount: organizeResult.processedTrackIds.length,
            trackOfferCount,
        });

        if (softIncomplete || hardIncomplete) {
            try {
                await withSqliteWriteGate(() => recordHistoryEvent({
                    artistId: historyContext.artistId,
                    albumId: historyContext.albumId,
                    mediaId: historyContext.mediaId,
                    eventType: HISTORY_EVENT_TYPES.AlbumImportIncomplete,
                    quality: historyContext.quality,
                    sourceTitle: String(resolved?.title || providerId),
                    data: {
                        type,
                        providerId,
                        originalJobId: originalJobId ?? null,
                        unorganizedTrackOffers: isTrackOffersJob
                            ? describeUnorganizedTrackOffers(job.payload.trackOffers ?? [], organizeResult.processedTrackIds)
                            : undefined,
                        totalTracksInStaging: organizeResult.totalTracksInStaging,
                        processedTrackIds: {
                            count: organizeResult.processedTrackIds.length,
                            expected: isTrackOffersJob
                                ? trackOfferCount
                                : expectedProcessedTracks,
                        },
                    },
                }), "import:history");
            } catch (historyError) {
                console.warn(`[ImportDownload] Failed to write AlbumImportIncomplete history event for ${type} ${providerId}:`, historyError);
            }
        }

        if (hardIncomplete) {
            const processed = organizeResult.processedTrackIds.length;
            const missing = describeUnorganizedTrackOffers(
                Array.isArray(job.payload.trackOffers) ? job.payload.trackOffers : [],
                organizeResult.processedTrackIds,
            );
            console.warn(
                `[ImportDownload] Hybrid album ${providerId}: ${organizeResult.totalTracksInStaging} file(s) in staging; `
                + `not organized: ${missing.join("; ") || "none identified"}`,
            );
            throw new Error(
                `Hybrid album import incomplete for ${providerId}: organized ${processed}/${trackOfferCount} offered tracks `
                + `(${organizeResult.totalTracksInStaging} in staging). Not organized: ${missing.slice(0, 5).join("; ")}`
                + `${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}. Refusing to mark the job complete.`,
            );
        }

        cancellationCheckpoint("before completing import");
        const liveCommand = CommandQueueManager.get(job.id);
        const liveDownloadState = (liveCommand?.payload?.downloadState || {}) as Record<string, unknown>;
        const payloadDownloadState = (job.payload?.downloadState || {}) as Record<string, unknown>;
        const existingDownloadState = {
            ...payloadDownloadState,
            ...liveDownloadState,
        };
        const warningMessage = typeof existingDownloadState.warningMessage === "string"
            ? existingDownloadState.warningMessage.trim()
            : "";
        const completedWithWarning = existingDownloadState.outcome === "completedWithWarning" && Boolean(warningMessage);
        options.updateState({
            progress: 100,
            description: "ImportDownload: completed",
            currentFileNum: organizeResult.processedTrackIds.length,
            totalFiles: organizeResult.expectedTracks || organizeResult.totalTracksInStaging,
            statusMessage: completedWithWarning ? warningMessage : "Import completed",
            state: "completed",
            ...(completedWithWarning
                ? {
                    outcome: "completedWithWarning" as const,
                    warningMessage,
                    primaryProvider: typeof existingDownloadState.primaryProvider === "string"
                        ? existingDownloadState.primaryProvider
                        : undefined,
                    fallbackProvider: typeof existingDownloadState.fallbackProvider === "string"
                        ? existingDownloadState.fallbackProvider
                        : undefined,
                }
                : {}),
        });

        shouldCleanupDownloadPath = true;
    } catch (error) {
        if (isImportDownloadCancelledError(error)) {
            // Only the validated download workspace is disposable. Files already
            // moved into a configured library root are deliberately preserved.
            shouldCleanupDownloadPath = true;
            throw error;
        }

        const historyContext = resolveImportHistoryContext(type, providerId, provider);
        const message = error instanceof Error ? error.message : String(error);
        try {
            await withSqliteWriteGate(() => recordHistoryEvent({
                artistId: historyContext.artistId,
                albumId: historyContext.albumId,
                mediaId: historyContext.mediaId,
                eventType: HISTORY_EVENT_TYPES.DownloadFailed,
                quality: historyContext.quality,
                sourceTitle: String(resolved?.title || providerId),
                data: {
                    type,
                    providerId,
                    originalJobId: originalJobId ?? null,
                    error: message,
                },
            }), "import:history");
        } catch (historyError) {
            console.warn(`[ImportDownload] Failed to write DownloadFailed history event for ${type} ${providerId}:`, historyError);
        }

        throw error;
    } finally {
        if (shouldCleanupDownloadPath) {
            try {
                fs.rmSync(downloadPath, { recursive: true, force: true });
                removeEmptyParents(path.dirname(downloadPath), Config.getDownloadPath());
            } catch {
                // ignore cleanup errors
            }
        }
    }
    }
}


/**
 * Network work for an import, run by the download slot right after the bytes
 * finished downloading and before the import queues for the disk-exclusive
 * slot. Best-effort: anything missing is looked up again by the import.
 */
export async function prefetchImportNetworkData(payload: {
    type: string;
    provider?: string | null;
    providerId: string;
    trackOffers?: Array<{ providerTrackId?: string | null }> | null;
    downloadPath?: string | null;
}): Promise<{ prefetchedLyrics?: Record<string, unknown> }> {
    const provider = String(payload.provider || "").trim();
    if (!provider || (payload.type !== "album" && payload.type !== "track")) return {};
    try {
        await ProviderTrackTagSupplementService.refresh({
            providerId: provider,
            albumProviderIds: payload.type === "album" ? [payload.providerId] : [],
            trackProviderIds: payload.type === "track" ? [payload.providerId] : [],
        });
    } catch (error) {
        console.warn(`[ImportDownload] Prefetch of provider tag supplements failed for ${payload.type} ${payload.providerId}:`, error);
    }
    try {
        let trackIds: string[];
        if (payload.type === "track") {
            trackIds = [payload.providerId];
        } else if (Array.isArray(payload.trackOffers) && payload.trackOffers.length > 0) {
            trackIds = payload.trackOffers.map((offer) => String(offer?.providerTrackId || "")).filter(Boolean);
        } else {
            trackIds = (db.prepare(`
                SELECT track.provider_id AS id
                FROM ProviderItems release
                JOIN ProviderEditionMembers member ON member.provider_edition_item_id = release.id
                JOIN ProviderItems track ON track.id = member.member_item_id
                WHERE release.provider = ? AND release.entity_type = 'release' AND release.provider_id = ?
            `).all(provider, payload.providerId) as Array<{ id: string }>).map((row) => String(row.id));
        }
        const { prefetchProviderLyrics } = await import("./track-lyrics-materializer.js");
        return { prefetchedLyrics: await prefetchProviderLyrics(provider, trackIds, 4, payload.downloadPath) };
    } catch (error) {
        console.warn(`[ImportDownload] Lyrics prefetch failed for ${payload.type} ${payload.providerId}:`, error);
        return {};
    }
}

/** Catalog identity + album metadata refresh after an import completed and
 * released its acquisition plan. Never runs inside the disk-exclusive slot. */
export async function resolveImportedCatalogIdentity(type: string, providerId: string, provider: string | null): Promise<void> {
    try {
        if (type === "album") {
            await MetadataIdentityService.resolveAlbum(providerId, { provider: provider || undefined } as any);
            const { RefreshAlbumService } = await import("../music/refresh-album-service.js");
            await RefreshAlbumService.refreshMetadata(providerId, { provider: provider || undefined });
        } else if (type === "track") {
            await MetadataIdentityService.resolveTrack(providerId, { provider: provider || undefined } as any);
        }
    } catch (error) {
        console.warn(`[ImportDownload] Post-import catalog identity refresh failed for ${type} ${providerId}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

const STEREO_QUALITY_LADDER: Record<string, number> = {
    "low": 1,
    "lossy": 2,
    "high": 2,
    "lossless": 3,
    "hires-lossless": 4,
};

function stereoLadderRank(value: string | null | undefined): number | null {
    const normalized = String(value || "").trim().toLowerCase().replace(/_/g, "-");
    const key = normalized === "hires" || normalized === "hi-res-lossless" ? "hires-lossless" : normalized;
    return STEREO_QUALITY_LADDER[key] ?? null;
}

/**
 * Compare what the provider advertised for this exact track variant with what
 * the provider actually delivered (source_quality: the downloaded stream as
 * probed BEFORE any profile conversion, so our own downconvert never counts as
 * an under-delivery). When the file is below the advertisement (TIDAL
 * "HIRES_LOSSLESS" that streams as 16/44.1), record the delivered class on the
 * variant and on plan tracks that use it, so the track/album badge and future
 * plan ranking stop treating it as hi-res. provider_quality_label is left as
 * advertised. Spatial variants are not touched.
 */
export function recordDeliveredQuality(fileId: number, variantId: number): void {
    // Measured stream class, before any profile conversion. The provider's own
    // quality_class / label are never touched here: they are source capability.
    const row = db.prepare(`
        SELECT
          COALESCE(NULLIF(TRIM(file.source_quality), ''), NULLIF(TRIM(file.imported_quality), ''), NULLIF(TRIM(file.quality), '')) AS measured,
          variant.quality_class AS advertised
        FROM TrackFiles file
        JOIN ProviderItemAudioVariants variant ON variant.id = ?
        WHERE file.id = ?
    `).get(variantId, fileId) as { measured: string | null; advertised: string | null } | undefined;
    if (!row) return;
    const measuredRank = stereoLadderRank(row.measured);
    if (measuredRank == null || stereoLadderRank(row.advertised) == null) return;
    const delivered = ({ 1: "lossy", 2: "lossy", 3: "lossless", 4: "hires-lossless" } as Record<number, string>)[measuredRank];
    db.prepare(`
        UPDATE ProviderItemAudioVariants
        SET delivered_quality_class = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND delivered_quality_class IS NOT ?
    `).run(delivered, variantId, delivered);
}
