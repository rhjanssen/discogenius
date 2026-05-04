import { db } from "../database.js";
import { queueArtistMonitoringIntake } from "./artist-monitoring.js";
import { resolveArtistFolderForPersistence } from "./artist-paths.js";
import { lidarrMetadataService, type LidarrArtist } from "./metadata/lidarr-metadata-service.js";
import { providerManager } from "./providers/index.js";
import type { ProviderArtist } from "./providers/provider-interface.js";

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
    mbid?: string | null;
};

function normalizeSearchText(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function bestLidarrArtistMatch(providerArtist: FollowedArtistRow, candidates: LidarrArtist[]): LidarrArtist | null {
    const normalizedName = normalizeSearchText(providerArtist.name);
    const exactMatches = candidates
        .filter((candidate) => normalizeSearchText(candidate.artistname || "") === normalizedName)
        .sort((left, right) => (right.Albums?.length || 0) - (left.Albums?.length || 0));

    return exactMatches[0] || null;
}

async function resolveMusicBrainzArtistId(providerArtist: FollowedArtistRow): Promise<string | null> {
    if (providerArtist.mbid) {
        return providerArtist.mbid;
    }

    try {
        const candidates = await lidarrMetadataService.searchArtists(providerArtist.name, 10);
        return bestLidarrArtistMatch(providerArtist, candidates)?.id || null;
    } catch (error) {
        console.warn(`[FollowedArtistsImport] Failed to match ${providerArtist.name} to Lidarr metadata:`, error);
        return null;
    }
}

function normalizeProviderArtist(artist: ProviderArtist): FollowedArtistRow {
    return {
        tidal_id: artist.providerId,
        name: artist.name,
        picture: artist.picture || null,
        popularity: artist.popularity ?? null,
    };
}

function ensureMonitoredArtist(artist: FollowedArtistRow): "added" | "updated" | "skipped" {
    const existing = db.prepare("SELECT id, monitor, path FROM artists WHERE id = ?").get(artist.tidal_id) as { id: string | number; monitor: number; path: string | null } | undefined;

    if (existing) {
        if (existing.monitor === 1) {
            return "skipped";
        }

        db.prepare(`
            UPDATE artists
            SET monitor = 1,
                monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP),
                path = COALESCE(path, ?),
                picture = COALESCE(picture, ?),
                popularity = COALESCE(popularity, ?),
                mbid = COALESCE(mbid, ?),
                musicbrainz_status = CASE WHEN ? IS NOT NULL THEN 'verified' ELSE musicbrainz_status END,
                musicbrainz_last_checked = CASE WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP ELSE musicbrainz_last_checked END,
                musicbrainz_match_method = CASE WHEN ? IS NOT NULL THEN 'lidarr-search' ELSE musicbrainz_match_method END
            WHERE id = ?
        `).run(
            resolveArtistFolderForPersistence({
                artistId: artist.tidal_id,
                artistName: artist.name,
                artistMbId: artist.mbid || null,
                existingPath: existing.path,
            }),
            artist.picture || null,
            artist.popularity || 0,
            artist.mbid || null,
            artist.mbid || null,
            artist.mbid || null,
            artist.mbid || null,
            artist.tidal_id,
        );

        return "updated";
    }

    db.prepare(`
        INSERT INTO artists (
            id, name, picture, popularity, mbid,
            musicbrainz_status, musicbrainz_last_checked, musicbrainz_match_method,
            monitor, monitored_at, last_scanned, path
        )
        VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP ELSE NULL END, ?, 1, CURRENT_TIMESTAMP, NULL, ?)
    `).run(
        artist.tidal_id,
        artist.name,
        artist.picture || null,
        artist.popularity || 0,
        artist.mbid || null,
        artist.mbid ? "verified" : "pending",
        artist.mbid || null,
        artist.mbid ? "lidarr-search" : null,
        resolveArtistFolderForPersistence({
            artistId: artist.tidal_id,
            artistName: artist.name,
            artistMbId: artist.mbid || null,
        }),
    );

    return "added";
}

export class FollowedArtistsImportService {
    static async importFollowedArtists(options?: {
        onEvent?: (event: FollowedArtistsImportEvent) => void;
    }): Promise<FollowedArtistsImportSummary> {
        const emit = options?.onEvent;
        const provider = providerManager.getDefaultProvider();
        if (!provider.getFollowedArtists) {
            throw new Error(`${provider.name} does not support followed artist import`);
        }
        if (provider.isAuthenticated && !provider.isAuthenticated()) {
            throw new Error(`Connect ${provider.name} before importing followed artists`);
        }

        emit?.({ type: "status", message: `Fetching followed artists from ${provider.name}...` });

        const followedArtists = (await provider.getFollowedArtists()).map(normalizeProviderArtist);

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
                const mbid = await resolveMusicBrainzArtistId(artist);
                if (mbid) {
                    artist.mbid = mbid;
                    try {
                        await lidarrMetadataService.syncArtist(mbid);
                    } catch (error) {
                        console.warn(`[FollowedArtistsImport] Failed to sync Lidarr metadata for ${artist.name} (${mbid}):`, error);
                    }
                }

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
