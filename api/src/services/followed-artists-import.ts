import { db } from "../database.js";
import { getFollowedArtists } from "./tidal.js";
import { queueArtistMonitoringIntake } from "./artist-monitoring.js";

export type FollowedArtistsImportEvent =
    | { type: "status"; message: string }
    | { type: "total"; total: number }
    | { type: "artist-progress"; name: string; progress: number; total: number }
    | { type: "artist-added"; name: string; tidal_id: string | number; progress: number; total: number; added: number }
    | { type: "artist-updated"; name: string; tidal_id: string | number; progress: number; total: number; updated: number }
    | { type: "artist-skipped"; name: string; progress: number; total: number; skipped: number; reason: string }
    | { type: "error"; message: string; error: string };

export interface FollowedArtistsImportSummary {
    success: boolean;
    added: number;
    updated: number;
    skipped: number;
    queued: number;
    message: string;
}

type FollowedArtistRow = {
    tidal_id: string | number;
    name: string;
    picture?: string | null;
    popularity?: number | null;
};

function ensureMonitoredArtist(artist: FollowedArtistRow): "added" | "updated" | "skipped" {
    const existing = db.prepare("SELECT id, monitor FROM artists WHERE id = ?").get(artist.tidal_id) as { id: string | number; monitor: number } | undefined;

    if (existing) {
        if (existing.monitor === 1) {
            return "skipped";
        }

        db.prepare(`
            UPDATE artists
            SET monitor = 1,
                monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP),
                picture = COALESCE(picture, ?),
                popularity = COALESCE(popularity, ?)
            WHERE id = ?
        `).run(
            artist.picture || null,
            artist.popularity || 0,
            artist.tidal_id,
        );

        return "updated";
    }

    db.prepare(`
        INSERT INTO artists (id, name, picture, popularity, monitor, monitored_at, last_scanned)
        VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, NULL)
    `).run(
        artist.tidal_id,
        artist.name,
        artist.picture || null,
        artist.popularity || 0,
    );

    return "added";
}

export class FollowedArtistsImportService {
    static async importFollowedArtists(options?: {
        onEvent?: (event: FollowedArtistsImportEvent) => void;
    }): Promise<FollowedArtistsImportSummary> {
        const emit = options?.onEvent;
        emit?.({ type: "status", message: "Fetching followed artists from Tidal..." });

        const followedArtists = await getFollowedArtists();

        if (!followedArtists || followedArtists.length === 0) {
            return {
                success: true,
                added: 0,
                updated: 0,
                skipped: 0,
                queued: 0,
                message: "No followed artists found on Tidal",
            };
        }

        emit?.({ type: "total", total: followedArtists.length });

        let addedCount = 0;
        let updatedCount = 0;
        let skippedCount = 0;
        let queuedCount = 0;

        for (let index = 0; index < followedArtists.length; index += 1) {
            const artist = followedArtists[index];
            const progress = index + 1;

            emit?.({
                type: "artist-progress",
                name: artist.name,
                progress,
                total: followedArtists.length,
            });

            try {
                const result = ensureMonitoredArtist(artist);

                if (result === "skipped") {
                    skippedCount += 1;
                    emit?.({
                        type: "artist-skipped",
                        name: artist.name,
                        progress,
                        total: followedArtists.length,
                        skipped: skippedCount,
                        reason: "already_monitored",
                    });
                    continue;
                }

                const jobId = queueArtistMonitoringIntake({
                    artistId: String(artist.tidal_id),
                    artistName: artist.name,
                });
                if (jobId !== -1) {
                    queuedCount += 1;
                }

                if (result === "added") {
                    addedCount += 1;
                    emit?.({
                        type: "artist-added",
                        name: artist.name,
                        tidal_id: artist.tidal_id,
                        progress,
                        total: followedArtists.length,
                        added: addedCount,
                    });
                } else {
                    updatedCount += 1;
                    emit?.({
                        type: "artist-updated",
                        name: artist.name,
                        tidal_id: artist.tidal_id,
                        progress,
                        total: followedArtists.length,
                        updated: updatedCount,
                    });
                }
            } catch (error) {
                console.error(`Failed to import followed artist ${artist.name}:`, error);
                emit?.({
                    type: "error",
                    message: `Failed to import followed artist ${artist.name}`,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        const totalMonitored = addedCount + updatedCount;
        return {
            success: true,
            added: addedCount,
            updated: updatedCount,
            skipped: skippedCount,
            queued: queuedCount,
            message: totalMonitored > 0
                ? `Monitored ${totalMonitored} artists (${addedCount} new, ${updatedCount} existing). Scans queued for processing.`
                : `All ${skippedCount} artists were already monitored.`,
        };
    }
}