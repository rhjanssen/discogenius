import { db } from "../../database.js";
import { queueArtistMonitoringIntake } from "../music/artist-monitoring.js";
import { resolveArtistFolderForIdentityUpdate } from "../music/artist-paths.js";
import { servarrMetadata } from "../metadata/servarr-metadata.js";
import { ProviderArtistIdentityService } from "../metadata/provider-artist-identity-service.js";
import { streamingProviderManager } from "./index.js";
import type { ProviderArtist, ProviderImportSelection } from "./streaming-provider.js";
import { RefreshArtistService } from "../music/refresh-artist-service.js";

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
    providerId: string;
    providerName: string;
    total: number;
    added: number;
    updated: number;
    skipped: number;
    unmatched: number;
    failed: number;
    queued: number;
    message: string;
}

export type FollowedArtistRow = {
    provider_id: string;
    name: string;
    picture?: string | null;
    provider_url?: string | null;
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
        provider_url: artist.url || null,
        popularity: artist.popularity ?? null,
        raw: artist.raw,
    };
}

function findExistingArtist(artist: FollowedArtistRow): { id: string | number; monitored: number; path: string | null } | undefined {
    if (artist.mbid) {
        const byMbid = db.prepare("SELECT id, monitored, path FROM artists WHERE mbid = ? OR id = ? LIMIT 1")
            .get(artist.mbid, artist.mbid) as { id: string | number; monitored: number; path: string | null } | undefined;
        if (byMbid) {
            return byMbid;
        }
    }
}

type ExistingArtistRow = { id: string | number; monitored: number; path: string | null };

/**
 * Upsert + monitor the canonical artist behind a provider artist row. Shared
 * by the provider import loop and the manual-match flow so both paths create
 * identical artist rows (path resolution, picture, popularity, intake shape).
 */
export async function ensureMonitoredArtist(
    artist: FollowedArtistRow,
    existingArtist?: ExistingArtistRow | null,
): Promise<{ status: "added" | "updated" | "skipped"; localArtistId: string | null; reason?: string }> {
    if (!artist.mbid) {
        return {
            status: "skipped",
            localArtistId: null,
            reason: artist.match_status === "ambiguous" ? "musicbrainz_ambiguous" : "musicbrainz_unmatched",
        };
    }

    const existing = existingArtist === undefined ? findExistingArtist(artist) : existingArtist;
    const status = existing?.monitored === 1 ? "skipped" : existing ? "updated" : "added";

    const localArtistId = await RefreshArtistService.upsertMusicBrainzArtist(artist.mbid, { monitorArtist: true });
    const resolvedArtistFolder = resolveArtistFolderForIdentityUpdate({
        artistId: localArtistId,
        artistName: artist.name,
        artistMbId: artist.mbid,
        existingPath: existing?.path ?? null,
    });
    db.prepare(`
        UPDATE artists
        SET monitored = 1,
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
    /**
     * Import the distinct artists from any provider import source (followed
     * artists, a playlist, favorite tracks, a home-screen mix). The per-artist
     * loop is identical regardless of source — only how we obtain the artist
     * list differs.
     */
    static async importArtists(options?: {
        providerId?: string | null;
        selection?: ProviderImportSelection;
        onEvent?: (event: FollowedArtistsImportEvent) => void;
    }): Promise<FollowedArtistsImportSummary> {
        const emit = options?.onEvent;
        const providerId = String(options?.providerId || "").trim();
        const selection: ProviderImportSelection = options?.selection ?? { category: "followed-artists" };
        const provider = providerId
            ? streamingProviderManager.getStreamingProvider(providerId)
            : streamingProviderManager.getDefaultStreamingProvider();
        if (!provider.getArtistsForImportSource) {
            throw new Error(`${provider.name} does not support artist import`);
        }
        if (provider.isAuthenticated && !provider.isAuthenticated()) {
            throw new Error(`Connect ${provider.name} before importing artists`);
        }

        emit?.({ type: "status", message: `Fetching artists from ${provider.name}...` });

        const providerArtists = await provider.getArtistsForImportSource(selection);
        const followedArtists = providerArtists.map(normalizeProviderArtist);

        if (!followedArtists || followedArtists.length === 0) {
            return {
                success: true,
                providerId: provider.id,
                providerName: provider.name,
                total: 0,
                added: 0,
                updated: 0,
                skipped: 0,
                unmatched: 0,
                failed: 0,
                queued: 0,
                message: `No followed artists found on ${provider.name}`,
            };
        }

        emit?.({ type: "total", total: followedArtists.length });

        let addedCount = 0;
        let updatedCount = 0;
        let skippedCount = 0;
        let unmatchedCount = 0;
        let failedCount = 0;
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
                    providerUrl: artist.provider_url || null,
                    popularity: artist.popularity ?? null,
                    mbid: artist.mbid || null,
                    raw: artist.raw,
                };
                const mbMatch = await ProviderArtistIdentityService.resolve(provider.id, identityInput, {
                    // Only invoked when name/alias/URL evidence is inconclusive:
                    // one provider call to compare discographies before giving up.
                    listProviderAlbumTitles: async () => {
                        const albums = await provider.getArtistAlbums(artist.provider_id);
                        return albums.map((album) => String(album.title || "")).filter(Boolean);
                    },
                });
                let existingArtistBeforeImport: ExistingArtistRow | null | undefined;
                if (mbMatch?.mbid) {
                    artist.mbid = mbMatch.mbid;
                    artist.match_status = mbMatch.status === "ambiguous" || mbMatch.status === "provider_only" ? "probable" : mbMatch.status;
                    artist.match_confidence = mbMatch.confidence;
                    artist.match_method = mbMatch.method;
                    existingArtistBeforeImport = findExistingArtist(artist) ?? null;
                    try {
                        await servarrMetadata.syncArtist(mbMatch.mbid);
                    } catch (error) {
                        console.warn(`[FollowedArtistsImport] Failed to sync canonical metadata for ${artist.name} (${mbMatch.mbid}):`, error);
                    }
                } else if (mbMatch?.reason === "musicbrainz_ambiguous") {
                    artist.match_status = "ambiguous";
                    artist.match_confidence = 0;
                    artist.match_method = mbMatch.method;
                }

                const result = await ensureMonitoredArtist(artist, existingArtistBeforeImport);
                ProviderArtistIdentityService.store(provider.id, identityInput, {
                    mbid: artist.mbid || null,
                    status: artist.match_status || (artist.mbid ? "verified" : "provider_only"),
                    confidence: artist.match_confidence ?? (artist.mbid ? 1 : 0),
                    method: artist.match_method || "followed-artists-import",
                }, result.localArtistId);

                if (result.status === "skipped") {
                    const reason = result.reason || "already_monitored";
                    if (reason.startsWith("musicbrainz_")) {
                        unmatchedCount += 1;
                    } else {
                        skippedCount += 1;
                    }
                    emit?.({
                        type: "artist-skipped",
                        name: artist.name,
                        progress,
                        total: followedArtists.length,
                        skipped: skippedCount + unmatchedCount,
                        reason,
                    });
                    continue;
                }

                if (!result.localArtistId) {
                    unmatchedCount += 1;
                    emit?.({
                        type: "artist-skipped",
                        name: artist.name,
                        progress,
                        total: followedArtists.length,
                        skipped: skippedCount + unmatchedCount,
                        reason: "musicbrainz_unmatched",
                    });
                    continue;
                }

                const commandId = queueArtistMonitoringIntake({
                    artistId: result.localArtistId,
                    artistName: artist.name,
                });
                if (commandId !== -1) {
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
                failedCount += 1;
                console.error(`Failed to import followed artist ${artist.name}:`, error);
                emit?.({
                    type: "error",
                    message: `Failed to import followed artist ${artist.name}`,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        // Every artist the provider returned must land in exactly one bucket —
        // an import that quietly drops artists (e.g. "531 followed but only 494
        // monitored, no explanation") is a support mystery, so the summary
        // itemizes the non-monitored buckets instead of hiding them.
        const totalMonitored = addedCount + updatedCount;
        const parts: string[] = [];
        if (totalMonitored > 0) {
            parts.push(`Monitored ${totalMonitored} of ${followedArtists.length} artists (${addedCount} new, ${updatedCount} already in library)`);
        } else {
            parts.push(`Monitored 0 of ${followedArtists.length} artists`);
        }
        if (skippedCount > 0) parts.push(`${skippedCount} already monitored`);
        if (unmatchedCount > 0) parts.push(`${unmatchedCount} not matched automatically`);
        if (failedCount > 0) parts.push(`${failedCount} failed`);

        return {
            success: true,
            providerId: provider.id,
            providerName: provider.name,
            total: followedArtists.length,
            added: addedCount,
            updated: updatedCount,
            skipped: skippedCount,
            unmatched: unmatchedCount,
            failed: failedCount,
            queued: queuedCount,
            message: `${parts.join(" · ")}.`,
        };
    }
}
