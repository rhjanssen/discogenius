import type { LocalGroup, ProviderMatch } from "../mediafiles/import-types.js";

export type ImportDecisionMode = "ExistingFiles" | "NewDownload";

export interface ImportDecisionContext {
    group: LocalGroup;
    match: ProviderMatch;
    sortedMatches: ProviderMatch[];
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
