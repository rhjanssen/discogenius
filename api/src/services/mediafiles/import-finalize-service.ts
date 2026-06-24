import fs from "fs";
import path from "path";
import { db } from "../../database.js";
import { Config } from "../config/config.js";
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
                    db.prepare("DELETE FROM MetadataFiles WHERE file_path = ?").run(fullPath);
                    db.prepare("DELETE FROM LyricFiles WHERE file_path = ?").run(fullPath);
                    db.prepare("DELETE FROM ExtraFiles WHERE file_path = ?").run(fullPath);
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
                    SELECT provider_id AS media_id, quality, file_path
                    FROM TrackFiles
                    WHERE artist_id = ?
                      AND file_type IN ('track', 'video')
                      AND file_path LIKE ?
                `).all(mapping.artistId, `${mapping.destDir}${path.sep}%`) as Array<{
                    media_id: string | null;
                    quality: string | null;
                    file_path: string;
                }>;

                const linkedMedia =
                    siblingMediaFiles.find((row) => path.parse(row.file_path).name === stem)
                    || (imageFileType === "video_thumbnail" ? siblingMediaFiles[0] || null : null);

                const sidecarIdentity = resolveLibraryFileIdentity({
                    artistId: mapping.artistId,
                    albumId: mapping.albumId,
                    mediaId: fileType === "lyrics" || fileType === "video_thumbnail" ? linkedMedia?.media_id || null : null,
                    fileType,
                    quality: linkedMedia?.quality || null,
                    libraryRoot: mapping.libraryRootPath,
                });



                LibraryFilesService.upsertLibraryFile({
                    artistId: mapping.artistId,
                    albumId: mapping.albumId,
                    mediaId: fileType === "lyrics" || fileType === "video_thumbnail" ? linkedMedia?.media_id || null : null,
                    filePath: targetPath,
                    libraryRoot: mapping.libraryRootPath,
                    fileType,
                    quality: linkedMedia?.quality || null,
                    expectedPath: targetPath,
                    canonicalArtistMbid: sidecarIdentity.canonicalArtistMbid,
                    canonicalReleaseGroupMbid: sidecarIdentity.canonicalReleaseGroupMbid,
                    canonicalReleaseMbid: sidecarIdentity.canonicalReleaseMbid,
                    canonicalTrackMbid: sidecarIdentity.canonicalTrackMbid,
                    canonicalRecordingMbid: sidecarIdentity.canonicalRecordingMbid,
                    provider: sidecarIdentity.provider,
                    providerEntityType: sidecarIdentity.providerEntityType,
                    providerId: sidecarIdentity.providerId,
                    librarySlot: sidecarIdentity.librarySlot,
                    removeFromUnmapped: false,
                });

                if (fileType !== "other") {
                    LibraryFilesService.enforceTrackedAssetIdentity({
                        artistId: mapping.artistId,
                        albumId: mapping.albumId,
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
