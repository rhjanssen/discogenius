import { db } from "../database.js";
import type { AlbumContract } from "../contracts/catalog.js";
import type { AlbumPageContract } from "../contracts/pages.js";
import type { AlbumTrackContract } from "../contracts/media.js";
import { lidarrMetadataService } from "./metadata/lidarr-metadata-service.js";
import { normalizeComparableText, stringSimilarity } from "./import-matching-utils.js";
import { streamingProviderManager } from "./providers/index.js";
import type { ProviderTrack } from "./providers/streaming-provider.js";

function queryReleaseGroup(releaseGroupMbid: string): any | null {
    return db.prepare(`
      SELECT
        rg.*,
        a.id AS local_artist_id,
        a.name AS local_artist_name,
        a.picture AS artist_picture,
        a.cover_image_url AS artist_cover_image_url,
        a.monitor AS artist_monitor,
        COALESCE(stereo.wanted, spatial.wanted, a.monitor, 0) AS wanted,
        COALESCE(stereo.selected_provider, spatial.selected_provider) AS selected_provider,
        COALESCE(stereo.selected_provider_id, spatial.selected_provider_id) AS selected_provider_id,
        COALESCE(stereo.quality, spatial.quality) AS selected_quality,
        stereo.selected_provider_id AS stereo_provider_id,
        stereo.quality AS stereo_quality,
        stereo.match_status AS stereo_match_status,
        spatial.selected_provider_id AS spatial_provider_id,
        spatial.quality AS spatial_quality,
        spatial.match_status AS spatial_match_status,
        stereo.provider_data AS stereo_provider_data,
        spatial.provider_data AS spatial_provider_data
      FROM mb_release_groups rg
      LEFT JOIN artists a ON a.mbid = rg.artist_mbid
      LEFT JOIN release_group_slots stereo
        ON stereo.release_group_mbid = rg.mbid
       AND stereo.slot = 'stereo'
      LEFT JOIN release_group_slots spatial
        ON spatial.release_group_mbid = rg.mbid
       AND spatial.slot = 'spatial'
      WHERE rg.mbid = ?
    `).get(releaseGroupMbid) as any | null;
}

function selectPreferredRelease(releaseGroupMbid: string): any | null {
    return db.prepare(`
      SELECT
        r.*,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM mb_mediums m
            WHERE m.release_mbid = r.mbid
              AND LOWER(COALESCE(m.format, '')) LIKE '%digital%'
          ) THEN 1 ELSE 0
        END AS digital_score
      FROM mb_releases r
      WHERE r.release_group_mbid = ?
      ORDER BY
        digital_score DESC,
        CASE LOWER(COALESCE(r.status, '')) WHEN 'official' THEN 0 ELSE 1 END ASC,
        COALESCE(r.track_count, 0) DESC,
        (r.date IS NULL) ASC,
        r.date DESC,
        r.mbid ASC
      LIMIT 1
    `).get(releaseGroupMbid) as any | null;
}

function coverArtArchiveReleaseGroupUrl(mbid: string | null | undefined): string | null {
    const trimmed = String(mbid || "").trim();
    return trimmed ? `https://coverartarchive.org/release-group/${trimmed}/front-500` : null;
}

function parseProviderData(value: unknown): any | null {
    if (!value) {
        return null;
    }
    try {
        return typeof value === "string" ? JSON.parse(value) : value;
    } catch {
        return null;
    }
}

async function resolveProviderCoverUrl(releaseGroup: any): Promise<string | null> {
    const candidates = [
        {
            providerId: String(releaseGroup.stereo_provider || releaseGroup.selected_provider || "").trim(),
            providerAlbumId: String(releaseGroup.stereo_provider_id || releaseGroup.selected_provider_id || "").trim(),
            data: parseProviderData(releaseGroup.stereo_provider_data),
        },
        {
            providerId: String(releaseGroup.spatial_provider || releaseGroup.selected_provider || "").trim(),
            providerAlbumId: String(releaseGroup.spatial_provider_id || releaseGroup.selected_provider_id || "").trim(),
            data: parseProviderData(releaseGroup.spatial_provider_data),
        },
    ];

    for (const candidate of candidates) {
        const imageId = String(candidate.data?.cover || "").trim();
        if (!candidate.providerId || !imageId) {
            continue;
        }

        try {
            const provider = streamingProviderManager.getStreamingProvider(candidate.providerId);
            const resolved = await provider.getArtworkUrl?.({
                entityType: "album",
                providerId: candidate.providerAlbumId,
                imageId,
                size: 640,
            });
            if (resolved) {
                return String(resolved);
            }
        } catch {
            // Fall through to MusicBrainz/Cover Art Archive sources.
        }
    }

    return null;
}

export function normalizeMusicBrainzReleaseGroupAlbum(
    releaseGroup: any,
    release: any | null,
    providerCoverUrl?: string | null,
): AlbumContract {
    const primaryType = String(releaseGroup.primary_type || "Album").trim().toUpperCase();
    const artistId = releaseGroup.local_artist_id == null
        ? String(releaseGroup.artist_mbid)
        : String(releaseGroup.local_artist_id);
    const artistName = String(releaseGroup.local_artist_name || "Unknown Artist");
    let coverUrl: string | null = null;

    try {
        if (releaseGroup.data) {
            const albumData = typeof releaseGroup.data === "string" ? JSON.parse(releaseGroup.data) : releaseGroup.data;
            coverUrl = lidarrMetadataService.getAlbumImageUrl(albumData);
        }
    } catch {
        // Ignore malformed cached metadata and continue through the normal artwork chain.
    }

    if (!coverUrl) {
        coverUrl = providerCoverUrl ?? coverArtArchiveReleaseGroupUrl(releaseGroup.mbid);
    }

    return {
        id: String(releaseGroup.mbid),
        title: String(releaseGroup.title || release?.title || "Unknown Album"),
        cover_id: coverUrl,
        cover: coverUrl,
        cover_art_url: coverUrl,
        vibrant_color: null,
        release_date: release?.date || releaseGroup.first_release_date || null,
        type: primaryType === "EP" || primaryType === "SINGLE" ? primaryType : "ALBUM",
        album_type: primaryType === "EP" || primaryType === "SINGLE" ? primaryType : "ALBUM",
        quality: "",
        stereo_provider_id: releaseGroup.stereo_provider_id || null,
        stereo_quality: releaseGroup.stereo_quality || null,
        stereo_match_status: releaseGroup.stereo_match_status || null,
        spatial_provider_id: releaseGroup.spatial_provider_id || null,
        spatial_quality: releaseGroup.spatial_quality || null,
        spatial_match_status: releaseGroup.spatial_match_status || null,
        selected_provider_id: releaseGroup.selected_provider_id || null,
        source: "musicbrainz",
        is_monitored: Boolean(releaseGroup.wanted ?? releaseGroup.artist_monitor),
        is_downloaded: false,
        downloaded: 0,
        artist_id: artistId,
        artist_name: artistName,
        include_in_monitoring: 1,
        excluded_reason: null,
        filtered_out: 0,
        filtered_reason: null,
        redundant_of: null,
        redundant: null,
        monitor: (releaseGroup.wanted ?? releaseGroup.artist_monitor) ? 1 : 0,
        monitor_lock: 0,
        monitor_locked: false,
        module: primaryType,
        group_type: primaryType,
    };
}

function getReleaseTrackContracts(
    releaseMbid: string,
    releaseGroupMbid: string,
    albumTitle: string,
    artistName: string,
): AlbumTrackContract[] {
    const rows = db.prepare(`
      SELECT
        t.mbid,
        t.recording_mbid,
        t.release_mbid,
        t.title,
        t.number,
        t.position,
        t.medium_position,
        t.length_ms
      FROM mb_tracks t
      WHERE t.release_mbid = ?
      ORDER BY t.medium_position ASC, t.position ASC
    `).all(releaseMbid) as any[];

    return rows.map((track) => ({
        id: String(track.mbid),
        preview_provider: null,
        preview_provider_track_id: null,
        title: String(track.title || "Unknown Track"),
        version: null,
        duration: Math.round(Number(track.length_ms || 0) / 1000),
        track_number: Number(track.position || 0),
        volume_number: Number(track.medium_position || 1),
        quality: "",
        artist_name: artistName,
        album_title: albumTitle,
        musicbrainz_track_id: String(track.mbid),
        musicbrainz_recording_id: track.recording_mbid == null ? null : String(track.recording_mbid),
        musicbrainz_release_id: track.release_mbid == null ? null : String(track.release_mbid),
        downloaded: false,
        is_downloaded: false,
        is_monitored: true,
        monitor: 1,
        monitor_lock: 0,
        monitor_locked: false,
        explicit: false,
        album_id: releaseGroupMbid,
        files: [],
    }));
}

function scoreProviderTrackMatch(track: AlbumTrackContract, providerTrack: ProviderTrack): number {
    const volumeScore = Number(track.volume_number || 1) === Number(providerTrack.volumeNumber || 1) ? 0.35 : 0;
    const trackScore = Number(track.track_number || 0) === Number(providerTrack.trackNumber || 0) ? 0.35 : 0;
    const titleScore = stringSimilarity(normalizeComparableText(track.title), normalizeComparableText(providerTrack.title)) * 0.2;
    const durationDelta = Math.abs(Number(track.duration || 0) - Number(providerTrack.duration || 0));
    const durationScore = Number(track.duration || 0) > 0 && Number(providerTrack.duration || 0) > 0
        ? Math.max(0, 1 - (durationDelta / Math.max(8, Number(track.duration || 0) * 0.08))) * 0.1
        : 0;

    return volumeScore + trackScore + titleScore + durationScore;
}

function attachLocalFilesToTracks(
    tracks: AlbumTrackContract[],
    providerAlbumIds: string[],
    providerId: string | null,
): AlbumTrackContract[] {
    const normalizedAlbumIds = Array.from(new Set(providerAlbumIds.map((value) => String(value || "").trim()).filter(Boolean)));
    if (normalizedAlbumIds.length === 0 || tracks.length === 0) {
        return tracks;
    }

    const placeholders = normalizedAlbumIds.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT
        m.id AS media_id,
        m.album_id,
        m.title,
        m.quality AS media_quality,
        m.track_number,
        m.volume_number,
        lf.id AS file_id,
        lf.artist_id,
        lf.album_id AS file_album_id,
        lf.media_id AS file_media_id,
        lf.file_type,
        lf.file_path,
        lf.relative_path,
        lf.filename,
        lf.extension,
        lf.quality,
        lf.library_root,
        lf.file_size,
        lf.bitrate,
        lf.sample_rate,
        lf.bit_depth,
        lf.channels,
        lf.codec,
        lf.duration
      FROM media m
      LEFT JOIN library_files lf
        ON CAST(lf.media_id AS TEXT) = CAST(m.id AS TEXT)
       AND lf.file_type = 'track'
      WHERE CAST(m.album_id AS TEXT) IN (${placeholders})
        AND m.type != 'Music Video'
    `).all(...normalizedAlbumIds) as any[];

    if (rows.length === 0) {
        return tracks;
    }

    const rowsByPosition = new Map<string, any[]>();
    for (const row of rows) {
        const key = `${Number(row.volume_number || 1)}:${Number(row.track_number || 0)}`;
        const list = rowsByPosition.get(key) || [];
        list.push(row);
        rowsByPosition.set(key, list);
    }

    return tracks.map((track) => {
        const key = `${Number(track.volume_number || 1)}:${Number(track.track_number || 0)}`;
        const matches = rowsByPosition.get(key) || [];
        const files = matches
            .filter((row) => row.file_id != null)
            .map((row) => ({
                id: Number(row.file_id),
                artist_id: row.artist_id == null ? null : String(row.artist_id),
                album_id: row.file_album_id == null ? null : String(row.file_album_id),
                media_id: row.file_media_id == null ? null : String(row.file_media_id),
                file_type: String(row.file_type),
                file_path: String(row.file_path),
                relative_path: row.relative_path == null ? undefined : String(row.relative_path),
                filename: row.filename == null ? undefined : String(row.filename),
                extension: row.extension == null ? undefined : String(row.extension),
                quality: row.quality == null ? null : String(row.quality),
                library_root: row.library_root == null ? undefined : String(row.library_root),
                file_size: row.file_size == null ? undefined : Number(row.file_size),
                bitrate: row.bitrate == null ? undefined : Number(row.bitrate),
                sample_rate: row.sample_rate == null ? undefined : Number(row.sample_rate),
                bit_depth: row.bit_depth == null ? undefined : Number(row.bit_depth),
                channels: row.channels == null ? undefined : Number(row.channels),
                codec: row.codec == null ? undefined : String(row.codec),
                duration: row.duration == null ? undefined : Number(row.duration),
            }));
        const bestMedia = matches[0] || null;

        return {
            ...track,
            preview_provider: track.preview_provider || (bestMedia ? providerId : null),
            preview_provider_track_id: track.preview_provider_track_id || (bestMedia?.media_id == null ? null : String(bestMedia.media_id)),
            quality: bestMedia?.media_quality || track.quality,
            downloaded: files.length > 0 || track.downloaded,
            is_downloaded: files.length > 0 || track.is_downloaded,
            files: files.length > 0 ? files : track.files,
        };
    });
}

async function attachProviderPreviewTracks(
    tracks: AlbumTrackContract[],
    releaseGroup: any,
): Promise<AlbumTrackContract[]> {
    const providerAlbumSelections = [
        {
            providerId: String(releaseGroup.stereo_provider || releaseGroup.selected_provider || "").trim(),
            providerAlbumId: String(releaseGroup.stereo_provider_id || "").trim(),
        },
        {
            providerId: String(releaseGroup.spatial_provider || releaseGroup.selected_provider || "").trim(),
            providerAlbumId: String(releaseGroup.spatial_provider_id || "").trim(),
        },
        {
            providerId: String(releaseGroup.selected_provider || "").trim(),
            providerAlbumId: String(releaseGroup.selected_provider_id || "").trim(),
        },
    ].filter((selection) => selection.providerId && selection.providerAlbumId);
    const seenAlbums = new Set<string>();
    const uniqueSelections = providerAlbumSelections.filter((selection) => {
        const key = `${selection.providerId}:${selection.providerAlbumId}`;
        if (seenAlbums.has(key)) {
            return false;
        }
        seenAlbums.add(key);
        return true;
    });

    if (uniqueSelections.length === 0 || tracks.length === 0) {
        return tracks;
    }

    try {
        const providerTracks = (await Promise.all(uniqueSelections.map(async (selection) => {
            const provider = streamingProviderManager.getStreamingProvider(selection.providerId);
            const albumTracks = await provider.getAlbumTracks(selection.providerAlbumId);
            return albumTracks.map((track) => ({
                ...track,
                __providerId: selection.providerId,
            }));
        }))).flat();
        const unusedProviderTracks = new Set(providerTracks.map((track) => track.providerId));

        return tracks.map((track) => {
            const candidates = providerTracks
                .filter((providerTrack) => unusedProviderTracks.has(providerTrack.providerId))
                .map((providerTrack) => ({ providerTrack, score: scoreProviderTrackMatch(track, providerTrack) }))
                .sort((left, right) => right.score - left.score);
            const best = candidates[0];
            if (!best || best.score < 0.55) {
                return track;
            }

            unusedProviderTracks.delete(best.providerTrack.providerId);
            return {
                ...track,
                preview_provider: String((best.providerTrack as ProviderTrack & { __providerId?: string }).__providerId || ""),
                preview_provider_track_id: String(best.providerTrack.providerId),
                quality: best.providerTrack.quality || track.quality,
            };
        });
    } catch (error) {
        console.warn(`[MusicBrainzReleaseGroupReadService] Failed to hydrate provider tracks for ${releaseGroup.mbid}:`, error);
        return tracks;
    }
}

async function buildReleaseGroupTrackContracts(
    releaseGroup: any,
    release: any,
    album: AlbumContract,
): Promise<AlbumTrackContract[]> {
    const providerAlbumIds = [
        releaseGroup.stereo_provider_id,
        releaseGroup.spatial_provider_id,
        releaseGroup.selected_provider_id,
    ].map((value) => String(value || "").trim()).filter(Boolean);
    const providerId = String(releaseGroup.selected_provider || "").trim() || null;
    const canonicalTracks = getReleaseTrackContracts(release.mbid, releaseGroup.mbid, album.title, album.artist_name);
    const withLocalFiles = attachLocalFilesToTracks(canonicalTracks, providerAlbumIds, providerId);
    return attachProviderPreviewTracks(withLocalFiles, releaseGroup);
}

export class MusicBrainzReleaseGroupReadService {
    static hasReleaseGroup(releaseGroupMbid: string): boolean {
        return Boolean(queryReleaseGroup(releaseGroupMbid));
    }

    private static async loadReleaseGroup(releaseGroupMbid: string): Promise<any | null> {
        const releaseGroup = queryReleaseGroup(releaseGroupMbid);
        if (!releaseGroup) {
            return null;
        }

        const releaseCount = db.prepare("SELECT COUNT(*) AS count FROM mb_releases WHERE release_group_mbid = ?")
            .get(releaseGroupMbid) as { count: number } | undefined;

        if (Number(releaseCount?.count || 0) === 0) {
            try {
                await lidarrMetadataService.syncReleaseGroup(releaseGroupMbid, releaseGroup.artist_mbid);
            } catch (error) {
                console.warn(`[MusicBrainzReleaseGroupReadService] Failed to hydrate Lidarr album ${releaseGroupMbid}:`, error);
            }
        }

        return queryReleaseGroup(releaseGroupMbid);
    }

    static async getAlbum(releaseGroupMbid: string): Promise<AlbumContract | null> {
        const releaseGroup = await this.loadReleaseGroup(releaseGroupMbid);
        if (!releaseGroup) {
            return null;
        }

        return normalizeMusicBrainzReleaseGroupAlbum(
            releaseGroup,
            selectPreferredRelease(releaseGroupMbid),
            await resolveProviderCoverUrl(releaseGroup),
        );
    }

    static async getTracks(releaseGroupMbid: string): Promise<AlbumTrackContract[]> {
        const releaseGroup = await this.loadReleaseGroup(releaseGroupMbid);
        const release = releaseGroup ? selectPreferredRelease(releaseGroupMbid) : null;
        if (!releaseGroup || !release) {
            return [];
        }

        const album = normalizeMusicBrainzReleaseGroupAlbum(releaseGroup, release, await resolveProviderCoverUrl(releaseGroup));
        return buildReleaseGroupTrackContracts(releaseGroup, release, album);
    }

    static async getPage(releaseGroupMbid: string): Promise<AlbumPageContract | null> {
        const releaseGroup = await this.loadReleaseGroup(releaseGroupMbid);
        if (!releaseGroup) {
            return null;
        }

        const release = selectPreferredRelease(releaseGroupMbid);
        const album = normalizeMusicBrainzReleaseGroupAlbum(releaseGroup, release, await resolveProviderCoverUrl(releaseGroup));

        return {
            album,
            tracks: release
                ? await buildReleaseGroupTrackContracts(releaseGroup, release, album)
                : [],
            similarAlbums: [],
            otherVersions: [],
            artistPicture: releaseGroup.artist_picture != null ? String(releaseGroup.artist_picture) : null,
            artistCoverImageUrl: releaseGroup.artist_cover_image_url ?? null,
        };
    }
}
