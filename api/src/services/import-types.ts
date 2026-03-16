import type * as mm from "music-metadata";
import type { LibraryRoot } from "./naming.js";

export interface LocalFile {
    path: string;
    name: string;
    size: number;
    extension: string;
    metadata?: mm.IAudioMetadata;
    fingerprint?: string | null;
}

export interface LocalGroup {
    id: string;
    path: string;
    rootPath: string;
    libraryRoot: LibraryRoot;
    files: LocalFile[];
    sidecars: string[];
    commonTags: {
        artist?: string;
        album?: string;
        year?: number;
    };
    status: "pending" | "imported" | "manual_required";
}

export interface ImportCandidate {
    group: LocalGroup;
    matches: TidalMatch[];
}

export interface TidalMatch {
    item: any;
    itemType: "album" | "video";
    score: number;
    closeMatchScore?: number;
    matchType: "exact" | "fuzzy" | "fingerprint";
    confidence?: number;
    closeMatchConfidence?: number;
    coverage?: number;
    matchedCount?: number;
    totalFiles?: number;
    autoImportReady?: boolean;
    trackIdsByFilePath?: Record<string, string>;
    rejections?: string[];
    conflictPath?: string | null;
}

export interface AutoImportedGroupSummary {
    folderName: string;
    groupPath: string;
    artistId: string;
    artistName: string;
    albumId: string | null;
    albumTitle: string;
    itemType: "album" | "video";
}

export interface RootFolderImportProgressEvent {
    message: string;
    currentFileNum: number;
    totalFiles: number;
    currentGroupNum: number;
    totalGroups: number;
}