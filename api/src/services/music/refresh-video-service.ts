import { db } from "../../database.js";
import { streamingProviderManager } from "../providers/index.js";
import type { RefreshOptions } from "./scan-types.js";
import { videoComparableTitle } from "../mediafiles/import-matching-utils.js";
import {
    buildVideoIdentity,
    durationMs,
    findRelatedAudioRecordingForVideo,
    isPlaceholderVideoTitle,
    nullableText,
    preferredMergedVideoTitle,
    videoVariantClass,
    type AudioRecordingCandidateRow,
    type AudioRecordingVideoMatch,
} from "./refresh-video-support.js";
import { isExactVideoTwin, scoreVideoIdentityMatch, videosAreSameIdentity } from "./video-match.js";
import {
    catalogVideoDisplayTitle,
    isMainVideoVariant,
    normalizeVideoVariant,
    parseVideoVariant,
    preferredVideoVariant,
    VIDEO_DURATION_MATCH_MS,
    type VideoVariant,
} from "./video-variant.js";
import type { ProviderVideo } from "../providers/streaming-provider.js";

/** Fill Recordings.title when it is still the placeholder and a real title arrived. */
function backfillPlaceholderVideoTitle(recordingId: number, title: string): void {
    if (isPlaceholderVideoTitle(title)) {
        return;
    }
    db.prepare(`
        UPDATE Recordings
        SET title = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND (
            title IS NULL
            OR TRIM(title) = ''
            OR LOWER(TRIM(title)) = 'unknown video'
          )
    `).run(title, recordingId);
}

function getArtistMusicBrainzId(artistId: string): string | null {
    const row = db.prepare("SELECT mbid FROM Artists WHERE CAST(id AS TEXT) = CAST(? AS TEXT) LIMIT 1")
        .get(artistId) as { mbid?: string | null } | undefined;
    return nullableText(row?.mbid);
}

function getArtistMetadataId(artistMbid: string | null): number | null {
    if (!artistMbid) {
        return null;
    }
    const row = db.prepare(`
        SELECT id
        FROM ArtistMetadata
        WHERE foreign_artist_id = ? OR mbid = ?
        LIMIT 1
    `).get(artistMbid, artistMbid) as { id?: number | null } | undefined;
    return row?.id == null ? null : Number(row.id);
}

function getRecordingIdByForeignId(recordingMbid: string | null): number | null {
    if (!recordingMbid) {
        return null;
    }
    const row = db.prepare(`
        SELECT id
        FROM Recordings
        WHERE foreign_recording_id = ? OR mbid = ?
        LIMIT 1
    `).get(recordingMbid, recordingMbid) as { id?: number | null } | undefined;
    return row?.id == null ? null : Number(row.id);
}

/** Audio recordings already matched to tracks on a specific provider album. */
function loadAudioRecordingCandidatesForProviderAlbum(
    provider: string,
    providerAlbumId: string,
): AudioRecordingCandidateRow[] {
    return db.prepare(`
        SELECT DISTINCT rec.id, rec.mbid, rec.title, rec.length_ms, rec.isrcs
        FROM ProviderItems track
        JOIN Recordings rec
          ON CAST(rec.id AS TEXT) = CAST(track.recording_id AS TEXT)
          OR (track.recording_mbid IS NOT NULL AND rec.mbid = track.recording_mbid)
        WHERE track.provider = ?
          AND track.entity_type = 'track'
          AND CAST(track.provider_album_id AS TEXT) = CAST(? AS TEXT)
          AND track.recording_id IS NOT NULL
          AND (rec.is_video IS NULL OR rec.is_video = 0)
    `).all(provider, providerAlbumId) as AudioRecordingCandidateRow[];
}

function findAudioRecordingByProviderTrack(
    provider: string,
    providerTrackId: string,
): AudioRecordingVideoMatch | null {
    const row = db.prepare(`
        SELECT rec.id, rec.mbid, rec.title
        FROM ProviderItems track
        JOIN Recordings rec
          ON CAST(rec.id AS TEXT) = CAST(track.recording_id AS TEXT)
        WHERE track.provider = ?
          AND track.entity_type = 'track'
          AND CAST(track.provider_id AS TEXT) = CAST(? AS TEXT)
          AND track.recording_id IS NOT NULL
          AND (rec.is_video IS NULL OR rec.is_video = 0)
        LIMIT 1
    `).get(provider, providerTrackId) as {
        id: number;
        mbid?: string | null;
        title?: string | null;
    } | undefined;
    if (!row?.id) {
        return null;
    }
    return {
        id: Number(row.id),
        mbid: nullableText(row.mbid),
        confidence: 0.96,
        method: "provider-video-related-track",
        evidence: {
            relatedTrackId: providerTrackId,
            audioTitle: row.title ?? null,
        },
    };
}

/**
 * Link a provider video to an audio recording only via explicit API association:
 * related-track id, or title/duration within the same provider album.
 * Official/main videos may also exact-match an artist audio recording by
 * title+duration when providers omit album/song links (common for TIDAL MVs).
 * Never fuzzy-match live cuts artist-wide.
 */
function resolveProviderVideoAudioMatch(input: {
    video: any;
    provider: string;
    artistMbid?: string | null;
}): AudioRecordingVideoMatch | null {
    const relatedTrackId = nullableText(input.video.related_track_id ?? input.video.relatedTrackId);
    if (relatedTrackId) {
        const byTrack = findAudioRecordingByProviderTrack(input.provider, relatedTrackId);
        if (byTrack) {
            return byTrack;
        }
        // Related-track id present but not yet matched — keep trying album /
        // artist exact title once catalog track matching has caught up.
    }

    const albumId = nullableText(input.video.album_id ?? input.video.albumId);
    if (albumId) {
        const albumCandidates = loadAudioRecordingCandidatesForProviderAlbum(input.provider, albumId);
        const albumMatch = findRelatedAudioRecordingForVideo(input.video, albumCandidates);
        if (albumMatch) {
            return {
                ...albumMatch,
                method: albumMatch.method.includes("album")
                    ? albumMatch.method
                    : albumMatch.method.replace("provider-video-", "provider-video-album-"),
                evidence: {
                    ...albumMatch.evidence,
                    providerAlbumId: albumId,
                },
            };
        }
        // Album present but no in-album audio hit — fall through to artist
        // exact title+duration for official MVs (YouTube often lists the OMV
        // itself as the album track without an ATV audio row).
    }

    const artistMbid = nullableText(input.artistMbid ?? input.video.artist_mbid);
    const offerVariant = parseVideoVariant(nullableText(input.video.title));
    if (artistMbid && isMainVideoVariant(offerVariant)) {
        return findAudioRecordingByArtistTitleDuration(artistMbid, input.video);
    }

    return null;
}

function findAudioRecordingByArtistTitleDuration(
    artistMbid: string,
    video: any,
): AudioRecordingVideoMatch | null {
    const candidates = db.prepare(`
        SELECT id, mbid, title, length_ms, isrcs
        FROM Recordings
        WHERE artist_mbid = ?
          AND (is_video IS NULL OR is_video = 0)
          AND mbid IS NOT NULL
    `).all(artistMbid) as AudioRecordingCandidateRow[];
    const match = findRelatedAudioRecordingForVideo(video, candidates);
    if (!match) return null;
    // Artist-wide is title+duration only — ISRC-only links are too eager when
    // providers omit album/song associations (official MVs often share ISRC
    // with a shorter audio cut).
    if (match.method === "provider-video-isrc-recording") return null;
    if (match.confidence < 0.84) return null;
    const durationDiffMs = match.evidence.durationDiffMs;
    if (typeof durationDiffMs === "number" && durationDiffMs > VIDEO_DURATION_MATCH_MS) {
        return null;
    }
    return {
        ...match,
        method: "provider-video-artist-title-duration",
        evidence: {
            ...match.evidence,
            artistMbid,
        },
    };
}

function upsertProviderVideoAudioRelation(input: {
    videoRecordingId: number | null;
    videoRecordingMbid: string | null;
    audioMatch: AudioRecordingVideoMatch | null;
    provider: string;
    videoVariant?: VideoVariant | string | null;
    videoTitle?: string | null;
}): void {
    if (!input.videoRecordingId || !input.audioMatch) {
        return;
    }

    db.prepare(`
        INSERT INTO RecordingRelations (
            source_recording_id, target_recording_id, source_foreign_recording_id,
            target_foreign_recording_id, relation_type, source, confidence, data, updated_at
        ) VALUES (?, ?, ?, ?, 'provider_video_for', ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(source_recording_id, target_recording_id, relation_type) DO UPDATE SET
            source_foreign_recording_id = COALESCE(excluded.source_foreign_recording_id, RecordingRelations.source_foreign_recording_id),
            target_foreign_recording_id = COALESCE(excluded.target_foreign_recording_id, RecordingRelations.target_foreign_recording_id),
            source = excluded.source,
            confidence = excluded.confidence,
            data = excluded.data,
            updated_at = CURRENT_TIMESTAMP
    `).run(
        input.videoRecordingId,
        input.audioMatch.id,
        input.videoRecordingMbid,
        input.audioMatch.mbid,
        input.provider,
        input.audioMatch.confidence,
        JSON.stringify({
            method: input.audioMatch.method,
            evidence: input.audioMatch.evidence,
        }),
    );
}

function ensureProviderVideoRecording(input: {
    video: any;
    artistMbid: string | null;
    existingRecordingId?: number | null;
}): number | null {
    const recordingMbid = nullableText(input.video.mbid) ?? nullableText(input.video.recording_mbid);
    const artistMbid = nullableText(input.video.artist_mbid) ?? nullableText(input.video.mb_artist_mbid) ?? input.artistMbid;
    const artistMetadataId = getArtistMetadataId(artistMbid);
    const rawTitle = nullableText(input.video.title) ?? "Unknown Video";
    const groupTitle = catalogVideoDisplayTitle(rawTitle);
    const offerVariant = parseVideoVariant(rawTitle);
    const lengthMs = durationMs(input.video.duration);
    const provider = nullableText(input.video.provider);
    const providerId = nullableText(input.video.provider_id) ?? nullableText(input.video.providerId);
    const sameProviderExclude = provider && providerId
        ? { provider, providerId }
        : null;

    if (recordingMbid) {
        db.prepare(`
            INSERT OR IGNORE INTO Recordings (
                foreign_recording_id, mbid, artist_metadata_id, artist_mbid, title,
                artist_credit, length_ms, is_video, video_variant, metadata_status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'musicbrainz', CURRENT_TIMESTAMP)
        `).run(
            recordingMbid,
            recordingMbid,
            artistMetadataId,
            artistMbid,
            groupTitle,
            nullableText(input.video.artist_name),
            lengthMs,
            offerVariant,
        );

        const existingMb = db.prepare(`
            SELECT video_variant FROM Recordings WHERE foreign_recording_id = ? OR mbid = ? LIMIT 1
        `).get(recordingMbid, recordingMbid) as { video_variant: string | null } | undefined;
        const mergedMbVariant = preferredVideoVariant(existingMb?.video_variant, offerVariant);

        db.prepare(`
            UPDATE Recordings
            SET
                artist_metadata_id = COALESCE(artist_metadata_id, ?),
                artist_mbid = COALESCE(artist_mbid, ?),
                title = COALESCE(NULLIF(?, ''), title),
                artist_credit = COALESCE(artist_credit, ?),
                length_ms = COALESCE(?, length_ms),
                video_variant = ?,
                is_video = 1,
                metadata_status = 'musicbrainz',
                updated_at = CURRENT_TIMESTAMP
            WHERE foreign_recording_id = ? OR mbid = ?
        `).run(
            artistMetadataId,
            artistMbid,
            groupTitle,
            nullableText(input.video.artist_name),
            lengthMs,
            mergedMbVariant,
            recordingMbid,
            recordingMbid,
        );

        return getRecordingIdByForeignId(recordingMbid);
    }

    // Prefer a compatible canonical MusicBrainz video even when this provider
    // item was linked to a provider-only row by an older refresh. Video titles
    // need asset-aware comparison here: the shared audio-title matcher treats
    // "Official Video", "Lyric Video", and "Performance" as decoration and
    // would collapse genuinely different uploads onto one recording.
    const releaseDate = nullableText(input.video.release_date);
    const musicBrainzRecordingId = artistMbid
        ? findMusicBrainzVideoRecordingIdByTitle(
            artistMbid,
            rawTitle,
            lengthMs,
            releaseDate,
            sameProviderExclude,
        )
        : null;
    if (musicBrainzRecordingId) {
        applyCatalogVideoIdentity(musicBrainzRecordingId, {
            groupTitle,
            offerVariant,
            lengthMs,
            preserveMbTitle: true,
        });
        backfillPlaceholderVideoTitle(musicBrainzRecordingId, groupTitle);
        return musicBrainzRecordingId;
    }

    if (input.existingRecordingId) {
        const existing = db.prepare(`
            SELECT id, title, length_ms, mbid, video_variant, release_date
            FROM Recordings
            WHERE id = ? AND is_video = 1
        `).get(input.existingRecordingId) as {
            id: number;
            title: string | null;
            length_ms: number | null;
            mbid: string | null;
            video_variant: string | null;
            release_date: string | null;
        } | undefined;

        // Existing links are evidence, not an identity override. Revalidate
        // them so a refresh can split legacy overmerges (e.g. Live Capitol
        // glued onto studio Oblivion at the old 10s live↔unlabeled gate).
        const existingTitle = String(existing?.title || "");
        // Revalidate with full identity rules. Bare live↔main on an MB row
        // still requires cross-provider (do not pass allowSameProviderBareLiveTwin);
        // named venue/TV performance twins may stay attached at exact duration.
        const stillSame = Boolean(
            existing
            && sameProviderVideo(
                rawTitle,
                lengthMs,
                existingTitle,
                existing.length_ms,
                offerVariant,
                coherentStoredVideoVariant(existingTitle, existing.video_variant),
                releaseDate,
                existing.release_date,
                undefined,
                undefined,
                provider,
                recordingVideoProvider(existing.id),
                !existing.mbid,
            ),
        );
        const sameProviderCollision = Boolean(
            existing
            && sameProviderExclude
            && recordingHasOtherOfferFromProvider(
                existing.id,
                sameProviderExclude.provider,
                sameProviderExclude.providerId,
            )
            && !isExactVideoTwin({
                titleA: rawTitle,
                titleB: existingTitle,
                lengthMsA: lengthMs,
                lengthMsB: existing.length_ms,
                variantA: offerVariant,
                variantB: existing.video_variant,
                releaseDateA: releaseDate,
                releaseDateB: existing.release_date,
            }),
        );
        if (!stillSame || sameProviderCollision) {
            input.existingRecordingId = null;
        }
    }

    if (input.existingRecordingId) {
        applyCatalogVideoIdentity(input.existingRecordingId, {
            groupTitle,
            offerVariant,
            lengthMs,
            artistMetadataId,
            artistMbid,
            artistCredit: nullableText(input.video.artist_name),
            preserveMbTitle: false,
        });
        return input.existingRecordingId;
    }

    // Cross-provider dedup: another provider may already have minted a
    // provider-only recording for this same video (e.g. TIDAL and Apple Music
    // both carry "Don't Want You Back (feat. Kiesza)"). Attach to it instead of
    // creating a per-provider duplicate.
    const providerRecordingId = artistMbid
        ? findProviderOnlyVideoRecordingId(
            artistMbid,
            rawTitle,
            lengthMs,
            releaseDate,
            input.video.isrc ?? input.video.isrcs,
            sameProviderExclude,
        )
        : null;
    if (providerRecordingId) {
        applyCatalogVideoIdentity(providerRecordingId, {
            groupTitle,
            offerVariant,
            lengthMs,
            preserveMbTitle: false,
        });
        backfillPlaceholderVideoTitle(providerRecordingId, groupTitle);
        return providerRecordingId;
    }

    const result = db.prepare(`
        INSERT INTO Recordings (
            artist_metadata_id, artist_mbid, title, artist_credit, length_ms,
            release_date, is_video, video_variant, metadata_status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'provider_only', CURRENT_TIMESTAMP)
    `).run(
        artistMetadataId,
        artistMbid,
        groupTitle,
        nullableText(input.video.artist_name),
        lengthMs,
        nullableText(input.video.release_date),
        offerVariant,
    );

    return Number(result.lastInsertRowid);
}

function applyCatalogVideoIdentity(
    recordingId: number,
    input: {
        groupTitle: string;
        offerVariant: VideoVariant;
        lengthMs: number | null;
        artistMetadataId?: number | null;
        artistMbid?: string | null;
        artistCredit?: string | null;
        preserveMbTitle: boolean;
    },
): void {
    const existing = db.prepare(`
        SELECT title, video_variant, mbid FROM Recordings WHERE id = ?
    `).get(recordingId) as {
        title: string | null;
        video_variant: string | null;
        mbid: string | null;
    } | undefined;
    if (!existing) return;

    const existingTitle = String(existing.title || "");
    // Named venue/TV live twin onto a bare MB main title: adopt the fuller
    // live title with the live variant. Keeping bare title + live variant
    // breaks reverse matching (TIDAL unlabeled then fails to re-attach).
    const incomingNamedLive = input.offerVariant === "live"
        && /\bperformance\b|\blive\s+at\b|\blive\s+from\b/i.test(input.groupTitle);
    const existingBareMain = isMainVideoVariant(
        normalizeVideoVariant(existing.video_variant || parseVideoVariant(existingTitle)),
    ) && !/\bperformance\b|\blive\s+at\b|\blive\s+from\b/i.test(existingTitle);
    const adoptNamedLiveTitle = Boolean(existing.mbid && incomingNamedLive && existingBareMain);

    const mergedVariant = preferredVideoVariant(existing.video_variant, input.offerVariant);
    const preferIncomingTitle = adoptNamedLiveTitle || (!input.preserveMbTitle && !existing.mbid);
    const nextTitle = preferIncomingTitle
        ? (preferredMergedVideoTitle(existingTitle, input.groupTitle) || input.groupTitle)
        : (existingTitle.trim() || input.groupTitle);

    db.prepare(`
        UPDATE Recordings
        SET
            artist_metadata_id = COALESCE(?, artist_metadata_id),
            artist_mbid = COALESCE(?, artist_mbid),
            title = CASE
                WHEN LOWER(TRIM(COALESCE(title, ''))) IN ('', 'unknown video') THEN ?
                WHEN ? = 1 THEN ?
                ELSE title
            END,
            artist_credit = COALESCE(artist_credit, ?),
            length_ms = COALESCE(?, length_ms),
            video_variant = ?,
            is_video = 1,
            metadata_status = CASE
                WHEN foreign_recording_id IS NULL THEN 'provider_only'
                ELSE metadata_status
            END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(
        input.artistMetadataId ?? null,
        input.artistMbid ?? null,
        input.groupTitle,
        preferIncomingTitle ? 1 : 0,
        nextTitle,
        input.artistCredit ?? null,
        input.lengthMs,
        mergedVariant,
        recordingId,
    );
}

function recordingVideoProvider(recordingId: number): string | null {
    const row = db.prepare(`
        SELECT provider
        FROM ProviderItems
        WHERE entity_type = 'video'
          AND recording_id = ?
        ORDER BY updated_at DESC
        LIMIT 1
    `).get(recordingId) as { provider?: string } | undefined;
    return row?.provider ? String(row.provider) : null;
}

/**
 * Stored video_variant=live on a bare title is an inconsistent twin-promote
 * leftover. Matching should trust the title so unlabeled peers still attach.
 */
function coherentStoredVideoVariant(
    title: string,
    stored?: VideoVariant | string | null,
): VideoVariant {
    const fromTitle = parseVideoVariant(title);
    if (stored == null || !String(stored).trim()) return fromTitle;
    const fromStored = normalizeVideoVariant(stored);
    if (fromStored === "live" && fromTitle !== "live") return fromTitle;
    return fromStored;
}

/**
 * Title + duration + release date are scored together (weights).
 */
function sameProviderVideo(
    titleA: string,
    lengthMsA: number | null,
    titleB: string,
    lengthMsB: number | null,
    variantA?: VideoVariant | string | null,
    variantB?: VideoVariant | string | null,
    releaseDateA?: string | null,
    releaseDateB?: string | null,
    isrcsA?: string | string[] | null,
    isrcsB?: string | string[] | null,
    providerA?: string | null,
    providerB?: string | null,
    allowSameProviderBareLiveTwin?: boolean,
): boolean {
    return videosAreSameIdentity({
        titleA,
        titleB,
        lengthMsA,
        lengthMsB,
        variantA,
        variantB,
        releaseDateA,
        releaseDateB,
        isrcsA,
        isrcsB,
        providerA,
        providerB,
        allowSameProviderBareLiveTwin,
    });
}

/**
 * Providers rarely publish two IDs for the exact same music video. Two offers
 * from the same provider on one recording are allowed only when title+duration
 * are an exact twin (TIDAL sometimes lists the same MV twice). Otherwise keep
 * them separate — official vs live cuts often share a fuzzy title.
 */
function recordingHasOtherOfferFromProvider(
    recordingId: number,
    provider: string,
    providerId: string,
): boolean {
    const row = db.prepare(`
        SELECT 1 AS hit
        FROM ProviderItems
        WHERE entity_type = 'video'
          AND recording_id = ?
          AND provider = ?
          AND CAST(provider_id AS TEXT) != CAST(? AS TEXT)
        LIMIT 1
    `).get(recordingId, provider, providerId) as { hit?: number } | undefined;
    return Boolean(row?.hit);
}

function recordingsShareProvider(leftRecordingId: number, rightRecordingId: number): boolean {
    const row = db.prepare(`
        SELECT 1 AS hit
        FROM ProviderItems left_item
        JOIN ProviderItems right_item
          ON left_item.provider = right_item.provider
         AND left_item.entity_type = 'video'
         AND right_item.entity_type = 'video'
         AND CAST(left_item.provider_id AS TEXT) != CAST(right_item.provider_id AS TEXT)
        WHERE left_item.recording_id = ?
          AND right_item.recording_id = ?
        LIMIT 1
    `).get(leftRecordingId, rightRecordingId) as { hit?: number } | undefined;
    return Boolean(row?.hit);
}

function isExactTwinAgainstRecording(
    title: string,
    lengthMs: number | null,
    releaseDate: string | null | undefined,
    isrcs: string | string[] | null | undefined,
    recording: {
        title: string | null;
        length_ms: number | null;
        video_variant: string | null;
        release_date: string | null;
        isrcs?: string | null;
        provider_duration?: number | null;
        provider_isrc?: string | null;
    },
): boolean {
    return isExactVideoTwin({
        titleA: title,
        titleB: String(recording.title || ""),
        lengthMsA: lengthMs,
        lengthMsB: recording.length_ms ?? durationMs(recording.provider_duration),
        variantA: parseVideoVariant(title),
        variantB: recording.video_variant,
        releaseDateA: releaseDate,
        releaseDateB: recording.release_date,
        isrcsA: isrcs,
        isrcsB: recording.isrcs ?? recording.provider_isrc,
    });
}

/**
 * Find an existing provider-only video recording for the artist that describes
 * the SAME video from another provider. Highest identity score wins.
 */
function findProviderOnlyVideoRecordingId(
    artistMbid: string,
    title: string,
    lengthMs: number | null,
    releaseDate?: string | null,
    isrcs?: string | string[] | null,
    exclude?: { provider: string; providerId: string } | null,
): number | null {
    if (!videoComparableTitle(title)) {
        return null;
    }
    const rows = db.prepare(`
        SELECT
          r.id,
          r.title,
          r.length_ms,
          r.video_variant,
          r.release_date,
          r.isrcs,
          (
            SELECT pi.duration
            FROM ProviderItems pi
            WHERE pi.entity_type = 'video'
              AND pi.recording_id = r.id
              AND pi.duration IS NOT NULL
            ORDER BY pi.updated_at DESC
            LIMIT 1
          ) AS provider_duration,
          (
            SELECT pi.isrc
            FROM ProviderItems pi
            WHERE pi.entity_type = 'video'
              AND pi.recording_id = r.id
              AND pi.isrc IS NOT NULL
              AND TRIM(pi.isrc) != ''
            ORDER BY pi.updated_at DESC
            LIMIT 1
          ) AS provider_isrc,
          (
            SELECT pi.provider
            FROM ProviderItems pi
            WHERE pi.entity_type = 'video'
              AND pi.recording_id = r.id
            ORDER BY pi.updated_at DESC
            LIMIT 1
          ) AS provider
        FROM Recordings r
        WHERE r.is_video = 1 AND r.mbid IS NULL AND r.artist_mbid = ?
    `).all(artistMbid) as Array<{
        id: number;
        title: string | null;
        length_ms: number | null;
        video_variant: string | null;
        release_date: string | null;
        isrcs: string | null;
        provider_duration: number | null;
        provider_isrc: string | null;
        provider: string | null;
    }>;
    const incomingProvider = exclude?.provider ?? null;
    const offerVariant = parseVideoVariant(title);
    const scored = rows
        .filter((row) => {
            if (!exclude?.provider || !exclude.providerId) return true;
            if (!recordingHasOtherOfferFromProvider(row.id, exclude.provider, exclude.providerId)) {
                return true;
            }
            // Same provider already present: only attach when this is an exact twin.
            return isExactTwinAgainstRecording(
                title,
                lengthMs,
                releaseDate,
                isrcs,
                row,
            );
        })
        .map((row) => ({
            row,
            match: scoreVideoIdentityMatch({
                titleA: title,
                titleB: String(row.title || ""),
                lengthMsA: lengthMs,
                lengthMsB: row.length_ms ?? durationMs(row.provider_duration),
                variantA: offerVariant,
                variantB: row.video_variant,
                releaseDateA: releaseDate,
                releaseDateB: row.release_date,
                isrcsA: isrcs,
                isrcsB: row.isrcs ?? row.provider_isrc,
                providerA: incomingProvider,
                providerB: row.provider,
            }),
        }))
        .filter((entry) => entry.match.matched);
    if (scored.length === 0) {
        return null;
    }
    scored.sort((left, right) =>
        right.match.score - left.match.score
        || left.row.id - right.row.id);
    return Number(scored[0].row.id);
}

/**
 * Heal duplicate provider-only video recordings for an artist. New provider
 * items only run dedup when they have no recording yet — items that minted a
 * duplicate before dedup existed (or before the qualifier-tolerant rule) keep
 * it forever, so every video refresh sweeps the artist and merges recordings
 * that now qualify as the same video (references repoint to the kept row).
 */
function dedupeProviderOnlyVideoRecordings(artistMbid: string): number {
    const rows = db.prepare(`
        SELECT
          r.id,
          r.title,
          r.length_ms,
          r.video_variant,
          r.release_date,
          r.isrcs,
          (
            SELECT pi.duration
            FROM ProviderItems pi
            WHERE pi.entity_type = 'video'
              AND pi.recording_id = r.id
              AND pi.duration IS NOT NULL
            ORDER BY pi.updated_at DESC
            LIMIT 1
          ) AS provider_duration,
          (
            SELECT pi.isrc
            FROM ProviderItems pi
            WHERE pi.entity_type = 'video'
              AND pi.recording_id = r.id
              AND pi.isrc IS NOT NULL
              AND TRIM(pi.isrc) != ''
            ORDER BY pi.updated_at DESC
            LIMIT 1
          ) AS provider_isrc,
          (
            SELECT pi.provider
            FROM ProviderItems pi
            WHERE pi.entity_type = 'video'
              AND pi.recording_id = r.id
            ORDER BY pi.updated_at DESC
            LIMIT 1
          ) AS provider
        FROM Recordings r
        WHERE r.is_video = 1 AND r.mbid IS NULL AND r.artist_mbid = ?
        ORDER BY r.id
    `).all(artistMbid) as Array<{
        id: number;
        title: string | null;
        length_ms: number | null;
        video_variant: string | null;
        release_date: string | null;
        isrcs: string | null;
        provider_duration: number | null;
        provider_isrc: string | null;
        provider: string | null;
    }>;
    let merged = 0;
    const kept: Array<{
        id: number;
        title: string;
        length_ms: number | null;
        video_variant: string | null;
        release_date: string | null;
        isrcs: string | null;
        provider: string | null;
    }> = [];
    for (const row of rows) {
        const title = String(row.title || "");
        const lengthMs = row.length_ms ?? durationMs(row.provider_duration);
        const isrcs = row.isrcs ?? row.provider_isrc;
        const target = kept.find((k) => {
            const twin = sameProviderVideo(
                k.title,
                k.length_ms,
                title,
                lengthMs,
                k.video_variant,
                row.video_variant || parseVideoVariant(title),
                k.release_date,
                row.release_date,
                k.isrcs,
                isrcs,
                k.provider,
                row.provider,
            );
            if (!twin) return false;
            if (!recordingsShareProvider(k.id, row.id)) return true;
            return isExactTwinAgainstRecording(title, lengthMs, row.release_date, isrcs, {
                title: k.title,
                length_ms: k.length_ms,
                video_variant: k.video_variant,
                release_date: k.release_date,
                isrcs: k.isrcs,
            });
        });
        if (!target) {
            kept.push({
                id: row.id,
                title: catalogVideoDisplayTitle(title),
                length_ms: lengthMs,
                video_variant: row.video_variant || parseVideoVariant(title),
                release_date: row.release_date,
                isrcs,
                provider: row.provider,
            });
            continue;
        }
        const preferredTitle = preferredMergedVideoTitle(target.title, title);
        const mergedVariant = preferredVideoVariant(
            target.video_variant || parseVideoVariant(target.title),
            row.video_variant || parseVideoVariant(title),
        );
        target.title = preferredTitle;
        target.video_variant = mergedVariant;
        if (row.length_ms != null) target.length_ms = row.length_ms;
        if (row.release_date) target.release_date = target.release_date || row.release_date;
        db.prepare(`
            UPDATE Recordings
            SET title = ?, video_variant = ?,
                length_ms = COALESCE(?, length_ms),
                release_date = COALESCE(release_date, ?),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(preferredTitle, mergedVariant, row.length_ms, row.release_date, target.id);
        db.prepare(`UPDATE ProviderItems SET recording_id = ? WHERE recording_id = ?`).run(target.id, row.id);
        db.prepare(`UPDATE TrackFiles SET recording_id = ? WHERE recording_id = ?`).run(target.id, row.id);
        db.prepare(`UPDATE OR IGNORE RecordingRelations SET source_recording_id = ? WHERE source_recording_id = ?`).run(target.id, row.id);
        db.prepare(`UPDATE OR IGNORE RecordingRelations SET target_recording_id = ? WHERE target_recording_id = ?`).run(target.id, row.id);
        db.prepare(`DELETE FROM RecordingRelations WHERE source_recording_id = ? OR target_recording_id = ?`).run(row.id, row.id);
        db.prepare(`
            UPDATE Recordings
            SET length_ms = COALESCE(?, length_ms),
                cover_image_id = COALESCE(cover_image_id, (SELECT cover_image_id FROM Recordings WHERE id = ?)),
                cover_image_url = COALESCE(cover_image_url, (SELECT cover_image_url FROM Recordings WHERE id = ?)),
                release_date = COALESCE(release_date, (SELECT release_date FROM Recordings WHERE id = ?)),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(row.length_ms, row.id, row.id, row.id, target.id);
        db.prepare(`DELETE FROM Recordings WHERE id = ?`).run(row.id);
        merged += 1;
    }
    return merged;
}

function findMusicBrainzVideoRecordingIdByTitle(
    artistMbid: string,
    title: string,
    lengthMs: number | null,
    releaseDate?: string | null,
    exclude?: { provider: string; providerId: string } | null,
): number | null {
    if (!videoComparableTitle(title)) {
        return null;
    }
    const rows = db.prepare(`
        SELECT
          r.id,
          r.title,
          r.length_ms,
          r.video_variant,
          r.release_date,
          (
            SELECT pi.provider
            FROM ProviderItems pi
            WHERE pi.entity_type = 'video'
              AND pi.recording_id = r.id
            ORDER BY pi.updated_at DESC
            LIMIT 1
          ) AS provider
        FROM Recordings r
        WHERE r.is_video = 1 AND r.mbid IS NOT NULL AND r.artist_mbid = ?
    `).all(artistMbid) as Array<{
        id: number;
        title: string | null;
        length_ms: number | null;
        video_variant: string | null;
        release_date: string | null;
        provider: string | null;
    }>;
    const wantedClass = videoVariantClass(title);
    const incomingProvider = exclude?.provider ?? null;
    const scored = rows
        .filter((row) => {
            if (!exclude?.provider || !exclude.providerId) return true;
            if (!recordingHasOtherOfferFromProvider(row.id, exclude.provider, exclude.providerId)) {
                return true;
            }
            return isExactTwinAgainstRecording(title, lengthMs, releaseDate, null, row);
        })
        .map((row) => {
            const rowTitle = String(row.title || "");
            // Let scoreVideoIdentityMatch own variant policy (lyric pairs,
            // named venue/TV performance twins, cross-provider bare live).
            // A rigid live↔main pre-filter here blocked Apple "Live at …"
            // twins from attaching to an unlabeled MusicBrainz video that
            // TIDAL already populated (Me & Mr. Jones / Other Voices).
            //
            // If a prior twin attach left video_variant=live on a bare MB title,
            // trust the title for matching so reverse unlabeled offers still join.
            const rowVariant = coherentStoredVideoVariant(rowTitle, row.video_variant);
            const match = scoreVideoIdentityMatch({
                titleA: title,
                titleB: rowTitle,
                lengthMsA: lengthMs,
                lengthMsB: row.length_ms,
                variantA: wantedClass,
                variantB: rowVariant,
                releaseDateA: releaseDate,
                releaseDateB: row.release_date,
                providerA: incomingProvider,
                providerB: row.provider,
            });
            return match.matched ? { row, match } : null;
        })
        .filter((entry): entry is { row: typeof rows[number]; match: ReturnType<typeof scoreVideoIdentityMatch> } => entry != null);
    if (scored.length === 0) {
        return null;
    }
    scored.sort((left, right) =>
        right.match.score - left.match.score
        || left.row.id - right.row.id);
    return Number(scored[0].row.id);
}

/**
 * Re-evaluate every provider video for an artist, not only offers returned by
 * the current provider refresh. This heals legacy rows where lyric/live/audio
 * variants were attached to one canonical MusicBrainz recording, and also
 * promotes old provider-only rows when a compatible canonical recording has
 * since appeared.
 */
function repairProviderVideoRecordingAssignments(artistMbid: string): number {
    const rows = db.prepare(`
        SELECT
            provider_item.provider,
            provider_item.provider_id,
            provider_item.provider_album_id,
            provider_item.recording_mbid,
            provider_item.title,
            provider_item.duration,
            provider_item.release_date,
            provider_item.provider_url,
            provider_item.asset_id,
            provider_item.recording_id,
            COALESCE(provider_item.artist_mbid, recording.artist_mbid) AS artist_mbid
        FROM ProviderItems provider_item
        JOIN Recordings recording ON recording.id = provider_item.recording_id
        WHERE provider_item.entity_type = 'video'
          AND recording.artist_mbid = ?
        ORDER BY provider_item.provider, provider_item.provider_id
    `).all(artistMbid) as Array<{
        provider: string;
        provider_id: string;
        provider_album_id: string | null;
        recording_mbid: string | null;
        title: string | null;
        duration: number | null;
        release_date: string | null;
        provider_url: string | null;
        asset_id: string | null;
        recording_id: number;
        artist_mbid: string | null;
    }>;

    const updateProviderItem = db.prepare(`
        UPDATE ProviderItems
        SET recording_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE provider = ? AND entity_type = 'video' AND provider_id = ?
    `);
    const updateTrackFiles = db.prepare(`
        UPDATE TrackFiles
        SET recording_id = ?,
            canonical_recording_mbid = (SELECT mbid FROM Recordings WHERE id = ?)
        WHERE provider = ?
          AND (provider_entity_type = 'video' OR library_slot = 'video')
          AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
    `);
    const copyAudioRelations = db.prepare(`
        INSERT OR IGNORE INTO RecordingRelations (
            source_recording_id, target_recording_id, source_foreign_recording_id,
            target_foreign_recording_id, relation_type, source, confidence, data, updated_at
        )
        SELECT
            ?, target_recording_id,
            (SELECT mbid FROM Recordings WHERE id = ?),
            target_foreign_recording_id, relation_type, source, confidence, data,
            CURRENT_TIMESTAMP
        FROM RecordingRelations
        WHERE source_recording_id = ? AND relation_type = 'provider_video_for'
    `);
    const inheritMonitoredState = db.prepare(`
        UPDATE Recordings
        SET monitored = CASE
                WHEN monitored_lock = 1 THEN monitored
                WHEN (SELECT monitored FROM Recordings WHERE id = ?) = 1 THEN 1
                ELSE monitored
            END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `);

    let repaired = 0;
    for (const row of rows) {
        // A missing provider title cannot safely disprove the existing link.
        // Leave sparse legacy offers untouched until a provider refresh fills
        // their metadata rather than splitting them into "Unknown Video" rows.
        if (!nullableText(row.title)) {
            continue;
        }
        const targetRecordingId = ensureProviderVideoRecording({
            video: {
                provider: row.provider,
                provider_id: row.provider_id,
                album_id: row.provider_album_id,
                recording_mbid: row.recording_mbid,
                artist_mbid: row.artist_mbid,
                title: row.title,
                duration: row.duration,
                release_date: row.release_date,
                url: row.provider_url,
                image_id: row.asset_id,
            },
            artistMbid: row.artist_mbid ?? artistMbid,
            existingRecordingId: row.recording_id,
        });
        if (!targetRecordingId || targetRecordingId === row.recording_id) {
            continue;
        }

        copyAudioRelations.run(targetRecordingId, targetRecordingId, row.recording_id);
        inheritMonitoredState.run(row.recording_id, targetRecordingId);
        updateProviderItem.run(targetRecordingId, row.provider, row.provider_id);
        updateTrackFiles.run(targetRecordingId, targetRecordingId, row.provider, row.provider_id);
        repaired += 1;
    }
    return repaired;
}

/** Re-link video→audio Appears On after track matching has caught up. */
function repairProviderVideoAudioRelations(artistMbid: string): number {
    const rows = db.prepare(`
        SELECT
            provider_item.provider,
            provider_item.provider_id,
            provider_item.provider_album_id,
            provider_item.title,
            provider_item.duration,
            provider_item.recording_id,
            provider_item.recording_mbid,
            COALESCE(provider_item.artist_mbid, recording.artist_mbid) AS artist_mbid
        FROM ProviderItems provider_item
        JOIN Recordings recording ON recording.id = provider_item.recording_id
        WHERE provider_item.entity_type = 'video'
          AND recording.artist_mbid = ?
          AND NOT EXISTS (
            SELECT 1 FROM RecordingRelations rr
            WHERE rr.source_recording_id = provider_item.recording_id
              AND rr.relation_type = 'provider_video_for'
          )
    `).all(artistMbid) as Array<{
        provider: string;
        provider_id: string;
        provider_album_id: string | null;
        title: string | null;
        duration: number | null;
        recording_id: number;
        recording_mbid: string | null;
        artist_mbid: string | null;
    }>;

    let linked = 0;
    for (const row of rows) {
        if (!nullableText(row.title)) continue;
        const audioMatch = resolveProviderVideoAudioMatch({
            video: {
                title: row.title,
                duration: row.duration,
                album_id: row.provider_album_id,
                artist_mbid: row.artist_mbid,
            },
            provider: row.provider,
            artistMbid: row.artist_mbid ?? artistMbid,
        });
        if (!audioMatch) continue;
        upsertProviderVideoAudioRelation({
            videoRecordingId: row.recording_id,
            videoRecordingMbid: row.recording_mbid,
            audioMatch,
            provider: row.provider,
            videoTitle: row.title,
        });
        linked += 1;
    }
    return linked;
}

function deleteOrphanProviderOnlyVideoRecordings(artistMbid: string): number {
    const rows = db.prepare(`
        SELECT recording.id
        FROM Recordings recording
        WHERE recording.is_video = 1
          AND recording.mbid IS NULL
          AND recording.artist_mbid = ?
          AND recording.monitored_lock = 0
          AND NOT EXISTS (SELECT 1 FROM ProviderItems item WHERE item.recording_id = recording.id)
          AND NOT EXISTS (SELECT 1 FROM TrackFiles file WHERE file.recording_id = recording.id)
          AND NOT EXISTS (SELECT 1 FROM Tracks track WHERE track.recording_id = recording.id)
    `).all(artistMbid) as Array<{ id: number }>;
    for (const row of rows) {
        db.prepare(`DELETE FROM RecordingRelations WHERE source_recording_id = ? OR target_recording_id = ?`)
            .run(row.id, row.id);
        db.prepare(`DELETE FROM Recordings WHERE id = ?`).run(row.id);
    }
    return rows.length;
}

export class RefreshVideoService {
    /**
     * Fill missing video duration / release date / quality via the provider's
     * getVideo hook (YouTube Music uses yt-dlp inside that adapter). Core never
     * imports yt-dlp directly — unconfigured providers simply skip enrichment.
     */
    static async enrichVideoFactsFromProvider<T extends {
        providerId: string;
        title?: string;
        duration?: number | null;
        releaseDate?: string | null;
        quality?: string | null;
        cover?: string | null;
        url?: string | null;
    }>(
        providerId: string,
        items: T[],
        options: { limit?: number } = {},
    ): Promise<T[]> {
        if (!items.length) return items;
        const provider = (() => {
            try {
                return streamingProviderManager.getStreamingProvider(providerId);
            } catch {
                return null;
            }
        })();
        if (!provider?.getVideo) return items;

        const limitCount = Math.max(1, Math.min(options.limit ?? 40, 80));
        const pLimit = (await import("p-limit")).default;
        const limit = pLimit(4);
        const targets = items.slice(0, limitCount);

        await Promise.all(targets.map((item) => limit(async () => {
            const needsEnrichment = item.duration == null
                || !String(item.releaseDate || "").trim()
                || !String(item.quality || "").trim()
                // YouTube Music often returns bare titles; getVideo may restore
                // lyric/live cut labels via oEmbed.
                || parseVideoVariant(item.title) === "video";
            if (!needsEnrichment) return;
            try {
                const detailed: ProviderVideo = await provider.getVideo!(String(item.providerId));
                if (detailed.duration != null) item.duration = Number(detailed.duration);
                if (!item.releaseDate && detailed.releaseDate) item.releaseDate = detailed.releaseDate;
                if (!item.quality && detailed.quality) item.quality = detailed.quality;
                if (!item.cover && detailed.cover) item.cover = detailed.cover;
                if (!item.url && detailed.url) item.url = detailed.url;
                if (detailed.title) {
                    const currentVariant = parseVideoVariant(item.title);
                    const detailedVariant = parseVideoVariant(detailed.title);
                    if (
                        !item.title
                        || item.title === "Unknown Video"
                        || (currentVariant === "video" && detailedVariant !== "video")
                        || (detailedVariant !== "video"
                            && preferredVideoVariant(currentVariant, detailedVariant) === detailedVariant
                            && String(detailed.title).length > String(item.title || "").length)
                    ) {
                        item.title = detailed.title;
                    }
                }
            } catch (error) {
                console.warn(
                    `[RefreshVideoService] getVideo enrich failed for ${providerId}:${item.providerId}:`,
                    error,
                );
            }
        })));

        return items;
    }

    /**
     * Persist YouTube Music (and similar) ATV→OMV counterparts as album-scoped
     * video offers linked to the audio recording. Powers video-page "From album"
     * links, download offers, and inline video layout via provider_video_for.
     */
    static upsertAlbumTrackCounterpartVideos(input: {
        artistId: string;
        provider: string;
        albumId: string;
        releaseGroupMbid?: string | null;
        releaseMbid?: string | null;
        counterparts: Array<{
            providerId: string;
            albumId: string;
            title: string;
            duration?: number | null;
            releaseDate?: string | null;
            quality?: string | null;
            cover?: string | null;
            url?: string | null;
            audioRecordingId?: number | null;
            audioRecordingMbid?: string | null;
            audioProviderTrackId?: string | null;
            artistName?: string | null;
        }>;
    }): void {
        if (!input.counterparts.length) {
            return;
        }

        const artistMbid = getArtistMusicBrainzId(input.artistId) || nullableText(input.artistId);
        const videos = input.counterparts.map((counterpart) => ({
            provider: input.provider,
            provider_id: counterpart.providerId,
            album_id: counterpart.albumId || input.albumId,
            title: counterpart.title,
            duration: counterpart.duration ?? null,
            release_date: counterpart.releaseDate ?? null,
            image_id: counterpart.cover ?? null,
            url: counterpart.url ?? null,
            artist_mbid: artistMbid,
            artist_name: counterpart.artistName ?? null,
            release_group_mbid: input.releaseGroupMbid ?? null,
            release_mbid: input.releaseMbid ?? null,
            quality: counterpart.quality ?? null,
            _explicitAudioMatch: counterpart.audioRecordingId
                ? {
                    id: Number(counterpart.audioRecordingId),
                    mbid: nullableText(counterpart.audioRecordingMbid),
                    confidence: 0.98,
                    method: "yt-atv-omv-counterpart",
                    evidence: {
                        audioProviderTrackId: counterpart.audioProviderTrackId ?? null,
                        counterpartKind: counterpart.providerId === counterpart.audioProviderTrackId
                            ? "yt-self-omv"
                            : "yt-atv-omv",
                        albumProviderId: counterpart.albumId || input.albumId,
                    },
                } satisfies AudioRecordingVideoMatch
                : null,
        }));

        // Prefer the shared upsert path so recording creation / repair / dedupe
        // stay identical to artist-video refresh; inject explicit audio matches
        // below by temporarily overriding fuzzy matching via the prepared list.
        const selectProviderItem = db.prepare(`
            SELECT recording_id
            FROM ProviderItems
            WHERE provider = ? AND entity_type = 'video' AND provider_id = ?
            LIMIT 1
        `);
        const updateRecordingState = db.prepare(`
            UPDATE Recordings
            SET
                release_date = COALESCE(?, release_date),
                cover_image_id = COALESCE(?, cover_image_id),
                length_ms = COALESCE(?, length_ms),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);
        const upsertProviderItem = db.prepare(`
            INSERT INTO ProviderItems (
                provider, entity_type, provider_id, provider_album_id, artist_mbid, recording_mbid,
                release_group_mbid, release_mbid,
                title, quality, duration, release_date, availability,
                library_slot, recording_id, provider_url, asset_id,
                match_status, match_confidence, match_method, match_evidence, updated_at
            ) VALUES (?, 'video', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'video', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
                provider_album_id = COALESCE(excluded.provider_album_id, ProviderItems.provider_album_id),
                artist_mbid = COALESCE(excluded.artist_mbid, ProviderItems.artist_mbid),
                recording_mbid = COALESCE(excluded.recording_mbid, ProviderItems.recording_mbid),
                release_group_mbid = COALESCE(excluded.release_group_mbid, ProviderItems.release_group_mbid),
                release_mbid = COALESCE(excluded.release_mbid, ProviderItems.release_mbid),
                title = COALESCE(NULLIF(TRIM(excluded.title), ''), ProviderItems.title),
                quality = excluded.quality,
                duration = COALESCE(excluded.duration, ProviderItems.duration),
                release_date = COALESCE(excluded.release_date, ProviderItems.release_date),
                availability = excluded.availability,
                library_slot = excluded.library_slot,
                recording_id = COALESCE(excluded.recording_id, ProviderItems.recording_id),
                provider_url = COALESCE(excluded.provider_url, ProviderItems.provider_url),
                asset_id = COALESCE(excluded.asset_id, ProviderItems.asset_id),
                match_status = excluded.match_status,
                match_confidence = excluded.match_confidence,
                match_method = excluded.match_method,
                match_evidence = excluded.match_evidence,
                updated_at = CURRENT_TIMESTAMP
        `);

        db.transaction(() => {
            for (const video of videos) {
                const existingProviderItem = selectProviderItem.get(video.provider, String(video.provider_id)) as { recording_id?: number | null } | undefined;
                const recordingId = ensureProviderVideoRecording({
                    video,
                    artistMbid,
                    existingRecordingId: existingProviderItem?.recording_id ?? null,
                });
                if (recordingId) {
                    updateRecordingState.run(
                        nullableText(video.release_date),
                        nullableText(video.image_id),
                        durationMs(video.duration),
                        recordingId,
                    );
                    upsertProviderVideoAudioRelation({
                        videoRecordingId: recordingId,
                        videoRecordingMbid: null,
                        audioMatch: video._explicitAudioMatch,
                        provider: video.provider,
                        videoTitle: video.title,
                    });
                }

                upsertProviderItem.run(
                    video.provider,
                    String(video.provider_id),
                    nullableText(video.album_id),
                    artistMbid,
                    null,
                    nullableText(video.release_group_mbid),
                    nullableText(video.release_mbid),
                    video.title,
                    video.quality || null,
                    video.duration || null,
                    nullableText(video.release_date),
                    "available",
                    recordingId,
                    nullableText(video.url),
                    nullableText(video.image_id),
                    video._explicitAudioMatch ? "verified" : "probable",
                    video._explicitAudioMatch?.confidence ?? 0.7,
                    video._explicitAudioMatch?.method ?? "yt-atv-omv-counterpart",
                    JSON.stringify(video._explicitAudioMatch?.evidence ?? { counterpartKind: "yt-atv-omv" }),
                );
            }

            if (artistMbid) {
                repairProviderVideoRecordingAssignments(artistMbid);
                dedupeProviderOnlyVideoRecordings(artistMbid);
                repairProviderVideoAudioRelations(artistMbid);
                deleteOrphanProviderOnlyVideoRecordings(artistMbid);
            }
        })();
    }

    static upsertArtistVideos(artistId: string, videos: any[], options: RefreshOptions = {}): void {
        const selectProviderItem = db.prepare(`
            SELECT recording_id
            FROM ProviderItems
            WHERE provider = ? AND entity_type = 'video' AND provider_id = ?
            LIMIT 1
        `);
        const updateRecordingState = db.prepare(`
            UPDATE Recordings
            SET
                release_date = COALESCE(?, release_date),
                cover_image_id = COALESCE(?, cover_image_id),
                length_ms = COALESCE(?, length_ms),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);
        const upsertProviderItem = db.prepare(`
            INSERT INTO ProviderItems (
                provider, entity_type, provider_id, provider_album_id, artist_mbid, recording_mbid,
                title, quality, duration, release_date, availability,
                library_slot, recording_id, provider_url, asset_id,
                match_status, match_confidence, match_method, match_evidence, updated_at
            ) VALUES (?, 'video', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'video', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
                provider_album_id = COALESCE(excluded.provider_album_id, ProviderItems.provider_album_id),
                artist_mbid = COALESCE(excluded.artist_mbid, ProviderItems.artist_mbid),
                recording_mbid = COALESCE(excluded.recording_mbid, ProviderItems.recording_mbid),
                title = COALESCE(NULLIF(TRIM(excluded.title), ''), ProviderItems.title),
                quality = excluded.quality,
                duration = COALESCE(excluded.duration, ProviderItems.duration),
                release_date = COALESCE(excluded.release_date, ProviderItems.release_date),
                availability = excluded.availability,
                library_slot = excluded.library_slot,
                recording_id = COALESCE(excluded.recording_id, ProviderItems.recording_id),
                provider_url = COALESCE(excluded.provider_url, ProviderItems.provider_url),
                asset_id = COALESCE(excluded.asset_id, ProviderItems.asset_id),
                match_status = excluded.match_status,
                match_confidence = excluded.match_confidence,
                match_method = excluded.match_method,
                match_evidence = excluded.match_evidence,
                updated_at = CURRENT_TIMESTAMP
        `);

        // Resolve audio↔video matches BEFORE opening the write transaction: the
        // related-track / album-scoped candidate load is pure read/compute work,
        // and doing it inside the transaction held the single SQLite write lock
        // for the whole matching pass, starving every other writer in the app.
        const canonicalArtistMbid = getArtistMusicBrainzId(artistId);
        const preparedVideos = videos.map((video) => {
            const artistMbid = String(video.artist_mbid || video.mb_artist_mbid || "").trim() || canonicalArtistMbid;
            const provider = String(video.provider || video._provider || streamingProviderManager.getDefaultProviderId());
            return {
                video,
                artistMbid,
                provider,
                audioMatch: resolveProviderVideoAudioMatch({
                    video,
                    provider,
                    artistMbid,
                }),
            };
        });

        db.transaction(() => {
            for (const { video, artistMbid, provider, audioMatch } of preparedVideos) {
                const existingProviderItem = selectProviderItem.get(provider, String(video.provider_id)) as { recording_id?: number | null } | undefined;
                const identity = buildVideoIdentity(video);
                const recordingMbid = String(video.mbid || video.recording_mbid || "").trim() || null;
                const recordingId = ensureProviderVideoRecording({
                    video,
                    artistMbid,
                    existingRecordingId: existingProviderItem?.recording_id ?? null,
                });

                const quality = video.quality || null;
                // ProviderVideo uses `cover`; legacy payloads may still send image_id.
                const cover = nullableText(video.cover)
                    || nullableText(video.image_id)
                    || nullableText(video.imageId);

                if (recordingId) {
                    updateRecordingState.run(
                        nullableText(video.release_date),
                        cover,
                        durationMs(video.duration),
                        recordingId,
                    );
                    upsertProviderVideoAudioRelation({
                        videoRecordingId: recordingId,
                        videoRecordingMbid: recordingMbid,
                        audioMatch,
                        provider,
                        videoTitle: video.title,
                    });
                }

                upsertProviderItem.run(
                    provider,
                    String(video.provider_id),
                    nullableText(video.album_id),
                    artistMbid,
                    recordingMbid,
                    video.title,
                    quality,
                    video.duration || null,
                    video.release_date || null,
                    "available",
                    recordingId,
                    nullableText(video.url),
                    cover,
                    identity.confidence >= 0.9 ? "verified" : "probable",
                    identity.confidence,
                    identity.method,
                    JSON.stringify(identity.evidence)
                );
            }

            const sweptArtists = new Set<string>();
            const normalizedCanonicalArtistMbid = nullableText(canonicalArtistMbid);
            if (normalizedCanonicalArtistMbid) {
                sweptArtists.add(normalizedCanonicalArtistMbid);
            }
            for (const { artistMbid } of preparedVideos) {
                const normalized = nullableText(artistMbid);
                if (normalized) sweptArtists.add(normalized);
            }
            for (const normalized of sweptArtists) {
                // Dedupe before repair so cross-provider twins collapse first;
                // repair then re-homes offers onto the surviving identity.
                const merged = dedupeProviderOnlyVideoRecordings(normalized);
                if (merged > 0) {
                    console.log(`[RefreshVideoService] Merged ${merged} duplicate provider-only video recording(s) for artist ${normalized}`);
                }
                const repaired = repairProviderVideoRecordingAssignments(normalized);
                if (repaired > 0) {
                    console.log(`[RefreshVideoService] Repaired ${repaired} provider video recording assignment(s) for artist ${normalized}`);
                }
                const linked = repairProviderVideoAudioRelations(normalized);
                if (linked > 0) {
                    console.log(`[RefreshVideoService] Linked ${linked} video→audio relation(s) for artist ${normalized}`);
                }
                deleteOrphanProviderOnlyVideoRecordings(normalized);
            }
        })();
    }
}
