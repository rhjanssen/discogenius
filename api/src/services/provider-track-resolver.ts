import { db } from "../database.js";
import { normalizeComparableText, stringSimilarity } from "./import-matching-utils.js";
import { streamingProviderManager } from "./providers/index.js";
import type { ProviderTrack } from "./providers/streaming-provider.js";

type CanonicalTrackCandidate = {
    mbid: string | null;
    recording_mbid: string | null;
    release_group_mbid: string | null;
    title: string | null;
    position: number | null;
    medium_position: number | null;
    length_ms: number | null;
};

type ProviderAlbumSelection = {
    slot: string;
    provider: string;
    providerAlbumId: string;
    quality: string | null;
};

export type ResolvedProviderTrack = {
    provider: string;
    providerTrackId: string;
    providerAlbumId: string;
    slot: string;
    quality: string | null;
    score: number;
};

export function looksLikeMusicBrainzMbid(value: unknown): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || "").trim());
}

function getCanonicalTrack(input: {
    releaseGroupMbid?: string | null;
    canonicalTrackMbid?: string | null;
    canonicalRecordingMbid?: string | null;
    title?: string | null;
    volumeNumber?: number | null;
    trackNumber?: number | null;
    duration?: number | null;
}): CanonicalTrackCandidate | null {
    const releaseGroupMbid = String(input.releaseGroupMbid || "").trim();
    const canonicalTrackMbid = String(input.canonicalTrackMbid || "").trim();
    const canonicalRecordingMbid = String(input.canonicalRecordingMbid || "").trim();

    if (canonicalTrackMbid && releaseGroupMbid) {
        const row = db.prepare(`
            SELECT
              t.mbid,
              t.recording_mbid,
              r.release_group_mbid,
              t.title,
              t.position,
              t.medium_position,
              t.length_ms
            FROM mb_tracks t
            JOIN mb_releases r ON r.mbid = t.release_mbid
            WHERE t.mbid = ?
              AND r.release_group_mbid = ?
            LIMIT 1
        `).get(canonicalTrackMbid, releaseGroupMbid) as CanonicalTrackCandidate | undefined;
        if (row) return row;
    }

    if (canonicalRecordingMbid && releaseGroupMbid) {
        const row = db.prepare(`
            SELECT
              t.mbid,
              t.recording_mbid,
              r.release_group_mbid,
              t.title,
              t.position,
              t.medium_position,
              t.length_ms
            FROM mb_tracks t
            JOIN mb_releases r ON r.mbid = t.release_mbid
            WHERE t.recording_mbid = ?
              AND r.release_group_mbid = ?
            ORDER BY t.medium_position ASC, t.position ASC
            LIMIT 1
        `).get(canonicalRecordingMbid, releaseGroupMbid) as CanonicalTrackCandidate | undefined;
        if (row) return row;
    }

    if (!releaseGroupMbid && !canonicalTrackMbid && !canonicalRecordingMbid && !input.title) {
        return null;
    }

    return {
        mbid: canonicalTrackMbid || null,
        recording_mbid: canonicalRecordingMbid || null,
        release_group_mbid: releaseGroupMbid || null,
        title: input.title || null,
        position: input.trackNumber ?? null,
        medium_position: input.volumeNumber ?? null,
        length_ms: input.duration == null ? null : Number(input.duration) * 1000,
    };
}

function getProviderAlbumSelections(
    releaseGroupMbid: string,
    options: { slot?: string | null; provider?: string | null },
): ProviderAlbumSelection[] {
    const slot = String(options.slot || "").trim().toLowerCase();
    const provider = String(options.provider || "").trim().toLowerCase();
    const rows = db.prepare(`
        SELECT
          slot,
          selected_provider,
          selected_provider_id,
          quality
        FROM release_group_slots
        WHERE release_group_mbid = ?
          AND selected_provider IS NOT NULL
          AND selected_provider_id IS NOT NULL
          AND (? = '' OR LOWER(slot) = ?)
          AND (? = '' OR LOWER(selected_provider) = ?)
        ORDER BY
          CASE
            WHEN LOWER(slot) = 'stereo' THEN 0
            WHEN LOWER(slot) = 'spatial' THEN 1
            ELSE 2
          END ASC,
          updated_at DESC
    `).all(releaseGroupMbid, slot, slot, provider, provider) as Array<{
        slot?: string | null;
        selected_provider?: string | null;
        selected_provider_id?: string | number | null;
        quality?: string | null;
    }>;

    return rows
        .map((row) => ({
            slot: String(row.slot || ""),
            provider: String(row.selected_provider || ""),
            providerAlbumId: String(row.selected_provider_id || ""),
            quality: row.quality == null ? null : String(row.quality),
        }))
        .filter((row) => row.slot && row.provider && row.providerAlbumId);
}

function scoreProviderTrackMatch(track: CanonicalTrackCandidate, providerTrack: ProviderTrack): number {
    const volumeScore = Number(track.medium_position || 1) === Number(providerTrack.volumeNumber || 1) ? 0.35 : 0;
    const trackScore = Number(track.position || 0) === Number(providerTrack.trackNumber || 0) ? 0.35 : 0;
    const titleScore = stringSimilarity(
        normalizeComparableText(track.title || ""),
        normalizeComparableText(providerTrack.title || ""),
    ) * 0.2;
    const durationSeconds = Number(track.length_ms || 0) / 1000;
    const durationDelta = Math.abs(durationSeconds - Number(providerTrack.duration || 0));
    const durationScore = durationSeconds > 0 && Number(providerTrack.duration || 0) > 0
        ? Math.max(0, 1 - (durationDelta / Math.max(8, durationSeconds * 0.08))) * 0.1
        : 0;

    return volumeScore + trackScore + titleScore + durationScore;
}

export async function resolveProviderTrackForCanonicalTrack(input: {
    releaseGroupMbid?: string | null;
    canonicalTrackMbid?: string | null;
    canonicalRecordingMbid?: string | null;
    provider?: string | null;
    slot?: string | null;
    title?: string | null;
    volumeNumber?: number | null;
    trackNumber?: number | null;
    duration?: number | null;
}): Promise<ResolvedProviderTrack | null> {
    const canonicalTrack = getCanonicalTrack(input);
    const releaseGroupMbid = String(input.releaseGroupMbid || canonicalTrack?.release_group_mbid || "").trim();
    if (!canonicalTrack || !releaseGroupMbid) {
        return null;
    }

    const selections = getProviderAlbumSelections(releaseGroupMbid, {
        slot: input.slot,
        provider: input.provider,
    });
    if (selections.length === 0) {
        return null;
    }

    let best: ResolvedProviderTrack | null = null;
    for (const selection of selections) {
        const provider = streamingProviderManager.getStreamingProvider(selection.provider);
        const providerTracks = await provider.getAlbumTracks(selection.providerAlbumId);
        for (const providerTrack of providerTracks) {
            const score = scoreProviderTrackMatch(canonicalTrack, providerTrack);
            if (!best || score > best.score) {
                best = {
                    provider: selection.provider,
                    providerTrackId: String(providerTrack.providerId),
                    providerAlbumId: selection.providerAlbumId,
                    slot: selection.slot,
                    quality: providerTrack.quality || selection.quality,
                    score,
                };
            }
        }
    }

    return best && best.score >= 0.55 ? best : null;
}
