import fs from "fs";
import path from "path";
import { db } from "../database.js";
import type { ImportCandidate } from "./import-service.js";
import { getUnmappedMediaMetrics } from "./library-media-metrics.js";

export function clearRootFolderReviewEntries(roots: Iterable<string>, folderNames: string[]) {
    const deleteByPrefix = db.prepare(`
        DELETE FROM unmapped_files
        WHERE file_path = ? OR file_path LIKE ?
    `);

    for (const root of roots) {
        for (const folderName of folderNames) {
            const folderPath = path.join(root, folderName);
            deleteByPrefix.run(folderPath, `${folderPath}${path.sep}%`);
        }
    }
}

export function persistRootReviewCandidates(candidates: ImportCandidate[]) {
    if (candidates.length === 0) {
        return;
    }

    const upsertUnmappedFile = db.prepare(`
        INSERT INTO unmapped_files (
            file_path, relative_path, library_root, filename, extension, file_size, duration,
            bitrate, sample_rate, bit_depth, channels, codec,
            detected_artist, detected_album, detected_track, audio_quality, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET
            relative_path = excluded.relative_path,
            library_root = excluded.library_root,
            filename = excluded.filename,
            extension = excluded.extension,
            file_size = excluded.file_size,
            duration = excluded.duration,
            bitrate = COALESCE(excluded.bitrate, bitrate),
            sample_rate = COALESCE(excluded.sample_rate, sample_rate),
            bit_depth = COALESCE(excluded.bit_depth, bit_depth),
            channels = COALESCE(excluded.channels, channels),
            codec = COALESCE(excluded.codec, codec),
            detected_artist = COALESCE(excluded.detected_artist, detected_artist),
            detected_album = COALESCE(excluded.detected_album, detected_album),
            detected_track = COALESCE(excluded.detected_track, detected_track),
            audio_quality = COALESCE(excluded.audio_quality, audio_quality),
            reason = excluded.reason,
            ignored = 0,
            updated_at = CURRENT_TIMESTAMP
    `);

    for (const candidate of candidates) {
        for (const file of candidate.group.files) {
            let stats: fs.Stats | null = null;
            try {
                stats = fs.statSync(file.path);
            } catch {
                continue;
            }

            const metrics = getUnmappedMediaMetrics(file.metadata?.format, file.extension);

            upsertUnmappedFile.run(
                file.path,
                path.relative(candidate.group.rootPath, file.path),
                candidate.group.libraryRoot,
                file.name,
                file.extension.replace(".", ""),
                stats.size,
                metrics.duration,
                metrics.bitrate,
                metrics.sampleRate,
                metrics.bitDepth,
                metrics.channels,
                metrics.codec,
                candidate.group.commonTags.artist || file.metadata?.common?.artist || file.metadata?.common?.albumartist || null,
                candidate.group.commonTags.album || file.metadata?.common?.album || null,
                file.metadata?.common?.title || path.parse(file.name).name,
                metrics.audioQuality,
                candidate.matches[0]?.rejections?.join("; ") || "Manual review required after root folder scan",
            );
        }
    }
}
