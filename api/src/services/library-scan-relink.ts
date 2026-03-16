import { db } from "../database.js";

export type LibraryRootKey = "music" | "spatial_music" | "music_videos";

export interface RelinkUnresolvedLibraryFilesParams {
    artistId: string;
    fileExists: (filePath: string) => boolean;
    resolveStoredLibraryPath: (params: {
        filePath: string;
        libraryRoot: string | null;
        relativePath: string | null;
    }) => string;
    resolveLibraryRootKey: (libraryRoot: string | null | undefined, filePath: string) => LibraryRootKey | null;
    resolveLibraryRootPath: (libraryRoot: string | null | undefined, filePath: string) => string | null;
    getDefaultLibraryRootPath: () => string;
    matchFileToMedia: (
        filePath: string,
        artistId: string,
        libraryRoot: LibraryRootKey,
    ) => { albumId: string | null; mediaId: string | null; fileType: string; quality: string | null } | null;
    upsertLibraryFile: (params: {
        artistId: string;
        albumId?: string | null;
        mediaId?: string | null;
        filePath: string;
        libraryRoot: string;
        fileType: string;
        quality?: string | null;
        expectedPath?: string | null;
    }) => void;
}

export function relinkUnresolvedLibraryFiles(params: RelinkUnresolvedLibraryFilesParams): { relinked: number } {
    const rows = db.prepare(`
        SELECT id, file_path, relative_path, library_root, extension, file_type
        FROM library_files
        WHERE artist_id = ?
          AND media_id IS NULL
          AND (
            file_type IN ('track', 'video')
            OR LOWER(COALESCE(extension, '')) IN ('flac', 'alac', 'wav', 'aiff', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'mp4', 'm4v', 'mkv', 'mov', 'avi', 'ts', 'webm')
          )
    `).all(params.artistId) as Array<{
        id: number;
        file_path: string;
        relative_path: string | null;
        library_root: string | null;
        extension: string | null;
        file_type: string | null;
    }>;

    let relinked = 0;

    for (const row of rows) {
        const resolvedPath = params.resolveStoredLibraryPath({
            filePath: row.file_path,
            libraryRoot: row.library_root,
            relativePath: row.relative_path,
        });
        if (!params.fileExists(resolvedPath)) {
            continue;
        }

        const rootKey = params.resolveLibraryRootKey(row.library_root, resolvedPath) || "music";
        const match = params.matchFileToMedia(resolvedPath, params.artistId, rootKey);
        if (!match?.mediaId || (match.fileType !== "track" && match.fileType !== "video")) {
            continue;
        }

        const rootPath = params.resolveLibraryRootPath(row.library_root, resolvedPath) || params.getDefaultLibraryRootPath();
        params.upsertLibraryFile({
            artistId: params.artistId,
            albumId: match.albumId,
            mediaId: match.mediaId,
            filePath: resolvedPath,
            libraryRoot: rootPath,
            fileType: match.fileType,
            quality: match.quality,
            expectedPath: resolvedPath,
        });
        relinked += 1;
    }

    return { relinked };
}
