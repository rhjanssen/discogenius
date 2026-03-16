import type { LocalGroup, TidalMatch } from "../import-types.js";
import { getExistingImportedMediaConflictPath } from "./conflicts.js";
import type { ImportDecisionContext, ImportDecisionMode, ImportDecisionSpecification } from "./types.js";

const ALBUM_MIN_SCORE = 0.72;
const ALBUM_MIN_CONFIDENCE = 0.62;
const VIDEO_MIN_SCORE = 0.93;
const MIN_SCORE_GAP = 0.08;

function normalizeComparableText(value?: string | null): string {
    return (value || "")
        .toLowerCase()
        .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
        .replace(/[_./\\-]+/g, " ")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getComparableScore(match: TidalMatch, mode: ImportDecisionMode): number {
    if (match.itemType === "album" && mode === "ExistingFiles") {
        return match.closeMatchScore ?? match.score;
    }

    return match.score;
}

function getComparableConfidence(match: TidalMatch, mode: ImportDecisionMode): number {
    if (match.itemType === "album" && mode === "ExistingFiles") {
        return match.closeMatchConfidence ?? match.confidence ?? 0;
    }

    return match.confidence ?? 0;
}

const videoScoreSpecification: ImportDecisionSpecification = {
    evaluate(context) {
        if (context.match.itemType !== "video") {
            return null;
        }

        return context.match.score >= VIDEO_MIN_SCORE ? null : "Match score too low";
    },
};

const unmatchedTracksSpecification: ImportDecisionSpecification = {
    evaluate(context) {
        if (context.match.itemType !== "album") {
            return null;
        }

        if (context.mode !== "NewDownload") {
            return null;
        }

        const totalFiles = context.match.totalFiles ?? context.group.files.length;
        const matchedCount = context.match.matchedCount ?? 0;
        if (totalFiles > 0 && matchedCount < totalFiles) {
            return "Has unmatched tracks";
        }

        return null;
    },
};

const missingTracksSpecification: ImportDecisionSpecification = {
    evaluate(context) {
        if (context.match.itemType !== "album") {
            return null;
        }

        if (context.mode !== "NewDownload") {
            return null;
        }

        const remoteTrackCount = Number(
            context.match.item?.numberOfTracks
            ?? context.match.item?.num_tracks
            ?? context.match.item?.number_of_tracks
            ?? 0
        );
        const matchedCount = context.match.matchedCount ?? 0;
        if (remoteTrackCount > 0 && matchedCount < remoteTrackCount) {
            return "Has missing tracks";
        }

        return null;
    },
};

const confidenceSpecification: ImportDecisionSpecification = {
    evaluate(context) {
        if (context.match.itemType !== "album") {
            return null;
        }

        const confidence = getComparableConfidence(context.match, context.mode);
        return confidence >= ALBUM_MIN_CONFIDENCE ? null : "Track mapping confidence too low";
    },
};

const matchScoreSpecification: ImportDecisionSpecification = {
    evaluate(context) {
        if (context.match.itemType !== "album") {
            return null;
        }

        return getComparableScore(context.match, context.mode) >= ALBUM_MIN_SCORE ? null : "Match score too low";
    },
};

const ambiguousMatchSpecification: ImportDecisionSpecification = {
    evaluate(context) {
        const secondBest = context.sortedMatches[1];
        if (!secondBest) {
            return null;
        }

        const bestScore = getComparableScore(context.match, context.mode);
        const secondScore = getComparableScore(secondBest, context.mode);

        return (bestScore - secondScore) >= MIN_SCORE_GAP
            ? null
            : "Best match is too close to another candidate";
    },
};

const metadataSignalSpecification: ImportDecisionSpecification = {
    evaluate(context) {
        if (context.match.itemType !== "album") {
            return null;
        }

        if (context.hasMetadataSignal || context.hasUsefulFilenameSignal) {
            return null;
        }

        const scoreGap = context.sortedMatches.length > 1
            ? getComparableScore(context.match, context.mode) - getComparableScore(context.sortedMatches[1], context.mode)
            : 1;
        const isSingleFileGroup = (context.match.totalFiles ?? context.group.files.length) === 1;
        const clearFingerprintWinner = context.match.matchType === "fingerprint"
            && context.strongFingerprintCandidateCount >= 1
            && scoreGap >= (isSingleFileGroup ? 0.12 : MIN_SCORE_GAP)
            && getComparableConfidence(context.match, context.mode) >= ALBUM_MIN_CONFIDENCE;

        if (context.match.matchType === "exact" && context.directCandidateCount === 1) {
            return null;
        }

        return clearFingerprintWinner ? null : "Insufficient local metadata for safe auto-import";
    },
};

const existingImportSpecification: ImportDecisionSpecification = {
    evaluate(context) {
        return context.existingConflictPath
            ? `Album already imported at ${context.existingConflictPath}`
            : null;
    },
};

const albumSpecifications: ImportDecisionSpecification[] = [
    unmatchedTracksSpecification,
    missingTracksSpecification,
    confidenceSpecification,
    matchScoreSpecification,
    ambiguousMatchSpecification,
    metadataSignalSpecification,
    existingImportSpecification,
];

const videoSpecifications: ImportDecisionSpecification[] = [
    videoScoreSpecification,
    existingImportSpecification,
];

export class ImportDecisionEngine {
    static hasEmbeddedMetadataSignal(group: LocalGroup): boolean {
        return group.files.some((file) => {
            const common = file.metadata?.common;
            return Boolean(
                common?.artist
                || common?.albumartist
                || common?.album
                || common?.title
                || common?.artists?.length
                || common?.albumartists?.length
            );
        });
    }

    static isInformativeTrackLabel(label?: string | null): boolean {
        const normalized = normalizeComparableText(label);
        if (!normalized) {
            return false;
        }

        return !/^(track|title|audio|song|unknown|untitled|side|disc|cd|file|sample|demo|test)[\s_-]*\d*$/.test(normalized)
            && !/^(one|two|three|four|five|six|seven|eight|nine|ten)$/.test(normalized)
            && !/^\d+$/.test(normalized);
    }

    static evaluateMatches(params: {
        group: LocalGroup;
        matches: TidalMatch[];
        mode?: ImportDecisionMode;
        directCandidateCount?: number;
        strongFingerprintCandidateCount?: number;
    }): TidalMatch[] {
        const mode = params.mode ?? "NewDownload";
        const sorted = [...params.matches].sort((left, right) => {
            return getComparableScore(right, mode) - getComparableScore(left, mode);
        });
        if (sorted.length === 0) {
            return sorted;
        }

        for (const match of sorted) {
            match.autoImportReady = false;
            match.rejections = [];
            match.conflictPath = null;
        }

        const bestMatch = sorted[0];
        const existingConflictPath = getExistingImportedMediaConflictPath(params.group, bestMatch);
        const context: ImportDecisionContext = {
            group: params.group,
            match: bestMatch,
            sortedMatches: sorted,
            mode,
            existingConflictPath,
            hasMetadataSignal: this.hasEmbeddedMetadataSignal(params.group),
            hasUsefulFilenameSignal: params.group.files.some((file) =>
                this.isInformativeTrackLabel(file.metadata?.common?.title || file.name.replace(/\.[^/.]+$/, ""))
            ),
            directCandidateCount: params.directCandidateCount ?? 0,
            strongFingerprintCandidateCount: params.strongFingerprintCandidateCount ?? 0,
        };

        const specifications = bestMatch.itemType === "video" ? videoSpecifications : albumSpecifications;
        bestMatch.rejections = specifications
            .map((specification) => specification.evaluate(context))
            .filter((reason): reason is string => Boolean(reason));
        bestMatch.autoImportReady = bestMatch.rejections.length === 0;
        bestMatch.conflictPath = existingConflictPath;

        for (const alternateMatch of sorted.slice(1)) {
            alternateMatch.rejections = ["Lower ranked candidate"];
        }

        return sorted;
    }

    static evaluateSingleMatch(params: {
        group: LocalGroup;
        match: TidalMatch;
        mode?: ImportDecisionMode;
        directCandidateCount?: number;
        strongFingerprintCandidateCount?: number;
    }): TidalMatch {
        return this.evaluateMatches({
            group: params.group,
            matches: [params.match],
            mode: params.mode,
            directCandidateCount: params.directCandidateCount,
            strongFingerprintCandidateCount: params.strongFingerprintCandidateCount,
        })[0];
    }
}
