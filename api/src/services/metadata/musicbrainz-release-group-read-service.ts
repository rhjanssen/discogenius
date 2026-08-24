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
import { AlbumTrackListNavigationService } from "../music/album-track-list-navigation-service.js";
import { libraryArtistMonitoredSelectSql } from "../music/managed-artists.js";
import { planTrackDisplayQualitySql } from "../../utils/display-quality-sql.js";
import { getReleaseGroupDownloadStatsMap } from "../download/download-state.js";

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
            FROM json_each(COALESCE(NULLIF(quality_profile.allowed_source_formats, ''), '[]')) allowed
            WHERE allowed.value = 'spatial'
          ) THEN 'spatial' ELSE 'stereo' END AS library_class,
          release.mbid AS release_mbid,
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
          (
            SELECT ${planTrackDisplayQualitySql("plan_track", "variant")}
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
          ) AS quality,
          ROW_NUMBER() OVER (
            PARTITION BY CASE WHEN EXISTS (
              SELECT 1
              FROM json_each(COALESCE(NULLIF(quality_profile.allowed_source_formats, ''), '[]')) allowed
              WHERE allowed.value = 'spatial'
            ) THEN 'spatial' ELSE 'stereo' END
            -- A Library may monitor several Editions of one Album; exactly one
            -- of them is the representative ("Primary"). The header describes
            -- *that* Edition, so it has to win. Ranking on recency alone let a
            -- supplemental pick-up Edition (a rarities disc, a Japanese
            -- bonus-track pressing) supply the album's provider, quality and
            -- selected release — contradicting the tracklist right below it.
            ORDER BY
              CASE WHEN plan.id IS NOT NULL THEN 0 ELSE 1 END,
              library_release.representative DESC,
              library_release.updated_at DESC,
              library_release.id DESC
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
        ${libraryArtistMonitoredSelectSql("a")} AS artist_monitor,
        CASE WHEN EXISTS (
          SELECT 1
          FROM LibraryAlbums library_group
          WHERE library_group.release_group_id = rg.id
        ) THEN 1 ELSE 0 END AS wanted,
        CASE WHEN EXISTS (
          SELECT 1
          FROM LibraryAlbums library_group
          WHERE library_group.release_group_id = rg.id
            AND library_group.locked = 1
        ) THEN 1 ELSE 0 END AS monitored_lock,
        COALESCE(stereo.provider, spatial.provider) AS selected_provider,
        COALESCE(stereo.provider_id, spatial.provider_id) AS selected_provider_id,
        COALESCE(stereo.release_mbid, spatial.release_mbid) AS selected_release_mbid,
        COALESCE(stereo.quality, spatial.quality) AS selected_quality,
        stereo.provider AS stereo_provider,
        stereo.provider_id AS stereo_provider_id,
        stereo.provider_url AS stereo_provider_url,
        stereo.provider_cover AS stereo_cover,
        stereo.release_mbid AS stereo_release_mbid,
        stereo.quality AS stereo_quality,
        stereo.match_status AS stereo_match_status,
        spatial.provider AS spatial_provider,
        spatial.provider_id AS spatial_provider_id,
        spatial.provider_url AS spatial_provider_url,
        spatial.provider_cover AS spatial_cover,
        spatial.release_mbid AS spatial_release_mbid,
        spatial.quality AS spatial_quality,
        spatial.match_status AS spatial_match_status
      FROM Albums rg
      LEFT JOIN ArtistMetadata a ON a.mbid = rg.artist_mbid
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
          COALESCE(library_release.representative, 0) DESC,
          CASE WHEN EXISTS (
            SELECT 1
            FROM json_each(COALESCE(NULLIF(quality_profile.allowed_source_formats, ''), '[]')) allowed
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
        EXISTS (
          SELECT 1
          FROM LibraryEditions monitored_edition
          JOIN Libraries library
            ON library.id = monitored_edition.library_id
           AND library.enabled = 1
          WHERE monitored_edition.edition_id = r.id
        ) AS is_monitored,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM json_each(CASE WHEN json_valid(r.media) THEN r.media ELSE '[]' END) m
            WHERE LOWER(COALESCE(
              CASE WHEN json_valid(m.value) THEN json_extract(m.value, '$.Format') END,
              CASE WHEN json_valid(m.value) THEN json_extract(m.value, '$.format') END,
              m.value,
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
    // Both the slot and the badge used to be correlated subqueries evaluated once
    // per accepted match — each one walking AcquisitionPlanSources →
    // SelectedAcquisitionPlans → plan tracks/libraries for a single row, and the
    // ORDER BY then re-read the correlated result. On a library with ~1300
    // artists that cost 28s inside a single album page load, on the one thread
    // better-sqlite3 shares with every other request.
    //
    // Anchoring on this release group's matches first and folding each fact in
    // one pass keeps the same answers and the same ordering.
    const providerOffers = db.prepare(`
      WITH release_group_matches AS (
        SELECT
          release_match.id AS match_id,
          release_match.match_state,
          release_match.confidence,
          provider_item.provider,
          provider_item.provider_id,
          release.mbid AS release_mbid
        FROM Albums release_group
        JOIN AlbumEditions release
          ON release.release_group_id = release_group.id
        JOIN ProviderEditionMatches release_match
          ON release_match.edition_id = release.id
         AND release_match.match_state = 'accepted'
        JOIN ProviderItems provider_item
          ON provider_item.id = release_match.provider_edition_item_id
        WHERE release_group.mbid = ?
      ),
      -- Matches acquired by a library whose profile allows spatial sources.
      spatial_matches AS (
        SELECT DISTINCT source.provider_edition_match_id AS match_id
        FROM release_group_matches
        JOIN AcquisitionPlanSources source
          ON source.provider_edition_match_id = release_group_matches.match_id
        JOIN SelectedAcquisitionPlans plan
          ON plan.id = source.plan_id
         AND plan.state = 'current'
        JOIN LibraryEditions library_release
          ON library_release.id = plan.library_edition_id
        JOIN Libraries library
          ON library.id = library_release.library_id
        JOIN quality_profiles quality_profile
          ON quality_profile.id = library.quality_profile_id
        JOIN json_each(COALESCE(NULLIF(quality_profile.allowed_source_formats, ''), '[]')) allowed
          ON allowed.value = 'spatial'
      ),
      -- Best display quality per match, from the variant each planned track selected.
      ranked_match_quality AS (
        SELECT
          source.provider_edition_match_id AS match_id,
          ${planTrackDisplayQualitySql("plan_track", "variant")} AS quality,
          ROW_NUMBER() OVER (
            PARTITION BY source.provider_edition_match_id
            ORDER BY
              CASE variant.quality_class
                WHEN 'spatial' THEN 0
                WHEN 'hires-lossless' THEN 1
                WHEN 'lossless' THEN 2
                ELSE 3
              END,
              plan_track.id
          ) AS quality_rank
        FROM release_group_matches
        JOIN AcquisitionPlanSources source
          ON source.provider_edition_match_id = release_group_matches.match_id
        JOIN SelectedAcquisitionPlans plan
          ON plan.id = source.plan_id
         AND plan.state = 'current'
        JOIN AcquisitionPlanTracks plan_track
          ON plan_track.plan_id = plan.id
        JOIN ProviderItemAudioVariants variant
          ON variant.id = plan_track.provider_audio_variant_id
      )
      SELECT
        release_group_matches.provider,
        release_group_matches.provider_id,
        release_group_matches.release_mbid,
        CASE WHEN spatial_matches.match_id IS NOT NULL THEN 'spatial' ELSE 'stereo' END AS library_class,
        match_quality.quality AS quality,
        release_group_matches.match_state AS match_status,
        release_group_matches.confidence AS match_confidence
      FROM release_group_matches
      LEFT JOIN spatial_matches
        ON spatial_matches.match_id = release_group_matches.match_id
      LEFT JOIN ranked_match_quality match_quality
        ON match_quality.match_id = release_group_matches.match_id
       AND match_quality.quality_rank = 1
      ORDER BY
        release_group_matches.confidence DESC,
        CASE UPPER(COALESCE(match_quality.quality, ''))
          WHEN 'HIRES_LOSSLESS' THEN 0
          WHEN 'HI_RES_LOSSLESS' THEN 0
          WHEN 'DOLBY_ATMOS' THEN 0
          WHEN 'LOSSLESS' THEN 1
          ELSE 2
        END ASC,
        release_group_matches.provider_id ASC
    `).all(releaseGroup.mbid) as Array<{
        provider: string | null;
        provider_id: string | number | null;
        release_mbid: string | null;
        library_class: string | null;
        quality: string | null;
        match_status: string | null;
        match_confidence: number | null;
    }>;

    const offersByReleaseMbid = new Map<string, typeof providerOffers>();
    for (const offer of providerOffers) {
        const releaseMbid = String(offer.release_mbid || "").trim();
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
            // Unknown, not clean — see the track contract above.
            // A version is one exact Edition. Album membership alone does not
            // monitor every version of that Album; only a LibraryEditions row
            // does. Reporting the release-group state here made all 24 Bad
            // Blood editions claim to be monitored after one album-level click.
            is_monitored: Boolean(release.is_monitored),
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

function applyAlbumDownloadStats(album: AlbumContract): AlbumContract {
    const stats = getReleaseGroupDownloadStatsMap([album.id]).get(album.id);
    if (!stats) {
        return album;
    }
    album.is_downloaded = stats.isDownloaded;
    album.downloaded = stats.downloadedPercent;
    album.track_file_count = stats.downloadedTracks;
    album.track_count = stats.totalTracks;
    return album;
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
        t.release_mbid,
        t.title,
        t.number,
        t.position,
        t.medium_position,
        t.length_ms,
        r.credits AS recording_credits
      FROM Tracks t
      LEFT JOIN Recordings r ON t.recording_mbid = r.mbid
      WHERE t.release_mbid = ?
        AND r.is_video = 0
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
            musicbrainz_release_id: track.release_mbid == null ? null : String(track.release_mbid),
            downloaded: false,
            is_downloaded: false,
            is_monitored: isMonitored,
            monitored_lock: false,
            // MusicBrainz does not record explicitness. Omitting it keeps the
            // field unknown; asserting false would describe every canonical
            // track as affirmatively clean. Providers supply the real value on
            // the plan, which is tri-state.
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

function isSpatialLibraryFile(file: { library_slot?: string | null; quality?: string | null }): boolean {
    const slot = String(file.library_slot || "").trim().toLowerCase();
    if (slot === "spatial") return true;
    const quality = String(file.quality || "").toUpperCase();
    return quality.includes("ATMOS") || quality.includes("SPATIAL") || quality.includes("SONY_360");
}

function stereoFileQualityRank(quality: string | null | undefined): number {
    const normalized = String(quality || "").toUpperCase();
    if (normalized.includes("HIRES") || normalized.includes("HI_RES")) return 3;
    if (normalized.includes("LOSSLESS")) return 2;
    if (normalized) return 1;
    return 0;
}

function pickBestAudioFile<T extends { quality?: string | null }>(files: T[]): T[] {
    if (files.length <= 1) return files;
    return [files.reduce((best, file) => (
        stereoFileQualityRank(file.quality) > stereoFileQualityRank(best.quality) ? file : best
    ))];
}

/**
 * One stereo file and one spatial file per track row. Sibling editions of the
 * same album routinely share a recording (Dutch CD + 10th anniversary ALAC +
 * a hi-res FLAC in another folder). Painting every copy onto this tracklist
 * made Local Files show HIGH and MAX for one stereo library.
 *
 * Prefer files that belong to the displayed edition. If that edition has none,
 * keep the best remaining stereo copy so a monitored edition is not blank when
 * the files were imported under a sibling release.
 */
function collapseLocalAudioFilesForEdition<T extends {
    file_type?: string | null;
    library_slot?: string | null;
    quality?: string | null;
    canonical_release_mbid?: string | null;
    canonical_track_mbid?: string | null;
}>(
    files: T[],
    targetReleaseMbid: string,
    trackMbidsSet: Set<string>,
): T[] {
    const lyrics: T[] = [];
    const spatial: T[] = [];
    const stereo: T[] = [];
    for (const file of files) {
        if (String(file.file_type || "track") === "lyrics") {
            lyrics.push(file);
        } else if (isSpatialLibraryFile(file)) {
            spatial.push(file);
        } else {
            stereo.push(file);
        }
    }

    const belongsToDisplayedEdition = (file: T): boolean => {
        const releaseMbid = String(file.canonical_release_mbid || "").trim();
        const trackMbid = String(file.canonical_track_mbid || "").trim();
        return (releaseMbid !== "" && releaseMbid === targetReleaseMbid)
            || (trackMbid !== "" && trackMbidsSet.has(trackMbid));
    };

    const ownedStereo = stereo.filter(belongsToDisplayedEdition);
    return [
        ...pickBestAudioFile(ownedStereo.length > 0 ? ownedStereo : stereo),
        ...pickBestAudioFile(spatial),
        ...lyrics,
    ];
}

function attachCanonicalFilesToTracks(
    tracks: AlbumTrackContract[],
    releaseGroupMbid: string,
    targetReleaseMbid: string,
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
        lf.artist_metadata_id,
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
    // Editions of this release group that the album page renders as their own
    // tab — i.e. the ones a file could be shown under instead of here.
    const editionsWithTabs = new Set(
        (db.prepare(`
          SELECT DISTINCT edition.mbid
          FROM LibraryEditions monitored
          JOIN AlbumEditions edition ON edition.id = monitored.edition_id
          WHERE edition.release_group_mbid = ?
        `).all(releaseGroupMbid) as Array<{ mbid: string }>).map((row) => String(row.mbid)),
    );
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
                // A file was acquired for ONE edition. Attaching it by recording
                // to every edition of the group put another tab's file — and its
                // provider — on this tracklist, the same leak the planned offers
                // had.
                //
                // But "belongs to a different edition" is not by itself the
                // test, because the stereo and spatial libraries routinely
                // monitor *different* editions of one album: an Atmos file
                // carries the spatial edition's MBID and still belongs beside
                // the stereo tracklist, which is the only place it can be shown.
                //
                // The distinction that matters is whether the file's edition has
                // a tab of its own. If it does, that is where it belongs; if it
                // does not — an unmonitored edition, or none recorded — this
                // tracklist is the only place it can appear.
                const fileReleaseMbid = file.canonical_release_mbid == null
                    ? ""
                    : String(file.canonical_release_mbid).trim();
                if (
                    fileReleaseMbid
                    && fileReleaseMbid !== targetReleaseMbid
                    && editionsWithTabs.has(fileReleaseMbid)
                ) {
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
        const files = collapseLocalAudioFilesForEdition(
            [
                ...canonicalFiles,
                ...(track.files || []).filter((file) => !canonicalFileIds.has(file.id)),
            ],
            targetReleaseMbid,
            trackMbidsSet,
        );
        const primaryFile = files.find((file) => file.file_type === "track") || files[0];

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

/**
 * Planned offers for ONE edition's tracklist.
 *
 * Two different scopes meet here and only one of them is the release group:
 *
 *  - the **target** is a single edition. An acquisition plan belongs to a
 *    LibraryEdition, so the tracklist under an edition tab must show that
 *    edition's plan and no other. Loading every plan in the release group and
 *    then attaching by recording made sibling editions bleed into each other -
 *    editions of one album share most of their recordings, so a track on the
 *    standard edition would display the deluxe edition's offer, and an edition
 *    with no plan at all would display offers it cannot acquire.
 *  - the **source** is deliberately unrestricted. The planner anchors on
 *    Recordings, so a provider album matched to a sibling edition can and
 *    should supply this edition's tracks; that is what every composite plan is
 *    made of. Scoping the source too is what produced "full coverage but no
 *    offers".
 */
function loadPlannedTrackOffers(releaseGroupMbid: string, targetReleaseMbid: string): PlannedTrackOffer[] {
    return db.prepare(`
      WITH ranked_offers AS (
        SELECT
          track.mbid AS track_mbid,
          recording.mbid AS recording_mbid,
          CASE WHEN EXISTS (
            SELECT 1
            FROM json_each(COALESCE(NULLIF(quality_profile.allowed_source_formats, ''), '[]')) allowed
            WHERE allowed.value = 'spatial'
          ) THEN 'spatial' ELSE 'stereo' END AS library_class,
          provider_release.provider AS provider,
          provider_release.provider_id AS provider_album_id,
          provider_release.provider_url AS provider_album_url,
          provider_track.provider_id AS provider_track_id,
          provider_track.provider_url AS provider_track_url,
          ${planTrackDisplayQualitySql("plan_track", "audio_variant")} AS quality,
          release.mbid AS selected_release_mbid,
          release_match.match_state AS match_status,
          ROW_NUMBER() OVER (
            PARTITION BY
              COALESCE(track.recording_id, track.id),
              CASE WHEN EXISTS (
                SELECT 1
                FROM json_each(COALESCE(NULLIF(quality_profile.allowed_source_formats, ''), '[]')) allowed
                WHERE allowed.value = 'spatial'
              ) THEN 'spatial' ELSE 'stereo' END
            ORDER BY library_release.updated_at DESC, plan_track.id DESC
          ) AS offer_rank
        FROM AcquisitionPlanTracks plan_track
        JOIN SelectedAcquisitionPlans plan
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
        -- Deliberately NOT "AND track_match.track_id = plan_track.track_id".
        -- The planner anchors on Recordings, so a provider album matched to
        -- edition A can legitimately supply a Track of edition B: the match's
        -- track_id is the *source* Track it was bound to, while the plan's
        -- track_id is the canonical target. Requiring them to be equal drops
        -- every cross-edition offer — which is every composite plan and most
        -- single-source ones — leaving a full-coverage plan looking like a
        -- tracklist with no offers at all.
        JOIN ProviderTrackMatches track_match
          ON track_match.id = plan_track.provider_track_match_id
         AND track_match.provider_edition_match_id = release_match.id
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
          -- The plan being rendered is this edition's, not a sibling's.
          AND release.mbid = ?
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
    `).all(releaseGroupMbid, targetReleaseMbid) as PlannedTrackOffer[];
}

function attachProviderPreviewTracks(
    tracks: AlbumTrackContract[],
    releaseGroup: any,
    targetReleaseMbid: string,
): AlbumTrackContract[] {
    if (tracks.length === 0) return tracks;

    const offers = loadPlannedTrackOffers(String(releaseGroup.mbid), targetReleaseMbid);
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
    const withCanonicalFiles = attachCanonicalFilesToTracks(canonicalTracks, releaseGroup.mbid, String(release.mbid));
    return attachProviderPreviewTracks(withCanonicalFiles, releaseGroup, String(release.mbid));
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
                        const artistExists = db.prepare("SELECT 1 FROM ArtistMetadata WHERE mbid = ? LIMIT 1").get(artistMbid);
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

        return applyAlbumDownloadStats(normalizeMusicBrainzReleaseGroupAlbum(
            releaseGroup,
            selectPreferredRelease(releaseGroupMbid),
            await resolveReleaseGroupArtwork(releaseGroup),
        ));
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

    /**
     * The complete canonical track list of ONE Edition.
     *
     * `getTracks` answers for whichever Edition the Library happens to prefer,
     * which is the wrong question when an Album is monitored as two Editions
     * whose recordings do not nest — the page then needs a list per Edition and
     * has to be able to ask for each by name.
     *
     * Canonical means canonical: every Track of the Edition is returned,
     * including the ones no provider can currently deliver. Trimming the list to
     * provider coverage would redefine the Edition as the subset somebody
     * happens to sell.
     */
    static async getEditionTracks(
        releaseGroupMbid: string,
        editionId: number,
    ): Promise<AlbumTrackContract[]> {
        const releaseGroup = await this.loadReleaseGroup(releaseGroupMbid);
        if (!releaseGroup) return [];

        const release = db.prepare(`
            SELECT edition.*
            FROM AlbumEditions edition
            JOIN Albums release_group ON release_group.id = edition.release_group_id
            WHERE edition.id = ? AND release_group.mbid = ?
        `).get(editionId, releaseGroupMbid) as any | undefined;
        if (!release) return [];

        const album = normalizeMusicBrainzReleaseGroupAlbum(
            releaseGroup,
            release,
            await resolveReleaseGroupArtwork(releaseGroup),
        );
        return buildReleaseGroupTrackContracts(releaseGroup, release, album);
    }

    static async getPage(releaseGroupMbid: string): Promise<AlbumPageContract | null> {
        const releaseGroup = await this.loadReleaseGroup(releaseGroupMbid);
        if (!releaseGroup) {
            return null;
        }

        const release = selectPreferredRelease(releaseGroupMbid);
        const coverUrl = await resolveReleaseGroupArtwork(releaseGroup);
        const album = applyAlbumDownloadStats(
            normalizeMusicBrainzReleaseGroupAlbum(releaseGroup, release, coverUrl),
        );
        const providerReview = await resolveProviderAlbumReview(releaseGroup);
        if (providerReview) {
            album.review = providerReview.review;
            album.review_text = providerReview.review;
            album.review_source = providerReview.source;
            album.review_last_updated = providerReview.updatedAt;
        }

        const navService = new AlbumTrackListNavigationService(db);
        const navInfo = navService.getNavigationInfo(releaseGroupMbid);
        const initialRelease = navInfo.initialTrackListEditionId != null
            ? (db.prepare("SELECT * FROM AlbumEditions WHERE id = ?").get(navInfo.initialTrackListEditionId) as any || release)
            : release;

        return {
            album,
            tracks: initialRelease
                ? await buildReleaseGroupTrackContracts(releaseGroup, initialRelease, album)
                : [],
            otherVersions: listMusicBrainzReleaseVersions(releaseGroup, album.cover_id || coverUrl),
            artistPicture: album.album_artists?.[0]?.picture || localArtistArtworkUrl(releaseGroup.artist_mbid, releaseGroup.artist_picture, releaseGroup.artist_cover_image_url),
            artistCoverImageUrl: album.album_artists?.[0]?.cover_image_url || localArtistArtworkUrl(releaseGroup.artist_mbid, releaseGroup.artist_cover_image_url),
            trackListTabs: navInfo.tabs,
            initialTrackListEditionId: initialRelease ? Number(initialRelease.id) : undefined,
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

