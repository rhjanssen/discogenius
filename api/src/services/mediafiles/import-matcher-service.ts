import path from "node:path";
import type { ImportDecisionMode } from "../import-decision/types.js";
import { CatalogCandidateService } from "./candidate-service.js";
import {
    IdentificationService,
    type IdentifiableFile,
} from "./identification-service.js";
import {
    normalizeComparableText,
    stringSimilarity,
} from "./import-matching-utils.js";
import type {
    ImportCandidate,
    LocalFile,
    LocalGroup,
    ProviderMatch,
    RootFolderImportProgressEvent,
} from "./import-types.js";

const EXPLICIT_CANONICAL_SELECTION =
    "Choose the destination Library and canonical MusicBrainz Edition or video Recording before import.";

function fileTitle(file: LocalFile): string {
    const tagged = String(file.metadata?.common?.title || "").trim();
    return tagged || path.basename(file.name, file.extension);
}

function artistName(group: LocalGroup): string {
    return String(
        group.commonTags.artist
        || group.files.find((file) => file.metadata?.common?.artist)?.metadata?.common?.artist
        || "",
    ).trim();
}

function albumTitle(group: LocalGroup): string {
    return String(
        group.commonTags.album
        || group.files.find((file) => file.metadata?.common?.album)?.metadata?.common?.album
        || path.basename(group.path),
    ).trim();
}

function identifiableFiles(group: LocalGroup): {
    files: IdentifiableFile[];
    pathById: Map<number, string>;
} {
    const pathById = new Map<number, string>();
    const files = group.files.map((file, index) => {
        const id = index + 1;
        pathById.set(id, file.path);
        return {
            id,
            filename: file.name,
            duration: file.metadata?.format?.duration ?? null,
            detected_artist: file.metadata?.common?.artist || group.commonTags.artist || null,
            detected_album: file.metadata?.common?.album || group.commonTags.album || null,
            detected_track: file.metadata?.common?.title || null,
            file_path: file.path,
            relative_path: path.relative(group.rootPath, file.path),
        };
    });
    return { files, pathById };
}

/**
 * Root-folder discovery is catalogue-only. It may suggest canonical MusicBrainz
 * identities for review, but never turns a provider resource into identity and
 * never auto-imports without an explicit Library + Edition/Recording selection.
 */
export class ImportMatcherService {
    async findMatches(
        groups: LocalGroup[],
        context: "music" | "spatial" | "video" = "music",
        options?: { onProgress?: (event: RootFolderImportProgressEvent) => void },
        mode: ImportDecisionMode = "NewDownload",
    ): Promise<ImportCandidate[]> {
        void mode;
        const totalFiles = groups.reduce((sum, group) => sum + group.files.length, 0);
        let processedFiles = 0;
        const results: ImportCandidate[] = [];

        if (totalFiles === 0) {
            options?.onProgress?.({
                message: "No files found for import evaluation",
                currentFileNum: 0,
                totalFiles: 0,
                currentGroupNum: 0,
                totalGroups: groups.length,
            });
        }

        for (let index = 0; index < groups.length; index += 1) {
            const group = groups[index];
            results.push({
                group,
                matches: await this.matchGroup(group, context),
            });
            processedFiles += group.files.length;
            options?.onProgress?.({
                message: `Reading file ${processedFiles}/${totalFiles}`,
                currentFileNum: processedFiles,
                totalFiles,
                currentGroupNum: index + 1,
                totalGroups: groups.length,
            });
        }
        return results;
    }

    async findMatchesForGroup(
        group: LocalGroup,
        context: "music" | "spatial" | "video" = "music",
        mode: ImportDecisionMode = "NewDownload",
    ): Promise<ProviderMatch[]> {
        void mode;
        return this.matchGroup(group, context);
    }

    private async matchGroup(
        group: LocalGroup,
        context: "music" | "spatial" | "video",
    ): Promise<ProviderMatch[]> {
        return context === "video" || group.libraryRoot === "videos"
            ? this.matchVideo(group)
            : this.matchAlbum(group);
    }

    private async matchAlbum(group: LocalGroup): Promise<ProviderMatch[]> {
        const candidates = CatalogCandidateService.getReleaseGroupCandidates({
            artist: artistName(group),
            album: albumTitle(group),
            limit: 8,
        });
        const { files, pathById } = identifiableFiles(group);
        const scored = await IdentificationService.scoreAlbumCandidates(files, candidates);

        return scored.map((match) => ({
            item: match.album,
            itemType: "album",
            score: match.combinedScore,
            closeMatchScore: match.closeMatchScore,
            matchType: match.combinedScore >= 0.9 ? "exact" : "fuzzy",
            confidence: match.confidence,
            closeMatchConfidence: match.closeMatchConfidence,
            coverage: match.coverage,
            matchedCount: match.matchedCount,
            totalFiles: match.totalFiles,
            autoImportReady: false,
            trackIdsByFilePath: Object.fromEntries(
                Object.entries(match.mappedTracks)
                    .map(([fileId, trackMbid]) => [pathById.get(Number(fileId)), trackMbid])
                    .filter((entry): entry is [string, string] => Boolean(entry[0])),
            ),
            rejections: [EXPLICIT_CANONICAL_SELECTION],
            typedRejections: [{ reason: EXPLICIT_CANONICAL_SELECTION, type: "permanent" }],
        }));
    }

    private matchVideo(group: LocalGroup): ProviderMatch[] {
        const file = group.files[0];
        if (!file) return [];
        const localArtist = artistName(group);
        const localTitle = fileTitle(file);
        const localDuration = Number(file.metadata?.format?.duration || 0);
        const candidates = CatalogCandidateService.getVideoRecordingCandidates({
            artist: localArtist,
            title: localTitle,
            limit: 12,
        });

        return candidates
            .map((candidate) => {
                const titleScore = stringSimilarity(
                    normalizeComparableText(localTitle),
                    normalizeComparableText(candidate.title),
                );
                const candidateArtist = candidate.artist_name || candidate.artist.name;
                const artistScore = localArtist
                    ? stringSimilarity(
                        normalizeComparableText(localArtist),
                        normalizeComparableText(candidateArtist),
                    )
                    : 0.5;
                const durationScore = localDuration > 0 && candidate.duration
                    ? Math.max(0, 1 - Math.abs(localDuration - candidate.duration) / 30)
                    : 0.5;
                const score = titleScore * 0.6 + artistScore * 0.3 + durationScore * 0.1;
                return {
                    item: candidate,
                    itemType: "video" as const,
                    score,
                    matchType: score >= 0.9 ? "exact" as const : "fuzzy" as const,
                    confidence: score,
                    coverage: 1,
                    matchedCount: 1,
                    totalFiles: 1,
                    autoImportReady: false,
                    rejections: [EXPLICIT_CANONICAL_SELECTION],
                    typedRejections: [{ reason: EXPLICIT_CANONICAL_SELECTION, type: "permanent" as const }],
                };
            })
            .filter((match) => match.score >= 0.55)
            .sort((left, right) => right.score - left.score);
    }
}

export const importMatcherService = new ImportMatcherService();
