import fs from "fs";
import { db } from "../../database.js";
import { resolveStoredLibraryPath } from "../mediafiles/library-paths.js";
import { normalizeResolvedPath } from "../mediafiles/path-utils.js";
import type { LocalGroup, TidalMatch } from "../mediafiles/import-types.js";

type LibraryRow = {
    file_path: string;
    relative_path: string | null;
    library_root: string | null;
};

export function getExistingImportedMediaConflictPath(group: LocalGroup, match: TidalMatch): string | null {
    const currentGroupPaths = new Set(group.files.map((file) => normalizeResolvedPath(file.path)));
    const rows: LibraryRow[] = [];

    if (match.itemType === "video") {
        const mediaId = match.item?.id?.toString?.() ?? match.item?.provider_id?.toString?.();
        if (!mediaId) {
            return null;
        }

        const existingRows = db.prepare(`
            SELECT file_path, relative_path, library_root
            FROM TrackFiles
            WHERE provider_entity_type = 'video'
              AND provider_id = ?
              AND file_type = 'video'
        `).all(mediaId) as LibraryRow[];
        rows.push(...existingRows);
    } else {
        const trackIds = Array.from(new Set(Object.values(match.trackIdsByFilePath || {}))).filter(Boolean);
        if (trackIds.length === 0) {
            return null;
        }

        const placeholders = trackIds.map(() => "?").join(", ");
        const existingRows = db.prepare(`
            SELECT file_path, relative_path, library_root
            FROM TrackFiles
            WHERE file_type = 'track'
              AND provider_entity_type = 'track'
              AND provider_id IN (${placeholders})
        `).all(...trackIds) as LibraryRow[];
        rows.push(...existingRows);
    }

    for (const row of rows) {
        const resolvedPath = resolveStoredLibraryPath({
            filePath: row.file_path,
            libraryRoot: row.library_root,
            relativePath: row.relative_path,
        });

        if (!fs.existsSync(resolvedPath)) {
            continue;
        }

        if (!currentGroupPaths.has(normalizeResolvedPath(resolvedPath))) {
            return resolvedPath;
        }
    }

    return null;
}
