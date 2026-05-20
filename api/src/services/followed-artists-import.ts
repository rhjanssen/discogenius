import { db } from "../database.js";
import { queueArtistMonitoringIntake } from "./artist-monitoring.js";
import { resolveArtistFolderForIdentityUpdate } from "./artist-paths.js";
import { lidarrMetadataService } from "./metadata/lidarr-metadata-service.js";
import { ProviderArtistIdentityService } from "./provider-artist-identity-service.js";
import { streamingProviderManager } from "./providers/index.js";
import type { ProviderArtist } from "./providers/streaming-provider.js";
import { RefreshArtistService } from "./refresh-artist-service.js";

export type FollowedArtistsImportEvent =
    | { type: "status"; message: string }
    | { type: "total"; total: number }
    | { type: "artist-progress"; name: string; progress: number; total: number }
    | { type: "artist-added"; name: string; provider_id: string; progress: number; total: number; added: number }
    | { type: "artist-updated"; name: string; provider_id: string; progress: number; total: number; updated: number }
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
    provider_id: string;
    name: string;
    picture?: string | null;
    popularity?: number | null;
    mbid?: string | null;
    match_status?: "verified" | "probable" | "ambiguous" | "provider_only";
    match_confidence?: number | null;
    match_method?: string | null;
    raw?: unknown;
};

function normalizeProviderArtist(artist: ProviderArtist): FollowedArtistRow {
    return {
        provider_id: artist.providerId,
        name: artist.name,
        picture: artist.picture || null,
        popularity: artist.popularity ?? null,
        raw: artist.raw,
    };
}

function findExistingArtist(artist: FollowedArtistRow): { id: string | number; monitor: number; path: string | null } | undefined {
    if (artist.mbid) {
        const byMbid = db.prepare("SELECT id, monitor, path FROM artists WHERE mbid = ? OR id = ? LIMIT 1")
            .get(artist.mbid, artist.mbid) as { id: string | number; monitor: number; path: string | null } | undefined;
        if (byMbid) {
            return byMbid;
        }
    }
}

async function ensureMonitoredArtist(artist: FollowedArtistRow): Promise<{ status: "added" | "updated" | "skipped"; localArtistId: string | null; reason?: string }> {
    if (!artist.mbid) {
        return {
            status: "skipped",
            localArtistId: null,
            reason: artist.match_status === "ambiguous" ? "musicbrainz_ambiguous" : "musicbrainz_unmatched",
        };
    }

    const existing = findExistingArtist(artist);
    const status = existing?.monitor === 1 ? "skipped" : existing ? "updated" : "added";

    const localArtistId = await RefreshArtistService.upsertMusicBrainzArtist(artist.mbid, { monitorArtist: true });
    const resolvedArtistFolder = resolveArtistFolderForIdentityUpdate({
        artistId: localArtistId,
        artistName: artist.name,
        artistMbId: artist.mbid,
        existingPath: existing?.path ?? null,
    });
    db.prepare(`
        UPDATE artists
        SET monitor = 1,
            monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP),
            path = CASE WHEN ? = 1 THEN ? ELSE COALESCE(path, ?) END,
            picture = COALESCE(picture, ?),
            popularity = COALESCE(popularity, ?)
        WHERE id = ?
    `).run(
        resolvedArtistFolder.shouldReplaceExistingPath ? 1 : 0,
        resolvedArtistFolder.path,
        resolvedArtistFolder.path,
        artist.picture || null,
        artist.popularity || 0,
        localArtistId,
    );
    return { status, localArtistId };
}

export class FollowedArtistsImportService {
    static async importFollowedArtists(options?: {
        onEvent?: (event: FollowedArtistsImportEvent) => void;
    }): Promise<FollowedArtistsImportSummary> {
        const emit = options?.onEvent;
        const provider = streamingProviderManager.getDefaultStreamingProvider();
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
                message: `No followed artists found on ${provider.name}`,
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
                const identityInput = {
                    providerId: artist.provider_id,
                    name: artist.name,
                    picture: artist.picture || null,
                    popularity: artist.popularity ?? null,
                    mbid: artist.mbid || null,
                    raw: artist.raw,
                };
                const mbMatch = await ProviderArtistIdentityService.resolve(provider.id, identityInput);
                if (mbMatch?.mbid) {
                    artist.mbid = mbMatch.mbid;
                    artist.match_status = mbMatch.status === "ambiguous" || mbMatch.status === "provider_only" ? "probable" : mbMatch.status;
                    artist.match_confidence = mbMatch.confidence;
                    artist.match_method = mbMatch.method;
                    try {
                        await lidarrMetadataService.syncArtist(mbMatch.mbid);
                    } catch (error) {
                        console.warn(`[FollowedArtistsImport] Failed to sync Lidarr metadata for ${artist.name} (${mbMatch.mbid}):`, error);
                    }
                } else if (mbMatch?.reason === "musicbrainz_ambiguous") {
                    artist.match_status = "ambiguous";
                    artist.match_confidence = 0;
                    artist.match_method = mbMatch.method;
                }

                const result = await ensureMonitoredArtist(artist);
                ProviderArtistIdentityService.store(provider.id, identityInput, {
                    mbid: artist.mbid || null,
                    status: artist.match_status || (artist.mbid ? "verified" : "provider_only"),
                    confidence: artist.match_confidence ?? (artist.mbid ? 1 : 0),
                    method: artist.match_method || "followed-artists-import",
                }, result.localArtistId);

                if (result.status === "skipped") {
                    skippedCount += 1;
                    emit?.({
                        type: "artist-skipped",
                        name: artist.name,
                        progress,
                        total: followedArtists.length,
                        skipped: skippedCount,
                        reason: result.reason || "already_monitored",
                    });
                    continue;
                }

                if (!result.localArtistId) {
                    skippedCount += 1;
                    emit?.({
                        type: "artist-skipped",
                        name: artist.name,
                        progress,
                        total: followedArtists.length,
                        skipped: skippedCount,
                        reason: "musicbrainz_unmatched",
                    });
                    continue;
                }

                const jobId = queueArtistMonitoringIntake({
                    artistId: result.localArtistId,
                    artistName: artist.name,
                });
                if (jobId !== -1) {
                    queuedCount += 1;
                }

                if (result.status === "added") {
                    addedCount += 1;
                    emit?.({
                        type: "artist-added",
                        name: artist.name,
                        provider_id: artist.provider_id,
                        progress,
                        total: followedArtists.length,
                        added: addedCount,
                    });
                } else {
                    updatedCount += 1;
                    emit?.({
                        type: "artist-updated",
                        name: artist.name,
                        provider_id: artist.provider_id,
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
