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
    resolveCompareVariant,
    videoVariantClass,
    type AudioRecordingCandidateRow,
    type AudioRecordingVideoMatch,
} from "./refresh-video-support.js";
import { scoreVideoIdentityMatch, videosAreSameIdentity } from "./video-match.js";
import {
    catalogVideoDisplayTitle,
    isMainVideoVariant,
    parseVideoVariant,
    preferredVideoVariant,
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
 * Never fuzzy-match artist-wide (live/studio collisions within ~5s are common).
 */
function resolveProviderVideoAudioMatch(input: {
    video: any;
    provider: string;
}): AudioRecordingVideoMatch | null {
    const relatedTrackId = nullableText(input.video.related_track_id ?? input.video.relatedTrackId);
    if (relatedTrackId) {
        const byTrack = findAudioRecordingByProviderTrack(input.provider, relatedTrackId);
        if (byTrack) {
            return byTrack;
        }
        // Related-track id present but not yet matched in catalog — do not
        // fall back to title matching (avoids wrong Appears On).
        return null;
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
        // Album association present but no in-album title/duration hit — stop.
        return null;
    }

    // No related-track or album association from the provider API — leave orphan.
    return null;
}

function upsertProviderVideoAudioRelation(input: {
    videoRecordingId: number | null;
    videoRecordingMbid: string | null;
    audioMatch: AudioRecordingVideoMatch | null;
    provider: string;
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
        ? findMusicBrainzVideoRecordingIdByTitle(artistMbid, rawTitle, lengthMs, releaseDate)
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
        const stillSame = Boolean(
            existing
            && sameProviderVideo(
                rawTitle,
                lengthMs,
                existingTitle,
                existing.length_ms,
                offerVariant,
                existing.video_variant,
                releaseDate,
                existing.release_date,
            ),
        );
        // MusicBrainz studio rows: never keep a live↔unlabeled glue even when
        // sameProviderVideo would allow it among provider-only peers.
        const existingClass = resolveCompareVariant(existingTitle, existing?.video_variant);
        const liveOntoMb = Boolean(
            existing?.mbid
            && ((offerVariant === "live" && isMainVideoVariant(existingClass))
                || (isMainVideoVariant(offerVariant) && existingClass === "live")),
        );
        if (!stillSame || liveOntoMb) {
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
        ? findProviderOnlyVideoRecordingId(artistMbid, rawTitle, lengthMs, releaseDate)
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

    const mergedVariant = preferredVideoVariant(existing.video_variant, input.offerVariant);
    const preferIncomingTitle = !input.preserveMbTitle && !existing.mbid;
    const nextTitle = preferIncomingTitle
        ? (preferredMergedVideoTitle(String(existing.title || ""), input.groupTitle) || input.groupTitle)
        : (String(existing.title || "").trim() || input.groupTitle);

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

/**
 * Same-video predicate used by DB-backed find/dedupe paths.
 * Title + duration + release date are scored together (Lidarr-style weights).
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
): number | null {
    if (!videoComparableTitle(title)) {
        return null;
    }
    const rows = db.prepare(`
        SELECT id, title, length_ms, video_variant, release_date
        FROM Recordings
        WHERE is_video = 1 AND mbid IS NULL AND artist_mbid = ?
    `).all(artistMbid) as Array<{
        id: number;
        title: string | null;
        length_ms: number | null;
        video_variant: string | null;
        release_date: string | null;
    }>;
    const offerVariant = parseVideoVariant(title);
    const scored = rows
        .map((row) => ({
            row,
            match: scoreVideoIdentityMatch({
                titleA: title,
                titleB: String(row.title || ""),
                lengthMsA: lengthMs,
                lengthMsB: row.length_ms,
                variantA: offerVariant,
                variantB: row.video_variant,
                releaseDateA: releaseDate,
                releaseDateB: row.release_date,
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
        SELECT id, title, length_ms, video_variant, release_date
        FROM Recordings
        WHERE is_video = 1 AND mbid IS NULL AND artist_mbid = ?
        ORDER BY id
    `).all(artistMbid) as Array<{
        id: number;
        title: string | null;
        length_ms: number | null;
        video_variant: string | null;
        release_date: string | null;
    }>;
    let merged = 0;
    const kept: Array<{
        id: number;
        title: string;
        length_ms: number | null;
        video_variant: string | null;
        release_date: string | null;
    }> = [];
    for (const row of rows) {
        const title = String(row.title || "");
        const target = kept.find((k) => sameProviderVideo(
            k.title,
            k.length_ms,
            title,
            row.length_ms,
            k.video_variant,
            row.video_variant || parseVideoVariant(title),
            k.release_date,
            row.release_date,
        ));
        if (!target) {
            kept.push({
                id: row.id,
                title: catalogVideoDisplayTitle(title),
                length_ms: row.length_ms,
                video_variant: row.video_variant || parseVideoVariant(title),
                release_date: row.release_date,
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
): number | null {
    if (!videoComparableTitle(title)) {
        return null;
    }
    const rows = db.prepare(`
        SELECT id, title, length_ms, video_variant, release_date
        FROM Recordings
        WHERE is_video = 1 AND mbid IS NOT NULL AND artist_mbid = ?
    `).all(artistMbid) as Array<{
        id: number;
        title: string | null;
        length_ms: number | null;
        video_variant: string | null;
        release_date: string | null;
    }>;
    const wantedClass = videoVariantClass(title);
    const scored = rows
        .map((row) => {
            const rowTitle = String(row.title || "");
            const rowClass = resolveCompareVariant(rowTitle, row.video_variant);
            if (rowClass !== wantedClass && !(isMainVideoVariant(rowClass) && isMainVideoVariant(wantedClass))) {
                const lyricPair = (wantedClass === "lyric" && isMainVideoVariant(rowClass))
                    || (isMainVideoVariant(wantedClass) && rowClass === "lyric");
                if (!lyricPair) {
                    return null;
                }
            }
            const match = scoreVideoIdentityMatch({
                titleA: title,
                titleB: rowTitle,
                lengthMsA: lengthMs,
                lengthMsB: row.length_ms,
                variantA: wantedClass,
                variantB: row.video_variant,
                releaseDateA: releaseDate,
                releaseDateB: row.release_date,
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
                || !String(item.quality || "").trim();
            if (!needsEnrichment) return;
            try {
                const detailed: ProviderVideo = await provider.getVideo!(String(item.providerId));
                if (detailed.duration != null) item.duration = Number(detailed.duration);
                if (!item.releaseDate && detailed.releaseDate) item.releaseDate = detailed.releaseDate;
                if (!item.quality && detailed.quality) item.quality = detailed.quality;
                if (!item.cover && detailed.cover) item.cover = detailed.cover;
                if (!item.url && detailed.url) item.url = detailed.url;
                if (detailed.title && (!item.title || item.title === "Unknown Video")) {
                    item.title = detailed.title;
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
                quality = COALESCE(excluded.quality, ProviderItems.quality),
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
                quality = COALESCE(excluded.quality, ProviderItems.quality),
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
                deleteOrphanProviderOnlyVideoRecordings(normalized);
            }
        })();
    }
}
