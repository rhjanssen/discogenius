import levenshtein from "fast-levenshtein";
import munkres from "munkres-js";
import { getAlbumTracks } from "./providers/tidal/tidal.js";
import type { ImportDecisionMode } from "./import-decision/types.js";

export interface IdentifiableFile {
    id: number;
    filename: string;
    duration?: number | null;
    detected_artist?: string | null;
    detected_album?: string | null;
    detected_track?: string | null;
    file_path?: string | null;
    relative_path?: string | null;
}

export interface IdentificationResult {
    fileId: number;
    tidalId: string;
}

export interface AlbumIdentificationResult {
    mappedTracks: Record<number, string>;
    matchedCount: number;
    totalFiles: number;
    averageCost: number;
    coverage: number;
    confidence: number;
    closeMatchConfidence: number;
}

export interface AlbumCandidateMatch extends AlbumIdentificationResult {
    album: any;
    albumScore: number;
    combinedScore: number;
    closeMatchScore: number;
}

type TrackDistanceResult = {
    normalizedDistance: number;
    titleSimilarity: number;
    reasons: string[];
};

const DISTANCE_WEIGHTS = {
    track_title: 3,
    track_index: 1,
    track_length: 2,
} as const;

export class IdentificationService {
    private static readonly MAX_ACCEPTABLE_DISTANCE = 0.4;

    private static normalizeText(value?: string | null): string {
        return (value || "")
            .toLowerCase()
            .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
            .replace(/\b(feat|ft|featuring|explicit|clean|remaster(?:ed)?|deluxe|version)\b/g, " ")
            .replace(/[_./\\-]+/g, " ")
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    private static getLocalTitle(file: IdentifiableFile): string {
        const fromTags = file.detected_track?.trim();
        if (fromTags) {
            return this.normalizeText(fromTags);
        }

        const baseName = file.filename.replace(/\.[^/.]+$/, "");
        const cleaned = baseName.replace(/^\d{1,3}[.\-_\s]+/, "");
        return this.normalizeText(cleaned);
    }

    private static extractTrackNumber(file: IdentifiableFile): number | null {
        const candidates = [file.detected_track, file.filename].filter(Boolean) as string[];
        const patterns = [
            /^\s*(\d{1,3})[.\-_\s]/,
            /(?:^|\s|[._-])(\d{1,3})(?=\s|[._-]|$)/,
            /(?:track|disc|cd)\s*(\d{1,3})/i,
        ];

        for (const candidate of candidates) {
            for (const pattern of patterns) {
                const match = candidate.match(pattern);
                if (!match?.[1]) {
                    continue;
                }

                const parsed = Number.parseInt(match[1], 10);
                if (!Number.isNaN(parsed) && parsed > 0) {
                    return parsed;
                }
            }
        }

        return null;
    }

    private static similarity(left?: string | null, right?: string | null): number {
        const normalizedLeft = this.normalizeText(left);
        const normalizedRight = this.normalizeText(right);
        if (!normalizedLeft || !normalizedRight) return 0;
        const distance = levenshtein.get(normalizedLeft, normalizedRight);
        const maxLength = Math.max(normalizedLeft.length, normalizedRight.length, 1);
        return Math.max(0, 1 - distance / maxLength);
    }

    private static getAlbumScore(files: IdentifiableFile[], album: any): number {
        const artistCandidates = files.map((file) => file.detected_artist).filter(Boolean) as string[];
        const albumCandidates = files.map((file) => file.detected_album).filter(Boolean) as string[];
        const primaryArtist = artistCandidates[0] || null;
        const primaryAlbum = albumCandidates[0] || null;

        const artistScore = this.similarity(primaryArtist, album.artist?.name || album.artist_name || album.artists?.[0]?.name);
        const albumScore = this.similarity(primaryAlbum, album.title || album.name);

        const remoteTrackCount = Number(album.numberOfTracks || album.num_tracks || 0);
        const trackCountScore = remoteTrackCount > 0
            ? Math.max(0, 1 - Math.abs(files.length - remoteTrackCount) / Math.max(remoteTrackCount, files.length, 1))
            : 0.5;

        return artistScore * 0.35 + albumScore * 0.45 + trackCountScore * 0.2;
    }

    private static addPenalty(weightedPenalty: { value: number; weight: number; reason: string }, penalties: Array<{ value: number; weight: number; reason: string }>) {
        penalties.push(weightedPenalty);
    }

    private static isTrackNumberMatch(localTrackNumber: number, trackNumber: number, totalTrackNumber: number): boolean {
        if (localTrackNumber === trackNumber || localTrackNumber === totalTrackNumber) {
            return true;
        }

        if (localTrackNumber > 100 && localTrackNumber % 100 === trackNumber) {
            return true;
        }

        return false;
    }

    private static calculateTrackDistance(file: IdentifiableFile, track: any, totalTrackNumber: number): TrackDistanceResult {
        const penalties: Array<{ value: number; weight: number; reason: string }> = [];
        const localTitle = this.getLocalTitle(file);
        const titleSimilarity = this.similarity(localTitle, track.title);

        this.addPenalty({
            value: 1 - titleSimilarity,
            weight: DISTANCE_WEIGHTS.track_title,
            reason: "track title",
        }, penalties);

        const localDuration = Number(file.duration || 0);
        const remoteDuration = Number(track.duration || 0);
        if (localDuration > 0 && remoteDuration > 0) {
            const durationDifference = Math.max(0, Math.abs(localDuration - remoteDuration) - 10);
            this.addPenalty({
                value: Math.min(durationDifference, 30) / 30,
                weight: DISTANCE_WEIGHTS.track_length,
                reason: "track length",
            }, penalties);
        }

        const localTrackNumber = this.extractTrackNumber(file);
        const remoteTrackNumber = Number(track.track_number || 0);
        if (localTrackNumber !== null && remoteTrackNumber > 0) {
            this.addPenalty({
                value: this.isTrackNumberMatch(localTrackNumber, remoteTrackNumber, totalTrackNumber) ? 0 : 1,
                weight: DISTANCE_WEIGHTS.track_index,
                reason: "track index",
            }, penalties);
        }

        const totalWeight = penalties.reduce((sum, penalty) => sum + penalty.weight, 0);
        const weightedDistance = penalties.reduce((sum, penalty) => sum + penalty.value * penalty.weight, 0);
        const normalizedDistance = totalWeight > 0 ? weightedDistance / totalWeight : 1;

        return {
            normalizedDistance,
            titleSimilarity,
            reasons: penalties.filter((penalty) => penalty.value > 0).map((penalty) => penalty.reason),
        };
    }

    private static buildDistanceMatrix(files: IdentifiableFile[], tracks: any[]) {
        const orderedFiles = [...files].sort((left, right) => {
            const leftTrack = this.extractTrackNumber(left) ?? Number.MAX_SAFE_INTEGER;
            const rightTrack = this.extractTrackNumber(right) ?? Number.MAX_SAFE_INTEGER;
            if (leftTrack !== rightTrack) return leftTrack - rightTrack;
            return left.filename.localeCompare(right.filename);
        });

        const distances = orderedFiles.map((file) => tracks.map((track, trackIndex) => {
            const totalTrackNumber = trackIndex + 1;
            return this.calculateTrackDistance(file, track, totalTrackNumber);
        }));

        const matrix = distances.map((row) => row.map((distance) => distance.normalizedDistance));

        return { orderedFiles, distances, matrix };
    }

    private static solveAssignments(files: IdentifiableFile[], tracks: any[]): AlbumIdentificationResult {
        if (files.length === 0 || tracks.length === 0) {
            return {
                mappedTracks: {},
                matchedCount: 0,
                totalFiles: files.length,
                averageCost: 100,
                coverage: 0,
                confidence: 0,
                closeMatchConfidence: 0,
            };
        }

        const { orderedFiles, distances, matrix } = this.buildDistanceMatrix(files, tracks);
        const numRows = matrix.length;
        const numCols = tracks.length;

        let inputMatrix = matrix;
        let transposed = false;
        if (numRows > numCols) {
            transposed = true;
            const nextMatrix: number[][] = [];
            for (let colIndex = 0; colIndex < numCols; colIndex++) {
                const newRow: number[] = [];
                for (let rowIndex = 0; rowIndex < numRows; rowIndex++) {
                    newRow.push(matrix[rowIndex][colIndex]);
                }
                nextMatrix.push(newRow);
            }
            inputMatrix = nextMatrix;
        }

        const indices = munkres(inputMatrix);
        const mappedTracks: Record<number, string> = {};
        const acceptedDistances: number[] = [];

        indices.forEach((pair: number[]) => {
            const rowIndex = transposed ? pair[1] : pair[0];
            const colIndex = transposed ? pair[0] : pair[1];

            if (rowIndex >= numRows || colIndex >= numCols) {
                return;
            }

            const file = orderedFiles[rowIndex];
            const track = tracks[colIndex];
            const distance = distances[rowIndex][colIndex];

            if (distance.normalizedDistance <= this.MAX_ACCEPTABLE_DISTANCE) {
                mappedTracks[file.id] = track.tidal_id ? track.tidal_id.toString() : track.id.toString();
                acceptedDistances.push(distance.normalizedDistance);
            }
        });

        const matchedCount = acceptedDistances.length;
        const averageDistance = matchedCount > 0
            ? acceptedDistances.reduce((sum, distance) => sum + distance, 0) / matchedCount
            : 1;
        const worstDistance = matchedCount > 0 ? Math.max(...acceptedDistances) : 1;
        const coverage = files.length > 0 ? matchedCount / files.length : 0;
        const distanceQuality = matchedCount > 0
            ? Math.max(0, Math.min(1, 1 - Math.max(averageDistance, worstDistance)))
            : 0;
        const closeMatchConfidence = distanceQuality;
        const confidence = matchedCount > 0
            ? Math.max(0, Math.min(1, coverage * distanceQuality))
            : 0;

        return {
            mappedTracks,
            matchedCount,
            totalFiles: files.length,
            averageCost: averageDistance * 100,
            coverage,
            confidence,
            closeMatchConfidence,
        };
    }

    public static async identifyUnmappedFiles(files: IdentifiableFile[], tidalAlbumId: string): Promise<AlbumIdentificationResult> {
        const tracks = await getAlbumTracks(tidalAlbumId) as any[];
        return this.solveAssignments(files, tracks);
    }

    public static async scoreAlbumCandidates(files: IdentifiableFile[], albumCandidates: any[]): Promise<AlbumCandidateMatch[]> {
        const matches: AlbumCandidateMatch[] = [];

        for (const album of albumCandidates) {
            const albumId = album?.id?.toString?.() || album?.tidal_id?.toString?.();
            if (!albumId) continue;

            const identification = await this.identifyUnmappedFiles(files, albumId);
            if (identification.matchedCount === 0) continue;

            const albumScore = this.getAlbumScore(files, album);
            const strictMappingScore = identification.confidence;
            const closeMappingScore = identification.closeMatchConfidence;
            const combinedScore = strictMappingScore * 0.65 + albumScore * 0.35;
            const closeMatchScore = closeMappingScore * 0.65 + albumScore * 0.35;

            matches.push({
                ...identification,
                album,
                albumScore,
                combinedScore,
                closeMatchScore,
            });
        }

        return matches.sort((left, right) => right.combinedScore - left.combinedScore);
    }

    public static async findBestAlbumMatch(
        files: IdentifiableFile[],
        albumCandidates: any[],
        mode: ImportDecisionMode = "NewDownload"
    ): Promise<AlbumCandidateMatch | null> {
        const matches = await this.scoreAlbumCandidates(files, albumCandidates);
        const sortedMatches = [...matches].sort((left, right) => {
            if (mode === "ExistingFiles") {
                return right.closeMatchScore - left.closeMatchScore;
            }

            return right.combinedScore - left.combinedScore;
        });
        const bestMatch = sortedMatches[0] ?? null;

        if (!bestMatch) return null;
        if (mode === "ExistingFiles") {
            if (bestMatch.closeMatchConfidence < 0.5 || bestMatch.closeMatchScore < 0.52) return null;
            return bestMatch;
        }

        if (bestMatch.coverage < 0.5 || bestMatch.combinedScore < 0.52) return null;
        return bestMatch;
    }

    public static async identifyAndMapFiles(
        files: any[],
        tidalAlbumId: string
    ): Promise<Record<number, string>> {
        const result = await this.identifyUnmappedFiles(files, tidalAlbumId);
        return result.mappedTracks;
    }
}
