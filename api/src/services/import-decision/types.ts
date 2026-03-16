import type { LocalGroup, TidalMatch } from "../import-types.js";

export type ImportDecisionMode = "ExistingFiles" | "NewDownload";

export interface ImportDecisionContext {
    group: LocalGroup;
    match: TidalMatch;
    sortedMatches: TidalMatch[];
    mode: ImportDecisionMode;
    existingConflictPath: string | null;
    hasMetadataSignal: boolean;
    hasUsefulFilenameSignal: boolean;
    directCandidateCount: number;
    strongFingerprintCandidateCount: number;
}

export interface ImportDecisionSpecification {
    evaluate(context: ImportDecisionContext): string | null;
}
