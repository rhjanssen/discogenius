import { db } from "../../database.js";
import { streamingProviderManager } from "../providers/index.js";
import type { RefreshOptions } from "./scan-types.js";
import { videoComparableTitle } from "../mediafiles/import-matching-utils.js";
import { livePerformanceTitleSql } from "./live-performance-markers.js";
import {
    buildVideoIdentity,
    durationMs,
    findRelatedAudioRecordingForVideo,
    isLivePerformanceTitle,
    isPlaceholderVideoTitle,
    nullableText,
    recordingPerformanceTitle,
    videoAudioTitlesCompatible,
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
    VIDEO_AUDIO_STUDIO_DURATION_MATCH_MS,
    VIDEO_DURATION_MATCH_MS,
    type VideoVariant,
} from "./video-variant.js";
import type { ProviderVideo } from "../providers/streaming-provider.js";
import { ProviderCatalogRepository } from "../providers/provider-catalog-repository.js";
import { ProviderMatchRepository } from "./provider-match-repository.js";
import {
    claimYouTubeWatchId,
    coalesceVideoRecordings,
    findVideoRecordingByMbid,
    findVideoRecordingByYouTubeWatchId,
    mintVideoRecording,
    youtubeWatchIdFromVideoOffer,
} from "./video-recording-catalog.js";

const VIDEO_MATCHER_VERSION = 1;
const VIDEO_MATCH_AMBIGUITY_MARGIN = 0.03;

function persistNormalizedProviderVideo(input: {
    video: any;
    provider: string;
    recordingId: number | null;
    identity: ReturnType<typeof buildVideoIdentity>;
}): void {
    const providerId = nullableText(input.video.provider_id) ?? nullableText(input.video.providerId);
    if (!providerId) {
        return;
    }
    const catalog = new ProviderCatalogRepository(db);
    const providerVideoItemId = catalog.upsertItem({
        provider: input.provider,
        entityType: "video",
        providerId,
        title: nullableText(input.video.title),
        isrc: nullableText(input.video.isrc),
        durationMs: durationMs(input.video.duration),
        releaseDate: nullableText(input.video.release_date),
        availability: nullableText(input.video.availability) ?? "available",
        availabilityReason: nullableText(input.video.availability_reason),
        checkedAt: new Date().toISOString(),
        providerUrl: nullableText(input.video.url),
        coverId: (() => {
            const cover = nullableText(input.video.cover)
                ?? nullableText(input.video.image_id)
                ?? nullableText(input.video.imageId);
            return cover && !/^https?:\/\//i.test(cover) ? cover : null;
        })(),
        artworkUrl: (() => {
            const cover = nullableText(input.video.cover)
                ?? nullableText(input.video.image_id)
                ?? nullableText(input.video.imageId);
            return cover && /^https?:\/\//i.test(cover) ? cover : null;
        })(),
        popularity: input.video.popularity == null ? null : Number(input.video.popularity),
        videoQuality: nullableText(input.video.quality),
    });

    // A bundled video's album context is a release OCCURRENCE, not a scalar on
    // the item (the provider_album_id shadow column is gone). Persist it as a
    // ProviderEditionMembers row so downstream readers resolve it the same way
    // they resolve a track's release, and so one video can legitimately occur on
    // several provider releases.
    const providerAlbumId = nullableText(input.video.album_id ?? input.video.albumId);
    if (providerAlbumId) {
        const providerEditionItemId = catalog.upsertItem({
            provider: input.provider,
            entityType: "release",
            providerId: providerAlbumId,
            availability: "unknown",
        });
        const existingMember = db.prepare(`
            SELECT id FROM ProviderEditionMembers
            WHERE provider_edition_item_id = ? AND member_item_id = ?
            LIMIT 1
        `).get(providerEditionItemId, providerVideoItemId) as { id: number } | undefined;
        if (!existingMember) {
            const nextPosition = Number((db.prepare(`
                SELECT COALESCE(MAX(position), 0) + 1 AS next
                FROM ProviderEditionMembers
                WHERE provider_edition_item_id = ? AND medium_position = 1
            `).get(providerEditionItemId) as { next: number }).next);
            db.prepare(`
                INSERT OR IGNORE INTO ProviderEditionMembers (
                    provider_edition_item_id, member_item_id, medium_position, position,
                    contextual_title
                ) VALUES (?, ?, 1, ?, ?)
            `).run(providerEditionItemId, providerVideoItemId, nextPosition, nullableText(input.video.title));
        }
    }

    if (input.recordingId == null) {
        return;
    }
    const canonical = db.prepare(`
        SELECT mbid, foreign_recording_id, youtube_video_id, metadata_status
        FROM Recordings
        WHERE id = ? AND is_video = 1
        LIMIT 1
    `).get(input.recordingId) as {
        mbid: string | null;
        foreign_recording_id: string | null;
        youtube_video_id: string | null;
        metadata_status: string | null;
    } | undefined;
    const canonicalMbid = nullableText(canonical?.mbid) ?? nullableText(canonical?.foreign_recording_id);
    const suppliedMbid = nullableText(input.video.mbid) ?? nullableText(input.video.recording_mbid);
    const youtubeWatchId = youtubeWatchIdFromVideoOffer(input.video);
    const matchMethod = youtubeWatchId && canonical?.youtube_video_id === youtubeWatchId
        ? "youtube_video_id"
        : suppliedMbid && canonicalMbid && suppliedMbid === canonicalMbid
            ? "external_id"
            : "title_artist_duration";
    new ProviderMatchRepository(db).upsertVideoMatch({
        providerVideoItemId,
        recordingId: input.recordingId,
        decision: {
            matchState: "accepted",
            decisionSource: "automatic",
            confidence: input.identity.confidence,
            method: matchMethod,
            matcherVersion: VIDEO_MATCHER_VERSION,
            evidence: {
                identityKey: input.identity.key,
                identityMethod: input.identity.method,
                canonicalRecordingMbid: canonicalMbid,
                canonicalMetadataStatus: canonical?.metadata_status ?? null,
                ...input.identity.evidence,
            },
        },
    });
    db.prepare(`
        UPDATE TrackFiles
        SET recording_id = ?,
            canonical_recording_mbid = ?
        WHERE provider = ?
          AND (provider_entity_type = 'video' OR library_slot = 'video')
          AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
    `).run(input.recordingId, canonicalMbid, input.provider, providerId);
}

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
    const row = db.prepare(`
        SELECT mbid
        FROM ArtistMetadata
        WHERE CAST(id AS TEXT) = CAST(? AS TEXT)
           OR mbid = ?
           OR foreign_artist_id = ?
        LIMIT 1
    `).get(artistId, artistId, artistId) as { mbid?: string | null } | undefined;
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

function getAcceptedProviderVideoRecordingId(provider: string, providerId: string): number | null {
    const row = db.prepare(`
        SELECT video_match.recording_id
        FROM ProviderItems item
        JOIN ProviderVideoMatches video_match
          ON video_match.provider_video_item_id = item.id
         AND video_match.match_state = 'accepted'
        JOIN Recordings recording
          ON recording.id = video_match.recording_id
         AND recording.is_video = 1
        WHERE item.provider = ?
          AND item.entity_type = 'video'
          AND item.provider_id = ?
        ORDER BY
          CASE video_match.decision_source WHEN 'manual' THEN 0 ELSE 1 END,
          video_match.confidence DESC,
          video_match.updated_at DESC
        LIMIT 1
    `).get(provider, providerId) as { recording_id?: number | null } | undefined;
    return row?.recording_id == null ? null : Number(row.recording_id);
}

function getAcceptedProviderVideoRecordingFacts(
    provider: string,
    providerId: string,
): { id: number; title: string | null; disambiguation: string | null } | null {
    const row = db.prepare(`
        SELECT
            recording.id,
            recording.title,
            recording.disambiguation
        FROM ProviderItems item
        JOIN ProviderVideoMatches video_match
          ON video_match.provider_video_item_id = item.id
         AND video_match.match_state = 'accepted'
        JOIN Recordings recording
          ON recording.id = video_match.recording_id
         AND recording.is_video = 1
        WHERE item.provider = ?
          AND item.entity_type = 'video'
          AND item.provider_id = ?
        ORDER BY
          CASE video_match.decision_source WHEN 'manual' THEN 0 ELSE 1 END,
          video_match.confidence DESC,
          video_match.updated_at DESC
        LIMIT 1
    `).get(provider, providerId) as {
        id?: number | null;
        title?: string | null;
        disambiguation?: string | null;
    } | undefined;
    if (row?.id == null) return null;
    return {
        id: Number(row.id),
        title: nullableText(row.title),
        disambiguation: nullableText(row.disambiguation),
    };
}

/**
 * YouTube Music often lists the official music video as an album TRACK using
 * the audio duration. Title+duration then misses the MB video (223s OMV vs
 * 207s album listing). If that same provider id is already an accepted track
 * of audio that has exactly one `music_video_for` video, that relation is the
 * identity — do not invent a second recording.
 */
function findCanonicalVideoViaSharedTrackOffer(
    provider: string,
    providerId: string,
): number | null {
    const rows = db.prepare(`
        SELECT DISTINCT video_rec.id AS id
        FROM ProviderItems track_item
        JOIN ProviderEditionMembers member
          ON member.member_item_id = track_item.id
        JOIN ProviderTrackMatches track_match
          ON track_match.provider_edition_member_id = member.id
         AND track_match.match_state = 'accepted'
        JOIN RecordingRelations relation
          ON relation.target_recording_id = track_match.recording_id
         AND relation.relation_type = 'music_video_for'
        JOIN Recordings video_rec
          ON video_rec.id = relation.source_recording_id
         AND video_rec.is_video = 1
        WHERE track_item.provider = ?
          AND track_item.entity_type = 'track'
          AND CAST(track_item.provider_id AS TEXT) = CAST(? AS TEXT)
    `).all(provider, providerId) as Array<{ id: number }>;
    const ids = [...new Set(rows.map((row) => Number(row.id)))];
    return ids.length === 1 ? ids[0] : null;
}

/** Audio recordings already matched to tracks on a specific provider album. */
function loadAudioRecordingCandidatesForProviderAlbum(
    provider: string,
    providerAlbumId: string,
): AudioRecordingCandidateRow[] {
    const liveAlbumSql = livePerformanceTitleSql("a.title");
    return db.prepare(`
        SELECT DISTINCT
          rec.id,
          rec.mbid,
          rec.title,
          rec.length_ms,
          rec.isrcs,
          CASE WHEN EXISTS (
            SELECT 1
            FROM Tracks t
            JOIN AlbumEditions ar
              ON ar.id = t.album_edition_id
              OR (t.release_mbid IS NOT NULL AND ar.mbid = t.release_mbid)
            JOIN Albums a ON a.mbid = ar.release_group_mbid
            WHERE (t.recording_id = rec.id OR (rec.mbid IS NOT NULL AND t.recording_mbid = rec.mbid))
              AND (
                a.secondary_types IS NULL
                OR TRIM(a.secondary_types) = ''
                OR a.secondary_types = '[]'
                OR LOWER(a.secondary_types) NOT LIKE '%"live"%'
              )
          ) THEN 1 ELSE 0 END AS has_non_live_album,
          CASE WHEN EXISTS (
            SELECT 1
            FROM Tracks t
            JOIN AlbumEditions ar
              ON ar.id = t.album_edition_id
              OR (t.release_mbid IS NOT NULL AND ar.mbid = t.release_mbid)
            JOIN Albums a ON a.mbid = ar.release_group_mbid
            WHERE (t.recording_id = rec.id OR (rec.mbid IS NOT NULL AND t.recording_mbid = rec.mbid))
              AND (
                LOWER(COALESCE(a.secondary_types, '')) LIKE '%"live"%'
                OR ${liveAlbumSql}
              )
          ) THEN 1 ELSE 0 END AS has_live_album
        FROM ProviderItems track
        JOIN ProviderEditionMembers member ON member.member_item_id = track.id
        JOIN ProviderItems release_item
          ON release_item.id = member.provider_edition_item_id
         AND release_item.entity_type = 'release'
        JOIN ProviderTrackMatches track_match
          ON track_match.provider_edition_member_id = member.id
         AND track_match.match_state = 'accepted'
        JOIN ProviderEditionMatches release_match
          ON release_match.id = track_match.provider_edition_match_id
         AND release_match.match_state = 'accepted'
        JOIN Recordings rec ON rec.id = track_match.recording_id
        WHERE release_item.provider = ?
          AND track.entity_type = 'track'
          AND CAST(release_item.provider_id AS TEXT) = CAST(? AS TEXT)
          AND rec.is_video = 0
    `).all(provider, providerAlbumId) as AudioRecordingCandidateRow[];
}

/**
 * Audio recordings sitting on the same Provider Editions this VIDEO is a member
 * of.
 *
 * A provider edition routinely mixes members: five audio tracks then two videos.
 * That membership is evidence — video member 6 and audio member 1 being on one
 * release is a real reason to think they are the same performance — but a
 * provider often reports no album id on the video payload itself, so the
 * album-keyed lookup never fires and the relation is never derived. Walking the
 * membership rows from the video's side finds the same candidates.
 *
 * Only editions that are themselves matched to a canonical Edition count. An
 * unmatched provider release is not evidence about canonical identity.
 */
function loadAudioRecordingCandidatesForProviderVideoMembership(
    provider: string,
    providerVideoId: string,
): AudioRecordingCandidateRow[] {
    const liveAlbumSql = livePerformanceTitleSql("a.title");
    return db.prepare(`
        SELECT DISTINCT
          rec.id,
          rec.mbid,
          rec.title,
          rec.length_ms,
          rec.isrcs,
          CASE WHEN EXISTS (
            SELECT 1
            FROM Tracks t
            JOIN AlbumEditions ar
              ON ar.id = t.album_edition_id
              OR (t.release_mbid IS NOT NULL AND ar.mbid = t.release_mbid)
            JOIN Albums a ON a.mbid = ar.release_group_mbid
            WHERE (t.recording_id = rec.id OR (rec.mbid IS NOT NULL AND t.recording_mbid = rec.mbid))
              AND (
                a.secondary_types IS NULL
                OR TRIM(a.secondary_types) = ''
                OR a.secondary_types = '[]'
                OR LOWER(a.secondary_types) NOT LIKE '%"live"%'
              )
          ) THEN 1 ELSE 0 END AS has_non_live_album,
          CASE WHEN EXISTS (
            SELECT 1
            FROM Tracks t
            JOIN AlbumEditions ar
              ON ar.id = t.album_edition_id
              OR (t.release_mbid IS NOT NULL AND ar.mbid = t.release_mbid)
            JOIN Albums a ON a.mbid = ar.release_group_mbid
            WHERE (t.recording_id = rec.id OR (rec.mbid IS NOT NULL AND t.recording_mbid = rec.mbid))
              AND (
                LOWER(COALESCE(a.secondary_types, '')) LIKE '%"live"%'
                OR ${liveAlbumSql}
              )
          ) THEN 1 ELSE 0 END AS has_live_album
        FROM ProviderItems video_item
        JOIN ProviderEditionMembers video_member
          ON video_member.member_item_id = video_item.id
        JOIN ProviderEditionMembers audio_member
          ON audio_member.provider_edition_item_id = video_member.provider_edition_item_id
        JOIN ProviderItems track
          ON track.id = audio_member.member_item_id
         AND track.entity_type = 'track'
        JOIN ProviderTrackMatches track_match
          ON track_match.provider_edition_member_id = audio_member.id
         AND track_match.match_state = 'accepted'
        JOIN ProviderEditionMatches release_match
          ON release_match.id = track_match.provider_edition_match_id
         AND release_match.match_state = 'accepted'
        JOIN Recordings rec ON rec.id = track_match.recording_id
        WHERE video_item.provider = ?
          AND video_item.entity_type = 'video'
          AND CAST(video_item.provider_id AS TEXT) = CAST(? AS TEXT)
          AND rec.is_video = 0
    `).all(provider, providerVideoId) as AudioRecordingCandidateRow[];
}

function findAudioRecordingByProviderTrack(
    provider: string,
    providerTrackId: string,
): AudioRecordingVideoMatch | null {
    const row = db.prepare(`
        SELECT rec.id, rec.mbid, rec.title
        FROM ProviderItems track
        JOIN ProviderEditionMembers member ON member.member_item_id = track.id
        JOIN ProviderTrackMatches track_match
          ON track_match.provider_edition_member_id = member.id
         AND track_match.match_state = 'accepted'
        JOIN ProviderEditionMatches release_match
          ON release_match.id = track_match.provider_edition_match_id
         AND release_match.match_state = 'accepted'
        JOIN Recordings rec ON rec.id = track_match.recording_id
        WHERE track.provider = ?
          AND track.entity_type = 'track'
          AND CAST(track.provider_id AS TEXT) = CAST(? AS TEXT)
          AND rec.is_video = 0
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
        const albumMatch = findRelatedAudioRecordingForVideo(input.video, albumCandidates, {
            videoVariant: parseVideoVariant(nullableText(input.video.title)),
        });
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

    // The video may itself be a member of a matched provider edition even when
    // the payload carries no album id — Apple lists videos as trailing members
    // of the album they belong to. Same evidence, read from the other side.
    const providerVideoId = nullableText(input.video.provider_id ?? input.video.providerId);
    if (providerVideoId) {
        const memberCandidates = loadAudioRecordingCandidatesForProviderVideoMembership(
            input.provider,
            providerVideoId,
        );
        const memberMatch = findRelatedAudioRecordingForVideo(input.video, memberCandidates, {
            videoVariant: parseVideoVariant(nullableText(input.video.title)),
        });
        if (memberMatch) {
            return {
                ...memberMatch,
                method: "provider-video-edition-membership",
                evidence: {
                    ...memberMatch.evidence,
                    providerVideoId,
                },
            };
        }
    }

    const artistMbid = nullableText(input.artistMbid ?? input.video.artist_mbid);
    const offerVariant = parseVideoVariant(nullableText(input.video.title));
    if (artistMbid && isMainVideoVariant(offerVariant)) {
        return findAudioRecordingByArtistTitleDuration(artistMbid, input.video);
    }

    return null;
}

function loadAudioRecordingCandidatesForArtist(artistMbid: string): AudioRecordingCandidateRow[] {
    const liveAlbumSql = livePerformanceTitleSql("a.title");
    return db.prepare(`
        SELECT
          rec.id,
          rec.mbid,
          rec.title,
          rec.length_ms,
          rec.isrcs,
          CASE WHEN EXISTS (
            SELECT 1
            FROM Tracks t
            JOIN AlbumEditions ar
              ON ar.id = t.album_edition_id
              OR (t.release_mbid IS NOT NULL AND ar.mbid = t.release_mbid)
            JOIN Albums a ON a.mbid = ar.release_group_mbid
            WHERE (t.recording_id = rec.id OR (rec.mbid IS NOT NULL AND t.recording_mbid = rec.mbid))
              AND (
                a.secondary_types IS NULL
                OR TRIM(a.secondary_types) = ''
                OR a.secondary_types = '[]'
                OR LOWER(a.secondary_types) NOT LIKE '%"live"%'
              )
          ) THEN 1 ELSE 0 END AS has_non_live_album,
          CASE WHEN EXISTS (
            SELECT 1
            FROM Tracks t
            JOIN AlbumEditions ar
              ON ar.id = t.album_edition_id
              OR (t.release_mbid IS NOT NULL AND ar.mbid = t.release_mbid)
            JOIN Albums a ON a.mbid = ar.release_group_mbid
            WHERE (t.recording_id = rec.id OR (rec.mbid IS NOT NULL AND t.recording_mbid = rec.mbid))
              AND LOWER(COALESCE(a.primary_type, '')) IN ('album', 'ep', 'single')
              AND (
                a.secondary_types IS NULL
                OR TRIM(a.secondary_types) = ''
                OR a.secondary_types = '[]'
              )
          ) THEN 1 ELSE 0 END AS has_studio_album,
          CASE WHEN EXISTS (
            SELECT 1
            FROM Tracks t
            JOIN AlbumEditions ar
              ON ar.id = t.album_edition_id
              OR (t.release_mbid IS NOT NULL AND ar.mbid = t.release_mbid)
            JOIN Albums a ON a.mbid = ar.release_group_mbid
            WHERE (t.recording_id = rec.id OR (rec.mbid IS NOT NULL AND t.recording_mbid = rec.mbid))
              AND (
                LOWER(COALESCE(a.secondary_types, '')) LIKE '%"live"%'
                OR ${liveAlbumSql}
              )
          ) THEN 1 ELSE 0 END AS has_live_album
        FROM Recordings rec
        WHERE rec.artist_mbid = ?
          AND rec.is_video = 0
          AND rec.mbid IS NOT NULL
    `).all(artistMbid) as AudioRecordingCandidateRow[];
}

/** Artist-wide title+duration only. ISRC-only links are too eager for official MVs. */
function acceptArtistWideRelatedAudioMatch(
    match: AudioRecordingVideoMatch | null,
    preferStudio: boolean,
): AudioRecordingVideoMatch | null {
    if (!match) return null;
    if (match.method === "provider-video-isrc-recording") return null;
    if (match.confidence < 0.84) return null;
    const durationDiffMs = match.evidence.durationDiffMs;
    const maxDurationDiff = preferStudio && match.evidence.hasNonLiveAlbum
        ? VIDEO_AUDIO_STUDIO_DURATION_MATCH_MS
        : VIDEO_DURATION_MATCH_MS;
    if (typeof durationDiffMs === "number" && durationDiffMs > maxDurationDiff) {
        return null;
    }
    return match;
}

function findAudioRecordingByArtistTitleDuration(
    artistMbid: string,
    video: any,
): AudioRecordingVideoMatch | null {
    const offerVariant = parseVideoVariant(nullableText(video.title));
    const preferStudio = isMainVideoVariant(offerVariant);
    const match = acceptArtistWideRelatedAudioMatch(
        findRelatedAudioRecordingForVideo(video, loadAudioRecordingCandidatesForArtist(artistMbid), {
            videoVariant: offerVariant,
            preferStudioAudio: preferStudio,
        }),
        preferStudio,
    );
    if (!match) return null;
    return {
        ...match,
        method: "provider-video-artist-title-duration",
        evidence: {
            ...match.evidence,
            artistMbid,
        },
    };
}

/**
 * After catalog hydration, link MB video recordings that still have no audio
 * relation. Same function as provider ingest (`findRelatedAudioRecordingForVideo`).
 * Skips videos that already have music_video_for or an inferred relation.
 */
function linkUnrelatedCatalogVideosToAudio(artistMbid: string): number {
    const mbid = nullableText(artistMbid);
    if (!mbid) return 0;

    const videos = db.prepare(`
        SELECT
            video.id,
            video.mbid,
            video.title,
            video.disambiguation,
            video.length_ms,
            video.video_variant,
            video.isrcs
        FROM Recordings video
        WHERE video.artist_mbid = ?
          AND video.is_video = 1
          AND NOT EXISTS (
            SELECT 1
            FROM RecordingRelations relation
            WHERE relation.source_recording_id = video.id
              AND relation.relation_type IN ('music_video_for', 'provider_video_for')
          )
    `).all(mbid) as Array<{
        id: number;
        mbid: string | null;
        title: string | null;
        disambiguation: string | null;
        length_ms: number | null;
        video_variant: string | null;
        isrcs: string | null;
    }>;
    if (videos.length === 0) return 0;

    const candidates = loadAudioRecordingCandidatesForArtist(mbid);
    let linked = 0;
    for (const video of videos) {
        const foldedTitle = recordingPerformanceTitle(video.title, video.disambiguation);
        const fromTitle = parseVideoVariant(foldedTitle);
        const videoVariant = normalizeVideoVariant(video.video_variant) === "live"
            ? "live"
            : fromTitle;
        const preferStudio = isMainVideoVariant(videoVariant);
        const lengthMs = Number(video.length_ms || 0) > 0 ? Number(video.length_ms) : null;
        const match = acceptArtistWideRelatedAudioMatch(
            findRelatedAudioRecordingForVideo(
                {
                    title: video.title,
                    disambiguation: video.disambiguation,
                    duration: lengthMs == null ? null : lengthMs / 1000,
                    isrcs: video.isrcs,
                },
                candidates,
                {
                    videoVariant,
                    preferStudioAudio: preferStudio,
                },
            ),
            preferStudio,
        );
        if (!match) continue;
        upsertProviderVideoAudioRelation({
            videoRecordingId: video.id,
            videoRecordingMbid: video.mbid,
            audioMatch: {
                ...match,
                method: "canonical-title-duration",
                evidence: {
                    ...match.evidence,
                    artistMbid: mbid,
                },
            },
            provider: "canonical",
            videoVariant,
            videoTitle: foldedTitle,
        });
        linked += 1;
    }
    return linked;
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
    const youtubeWatchId = youtubeWatchIdFromVideoOffer(input.video);
    const releaseDate = nullableText(input.video.release_date);
    const sameProviderExclude = provider && providerId
        ? { provider, providerId }
        : null;

    const finish = (recordingId: number): number => {
        applyCatalogVideoIdentity(recordingId, {
            groupTitle,
            offerVariant,
            lengthMs,
            artistMetadataId,
            artistMbid,
            artistCredit: nullableText(input.video.artist_name),
        });
        backfillPlaceholderVideoTitle(recordingId, groupTitle);
        let survivor = claimYouTubeWatchId(recordingId, youtubeWatchId);
        if (input.existingRecordingId && input.existingRecordingId !== survivor) {
            const existing = db.prepare(`
                SELECT id, mbid FROM Recordings WHERE id = ? AND is_video = 1
            `).get(input.existingRecordingId) as { id: number; mbid: string | null } | undefined;
            if (existing && !existing.mbid) {
                survivor = coalesceVideoRecordings(survivor, existing.id);
            }
        }
        return survivor;
    };

    if (youtubeWatchId) {
        const byYouTube = findVideoRecordingByYouTubeWatchId(youtubeWatchId);
        if (byYouTube != null) return finish(byYouTube);
    }

    if (recordingMbid) {
        const byMbid = findVideoRecordingByMbid(recordingMbid);
        if (byMbid != null) return finish(byMbid);
    }

    if (provider && providerId) {
        const sharedTrackVideoId = findCanonicalVideoViaSharedTrackOffer(provider, providerId);
        if (sharedTrackVideoId != null) return finish(sharedTrackVideoId);
    }

    const matchedByTitle = artistMbid
        ? findVideoRecordingIdByTitle(
            artistMbid,
            rawTitle,
            lengthMs,
            releaseDate,
            sameProviderExclude,
            input.existingRecordingId,
        )
        : null;
    if (matchedByTitle) return finish(matchedByTitle);

    if (input.existingRecordingId) {
        const manualAccepted = provider && providerId
            ? db.prepare(`
                SELECT 1 AS hit
                FROM ProviderItems item
                JOIN ProviderVideoMatches video_match
                  ON video_match.provider_video_item_id = item.id
                 AND video_match.recording_id = ?
                 AND video_match.match_state = 'accepted'
                 AND video_match.decision_source = 'manual'
                WHERE item.provider = ?
                  AND item.entity_type = 'video'
                  AND item.provider_id = ?
                LIMIT 1
            `).get(input.existingRecordingId, provider, providerId) as { hit?: number } | undefined
            : undefined;
        if (manualAccepted?.hit) {
            return finish(input.existingRecordingId);
        }
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

        const existingTitle = String(existing?.title || "");
        const stillSame = Boolean(
            existing
            && sameProviderVideo(
                rawTitle,
                lengthMs,
                existingTitle,
                existing.length_ms,
                offerVariant,
                coherentStoredVideoVariant(existingTitle, existing.video_variant, offerVariant),
                releaseDate,
                existing.release_date,
                undefined,
                undefined,
                provider,
                recordingVideoProvider(existing.id, sameProviderExclude),
                false,
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
        return finish(input.existingRecordingId);
    }

    if (!providerId && !youtubeWatchId) {
        return null;
    }
    return finish(mintVideoRecording({
        artistMbid,
        artistMetadataId,
        title: groupTitle,
        artistCredit: nullableText(input.video.artist_name),
        lengthMs,
        videoVariant: offerVariant,
        youtubeVideoId: youtubeWatchId,
        releaseDate,
        coverImageId: nullableText(input.video.cover)
            ?? nullableText(input.video.image_id)
            ?? nullableText(input.video.imageId),
    }));
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

    db.prepare(`
        UPDATE Recordings
        SET
            artist_metadata_id = COALESCE(artist_metadata_id, ?),
            artist_mbid = COALESCE(artist_mbid, ?),
            title = CASE
                WHEN LOWER(TRIM(COALESCE(title, ''))) IN ('', 'unknown video') THEN ?
                ELSE title
            END,
            artist_credit = COALESCE(artist_credit, ?),
            length_ms = COALESCE(length_ms, ?),
            video_variant = CASE
                WHEN video_variant IS NULL OR TRIM(video_variant) = '' THEN ?
                ELSE video_variant
            END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND is_video = 1
    `).run(
        input.artistMetadataId ?? null,
        input.artistMbid ?? null,
        input.groupTitle,
        input.artistCredit ?? null,
        input.lengthMs,
        input.offerVariant,
        recordingId,
    );
}

/**
 * Which provider already owns this video recording, ignoring the offer being
 * revalidated. The question the caller asks is "is this a same-provider twin or
 * a cross-provider one?", so counting the candidate itself would make every
 * offer look same-provider and suppress legitimate splits.
 */
function recordingVideoProvider(
    recordingId: number,
    exclude?: { provider: string; providerId: string } | null,
): string | null {
    const row = db.prepare(`
        SELECT pi.provider
        FROM ProviderItems pi
        JOIN ProviderVideoMatches video_match
          ON video_match.provider_video_item_id = pi.id
         AND video_match.match_state = 'accepted'
        WHERE pi.entity_type = 'video'
          AND video_match.recording_id = @recordingId
          AND (
            @excludeProvider IS NULL
            OR NOT (pi.provider = @excludeProvider AND CAST(pi.provider_id AS TEXT) = CAST(@excludeProviderId AS TEXT))
          )
        ORDER BY pi.updated_at DESC
        LIMIT 1
    `).get({
        recordingId,
        excludeProvider: exclude?.provider ?? null,
        excludeProviderId: exclude?.providerId ?? null,
    }) as { provider?: string } | undefined;
    return row?.provider ? String(row.provider) : null;
}

/**
 * Stored video_variant=live on a bare title is often an inconsistent twin-promote
 * leftover. Matching should trust the title when the *incoming* offer is also
 * unlabeled/main so studio peers can still attach. Incoming live offers must
 * keep the stored live class so Apple "(Live)" joins the MB live cut.
 */
function coherentStoredVideoVariant(
    title: string,
    stored?: VideoVariant | string | null,
    incomingVariant?: VideoVariant | string | null,
): VideoVariant {
    const fromTitle = parseVideoVariant(title);
    if (stored == null || !String(stored).trim()) return fromTitle;
    const fromStored = normalizeVideoVariant(stored);
    if (fromStored === "live" && fromTitle !== "live") {
        const incoming = incomingVariant == null || !String(incomingVariant).trim()
            ? null
            : normalizeVideoVariant(incomingVariant);
        if (incoming === "live") return fromStored;
        return fromTitle;
    }
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
 * are an exact twin within the soft duration gate (TIDAL sometimes lists the
 * same MV twice with 1s catalog rounding). Otherwise keep them separate —
 * official vs live cuts often share a fuzzy title.
 */
function recordingHasOtherOfferFromProvider(
    recordingId: number,
    provider: string,
    providerId: string,
): boolean {
    const row = db.prepare(`
        SELECT 1 AS hit
        FROM ProviderVideoMatches video_match
        JOIN ProviderItems item ON item.id = video_match.provider_video_item_id
        WHERE video_match.recording_id = ?
          AND video_match.match_state = 'accepted'
          AND item.entity_type = 'video'
          AND item.provider = ?
          AND CAST(item.provider_id AS TEXT) != CAST(? AS TEXT)
        LIMIT 1
    `).get(recordingId, provider, providerId) as { hit?: number } | undefined;
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

function findVideoRecordingIdByTitle(
    artistMbid: string,
    title: string,
    lengthMs: number | null,
    releaseDate?: string | null,
    exclude?: { provider: string; providerId: string } | null,
    skipRecordingId?: number | null,
): number | null {
    if (!videoComparableTitle(title)) {
        return null;
    }
    const skipId = skipRecordingId != null ? Number(skipRecordingId) : null;
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
            JOIN ProviderVideoMatches video_match
              ON video_match.provider_video_item_id = pi.id
             AND video_match.match_state = 'accepted'
            WHERE pi.entity_type = 'video'
              AND video_match.recording_id = r.id
            ORDER BY pi.updated_at DESC
            LIMIT 1
          ) AS provider
        FROM Recordings r
        WHERE r.is_video = 1 AND r.artist_mbid = ?
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
            if (skipId != null && Number(row.id) === skipId) return false;
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
            const rowVariant = coherentStoredVideoVariant(rowTitle, row.video_variant, wantedClass);
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
    if (
        scored.length > 1
        && scored[0].match.score - scored[1].match.score < VIDEO_MATCH_AMBIGUITY_MARGIN
    ) {
        return null;
    }
    return Number(scored[0].row.id);
}

/**
 * Re-run `ensureProviderVideoRecording` on stored matches, not only offers
 * returned by this refresh. Same identity function as ingest. Splits legacy
 * lyric/live overmerges and attaches offers once a compatible MB recording exists.
 */
function repairProviderVideoRecordingAssignments(artistMbid: string): number {
    const rows = db.prepare(`
        SELECT
            video_match.id AS match_id,
            video_match.decision_source,
            video_match.method AS match_method,
            provider_item.provider,
            provider_item.provider_id,
            release_item.provider_id AS provider_album_id,
            -- The attached recording's MBID is deliberately NOT selected. It is the
            -- attachment under review, never evidence about the provider offer, and
            -- having it in scope is what previously let it leak into both the
            -- revalidation input and the repaired match's identity.
            provider_item.title,
            provider_item.duration_ms / 1000.0 AS duration,
            provider_item.release_date,
            provider_item.provider_url,
            COALESCE(provider_item.cover_id, provider_item.artwork_url) AS asset_id,
            provider_item.video_quality,
            (
              -- Provider-native credited artist name, so the repaired identity's
              -- fingerprint fallback is a real provider fact rather than an empty
              -- artist component.
              SELECT credit.credited_name
              FROM ProviderItemCredits credit
              WHERE credit.item_id = provider_item.id
              ORDER BY CASE credit.normalized_role WHEN 'primary' THEN 0 ELSE 1 END,
                       credit.ordinal
              LIMIT 1
            ) AS artist_name,
            video_match.recording_id,
            recording.artist_mbid,
            recording.mbid AS canonical_recording_mbid
        FROM ProviderVideoMatches video_match
        JOIN ProviderItems provider_item
          ON provider_item.id = video_match.provider_video_item_id
        JOIN Recordings recording ON recording.id = video_match.recording_id
        LEFT JOIN ProviderEditionMembers release_member
          ON release_member.id = (
            -- Only an UNAMBIGUOUS membership yields a release context: one
            -- provider video may sit on several releases, and picking the
            -- lowest member id would invent one.
            SELECT candidate_member.id
            FROM ProviderEditionMembers candidate_member
            WHERE candidate_member.member_item_id = provider_item.id
              AND (
                SELECT COUNT(DISTINCT sibling.provider_edition_item_id)
                FROM ProviderEditionMembers sibling
                WHERE sibling.member_item_id = provider_item.id
              ) = 1
            LIMIT 1
          )
        LEFT JOIN ProviderItems release_item
          ON release_item.id = release_member.provider_edition_item_id
        WHERE provider_item.entity_type = 'video'
          AND video_match.match_state = 'accepted'
          AND recording.artist_mbid = ?
        ORDER BY provider_item.provider, provider_item.provider_id
    `).all(artistMbid) as Array<{
        provider: string;
        match_id: number;
        decision_source: "automatic" | "manual";
        match_method: string;
        provider_id: string;
        provider_album_id: string | null;
        title: string | null;
        duration: number | null;
        release_date: string | null;
        provider_url: string | null;
        asset_id: string | null;
        video_quality: string | null;
        artist_name: string | null;
        recording_id: number;
        artist_mbid: string | null;
        canonical_recording_mbid: string | null;
    }>;

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
    // Merging one canonical video into another carries the selections with it:
    // a library that wanted the duplicate wants the survivor. A selection the
    // survivor already has is left exactly as the user set it.
    const inheritMonitoredState = db.prepare(`
        INSERT INTO LibraryVideos (
            library_id, video_recording_id, preferred_offer_key, selection_mode,
            placement_mode, placement_selection_mode, reason, selected_at, updated_at
        )
        SELECT
            merged.library_id, @survivorRecordingId, merged.preferred_offer_key,
            merged.selection_mode, 'separated', merged.placement_selection_mode,
            merged.reason, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM LibraryVideos merged
        WHERE merged.video_recording_id = @mergedRecordingId
        ON CONFLICT(library_id, video_recording_id) DO NOTHING
    `);
    const rejectMatch = db.prepare(`
        UPDATE ProviderVideoMatches
        SET match_state = 'rejected',
            method = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `);
    const clearInventedFileIdentity = db.prepare(`
        UPDATE TrackFiles
        SET recording_id = NULL,
            canonical_recording_mbid = NULL
        WHERE provider = ?
          AND (provider_entity_type = 'video' OR library_slot = 'video')
          AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
          AND recording_id = ?
    `);

    let repaired = 0;
    for (const row of rows) {
        // A sparse offer cannot safely disprove a manual match to a real
        // MusicBrainz recording. It can never justify a provider-only target.
        if (!nullableText(row.title)) {
            if (!row.canonical_recording_mbid) {
                rejectMatch.run("invalid_noncanonical_target", row.match_id);
                clearInventedFileIdentity.run(row.provider, row.provider_id, row.recording_id);
                repaired += 1;
            }
            continue;
        }
        if (row.decision_source === "manual" && row.canonical_recording_mbid) {
            continue;
        }
        if (
            row.canonical_recording_mbid
            && (
                row.match_method === "musicbrainz-recording-url"
                || row.match_method === "external_id"
                || row.duration == null
            )
        ) {
            // Direct catalog evidence and sparse provider payloads are not
            // disproved by a later list response that lacks matching facts.
            continue;
        }
        // Deliberately do NOT pass the currently attached recording's MBID as
        // the offer's own claim. That MBID is the attachment under
        // review, and feeding it back in takes ensureProviderVideoRecording's
        // MusicBrainz short-circuit, which returns that same recording and skips
        // revalidation entirely — so an overmerged lyric/live cut could never be
        // split off. The offer is re-evaluated on its provider-native facts, with
        // the current attachment supplied only as `existingRecordingId` evidence.
        const targetRecordingId = ensureProviderVideoRecording({
            video: {
                provider: row.provider,
                provider_id: row.provider_id,
                album_id: row.provider_album_id,
                artist_mbid: row.artist_mbid,
                artist_name: row.artist_name,
                title: row.title,
                duration: row.duration,
                release_date: row.release_date,
                url: row.provider_url,
                image_id: row.asset_id,
                quality: row.video_quality,
            },
            artistMbid: row.artist_mbid ?? artistMbid,
            existingRecordingId: row.recording_id,
        });
        if (!targetRecordingId) {
            rejectMatch.run(
                row.canonical_recording_mbid
                    ? "canonical_match_no_longer_supported"
                    : "invalid_noncanonical_target",
                row.match_id,
            );
            clearInventedFileIdentity.run(row.provider, row.provider_id, row.recording_id);
            repaired += 1;
            continue;
        }
        if (targetRecordingId === row.recording_id) {
            continue;
        }

        copyAudioRelations.run(targetRecordingId, targetRecordingId, row.recording_id);
        inheritMonitoredState.run({
          mergedRecordingId: row.recording_id,
          survivorRecordingId: targetRecordingId,
        });
        updateTrackFiles.run(targetRecordingId, targetRecordingId, row.provider, row.provider_id);
        // Provider-native facts ONLY. The old attached recording's MBID is the
        // attachment this sweep just decided against, so it must not reappear here:
        // buildVideoIdentity
        // short-circuits on a recording MBID and would stamp the new accepted edge
        // with `mb-recording:<old mbid>` at 0.98 confidence — provenance claiming the
        // very recording the offer was split off from. The repaired edge is justified
        // by the offer's own URL, or by its title/artist/duration fingerprint.
        const repairedVideo = {
            provider: row.provider,
            provider_id: row.provider_id,
            album_id: row.provider_album_id,
            artist_mbid: row.artist_mbid,
            artist_name: row.artist_name,
            title: row.title,
            duration: row.duration,
            release_date: row.release_date,
            url: row.provider_url,
            image_id: row.asset_id,
            quality: row.video_quality,
        };
        const repairedIdentity = buildVideoIdentity(repairedVideo);
        persistNormalizedProviderVideo({
            video: repairedVideo,
            provider: row.provider,
            recordingId: targetRecordingId,
            identity: {
                ...repairedIdentity,
                evidence: {
                    ...repairedIdentity.evidence,
                    // Cut class parsed from the offer's own title, and the provider's
                    // own quality label — both provider-native, and the variant is what
                    // separates a lyric/live cut from the official one.
                    providerVideoVariant: parseVideoVariant(row.title),
                    providerVideoQuality: nullableText(row.video_quality),
                    repairedFromRecordingId: row.recording_id,
                },
            },
        });
        repaired += 1;
    }
    return repaired;
}

/**
 * Re-apply `findRelatedAudioRecordingForVideo` to stored provider video matches.
 * Same function as ingest, not a second matcher. Track matching and the live
 * veto can land after the first write, so a refresh replays the decision on
 * rows already in the database.
 */
function repairProviderVideoAudioRelations(artistMbid: string): number {
    const rows = db.prepare(`
        SELECT
            provider_item.provider,
            provider_item.provider_id,
            release_item.provider_id AS provider_album_id,
            provider_item.title,
            provider_item.duration_ms / 1000.0 AS duration,
            video_match.recording_id,
            recording.mbid AS recording_mbid,
            recording.artist_mbid,
            recording.title AS recording_title,
            recording.disambiguation AS recording_disambiguation,
            recording.video_variant AS video_variant
        FROM ProviderVideoMatches video_match
        JOIN ProviderItems provider_item
          ON provider_item.id = video_match.provider_video_item_id
        JOIN Recordings recording ON recording.id = video_match.recording_id
        LEFT JOIN ProviderEditionMembers release_member
          ON release_member.id = (
            -- Only an UNAMBIGUOUS membership yields a release context: one
            -- provider video may sit on several releases, and picking the
            -- lowest member id would invent one.
            SELECT candidate_member.id
            FROM ProviderEditionMembers candidate_member
            WHERE candidate_member.member_item_id = provider_item.id
              AND (
                SELECT COUNT(DISTINCT sibling.provider_edition_item_id)
                FROM ProviderEditionMembers sibling
                WHERE sibling.member_item_id = provider_item.id
              ) = 1
            LIMIT 1
          )
        LEFT JOIN ProviderItems release_item
          ON release_item.id = release_member.provider_edition_item_id
        WHERE provider_item.entity_type = 'video'
          AND video_match.match_state = 'accepted'
          AND recording.artist_mbid = ?
        ORDER BY provider_item.provider, provider_item.provider_id
    `).all(artistMbid) as Array<{
        provider: string;
        provider_id: string;
        provider_album_id: string | null;
        title: string | null;
        duration: number | null;
        recording_id: number;
        recording_mbid: string | null;
        artist_mbid: string | null;
        recording_title: string | null;
        recording_disambiguation: string | null;
        video_variant: string | null;
    }>;

    const existingRelations = db.prepare(`
        SELECT
            rr.source_recording_id AS video_id,
            rr.target_recording_id AS audio_id,
            rr.source AS relation_source,
            rr.data AS relation_data,
            audio.title AS audio_title,
            audio.mbid AS mbid
        FROM RecordingRelations rr
        JOIN Recordings audio ON audio.id = rr.target_recording_id
        WHERE rr.relation_type = 'provider_video_for'
          AND rr.source_recording_id IN (
            SELECT id FROM Recordings WHERE artist_mbid = ? AND is_video = 1
          )
    `).all(artistMbid) as Array<{
        video_id: number;
        audio_id: number;
        relation_source: string | null;
        relation_data: string | null;
        audio_title: string | null;
        mbid: string | null;
    }>;
    const relationsByVideo = new Map<number, typeof existingRelations>();
    for (const row of existingRelations) {
        const list = relationsByVideo.get(row.video_id) ?? [];
        list.push(row);
        relationsByVideo.set(row.video_id, list);
    }

    const deleteRelation = db.prepare(`
        DELETE FROM RecordingRelations
        WHERE source_recording_id = ?
          AND target_recording_id = ?
          AND relation_type = 'provider_video_for'
    `);
    const audioHasNonLiveAlbum = db.prepare(`
        SELECT 1 AS hit
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.release_mbid IS NOT NULL AND ar.mbid = t.release_mbid)
        JOIN Albums a ON a.mbid = ar.release_group_mbid
        WHERE (t.recording_id = ? OR (t.recording_mbid IS NOT NULL AND t.recording_mbid = ?))
          AND (
            a.secondary_types IS NULL
            OR TRIM(a.secondary_types) = ''
            OR a.secondary_types = '[]'
            OR LOWER(a.secondary_types) NOT LIKE '%"live"%'
          )
        LIMIT 1
    `);
    const audioHasStudioAlbum = db.prepare(`
        SELECT 1 AS hit
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.release_mbid IS NOT NULL AND ar.mbid = t.release_mbid)
        JOIN Albums a ON a.mbid = ar.release_group_mbid
        WHERE (t.recording_id = ? OR (t.recording_mbid IS NOT NULL AND t.recording_mbid = ?))
          AND LOWER(COALESCE(a.primary_type, '')) IN ('album', 'ep', 'single')
          AND (
            a.secondary_types IS NULL
            OR TRIM(a.secondary_types) = ''
            OR a.secondary_types = '[]'
          )
        LIMIT 1
    `);
    const liveAlbumTitleSql = livePerformanceTitleSql("a.title");
    const audioHasLiveAlbum = db.prepare(`
        SELECT 1 AS hit
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.release_mbid IS NOT NULL AND ar.mbid = t.release_mbid)
        JOIN Albums a ON a.mbid = ar.release_group_mbid
        WHERE (t.recording_id = ? OR (t.recording_mbid IS NOT NULL AND t.recording_mbid = ?))
          AND (
            LOWER(COALESCE(a.secondary_types, '')) LIKE '%"live"%'
            OR ${liveAlbumTitleSql}
          )
        LIMIT 1
    `);

    let changed = 0;
    const seenVideos = new Set<number>();
    for (const row of rows) {
        if (seenVideos.has(row.recording_id)) continue;
        seenVideos.add(row.recording_id);

        const videoTitle = recordingPerformanceTitle(
            nullableText(row.recording_title) || nullableText(row.title),
            row.recording_disambiguation,
        );
        if (!videoTitle) continue;
        const videoVariant = parseVideoVariant(videoTitle);
        const existing = relationsByVideo.get(row.recording_id) ?? [];

        for (const relation of existing) {
            let relationMethod = "";
            try {
                const parsed = JSON.parse(String(relation.relation_data || "{}"));
                relationMethod = String(parsed?.method || "").trim();
            } catch {
                relationMethod = "";
            }
            // Explicit provider related-track / ATV↔OMV counterpart links are
            // authoritative — do not drop them for missing studio-album rows
            // (common before Tracks are hydrated, and in unit fixtures).
            if (
                relationMethod === "provider-video-related-track"
                || relationMethod === "yt-atv-omv-counterpart"
            ) {
                continue;
            }
            const incompatibleTitle = !videoAudioTitlesCompatible(videoTitle, relation.audio_title);
            const videoIsLive = isLivePerformanceTitle(videoTitle)
                || normalizeVideoVariant(videoVariant) === "live"
                || normalizeVideoVariant(row.video_variant) === "live";
            const audioOnLiveAlbum = Boolean(
                audioHasLiveAlbum.get(relation.audio_id, relation.mbid ?? null),
            );
            const audioOnNonLiveAlbum = Boolean(
                audioHasNonLiveAlbum.get(relation.audio_id, relation.mbid ?? null),
            );
            const audioIsLiveSide = isLivePerformanceTitle(relation.audio_title)
                || (audioOnLiveAlbum && !audioOnNonLiveAlbum);
            // Live-marked video must not stick to studio-only audio.
            const liveVideoOntoStudioAudio = videoIsLive && !audioIsLiveSide;
            const mainOntoLiveTitle = isMainVideoVariant(videoVariant) && audioIsLiveSide;
            const mainOntoLiveOnlyAlbum = isMainVideoVariant(videoVariant)
                && !audioOnNonLiveAlbum;
            // Prefer Album/EP/Single studio membership over compilation-only links.
            const mainOntoWeakStudio = isMainVideoVariant(videoVariant)
                && !audioHasStudioAlbum.get(relation.audio_id, relation.mbid ?? null);
            if (
                !incompatibleTitle
                && !liveVideoOntoStudioAudio
                && !mainOntoLiveTitle
                && !mainOntoLiveOnlyAlbum
                && !mainOntoWeakStudio
            ) {
                continue;
            }
            deleteRelation.run(row.recording_id, relation.audio_id);
            changed += 1;
        }

        const stillHasRelation = Boolean(db.prepare(`
            SELECT 1 AS hit FROM RecordingRelations
            WHERE source_recording_id = ? AND relation_type = 'provider_video_for'
            LIMIT 1
        `).get(row.recording_id));
        if (stillHasRelation) continue;

        const audioMatch = resolveProviderVideoAudioMatch({
            video: {
                title: videoTitle,
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
            videoTitle,
            videoVariant,
        });
        changed += 1;
    }
    return changed;
}

function deleteOrphanProviderOnlyVideoRecordings(artistMbid: string): number {
    const rows = db.prepare(`
        SELECT recording.id
        FROM Recordings recording
        WHERE recording.is_video = 1
          AND recording.mbid IS NULL
          AND recording.youtube_video_id IS NULL
          AND recording.artist_mbid = ?
          AND NOT EXISTS (SELECT 1 FROM LibraryVideos selected_video JOIN Libraries selected_video_library ON selected_video_library.id = selected_video.library_id AND selected_video_library.enabled = 1 WHERE selected_video.video_recording_id = recording.id AND selected_video.selection_mode = 'manual')
          AND NOT EXISTS (
            SELECT 1
            FROM ProviderVideoMatches video_match
            WHERE video_match.recording_id = recording.id
              AND video_match.match_state = 'accepted'
          )
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
     * Catalog-time audio↔video links for MusicBrainz video recordings that have
     * no music_video_for and no inferred relation yet. Uses the same
     * `findRelatedAudioRecordingForVideo` policy as provider ingest.
     */
    static linkCatalogVideoAudioRelations(artistMbid: string): number {
        return linkUnrelatedCatalogVideosToAudio(artistMbid);
    }

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
     * Backfill quality on video offers that were persisted without it — notably
     * youtube-music offers ingested from MusicBrainz free-streaming URL relations
     * (upsertMusicBrainzVideoUrlOffers writes those inside a synchronous
     * transaction, so it cannot run the async provider height probe inline).
     * Reuses the provider getVideo hook and only fills NULL/empty quality; an
     * existing tag is never overwritten. Best-effort and throttled like the
     * getVideo enrichment path.
     */
    static async backfillMissingVideoOfferQuality(
        artistMbid: string,
        options: { limit?: number } = {},
    ): Promise<number> {
        const mbid = String(artistMbid || "").trim();
        if (!mbid) return 0;

        const limitCount = Math.max(1, Math.min(options.limit ?? 80, 200));
        const rows = db.prepare(`
            SELECT DISTINCT pi.provider AS provider, pi.provider_id AS providerId
            FROM ProviderItems pi
            JOIN ProviderVideoMatches video_match
              ON video_match.provider_video_item_id = pi.id
             AND video_match.match_state = 'accepted'
            JOIN Recordings r ON r.id = video_match.recording_id
            WHERE pi.entity_type = 'video'
              AND (pi.video_quality IS NULL OR TRIM(pi.video_quality) = '')
              AND r.is_video = 1
              AND r.artist_mbid = ?
              AND pi.provider_id IS NOT NULL
              AND TRIM(pi.provider_id) != ''
            LIMIT ?
        `).all(mbid, limitCount) as Array<{ provider: string; providerId: string }>;
        if (!rows.length) return 0;

        const updateQuality = db.prepare(`
            UPDATE ProviderItems
            SET video_quality = ?, updated_at = CURRENT_TIMESTAMP
            WHERE provider = ?
              AND entity_type = 'video'
              AND provider_id = ?
              AND (video_quality IS NULL OR TRIM(video_quality) = '')
        `);

        const pLimit = (await import("p-limit")).default;
        const limit = pLimit(4);
        let updated = 0;

        await Promise.all(rows.map((row) => limit(async () => {
            const provider = (() => {
                try {
                    return streamingProviderManager.getStreamingProvider(row.provider);
                } catch {
                    return null;
                }
            })();
            if (!provider?.getVideo) return;
            try {
                const detailed: ProviderVideo = await provider.getVideo(String(row.providerId));
                const quality = String(detailed?.quality || "").trim();
                if (quality) {
                    const result = updateQuality.run(quality, row.provider, String(row.providerId));
                    if (result.changes > 0) updated += 1;
                }
            } catch (error) {
                console.warn(
                    `[RefreshVideoService] quality backfill getVideo failed for ${row.provider}:${row.providerId}:`,
                    error,
                );
            }
        })));

        return updated;
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
        const selectAudioTitle = db.prepare(`
            SELECT title FROM Recordings WHERE id = ? LIMIT 1
        `);
        const videos = input.counterparts.map((counterpart) => {
            let explicitAudioMatch: AudioRecordingVideoMatch | null = null;
            if (counterpart.audioRecordingId) {
                const audio = selectAudioTitle.get(counterpart.audioRecordingId) as { title?: string | null } | undefined;
                // Enriched OMV titles (Oblivion Live…) must not keep a position-
                // matched audio link to a different song/venue (Flaws Unit 24).
                if (videoAudioTitlesCompatible(counterpart.title, audio?.title ?? null)) {
                    explicitAudioMatch = {
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
                    };
                }
            }
            return {
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
                _explicitAudioMatch: explicitAudioMatch,
            };
        });

        // Prefer the shared upsert path so identity matching and relation
        // replay stay identical to artist-video refresh; inject explicit audio
        // matches below by temporarily overriding fuzzy matching via the prepared list.
        const updateRecordingState = db.prepare(`
            UPDATE Recordings
            SET
                release_date = COALESCE(release_date, ?),
                cover_image_id = COALESCE(cover_image_id, ?),
                length_ms = COALESCE(length_ms, ?),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);
        db.transaction(() => {
            for (const video of videos) {
                const existingRecordingId = getAcceptedProviderVideoRecordingId(
                    video.provider,
                    String(video.provider_id),
                );
                const recordingId = ensureProviderVideoRecording({
                    video,
                    artistMbid,
                    existingRecordingId,
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

                persistNormalizedProviderVideo({
                    video,
                    provider: video.provider,
                    recordingId,
                    identity: buildVideoIdentity(video),
                });
            }

            if (artistMbid) {
                repairProviderVideoRecordingAssignments(artistMbid);
                repairProviderVideoAudioRelations(artistMbid);
                deleteOrphanProviderOnlyVideoRecordings(artistMbid);
            }
        })();
    }

    static upsertArtistVideos(artistId: string, videos: any[], options: RefreshOptions = {}): void {
        const updateRecordingState = db.prepare(`
            UPDATE Recordings
            SET
                release_date = COALESCE(release_date, ?),
                cover_image_id = COALESCE(cover_image_id, ?),
                length_ms = COALESCE(length_ms, ?),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);

        // Resolve audio↔video matches BEFORE opening the write transaction: the
        // related-track / album-scoped candidate load is pure read/compute work,
        // and doing it inside the transaction held the single SQLite write lock
        // for the whole matching pass, starving every other writer in the app.
        const canonicalArtistMbid = getArtistMusicBrainzId(artistId);
        const preparedVideos = videos.map((video) => {
            const artistMbid = String(video.artist_mbid || video.mb_artist_mbid || "").trim() || canonicalArtistMbid;
            const provider = String(video.provider || video._provider || streamingProviderManager.getDefaultProviderId());
            const providerId = nullableText(video.provider_id) ?? nullableText(video.providerId);
            const recording = providerId
                ? getAcceptedProviderVideoRecordingFacts(provider, providerId)
                : null;
            const videoForAudioMatch = recording
                ? {
                    ...video,
                    title: recordingPerformanceTitle(recording.title, recording.disambiguation)
                        || video.title,
                    disambiguation: recording.disambiguation,
                }
                : video;
            return {
                video,
                artistMbid,
                provider,
                audioMatch: resolveProviderVideoAudioMatch({
                    video: videoForAudioMatch,
                    provider,
                    artistMbid,
                }),
            };
        });

        db.transaction(() => {
            for (const { video, artistMbid, provider, audioMatch } of preparedVideos) {
                const identity = buildVideoIdentity(video);
                const recordingMbid = String(video.mbid || video.recording_mbid || "").trim() || null;
                const recordingId = ensureProviderVideoRecording({
                    video,
                    artistMbid,
                    existingRecordingId: getAcceptedProviderVideoRecordingId(
                        provider,
                        String(video.provider_id),
                    ),
                });

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

                persistNormalizedProviderVideo({
                    video,
                    provider,
                    recordingId,
                    identity,
                });
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
