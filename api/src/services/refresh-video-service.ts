import { db } from "../database.js";
import type { ScanOptions } from "./scan-types.js";

export class RefreshVideoService {
    static upsertArtistVideos(artistId: string, videos: any[], options: ScanOptions = {}): void {
        const forceUpdate = options.forceUpdate === true;
        const videoInsert = db.prepare(`
            INSERT INTO media (
                id, artist_id, album_id, title, duration, release_date, version,
                explicit, type, quality, popularity, cover, monitor, last_scanned
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Music Video', ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);

        const videoUpdate = db.prepare(`
            UPDATE media SET
                title = ?, duration = ?, release_date = ?, version = ?,
                explicit = ?, quality = ?, popularity = ?,
                ${forceUpdate ? "cover = ?" : "cover = COALESCE(?, cover)"},
                last_scanned = CURRENT_TIMESTAMP
            WHERE id = ? AND type = 'Music Video'
        `);

        const selectVideo = db.prepare(
            "SELECT id, monitor, monitor_lock FROM media WHERE id = ? AND type = 'Music Video'",
        );

        db.transaction(() => {
            for (const video of videos) {
                const exists = selectVideo.get(video.tidal_id) as any;

                let shouldMonitor = exists?.monitor || 0;
                if (exists?.monitor_lock) {
                    shouldMonitor = exists.monitor;
                }

                const quality = video.quality || "MP4_1080P";
                const cover = video.image_id || null;

                if (!exists) {
                    videoInsert.run(
                        video.tidal_id,
                        artistId,
                        video.album_id || null,
                        video.title,
                        video.duration,
                        video.release_date,
                        video.version || null,
                        video.explicit ? 1 : 0,
                        quality,
                        video.popularity || 0,
                        cover,
                        shouldMonitor,
                    );
                } else {
                    videoUpdate.run(
                        video.title,
                        video.duration,
                        video.release_date,
                        video.version || null,
                        video.explicit ? 1 : 0,
                        quality,
                        video.popularity || 0,
                        cover,
                        video.tidal_id,
                    );
                }
            }
        })();
    }
}
