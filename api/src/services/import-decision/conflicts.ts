import fs from "fs";
import { db } from "../../database.js";
import { resolveStoredLibraryPath } from "../mediafiles/library-paths.js";
import { normalizeResolvedPath } from "../mediafiles/path-utils.js";
import type { LocalGroup, ProviderMatch } from "../mediafiles/import-types.js";

type LibraryRow = {
    file_path: string;
    relative_path: string | null;
    library_root: string | null;
};

export function getExistingImportedMediaConflictPath(group: LocalGroup, match: ProviderMatch): string | null {
    const currentGroupPaths = new Set(group.files.map((file) => normalizeResolvedPath(file.path)));
    const rows: LibraryRow[] = [];

    if (match.itemType === "video") {
        const recordingId = Number(match.item?.recording_id ?? match.item?.id);
        const recordingMbid = String(match.item?.mbid ?? "").trim();
        const provider = String(match.item?.provider ?? "").trim();
        const providerId = String(match.item?.provider_id ?? "").trim();
        const predicates: string[] = [];
        const params: Array<string | number> = [];
        if (Number.isInteger(recordingId) && recordingId > 0) {
            predicates.push("recording_id = ?");
            params.push(recordingId);
        }
        if (recordingMbid) {
            predicates.push("canonical_recording_mbid = ?");
            params.push(recordingMbid);
        }
        if (provider && providerId) {
            predicates.push("(provider = ? AND provider_entity_type = 'video' AND provider_id = ?)");
            params.push(provider, providerId);
        }
        if (predicates.length === 0) {
            return null;
        }

        const existingRows = db.prepare(`
            SELECT file_path, relative_path, library_root
            FROM TrackFiles
            WHERE file_type = 'video'
              AND (${predicates.join(" OR ")})
        `).all(...params) as LibraryRow[];
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
              AND canonical_track_mbid IN (${placeholders})
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
