import { db } from "../database.js";
import { queueArtistMonitoringIntake } from "./artist-monitoring.js";
import { resolveArtistFolderForPersistence } from "./artist-paths.js";
import { lidarrMetadataService, type LidarrArtist } from "./metadata/lidarr-metadata-service.js";
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

function normalizeSearchText(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function bestLidarrArtistMatch(providerArtist: FollowedArtistRow, candidates: LidarrArtist[]): {
    artist: LidarrArtist;
    status: "verified" | "probable";
    confidence: number;
    method: string;
} | null {
    const normalizedName = normalizeSearchText(providerArtist.name);
    const exactMatches = candidates
        .filter((candidate) => normalizeSearchText(candidate.artistname || "") === normalizedName)
        .sort((left, right) => (right.Albums?.length || 0) - (left.Albums?.length || 0));

    if (exactMatches.length === 0) {
        return null;
    }

    if (exactMatches.length === 1) {
        return {
            artist: exactMatches[0],
            status: "verified",
            confidence: 1,
            method: "lidarr-artist-name-exact",
        };
    }

    const [best, second] = exactMatches;
    const bestAlbumCount = best.Albums?.length || 0;
    const secondAlbumCount = second.Albums?.length || 0;
    const bestHasDisambiguation = String(best.disambiguation || "").trim().length > 0;
    const secondHasDisambiguation = String(second.disambiguation || "").trim().length > 0;

    if (bestAlbumCount >= secondAlbumCount + 5 && (!bestHasDisambiguation || secondHasDisambiguation)) {
        return {
            artist: best,
            status: "probable",
            confidence: 0.78,
            method: "lidarr-artist-name-discography-weight",
        };
    }

    return null;
}

async function resolveMusicBrainzArtist(providerArtist: FollowedArtistRow): Promise<{
    mbid: string | null;
    status: "verified" | "probable";
    confidence: number;
    method: string;
    reason?: string;
} | null> {
    if (providerArtist.mbid) {
        return {
            mbid: providerArtist.mbid,
            status: "verified",
            confidence: 1,
            method: "provider-musicbrainz-id",
        };
    }

    try {
        const candidates = await lidarrMetadataService.searchArtists(providerArtist.name, 10);
        const match = bestLidarrArtistMatch(providerArtist, candidates);
        const normalizedName = normalizeSearchText(providerArtist.name);
        const exactCount = candidates.filter((candidate) => normalizeSearchText(candidate.artistname || "") === normalizedName).length;
        if (!match && exactCount > 1) {
            return {
                mbid: null,
                status: "probable",
                confidence: 0,
                method: "lidarr-artist-name-ambiguous",
                reason: "musicbrainz_ambiguous",
            };
        }
        return match ? {
            mbid: match.artist.id,
            status: match.status,
            confidence: match.confidence,
            method: match.method,
        } : null;
    } catch (error) {
        console.warn(`[FollowedArtistsImport] Failed to match ${providerArtist.name} to Lidarr metadata:`, error);
        return null;
    }
}

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
    db.prepare(`
        UPDATE artists
        SET monitor = 1,
            monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP),
            path = COALESCE(path, ?),
            picture = COALESCE(picture, ?),
            popularity = COALESCE(popularity, ?)
        WHERE id = ?
    `).run(
        resolveArtistFolderForPersistence({
            artistId: localArtistId,
            artistName: artist.name,
            artistMbId: artist.mbid,
            existingPath: existing?.path ?? null,
        }),
        artist.picture || null,
        artist.popularity || 0,
        localArtistId,
    );
    return { status, localArtistId };
}

function storeProviderArtistIdentity(providerId: string, artist: FollowedArtistRow, localArtistId: string | null): void {
    const matchStatus = artist.match_status || (artist.mbid ? "verified" : "provider_only");
    const matchConfidence = artist.match_confidence ?? (artist.mbid ? 1 : 0.45);
    const matchMethod = artist.match_method || "followed-artists-import";

    db.prepare(`
        INSERT INTO provider_items (
            provider, entity_type, provider_id, artist_mbid,
            title, match_status, match_confidence, match_method, data, updated_at
        )
        VALUES (?, 'artist', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
            artist_mbid = COALESCE(excluded.artist_mbid, provider_items.artist_mbid),
            title = excluded.title,
            match_status = excluded.match_status,
            match_confidence = excluded.match_confidence,
            match_method = excluded.match_method,
            data = excluded.data,
            updated_at = CURRENT_TIMESTAMP
    `).run(
        providerId,
        artist.provider_id,
        artist.mbid || null,
        artist.name,
        matchStatus,
        matchConfidence,
        matchMethod,
        JSON.stringify(artist.raw ?? artist),
    );

    if (!localArtistId) {
        return;
    }

    db.prepare(`
        INSERT INTO local_entities (local_id, entity_type, legacy_id, musicbrainz_id, display_name, updated_at)
        VALUES (?, 'artist', ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(local_id) DO UPDATE SET
            legacy_id = COALESCE(local_entities.legacy_id, excluded.legacy_id),
            musicbrainz_id = COALESCE(excluded.musicbrainz_id, local_entities.musicbrainz_id),
            display_name = excluded.display_name,
            updated_at = CURRENT_TIMESTAMP
    `).run(
        `artist:${localArtistId}`,
        localArtistId,
        artist.mbid || null,
        artist.name,
    );

    db.prepare(`
        INSERT INTO provider_entity_ids (
            local_id, entity_type, provider, external_id, provider_entity_type,
            match_status, match_confidence, match_method, data, updated_at
        )
        VALUES (?, 'artist', ?, ?, 'artist', ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(provider, provider_entity_type, external_id) DO UPDATE SET
            local_id = excluded.local_id,
            entity_type = excluded.entity_type,
            match_status = excluded.match_status,
            match_confidence = excluded.match_confidence,
            match_method = excluded.match_method,
            data = excluded.data,
            updated_at = CURRENT_TIMESTAMP
    `).run(
        `artist:${localArtistId}`,
        providerId,
        artist.provider_id,
        matchStatus,
        matchConfidence,
        matchMethod,
        JSON.stringify(artist.raw ?? artist),
    );
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
                const mbMatch = await resolveMusicBrainzArtist(artist);
                if (mbMatch?.mbid) {
                    artist.mbid = mbMatch.mbid;
                    artist.match_status = mbMatch.status;
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
                storeProviderArtistIdentity(provider.id, artist, result.localArtistId);

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
