import { db } from "../../database.js";
import type { AlbumContract } from "../../contracts/catalog.js";
import type { AlbumPageContract } from "../../contracts/pages.js";
import type { AlbumTrackContract, AlbumVersionContract } from "../../contracts/media.js";
import { skyHookProxy } from "./skyhook-proxy.js";
import { scoreTrackMatch as sharedScoreTrackMatch } from "../music/provider-track-matcher.js";
import { streamingProviderManager } from "../providers/index.js";
import type { ProviderTrack } from "../providers/streaming-provider.js";
import {
    albumProviderArtworkCandidatesFromRow,
    chooseCachedAlbumArtwork,
    chooseCachedProviderArtwork,
    parseJsonObject,
    registerMediaCoverProxyUrl,
    resolveMediaCoverProxyUrl,
} from "./media-cover-service.js";
import { resolveHydratedReleaseGroupArtwork } from "./release-group-artwork-service.js";
import { MusicBrainzReleaseSelectionService } from "./musicbrainz-release-selection-service.js";
import { MusicBrainzArtistCreditService } from "./musicbrainz-artist-credit-service.js";
import { getConfigSection } from "../config/config.js";

function proxyStoredArtworkUrl(...values: unknown[]): string | null {
    for (const value of values) {
        const text = value == null ? "" : String(value).trim();
        if (!text) {
            continue;
        }

        const resolved = resolveMediaCoverProxyUrl(text);
        if (resolved) {
            return registerMediaCoverProxyUrl(resolved) || resolved;
        }

        if (/^\/MediaCoverProxy\//i.test(text)) {
            continue;
        }

        return registerMediaCoverProxyUrl(text) || text;
    }

    return null;
}

function queryReleaseGroup(releaseGroupMbid: string): any | null {
    return db.prepare(`
      SELECT
        rg.*,
        a.id AS local_artist_id,
        a.name AS local_artist_name,
        a.picture AS artist_picture,
        a.cover_image_url AS artist_cover_image_url,
        a.monitored AS artist_monitor,
        CASE WHEN COALESCE(stereo.monitored, 0) = 1 OR COALESCE(spatial.monitored, 0) = 1 THEN 1 ELSE 0 END AS wanted,
        CASE WHEN COALESCE(stereo.monitored_lock, 0) = 1 OR COALESCE(spatial.monitored_lock, 0) = 1 THEN 1 ELSE 0 END AS monitored_lock,
        COALESCE(stereo.selected_provider, spatial.selected_provider) AS selected_provider,
        COALESCE(stereo.selected_provider_id, spatial.selected_provider_id) AS selected_provider_id,
        COALESCE(stereo.selected_release_mbid, spatial.selected_release_mbid) AS selected_release_mbid,
        COALESCE(stereo.quality, spatial.quality) AS selected_quality,
        stereo.selected_provider AS stereo_provider,
        stereo.selected_provider_id AS stereo_provider_id,
        stereo.selected_release_mbid AS stereo_release_mbid,
        stereo.quality AS stereo_quality,
        stereo.match_status AS stereo_match_status,
        spatial.selected_provider AS spatial_provider,
        spatial.selected_provider_id AS spatial_provider_id,
        spatial.selected_release_mbid AS spatial_release_mbid,
        spatial.quality AS spatial_quality,
        spatial.match_status AS spatial_match_status,
        stereo.provider_data AS stereo_provider_data,
        spatial.provider_data AS spatial_provider_data
      FROM Albums rg
      LEFT JOIN Artists a ON a.mbid = rg.artist_mbid
      LEFT JOIN ReleaseGroupSlots stereo
        ON stereo.release_group_mbid = rg.mbid
       AND stereo.slot = 'stereo'
      LEFT JOIN ReleaseGroupSlots spatial
        ON spatial.release_group_mbid = rg.mbid
       AND spatial.slot = 'spatial'
      WHERE rg.mbid = ?
    `).get(releaseGroupMbid) as any | null;
}

function selectPreferredRelease(releaseGroupMbid: string): any | null {
    const selectedSlot = db.prepare(`
        SELECT selected_release_mbid
        FROM ReleaseGroupSlots
        WHERE release_group_mbid = ?
          AND selected_release_mbid IS NOT NULL
        ORDER BY CASE slot WHEN 'stereo' THEN 0 ELSE 1 END
        LIMIT 1
    `).get(releaseGroupMbid) as { selected_release_mbid?: string | null } | undefined;
    if (selectedSlot?.selected_release_mbid) {
        const selectedRelease = db.prepare("SELECT * FROM AlbumReleases WHERE mbid = ?")
            .get(selectedSlot.selected_release_mbid) as any | null;
        if (selectedRelease) {
            return selectedRelease;
        }
    }

    const selected = MusicBrainzReleaseSelectionService.selectRepresentativeRelease(releaseGroupMbid);
    return selected
        ? db.prepare("SELECT * FROM AlbumReleases WHERE mbid = ?").get(selected.mbid) as any | null
        : null;
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

function splitProviderAlbumIds(value: unknown): string[] {
    return String(value || "")
        .split(/[;+]/)
        .map((part) => part.trim())
        .filter(Boolean);
}

function formatReleaseVersionLabel(release: any): string | null {
    const country = formatReleaseCountry(release.country);
    const parts = [
        release.disambiguation ? String(release.disambiguation) : null,
        release.status ? String(release.status) : null,
        country,
        Number(release.media_count || 0) > 1 ? `${Number(release.media_count)} media` : null,
        Number(release.track_count || 0) > 0 ? `${Number(release.track_count)} tracks` : null,
    ].filter((part): part is string => Boolean(part));

    return parts.length > 0 ? parts.join(" · ") : null;
}

function formatReleaseCountry(value: unknown): string | null {
    const raw = String(value || "").trim();
    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            const countries = parsed.map(formatReleaseCountry).filter((country): country is string => Boolean(country));
            return countries.length > 0 ? countries.join(", ") : null;
        }
    } catch {
        // Continue with scalar normalization below.
    }

    const withoutBrackets = raw.replace(/^\[+|\]+$/g, "").trim();
    if (!withoutBrackets) {
        return null;
    }

    return withoutBrackets.toLowerCase() === "worldwide" ? "Worldwide" : withoutBrackets;
}

function listMusicBrainzReleaseVersions(
    releaseGroup: any,
    coverUrl?: string | null,
): AlbumVersionContract[] {
    const includeSpatial = getConfigSection("filtering").include_spatial === true;
    const releases = db.prepare(`
      SELECT
        r.mbid,
        r.title,
        r.status,
        r.country,
        r.date,
        r.media_count,
        r.track_count,
        r.barcode,
        r.disambiguation,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM AlbumReleaseMedia m
            WHERE m.release_mbid = r.mbid
              AND LOWER(COALESCE(m.format, '')) LIKE '%digital%'
          ) THEN 1 ELSE 0
        END AS digital_score
      FROM AlbumReleases r
      WHERE r.release_group_mbid = ?
      ORDER BY
        digital_score DESC,
        CASE LOWER(COALESCE(r.status, '')) WHEN 'official' THEN 0 ELSE 1 END ASC,
        COALESCE(r.track_count, 0) DESC,
        (r.date IS NULL) ASC,
        r.date DESC,
        r.country ASC,
        r.mbid ASC
    `).all(releaseGroup.mbid) as any[];

    const imageUrl = coverUrl ?? chooseReleaseGroupArtwork(releaseGroup);
    const providerCoverUrl = chooseReleaseGroupProviderArtwork(releaseGroup);
    const artistName = String(releaseGroup.local_artist_name || "Unknown Artist");
    const providerOffers = db.prepare(`
      SELECT
        provider,
        provider_id,
        release_mbid,
        library_slot,
        quality,
        match_status,
        match_confidence,
        match_evidence
      FROM ProviderItems
      WHERE entity_type = 'album'
        AND release_group_mbid = ?
        AND match_status IN ('verified', 'probable')
      ORDER BY
        CASE match_status WHEN 'verified' THEN 0 WHEN 'probable' THEN 1 ELSE 2 END ASC,
        COALESCE(match_confidence, 0) DESC,
        CASE UPPER(COALESCE(quality, ''))
          WHEN 'HIRES_LOSSLESS' THEN 0
          WHEN 'HI_RES_LOSSLESS' THEN 0
          WHEN 'DOLBY_ATMOS' THEN 0
          WHEN 'LOSSLESS' THEN 1
          ELSE 2
        END ASC,
        provider_id ASC
    `).all(releaseGroup.mbid) as Array<{
        provider: string | null;
        provider_id: string | number | null;
        release_mbid: string | null;
        library_slot: string | null;
        quality: string | null;
        match_status: string | null;
        match_confidence: number | null;
        match_evidence: string | null;
    }>;

    const compatibleReleaseMbidsForOffer = (offer: typeof providerOffers[number]): Set<string> => {
        const mbids = new Set<string>();
        const directReleaseMbid = String(offer.release_mbid || "").trim();
        if (directReleaseMbid) {
            mbids.add(directReleaseMbid);
        }
        try {
            const evidence = JSON.parse(String(offer.match_evidence || "{}"));
            const evidenceMbids = Array.isArray(evidence.availableReleaseMbids)
                ? evidence.availableReleaseMbids
                : [];
            for (const releaseMbid of evidenceMbids) {
                const normalized = String(releaseMbid || "").trim();
                if (normalized) {
                    mbids.add(normalized);
                }
            }
            const matchedReleaseMbid = String(evidence.matchedReleaseMbid || "").trim();
            if (matchedReleaseMbid) {
                mbids.add(matchedReleaseMbid);
            }
        } catch {
            // Ignore malformed match evidence; the durable release_mbid is enough.
        }
        return mbids;
    };

    const offersByReleaseMbid = new Map<string, typeof providerOffers>();
    for (const offer of providerOffers) {
        for (const releaseMbid of compatibleReleaseMbidsForOffer(offer)) {
            const offers = offersByReleaseMbid.get(releaseMbid) || [];
            offers.push(offer);
            offersByReleaseMbid.set(releaseMbid, offers);
        }
    }

    const selectOfferForSlot = (releaseMbid: string, slot: "stereo" | "spatial") => {
        const offers = offersByReleaseMbid.get(releaseMbid) || [];
        return offers.find((offer) => String(offer.library_slot || "stereo") === slot) || null;
    };

    return releases.map((release) => {
        const releaseMbid = String(release.mbid);
        const isStereoSelected = releaseGroup.stereo_release_mbid === releaseMbid;
        const isSpatialSelected = releaseGroup.spatial_release_mbid === releaseMbid;
        const stereoOffer = isStereoSelected
            ? null
            : selectOfferForSlot(releaseMbid, "stereo");
        const spatialOffer = includeSpatial && !isSpatialSelected
            ? selectOfferForSlot(releaseMbid, "spatial")
            : null;

        return {
            id: releaseMbid,
            title: String(release.title || releaseGroup.title || "Unknown Release"),
            cover_id: imageUrl,
            provider_cover_id: providerCoverUrl,
            artist_name: artistName,
            release_date: release.date || releaseGroup.first_release_date || null,
            popularity: undefined,
            quality: null,
            explicit: false,
            is_monitored: Boolean(releaseGroup.wanted),
            version: formatReleaseVersionLabel(release),
            stereo_provider_id: isStereoSelected
                ? releaseGroup.stereo_provider_id || null
                : stereoOffer?.provider_id == null ? null : String(stereoOffer.provider_id),
            stereo_quality: isStereoSelected
                ? releaseGroup.stereo_quality || null
                : stereoOffer?.quality || null,
            spatial_provider_id: includeSpatial && isSpatialSelected
                ? releaseGroup.spatial_provider_id || null
                : spatialOffer?.provider_id == null ? null : String(spatialOffer.provider_id),
            spatial_quality: includeSpatial && isSpatialSelected
                ? releaseGroup.spatial_quality || null
                : spatialOffer?.quality || null,
        };
    });
}

function chooseReleaseGroupArtwork(releaseGroup: any): string | null {
    return chooseCachedAlbumArtwork({
        albumMbid: releaseGroup.mbid,
        skyHookData: parseJsonObject(releaseGroup.data),
        providerCandidates: albumProviderArtworkCandidatesFromRow(releaseGroup),
    });
}

function chooseReleaseGroupProviderArtwork(releaseGroup: any): string | null {
    return chooseCachedProviderArtwork(albumProviderArtworkCandidatesFromRow(releaseGroup), "album");
}

async function resolveReleaseGroupArtwork(releaseGroup: any): Promise<string | null> {
    return resolveHydratedReleaseGroupArtwork(releaseGroup, "MusicBrainzReleaseGroupReadService");
}

async function resolveProviderAlbumReview(releaseGroup: any): Promise<{
    review: string;
    source: string;
    updatedAt: string;
} | null> {
    const candidates = [
        {
            providerId: String(releaseGroup.stereo_provider || releaseGroup.selected_provider || "").trim(),
            providerAlbumId: String(releaseGroup.stereo_provider_id || releaseGroup.selected_provider_id || "").trim(),
        },
        {
            providerId: String(releaseGroup.spatial_provider || releaseGroup.selected_provider || "").trim(),
            providerAlbumId: String(releaseGroup.spatial_provider_id || releaseGroup.selected_provider_id || "").trim(),
        },
    ];
    const seen = new Set<string>();

    for (const candidate of candidates) {
        const key = `${candidate.providerId}:${candidate.providerAlbumId}`;
        if (!candidate.providerId || !candidate.providerAlbumId || seen.has(key)) {
            continue;
        }
        seen.add(key);

        try {
            const provider = streamingProviderManager.getStreamingProvider(candidate.providerId);
            const review = await provider.getAlbumReview?.(candidate.providerAlbumId);
            const trimmed = String(review || "").trim();
            if (trimmed) {
                return {
                    review: trimmed,
                    source: provider.id,
                    updatedAt: new Date().toISOString(),
                };
            }
        } catch {
            // provider editorial metadata is best-effort; canonical MB data still loads.
        }
    }

    return null;
}

export function normalizeMusicBrainzReleaseGroupAlbum(
    releaseGroup: any,
    release: any | null,
    resolvedCoverUrl?: string | null,
): AlbumContract {
    const includeSpatial = getConfigSection("filtering").include_spatial === true;
    const primaryType = String(releaseGroup.primary_type || "Album").trim().toUpperCase();
    const fallbackArtistId = releaseGroup.local_artist_id == null
        ? String(releaseGroup.artist_mbid)
        : String(releaseGroup.local_artist_id);
    const albumArtists = MusicBrainzArtistCreditService.getAlbumArtists(String(releaseGroup.mbid))
        .map((artist) => ({
            id: artist.artistId,
            name: artist.name,
            join_phrase: artist.joinPhrase,
            picture: proxyStoredArtworkUrl(artist.picture, artist.coverImageUrl),
            cover_image_url: proxyStoredArtworkUrl(artist.coverImageUrl),
        }));
    const artistId = albumArtists[0]?.id || fallbackArtistId;
    const artistName = albumArtists.length > 0
        ? albumArtists.map((artist) => `${artist.name}${artist.join_phrase}`).join("")
        : String(releaseGroup.local_artist_name || "Unknown Artist");
    const coverUrl = resolvedCoverUrl ?? chooseReleaseGroupArtwork(releaseGroup);
    const providerCoverUrl = chooseReleaseGroupProviderArtwork(releaseGroup);

    return {
        id: String(releaseGroup.mbid),
        title: String(releaseGroup.title || "Unknown Album"),
        cover_id: coverUrl,
        cover: coverUrl,
        cover_art_url: coverUrl,
        provider_cover_id: providerCoverUrl,
        vibrant_color: null,
        release_date: releaseGroup.first_release_date || null,
        type: primaryType === "EP" || primaryType === "SINGLE" ? primaryType : "ALBUM",
        album_type: primaryType === "EP" || primaryType === "SINGLE" ? primaryType : "ALBUM",
        quality: "",
        stereo_provider: releaseGroup.stereo_provider || null,
        stereo_provider_id: releaseGroup.stereo_provider_id || null,
        stereo_quality: releaseGroup.stereo_quality || null,
        stereo_match_status: releaseGroup.stereo_match_status || null,
        stereo_release_mbid: releaseGroup.stereo_release_mbid || null,
        spatial_provider: includeSpatial ? releaseGroup.spatial_provider || null : null,
        spatial_provider_id: includeSpatial ? releaseGroup.spatial_provider_id || null : null,
        spatial_quality: includeSpatial ? releaseGroup.spatial_quality || null : null,
        spatial_match_status: includeSpatial ? releaseGroup.spatial_match_status || null : null,
        spatial_release_mbid: includeSpatial ? releaseGroup.spatial_release_mbid || null : null,
        selected_provider: releaseGroup.selected_provider || null,
        selected_provider_id: releaseGroup.selected_provider_id || null,
        selected_release_mbid: releaseGroup.selected_release_mbid || null,
        source: "musicbrainz",
        is_monitored: Boolean(releaseGroup.wanted),
        is_downloaded: false,
        downloaded: 0,
        artist_id: artistId,
        artist_name: artistName,
        album_artists: albumArtists,
        include_in_monitoring: 1,
        excluded_reason: null,
        filtered_out: 0,
        filtered_reason: null,
        redundant_of: null,
        redundant: null,
        monitored_lock: Boolean(releaseGroup.monitored_lock),
        module: primaryType,
        group_type: primaryType,
    };
}

function parseRecordingArtistCredits(recordingDataStr: string | null | undefined, trackDataStr?: string | null | undefined): Array<{ id: string; name: string; join_phrase: string }> | null {
    const tryParse = (str: string | null | undefined) => {
        if (!str) return null;
        try {
            const parsed = JSON.parse(str);
            const credits = parsed["artist-credit"] || parsed.artistCredits || parsed.artist_credits;
            if (Array.isArray(credits) && credits.length > 0) {
                return credits.map((c: any) => {
                    const artistId = c.artist?.id || c.artistId || "";
                    const name = c.name || c.artist?.name || "";
                    const joinPhrase = c.joinphrase || c.join_phrase || "";
                    return {
                        id: artistId,
                        name: name,
                        join_phrase: joinPhrase,
                    };
                }).filter(c => c.name);
            }
        } catch {
            // Ignore
        }
        return null;
    };

    const trackCredits = tryParse(trackDataStr);
    if (trackCredits) {
        return trackCredits;
    }
    return tryParse(recordingDataStr);
}

function getReleaseTrackContracts(
    releaseMbid: string,
    releaseGroupMbid: string,
    albumTitle: string,
    artistName: string,
    artistMbid: string,
    isMonitored: boolean,
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
        t.length_ms,
        r.data AS recording_data,
        t.data AS track_data
      FROM Tracks t
      LEFT JOIN Recordings r ON t.recording_mbid = r.mbid
      WHERE t.release_mbid = ?
      ORDER BY t.medium_position ASC, t.position ASC
    `).all(releaseMbid) as any[];

    return rows.map((track) => {
        const parsedCredits = parseRecordingArtistCredits(track.recording_data, track.track_data);
        const artist_credits = parsedCredits && parsedCredits.length > 0
            ? parsedCredits
            : [{ id: artistMbid, name: artistName, join_phrase: "" }];

        return {
            id: String(track.mbid),
            preview_provider: null,
            preview_provider_track_id: null,
            title: String(track.title || "Unknown Track"),
            version: null,
            duration: Math.round(Number(track.length_ms || 0) / 1000),
            track_number: Number(track.position || 0),
            volume_number: Number(track.medium_position || 1),
            quality: "",
            qualityTags: [],
            artist_name: artistName,
            artist_credits,
            album_title: albumTitle,
            musicbrainz_track_id: String(track.mbid),
            musicbrainz_recording_id: track.recording_mbid == null ? null : String(track.recording_mbid),
            musicbrainz_release_id: track.release_mbid == null ? null : String(track.release_mbid),
            downloaded: false,
            is_downloaded: false,
            is_monitored: isMonitored,
            monitored_lock: false,
            explicit: false,
            album_id: releaseGroupMbid,
            files: [],
        };
    });
}

// The album-page UI uses the same matcher as curation, so a "matched" badge can
// never disagree with the per-track availability shown below it. Adapts the
// camelCase ProviderTrack shape into the shared matcher.
function scoreProviderTrackMatch(
    track: AlbumTrackContract,
    providerTrack: ProviderTrack,
    canonicalIsrcs: Set<string> = new Set(),
): number {
    return sharedScoreTrackMatch(
        {
            recordingMbid: track.musicbrainz_recording_id ?? null,
            isrcs: canonicalIsrcs,
            title: track.title,
            trackNumber: Number(track.track_number || 0),
            volumeNumber: Number(track.volume_number || 1),
            durationSec: track.duration == null ? null : Number(track.duration),
        },
        {
            mbid: null,
            isrc: providerTrack.isrc ?? null,
            title: providerTrack.title,
            version: (providerTrack as { version?: string | null }).version ?? null,
            trackNumber: providerTrack.trackNumber ?? null,
            volumeNumber: providerTrack.volumeNumber ?? null,
            durationSec: providerTrack.duration == null ? null : Number(providerTrack.duration),
        },
    );
}

function normalizeLibraryFileFromRow(row: any) {
    return {
        id: Number(row.file_id ?? row.id),
        artist_id: row.artist_id == null ? null : String(row.artist_id),
        album_id: row.file_album_id == null ? row.album_id == null ? null : String(row.album_id) : String(row.file_album_id),
        media_id: row.file_media_id == null ? row.media_id == null ? null : String(row.media_id) : String(row.file_media_id),
        canonical_artist_mbid: row.canonical_artist_mbid == null ? null : String(row.canonical_artist_mbid),
        canonical_release_group_mbid: row.canonical_release_group_mbid == null ? null : String(row.canonical_release_group_mbid),
        canonical_release_mbid: row.canonical_release_mbid == null ? null : String(row.canonical_release_mbid),
        canonical_track_mbid: row.canonical_track_mbid == null ? null : String(row.canonical_track_mbid),
        canonical_recording_mbid: row.canonical_recording_mbid == null ? null : String(row.canonical_recording_mbid),
        provider: row.provider == null ? null : String(row.provider),
        provider_entity_type: row.provider_entity_type == null ? null : String(row.provider_entity_type),
        provider_id: row.provider_id == null ? null : String(row.provider_id),
        library_slot: row.library_slot == null ? null : String(row.library_slot),
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
    };
}

function attachCanonicalFilesToTracks(tracks: AlbumTrackContract[]): AlbumTrackContract[] {
    const trackMbids = Array.from(new Set(
        tracks
            .map((track) => String(track.musicbrainz_track_id || track.id || "").trim())
            .filter(Boolean)
    ));
    if (trackMbids.length === 0) {
        return tracks;
    }

    const placeholders = trackMbids.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT
        lf.id AS file_id,
        lf.artist_id,
        lf.album_id AS file_album_id,
        lf.media_id AS file_media_id,
        lf.canonical_artist_mbid,
        lf.canonical_release_group_mbid,
        lf.canonical_release_mbid,
        lf.canonical_track_mbid,
        lf.canonical_recording_mbid,
        lf.provider,
        lf.provider_entity_type,
        lf.provider_id,
        lf.library_slot,
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
      FROM TrackFiles lf
      WHERE lf.canonical_track_mbid IN (${placeholders})
        AND lf.file_type IN ('track', 'lyrics')
      ORDER BY lf.file_type ASC, lf.id ASC
    `).all(...trackMbids) as any[];

    if (rows.length === 0) {
        return tracks;
    }

    const filesByTrackMbid = new Map<string, any[]>();
    for (const row of rows) {
        const key = String(row.canonical_track_mbid);
        const list = filesByTrackMbid.get(key) || [];
        list.push(normalizeLibraryFileFromRow(row));
        filesByTrackMbid.set(key, list);
    }

    return tracks.map((track) => {
        const trackMbid = String(track.musicbrainz_track_id || track.id || "");
        const canonicalFiles = filesByTrackMbid.get(trackMbid) || [];
        if (canonicalFiles.length === 0) {
            return track;
        }

        const canonicalFileIds = new Set(canonicalFiles.map((file) => file.id));
        const files = [
            ...canonicalFiles,
            ...(track.files || []).filter((file) => !canonicalFileIds.has(file.id)),
        ];
        const primaryFile = canonicalFiles.find((file) => file.file_type === "track") || canonicalFiles[0];

        return {
            ...track,
            quality: primaryFile?.quality || track.quality,
            qualityTags: mergeQualityTags([primaryFile?.quality, ...(track.qualityTags || []), track.quality]),
            downloaded: true,
            is_downloaded: true,
            files,
        };
    });
}

type ProviderTrackSlot = "stereo" | "spatial" | "selected";

type ProviderTrackSelection = {
    providerId: string;
    providerAlbumId: string;
    slot: ProviderTrackSlot;
    quality: string | null;
};

type AnnotatedProviderTrack = ProviderTrack & {
    __providerId: string;
    __providerAlbumId: string;
    __slot: ProviderTrackSlot;
    __albumQuality: string | null;
    __key: string;
};

function mergeQualityTags(values: Array<string | null | undefined>): string[] {
    const seen = new Set<string>();
    return values
        .map((value) => String(value || "").trim())
        .filter((value) => {
            const key = value.toUpperCase();
            if (!value || seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
}

function providerTrackQuality(track: AnnotatedProviderTrack | null | undefined): string | null {
    return track?.quality || track?.__albumQuality || null;
}

function providerArtistCredits(track: AnnotatedProviderTrack | null | undefined): Array<{ id: string; name: string; join_phrase: string }> {
    const trackArtists = track?.artists;
    const artists = Array.isArray(trackArtists) && trackArtists.length > 0
        ? trackArtists
        : track?.artist
            ? [track.artist]
            : [];
    const seen = new Set<string>();
    const names = artists
        .map((artist) => String(artist?.name || "").trim())
        .filter((name) => {
            const key = name.toLowerCase();
            if (!name || seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });

    return names.map((name, index) => ({
        id: "",
        name,
        join_phrase: index < names.length - 1 ? ", " : "",
    }));
}

function buildProviderTrackSelections(releaseGroup: any): ProviderTrackSelection[] {
    const selections: Array<{
        providerId: string;
        providerAlbumIds: string[];
        slot: ProviderTrackSlot;
        quality: string | null;
    }> = [
        {
            providerId: String(releaseGroup.stereo_provider || releaseGroup.selected_provider || "").trim(),
            providerAlbumIds: splitProviderAlbumIds(releaseGroup.stereo_provider_id),
            slot: "stereo",
            quality: releaseGroup.stereo_quality || null,
        },
        {
            providerId: String(releaseGroup.spatial_provider || releaseGroup.selected_provider || "").trim(),
            providerAlbumIds: splitProviderAlbumIds(releaseGroup.spatial_provider_id),
            slot: "spatial",
            quality: releaseGroup.spatial_quality || null,
        },
        {
            providerId: String(releaseGroup.selected_provider || "").trim(),
            providerAlbumIds: splitProviderAlbumIds(releaseGroup.selected_provider_id),
            slot: "selected",
            quality: releaseGroup.selected_quality || null,
        },
    ];

    const unique: ProviderTrackSelection[] = [];
    const seenAlbums = new Set<string>();
    for (const selection of selections) {
        for (const providerAlbumId of selection.providerAlbumIds) {
            const key = `${selection.providerId}:${providerAlbumId}`;
            if (!selection.providerId || !providerAlbumId || seenAlbums.has(key)) {
                continue;
            }
            seenAlbums.add(key);
            unique.push({
                providerId: selection.providerId,
                providerAlbumId,
                slot: selection.slot,
                quality: selection.quality,
            });
        }
    }

    return unique;
}

function findBestProviderTrackMatch(
    track: AlbumTrackContract,
    providerTracks: AnnotatedProviderTrack[],
    unusedProviderTracks: Set<string>,
    canonicalIsrcs: Set<string> | undefined,
    slot: ProviderTrackSlot,
): { providerTrack: AnnotatedProviderTrack; score: number } | null {
    const candidates = providerTracks
        .filter((providerTrack) => providerTrack.__slot === slot && unusedProviderTracks.has(providerTrack.__key))
        .map((providerTrack) => ({
            providerTrack,
            score: scoreProviderTrackMatch(track, providerTrack, canonicalIsrcs),
        }))
        .filter((candidate) => candidate.score >= 0.55)
        .sort((left, right) => right.score - left.score);

    return candidates[0] || null;
}

async function attachProviderPreviewTracks(
    tracks: AlbumTrackContract[],
    releaseGroup: any,
): Promise<AlbumTrackContract[]> {
    const providerAlbumSelections = buildProviderTrackSelections(releaseGroup);
    if (providerAlbumSelections.length === 0 || tracks.length === 0) {
        return tracks;
    }

    try {
        const recordingIsrcs = new Map<string, Set<string>>();
        const selectRecordingIsrcs = db.prepare("SELECT isrcs FROM Recordings WHERE mbid = ?");
        for (const track of tracks) {
            const recordingMbid = String(track.musicbrainz_recording_id || "").trim();
            if (!recordingMbid || recordingIsrcs.has(recordingMbid)) {
                continue;
            }
            const row = selectRecordingIsrcs.get(recordingMbid) as { isrcs?: string | null } | undefined;
            try {
                const isrcs = JSON.parse(String(row?.isrcs || "[]")) as unknown;
                recordingIsrcs.set(
                    recordingMbid,
                    new Set(Array.isArray(isrcs)
                        ? isrcs.map((isrc) => String(isrc || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "")).filter(Boolean)
                        : []),
                );
            } catch {
                recordingIsrcs.set(recordingMbid, new Set());
            }
        }

        const providerTracks = (await Promise.all(providerAlbumSelections.map(async (selection) => {
            const provider = streamingProviderManager.getStreamingProvider(selection.providerId);
            const albumTracks = await provider.getAlbumTracks(selection.providerAlbumId);
            return albumTracks.map((track, index) => ({
                ...track,
                __providerId: selection.providerId,
                __providerAlbumId: selection.providerAlbumId,
                __slot: selection.slot,
                __albumQuality: selection.quality,
                __key: `${selection.providerId}:${selection.providerAlbumId}:${track.providerId || index}`,
            } satisfies AnnotatedProviderTrack));
        }))).flat() as AnnotatedProviderTrack[];
        const unusedProviderTracks = new Set(providerTracks.map((track) => track.__key));

        return tracks.map((track) => {
            const trackIsrcs = recordingIsrcs.get(String(track.musicbrainz_recording_id || "").trim());
            const stereoBest = findBestProviderTrackMatch(track, providerTracks, unusedProviderTracks, trackIsrcs, "stereo");
            const spatialBest = findBestProviderTrackMatch(track, providerTracks, unusedProviderTracks, trackIsrcs, "spatial");
            const selectedBest = findBestProviderTrackMatch(track, providerTracks, unusedProviderTracks, trackIsrcs, "selected");
            const bestPreview = stereoBest || selectedBest || spatialBest;

            if (!stereoBest && !spatialBest && !selectedBest) {
                return {
                    ...track,
                    qualityTags: mergeQualityTags([...(track.qualityTags || []), track.quality]),
                };
            }

            for (const best of [stereoBest, spatialBest, selectedBest]) {
                if (best) {
                    unusedProviderTracks.delete(best.providerTrack.__key);
                }
            }

            const credits = providerArtistCredits(bestPreview?.providerTrack);
            const qualityTags = mergeQualityTags([
                providerTrackQuality(spatialBest?.providerTrack),
                providerTrackQuality(stereoBest?.providerTrack),
                providerTrackQuality(selectedBest?.providerTrack),
                ...(track.qualityTags || []),
                track.quality,
            ]);
            const primaryQuality = providerTrackQuality(stereoBest?.providerTrack)
                || providerTrackQuality(selectedBest?.providerTrack)
                || providerTrackQuality(spatialBest?.providerTrack)
                || track.quality;

            return {
                ...track,
                preview_provider: bestPreview ? bestPreview.providerTrack.__providerId : track.preview_provider,
                preview_provider_track_id: bestPreview ? String(bestPreview.providerTrack.providerId) : track.preview_provider_track_id,
                quality: primaryQuality,
                qualityTags,
                artist_name: credits.length > 0
                    ? credits.map((credit) => credit.name).join(", ")
                    : track.artist_name,
                artist_credits: credits.length > 0 ? credits : track.artist_credits,
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
    const canonicalTracks = getReleaseTrackContracts(
        release.mbid,
        releaseGroup.mbid,
        album.title,
        album.artist_name,
        album.artist_id,
        Boolean(releaseGroup.wanted),
    );
    const withCanonicalFiles = attachCanonicalFilesToTracks(canonicalTracks);
    return attachProviderPreviewTracks(withCanonicalFiles, releaseGroup);
}

export class MusicBrainzReleaseGroupReadService {
    static hasReleaseGroup(releaseGroupMbid: string): boolean {
        return Boolean(queryReleaseGroup(releaseGroupMbid));
    }

    private static async loadReleaseGroup(releaseGroupMbid: string): Promise<any | null> {
        let releaseGroup = queryReleaseGroup(releaseGroupMbid);
        if (!releaseGroup) {
            try {
                const detail = await skyHookProxy.getAlbumInfo(releaseGroupMbid);
                if (detail) {
                    const artistMbid = (detail as any).artistid || (detail as any).artistId || (detail as any).ArtistId || (detail as any).Artist?.Id || (detail as any).Artist?.id || (detail as any).artists?.[0]?.id || (detail as any).artists?.[0]?.Id;
                    if (artistMbid) {
                        const artistExists = db.prepare("SELECT 1 FROM Artists WHERE mbid = ? LIMIT 1").get(artistMbid);
                        if (!artistExists) {
                            await skyHookProxy.syncArtist(artistMbid);
                        }
                        await skyHookProxy.syncReleaseGroup(releaseGroupMbid, artistMbid);
                        releaseGroup = queryReleaseGroup(releaseGroupMbid);
                    }
                }
            } catch (error) {
                console.warn(`[MusicBrainzReleaseGroupReadService] Failed to load remote MusicBrainz release group ${releaseGroupMbid}:`, error);
            }
        }

        if (!releaseGroup) {
            return null;
        }

        const releaseCount = db.prepare("SELECT COUNT(*) AS count FROM AlbumReleases WHERE release_group_mbid = ?")
            .get(releaseGroupMbid) as { count: number } | undefined;

        const parsed = parseJsonObject(releaseGroup.data);
        const isDetailed = parsed && Array.isArray(parsed.Releases || parsed.releases);

        if (Number(releaseCount?.count || 0) === 0 || !isDetailed) {
            try {
                await skyHookProxy.syncReleaseGroup(releaseGroupMbid, releaseGroup.artist_mbid);
            } catch (error) {
                console.warn(`[MusicBrainzReleaseGroupReadService] Failed to hydrate MusicBrainz release group ${releaseGroupMbid}:`, error);
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
            await resolveReleaseGroupArtwork(releaseGroup),
        );
    }

    static async getTracks(releaseGroupMbid: string): Promise<AlbumTrackContract[]> {
        const releaseGroup = await this.loadReleaseGroup(releaseGroupMbid);
        const release = releaseGroup ? selectPreferredRelease(releaseGroupMbid) : null;
        if (!releaseGroup || !release) {
            return [];
        }

        const album = normalizeMusicBrainzReleaseGroupAlbum(releaseGroup, release, await resolveReleaseGroupArtwork(releaseGroup));
        return buildReleaseGroupTrackContracts(releaseGroup, release, album);
    }

    static async getPage(releaseGroupMbid: string): Promise<AlbumPageContract | null> {
        const releaseGroup = await this.loadReleaseGroup(releaseGroupMbid);
        if (!releaseGroup) {
            return null;
        }

        const release = selectPreferredRelease(releaseGroupMbid);
        const coverUrl = await resolveReleaseGroupArtwork(releaseGroup);
        const album = normalizeMusicBrainzReleaseGroupAlbum(releaseGroup, release, coverUrl);
        const providerReview = await resolveProviderAlbumReview(releaseGroup);
        if (providerReview) {
            album.review = providerReview.review;
            album.review_text = providerReview.review;
            album.review_source = providerReview.source;
            album.review_last_updated = providerReview.updatedAt;
        }

        return {
            album,
            tracks: release
                ? await buildReleaseGroupTrackContracts(releaseGroup, release, album)
                : [],
            similarAlbums: [],
            otherVersions: listMusicBrainzReleaseVersions(releaseGroup, album.cover_id || coverUrl),
            artistPicture: album.album_artists?.[0]?.picture || proxyStoredArtworkUrl(releaseGroup.artist_picture, releaseGroup.artist_cover_image_url),
            artistCoverImageUrl: album.album_artists?.[0]?.cover_image_url || proxyStoredArtworkUrl(releaseGroup.artist_cover_image_url),
        };
    }

    static async getVersions(releaseGroupMbid: string): Promise<AlbumVersionContract[]> {
        const releaseGroup = await this.loadReleaseGroup(releaseGroupMbid);
        if (!releaseGroup) {
            return [];
        }

        return listMusicBrainzReleaseVersions(releaseGroup, await resolveReleaseGroupArtwork(releaseGroup));
    }
}
