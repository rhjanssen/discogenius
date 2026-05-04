import fs from "fs";
import path from "path";
import { db } from "../database.js";
import { UnmappedFileRepository, type UnmappedFile } from "../repositories/UnmappedFileRepository.js";
import { IdentificationService, type AlbumCandidateMatch } from "./identification-service.js";
import { ImportDecisionEngine } from "./import-decision/engine.js";
import type { ImportDecisionMode } from "./import-decision/types.js";
import type { LocalFile, LocalGroup, TidalMatch } from "./import-types.js";
import { ImportService } from "./import-service.js";
import { getAlbum, searchTidal } from "./providers/tidal/tidal.js";

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

function isAudioCandidate(filePath: string): boolean {
    return [
        ".flac",
        ".alac",
        ".wav",
        ".aiff",
        ".aif",
        ".mp3",
        ".m4a",
        ".aac",
        ".ogg",
        ".opus",
        ".wma",
    ].includes(path.extname(filePath).toLowerCase());
}

export class UnmappedFilesService {
    constructor(
        private readonly repository: UnmappedFileRepository = unmappedFileRepository,
        private readonly importService: ImportService = new ImportService()
    ) { }

    listFiles(limit?: number, offset?: number): { items: UnmappedFile[]; total: number } {
        return {
            items: this.repository.findAll(limit, offset),
            total: this.repository.count(),
        };
    }

    getFile(id: number): UnmappedFile | undefined {
        return this.repository.findById(id);
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

    async bulkMap(items: Array<{ id: number; tidalId: string }>): Promise<void> {
        await this.importService.bulkImportUnmapped(items);
    }

    async identifyAgainstAlbum(
        fileIds: number[],
        tidalAlbumId: string,
        mode: ImportDecisionMode = "ExistingFiles"
    ) {
        const files = this.repository.findByIds(fileIds);
        const identification = await IdentificationService.identifyUnmappedFiles(files, tidalAlbumId);
        const album = await getAlbum(tidalAlbumId);
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
            autoImportReady: evaluatedMatch?.autoImportReady ?? false,
            rejections: evaluatedMatch?.rejections ?? [],
            conflictPath: evaluatedMatch?.conflictPath ?? null,
        };
    }

    async findBestAlbumCandidate(
        files: UnmappedFile[],
        mode: ImportDecisionMode = "ExistingFiles"
    ): Promise<TidalMatch | null> {
        if (files.length === 0) return null;
        if (files.some((file) => file.library_root === "music_videos")) {
            return this.findBestVideoCandidate(files, mode);
        }
        const group = this.buildLocalGroup(files);
        const context = files[0]?.library_root === "spatial_music" ? "atmos" : "music";
        const matches = await this.importService.findMatchesForGroup(group, context, mode);
        return matches[0] ?? null;
    }

    private async findBestVideoCandidate(
        files: UnmappedFile[],
        mode: ImportDecisionMode = "ExistingFiles",
    ): Promise<TidalMatch | null> {
        const group = this.buildLocalGroup(files);
        const matches = await this.importService.findMatchesForGroup(group, "video", mode);
        const top = matches[0];
        if (!top || top.score < 0.55) return null;
        return top;
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
            status: "pending",
        };
    }

    private buildTrackIdsByFilePath(files: UnmappedFile[], mappedTracks: Record<number, string>): Record<string, string> {
        const filesById = new Map(files.map((file) => [file.id, file]));
        const trackIdsByFilePath: Record<string, string> = {};

        for (const [fileId, tidalId] of Object.entries(mappedTracks)) {
            const file = filesById.get(Number(fileId));
            if (!file) {
                continue;
            }

            trackIdsByFilePath[file.file_path] = tidalId;
        }

        return trackIdsByFilePath;
    }

    private evaluateAlbumCandidate(
        files: UnmappedFile[],
        candidate: AlbumCandidateMatch,
        options: {
            matchType: TidalMatch["matchType"];
            directCandidateCount?: number;
            strongFingerprintCandidateCount?: number;
            mode?: ImportDecisionMode;
        },
    ): TidalMatch {
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

    private async findFingerprintAlbumCandidate(
        files: UnmappedFile[],
        preferredArtist: string | null,
        mode: ImportDecisionMode = "ExistingFiles",
    ): Promise<TidalMatch | null> {
        const { generateFingerprint, lookupAcoustId, lookupMusicBrainzRecording } = await import("./fingerprint.js");
        const candidateAlbums = new Map<string, any>();
        const seenQueries = new Set<string>();
        const seenRecordingIds = new Set<string>();

        for (const file of files.slice(0, 3)) {
            if (!isAudioCandidate(file.file_path)) {
                continue;
            }

            let fingerprintResult: { duration: number; fingerprint: string } | null = null;
            try {
                fingerprintResult = await generateFingerprint(file.file_path);
            } catch {
                continue;
            }

            const recordingIds = await lookupAcoustId(fingerprintResult.fingerprint, fingerprintResult.duration);
            for (const recordingId of recordingIds.slice(0, 4)) {
                if (seenRecordingIds.has(recordingId)) {
                    continue;
                }
                seenRecordingIds.add(recordingId);

                const recording = await lookupMusicBrainzRecording(recordingId);
                if (!recording?.title) {
                    continue;
                }

                const primaryArtist = recording.artists[0] || preferredArtist || "";
                const query = [primaryArtist, recording.title].filter(Boolean).join(" ").trim();
                if (!query || seenQueries.has(query)) {
                    continue;
                }
                seenQueries.add(query);

                let trackResults: any[] = [];
                try {
                    const searchResults = await searchTidal(query, "tracks", 10);
                    trackResults = Array.isArray(searchResults) ? searchResults : [];
                } catch {
                    continue;
                }

                for (const track of trackResults) {
                    const albumId = track?.album_id?.toString?.();
                    if (!albumId || candidateAlbums.has(albumId)) {
                        continue;
                    }

                    try {
                        const album = await getAlbum(albumId);
                        if (album) {
                            candidateAlbums.set(albumId, album);
                        }
                    } catch {
                        // Ignore individual album hydration failures.
                    }
                }
            }
        }

        if (candidateAlbums.size === 0) {
            return null;
        }

        const bestMatch = await IdentificationService.findBestAlbumMatch(
            files,
            Array.from(candidateAlbums.values()),
            "ExistingFiles"
        );
        if (!bestMatch) {
            return null;
        }

        return this.evaluateAlbumCandidate(files, bestMatch, {
            matchType: "fingerprint",
            strongFingerprintCandidateCount: 1,
            mode,
        });
    }

    async autoImportFolderGroup(anchorFile: UnmappedFile): Promise<number> {
        const relativeDirectory = getRelativeDirectory(anchorFile);
        const folderFiles = this.repository.findByDirectory(relativeDirectory, anchorFile.library_root)
            .filter((file) => !file.ignored);

        if (folderFiles.length === 0) return 0;

        const bestMatch = await this.findBestAlbumCandidate(folderFiles);
        if (!bestMatch) return 0;
        if (!bestMatch.autoImportReady) {
            return 0;
        }

        const items = Object.entries(bestMatch.trackIdsByFilePath || {}).map(([filePath, tidalId]) => ({
            id: folderFiles.find((file) => file.file_path === filePath)?.id || 0,
            tidalId,
        })).filter((item) => item.id > 0);

        if (items.length === 0) {
            return 0;
        }

        await this.bulkMap(items);
        return items.length;
    }
}
