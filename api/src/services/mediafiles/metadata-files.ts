import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { db } from '../../database.js';
import { streamingProviderManager } from "../providers/index.js";
import { buildStreamingMediaUrl } from "../download/download-routing.js";
import { getLyricsForProviderMedia } from "../extras/lyrics/lyric-service.js";
import {
    classifyLyricsForSidecar,
    lyricSidecarPath,
} from "../extras/lyrics/lyric-sidecar.js";
import { resolveFfmpegBinary } from "./audioUtils.js";
import {
    getMediaCoverFilePathFromUrl,
    normalizeArtworkUrl,
    parseJsonObject,
    resolveMediaCoverProxyUrl,
    syncCachedMediaCoverToFile,
    type MediaCoverSidecarSyncResult,
} from "../metadata/media-cover-service.js";

type AlbumProviderItemRow = {
    provider: string | null;
    provider_id: string;
    artist_mbid: string | null;
    release_group_mbid: string | null;
    release_mbid: string | null;
    provider_title: string | null;
    provider_version: string | null;
    provider_quality: string | null;
    provider_explicit: number | null;
    provider_duration: number | null;
    provider_release_date: string | null;
    provider_upc: string | null;
    provider_asset_id: string | null;

    release_group_title: string | null;
    primary_type: string | null;
    first_release_date: string | null;
    release_group_cover_image_id: string | null;
    release_group_vibrant_color: string | null;
    release_group_video_cover: string | null;
    release_group_popularity: number | null;
    release_group_review_text: string | null;
    release_group_review_source: string | null;
    release_group_review_last_updated: string | null;
    release_group_overview: string | null;
    release_group_images: string | null;
    release_title: string | null;
    release_date: string | null;
    barcode: string | null;
    release_copyright: string | null;
    media_count: number | null;
    track_count: number | null;
    artist_id: string | null;
    artist_name: string | null;
};

type VideoProviderItemRow = {
    provider: string | null;
    provider_id: string;
    artist_mbid: string | null;
    release_group_mbid: string | null;
    release_mbid: string | null;
    recording_mbid: string | null;
    album_id: string | null;
    provider_title: string | null;
    provider_quality: string | null;
    provider_explicit: number | null;
    provider_duration: number | null;
    provider_release_date: string | null;
    provider_asset_id: string | null;

    recording_title: string | null;
    recording_release_date: string | null;
    recording_cover_image_id: string | null;
    recording_artist_credit: string | null;
    recording_credits: string | null;
    recording_length_ms: number | null;
    artist_id: string | null;
    artist_name: string | null;
    album_title: string | null;
    album_mbid: string | null;
};

/**
 * Clean provider text by removing TIDAL-style [wimpLink] tags and normalizing line breaks.
 */
export function cleanProviderText(text: string): string {
    const normalized = text
        .replace(/\r\n/g, "\n")
        .replace(/<br\s*\/?>/gi, "\n");

    return normalized
        .replace(/\[wimpLink\b[^\]]*\]([\s\S]*?)\[\/wimpLink\]/gi, '$1')
        .replace(/\[wimpLink\b[^\]]*\]/gi, '')
        .replace(/\[\/wimpLink\]/gi, '')
        .trim();
}

function escapeXml(value: unknown): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function xmlElement(name: string, value: unknown): string | null {
    const text = String(value ?? "").trim();
    return text ? `  <${name}>${escapeXml(text)}</${name}>` : null;
}

/** Parse Albums.genres / AlbumEditions.label / Recordings.isrcs JSON arrays. */
function parseJsonStringList(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((item) => (typeof item === "string" ? item.trim() : ""))
            .filter((item) => item.length > 0);
    } catch {
        return [];
    }
}

function xmlUniqueId(type: string, value: unknown, isDefault = false): string | null {
    const text = String(value ?? "").trim();
    if (!text) return null;
    return `  <uniqueid type="${escapeXml(type)}" default="${isDefault ? "true" : "false"}">${escapeXml(text)}</uniqueid>`;
}

function writeXmlFile(outputPath: string, xml: string): boolean {
    if (fs.existsSync(outputPath)) {
        try {
            const existing = fs.readFileSync(outputPath, 'utf-8');
            if (existing.trim() === xml.trim()) {
                return false;
            }
        } catch {
            /* best effort */
        }
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, xml, 'utf-8');
    return true;
}

function warnNfoFallback(entity: string, id: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ [METADATA] Falling back to local ${entity} metadata for ${id}: ${message}`);
}

function textOrNull(...values: unknown[]): string | null {
    for (const value of values) {
        const text = String(value ?? "").trim();
        if (text) return text;
    }
    return null;
}

function loadAlbumProviderItem(albumId: string, provider: string): AlbumProviderItemRow | null {
    return (db.prepare(`
        SELECT
            pi.provider,
            pi.provider_id,
            artist_metadata.mbid AS artist_mbid,
            rg.mbid AS release_group_mbid,
            release.mbid AS release_mbid,
            pi.title AS provider_title,
            pi.version AS provider_version,
            COALESCE(variant.provider_quality_label, variant.quality_class) AS provider_quality,
            pi.explicit AS provider_explicit,
            pi.duration_ms / 1000.0 AS provider_duration,
            pi.release_date AS provider_release_date,
            pi.upc AS provider_upc,
            pi.cover_id AS provider_asset_id,

            rg.title AS release_group_title,
            rg.primary_type AS primary_type,
            rg.first_release_date AS first_release_date,
            rg.cover_image_id AS release_group_cover_image_id,
            rg.vibrant_color AS release_group_vibrant_color,
            rg.video_cover AS release_group_video_cover,
            rg.popularity AS release_group_popularity,
            rg.review_text AS release_group_review_text,
            rg.review_source AS release_group_review_source,
            rg.review_last_updated AS release_group_review_last_updated,
            rg.overview AS release_group_overview,
            rg.images AS release_group_images,
            release.title AS release_title,
            release.date AS release_date,
            release.barcode AS barcode,
            release.copyright AS release_copyright,
            release.media_count AS media_count,
            release.track_count AS track_count,
            artist.id AS artist_id,
            COALESCE(artist.name, artist_metadata.name) AS artist_name
        FROM ProviderItems pi
        JOIN ProviderEditionMatches release_match
          ON release_match.provider_edition_item_id = pi.id
         AND release_match.match_state = 'accepted'
        JOIN AlbumEditions release ON release.id = release_match.edition_id
        JOIN Albums rg ON rg.id = release.release_group_id
        LEFT JOIN ArtistMetadata artist_metadata ON artist_metadata.id = rg.artist_metadata_id
        LEFT JOIN ArtistMetadata artist ON artist.mbid = artist_metadata.mbid
        LEFT JOIN ProviderItemAudioVariants variant
          ON variant.id = (
            SELECT candidate.id
            FROM ProviderItemAudioVariants candidate
            WHERE candidate.provider_item_id = pi.id
            ORDER BY
              CASE candidate.availability WHEN 'available' THEN 0 ELSE 1 END,
              candidate.id
            LIMIT 1
          )
        WHERE pi.entity_type = 'release'
          AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
          AND pi.provider = ?
        ORDER BY pi.updated_at DESC
        LIMIT 1
    `).get(albumId, provider) as AlbumProviderItemRow | undefined) ?? null;
}

function loadVideoProviderItem(videoId: string, provider: string): VideoProviderItemRow | null {
    return (db.prepare(`
        SELECT
            pi.provider,
            pi.provider_id,
            artist_metadata.mbid AS artist_mbid,
            album.mbid AS release_group_mbid,
            release.mbid AS release_mbid,
            recording.mbid AS recording_mbid,
            CAST(album.id AS TEXT) AS album_id,
            pi.title AS provider_title,
            pi.video_quality AS provider_quality,
            pi.explicit AS provider_explicit,
            pi.duration_ms / 1000.0 AS provider_duration,
            pi.release_date AS provider_release_date,
            pi.cover_id AS provider_asset_id,

            recording.title AS recording_title,
            recording.release_date AS recording_release_date,
            recording.cover_image_id AS recording_cover_image_id,
            recording.artist_credit AS recording_artist_credit,
            recording.credits AS recording_credits,
            recording.length_ms AS recording_length_ms,
            artist.id AS artist_id,
            COALESCE(artist.name, artist_metadata.name) AS artist_name,
            album.title AS album_title,
            release.mbid AS album_mbid
        FROM ProviderItems pi
        JOIN ProviderVideoMatches video_match
          ON video_match.provider_video_item_id = pi.id
         AND video_match.match_state = 'accepted'
        JOIN Recordings recording ON recording.id = video_match.recording_id
        LEFT JOIN ArtistMetadata artist_metadata
          ON artist_metadata.id = recording.artist_metadata_id
          OR (recording.artist_metadata_id IS NULL AND artist_metadata.mbid = recording.artist_mbid)
        LEFT JOIN ArtistMetadata artist ON artist.mbid = artist_metadata.mbid
        LEFT JOIN RecordingRelations relation
          ON relation.source_recording_id = recording.id
         AND relation.relation_type IN ('provider_video_for', 'music_video_for')
        LEFT JOIN Tracks related_track ON related_track.recording_id = relation.target_recording_id
        LEFT JOIN AlbumEditions release ON release.id = related_track.album_edition_id
        LEFT JOIN Albums album ON album.id = release.release_group_id
        WHERE pi.entity_type = 'video'
          AND pi.provider = ?
          AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
        ORDER BY pi.updated_at DESC
        LIMIT 1
    `).get(provider, videoId) as VideoProviderItemRow | undefined) ?? null;
}

function parseRecordingCredits(value: unknown): Array<{ id?: string; name?: string; join_phrase?: string }> {
    const parsed = parseJsonObject(value);
    const credits = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.["artist-credit"])
            ? parsed["artist-credit"]
            : Array.isArray(parsed?.artistCredits)
                ? parsed.artistCredits
                : Array.isArray(parsed?.artist_credits)
                    ? parsed.artist_credits
                    : [];

    return credits
        .filter((credit): credit is Record<string, any> => Boolean(credit && typeof credit === "object"))
        .map((credit) => ({
            id: textOrNull(credit.id, credit.artist?.id) || undefined,
            name: textOrNull(credit.name, credit.artist?.name) || undefined,
            join_phrase: textOrNull(credit.join_phrase, credit.joinPhrase, credit.joinphrase) || "",
        }))
        .filter((credit) => Boolean(credit.name));
}

async function getVideoForNfo(videoId: string, providerId: string) {
    const provider = streamingProviderManager.getStreamingProvider(providerId);
    try {
        const video = await provider.getVideo?.(videoId);
        if (!video) {
            throw new Error(`provider video ${videoId} not found`);
        }
        return video;
    } catch (error) {
        warnNfoFallback("video", videoId, error);
        const row = loadVideoProviderItem(videoId, provider.id);

        if (!row) throw error;
        const artistId = row.artist_id ? String(row.artist_id) : null;
        const artistName = row.artist_name || row.recording_artist_credit || null;
        const artists = parseRecordingCredits(row.recording_credits);
        return {
            id: String(row.provider_id),
            title: row.recording_title || row.provider_title || "Unknown Video",
            artist_id: artistId,
            artist_name: artistName,
            artists: artists.length > 0 ? artists : (artistId && artistName ? [{ id: artistId, name: artistName }] : []),
            album_id: row.album_id ? String(row.album_id) : null,
            duration: row.provider_duration || (row.recording_length_ms ? Math.round(row.recording_length_ms / 1000) : 0),
            release_date: row.recording_release_date || row.provider_release_date || null,
            image_id: row.recording_cover_image_id || row.provider_asset_id || null,
            vibrant_color: null,
            quality: row.provider_quality || null,
            explicit: Boolean(row.provider_explicit ),
            popularity: 0,
            url: (() => {
                try {
                    return buildStreamingMediaUrl("video", String(row.provider_id));
                } catch {
                    return null;
                }
            })(),
            type: "Music Video",
        };
    }
}

type VideoThumbnailResolution =
    | "160x107"
    | "480x320"
    | "750x500"
    | "1080x720"
    | "640x360"
    | "1280x720"
    | "origin";

async function downloadProviderArtwork(
    url: string | null | undefined,
    outputPath: string,
    label: string,
): Promise<boolean> {
    if (!url) {
        console.log(`ℹ️ [METADATA] No ${label} available, skipping.`);
        return false;
    }

    // Prefer local MediaCover cache if present (MediaCover origin file).
    const localFilePath = getMediaCoverFilePathFromUrl(url);
    if (localFilePath && fs.existsSync(localFilePath)) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.copyFileSync(localFilePath, outputPath);
        console.log(`✅ [METADATA] ${label} copied from MediaCover cache: ${outputPath}`);
        return true;
    }

    const fetchSource = String(url);
    const fetchUrl = resolveMediaCoverProxyUrl(fetchSource) || (
        /^https?:\/\//i.test(fetchSource) ? fetchSource : null
    );
    if (!fetchUrl) {
        console.log(`⚠️ [METADATA] Invalid ${label} URL: ${url}`);
        return false;
    }

    console.log(`📥 [METADATA] Downloading ${label}: ${fetchUrl}`);

    let response: Response;
    try {
        // Timeout so a dead/slow image host can't hang metadata generation
        // (which runs inside the maxConcurrent=1 refresh — one hang stalls all).
        response = await fetch(fetchUrl, { signal: AbortSignal.timeout(30_000) });
    } catch (error) {
        console.warn(`⚠️ [METADATA] Failed to download ${label}: ${(error as Error).message}`);
        return false;
    }
    if (!response.ok) {
        console.log(`⚠️ [METADATA] Failed to download ${label}: ${response.statusText}`);
        return false;
    }

    const buffer = await response.arrayBuffer();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(buffer));

    console.log(`✅ [METADATA] ${label} saved: ${outputPath}`);
    return true;
}

/**
 * Download album video cover (animated MP4) at specified resolution.
 * @param videoCoverId - Provider animated-cover id or absolute URL
 * @param resolution - Resolution: 80, 160, 320, 640, 1280, or "origin"
 * @param outputPath - Full path where to save the MP4
 * @param options - Prefer the import/download provider; fall back to slot then default
 */
export type AlbumVideoCoverDownloadOptions = {
    provider?: string | null;
    providerAlbumId?: string | null;
    releaseGroupMbid?: string | null;
};

function resolveAlbumVideoCoverProvider(options?: AlbumVideoCoverDownloadOptions): {
    providerId: string;
    providerAlbumId: string | null;
} {
    const requestedProvider = String(options?.provider || "").trim();
    const requestedAlbumId = String(options?.providerAlbumId || "").trim() || null;
    if (requestedProvider) {
        return { providerId: requestedProvider, providerAlbumId: requestedAlbumId };
    }

    const releaseGroupMbid = String(options?.releaseGroupMbid || "").trim();
    if (releaseGroupMbid) {
        const source = db.prepare(`
            SELECT
              plan.provider AS selected_provider,
              provider_release.provider_id AS selected_provider_id
            FROM SelectedAcquisitionPlans plan
            JOIN LibraryEditions library_release
              ON library_release.id = plan.library_edition_id
            JOIN AlbumEditions release
              ON release.id = library_release.edition_id
            JOIN Albums release_group
              ON release_group.id = release.release_group_id
            JOIN AcquisitionPlanSources plan_source
              ON plan_source.plan_id = plan.id
            JOIN ProviderEditionMatches release_match
              ON release_match.id = plan_source.provider_edition_match_id
            JOIN ProviderItems provider_release
              ON provider_release.id = release_match.provider_edition_item_id
            WHERE release_group.mbid = ?
              AND plan.state = 'current'
              AND release_match.match_state = 'accepted'
            ORDER BY
              plan_source.sort_order,
              plan_source.id
            LIMIT 1
        `).get(releaseGroupMbid) as {
            selected_provider?: string | null;
            selected_provider_id?: string | null;
        } | undefined;
        const selectedProvider = String(source?.selected_provider || "").trim();
        if (selectedProvider) {
            return {
                providerId: selectedProvider,
                providerAlbumId: requestedAlbumId
                    || String(source?.selected_provider_id || "").trim()
                    || null,
            };
        }
    }

    return {
        providerId: streamingProviderManager.getDefaultProviderId(),
        providerAlbumId: requestedAlbumId,
    };
}

function isHlsArtworkUrl(url: string): boolean {
    const normalized = url.toLowerCase();
    return normalized.includes(".m3u8") || normalized.includes("application/vnd.apple.mpegurl");
}

async function downloadHlsArtworkToFile(url: string, outputPath: string, label: string): Promise<boolean> {
    const ffmpegBin = resolveFfmpegBinary();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const tempPath = `${outputPath}.partial.mp4`;
    try {
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
    } catch {
        // ignore
    }

    console.log(`📥 [METADATA] Remuxing HLS ${label}: ${url}`);
    const ok = await new Promise<boolean>((resolve) => {
        const child = spawn(ffmpegBin, [
            "-y",
            "-loglevel", "error",
            "-i", url,
            "-c", "copy",
            "-bsf:a", "aac_adtstoasc",
            tempPath,
        ], { windowsHide: true });
        let stderr = "";
        child.stderr?.on("data", (chunk) => {
            stderr += String(chunk);
        });
        child.on("error", (error) => {
            console.warn(`⚠️ [METADATA] Failed to remux ${label}: ${error.message}`);
            resolve(false);
        });
        child.on("close", (code) => {
            if (code === 0 && fs.existsSync(tempPath)) {
                resolve(true);
                return;
            }
            console.warn(`⚠️ [METADATA] Failed to remux ${label}: ${stderr.trim() || `ffmpeg exited with code ${code}`}`);
            resolve(false);
        });
    });

    if (!ok) {
        try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch {
            // ignore
        }
        return false;
    }

    fs.renameSync(tempPath, outputPath);
    console.log(`✅ [METADATA] ${label} saved: ${outputPath}`);
    return true;
}

export async function downloadAlbumVideoCover(
    videoCoverId: string,
    resolution: number | "origin",
    outputPath: string,
    options?: AlbumVideoCoverDownloadOptions,
): Promise<void> {
    const allowed = [80, 160, 250, 320, 500, 640, 1200, 1280];
    const numericResolution = typeof resolution === "number" ? resolution : Number(resolution);
    const safeResolution = resolution === "origin"
        ? "origin"
        : (Number.isFinite(numericResolution)
            ? (allowed.find((size) => size >= numericResolution) ?? allowed[allowed.length - 1])
            : 320);

    const size = safeResolution === "origin" ? "origin" : `${safeResolution}x${safeResolution}`;
    const resolved = resolveAlbumVideoCoverProvider(options);
    let provider;
    try {
        provider = streamingProviderManager.getStreamingProvider(resolved.providerId);
    } catch {
        provider = streamingProviderManager.getDefaultStreamingProvider();
    }

    const url = await provider.getArtworkUrl?.({
        entityType: "albumVideoCover",
        imageId: videoCoverId,
        providerId: resolved.providerAlbumId,
        size,
    });
    if (!url) {
        console.log("ℹ️ [METADATA] No album video cover available, skipping.");
        return;
    }

    if (isHlsArtworkUrl(url)) {
        await downloadHlsArtworkToFile(url, outputPath, "album video cover");
        return;
    }

    await downloadProviderArtwork(url, outputPath, "album video cover");
}

function resolveCanonicalVideoCoverId(context: {
    provider?: string | null;
    providerId?: string | number | null;
    videoId?: string | number | null;
}): string | null {
    const explicitVideoId = String(context.videoId ?? "").trim();
    if (explicitVideoId) {
        const byId = db.prepare(`
          SELECT id
          FROM Recordings
          WHERE id = ? AND is_video = 1
          LIMIT 1
        `).get(explicitVideoId) as { id: number } | undefined;
        if (byId?.id != null) return String(byId.id);

        const byMbid = db.prepare(`
          SELECT id
          FROM Recordings
          WHERE mbid = ? AND is_video = 1
          LIMIT 1
        `).get(explicitVideoId) as { id: number } | undefined;
        if (byMbid?.id != null) return String(byMbid.id);
    }

    const provider = String(context.provider || "").trim();
    const providerId = String(context.providerId ?? "").trim();
    if (!provider || !providerId) return null;

    const providerItem = db.prepare(`
      SELECT video_match.recording_id
      FROM ProviderItems pi
      JOIN ProviderVideoMatches video_match
        ON video_match.provider_video_item_id = pi.id
       AND video_match.match_state = 'accepted'
      WHERE pi.provider = ?
        AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
        AND pi.entity_type = 'video'
      ORDER BY pi.updated_at DESC
      LIMIT 1
    `).get(provider, providerId) as { recording_id?: number | null } | undefined;
    return providerItem?.recording_id != null ? String(providerItem.recording_id) : null;
}

/**
 * Materialize a static music-video thumbnail from the canonical recording's
 * cached full-resolution MediaCover master. The image id and resolution remain
 * in the signature for call-site compatibility; refresh/match owns all source
 * selection, provider access, and network I/O.
 */
export async function downloadVideoThumbnail(
    _imageId: string,
    _resolution: VideoThumbnailResolution,
    outputPath: string,
    context: { provider?: string | null; providerId?: string | number | null; videoId?: string | number | null } = {},
): Promise<MediaCoverSidecarSyncResult> {
    const videoId = resolveCanonicalVideoCoverId(context);
    if (!videoId) return "missing";
    return syncCachedMediaCoverToFile({
        entityId: videoId,
        coverEntity: "Video",
        coverTypes: "cover",
        outputPath,
    });
}

/**
 * Get track lyrics including synchronized subtitles
 * @param trackId - Tidal track ID
 * @returns Lyrics object with text and subtitles (LRC format)
 */
export async function getTrackLyrics(trackId: string, provider?: string | null): Promise<{
    text: string;
    subtitles: string;
    provider: string;
    matchType?: string;
} | null> {
    return getLyricsForProviderMedia(trackId, provider);
}

/**
 * Save synchronized lyrics to `.lrc`, or unsynchronized lyrics to the
 * plain `.txt` sidecar format.
 * @param trackId - Tidal track ID
 * @param outputPath - Adjacent lyric path (its extension is replaced when the
 * provider only supplies plain lyrics)
 * @returns The actual sidecar path written
 */
export async function saveLyricsFile(
    trackId: string,
    outputPath: string,
    provider?: string | null,
): Promise<string> {
    const lyrics = await getTrackLyrics(trackId, provider);
    const classified = classifyLyricsForSidecar(lyrics);
    if (!classified) {
        throw new Error(`No lyrics available for track ${trackId}`);
    }

    const actualPath = lyricSidecarPath(outputPath, classified.extension);

    fs.mkdirSync(path.dirname(actualPath), { recursive: true });
    fs.writeFileSync(actualPath, `${classified.content}\n`, 'utf-8');

    console.log(`✅ [METADATA] Lyrics saved: ${actualPath}`);
    return actualPath;
}

/**
 * Save artist.nfo in the Jellyfin/Kodi music artist shape.
 */
export async function saveArtistNfoFile(
    artistId: string,
    outputPath: string
): Promise<boolean> {
    const localArtist = db.prepare(`
        SELECT
            artist.id,
            artist.mbid,
            artist.name,
            COALESCE(NULLIF(TRIM(artist.sort_name), ''), artist.name) AS sort_name,
            NULLIF(TRIM(artist.overview), '') AS biography
        FROM ArtistMetadata artist
        WHERE CAST(artist.id AS TEXT) = CAST(? AS TEXT)
           OR artist.mbid = ?
        ORDER BY CASE WHEN CAST(artist.id AS TEXT) = CAST(? AS TEXT) THEN 0 ELSE 1 END
        LIMIT 1
    `).get(artistId, artistId, artistId) as {
        id: string;
        mbid: string | null;
        name: string;
        sort_name: string | null;
        biography: string | null;
    } | undefined;
    if (!localArtist) {
        throw new Error(`Cannot write artist NFO without local canonical artist ${artistId}`);
    }
    const bioText = localArtist.biography ? cleanProviderText(localArtist.biography) : "";

    const albums = localArtist?.mbid
        ? db.prepare(`
        SELECT title, release_date
        FROM (
            SELECT title, first_release_date AS release_date
            FROM Albums
            WHERE artist_mbid = ?
        )
        ORDER BY release_date, title
        LIMIT 250
    `).all(localArtist.mbid) as Array<{ title: string; release_date: string | null }>
        : [];
    const providerIds = localArtist.mbid
        ? db.prepare(`
            SELECT pi.provider, CAST(pi.provider_id AS TEXT) AS provider_id
            FROM ProviderItems pi
            JOIN ProviderArtistMatches artist_match
              ON artist_match.provider_artist_item_id = pi.id
             AND artist_match.match_state = 'accepted'
            JOIN ArtistMetadata artist_meta ON artist_meta.id = artist_match.artist_id
            WHERE pi.entity_type = 'artist'
              AND artist_meta.mbid = ?
              AND pi.provider IS NOT NULL
              AND pi.provider_id IS NOT NULL
            ORDER BY pi.provider ASC, CAST(pi.provider_id AS TEXT) ASC
        `).all(localArtist.mbid) as Array<{ provider: string; provider_id: string }>
        : [];

    const elements = [
        xmlElement("title", localArtist.name),
        xmlElement("name", localArtist.name),
        xmlElement("sorttitle", localArtist.sort_name || localArtist.name),
        xmlElement("biography", bioText),
        xmlElement("outline", bioText),
        xmlElement("musicbrainzartistid", localArtist?.mbid),
        xmlUniqueId("MusicBrainzArtist", localArtist?.mbid, true),
        ...providerIds.map((entry) => xmlUniqueId(`${entry.provider}Artist`, entry.provider_id)),
        ...albums.map((album) => {
            const year = String(album.release_date || "").match(/^\d{4}/)?.[0] || "";
            return `  <album>\n${[
                xmlElement("title", album.title),
                xmlElement("year", year),
            ].filter((element): element is string => Boolean(element)).map((element) => `  ${element}`).join("\n")}\n  </album>`;
        }),
    ].filter((element): element is string => element !== null);

    const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<artist>\n${elements.join("\n")}\n</artist>\n`;
    const written = writeXmlFile(outputPath, xml);
    if (written) {
        console.log(`✅ [METADATA] Artist NFO saved: ${outputPath}`);
    }
    return written;
}

export type AlbumNfoOptions = {
    releaseGroupMbid?: string | null;
    releaseMbid?: string | null;
    librarySlot?: string | null;
    provider?: string | null;
    providerAlbumId?: string | null;
};

function formatNfoTrackDuration(value: number | null | undefined): string | null {
    const totalSeconds = Number(value);
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return null;
    const rounded = Math.round(totalSeconds);
    const minutes = Math.floor(rounded / 60);
    const seconds = rounded % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Save album.nfo in the Jellyfin/Kodi music album shape.
 */
export async function saveAlbumNfoFile(
    albumId: string,
    outputPath: string,
    options: AlbumNfoOptions = {},
): Promise<boolean> {
    let releaseGroupMbid = textOrNull(options.releaseGroupMbid);
    if (!releaseGroupMbid) {
        const canonical = db.prepare(`
            SELECT mbid AS release_group_mbid
            FROM Albums
            WHERE mbid = ?
            UNION ALL
            SELECT release_group_mbid
            FROM AlbumEditions
            WHERE mbid = ?
            LIMIT 1
        `).get(albumId, albumId) as { release_group_mbid?: string | null } | undefined;
        releaseGroupMbid = textOrNull(canonical?.release_group_mbid);
    }
    if (!releaseGroupMbid && options.provider) {
        const qualifiedOffer = db.prepare(`
            SELECT release_group.mbid AS release_group_mbid
            FROM ProviderItems pi
            JOIN ProviderEditionMatches release_match
              ON release_match.provider_edition_item_id = pi.id
             AND release_match.match_state = 'accepted'
            JOIN AlbumEditions release ON release.id = release_match.edition_id
            JOIN Albums release_group ON release_group.id = release.release_group_id
            WHERE pi.provider = ?
              AND pi.entity_type = 'release'
              AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
            ORDER BY
              CASE WHEN release_match.decision_source = 'manual' THEN 0 ELSE 1 END,
              release_match.confidence DESC,
              release_match.id
            LIMIT 1
        `).get(options.provider, options.providerAlbumId || albumId) as {
            release_group_mbid?: string | null;
        } | undefined;
        releaseGroupMbid = textOrNull(qualifiedOffer?.release_group_mbid);
    }
    if (!releaseGroupMbid) {
        throw new Error(`Cannot write album NFO without a canonical release group for ${albumId}`);
    }

    const requestedLibraryClass = String(options.librarySlot || "").trim().toLowerCase();
    const selectedLibrary = db.prepare(`
        SELECT
          plan.provider AS selected_provider,
          provider_release.provider_id AS selected_provider_id,
          release.mbid AS selected_release_mbid
        FROM Albums release_group
        JOIN LibraryAlbums library_group
          ON library_group.release_group_id = release_group.id
        JOIN Libraries library
          ON library.id = library_group.library_id
        JOIN quality_profiles quality_profile
          ON quality_profile.id = library.quality_profile_id
        JOIN LibraryEditions library_release
          ON library_release.library_id = library.id
        JOIN AlbumEditions release
          ON release.id = library_release.edition_id
         AND release.release_group_id = release_group.id
        LEFT JOIN SelectedAcquisitionPlans plan
          ON plan.library_edition_id = library_release.id
         AND plan.state = 'current'
        LEFT JOIN AcquisitionPlanSources plan_source
          ON plan_source.plan_id = plan.id
         AND plan_source.role = 'primary'
        LEFT JOIN ProviderEditionMatches release_match
          ON release_match.id = plan_source.provider_edition_match_id
         AND release_match.match_state = 'accepted'
        LEFT JOIN ProviderItems provider_release
          ON provider_release.id = release_match.provider_edition_item_id
        WHERE release_group.mbid = ?
          AND (
            ? = ''
            OR (? = 'spatial' AND EXISTS (
              SELECT 1
              FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
              WHERE allowed.value = 'spatial'
            ))
            OR (? = 'stereo' AND EXISTS (
              SELECT 1
              FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
              WHERE allowed.value <> 'spatial'
            ))
          )
        ORDER BY
          CASE WHEN EXISTS (
            SELECT 1
            FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
            WHERE allowed.value = 'spatial'
          ) THEN 1 ELSE 0 END,
          library_release.updated_at DESC,
          library_release.id
        LIMIT 1
    `).get(
        releaseGroupMbid,
        requestedLibraryClass,
        requestedLibraryClass,
        requestedLibraryClass,
    ) as {
        selected_provider?: string | null;
        selected_provider_id?: string | null;
        selected_release_mbid?: string | null;
    } | undefined;
    const canonicalReleaseMbid = textOrNull(
        options.releaseMbid,
        selectedLibrary?.selected_release_mbid,
        (db.prepare(`
            SELECT mbid
            FROM AlbumEditions
            WHERE release_group_mbid = ?
            ORDER BY
              CASE WHEN EXISTS (
                SELECT 1 FROM LibraryEditions library_edition
                WHERE library_edition.edition_id = AlbumEditions.id
              ) THEN 0 ELSE 1 END,
              CASE WHEN date IS NULL THEN 1 ELSE 0 END, date ASC, mbid ASC
            LIMIT 1
        `).get(releaseGroupMbid) as { mbid?: string | null } | undefined)?.mbid,
    );
    const canonicalAlbum = db.prepare(`
        SELECT
            release_group.mbid AS release_group_mbid,
            release_group.title,
            release_group.artist_mbid,
            release_group.first_release_date,
            release_group.review_text,
            release_group.overview,
            release_group.genres,
            release.mbid AS release_mbid,
            release.date,
            release.barcode,
            release.label,
            COALESCE(NULLIF(TRIM(artist.name), ''), artist_metadata.name) AS artist_name
        FROM Albums release_group
        LEFT JOIN AlbumEditions release
          ON release.mbid = ?
         AND release.release_group_mbid = release_group.mbid
        LEFT JOIN ArtistMetadata artist_metadata ON artist_metadata.mbid = release_group.artist_mbid
        LEFT JOIN ArtistMetadata artist ON artist.mbid = release_group.artist_mbid
        WHERE release_group.mbid = ?
        LIMIT 1
    `).get(canonicalReleaseMbid, releaseGroupMbid) as {
        release_group_mbid: string;
        title: string;
        artist_mbid: string | null;
        first_release_date: string | null;
        review_text: string | null;
        overview: string | null;
        genres: string | null;
        release_mbid: string | null;
        date: string | null;
        barcode: string | null;
        label: string | null;
        artist_name: string | null;
    } | undefined;
    if (!canonicalAlbum) {
        throw new Error(`Canonical release group ${releaseGroupMbid} is missing`);
    }

    const artistCredits = db.prepare(`
        SELECT credit.credited_name
        FROM ReleaseGroupArtistCredits credit
        JOIN Albums release_group ON release_group.id = credit.release_group_id
        WHERE release_group.mbid = ?
        ORDER BY credit.ordinal ASC
    `).all(releaseGroupMbid) as Array<{ credited_name: string }>;
    const listingCredits = artistCredits.length > 0
        ? artistCredits
        : db.prepare(`
            SELECT credited_name
            FROM AlbumArtists
            WHERE release_group_mbid = ?
            ORDER BY ord ASC
        `).all(releaseGroupMbid) as Array<{ credited_name: string }>;
    const artists = listingCredits.length > 0
        ? listingCredits.map((entry) => entry.credited_name)
        : [canonicalAlbum.artist_name || "Unknown Artist"];

    const tracks = canonicalAlbum.release_mbid
        ? db.prepare(`
            SELECT
                track.title,
                CASE WHEN track.length_ms IS NULL THEN NULL ELSE ROUND(track.length_ms / 1000.0) END AS duration,
                track.position AS track_number,
                track.medium_position AS volume_number,
                track.recording_mbid,
                track.mbid AS track_mbid,
                recording.isrcs AS recording_isrcs
            FROM Tracks track
            LEFT JOIN Recordings recording ON recording.mbid = track.recording_mbid
            WHERE track.release_mbid = ?
            ORDER BY COALESCE(track.medium_position, 1), COALESCE(track.position, 0), track.id
        `).all(canonicalAlbum.release_mbid)
        : [];
    const nfoTracks = tracks as Array<{
        title: string;
        duration: number | null;
        track_number: number | null;
        volume_number: number | null;
        recording_mbid: string | null;
        track_mbid: string | null;
        recording_isrcs: string | null;
    }>;
    const releaseDate = canonicalAlbum.date || canonicalAlbum.first_release_date;
    const year = releaseDate ? releaseDate.substring(0, 4) : "";
    const reviewText = cleanProviderText(textOrNull(
        canonicalAlbum.review_text,
        canonicalAlbum.overview,
    ) || "");

    // Kodi album.nfo reads <genre> (multiple) and <label>; Jellyfin ignores NFO
    // genre for music albums but still benefits from embedded file tags.
    // <upc> is Discogenius/Jellyfin-friendly (not in Kodi's album.nfo schema).
    // ISRC stays track-level: embed in audio tags; optional <isrc> on NFO track
    // children for archival (Kodi has no album-level ISRC and does not wire
    // album.nfo tracks to library songs).
    const albumGenres = parseJsonStringList(
        canonicalAlbum.genres,
    );
    const albumLabels = parseJsonStringList(canonicalAlbum.label);
    const providerUniqueIds = new Map<string, string>();
    const addProviderIds = (provider: string | null | undefined, providerIds: string | null | undefined) => {
        const normalizedProvider = String(provider || "").trim();
        const providerId = String(providerIds || "").trim();
        if (!normalizedProvider || !providerId) return;
        providerUniqueIds.set(`${normalizedProvider}\u0000${providerId}`, providerId);
    };
    addProviderIds(selectedLibrary?.selected_provider, selectedLibrary?.selected_provider_id);
    addProviderIds(options.provider, options.providerAlbumId);

    const elements = [
        xmlElement("title", canonicalAlbum.title),
        xmlElement("review", reviewText),
        xmlElement("year", year),
        xmlElement("releasedate", releaseDate),
        ...artists.map((artistName: unknown) => xmlElement("artist", artistName)),
        ...artists.map((artistName: unknown) => xmlElement("albumartist", artistName)),
        ...albumGenres.map((genre) => xmlElement("genre", genre)),
        ...albumLabels.map((labelName) => xmlElement("label", labelName)),
        xmlElement("musicbrainzalbumid", canonicalAlbum.release_mbid),
        xmlElement("musicbrainzreleasegroupid", canonicalAlbum.release_group_mbid),
        xmlElement("musicbrainzalbumartistid", canonicalAlbum.artist_mbid),
        xmlElement("upc", canonicalAlbum.barcode),
        xmlUniqueId("MusicBrainzAlbum", canonicalAlbum.release_mbid, true),
        xmlUniqueId("MusicBrainzReleaseGroup", canonicalAlbum.release_group_mbid),
        xmlUniqueId("MusicBrainzAlbumArtist", canonicalAlbum.artist_mbid),
        ...Array.from(providerUniqueIds.entries()).map(([key, providerAlbumId]) => {
            const provider = key.split("\u0000", 1)[0];
            return xmlUniqueId(`${provider}Album`, providerAlbumId);
        }),
        ...nfoTracks.map((track) => {
            const trackIsrc = parseJsonStringList(track.recording_isrcs)[0] || null;
            const trackElements = [
                xmlElement("disc", track.volume_number || 1),
                xmlElement("position", track.track_number),
                xmlElement("title", track.title),
                xmlElement("duration", formatNfoTrackDuration(track.duration)),
                xmlElement("isrc", trackIsrc),
                xmlUniqueId("MusicBrainzTrack", track.track_mbid),
                xmlUniqueId("MusicBrainzRecording", track.recording_mbid),
            ].filter((element): element is string => Boolean(element));
            return `  <track>\n${trackElements.map((element) => `  ${element}`).join("\n")}\n  </track>`;
        }),
    ].filter((element): element is string => element !== null);

    const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<album>\n${elements.join("\n")}\n</album>\n`;
    const written = writeXmlFile(outputPath, xml);
    if (written) {
        console.log(`✅ [METADATA] Album NFO saved: ${outputPath}`);
    }
    return written;
}

/**
 * Save a music-video NFO sidecar. Jellyfin's music-video NFO root is musicvideo.
 */
export async function saveVideoNfoFile(
    videoId: string,
    outputPath: string,
    providerId?: string | null,
): Promise<void> {
    const provider = providerId
        ? streamingProviderManager.getStreamingProvider(providerId)
        : streamingProviderManager.getDefaultStreamingProvider();
    const video = await getVideoForNfo(videoId, provider.id);
    const videoRecord = video as any;
    const localVideo = loadVideoProviderItem(videoId, provider.id);
    const videoArtistId = videoRecord.artist_id || videoRecord.artist?.providerId || localVideo?.artist_id || null;
    const videoArtistName = videoRecord.artist_name || videoRecord.artist?.name || localVideo?.artist_name || null;
    const videoAlbumId = videoRecord.album_id || null;
    const videoReleaseDate = videoRecord.release_date || videoRecord.releaseDate || null;
    const artistRow = videoArtistId
        ? db.prepare("SELECT mbid FROM ArtistMetadata WHERE id = ?").get(videoArtistId) as { mbid?: string | null } | undefined
        : undefined;
    const albumItem = videoAlbumId
        ? loadAlbumProviderItem(String(videoAlbumId), localVideo?.provider || provider.id)
        : null;
    const albumRow = albumItem ? {
        title: albumItem.release_group_title || albumItem.release_title || albumItem.provider_title,
        mbid: albumItem.release_mbid,
        mb_release_group_id: albumItem.release_group_mbid,
    } : localVideo ? {
        title: localVideo.album_title,
        mbid: localVideo.album_mbid || localVideo.release_mbid,
        mb_release_group_id: localVideo.release_group_mbid,
    } : undefined;
    const year = String(videoReleaseDate || "").match(/^\d{4}/)?.[0] || "";
    const videoArtists = Array.isArray(videoRecord.artists) && videoRecord.artists.length > 0
        ? videoRecord.artists
        : Array.isArray(videoRecord.raw?.artists) ? videoRecord.raw.artists : [];
    const artistNames = videoArtists.length > 0
        ? videoArtists.map((artist: { name?: unknown }) => artist?.name).filter((name: unknown) => String(name ?? "").trim().length > 0)
        : [videoArtistName || "Unknown Artist"];

    const elements = [
        xmlElement("title", video.title),
        xmlElement("year", year),
        xmlElement("releasedate", videoReleaseDate),
        ...artistNames.map((artistName: unknown) => xmlElement("artist", artistName)),
        xmlElement("album", albumRow?.title),
        xmlElement("musicbrainzartistid", artistRow?.mbid || localVideo?.artist_mbid),
        xmlElement("musicbrainzalbumid", albumRow?.mbid),
        xmlElement("musicbrainzreleasegroupid", albumRow?.mb_release_group_id),
        xmlUniqueId("MusicBrainzArtist", artistRow?.mbid || localVideo?.artist_mbid),
        xmlUniqueId("MusicBrainzAlbum", albumRow?.mbid),
        xmlUniqueId("MusicBrainzReleaseGroup", albumRow?.mb_release_group_id),
        xmlUniqueId(`${provider.id}Video`, videoId, true),
    ].filter((element): element is string => element !== null);

    const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<musicvideo>\n${elements.join("\n")}\n</musicvideo>\n`;
    writeXmlFile(outputPath, xml);
    console.log(`✅ [METADATA] Video NFO saved: ${outputPath}`);
}



