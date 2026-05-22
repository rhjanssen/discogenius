import fs from "fs";
import path from "path";
import { db } from "../database.js";
import { Config } from "./config.js";
import { embedVideoThumbnail } from "./audioUtils.js";
import { SUPPORTED_IMPORT_EXTENSIONS } from "./import-discovery.js";
import { resolveLibraryFileIdentity } from "./library-file-identity.js";

export type ImportedDirectoryMapping = {
    destDir: string;
    artistId: string;
    albumId: string | null;
    libraryRootPath: string;
};

export function resolveImportedLibraryFileId(filePath: string): number | null {
    const row = db.prepare("SELECT id FROM TrackFiles WHERE file_path = ?").get(filePath) as { id: number } | undefined;
    return row?.id ?? null;
}

export function collectSiblingSidecarTargets(
    sourceFilePath: string,
    expectedPath: string,
    sidecarExtensions: string[],
    targets: Map<string, string>
): void {
    const sourceDir = path.dirname(sourceFilePath);
    const sourceStem = path.parse(sourceFilePath).name;
    const expectedDir = path.dirname(expectedPath);
    const expectedStem = path.parse(expectedPath).name;

    for (const extension of sidecarExtensions) {
        const sourceSidecar = path.join(sourceDir, `${sourceStem}${extension}`);
        if (!fs.existsSync(sourceSidecar)) {
            continue;
        }

        const targetSidecar = path.join(expectedDir, `${expectedStem}${extension}`);
        targets.set(sourceSidecar, targetSidecar);
    }
}

export async function finalizeImportedDirectories(params: {
    importedFileIds: number[];
    dirMappings: Map<string, ImportedDirectoryMapping>;
    imageFileType: "cover" | "video_thumbnail";
    explicitSidecarTargets?: Map<string, string>;
}): Promise<void> {
    const { importedFileIds, dirMappings, imageFileType, explicitSidecarTargets } = params;
    const [{ LibraryFilesService, removeEmptyParents }, { RenameTrackFileService }] = await Promise.all([
        import("./library-files.js"),
        import("./rename-track-file-service.js"),
    ]);

    if (importedFileIds.length > 0) {
        try {
            RenameTrackFileService.executeRenameFiles(importedFileIds);
        } catch (error: any) {
            console.error(`[Import] Failed to apply renames for imported items:`, error);
        }
    }

    const upsertMovedSidecar = db.prepare(`
        INSERT INTO TrackFiles (
            artist_id, album_id, media_id,
            canonical_artist_mbid, canonical_release_group_mbid,
            canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
            provider, provider_entity_type, provider_id, library_slot,
            file_path, relative_path, library_root,
            filename, extension, file_size, duration,
            file_type, quality, needs_rename,
            expected_path, original_filename,
            modified_at, verified_at
        ) VALUES (
            @artistId, @albumId, @mediaId,
            @canonicalArtistMbid, @canonicalReleaseGroupMbid,
            @canonicalReleaseMbid, @canonicalTrackMbid, @canonicalRecordingMbid,
            @provider, @providerEntityType, @providerId, @librarySlot,
            @filePath, @relativePath, @libraryRoot,
            @filename, @extension, @fileSize, 0,
            @fileType, @quality, 0,
            @expectedPath, @originalFilename,
            @modifiedAt, CURRENT_TIMESTAMP
        )
        ON CONFLICT(file_path) DO UPDATE SET
            artist_id = excluded.artist_id,
            album_id = excluded.album_id,
            media_id = excluded.media_id,
            canonical_artist_mbid = COALESCE(excluded.canonical_artist_mbid, TrackFiles.canonical_artist_mbid),
            canonical_release_group_mbid = COALESCE(excluded.canonical_release_group_mbid, TrackFiles.canonical_release_group_mbid),
            canonical_release_mbid = COALESCE(excluded.canonical_release_mbid, TrackFiles.canonical_release_mbid),
            canonical_track_mbid = COALESCE(excluded.canonical_track_mbid, TrackFiles.canonical_track_mbid),
            canonical_recording_mbid = COALESCE(excluded.canonical_recording_mbid, TrackFiles.canonical_recording_mbid),
            provider = COALESCE(excluded.provider, TrackFiles.provider),
            provider_entity_type = COALESCE(excluded.provider_entity_type, TrackFiles.provider_entity_type),
            provider_id = COALESCE(excluded.provider_id, TrackFiles.provider_id),
            library_slot = COALESCE(excluded.library_slot, TrackFiles.library_slot),
            relative_path = excluded.relative_path,
            library_root = excluded.library_root,
            filename = excluded.filename,
            extension = excluded.extension,
            file_size = excluded.file_size,
            file_type = excluded.file_type,
            quality = excluded.quality,
            needs_rename = 0,
            expected_path = excluded.expected_path,
            original_filename = excluded.original_filename,
            modified_at = excluded.modified_at,
            verified_at = CURRENT_TIMESTAMP
    `);

    const normalizePath = (inputPath: string) => {
        const normalized = path.resolve(inputPath);
        return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    };

    for (const [oldDir, mapping] of dirMappings.entries()) {
        if (!fs.existsSync(oldDir)) {
            continue;
        }

        try {
            const filesInDir = fs.readdirSync(oldDir);
            for (const entry of filesInDir) {
                const fullPath = path.join(oldDir, entry);
                if (!fs.statSync(fullPath).isFile()) {
                    continue;
                }

                const ext = path.extname(entry).toLowerCase();
                const isMedia = SUPPORTED_IMPORT_EXTENSIONS.has(ext) || [".mp4", ".mkv", ".webm", ".ts", ".mov"].includes(ext);
                if (isMedia) {
                    continue;
                }

                if (!fs.existsSync(mapping.destDir)) {
                    fs.mkdirSync(mapping.destDir, { recursive: true });
                }

                const destFile = explicitSidecarTargets?.get(fullPath) || path.join(mapping.destDir, entry);
                const samePath = normalizePath(fullPath) === normalizePath(destFile);
                const targetPath = samePath ? fullPath : destFile;

                if (!samePath) {
                    try {
                        fs.renameSync(fullPath, destFile);
                    } catch (error: any) {
                        if (error.code === "EXDEV") {
                            fs.copyFileSync(fullPath, destFile);
                            fs.rmSync(fullPath);
                        } else {
                            throw error;
                        }
                    }

                    db.prepare("DELETE FROM TrackFiles WHERE file_path = ?").run(fullPath);
                }

                let fileType = "other";
                if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
                    fileType = imageFileType;
                } else if (ext === ".lrc") {
                    fileType = "lyrics";
                } else if (ext === ".nfo") {
                    fileType = "nfo";
                }

                const stats = fs.statSync(targetPath);
                const relativePath = path.relative(mapping.libraryRootPath, targetPath);
                const stem = path.parse(targetPath).name;

                const siblingMediaFiles = db.prepare(`
                    SELECT album_id, media_id, quality, file_path
                    FROM TrackFiles
                    WHERE artist_id = ?
                      AND file_type IN ('track', 'video')
                      AND file_path LIKE ?
                `).all(mapping.artistId, `${mapping.destDir}${path.sep}%`) as Array<{
                    album_id: string | null;
                    media_id: string | null;
                    quality: string | null;
                    file_path: string;
                }>;

                const linkedMedia =
                    siblingMediaFiles.find((row) => path.parse(row.file_path).name === stem)
                    || (imageFileType === "video_thumbnail" ? siblingMediaFiles[0] || null : null);

                const sidecarIdentity = resolveLibraryFileIdentity({
                    artistId: mapping.artistId,
                    albumId: linkedMedia?.album_id || mapping.albumId,
                    mediaId: fileType === "lyrics" || fileType === "video_thumbnail" ? linkedMedia?.media_id || null : null,
                    fileType,
                    quality: linkedMedia?.quality || null,
                    libraryRoot: mapping.libraryRootPath,
                });

                upsertMovedSidecar.run({
                    artistId: mapping.artistId,
                    albumId: linkedMedia?.album_id || mapping.albumId,
                    mediaId: fileType === "lyrics" || fileType === "video_thumbnail" ? linkedMedia?.media_id || null : null,
                    canonicalArtistMbid: sidecarIdentity.canonicalArtistMbid,
                    canonicalReleaseGroupMbid: sidecarIdentity.canonicalReleaseGroupMbid,
                    canonicalReleaseMbid: sidecarIdentity.canonicalReleaseMbid,
                    canonicalTrackMbid: sidecarIdentity.canonicalTrackMbid,
                    canonicalRecordingMbid: sidecarIdentity.canonicalRecordingMbid,
                    provider: sidecarIdentity.provider,
                    providerEntityType: sidecarIdentity.providerEntityType,
                    providerId: sidecarIdentity.providerId,
                    librarySlot: sidecarIdentity.librarySlot,
                    filePath: targetPath,
                    relativePath,
                    libraryRoot: mapping.libraryRootPath,
                    filename: path.basename(targetPath),
                    extension: ext.replace(".", ""),
                    fileSize: stats.size,
                    fileType,
                    quality: linkedMedia?.quality || null,
                    expectedPath: targetPath,
                    originalFilename: path.basename(targetPath),
                    modifiedAt: stats.mtime.toISOString(),
                });

                if (fileType !== "other") {
                    LibraryFilesService.enforceTrackedAssetIdentity({
                        artistId: mapping.artistId,
                        albumId: linkedMedia?.album_id || mapping.albumId,
                        mediaId: fileType === "lyrics" || fileType === "video_thumbnail" ? linkedMedia?.media_id || null : null,
                        fileType,
                        librarySlot: sidecarIdentity.librarySlot,
                    });
                }

                if (
                    fileType === "video_thumbnail"
                    && linkedMedia?.file_path
                    && Config.getMetadataConfig().embed_video_thumbnail !== false
                ) {
                    await embedVideoThumbnail(linkedMedia.file_path, targetPath);
                }
            }
        } catch (error: any) {
            console.error(`[Import] Failed processing sidecars from ${oldDir}:`, error);
        }

        if (normalizePath(oldDir) !== normalizePath(mapping.destDir)) {
            removeEmptyParents(oldDir, mapping.libraryRootPath);
        }
    }
}
