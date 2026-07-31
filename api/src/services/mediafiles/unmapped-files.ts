import fs from "fs";
import path from "path";
import * as mm from "music-metadata";
import { db } from "../../database.js";
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

export class UnmappedFilesService {
    constructor(
        private readonly repository: UnmappedFileRepository = unmappedFileRepository,
        private readonly importService: ImportService = new ImportService(),
        private readonly identifyByAcoustId = identifyAudioFileByAcoustId,
        private readonly readEmbeddedRecordingMbid = readEmbeddedMusicBrainzRecordingMbid,
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

    deleteFile(id: number): void {
        const file = this.repository.findById(id);
        if (!file) {
            throw new Error("File not found in tracking DB");
        }

        if (fs.existsSync(file.file_path)) {
            fs.unlinkSync(file.file_path);
        }
        this.repository.delete(id);
    }

    deleteFiles(ids: number[]): number {
        const files = this.repository.findByIds(ids);
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
            JOIN Artists a ON a.mbid = al.artist_mbid
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

        // Catalog-only discovery (Lidarr: CandidateService → IdentificationService).
        // We match local files against the local catalog release groups by their
        // detected artist/album tags and score each with the same Munkres pipeline
        // used everywhere else. The streaming provider is never consulted to
        // identify files — only to download them.
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

    async autoImportFolderGroup(anchorFile: UnmappedFile): Promise<number> {
        void anchorFile;
        // Candidate discovery can assist review, but acquisition authority
        // requires an explicit Library + Edition/Recording selection.
        return 0;
    }
}
