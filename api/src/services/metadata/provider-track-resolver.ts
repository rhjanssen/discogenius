import { db } from "../../database.js";

type CanonicalTrackCandidate = {
    id?: number | null;
    mbid: string | null;
    recording_mbid: string | null;
    release_group_mbid: string | null;
    title: string | null;
    position: number | null;
    medium_position: number | null;
    length_ms: number | null;
    isrcs: string | null;
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
              t.id,
              t.mbid,
              t.recording_mbid,
              r.release_group_mbid,
              t.title,
              t.position,
              t.medium_position,
              t.length_ms,
              recording.isrcs
            FROM Tracks t
            JOIN AlbumEditions r ON r.mbid = t.release_mbid
            LEFT JOIN Recordings recording ON recording.mbid = t.recording_mbid
            WHERE t.mbid = ?
              AND r.release_group_mbid = ?
            LIMIT 1
        `).get(canonicalTrackMbid, releaseGroupMbid) as CanonicalTrackCandidate | undefined;
        if (row) return row;
    }

    if (canonicalRecordingMbid && releaseGroupMbid) {
        const row = db.prepare(`
            SELECT
              t.id,
              t.mbid,
              t.recording_mbid,
              r.release_group_mbid,
              t.title,
              t.position,
              t.medium_position,
              t.length_ms,
              recording.isrcs
            FROM Tracks t
            JOIN AlbumEditions r ON r.mbid = t.release_mbid
            LEFT JOIN Recordings recording ON recording.mbid = t.recording_mbid
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
        id: null,
        mbid: canonicalTrackMbid || null,
        recording_mbid: canonicalRecordingMbid || null,
        release_group_mbid: releaseGroupMbid || null,
        title: input.title || null,
        position: input.trackNumber ?? null,
        medium_position: input.volumeNumber ?? null,
        length_ms: input.duration == null ? null : Number(input.duration) * 1000,
        isrcs: null,
    };
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

    const requestedSlot = String(input.slot || "").trim().toLowerCase();
    const requestedProvider = String(input.provider || "").trim().toLowerCase();
    const row = db.prepare(`
        SELECT
          plan.provider,
          provider_track.provider_id AS provider_track_id,
          provider_release.provider_id AS provider_album_id,
          CASE
            WHEN variant.quality_class = 'spatial' THEN 'spatial'
            ELSE 'stereo'
          END AS slot,
          COALESCE(variant.provider_quality_label, variant.quality_class) AS quality,
          track_match.confidence * 100 AS score
        FROM AcquisitionPlanTracks plan_track
        JOIN AcquisitionPlans plan
          ON plan.id = plan_track.plan_id
         AND plan.state = 'current'
        JOIN LibraryEditions library_release
          ON library_release.id = plan.library_edition_id
        JOIN AlbumEditions release
          ON release.id = library_release.edition_id
        JOIN Albums release_group
          ON release_group.id = release.release_group_id
        JOIN ProviderTrackMatches track_match
          ON track_match.id = plan_track.provider_track_match_id
         AND track_match.match_state = 'accepted'
        JOIN Recordings canonical_recording
          ON canonical_recording.id = track_match.recording_id
        JOIN ProviderEditionMembers release_member
          ON release_member.id = track_match.provider_edition_member_id
        JOIN ProviderItems provider_track
          ON provider_track.id = release_member.member_item_id
        JOIN AcquisitionPlanSources source
          ON source.id = plan_track.source_id
        JOIN ProviderEditionMatches release_match
          ON release_match.id = source.provider_edition_match_id
        JOIN ProviderItems provider_release
          ON provider_release.id = release_match.provider_edition_item_id
        JOIN ProviderItemAudioVariants variant
          ON variant.id = plan_track.provider_audio_variant_id
        WHERE release_group.mbid = ?
          AND (
            (? IS NOT NULL AND plan_track.track_id = ?)
            OR (? IS NOT NULL AND canonical_recording.mbid = ?)
          )
          AND (? = '' OR LOWER(plan.provider) = ?)
          AND (
            ? = ''
            OR (? = 'spatial' AND variant.quality_class = 'spatial')
            OR (? = 'stereo' AND variant.quality_class <> 'spatial')
          )
        ORDER BY
          CASE WHEN track_match.decision_source = 'manual' THEN 0 ELSE 1 END,
          track_match.confidence DESC,
          plan.computed_at DESC,
          plan_track.id
        LIMIT 1
    `).get(
        releaseGroupMbid,
        canonicalTrack.id ?? null,
        canonicalTrack.id ?? null,
        canonicalTrack.recording_mbid,
        canonicalTrack.recording_mbid,
        requestedProvider,
        requestedProvider,
        requestedSlot,
        requestedSlot,
        requestedSlot,
    ) as {
        provider: string;
        provider_track_id: string;
        provider_album_id: string;
        slot: string;
        quality: string | null;
        score: number;
    } | undefined;

    if (!row) return null;
    return {
        provider: row.provider,
        providerTrackId: String(row.provider_track_id),
        providerAlbumId: String(row.provider_album_id),
        slot: row.slot,
        quality: row.quality,
        score: Number(row.score),
    };
}
