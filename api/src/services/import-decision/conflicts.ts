import fs from "fs";
import { db } from "../../database.js";
import { resolveStoredLibraryPath } from "../library-paths.js";
import { normalizeResolvedPath } from "../path-utils.js";
import type { LocalGroup, TidalMatch } from "../import-types.js";

type LibraryRow = {
    file_path: string;
    relative_path: string | null;
    library_root: string | null;
};

export function getExistingImportedMediaConflictPath(group: LocalGroup, match: TidalMatch): string | null {
    const currentGroupPaths = new Set(group.files.map((file) => normalizeResolvedPath(file.path)));
    const rows: LibraryRow[] = [];

    if (match.itemType === "video") {
        const mediaId = match.item?.id?.toString?.() ?? match.item?.tidal_id?.toString?.();
        if (!mediaId) {
            return null;
        }

        const existingRows = db.prepare(`
            SELECT file_path, relative_path, library_root
            FROM library_files
            WHERE media_id = ? AND file_type = 'video'
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
            FROM library_files
            WHERE file_type = 'track'
              AND media_id IN (${placeholders})
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
