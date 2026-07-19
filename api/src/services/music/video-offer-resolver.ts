import { db } from "../../database.js";
import { streamingProviderManager } from "../providers/index.js";

export type ResolvedVideoOffer = {
    provider: string;
    providerId: string;
    quality: string | null;
    recordingId: string | null;
    recordingMbid: string | null;
};

function findDirectProviderVideoOffer(
    provider: string | null | undefined,
    providerId: string | null | undefined,
): ResolvedVideoOffer | null {
    if (!provider || !providerId) {
        return null;
    }
    const row = db.prepare(`
        SELECT provider, CAST(provider_id AS TEXT) AS provider_id, quality,
               CAST(recording_id AS TEXT) AS recording_id, recording_mbid
        FROM ProviderItems
        WHERE entity_type = 'video'
          AND provider = ?
          AND CAST(provider_id AS TEXT) = ?
          AND (availability IS NULL
               OR LOWER(CAST(availability AS TEXT)) NOT IN ('0', 'false', 'unavailable', 'no', ''))
        LIMIT 1
    `).get(String(provider), String(providerId)) as {
        provider: string;
        provider_id: string;
        quality: string | null;
        recording_id: string | null;
        recording_mbid: string | null;
    } | undefined;
    return row
        ? {
            provider: row.provider,
            providerId: row.provider_id,
            quality: row.quality ?? null,
            recordingId: row.recording_id ?? null,
            recordingMbid: row.recording_mbid ?? null,
        }
        : null;
}

/** True when (provider, providerId) names an actual provider VIDEO offer. */
export function isKnownProviderVideoOffer(provider: string | null | undefined, providerId: string | null | undefined): boolean {
    return findDirectProviderVideoOffer(provider, providerId) !== null;
}

/** Resolve a canonical recording reference to a SPECIFIC provider's VIDEO offer, if it has one. */
export function resolveVideoOfferForProvider(provider: string, recordingRef: string | null | undefined): ResolvedVideoOffer | null {
    const key = String(recordingRef ?? "").trim();
    if (!provider || !key) {
        return null;
    }
    const row = db.prepare(`
        SELECT provider, CAST(provider_id AS TEXT) AS provider_id, quality,
               CAST(recording_id AS TEXT) AS recording_id, recording_mbid
        FROM ProviderItems
        WHERE entity_type = 'video' AND provider = ?
          AND (CAST(recording_id AS TEXT) = ? OR recording_mbid = ?)
          AND (availability IS NULL
               OR LOWER(CAST(availability AS TEXT)) NOT IN ('0', 'false', 'unavailable', 'no', ''))
        ORDER BY CAST(provider_id AS TEXT)
        LIMIT 1
    `).get(String(provider), key, key) as {
        provider: string;
        provider_id: string;
        quality: string | null;
        recording_id: string | null;
        recording_mbid: string | null;
    } | undefined;
    if (!row) {
        return null;
    }
    return {
        provider: row.provider,
        providerId: row.provider_id,
        quality: row.quality ?? null,
        recordingId: row.recording_id ?? null,
        recordingMbid: row.recording_mbid ?? null,
    };
}

/**
 * Videos dedupe across providers, so UI references are canonical Recordings
 * ids (row id or MBID) rather than provider catalog ids. Resolve one to the
 * preferred provider's VIDEO offer (streaming.provider_priority order).
 */
export function resolvePreferredVideoOffer(recordingRef: string | null | undefined): ResolvedVideoOffer | null {
    const key = String(recordingRef ?? "").trim();
    if (!key) {
        return null;
    }
    const offers = db.prepare(`
        SELECT provider, CAST(provider_id AS TEXT) AS provider_id, quality,
               CAST(recording_id AS TEXT) AS recording_id, recording_mbid
        FROM ProviderItems
        WHERE entity_type = 'video'
          AND (CAST(recording_id AS TEXT) = ? OR recording_mbid = ?)
          AND (availability IS NULL
               OR LOWER(CAST(availability AS TEXT)) NOT IN ('0', 'false', 'unavailable', 'no', ''))
    `).all(key, key) as Array<{
        provider: string;
        provider_id: string;
        quality: string | null;
        recording_id: string | null;
        recording_mbid: string | null;
    }>;
    if (offers.length === 0) {
        return null;
    }
    offers.sort((a, b) => {
        const rankDelta = streamingProviderManager.getProviderPreferenceRank(a.provider)
            - streamingProviderManager.getProviderPreferenceRank(b.provider);
        return rankDelta
            || a.provider.localeCompare(b.provider)
            || a.provider_id.localeCompare(b.provider_id);
    });
    return {
        provider: offers[0].provider,
        providerId: offers[0].provider_id,
        quality: offers[0].quality ?? null,
        recordingId: offers[0].recording_id ?? null,
        recordingMbid: offers[0].recording_mbid ?? null,
    };
}

/**
 * Resolve a queue/playback request without confusing a direct provider id with
 * a canonical Recordings id that happens to contain the same digits. Explicit
 * `(provider, providerId)` identity always wins; canonical preference is only a
 * fallback when that exact offer does not exist.
 */
export function resolveRequestedVideoOffer(
    provider: string | null | undefined,
    providerOrRecordingRef: string | null | undefined,
): ResolvedVideoOffer | null {
    return findDirectProviderVideoOffer(provider, providerOrRecordingRef)
        ?? resolvePreferredVideoOffer(providerOrRecordingRef);
}
