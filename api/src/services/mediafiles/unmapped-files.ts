import fs from "fs";
import path from "path";
import * as mm from "music-metadata";
import { getConfigSection } from "../config/config.js";
import { isReleaseStatusIncluded } from "../metadata/musicbrainz-release-group-filter.js";

/** A JSON array of strings or objects (name/format fields), or a plain string. */
function jsonStrings(raw: string | null, fields: string[] = []): string[] {
    if (!raw) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return [raw]; }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.flatMap((item) => {
        if (typeof item === "string") return [item];
        if (item && typeof item === "object") {
            for (const field of fields) {
                const value = (item as Record<string, unknown>)[field];
                if (typeof value === "string" && value) return [value];
            }
        }
        return [];
    });
}

/** Medium formats; a medium without a format counts as "Unknown" (Lidarr media_format). */
function mediaFormats(raw: string | null): string[] {
    let parsed: unknown;
    try { parsed = JSON.parse(raw ?? "[]"); } catch { return []; }
    if (!Array.isArray(parsed)) return [];
    return parsed.map((m) => {
        const f = m && typeof m === "object" ? ((m as Record<string, unknown>).format ?? (m as Record<string, unknown>).Format) : null;
        return typeof f === "string" && f.trim() ? f : "Unknown";
    });
}

function yearOf(date: string | null): number | null {
    const match = date ? /^(\d{4})/.exec(date) : null;
    return match ? Number(match[1]) : null;
}
import { db, withDbWrite } from "../../database.js";
import { RequestValidationError } from "../../utils/request-validation.js";
import { CommandNames } from "../commands/command-names.js";
import { CommandQueueManager } from "../commands/command-queue-manager.js";
import { isAutoImportStatusAllowed, planFolderAutoImport, titleDistance, type AutoImportCandidateRelease, type AutoImportFile, type CandidateQuery, type FingerprintEvidence, type FolderAutoImportPlan } from "./folder-auto-import-plan.js";
import { UnmappedFileRepository, type UnmappedFile } from "../../repositories/mediafiles/UnmappedFileRepository.js";
import { IdentificationService, type AlbumCandidateMatch } from "./identification-service.js";
import { ImportDecisionEngine } from "../import-decision/engine.js";
import type { ImportDecisionMode } from "../import-decision/types.js";
import type { LocalFile, LocalGroup, ProviderMatch } from "./import-types.js";
import { ImportService } from "./import-service.js";
import { CatalogCandidateService } from "./candidate-service.js";
import { normalizeComparableText, stringSimilarity } from "./import-matching-utils.js";
import {
    identifyAudioFileByAcoustId,
    type AcoustIdIdentificationResult,
} from "./acoustid-identification-service.js";

import { albumCoverLocalUrl, videoCoverLocalUrl } from "../metadata/media-cover-service.js";

const unmappedFileRepository = new UnmappedFileRepository(db);

function getRelativeDirectory(file: Pick<UnmappedFile, "relative_path">): string {
    const normalized = file.relative_path.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    return lastSlash >= 0 ? normalized.slice(0, lastSlash) : "";
}

function mostCommonNonEmpty(values: Array<string | null | undefined>): string | null {
    const counts = new Map<string, number>();
    for (const value of values) {
        const normalized = value?.trim();
        if (!normalized) continue;
        counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }

    let bestValue: string | null = null;
    let bestCount = -1;
    for (const [value, count] of counts.entries()) {
        if (count > bestCount) {
            bestValue = value;
            bestCount = count;
        }
    }

    return bestValue;
}

async function readEmbeddedMusicBrainzRecordingMbid(filePath: string): Promise<string | null> {
    try {
        const metadata = await mm.parseFile(filePath, { duration: false, skipCovers: true });
        const common = metadata.common as unknown as Record<string, unknown>;
        const commonValue = common.musicbrainz_recordingid ?? common.musicbrainz_trackid;
        if (typeof commonValue === "string" && commonValue.trim()) {
            return commonValue.trim();
        }
        for (const tags of Object.values(metadata.native || {})) {
            for (const tag of tags || []) {
                const normalizedId = String(tag.id || "").toLowerCase().replace(/[^a-z0-9]/g, "");
                if (
                    normalizedId !== "musicbrainztrackid"
                    && normalizedId !== "musicbrainzrecordingid"
                ) {
                    continue;
                }
                const value = Array.isArray(tag.value) ? tag.value[0] : tag.value;
                const normalizedValue = String(value || "").trim();
                if (normalizedValue) return normalizedValue;
            }
        }
    } catch {
        // An unreadable tag block is exactly when fingerprinting is useful.
    }
    return null;
}

/** Release groups the online lookup may add per folder, and how close their title must be. */
const ONLINE_LOOKUP_MAX_GROUPS = 5;
const ONLINE_LOOKUP_TITLE_DISTANCE = 0.25;

type AutoImportAction =
    | { type: "review"; reason: string }
    | { type: "add-missing-release"; album: string }
    | { type: "monitor"; libraryId: number; editionId: number; selectionMode: "auto"; locked: false }
    | { type: "import"; unmappedFileId: number; trackId: number; effects: Array<"rename" | "retag" | "cover" | "register"> };

type AutoImportFolderReport = {
    folder: string;
    fileIds: number[];
    decision: "import" | "review";
    reason?: string;
    needsEvidence?: "online" | "fingerprint";
    editionId?: number;
    libraryId?: number;
    mappings?: Array<{ unmappedFileId: number; trackId: number }>;
    queued?: number;
    /** True when this call did not move, rename, tag, or delete any library file. */
    filesUntouched: boolean;
    actions: AutoImportAction[];
};

export type PlanningIdentity = {
    tags: Record<string, string>;
    /** Seconds from the file itself. Null when the container does not say. */
    durationSeconds: number | null;
};

export class UnmappedFilesService {
    constructor(
        private readonly repository: UnmappedFileRepository = unmappedFileRepository,
        private readonly importService: ImportService = new ImportService(),
        private readonly identifyByAcoustId = identifyAudioFileByAcoustId,
        private readonly readEmbeddedRecordingMbid = readEmbeddedMusicBrainzRecordingMbid,
        private readonly readTags: (filePath: string) => Promise<PlanningIdentity> = readIdentityTags,
    ) { }

    listFiles(limit?: number, offset?: number): { items: UnmappedFile[]; total: number } {
        return {
            items: this.repository.findAll(limit, offset),
            total: this.repository.count(),
        };
    }

    async getCandidateGuesses(files: UnmappedFile[]): Promise<Record<number, {
        title: string;
        artistName: string;
        cover: string | null;
        score?: number;
    }>> {
        const groups = new Map<string, UnmappedFile[]>();
        for (const file of files) {
            const dir = getRelativeDirectory(file);
            const key = `${file.library_root}:${dir}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(file);
        }

        const result: Record<number, { title: string; artistName: string; cover: string | null; score?: number }> = {};

        for (const [, groupFiles] of groups) {
            try {
                const topMatch = await this.findBestAlbumCandidate(groupFiles);
                const albumOrRecording = (topMatch?.item || (topMatch as any)?.album || (topMatch as any)?.recording) as any;
                if (albumOrRecording) {
                    const mbid = albumOrRecording.mbid || albumOrRecording.id || albumOrRecording.providerId;
                    const isVideo = topMatch?.itemType === "video" || groupFiles[0]?.library_root === "videos";
                    const coverUrl = isVideo
                        ? (mbid ? videoCoverLocalUrl(String(mbid)) : null)
                        : (mbid ? albumCoverLocalUrl({ albumMbid: String(mbid) }) : null);

                    const candidateInfo = {
                        id: String(mbid || ''),
                        title: String(albumOrRecording.title || albumOrRecording.name || groupFiles[0].detected_album || groupFiles[0].filename),
                        artistName: String(albumOrRecording.artistName || albumOrRecording.artist_name || albumOrRecording.artist?.name || albumOrRecording.artists?.[0]?.name || groupFiles[0].detected_artist || 'Unknown Artist'),
                        cover: coverUrl || albumOrRecording.cover || albumOrRecording.imageId || albumOrRecording.picture || null,
                        score: topMatch?.score,
                    };
                    for (const f of groupFiles) {
                        result[f.id] = candidateInfo;
                    }
                } else if (groupFiles[0].detected_artist || groupFiles[0].detected_album) {
                    const fallbackInfo = {
                        id: '',
                        title: String(groupFiles[0].detected_album || groupFiles[0].detected_track || groupFiles[0].filename),
                        artistName: String(groupFiles[0].detected_artist || 'Unknown Artist'),
                        cover: null,
                    };
                    for (const f of groupFiles) {
                        result[f.id] = fallbackInfo;
                    }
                }
            } catch (err) {
                console.warn("[UnmappedFiles] Candidate guess failed:", err);
            }
        }

        return result;
    }

    getFile(id: number): UnmappedFile | undefined {
        return this.repository.findById(id);
    }

    async identifyFileByAcoustId(unmappedFileId: number): Promise<{
        file: { id: number; path: string };
        identification: AcoustIdIdentificationResult;
        canonicalOccurrences: Array<{
            recordingId: number;
            recordingMbid: string;
            recordingTitle: string;
            trackId: number;
            trackMbid: string;
            trackTitle: string;
            editionId: number;
            releaseMbid: string;
            editionTitle: string;
            albumId: number;
            releaseGroupMbid: string;
            albumTitle: string;
        }>;
    }> {
        const file = this.repository.findById(unmappedFileId);
        if (!file) throw new Error("Unmapped file not found");
        if (!fs.existsSync(file.file_path)) throw new Error("Unmapped file is missing from disk");
        if (file.library_root === "videos") {
            throw new Error("AcoustID identifies audio recordings, not video files");
        }

        const embeddedRecordingMbid = await this.readEmbeddedRecordingMbid(file.file_path);
        const identification = await this.identifyByAcoustId(file.file_path, {
            embeddedRecordingMbid,
        });
        const recordingIds = identification.recordingIds;
        const canonicalOccurrences = recordingIds.length === 0
            ? []
            : db.prepare(`
                SELECT
                  recording.id AS recordingId,
                  recording.mbid AS recordingMbid,
                  recording.title AS recordingTitle,
                  track.id AS trackId,
                  track.mbid AS trackMbid,
                  track.title AS trackTitle,
                  edition.id AS editionId,
                  edition.mbid AS releaseMbid,
                  edition.title AS editionTitle,
                  album.id AS albumId,
                  album.mbid AS releaseGroupMbid,
                  album.title AS albumTitle
                FROM Recordings recording
                JOIN Tracks track ON track.recording_id = recording.id
                JOIN AlbumEditions edition ON edition.id = track.album_edition_id
                JOIN Albums album ON album.id = edition.release_group_id
                WHERE recording.mbid IN (${recordingIds.map(() => "?").join(",")})
                ORDER BY
                  recording.mbid,
                  edition.date,
                  edition.id,
                  track.medium_position,
                  track.position,
                  track.id
              `).all(...recordingIds) as Array<{
                recordingId: number;
                recordingMbid: string;
                recordingTitle: string;
                trackId: number;
                trackMbid: string;
                trackTitle: string;
                editionId: number;
                releaseMbid: string;
                editionTitle: string;
                albumId: number;
                releaseGroupMbid: string;
                albumTitle: string;
              }>;

        return {
            file: { id: file.id, path: file.file_path },
            identification,
            canonicalOccurrences,
        };
    }

    setIgnored(id: number, ignored: boolean): void {
        this.repository.setIgnored(id, ignored);
    }

    setIgnoredBulk(ids: number[], ignored: boolean): number {
        const files = this.repository.findByIds(ids);
        const validIds = files.map((file) => file.id);
        this.repository.setIgnoredByIds(validIds, ignored);
        return validIds.length;
    }

    private assertDeletableUnmappedFile(filePath: string): void {
        const normalized = String(filePath || "").replace(/\\/g, "/");
        const trackOccupant = db.prepare(`
            SELECT id, file_path FROM TrackFiles
            WHERE LOWER(REPLACE(file_path, '\\', '/')) = LOWER(?)
            LIMIT 1
        `).get(normalized) as { id: number; file_path: string } | undefined;

        if (trackOccupant) {
            throw new RequestValidationError(
                `Refusing to delete unmapped file: path matches linked track file #${trackOccupant.id} (${trackOccupant.file_path})`
            );
        }

        const extraOccupant = db.prepare(`
            SELECT id, file_path FROM ExtraFiles
            WHERE LOWER(REPLACE(file_path, '\\', '/')) = LOWER(?)
            LIMIT 1
        `).get(normalized) as { id: number; file_path: string } | undefined;

        if (extraOccupant) {
            throw new RequestValidationError(
                `Refusing to delete unmapped file: path matches linked extra file #${extraOccupant.id} (${extraOccupant.file_path})`
            );
        }
    }

    deleteFile(id: number): void {
        const file = this.repository.findById(id);
        if (!file) {
            throw new Error("File not found in tracking DB");
        }

        this.assertDeletableUnmappedFile(file.file_path);

        if (fs.existsSync(file.file_path)) {
            fs.unlinkSync(file.file_path);
        }
        this.repository.delete(id);
    }

    deleteFiles(ids: number[]): number {
        const files = this.repository.findByIds(ids);
        for (const file of files) {
            this.assertDeletableUnmappedFile(file.file_path);
        }

        for (const file of files) {
            if (fs.existsSync(file.file_path)) {
                fs.unlinkSync(file.file_path);
            }
        }
        this.repository.deleteByIds(files.map((file) => file.id));
        return files.length;
    }

    listManualImportLibraries(): Array<{
        id: number;
        name: string;
        rootPath: string;
        qualityProfile: string;
    }> {
        return db.prepare(`
            SELECT
                library.id,
                library.name,
                library.root_path AS rootPath,
                profile.name AS qualityProfile
            FROM Libraries library
            JOIN quality_profiles profile ON profile.id = library.quality_profile_id
            WHERE library.enabled = 1
            ORDER BY library.id
        `).all() as Array<{
            id: number;
            name: string;
            rootPath: string;
            qualityProfile: string;
        }>;
    }

    getCanonicalImportRelease(identity: string): {
        id: number;
        mbid: string;
        releaseGroupId: number;
        releaseGroupMbid: string;
        title: string;
        disambiguation: string | null;
        date: string | null;
        country: string | null;
        mediumFormat: string | null;
        mediumCount: number | null;
        trackCount: number;
        tracks: Array<{
            id: number;
            mbid: string;
            recordingId: number;
            recordingMbid: string;
            mediumPosition: number;
            position: number;
            number: string | null;
            title: string;
            durationMs: number | null;
        }>;
    } | null {
        const numericId = Number(identity);
        const release = db.prepare(`
            SELECT
                release.id,
                release.mbid,
                release.release_group_id AS releaseGroupId,
                release_group.mbid AS releaseGroupMbid,
                release.title,
                release.disambiguation,
                release.date,
                release.country,
                release.media_count AS mediumCount,
                COALESCE(release.track_count, (
                    SELECT COUNT(*) FROM Tracks WHERE album_edition_id = release.id
                )) AS trackCount,
                (
                    SELECT GROUP_CONCAT(DISTINCT COALESCE(
                        json_extract(medium.value, '$.Format'),
                        json_extract(medium.value, '$.format')
                    ))
                    FROM json_each(release.media) medium
                ) AS mediumFormat
            FROM AlbumEditions release
            JOIN Albums release_group ON release_group.id = release.release_group_id
            WHERE release.mbid = ? OR release.id = ?
            LIMIT 1
        `).get(identity, Number.isInteger(numericId) ? numericId : -1) as {
            id: number;
            mbid: string;
            releaseGroupId: number;
            releaseGroupMbid: string;
            title: string;
            disambiguation: string | null;
            date: string | null;
            country: string | null;
            mediumFormat: string | null;
            mediumCount: number | null;
            trackCount: number;
        } | undefined;
        if (!release) return null;
        const tracks = db.prepare(`
            SELECT
                track.id,
                track.mbid,
                track.recording_id AS recordingId,
                recording.mbid AS recordingMbid,
                track.medium_position AS mediumPosition,
                track.position,
                track.number,
                track.title,
                COALESCE(track.length_ms, recording.length_ms) AS durationMs
            FROM Tracks track
            JOIN Recordings recording ON recording.id = track.recording_id
            WHERE track.album_edition_id = ?
              AND recording.is_video = 0
            ORDER BY track.medium_position, track.position, track.id
        `).all(release.id) as Array<{
            id: number;
            mbid: string;
            recordingId: number;
            recordingMbid: string;
            mediumPosition: number;
            position: number;
            number: string | null;
            title: string;
            durationMs: number | null;
        }>;
        return { ...release, tracks };
    }

    /**
     * Identify a group of local files against a specific release group, purely
     * from the local catalog (Lidarr: IdentificationService with an Album
     * override). `rawReleaseGroupMbid` is a MusicBrainz release-group MBID — no
     * translation to a streaming-provider id happens anywhere in this path.
     */
    async identifyAgainstAlbum(
        fileIds: number[],
        rawReleaseGroupMbid: string,
        mode: ImportDecisionMode = "ExistingFiles"
    ) {
        const cleanMbid = rawReleaseGroupMbid.replace(/^mbid-/, "");
        const files = this.repository.findByIds(fileIds);
        const identification = await IdentificationService.identifyUnmappedFiles(files, cleanMbid);

        const dbAlbum = db.prepare(`
            SELECT
                al.mbid AS id,
                al.mbid AS mbid,
                al.title AS title,
                a.name AS artist_name,
                a.mbid AS artist_mbid
            FROM Albums al
            JOIN ArtistMetadata a ON a.mbid = al.artist_mbid
            WHERE al.mbid = ? OR EXISTS (SELECT 1 FROM AlbumEditions rel WHERE rel.release_group_mbid = al.mbid AND rel.mbid = ?)
            LIMIT 1
        `).get(cleanMbid, cleanMbid) as any;

        const album = dbAlbum
            ? {
                id: dbAlbum.id,
                providerId: dbAlbum.id,
                title: dbAlbum.title,
                artist: { id: dbAlbum.artist_mbid, name: dbAlbum.artist_name },
                cover: albumCoverLocalUrl({ albumMbid: dbAlbum.id }),
            }
            : null;

        const evaluatedMatch = album
            ? this.evaluateAlbumCandidate(files, {
                ...identification,
                album,
                albumScore: 1,
                combinedScore: 1,
                closeMatchScore: 1,
            }, {
                matchType: "exact",
                directCandidateCount: 1,
                mode,
            })
            : null;

        return {
            ...identification,
            album,
            autoImportReady: evaluatedMatch?.autoImportReady ?? false,
            rejections: evaluatedMatch?.rejections ?? [],
            conflictPath: evaluatedMatch?.conflictPath ?? null,
        };
    }

    async findBestAlbumCandidate(
        files: UnmappedFile[],
        mode: ImportDecisionMode = "ExistingFiles"
    ): Promise<ProviderMatch | null> {
        if (files.length === 0) return null;
        if (files.some((file) => file.library_root === "videos")) {
            return this.findBestVideoCandidate(files, mode);
        }

        // Local-catalog discovery, equivalent to Lidarr's first candidate stage.
        // The configured canonical-catalog fallback Lidarr performs after this
        // stage is not implemented here yet. Streaming providers remain download-
        // only and must never become an identity fallback.
        const artist = mostCommonNonEmpty(files.map((file) => file.detected_artist));
        const album = mostCommonNonEmpty(files.map((file) => file.detected_album));
        const candidates = CatalogCandidateService.getReleaseGroupCandidates({ artist, album });
        if (candidates.length === 0) return null;

        const best = await IdentificationService.findBestAlbumMatch(files, candidates, mode);
        if (!best) return null;

        return this.evaluateAlbumCandidate(files, best, {
            matchType: "fuzzy",
            directCandidateCount: candidates.length,
            mode,
        });
    }

    private async findBestVideoCandidate(
        files: UnmappedFile[],
        _mode: ImportDecisionMode = "ExistingFiles",
    ): Promise<ProviderMatch | null> {
        const artist = mostCommonNonEmpty(files.map((file) => file.detected_artist));
        const title = mostCommonNonEmpty(files.map((file) => file.detected_track))
            || path.parse(files[0]?.filename || "").name;
        const duration = files[0]?.duration ?? null;
        const candidates = CatalogCandidateService.getVideoRecordingCandidates({
            artist,
            title,
            limit: 20,
        });
        const ranked = candidates
            .map((candidate) => {
                const titleScore = stringSimilarity(
                    normalizeComparableText(title),
                    normalizeComparableText(candidate.title),
                );
                const artistScore = artist
                    ? stringSimilarity(
                        normalizeComparableText(artist),
                        normalizeComparableText(candidate.artist_name),
                    )
                    : null;
                const durationScore = duration != null && candidate.duration != null
                    ? Math.max(0, 1 - Math.abs(duration - candidate.duration) / 30)
                    : null;
                const weights = [
                    { score: titleScore, weight: 0.65 },
                    ...(artistScore == null ? [] : [{ score: artistScore, weight: 0.25 }]),
                    ...(durationScore == null ? [] : [{ score: durationScore, weight: 0.10 }]),
                ];
                const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0);
                return {
                    candidate,
                    score: weights.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight,
                };
            })
            .sort((left, right) => right.score - left.score || left.candidate.mbid.localeCompare(right.candidate.mbid));
        const top = ranked[0];
        if (!top || top.score < 0.55) return null;
        const ambiguous = Boolean(ranked[1] && top.score - ranked[1].score < 0.15);
        const exact = normalizeComparableText(top.candidate.title) === normalizeComparableText(title)
            && (!artist || normalizeComparableText(top.candidate.artist_name) === normalizeComparableText(artist));
        return {
            item: top.candidate,
            itemType: "video",
            score: top.score,
            matchType: exact ? "exact" : "fuzzy",
            autoImportReady: false,
            rejections: ambiguous
                ? ["Ambiguous canonical video Recording candidates"]
                : ["Choose the destination Library and canonical MusicBrainz video Recording before import"],
            typedRejections: [{
                reason: ambiguous
                    ? "Ambiguous canonical video Recording candidates"
                    : "Choose the destination Library and canonical MusicBrainz video Recording before import",
                type: "permanent",
            }],
        };
    }

    private buildLocalGroup(files: UnmappedFile[]): LocalGroup {
        const groupFiles: LocalFile[] = files.map((file) => ({
            path: file.file_path,
            name: file.filename,
            size: file.file_size || 0,
            extension: `.${file.extension.replace(/^\./, "")}`.toLowerCase(),
            metadata: {
                common: {
                    artist: file.detected_artist || undefined,
                    albumartist: file.detected_artist || undefined,
                    album: file.detected_album || undefined,
                    title: file.detected_track || undefined,
                },
                format: {
                    duration: file.duration || undefined,
                },
            } as any,
        }));
        const firstFile = files[0];
        const groupPath = path.dirname(firstFile.file_path);

        return {
            id: Buffer.from(groupPath).toString("base64"),
            path: groupPath,
            rootPath: groupPath,
            libraryRoot: firstFile.library_root as LocalGroup["libraryRoot"],
            files: groupFiles,
            sidecars: [],
            commonTags: {
                artist: mostCommonNonEmpty(files.map((file) => file.detected_artist)) || undefined,
                album: mostCommonNonEmpty(files.map((file) => file.detected_album)) || undefined,
            },
            status: "queued",
        };
    }

    private buildTrackIdsByFilePath(files: UnmappedFile[], mappedTracks: Record<number, string>): Record<string, string> {
        const filesById = new Map(files.map((file) => [file.id, file]));
        const trackIdsByFilePath: Record<string, string> = {};

        for (const [fileId, providerId] of Object.entries(mappedTracks)) {
            const file = filesById.get(Number(fileId));
            if (!file) {
                continue;
            }

            trackIdsByFilePath[file.file_path] = providerId;
        }

        return trackIdsByFilePath;
    }

    private evaluateAlbumCandidate(
        files: UnmappedFile[],
        candidate: AlbumCandidateMatch,
        options: {
            matchType: ProviderMatch["matchType"];
            directCandidateCount?: number;
            strongFingerprintCandidateCount?: number;
            mode?: ImportDecisionMode;
        },
    ): ProviderMatch {
        const group = this.buildLocalGroup(files);
        const evaluatedMatch = ImportDecisionEngine.evaluateSingleMatch({
            group,
            match: {
                item: candidate.album,
                itemType: "album",
                score: candidate.combinedScore,
                closeMatchScore: candidate.closeMatchScore,
                matchType: options.matchType,
                confidence: candidate.confidence,
                closeMatchConfidence: candidate.closeMatchConfidence,
                coverage: candidate.coverage,
                matchedCount: candidate.matchedCount,
                totalFiles: candidate.totalFiles,
                autoImportReady: false,
                trackIdsByFilePath: this.buildTrackIdsByFilePath(files, candidate.mappedTracks),
            },
            mode: options.mode ?? "ExistingFiles",
            directCandidateCount: options.directCandidateCount,
            strongFingerprintCandidateCount: options.strongFingerprintCandidateCount,
        });

        return evaluatedMatch;
    }

    /**
     * Group the given unmapped files by folder and decide each folder.
     * `dryRun` reports the planned monitor, rename, retag, and cover actions
     * and does not queue work, write catalog rows, or touch files.
     */
    async autoImportByIds(ids: number[], options: { dryRun: boolean }): Promise<{
        dryRun: boolean;
        folders: AutoImportFolderReport[];
    }> {
        const seenFolders = new Set<string>();
        const folders: AutoImportFolderReport[] = [];
        for (const id of ids) {
            const file = this.getFile(id);
            if (!file) continue;
            const folder = path.dirname(file.file_path);
            if (seenFolders.has(folder)) continue;
            seenFolders.add(folder);
            const planned = await this.planAutoImportForFolder(file, { writeCatalog: !options.dryRun });
            const queued = options.dryRun ? undefined : await this.autoImportFolderGroup(file, planned);
            folders.push(this.describeAutoImport(folder, planned, { dryRun: options.dryRun, queued }));
        }
        return { dryRun: options.dryRun, folders };
    }

    /**
     * Re-evaluate existing non-ignored unmapped files whose file size/mtime
     * changed or whose artist catalog was updated since the last check.
     * Matching folders queue ImportUnmappedFiles (rename + retag); non-matching
     * folders update their reason, file_size, file_mtime_ms, and updated_at.
     */
    async recheckExistingUnmappedFiles(options?: {
        artistIds?: readonly string[];
    }): Promise<{ checkedFolders: number; skippedFolders: number; queuedFiles: number; updatedFolders: number }> {
        const allRows = this.repository.findAll().filter((row) => !row.ignored);
        const artistFilter = options?.artistIds?.length
            ? new Set(options.artistIds.map((id) => String(id).trim()).filter(Boolean))
            : null;
        let allowedArtistNames: Set<string> | null = null;
        if (artistFilter && artistFilter.size > 0) {
            allowedArtistNames = new Set<string>();
            for (const id of artistFilter) {
                const row = db.prepare("SELECT name FROM ArtistMetadata WHERE id = ? OR mbid = ? LIMIT 1").get(id, id) as { name?: string } | undefined;
                if (row?.name) allowedArtistNames.add(row.name.toLowerCase());
            }
        }

        const byFolder = new Map<string, UnmappedFile[]>();
        for (const row of allRows) {
            const folder = path.dirname(row.file_path);
            const list = byFolder.get(folder) ?? [];
            list.push(row);
            byFolder.set(folder, list);
        }

        let checkedFolders = 0;
        let skippedFolders = 0;
        let queuedFiles = 0;
        let updatedFolders = 0;

        for (const files of byFolder.values()) {
            const anchor = files[0];
            if (!anchor) continue;
            if (allowedArtistNames && allowedArtistNames.size > 0) {
                const folderArtist = String(anchor.detected_artist || "").trim().toLowerCase();
                if (!folderArtist || !allowedArtistNames.has(folderArtist)) continue;
            }

            let needsRecheck = false;
            const statsById = new Map<number, fs.Stats>();
            for (const file of files) {
                let stats: fs.Stats;
                try {
                    stats = fs.statSync(file.file_path);
                } catch {
                    continue;
                }
                statsById.set(file.id, stats);
                if (!isUnmappedFileCheckCurrent({
                    fileSize: file.file_size,
                    fileMtimeMs: file.file_mtime_ms ?? null,
                    updatedAt: file.updated_at ?? null,
                    statsSize: stats.size,
                    statsMtimeMs: stats.mtimeMs,
                    artistName: file.detected_artist,
                })) {
                    needsRecheck = true;
                }
            }

            if (statsById.size === 0) continue;
            if (!needsRecheck) {
                skippedFolders++;
                continue;
            }

            checkedFolders++;
            const planned = await this.planAutoImportForFolder(anchor, { writeCatalog: true });
            const queued = await this.autoImportFolderGroup(anchor, planned);
            if (queued > 0) {
                queuedFiles += queued;
            } else {
                updatedFolders++;
            }
            await withDbWrite(() => {
                const stamp = db.prepare(`
                    UPDATE UnmappedFiles
                    SET file_size = ?, file_mtime_ms = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `);
                for (const file of planned.files) {
                    const stats = statsById.get(file.id);
                    if (stats) stamp.run(stats.size, stats.mtimeMs, file.id);
                }
            });
        }

        return { checkedFolders, skippedFolders, queuedFiles, updatedFolders };
    }

    /**
     * Import one folder of unmapped files without a person when its tags prove
     * a single canonical release in the catalog and every file maps to its own
     * track (docs/PRODUCT_VISION.md ADR-2). Otherwise the folder stays in
     * Unmapped and every file gets the review reason. Returns the number of
     * files queued for import. Queuing does not delete an existing library copy;
     * the import command replaces a file only after the new one is in place.
     */
    async autoImportFolderGroup(
        anchorFile: UnmappedFile,
        planned?: { files: UnmappedFile[]; plan: FolderAutoImportPlan },
    ): Promise<number> {
        const result = planned ?? await this.planAutoImportForFolder(anchorFile);
        if (result.plan.decision !== "import") {
            const reason = `Auto-import: ${result.plan.reason}`;
            await withDbWrite(() => {
                const update = db.prepare("UPDATE UnmappedFiles SET reason = ? WHERE id = ?");
                for (const file of result.files) update.run(reason, file.id);
            });
            return 0;
        }

        const plan = result.plan;
        const sortedIds = plan.mappings.map((mapping) => mapping.unmappedFileId).sort((left, right) => left - right);
        await withDbWrite(() =>
            CommandQueueManager.push(
                CommandNames.ImportUnmappedFiles,
                {
                    applyStandardTags: true,
                    canonical: { libraryId: plan.libraryId, editionId: plan.editionId, mappings: plan.mappings },
                    title: "Auto-importing files",
                    description: `Auto-importing ${plan.mappings.length} file${plan.mappings.length === 1 ? "" : "s"}`,
                },
                `canonical-unmapped-import:${plan.libraryId}:${plan.editionId}:${sortedIds.join(",")}`,
            ),
        );
        return plan.mappings.length;
    }

    /** Catalog editions of the artist whose title is close to the album tag (read-only). */
    findCatalogCandidates(query: CandidateQuery): AutoImportCandidateRelease[] {
        if (!query.album) return [];
        const artistMbids = query.artistMbid
            ? [query.artistMbid]
            : (db.prepare("SELECT mbid FROM ArtistMetadata WHERE lower(name) = lower(?)").all(query.artistName ?? "") as Array<{ mbid: string }>).map((row) => row.mbid);
        const out: AutoImportCandidateRelease[] = [];
        for (const artistMbid of artistMbids) {
            const editions = db.prepare(`
                SELECT edition.id, edition.mbid, edition.title, edition.artist_mbid AS artistMbid,
                       album.title AS releaseGroupTitle,
                       (SELECT name FROM ArtistMetadata WHERE mbid = edition.artist_mbid) AS artistName,
                       album.first_release_date AS albumDate, edition.date AS releaseDate, edition.media_count AS mediaCount,
                       edition.media AS media, edition.country AS country, edition.label AS label,
                       edition.disambiguation AS disambiguation, edition.old_foreign_ids AS oldIds,
                       EXISTS(SELECT 1 FROM LibraryEditions le WHERE le.edition_id = edition.id AND le.library_id = ?) AS preferred,
                       edition.status AS status,
                       EXISTS(SELECT 1 FROM AcquisitionPlans plan WHERE plan.edition_id = edition.id AND plan.library_id = ?
                              AND plan.state = 'current' AND plan.target_track_count > 0 AND plan.coverage * 2 > plan.target_track_count) AS providerOffers
                FROM AlbumEditions edition
                JOIN Albums album ON album.id = edition.release_group_id
                WHERE edition.artist_mbid = ? AND edition.mbid IS NOT NULL
                ORDER BY edition.id
            `).all(query.libraryId, query.libraryId, artistMbid) as Array<{ id: number; mbid: string; title: string; artistMbid: string; releaseGroupTitle: string; preferred: number; status: string | null; providerOffers: number;
                artistName: string | null; albumDate: string | null; releaseDate: string | null; mediaCount: number | null; media: string | null; country: string | null; label: string | null; disambiguation: string | null; oldIds: string | null }>;
            const filtering = getConfigSection("filtering");
            for (const edition of editions) {
                if (!isAutoImportStatusAllowed(edition.status, isReleaseStatusIncluded(edition.status, filtering), Boolean(edition.providerOffers))) continue;
                if (Math.min(titleDistance(query.album, edition.title), titleDistance(query.album, edition.releaseGroupTitle)) > 0.4) continue;
                const release = this.getCanonicalImportRelease(edition.mbid);
                if (!release || release.tracks.length === 0) continue;
                out.push({
                    id: release.id, mbid: release.mbid, title: edition.title, releaseGroupTitle: edition.releaseGroupTitle,
                    artistMbid: edition.artistMbid, preferred: Boolean(edition.preferred),
                    artistName: edition.artistName ?? "", oldMbids: jsonStrings(edition.oldIds).map((id) => id.toLowerCase()),
                    albumYear: yearOf(edition.albumDate), releaseYear: yearOf(edition.releaseDate),
                    mediaCount: edition.mediaCount ?? undefined,
                    mediaFormats: mediaFormats(edition.media),
                    countries: jsonStrings(edition.country).map((c) => c.toUpperCase()),
                    labels: jsonStrings(edition.label, ["name", "Name", "label"]),
                    disambiguation: edition.disambiguation,
                    tracks: release.tracks.map((track) => ({ id: track.id, mbid: track.mbid, recordingMbid: track.recordingMbid,
                        mediumPosition: track.mediumPosition, position: track.position, title: track.title, durationMs: track.durationMs })),
                });
                if (out.length >= 60) return out;
            }
        }
        return out;
    }

    /**
     * ADR-13 step 2b: ask the active catalog source (local MusicBrainz mirror or
     * the public service) for the artist's release groups and add those whose
     * title is close to the album tag but are not in the catalog yet. Returns
     * the number added. Catalog metadata only; no library files change.
     */
    async addMissingReleaseGroupsFromCatalogSource(artistMbid: string, album: string): Promise<number> {
        try {
            const { catalogProviderRegistry } = await import("../catalog/index.js");
            const groups = await catalogProviderRegistry.getActive().getArtistReleaseGroups(artistMbid);
            const known = new Set((db.prepare("SELECT lower(mbid) AS mbid FROM Albums WHERE mbid IS NOT NULL").all() as Array<{ mbid: string }>).map((row) => row.mbid));
            const missing = groups
                .filter((group) => group.mbid && !known.has(group.mbid.toLowerCase()) && titleDistance(album, group.title) <= ONLINE_LOOKUP_TITLE_DISTANCE)
                .sort((a, b) => titleDistance(album, a.title) - titleDistance(album, b.title))
                .slice(0, ONLINE_LOOKUP_MAX_GROUPS);
            if (missing.length === 0) return 0;
            const { servarrMetadata } = await import("../metadata/servarr-metadata.js");
            let added = 0;
            for (const group of missing) {
                try {
                    await servarrMetadata.syncReleaseGroup(group.mbid, artistMbid);
                    added++;
                } catch (error) {
                    console.warn(`[AutoImport] Could not add release group ${group.mbid} to the catalog:`, error);
                }
            }
            return added;
        } catch (error) {
            console.warn("[AutoImport] Online MusicBrainz lookup failed:", error);
            return 0;
        }
    }

    /** ADR-13 step 3: AcoustID recording MBIDs per file (fingerprint.ts via the identification service). */
    async fingerprintFiles(files: UnmappedFile[]): Promise<FingerprintEvidence> {
        const evidence: FingerprintEvidence = new Map();
        for (const file of files) {
            if (file.library_root === "videos" || !fs.existsSync(file.file_path)) continue;
            try {
                const result = await this.identifyByAcoustId(file.file_path, {});
                if (result.recordingIds.length > 0) evidence.set(file.id, result.recordingIds);
            } catch (error) {
                console.warn(`[AutoImport] Fingerprint failed for ${file.file_path}:`, error);
            }
        }
        return evidence;
    }

    /**
     * Planning half of autoImportFolderGroup. Never touches library files.
     * With `writeCatalog` false (a dry run) a missing release is reported and not inserted.
     */
    async planAutoImportForFolder(
        anchorFile: UnmappedFile,
        options: { writeCatalog?: boolean } = {},
    ): Promise<{ files: UnmappedFile[]; plan: FolderAutoImportPlan }> {
        const folder = path.dirname(anchorFile.file_path);
        const siblings = (db.prepare(`
            SELECT * FROM UnmappedFiles WHERE library_root = ? AND file_path LIKE ? ESCAPE '\\'
        `).all(anchorFile.library_root, `${folder.replace(/[\\%_]/g, (char) => `\\${char}`)}%`) as any[])
            .map((row) => this.repository.findById(row.id))
            .filter((file): file is UnmappedFile => Boolean(file) && path.dirname(file!.file_path) === folder);
        const files = siblings.length > 0 ? siblings : [anchorFile];

        const libraries = this.listManualImportLibraries().map((library) => ({ id: library.id, rootPath: library.rootPath }));
        const autoFiles: AutoImportFile[] = [];
        for (const file of files) {
            const identity = await this.readTags(file.file_path);
            const storedDuration = file.duration != null && file.duration > 0 ? file.duration : null;
            autoFiles.push({
                id: file.id,
                // UnmappedFiles.library_root holds the root kind ("music"), not a path; resolve the owning library by path.
                libraryRoot: libraryRootPathFor(file.file_path, libraries) ?? file.library_root,
                ignored: file.ignored,
                // An unknown container length is missing evidence. Fall back to a stored length, never to zero.
                durationSeconds: identity.durationSeconds ?? storedDuration,
                tags: identity.tags,
            });
        }

        // ADR-13 identification order: own catalog by tags (step 1-2), then an
        // online MusicBrainz lookup that adds a missing release group to the
        // catalog, then AcoustID fingerprints when Lidarr's ShouldFingerprint says so.
        let lastQuery: CandidateQuery | null = null;
        const folderArtistMbid = /\{mbid-([0-9a-f-]{36})\}/i.exec(folder)?.[1] ?? null;
        const decide = (fingerprints?: FingerprintEvidence) => planFolderAutoImport({
            files: autoFiles,
            libraries,
            findRelease: (releaseMbid) => this.getCanonicalImportRelease(releaseMbid),
            findCandidates: (query) => { lastQuery = query; return this.findCatalogCandidates(query); },
            folderArtistMbid,
            fingerprints,
        });
        let plan = decide();
        const query = lastQuery as CandidateQuery | null;
        if (plan.decision === "review" && plan.needsEvidence === "online" && options.writeCatalog !== false && query?.album) {
            const artistMbid = query.artistMbid ?? artistMbidForName(query.artistName);
            if (artistMbid) {
                const added = await this.addMissingReleaseGroupsFromCatalogSource(artistMbid, query.album);
                if (added > 0) plan = decide();
            }
        }
        // Lidarr ShouldFingerprint (distance > 0.15, extra or missing tracks, worst track > 0.40) decides inside the planner.
        const needsFingerprint = plan.decision === "review" && plan.needsEvidence === "fingerprint";
        if (needsFingerprint) {
            const fingerprints = await this.fingerprintFiles(files);
            plan = decide(fingerprints);
        }
        return { files, plan };
    }

    private describeAutoImport(
        folder: string,
        planned: { files: UnmappedFile[]; plan: FolderAutoImportPlan },
        options: { dryRun: boolean; queued?: number },
    ): AutoImportFolderReport {
        const { files, plan } = planned;
        const actions: AutoImportAction[] = [];
        if (plan.decision === "review") {
            actions.push({ type: "review", reason: plan.reason });
            if (plan.needsEvidence === "online") {
                const album = plan.reason.match(/album "([^"]+)"/)?.[1] ?? "";
                if (album) actions.push({ type: "add-missing-release", album });
            }
        } else {
            const monitored = db.prepare(`
                SELECT 1 AS present FROM LibraryEditions
                WHERE library_id = ? AND edition_id = ?
            `).get(plan.libraryId, plan.editionId);
            if (!monitored) {
                actions.push({
                    type: "monitor",
                    libraryId: plan.libraryId,
                    editionId: plan.editionId,
                    selectionMode: "auto",
                    locked: false,
                });
            }
            for (const mapping of plan.mappings) {
                actions.push({
                    type: "import",
                    unmappedFileId: mapping.unmappedFileId,
                    trackId: mapping.trackId,
                    effects: ["rename", "retag", "cover", "register"],
                });
            }
        }
        return {
            folder,
            fileIds: files.map((file) => file.id),
            decision: plan.decision,
            ...(plan.decision === "review"
                ? { reason: plan.reason, ...(plan.needsEvidence ? { needsEvidence: plan.needsEvidence } : {}) }
                : { editionId: plan.editionId, libraryId: plan.libraryId, mappings: plan.mappings }),
            ...(options.queued !== undefined ? { queued: options.queued } : {}),
            filesUntouched: options.dryRun,
            actions,
        };
    }
}

/** Root path of the enabled library that contains filePath (longest match), or null. */
export function libraryRootPathFor(filePath: string, libraries: Array<{ rootPath: string }>): string | null {
    const normalized = filePath.replace(/\\/g, "/");
    let best: string | null = null;
    for (const { rootPath } of libraries) {
        const root = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
        if ((normalized === root || normalized.startsWith(`${root}/`)) && (!best || root.length > best.length)) best = root;
    }
    return best;
}

function artistMbidForName(name: string | null): string | null {
    if (!name) return null;
    const row = db.prepare(`
        SELECT mbid FROM ArtistMetadata WHERE lower(name) = lower(?)
    `).get(name) as { mbid: string } | undefined;
    return row?.mbid ?? null;
}

/** Identity tags in the key names planFolderAutoImport reads. Empty when the file cannot be parsed. */
async function readIdentityTags(filePath: string): Promise<PlanningIdentity> {
    try {
        const parsed = await mm.parseFile(filePath, { skipCovers: true, duration: true });
        const { common } = parsed;
        const tags: Record<string, string> = {};
        const put = (key: string, value: unknown) => {
            if (value !== undefined && value !== null && String(value).trim()) tags[key] = String(value);
        };
        put("MUSICBRAINZ_ALBUMID", common.musicbrainz_albumid);
        // music-metadata names the release-track id musicbrainz_trackid.
        put("MUSICBRAINZ_RELEASETRACKID", common.musicbrainz_trackid);
        put("MUSICBRAINZ_TRACKID", common.musicbrainz_recordingid);
        put("TRACK", common.track?.no);
        put("DISC", common.disk?.no);
        put("DISCTOTAL", common.disk?.of);
        put("TITLE", common.title);
        put("ALBUM", common.album);
        put("ALBUMARTIST", common.albumartist);
        put("ARTIST", common.artist);
        put("MUSICBRAINZ_ALBUMARTISTID", common.musicbrainz_albumartistid?.[0]);
        put("DATE", common.year);
        const probed = parsed.format.duration;
        const durationSeconds = typeof probed === "number" && Number.isFinite(probed) && probed > 0 ? probed : null;
        return { tags, durationSeconds };
    } catch {
        return { tags: {}, durationSeconds: null };
    }
}

export function hasArtistCatalogChangedSince(params: {
    artistId?: string | number | null;
    artistName?: string | null;
    since?: string | null;
}): boolean {
    const since = String(params.since || "").trim();
    if (!since) return true;

    let artistRow: { id: number } | undefined;
    const rawId = params.artistId != null ? String(params.artistId).trim() : "";
    if (rawId) {
        artistRow = db.prepare(`
            SELECT id FROM ArtistMetadata WHERE id = ? OR mbid = ? LIMIT 1
        `).get(rawId, rawId) as { id: number } | undefined;
    }
    if (!artistRow && params.artistName) {
        artistRow = db.prepare(`
            SELECT id FROM ArtistMetadata WHERE lower(name) = lower(?) LIMIT 1
        `).get(params.artistName.trim()) as { id: number } | undefined;
    }
    if (!artistRow) {
        return true;
    }

    const changed = db.prepare(`
        SELECT 1 FROM ArtistMetadata am
        WHERE am.id = ?
          AND (
            datetime(am.updated_at) > datetime(?)
            OR EXISTS (
              SELECT 1 FROM Albums a
              WHERE a.artist_metadata_id = am.id
                AND datetime(a.updated_at) > datetime(?)
            )
            OR EXISTS (
              SELECT 1 FROM AlbumEditions ae
              WHERE ae.artist_metadata_id = am.id
                AND datetime(ae.updated_at) > datetime(?)
            )
          )
        LIMIT 1
    `).get(artistRow.id, since, since, since);
    return Boolean(changed);
}

export function isUnmappedFileCheckCurrent(params: {
    fileSize: number | null | undefined;
    fileMtimeMs: number | null | undefined;
    updatedAt: string | null | undefined;
    statsSize: number;
    statsMtimeMs: number;
    artistId?: string | number | null;
    artistName?: string | null;
}): boolean {
    if (params.fileSize == null || params.fileMtimeMs == null || !params.updatedAt) {
        return false;
    }
    if (params.fileSize !== params.statsSize || Math.abs(params.fileMtimeMs - params.statsMtimeMs) >= 1) {
        return false;
    }
    return !hasArtistCatalogChangedSince({
        artistId: params.artistId,
        artistName: params.artistName,
        since: params.updatedAt,
    });
}

