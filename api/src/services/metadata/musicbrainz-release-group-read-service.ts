import { db } from "../../database.js";
import type { AlbumContract } from "../../contracts/catalog.js";
import type { AlbumPageContract } from "../../contracts/pages.js";
import type { AlbumTrackContract, AlbumVersionContract } from "../../contracts/media.js";
import { servarrMetadata } from "./servarr-metadata.js";
import { catalogProviderRegistry } from "../catalog/index.js";
import {
    albumCoverLocalUrl,
    albumProviderArtworkCandidatesFromRow,
    providerArtworkIdFromCandidates,
    imageContainerFromImagesColumn,
    mapArtistArtworkToLocalUrl,
} from "./media-cover-service.js";
import { resolveHydratedReleaseGroupArtwork } from "./release-group-artwork-service.js";
import { MusicBrainzReleaseSelectionService } from "./musicbrainz-release-selection-service.js";
import { MusicBrainzArtistCreditService, type CanonicalAlbumArtist } from "./musicbrainz-artist-credit-service.js";
import { getConfigSection } from "../config/config.js";

function localArtistArtworkUrl(artistMbid: string | null | undefined, ...values: unknown[]): string | null {
    return mapArtistArtworkToLocalUrl({
        artistMbid,
        sourceUrls: values.map((value) => value == null ? null : String(value)),
    });
}

function queryReleaseGroup(releaseGroupMbid: string): any | null {
    return db.prepare(`
      WITH ranked_selection AS (
        SELECT
          CASE WHEN EXISTS (
            SELECT 1
            FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
            WHERE allowed.value = 'spatial'
          ) THEN 'spatial' ELSE 'stereo' END AS library_class,
          release.mbid AS edition_mbid,
          COALESCE(provider_release.provider, plan.provider) AS provider,
          provider_release.provider_id AS provider_id,
          provider_release.provider_url AS provider_url,
          COALESCE(
            provider_release.cover_id,
            provider_release.artwork_url
          ) AS provider_cover,
          CASE
            WHEN release_match.match_state = 'accepted' THEN 'verified'
            ELSE release_match.match_state
          END AS match_status,
          COALESCE(
            (
              SELECT NULLIF(variant.provider_quality_label, '')
              FROM AcquisitionPlanTracks plan_track
              JOIN ProviderItemAudioVariants variant
                ON variant.id = plan_track.provider_audio_variant_id
              WHERE plan_track.plan_id = plan.id
              ORDER BY
                CASE variant.quality_class
                  WHEN 'spatial' THEN 0
                  WHEN 'hires-lossless' THEN 1
                  WHEN 'lossless' THEN 2
                  ELSE 3
                END,
                plan_track.id
              LIMIT 1
            ),
            (
              SELECT variant.quality_class
              FROM AcquisitionPlanTracks plan_track
              JOIN ProviderItemAudioVariants variant
                ON variant.id = plan_track.provider_audio_variant_id
              WHERE plan_track.plan_id = plan.id
              ORDER BY plan_track.id
              LIMIT 1
            )
          ) AS quality,
          ROW_NUMBER() OVER (
            PARTITION BY CASE WHEN EXISTS (
              SELECT 1
              FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
              WHERE allowed.value = 'spatial'
            ) THEN 'spatial' ELSE 'stereo' END
            ORDER BY library_release.updated_at DESC, library_release.id DESC
          ) AS selection_rank
        FROM Albums selected_group
        JOIN LibraryEditions library_release
          ON 1 = 1
        JOIN AlbumEditions release
          ON release.id = library_release.edition_id
         AND release.release_group_id = selected_group.id
        JOIN Libraries library
          ON library.id = library_release.library_id
         AND library.enabled = 1
        JOIN quality_profiles quality_profile
          ON quality_profile.id = library.quality_profile_id
        LEFT JOIN AcquisitionPlans plan
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
        WHERE selected_group.mbid = ?
      ),
      stereo AS (
        SELECT * FROM ranked_selection
        WHERE library_class = 'stereo' AND selection_rank = 1
      ),
      spatial AS (
        SELECT * FROM ranked_selection
        WHERE library_class = 'spatial' AND selection_rank = 1
      )
      SELECT
        rg.*,
        a.id AS local_artist_id,
        a.name AS local_artist_name,
        a.picture AS artist_picture,
        a.cover_image_url AS artist_cover_image_url,
        a.monitored AS artist_monitor,
        CASE WHEN EXISTS (
          SELECT 1
          FROM LibraryAlbums library_group
          WHERE library_group.release_group_id = rg.id
            AND library_group.monitored = 1
        ) THEN 1 ELSE 0 END AS wanted,
        CASE WHEN EXISTS (
          SELECT 1
          FROM LibraryAlbums library_group
          WHERE library_group.release_group_id = rg.id
            AND library_group.locked = 1
        ) THEN 1 ELSE 0 END AS monitored_lock,
        COALESCE(stereo.provider, spatial.provider) AS selected_provider,
        COALESCE(stereo.provider_id, spatial.provider_id) AS selected_provider_id,
        COALESCE(stereo.edition_mbid, spatial.edition_mbid) AS selected_release_mbid,
        COALESCE(stereo.quality, spatial.quality) AS selected_quality,
        stereo.provider AS stereo_provider,
        stereo.provider_id AS stereo_provider_id,
        stereo.provider_url AS stereo_provider_url,
        stereo.provider_cover AS stereo_cover,
        stereo.edition_mbid AS stereo_release_mbid,
        stereo.quality AS stereo_quality,
        stereo.match_status AS stereo_match_status,
        spatial.provider AS spatial_provider,
        spatial.provider_id AS spatial_provider_id,
        spatial.provider_url AS spatial_provider_url,
        spatial.provider_cover AS spatial_cover,
        spatial.edition_mbid AS spatial_release_mbid,
        spatial.quality AS spatial_quality,
        spatial.match_status AS spatial_match_status
      FROM Albums rg
      LEFT JOIN Artists a ON a.mbid = rg.artist_mbid
      LEFT JOIN stereo ON 1 = 1
      LEFT JOIN spatial ON 1 = 1
      WHERE rg.mbid = ?
    `).get(releaseGroupMbid, releaseGroupMbid) as any | null;
}

function selectPreferredRelease(releaseGroupMbid: string): any | null {
    const selectedLibraryRelease = db.prepare(`
        SELECT release.*
        FROM Albums release_group
        JOIN AlbumEditions release
          ON release.release_group_id = release_group.id
        JOIN LibraryEditions library_release
          ON library_release.edition_id = release.id
        JOIN Libraries library
          ON library.id = library_release.library_id
         AND library.enabled = 1
        JOIN quality_profiles quality_profile
          ON quality_profile.id = library.quality_profile_id
        WHERE release_group.mbid = ?
        ORDER BY
          CASE WHEN EXISTS (
            SELECT 1
            FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
            WHERE allowed.value = 'spatial'
          ) THEN 1 ELSE 0 END,
          library_release.updated_at DESC,
          library_release.id DESC
        LIMIT 1
    `).get(releaseGroupMbid) as any | null;
    if (selectedLibraryRelease) {
        return selectedLibraryRelease;
    }

    const selected = MusicBrainzReleaseSelectionService.selectRepresentativeRelease(releaseGroupMbid);
    return selected
        ? db.prepare("SELECT * FROM AlbumEditions WHERE mbid = ?").get(selected.mbid) as any | null
        : null;
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
            SELECT 1
            FROM json_each(r.media) m
            WHERE LOWER(COALESCE(
              json_extract(m.value, '$.Format'),
              json_extract(m.value, '$.format'),
              ''
            )) LIKE '%digital%'
          ) THEN 1 ELSE 0
        END AS digital_score
      FROM AlbumEditions r
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
        provider_item.provider,
        provider_item.provider_id,
        release.mbid AS edition_mbid,
        CASE WHEN EXISTS (
          SELECT 1
          FROM AcquisitionPlanSources source
          JOIN AcquisitionPlans plan
            ON plan.id = source.plan_id
           AND plan.state = 'current'
          JOIN LibraryEditions library_release
            ON library_release.id = plan.library_edition_id
          JOIN Libraries library
            ON library.id = library_release.library_id
          JOIN quality_profiles quality_profile
            ON quality_profile.id = library.quality_profile_id
          JOIN json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
          WHERE source.provider_edition_match_id = release_match.id
            AND allowed.value = 'spatial'
        ) THEN 'spatial' ELSE 'stereo' END AS library_class,
        (
          SELECT COALESCE(
            NULLIF(variant.provider_quality_label, ''),
            variant.quality_class
          )
          FROM AcquisitionPlanSources source
          JOIN AcquisitionPlans plan
            ON plan.id = source.plan_id
           AND plan.state = 'current'
          JOIN AcquisitionPlanTracks plan_track
            ON plan_track.plan_id = plan.id
          JOIN ProviderItemAudioVariants variant
            ON variant.id = plan_track.provider_audio_variant_id
          WHERE source.provider_edition_match_id = release_match.id
          ORDER BY
            CASE variant.quality_class
              WHEN 'spatial' THEN 0
              WHEN 'hires-lossless' THEN 1
              WHEN 'lossless' THEN 2
              ELSE 3
            END,
            plan_track.id
          LIMIT 1
        ) AS quality,
        release_match.match_state AS match_status,
        release_match.confidence AS match_confidence
      FROM ProviderEditionMatches release_match
      JOIN ProviderItems provider_item
        ON provider_item.id = release_match.provider_edition_item_id
      JOIN AlbumEditions release
        ON release.id = release_match.edition_id
      JOIN Albums release_group
        ON release_group.id = release.release_group_id
      WHERE release_group.mbid = ?
        AND release_match.match_state = 'accepted'
      ORDER BY
        release_match.confidence DESC,
        CASE UPPER(COALESCE(quality, ''))
          WHEN 'HIRES_LOSSLESS' THEN 0
          WHEN 'HI_RES_LOSSLESS' THEN 0
          WHEN 'DOLBY_ATMOS' THEN 0
          WHEN 'LOSSLESS' THEN 1
          ELSE 2
        END ASC,
        provider_item.provider_id ASC
    `).all(releaseGroup.mbid) as Array<{
        provider: string | null;
        provider_id: string | number | null;
        edition_mbid: string | null;
        library_class: string | null;
        quality: string | null;
        match_status: string | null;
        match_confidence: number | null;
    }>;

    const offersByReleaseMbid = new Map<string, typeof providerOffers>();
    for (const offer of providerOffers) {
        const releaseMbid = String(offer.edition_mbid || "").trim();
        if (!releaseMbid) continue;
        const offers = offersByReleaseMbid.get(releaseMbid) || [];
        offers.push(offer);
        offersByReleaseMbid.set(releaseMbid, offers);
    }

    const selectOfferForLibraryClass = (releaseMbid: string, libraryClass: "stereo" | "spatial") => {
        const offers = offersByReleaseMbid.get(releaseMbid) || [];
        return offers.find((offer) => String(offer.library_class || "stereo") === libraryClass) || null;
    };

    return releases.map((release) => {
        const releaseMbid = String(release.mbid);
        const isStereoSelected = releaseGroup.stereo_release_mbid === releaseMbid;
        const isSpatialSelected = releaseGroup.spatial_release_mbid === releaseMbid;
        const stereoOffer = isStereoSelected
            ? null
            : selectOfferForLibraryClass(releaseMbid, "stereo");
        const spatialOffer = includeSpatial && !isSpatialSelected
            ? selectOfferForLibraryClass(releaseMbid, "spatial")
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
    return albumCoverLocalUrl({
        albumMbid: releaseGroup.mbid,
        images: imageContainerFromImagesColumn(releaseGroup.images),
        providerCandidates: albumProviderArtworkCandidatesFromRow(releaseGroup),
    });
}

function chooseReleaseGroupProviderArtwork(releaseGroup: any): string | null {
    return providerArtworkIdFromCandidates(albumProviderArtworkCandidatesFromRow(releaseGroup), "album");
}

async function resolveReleaseGroupArtwork(releaseGroup: any): Promise<string | null> {
    return resolveHydratedReleaseGroupArtwork(releaseGroup, "MusicBrainzReleaseGroupReadService");
}

async function resolveProviderAlbumReview(releaseGroup: any): Promise<{
    review: string;
    source: string;
    updatedAt: string;
} | null> {
    const storedReview = String(releaseGroup.review_text || "").trim();
    if (storedReview) {
        return {
            review: storedReview,
            source: String(releaseGroup.review_source || "provider").trim() || "provider",
            updatedAt: String(releaseGroup.review_last_updated || new Date().toISOString()),
        };
    }

    // Page reads stay DB-only (Lidarr/Jellyfin). Live provider editorial fetches
    // belong on refresh/curation — never on every album navigation.
    const overview = String(releaseGroup.overview || "").trim();
    if (overview) {
        return {
            review: overview,
            source: "musicbrainz",
            updatedAt: String(releaseGroup.updated_at || new Date().toISOString()),
        };
    }

    return null;
}

export function normalizeMusicBrainzReleaseGroupAlbum(
    releaseGroup: any,
    release: any | null,
    resolvedCoverUrl?: string | null,
    preloadedAlbumArtists?: CanonicalAlbumArtist[],
): AlbumContract {
    const includeSpatial = getConfigSection("filtering").include_spatial === true;
    const primaryType = String(releaseGroup.primary_type || "Album").trim().toUpperCase();
    const fallbackArtistId = releaseGroup.local_artist_id == null
        ? String(releaseGroup.artist_mbid)
        : String(releaseGroup.local_artist_id);
    const albumArtists = (preloadedAlbumArtists ?? MusicBrainzArtistCreditService.getAlbumArtists(String(releaseGroup.mbid)))
        .map((artist) => ({
            id: artist.artistId,
            name: artist.name,
            join_phrase: artist.joinPhrase,
            picture: localArtistArtworkUrl(artist.artistId, artist.picture, artist.coverImageUrl),
            cover_image_url: localArtistArtworkUrl(artist.artistId, artist.coverImageUrl),
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
        stereo_provider_url: releaseGroup.stereo_provider_url || null,
        stereo_quality: releaseGroup.stereo_quality || null,
        stereo_match_status: releaseGroup.stereo_match_status || null,
        stereo_release_mbid: releaseGroup.stereo_release_mbid || null,
        spatial_provider: includeSpatial ? releaseGroup.spatial_provider || null : null,
        spatial_provider_id: includeSpatial ? releaseGroup.spatial_provider_id || null : null,
        spatial_provider_url: includeSpatial ? releaseGroup.spatial_provider_url || null : null,
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
        review: String(releaseGroup.review_text || releaseGroup.overview || "").trim() || null,
        review_text: String(releaseGroup.review_text || "").trim() || null,
        review_source: releaseGroup.review_source || null,
        review_last_updated: releaseGroup.review_last_updated || null,
    };
}

/**
 * Parse the structured `Recordings.credits` column (`[{id, name, join_phrase}]`)
 * into the artist-credit shape the album page uses.
 */
function parseRecordingArtistCredits(creditsStr: string | null | undefined): Array<{ id: string; name: string; join_phrase: string }> | null {
    if (!creditsStr) return null;
    try {
        const parsed = JSON.parse(creditsStr);
        if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.map((c: any) => ({
                id: c.id || c.artist?.id || c.artistId || "",
                name: c.name || c.artist?.name || "",
                join_phrase: c.join_phrase || "",
            })).filter((c) => c.name);
        }
    } catch {
        // Ignore malformed credits and fall back to the primary artist.
    }
    return null;
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
        t.edition_mbid,
        t.title,
        t.number,
        t.position,
        t.medium_position,
        t.length_ms,
        r.credits AS recording_credits
      FROM Tracks t
      LEFT JOIN Recordings r ON t.recording_mbid = r.mbid
      WHERE t.edition_mbid = ?
        AND (r.is_video IS NULL OR r.is_video = 0)
      ORDER BY t.medium_position ASC, t.position ASC
    `).all(releaseMbid) as any[];

    return rows.map((track) => {
        const parsedCredits = parseRecordingArtistCredits(track.recording_credits);
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
            musicbrainz_release_id: track.edition_mbid == null ? null : String(track.edition_mbid),
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
        video_codec: row.video_codec == null ? undefined : String(row.video_codec),
        width: row.width == null ? undefined : Number(row.width),
        height: row.height == null ? undefined : Number(row.height),
        duration: row.duration == null ? undefined : Number(row.duration),
    };
}

function attachCanonicalFilesToTracks(
    tracks: AlbumTrackContract[],
    releaseGroupMbid: string,
): AlbumTrackContract[] {
    const trackMbids = Array.from(new Set(
        tracks
            .map((track) => String(track.musicbrainz_track_id || track.id || "").trim())
            .filter(Boolean)
    ));
    const recordingMbids = Array.from(new Set(
        tracks
            .map((track) => String(track.musicbrainz_recording_id || "").trim())
            .filter(Boolean)
    ));
    if (trackMbids.length === 0 && recordingMbids.length === 0) {
        return tracks;
    }

    const matchConditions: string[] = [];
    const matchParams: string[] = [];
    if (trackMbids.length > 0) {
        matchConditions.push(`lf.canonical_track_mbid IN (${trackMbids.map(() => "?").join(",")})`);
        matchParams.push(...trackMbids);
    }
    if (recordingMbids.length > 0) {
        matchConditions.push(
            `(lf.canonical_recording_mbid IN (${recordingMbids.map(() => "?").join(",")}) AND lf.canonical_release_group_mbid = ?)`,
        );
        matchParams.push(...recordingMbids, releaseGroupMbid);
    }

    const rows = db.prepare(`
      SELECT
        lf.id AS file_id,
        lf.artist_id,
        NULL AS file_album_id,
        lf.provider_id AS file_media_id,
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
        lf.video_codec,
        lf.width,
        lf.height,
        lf.duration
      FROM TrackFiles lf
      WHERE (${matchConditions.join(" OR ")})
        AND lf.file_type IN ('track', 'lyrics')
      ORDER BY lf.file_type ASC, lf.id ASC
    `).all(...matchParams) as any[];

    if (rows.length === 0) {
        return tracks;
    }

    const trackMbidsSet = new Set(trackMbids);
    const filesByTrackMbid = new Map<string, ReturnType<typeof normalizeLibraryFileFromRow>[]>();
    const filesByRecordingMbid = new Map<string, ReturnType<typeof normalizeLibraryFileFromRow>[]>();
    for (const row of rows) {
        const file = normalizeLibraryFileFromRow(row);
        if (row.canonical_track_mbid != null && String(row.canonical_track_mbid).trim()) {
            const key = String(row.canonical_track_mbid);
            const list = filesByTrackMbid.get(key) || [];
            list.push(file);
            filesByTrackMbid.set(key, list);
        }
        if (row.canonical_recording_mbid != null && String(row.canonical_recording_mbid).trim()) {
            const key = String(row.canonical_recording_mbid);
            const list = filesByRecordingMbid.get(key) || [];
            list.push(file);
            filesByRecordingMbid.set(key, list);
        }
    }

    return tracks.map((track) => {
        const trackMbid = String(track.musicbrainz_track_id || track.id || "");
        const recordingMbid = String(track.musicbrainz_recording_id || "").trim();
        const canonicalFiles: ReturnType<typeof normalizeLibraryFileFromRow>[] = [];
        const seenFileIds = new Set<number>();

        const addFile = (file: ReturnType<typeof normalizeLibraryFileFromRow>) => {
            if (seenFileIds.has(file.id)) {
                return;
            }
            seenFileIds.add(file.id);
            canonicalFiles.push(file);
        };

        for (const file of filesByTrackMbid.get(trackMbid) || []) {
            addFile(file);
        }
        if (recordingMbid) {
            for (const file of filesByRecordingMbid.get(recordingMbid) || []) {
                const fileReleaseGroupMbid = file.canonical_release_group_mbid == null
                    ? null
                    : String(file.canonical_release_group_mbid).trim();
                if (fileReleaseGroupMbid !== releaseGroupMbid) {
                    continue;
                }
                const fileTrackMbid = file.canonical_track_mbid == null
                    ? null
                    : String(file.canonical_track_mbid).trim();
                // Spatial/Atmos files often carry a track MBID from a different
                // release in the same group; attach by recording when that track
                // is not on the displayed stereo tracklist.
                if (!fileTrackMbid || !trackMbidsSet.has(fileTrackMbid)) {
                    addFile(file);
                }
            }
        }

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

type PlannedTrackOffer = {
    track_mbid: string;
    recording_mbid: string | null;
    library_class: "stereo" | "spatial";
    provider: string;
    provider_album_id: string;
    provider_album_url: string | null;
    provider_track_id: string;
    provider_track_url: string | null;
    quality: string | null;
    selected_release_mbid: string;
    match_status: string;
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

function normalizePlannedQuality(value: string | null, libraryClass: "stereo" | "spatial"): string | null {
    const quality = String(value || "").trim();
    if (!quality) return null;
    if (libraryClass === "spatial" && /^(ATMOS|DOLBY[-_ ]?ATMOS)$/i.test(quality)) {
        return "DOLBY_ATMOS";
    }
    return quality;
}

function loadPlannedTrackOffers(releaseGroupMbid: string): PlannedTrackOffer[] {
    return db.prepare(`
      WITH ranked_offers AS (
        SELECT
          track.mbid AS track_mbid,
          recording.mbid AS recording_mbid,
          CASE WHEN EXISTS (
            SELECT 1
            FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
            WHERE allowed.value = 'spatial'
          ) THEN 'spatial' ELSE 'stereo' END AS library_class,
          provider_release.provider AS provider,
          provider_release.provider_id AS provider_album_id,
          provider_release.provider_url AS provider_album_url,
          provider_track.provider_id AS provider_track_id,
          provider_track.provider_url AS provider_track_url,
          COALESCE(
            NULLIF(audio_variant.provider_quality_label, ''),
            audio_variant.quality_class
          ) AS quality,
          release.mbid AS selected_release_mbid,
          release_match.match_state AS match_status,
          ROW_NUMBER() OVER (
            PARTITION BY
              COALESCE(track.recording_id, track.id),
              CASE WHEN EXISTS (
                SELECT 1
                FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
                WHERE allowed.value = 'spatial'
              ) THEN 'spatial' ELSE 'stereo' END
            ORDER BY library_release.updated_at DESC, plan_track.id DESC
          ) AS offer_rank
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
        JOIN Libraries library
          ON library.id = library_release.library_id
         AND library.enabled = 1
        JOIN quality_profiles quality_profile
          ON quality_profile.id = library.quality_profile_id
        JOIN Tracks track
          ON track.id = plan_track.track_id
        LEFT JOIN Recordings recording
          ON recording.id = track.recording_id
        JOIN AcquisitionPlanSources source
          ON source.id = plan_track.source_id
         AND source.plan_id = plan.id
        JOIN ProviderEditionMatches release_match
          ON release_match.id = source.provider_edition_match_id
         AND release_match.match_state = 'accepted'
        JOIN ProviderItems provider_release
          ON provider_release.id = release_match.provider_edition_item_id
        JOIN ProviderTrackMatches track_match
          ON track_match.id = plan_track.provider_track_match_id
         AND track_match.provider_edition_match_id = release_match.id
         AND track_match.track_id = plan_track.track_id
         AND track_match.match_state = 'accepted'
        JOIN ProviderEditionMembers member
          ON member.id = track_match.provider_edition_member_id
         AND member.provider_edition_item_id = provider_release.id
        JOIN ProviderItems provider_track
          ON provider_track.id = member.member_item_id
        JOIN ProviderItemAudioVariants audio_variant
          ON audio_variant.id = plan_track.provider_audio_variant_id
         AND audio_variant.provider_item_id = provider_track.id
        WHERE release_group.mbid = ?
      )
      SELECT
        track_mbid,
        recording_mbid,
        library_class,
        provider,
        provider_album_id,
        provider_album_url,
        provider_track_id,
        provider_track_url,
        quality,
        selected_release_mbid,
        match_status
      FROM ranked_offers
      WHERE offer_rank = 1
      ORDER BY
        CASE library_class WHEN 'stereo' THEN 0 ELSE 1 END,
        track_mbid
    `).all(releaseGroupMbid) as PlannedTrackOffer[];
}

function attachProviderPreviewTracks(
    tracks: AlbumTrackContract[],
    releaseGroup: any,
): AlbumTrackContract[] {
    if (tracks.length === 0) return tracks;

    const offers = loadPlannedTrackOffers(String(releaseGroup.mbid));
    if (offers.length === 0) {
        return tracks.map((track) => ({
            ...track,
            remoteOffers: [],
        }));
    }

    return tracks.map((track) => {
        const trackMbid = String(track.musicbrainz_track_id || track.id || "").trim();
        const recordingMbid = String(track.musicbrainz_recording_id || "").trim();
        const matching = offers.filter((offer) =>
            offer.track_mbid === trackMbid
            || Boolean(recordingMbid && offer.recording_mbid === recordingMbid),
        );
        const stereo = matching.find((offer) => offer.library_class === "stereo") || null;
        const spatial = matching.find((offer) => offer.library_class === "spatial") || null;
        const preview = stereo || spatial;
        if (!preview) {
            return {
                ...track,
                remoteOffers: [],
            };
        }

        const stereoQuality = stereo
            ? normalizePlannedQuality(stereo.quality, "stereo")
            : null;
        const spatialQuality = spatial
            ? normalizePlannedQuality(spatial.quality, "spatial")
            : null;
        const remoteOffers = [stereo, spatial]
            .filter((offer): offer is PlannedTrackOffer => Boolean(offer))
            .map((offer) => ({
                slot: offer.library_class,
                provider: offer.provider,
                providerAlbumId: offer.provider_album_id,
                ...(offer.provider_album_url
                    ? { providerUrl: offer.provider_album_url }
                    : {}),
                quality: normalizePlannedQuality(offer.quality, offer.library_class),
                matchStatus: offer.match_status === "accepted" ? "verified" : offer.match_status,
                selectedReleaseMbid: offer.selected_release_mbid,
                providerTrackId: offer.provider_track_id,
                ...(offer.provider_track_url
                    ? { providerTrackUrl: offer.provider_track_url }
                    : {}),
            }));

        return {
            ...track,
            preview_provider: preview.provider,
            preview_provider_track_id: preview.provider_track_id,
            quality: stereoQuality || spatialQuality || track.quality,
            qualityTags: mergeQualityTags([
                spatialQuality,
                stereoQuality,
                ...(track.qualityTags || []),
                track.quality,
            ]),
            remoteOffers,
        };
    });
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
    const withCanonicalFiles = attachCanonicalFilesToTracks(canonicalTracks, releaseGroup.mbid);
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
                const detail = await catalogProviderRegistry.getActive().getReleaseGroup(releaseGroupMbid);
                if (detail) {
                    const artistMbid = (detail as any).artistid || (detail as any).artistId || (detail as any).ArtistId || (detail as any).Artist?.Id || (detail as any).Artist?.id || (detail as any).artists?.[0]?.id || (detail as any).artists?.[0]?.Id;
                    if (artistMbid) {
                        const artistExists = db.prepare("SELECT 1 FROM Artists WHERE mbid = ? LIMIT 1").get(artistMbid);
                        if (!artistExists) {
                            await servarrMetadata.syncArtist(artistMbid);
                        }
                        await servarrMetadata.syncReleaseGroup(releaseGroupMbid, artistMbid);
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

        // Hydrate only when the release group has no local releases yet.
        // Re-syncing on every album-page GET always paid a remote catalog round
        // trip even when content_hash would skip the write (Lidarr/Jellyfin keep
        // detail GETs DB-only; freshness is the refresh/scheduler path).
        const releaseCount = db.prepare(
            "SELECT COUNT(*) AS count FROM AlbumEditions WHERE release_group_mbid = ?",
        ).get(releaseGroupMbid) as { count?: number } | undefined;

        if (Number(releaseCount?.count || 0) === 0) {
            try {
                await servarrMetadata.syncReleaseGroup(releaseGroupMbid, releaseGroup.artist_mbid);
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
            otherVersions: listMusicBrainzReleaseVersions(releaseGroup, album.cover_id || coverUrl),
            artistPicture: album.album_artists?.[0]?.picture || localArtistArtworkUrl(releaseGroup.artist_mbid, releaseGroup.artist_picture, releaseGroup.artist_cover_image_url),
            artistCoverImageUrl: album.album_artists?.[0]?.cover_image_url || localArtistArtworkUrl(releaseGroup.artist_mbid, releaseGroup.artist_cover_image_url),
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

