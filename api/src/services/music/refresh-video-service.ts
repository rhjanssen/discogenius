import { db } from "../../database.js";
import { streamingProviderManager } from "../providers/index.js";
import type { RefreshOptions } from "./scan-types.js";
import { videoComparableTitle } from "../mediafiles/import-matching-utils.js";

type AudioRecordingVideoMatch = {
    id: number;
    mbid: string | null;
    confidence: number;
    method: string;
    evidence: Record<string, unknown>;
};

function normalizeVideoText(value: unknown): string {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function normalizeProviderUrl(value: unknown): string | null {
    const raw = String(value || "").trim();
    if (!raw) {
        return null;
    }

    try {
        const url = new URL(raw);
        url.hash = "";
        url.search = "";
        return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
        return raw.toLowerCase();
    }
}

function durationBucket(durationSeconds: unknown): number | null {
    const duration = Number(durationSeconds || 0);
    if (!Number.isFinite(duration) || duration <= 0) {
        return null;
    }

    return Math.round(duration / 5) * 5;
}

function buildVideoIdentity(video: any): { key: string; method: string; confidence: number; evidence: Record<string, unknown> } {
    const recordingMbid = String(video.mbid || video.recording_mbid || "").trim();
    if (recordingMbid) {
        return {
            key: `mb-recording:${recordingMbid}`,
            method: "musicbrainz-recording",
            confidence: 0.98,
            evidence: { recordingMbid },
        };
    }

    const normalizedUrl = normalizeProviderUrl(video.url);
    if (normalizedUrl) {
        return {
            key: `url:${normalizedUrl}`,
            method: "provider-url",
            confidence: 0.9,
            evidence: { url: video.url },
        };
    }

    const title = normalizeVideoText(video.title);
    const artist = normalizeVideoText(video.artist_name);
    const bucket = durationBucket(video.duration);
    return {
        key: `fingerprint:${artist}:${title}:${bucket ?? "unknown"}`,
        method: "title-artist-duration",
        confidence: bucket == null ? 0.62 : 0.78,
        evidence: {
            normalizedTitle: title,
            normalizedArtist: artist,
            durationBucket: bucket,
        },
    };
}

function isPlaceholderVideoTitle(value: unknown): boolean {
    const trimmed = String(value || "").trim();
    return !trimmed || trimmed.toLowerCase() === "unknown video";
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

function nullableText(value: unknown): string | null {
    const text = String(value ?? "").trim();
    return text.length > 0 ? text : null;
}

function durationMs(durationSeconds: unknown): number | null {
    const duration = Number(durationSeconds || 0);
    if (!Number.isFinite(duration) || duration <= 0) {
        return null;
    }
    return Math.round(duration * 1000);
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

function parseIsrcValues(value: unknown): string[] {
    const values = new Set<string>();
    const add = (candidate: unknown) => {
        const normalized = String(candidate ?? "").trim().toUpperCase();
        if (/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalized)) {
            values.add(normalized);
        }
    };

    add(value);
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) {
                parsed.forEach(add);
            }
        } catch {
            value.split(/[,\s;|]+/).forEach(add);
        }
    } else if (Array.isArray(value)) {
        value.forEach(add);
    }

    return [...values];
}

type AudioRecordingCandidateRow = {
    id: number;
    mbid?: string | null;
    title?: string | null;
    length_ms?: number | null;
    isrcs?: string | null;
};

/**
 * Load the artist's audio recordings once — the candidate set every one of the
 * artist's videos is matched against. Recordings created from MusicBrainz
 * tracklists don't carry artist_mbid, so also resolve recordings through the
 * artist's release groups (Albums / ArtistReleaseGroups → releases → tracks).
 *
 * Written as a UNION of independently index-scoped legs on purpose: the old
 * single query started FROM Recordings with LEFT JOINs and an OR across three
 * artist columns, which SQLite cannot push down — it enumerated all ~650K
 * recordings through a 5-way join PER VIDEO, pegging a worker thread for the
 * better part of an hour per big artist (and, called inside the write
 * transaction, holding the SQLite write lock the whole time).
 */
function loadAudioRecordingCandidatesForArtist(artistMbid: string): AudioRecordingCandidateRow[] {
    return db.prepare(`
        SELECT rec.id, rec.mbid, rec.title, rec.length_ms, rec.isrcs
        FROM Recordings rec
        WHERE rec.artist_mbid = ? AND COALESCE(rec.is_video, 0) = 0
        UNION
        SELECT rec.id, rec.mbid, rec.title, rec.length_ms, rec.isrcs
        FROM Albums rg
        JOIN AlbumReleases ar ON ar.release_group_mbid = rg.mbid
        JOIN Tracks t ON t.release_mbid = ar.mbid
        JOIN Recordings rec ON rec.mbid = t.recording_mbid
        WHERE rg.artist_mbid = ? AND COALESCE(rec.is_video, 0) = 0
        UNION
        SELECT rec.id, rec.mbid, rec.title, rec.length_ms, rec.isrcs
        FROM ArtistReleaseGroups scope
        JOIN AlbumReleases ar ON ar.release_group_mbid = scope.release_group_mbid
        JOIN Tracks t ON t.release_mbid = ar.mbid
        JOIN Recordings rec ON rec.mbid = t.recording_mbid
        WHERE scope.artist_mbid = ? AND COALESCE(rec.is_video, 0) = 0
    `).all(artistMbid, artistMbid, artistMbid) as AudioRecordingCandidateRow[];
}

function findRelatedAudioRecordingForVideo(
    video: any,
    candidates: AudioRecordingCandidateRow[],
): AudioRecordingVideoMatch | null {
    const videoTitle = videoComparableTitle(video.title);
    if (!videoTitle || candidates.length === 0) {
        return null;
    }

    const videoDurationMs = durationMs(video.duration);
    const videoIsrcs = parseIsrcValues(video.isrc ?? video.isrcs);
    const rows = candidates;

    let best: AudioRecordingVideoMatch | null = null;
    for (const row of rows) {
        const audioTitle = videoComparableTitle(row.title);
        if (!audioTitle) {
            continue;
        }

        const audioIsrcs = parseIsrcValues(row.isrcs);
        const isrcOverlap = videoIsrcs.some((isrc) => audioIsrcs.includes(isrc));
        const exactTitle = videoTitle === audioTitle;
        const containedTitle = videoTitle.includes(audioTitle) || audioTitle.includes(videoTitle);
        if (!isrcOverlap && !exactTitle && !containedTitle) {
            continue;
        }

        const audioDurationMs = Number(row.length_ms || 0);
        const durationDiffMs = videoDurationMs && audioDurationMs ? Math.abs(videoDurationMs - audioDurationMs) : null;
        const durationCompatible = durationDiffMs == null || durationDiffMs <= 45_000;
        if (!isrcOverlap && !durationCompatible) {
            continue;
        }

        const confidence = isrcOverlap
            ? 0.95
            : exactTitle && durationCompatible
                ? 0.84
                : containedTitle && durationCompatible
                    ? 0.72
                    : 0.62;
        if (!best || confidence > best.confidence) {
            best = {
                id: Number(row.id),
                mbid: nullableText(row.mbid),
                confidence,
                method: isrcOverlap
                    ? "provider-video-isrc-recording"
                    : exactTitle
                        ? "provider-video-title-recording"
                        : "provider-video-contained-title-recording",
                evidence: {
                    videoTitle: video.title ?? null,
                    normalizedVideoTitle: videoTitle,
                    audioTitle: row.title ?? null,
                    normalizedAudioTitle: audioTitle,
                    isrcOverlap,
                    durationDiffMs,
                },
            };
        }
    }

    return best;
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
    const title = nullableText(input.video.title) ?? "Unknown Video";
    const lengthMs = durationMs(input.video.duration);

    if (recordingMbid) {
        db.prepare(`
            INSERT OR IGNORE INTO Recordings (
                foreign_recording_id, mbid, artist_metadata_id, artist_mbid, title,
                artist_credit, length_ms, is_video, metadata_status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'musicbrainz', CURRENT_TIMESTAMP)
        `).run(
            recordingMbid,
            recordingMbid,
            artistMetadataId,
            artistMbid,
            title,
            nullableText(input.video.artist_name),
            lengthMs,
        );

        db.prepare(`
            UPDATE Recordings
            SET
                artist_metadata_id = COALESCE(artist_metadata_id, ?),
                artist_mbid = COALESCE(artist_mbid, ?),
                title = COALESCE(NULLIF(?, ''), title),
                artist_credit = COALESCE(artist_credit, ?),
                length_ms = COALESCE(?, length_ms),
                is_video = 1,
                metadata_status = 'musicbrainz',
                updated_at = CURRENT_TIMESTAMP
            WHERE foreign_recording_id = ? OR mbid = ?
        `).run(
            artistMetadataId,
            artistMbid,
            title,
            nullableText(input.video.artist_name),
            lengthMs,
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
    const musicBrainzRecordingId = artistMbid
        ? findMusicBrainzVideoRecordingIdByTitle(artistMbid, title, lengthMs)
        : null;
    if (musicBrainzRecordingId) {
        db.prepare(`
            UPDATE Recordings
            SET length_ms = COALESCE(length_ms, ?), updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(lengthMs, musicBrainzRecordingId);
        backfillPlaceholderVideoTitle(musicBrainzRecordingId, title);
        return musicBrainzRecordingId;
    }

    if (input.existingRecordingId) {
        const existing = db.prepare(`
            SELECT id, title, length_ms
            FROM Recordings
            WHERE id = ? AND is_video = 1
        `).get(input.existingRecordingId) as {
            id: number;
            title: string | null;
            length_ms: number | null;
        } | undefined;

        // Existing links are evidence, not an identity override. Revalidate
        // them so a refresh can split legacy canonical overmerges rather than
        // keeping every old provider item pinned to the wrong recording.
        // Variant class must match exactly here: live↔unlabeled merges are only
        // for discovering a peer provider-only row, never for keeping a Live cut
        // glued onto a MusicBrainz studio video.
        if (
            !existing
            || videoVariantClass(title) !== videoVariantClass(String(existing.title || ""))
            || !sameProviderVideo(title, lengthMs, String(existing.title || ""), existing.length_ms)
        ) {
            input.existingRecordingId = null;
        }
    }

    if (input.existingRecordingId) {
        db.prepare(`
            UPDATE Recordings
            SET
                artist_metadata_id = COALESCE(artist_metadata_id, ?),
                artist_mbid = COALESCE(artist_mbid, ?),
                title = CASE
                    WHEN LOWER(TRIM(COALESCE(title, ''))) IN ('', 'unknown video')
                      THEN COALESCE(NULLIF(?, ''), title)
                    WHEN mbid IS NULL THEN COALESCE(NULLIF(?, ''), title)
                    ELSE title
                END,
                artist_credit = COALESCE(artist_credit, ?),
                length_ms = COALESCE(?, length_ms),
                is_video = 1,
                metadata_status = CASE
                    WHEN foreign_recording_id IS NULL THEN 'provider_only'
                    ELSE metadata_status
                END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(
            artistMetadataId,
            artistMbid,
            title,
            title,
            nullableText(input.video.artist_name),
            lengthMs,
            input.existingRecordingId,
        );
        return input.existingRecordingId;
    }

    // Cross-provider dedup: another provider may already have minted a
    // provider-only recording for this same video (e.g. TIDAL and Apple Music
    // both carry "Don't Want You Back (feat. Kiesza)"). Attach to it instead of
    // creating a per-provider duplicate.
    const providerRecordingId = artistMbid
        ? findProviderOnlyVideoRecordingId(artistMbid, title, lengthMs)
        : null;
    if (providerRecordingId) {
        db.prepare(`
            UPDATE Recordings
            SET length_ms = COALESCE(length_ms, ?), updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(lengthMs, providerRecordingId);
        backfillPlaceholderVideoTitle(providerRecordingId, title);
        return providerRecordingId;
    }

    const result = db.prepare(`
        INSERT INTO Recordings (
            artist_metadata_id, artist_mbid, title, artist_credit, length_ms,
            release_date, is_video, metadata_status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 'provider_only', CURRENT_TIMESTAMP)
    `).run(
        artistMetadataId,
        artistMbid,
        title,
        nullableText(input.video.artist_name),
        lengthMs,
        nullableText(input.video.release_date),
    );

    return Number(result.lastInsertRowid);
}

/**
 * Find an existing MusicBrainz video recording (is_video, canonical MBID) for the
 * artist whose comparable title matches the provider video's. Comparison strips
 * "official / video / audio / feat …" decoration, so a provider upload maps onto
 * the canonical MB video instead of creating a duplicate provider-only recording.
 */
/**
 * A video's variant class distinguishes uploads that share one base title but
 * are genuinely different assets: the music video proper vs an audio-only
 * upload, a lyric video, a visualizer, or a live performance. Cross-provider
 * dedup must only merge videos in the SAME class ("Living (Official Video)"
 * never merges with "Living (Audio)").
 */
const VIDEO_VARIANT_CLASSES: Array<{ cls: string; re: RegExp }> = [
    { cls: "audio", re: /\baudio\b/i },
    { cls: "lyric", re: /\blyrics?\b/i },
    { cls: "visualizer", re: /\bvisuali[sz]er\b/i },
    { cls: "live", re: /\blive\b|\bperformance\b/i },
];

function videoVariantClass(title: string): string {
    for (const { cls, re } of VIDEO_VARIANT_CLASSES) {
        if (re.test(title)) return cls;
    }
    return "video";
}

/**
 * Title with parenthetical/bracketed qualifiers removed entirely, e.g.
 * `SAVE MY SOUL ("FROM ALL SIDES" Tour)` → `save my soul`. Used for the
 * qualifier-tolerant dedup fallback where one provider labels a variant the
 * other leaves unlabeled.
 */
function videoCoreTitle(title: string): string {
    return videoComparableTitle(String(title || "").replace(/\([^)]*\)|\[[^\]]*\]/g, " "));
}

/**
 * Whether two provider video entries describe the SAME video. Two passes:
 * 1. Exact comparable base title + same variant class (duration only rejects
 *    when both sides are known and differ by >10s — Apple often includes
 *    splash/title cards that stretch beyond a 3s TIDAL cut of the same video).
 * 2. Qualifier-tolerant fallback: identical core titles (all parenthetical
 *    qualifiers stripped) where at most one side carries a variant label and
 *    BOTH durations are known and within 10s. Catches TIDAL "SAVE MY SOUL"
 *    (256s) vs Apple `SAVE MY SOUL ("FROM ALL SIDES" Tour)` (256s) without
 *    merging "X (Audio)" with "X (Lyric Video)" or a 4-minute video with a
 *    9-minute live cut.
 */
function sameProviderVideo(
    titleA: string,
    lengthMsA: number | null,
    titleB: string,
    lengthMsB: number | null,
): boolean {
    const baseA = videoComparableTitle(titleA);
    const baseB = videoComparableTitle(titleB);
    if (!baseA || !baseB) {
        return false;
    }
    const clsA = videoVariantClass(titleA);
    const clsB = videoVariantClass(titleB);
    const durationsKnown = lengthMsA != null && lengthMsB != null;
    const durationsClose = durationsKnown && Math.abs((lengthMsA as number) - (lengthMsB as number)) <= 10000;
    if (baseA === baseB && clsA === clsB) {
        return !durationsKnown || durationsClose;
    }
    const coreA = videoCoreTitle(titleA);
    const coreB = videoCoreTitle(titleB);
    if (!coreA || coreA !== coreB) {
        return false;
    }
    if (!durationsClose) {
        return false;
    }
    if (clsA === clsB) {
        return true;
    }
    // Providers often omit the Live/Performance qualifier on one side of the
    // same concert cut (TIDAL "Good Grief" 278s vs Apple "Good Grief (… Live
    // From O2 …)" 278s). Allow that only when neither title looks like an
    // Official Music Video — otherwise "Pompeii (Official Music Video)" would
    // wrongly absorb a same-duration live performance.
    const livePair = (clsA === "live" && clsB === "video") || (clsA === "video" && clsB === "live");
    if (livePair) {
        const officialMarker = /\bofficial\b|\bmusic\s*video\b/i;
        if (officialMarker.test(titleA) || officialMarker.test(titleB)) {
            return false;
        }
        return true;
    }
    // An explicit lyric/audio/visualizer marker identifies a different asset
    // class even when its duration happens to match the ordinary video.
    return false;
}

/**
 * Find an existing provider-only video recording for the artist that describes
 * the SAME video from another provider: same comparable base title, same
 * variant class, and a compatible duration (within 10 seconds; the closest
 * duration wins when several qualify).
 */
function findProviderOnlyVideoRecordingId(artistMbid: string, title: string, lengthMs: number | null): number | null {
    if (!videoComparableTitle(title)) {
        return null;
    }
    const rows = db.prepare(`
        SELECT id, title, length_ms
        FROM Recordings
        WHERE is_video = 1 AND mbid IS NULL AND artist_mbid = ?
    `).all(artistMbid) as Array<{ id: number; title: string | null; length_ms: number | null }>;
    const candidates = rows.filter((row) =>
        sameProviderVideo(title, lengthMs, String(row.title || ""), row.length_ms));
    if (candidates.length === 0) {
        return null;
    }
    candidates.sort((left, right) =>
        Math.abs((left.length_ms ?? lengthMs ?? 0) - (lengthMs ?? 0))
        - Math.abs((right.length_ms ?? lengthMs ?? 0) - (lengthMs ?? 0)));
    return Number(candidates[0].id);
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
        SELECT id, title, length_ms
        FROM Recordings
        WHERE is_video = 1 AND mbid IS NULL AND artist_mbid = ?
        ORDER BY id
    `).all(artistMbid) as Array<{ id: number; title: string | null; length_ms: number | null }>;
    let merged = 0;
    const kept: Array<{ id: number; title: string; length_ms: number | null }> = [];
    for (const row of rows) {
        const title = String(row.title || "");
        const target = kept.find((k) => sameProviderVideo(k.title, k.length_ms, title, row.length_ms));
        if (!target) {
            kept.push({ id: row.id, title, length_ms: row.length_ms });
            continue;
        }
        db.prepare(`UPDATE ProviderItems SET recording_id = ? WHERE recording_id = ?`).run(target.id, row.id);
        db.prepare(`UPDATE TrackFiles SET recording_id = ? WHERE recording_id = ?`).run(target.id, row.id);
        db.prepare(`UPDATE OR IGNORE RecordingRelations SET source_recording_id = ? WHERE source_recording_id = ?`).run(target.id, row.id);
        db.prepare(`UPDATE OR IGNORE RecordingRelations SET target_recording_id = ? WHERE target_recording_id = ?`).run(target.id, row.id);
        db.prepare(`DELETE FROM RecordingRelations WHERE source_recording_id = ? OR target_recording_id = ?`).run(row.id, row.id);
        db.prepare(`
            UPDATE Recordings
            SET length_ms = COALESCE(length_ms, (SELECT length_ms FROM Recordings WHERE id = ?)),
                cover_image_id = COALESCE(cover_image_id, (SELECT cover_image_id FROM Recordings WHERE id = ?)),
                cover_image_url = COALESCE(cover_image_url, (SELECT cover_image_url FROM Recordings WHERE id = ?)),
                release_date = COALESCE(release_date, (SELECT release_date FROM Recordings WHERE id = ?)),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(row.id, row.id, row.id, row.id, target.id);
        db.prepare(`DELETE FROM Recordings WHERE id = ?`).run(row.id);
        merged += 1;
    }
    return merged;
}

function findMusicBrainzVideoRecordingIdByTitle(
    artistMbid: string,
    title: string,
    lengthMs: number | null,
): number | null {
    if (!videoComparableTitle(title)) {
        return null;
    }
    const rows = db.prepare(`
        SELECT id, title, length_ms
        FROM Recordings
        WHERE is_video = 1 AND mbid IS NOT NULL AND artist_mbid = ?
    `).all(artistMbid) as Array<{ id: number; title: string | null; length_ms: number | null }>;
    // MusicBrainz matching stays class-strict: a Live/Performance cut must not
    // attach to the studio Official Music Video recording even when durations
    // coincide. Cross-provider live↔unlabeled merges only apply among
    // provider-only rows via sameProviderVideo.
    const wantedClass = videoVariantClass(title);
    const candidates = rows.filter((row) => {
        const rowTitle = String(row.title || "");
        if (videoVariantClass(rowTitle) !== wantedClass) {
            return false;
        }
        return sameProviderVideo(title, lengthMs, rowTitle, row.length_ms);
    });
    if (candidates.length === 0) {
        return null;
    }
    candidates.sort((left, right) => {
        const leftDelta = lengthMs != null && left.length_ms != null
            ? Math.abs(left.length_ms - lengthMs)
            : Number.MAX_SAFE_INTEGER;
        const rightDelta = lengthMs != null && right.length_ms != null
            ? Math.abs(right.length_ms - lengthMs)
            : Number.MAX_SAFE_INTEGER;
        return leftDelta - rightDelta || left.id - right.id;
    });
    return Number(candidates[0].id);
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
            image_id: counterpart.cover ?? null,
            url: counterpart.url ?? null,
            artist_mbid: artistMbid,
            artist_name: counterpart.artistName ?? null,
            release_group_mbid: input.releaseGroupMbid ?? null,
            release_mbid: input.releaseMbid ?? null,
            quality: null,
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
                cover_image_id = COALESCE(?, cover_image_id),
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
                    updateRecordingState.run(nullableText(video.image_id), recordingId);
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
                    null,
                    video.duration || null,
                    null,
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
        // candidate load + title/ISRC comparison is pure read/compute work, and
        // doing it inside the transaction held the single SQLite write lock for
        // the whole matching pass, starving every other writer in the app.
        const candidatesByArtist = new Map<string, AudioRecordingCandidateRow[]>();
        const candidatesFor = (mbid: string | null): AudioRecordingCandidateRow[] => {
            const normalized = nullableText(mbid);
            if (!normalized) return [];
            let rows = candidatesByArtist.get(normalized);
            if (!rows) {
                rows = loadAudioRecordingCandidatesForArtist(normalized);
                candidatesByArtist.set(normalized, rows);
            }
            return rows;
        };
        const canonicalArtistMbid = getArtistMusicBrainzId(artistId);
        const preparedVideos = videos.map((video) => {
            const artistMbid = String(video.artist_mbid || video.mb_artist_mbid || "").trim() || canonicalArtistMbid;
            return {
                video,
                artistMbid,
                audioMatch: findRelatedAudioRecordingForVideo(video, candidatesFor(artistMbid)),
            };
        });

        db.transaction(() => {
            for (const { video, artistMbid, audioMatch } of preparedVideos) {
                const provider = String(video.provider || video._provider || streamingProviderManager.getDefaultProviderId());
                const existingProviderItem = selectProviderItem.get(provider, String(video.provider_id)) as { recording_id?: number | null } | undefined;
                const identity = buildVideoIdentity(video);
                const recordingMbid = String(video.mbid || video.recording_mbid || "").trim() || null;
                const recordingId = ensureProviderVideoRecording({
                    video,
                    artistMbid,
                    existingRecordingId: existingProviderItem?.recording_id ?? null,
                });

                const quality = video.quality || "MP4_1080P";
                const cover = video.image_id || null;

                if (recordingId) {
                    updateRecordingState.run(
                        nullableText(video.release_date),
                        nullableText(cover),
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
                    nullableText(video.image_id),
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
                const repaired = repairProviderVideoRecordingAssignments(normalized);
                if (repaired > 0) {
                    console.log(`[RefreshVideoService] Repaired ${repaired} provider video recording assignment(s) for artist ${normalized}`);
                }
                const merged = dedupeProviderOnlyVideoRecordings(normalized);
                if (merged > 0) {
                    console.log(`[RefreshVideoService] Merged ${merged} duplicate provider-only video recording(s) for artist ${normalized}`);
                }
                deleteOrphanProviderOnlyVideoRecordings(normalized);
            }
        })();
    }
}
