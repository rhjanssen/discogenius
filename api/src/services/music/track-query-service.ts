import { db } from "../../database.js";
import type { AlbumTrackContract, LibraryFileContract, TrackRemoteOfferContract } from "../../contracts/media.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";
import { getConfigSection } from "../config/config.js";
import { albumCoverLocalUrl, imageContainerFromImagesColumn } from "../metadata/media-cover-service.js";
import { TrackLibraryIndexService } from "./track-library-index-service.js";
import { qualityTierSqlCondition } from "../../utils/quality-tier-sql.js";

const canonicalTrackDownloadedPredicate = `
  EXISTS (
    SELECT 1
    FROM TrackFiles downloaded_file
    WHERE downloaded_file.track_id = track.id
      AND (downloaded_file.file_class = 'audio' OR downloaded_file.file_type = 'track')
  )
`;

const canonicalTrackMonitoredPredicate = `
  EXISTS (
    SELECT 1
    FROM LibraryAlbums monitored_group
    JOIN Libraries monitored_library
      ON monitored_library.id = monitored_group.library_id
     AND monitored_library.enabled = 1
    WHERE monitored_group.release_group_id = release_group.id
  )
`;

const canonicalTrackSpatialQualityPredicate = `
  (
    EXISTS (
      SELECT 1
      FROM AcquisitionPlanTracks spatial_plan_track
      JOIN SelectedAcquisitionPlans spatial_plan
        ON spatial_plan.id = spatial_plan_track.plan_id
       AND spatial_plan.state = 'current'
      JOIN LibraryEditions spatial_library_release
        ON spatial_library_release.id = spatial_plan.library_edition_id
      JOIN Libraries spatial_library
        ON spatial_library.id = spatial_library_release.library_id
       AND spatial_library.enabled = 1
      JOIN quality_profiles spatial_profile
        ON spatial_profile.id = spatial_library.quality_profile_id
      WHERE spatial_plan_track.track_id = track.id
        AND EXISTS (
          SELECT 1
          FROM json_each(COALESCE(spatial_profile.allowed_source_formats, '[]')) allowed
          WHERE allowed.value = 'spatial'
        )
    )
    OR EXISTS (
      SELECT 1
      FROM TrackFiles spatial_file
      JOIN Libraries spatial_library
        ON spatial_library.id = spatial_file.library_id
       AND spatial_library.enabled = 1
      JOIN quality_profiles spatial_profile
        ON spatial_profile.id = spatial_library.quality_profile_id
      WHERE spatial_file.track_id = track.id
        AND EXISTS (
          SELECT 1
          FROM json_each(COALESCE(spatial_profile.allowed_source_formats, '[]')) allowed
          WHERE allowed.value = 'spatial'
        )
    )
  )
`;

const canonicalTrackStereoQualityPredicate = `
  (
    EXISTS (
      SELECT 1
      FROM AcquisitionPlanTracks stereo_plan_track
      JOIN SelectedAcquisitionPlans stereo_plan
        ON stereo_plan.id = stereo_plan_track.plan_id
       AND stereo_plan.state = 'current'
      JOIN LibraryEditions stereo_library_release
        ON stereo_library_release.id = stereo_plan.library_edition_id
      JOIN Libraries stereo_library
        ON stereo_library.id = stereo_library_release.library_id
       AND stereo_library.enabled = 1
      JOIN quality_profiles stereo_profile
        ON stereo_profile.id = stereo_library.quality_profile_id
      WHERE stereo_plan_track.track_id = track.id
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(COALESCE(stereo_profile.allowed_source_formats, '[]')) allowed
          WHERE allowed.value = 'spatial'
        )
    )
    OR EXISTS (
      SELECT 1
      FROM TrackFiles stereo_file
      JOIN Libraries stereo_library
        ON stereo_library.id = stereo_file.library_id
       AND stereo_library.enabled = 1
      JOIN quality_profiles stereo_profile
        ON stereo_profile.id = stereo_library.quality_profile_id
      WHERE stereo_file.track_id = track.id
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(COALESCE(stereo_profile.allowed_source_formats, '[]')) allowed
          WHERE allowed.value = 'spatial'
        )
    )
  )
`;

export interface TrackRow {
  id: number | string;
  track_row_id?: number;
  album_id: number | string | null;
  title: string;
  version?: string | null;
  duration: number;
  track_number: number;
  volume_number: number;
  quality: string;
  quality_tags?: string | null;
  remote_offers?: string | null;
  artist_name?: string;
  artist_id?: number | string | null;
  album_title?: string;
  album_cover?: string | null;
  album_images?: string | null;
  explicit?: boolean | number;
  is_monitored?: boolean | number;
  monitored_lock?: boolean | number;
  release_date?: string | null;
  popularity?: number | null;
  last_scanned?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  recording_credits?: string | null;
  preview_provider?: string | null;
  preview_provider_track_id?: string | null;
  musicbrainz_track_id?: string | null;
  musicbrainz_recording_id?: string | null;
  musicbrainz_release_id?: string | null;
  is_downloaded?: boolean | number;
}

interface LibraryFileRow {
  id: number;
  linked_track_mbid?: string | null;
  media_id: number | string | null;
  canonical_artist_mbid?: string | null;
  canonical_release_group_mbid?: string | null;
  canonical_release_mbid?: string | null;
  canonical_track_mbid?: string | null;
  canonical_recording_mbid?: string | null;
  provider?: string | null;
  provider_entity_type?: string | null;
  provider_id?: string | null;
  library_slot?: string | null;
  file_type: string;
  file_path: string;
  relative_path?: string;
  filename?: string;
  extension?: string;
  quality?: string | null;
  library_root?: string;
  file_size?: number;
  bitrate?: number;
  sample_rate?: number;
  bit_depth?: number;
  channels?: number;
  codec?: string;
  video_codec?: string;
  width?: number;
  height?: number;
  duration?: number;
  created_at?: string;
  modified_at?: string;
}

type SortableTrackField = "name" | "popularity" | "scannedAt" | "releaseDate";

export interface ListTracksQuery {
  limit: number;
  offset: number;
  search?: string;
  monitored?: boolean;
  downloaded?: boolean;
  locked?: boolean;
  libraryFilter?: string;
  provider?: string;
  qualityTier?: string;
  sort?: string;
  dir?: string;
}

interface TracksListResponse {
  items: AlbumTrackContract[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface TrackFileDetails extends LibraryFileContract {
  created_at?: string;
  modified_at?: string;
}

function normalizeLibraryFileRow(file: LibraryFileRow): LibraryFileContract {
  return {
    id: file.id,
    media_id: file.media_id == null ? null : String(file.media_id),
    canonical_artist_mbid: file.canonical_artist_mbid ?? null,
    canonical_release_group_mbid: file.canonical_release_group_mbid ?? null,
    canonical_release_mbid: file.canonical_release_mbid ?? null,
    canonical_track_mbid: file.canonical_track_mbid ?? null,
    canonical_recording_mbid: file.canonical_recording_mbid ?? null,
    provider: file.provider ?? null,
    provider_entity_type: file.provider_entity_type ?? null,
    provider_id: file.provider_id ?? null,
    library_slot: file.library_slot ?? null,
    file_type: file.file_type,
    file_path: file.file_path,
    relative_path: file.relative_path,
    filename: file.filename,
    extension: file.extension,
    quality: file.quality ?? null,
    library_root: file.library_root,
    file_size: file.file_size,
    bitrate: file.bitrate,
    sample_rate: file.sample_rate,
    bit_depth: file.bit_depth,
    channels: file.channels,
    codec: file.codec,
    video_codec: file.video_codec,
    width: file.width,
    height: file.height,
    duration: file.duration,
  };
}

function normalizeSortDirection(value: string | undefined): "ASC" | "DESC" {
  return String(value || "").toLowerCase() === "asc" ? "ASC" : "DESC";
}

function normalizeSortField(value: string | undefined): SortableTrackField {
  switch (value) {
    case "name":
    case "popularity":
    case "scannedAt":
    case "releaseDate":
      return value;
    default:
      return "releaseDate";
  }
}

function getTrackOrderBy(sort: SortableTrackField, dir: "ASC" | "DESC"): string {
  switch (sort) {
    case "name":
      return ` ORDER BY track.title ${dir}, track.mbid ASC`;
    case "popularity":
      return ` ORDER BY popularity ${dir}, COALESCE(artist.popularity, 0) ${dir}, track.mbid ASC`;
    case "scannedAt":
      return ` ORDER BY (track.updated_at IS NULL) ASC, track.updated_at ${dir}, track.mbid ASC`;
    case "releaseDate":
    default:
      return ` ORDER BY (release_group.first_release_date IS NULL) ASC, release_group.first_release_date ${dir}, track.mbid ASC`;
  }
}

function getTrackFromSql(selectClause: string, whereClause: string, candidateScoped = false): string {
  return `
    SELECT
      ${selectClause}
    FROM ${candidateScoped ? "candidate_track_ids candidate JOIN Tracks track ON track.id = candidate.id" : "Tracks track"}
    JOIN AlbumEditions release ON release.id = track.album_edition_id
    JOIN Albums release_group ON release_group.id = release.release_group_id
    LEFT JOIN ArtistMetadata artist ON artist.id = release_group.artist_metadata_id
    LEFT JOIN Recordings recording ON recording.id = track.recording_id
    ${whereClause}
  `;
}

function planTrackQualitySql(
  planTrackAlias: string,
  variantAlias: string,
  _providerItemAlias?: string,
): string {
  return `COALESCE(
    NULLIF(TRIM(CASE
      WHEN json_valid(${planTrackAlias}.source_quality_snapshot)
      THEN json_extract(${planTrackAlias}.source_quality_snapshot, '$.quality')
      ELSE ${planTrackAlias}.source_quality_snapshot
    END), ''),
    NULLIF(TRIM(${variantAlias}.provider_quality_label), ''),
    ${variantAlias}.quality_class
  )`;
}

function getTrackSelectSql(whereClause: string): string {
  const selectedQuality = planTrackQualitySql("selected_plan_track", "selected_variant", "provider_track");
  return getTrackFromSql(`
      track.id AS track_row_id,
      track.mbid AS id,
      release_group.mbid AS album_id,
      track.title,
      CASE
        WHEN provider_track.version IS NOT NULL
          AND TRIM(provider_track.version) != ''
          AND INSTR(LOWER(track.title), LOWER(TRIM(provider_track.version))) = 0
        THEN TRIM(provider_track.version)
        ELSE NULL
      END AS version,
      COALESCE(
        ROUND(COALESCE(track.length_ms, recording.length_ms, provider_track.duration_ms, 0) / 1000.0),
        0
      ) AS duration,
      track.position AS track_number,
      track.medium_position AS volume_number,
      COALESCE(${selectedQuality}, '') AS quality,
      (
        SELECT GROUP_CONCAT(quality_value)
        FROM (
          SELECT quality_value
          FROM (
            SELECT
              ${planTrackQualitySql("quality_plan_track", "quality_variant")} AS quality_value,
              CASE WHEN EXISTS (
                SELECT 1
                FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
                WHERE allowed.value = 'spatial'
              ) THEN 1 ELSE 0 END AS library_rank,
              quality_plan_track.id AS identity_rank
            FROM AcquisitionPlanTracks quality_plan_track
            JOIN Tracks quality_track
              ON quality_track.id = quality_plan_track.track_id
            JOIN SelectedAcquisitionPlans quality_plan
              ON quality_plan.id = quality_plan_track.plan_id
             AND quality_plan.state = 'current'
            JOIN LibraryEditions quality_library_release
              ON quality_library_release.id = quality_plan.library_edition_id
            JOIN AlbumEditions quality_release
              ON quality_release.id = quality_library_release.edition_id
            JOIN Libraries quality_library
              ON quality_library.id = quality_library_release.library_id
             AND quality_library.enabled = 1
            JOIN quality_profiles quality_profile
              ON quality_profile.id = quality_library.quality_profile_id
            JOIN ProviderItemAudioVariants quality_variant
              ON quality_variant.id = quality_plan_track.provider_audio_variant_id
            WHERE quality_track.recording_id = track.recording_id
              AND quality_release.release_group_id = release_group.id

            UNION ALL

            SELECT
              COALESCE(
                NULLIF(TRIM(quality_file.imported_quality), ''),
                NULLIF(TRIM(quality_file.source_quality), ''),
                NULLIF(TRIM(quality_file.quality), '')
              ) AS quality_value,
              CASE WHEN EXISTS (
                SELECT 1
                FROM json_each(COALESCE(file_quality_profile.allowed_source_formats, '[]')) allowed
                WHERE allowed.value = 'spatial'
              ) THEN 1 ELSE 0 END AS library_rank,
              quality_file.id AS identity_rank
            FROM TrackFiles quality_file
            JOIN Libraries file_library
              ON file_library.id = quality_file.library_id
             AND file_library.enabled = 1
            JOIN quality_profiles file_quality_profile
              ON file_quality_profile.id = file_library.quality_profile_id
            WHERE quality_file.track_id = track.id
              AND (quality_file.file_class = 'audio' OR quality_file.file_type = 'track')
          )
          WHERE quality_value IS NOT NULL AND TRIM(quality_value) != ''
          ORDER BY library_rank, identity_rank
        )
      ) AS quality_tags,
      COALESCE((
        SELECT json_group_array(json_object(
          'slot', selected_offer.library_class,
          'provider', selected_offer.provider,
          'providerAlbumId', selected_offer.provider_album_id,
          'quality', selected_offer.quality,
          'matchStatus', selected_offer.match_status,
          'selectedReleaseMbid', selected_offer.selected_release_mbid,
          'providerTrackId', selected_offer.provider_track_id
        ))
        FROM (
          SELECT
            CASE WHEN EXISTS (
              SELECT 1
              FROM json_each(COALESCE(remote_profile.allowed_source_formats, '[]')) allowed
              WHERE allowed.value = 'spatial'
            ) THEN 'spatial' ELSE 'stereo' END AS library_class,
            remote_release_item.provider,
            remote_release_item.provider_id AS provider_album_id,
            ${planTrackQualitySql("remote_plan_track", "remote_variant")} AS quality,
            remote_release_match.match_state AS match_status,
            remote_release.mbid AS selected_release_mbid,
            remote_track_item.provider_id AS provider_track_id
          FROM AcquisitionPlanTracks remote_plan_track
          JOIN Tracks remote_track
            ON remote_track.id = remote_plan_track.track_id
          JOIN SelectedAcquisitionPlans remote_plan
            ON remote_plan.id = remote_plan_track.plan_id
           AND remote_plan.state = 'current'
          JOIN LibraryEditions remote_library_release
            ON remote_library_release.id = remote_plan.library_edition_id
          JOIN Libraries remote_library
            ON remote_library.id = remote_library_release.library_id
           AND remote_library.enabled = 1
          JOIN quality_profiles remote_profile
            ON remote_profile.id = remote_library.quality_profile_id
          JOIN AlbumEditions remote_release
            ON remote_release.id = remote_library_release.edition_id
          JOIN AcquisitionPlanSources remote_source
            ON remote_source.id = remote_plan_track.source_id
          JOIN ProviderEditionMatches remote_release_match
            ON remote_release_match.id = remote_source.provider_edition_match_id
           AND remote_release_match.match_state = 'accepted'
          JOIN ProviderItems remote_release_item
            ON remote_release_item.id = remote_release_match.provider_edition_item_id
          JOIN ProviderTrackMatches remote_track_match
            ON remote_track_match.id = remote_plan_track.provider_track_match_id
           AND remote_track_match.match_state = 'accepted'
          JOIN ProviderEditionMembers remote_member
            ON remote_member.id = remote_track_match.provider_edition_member_id
          JOIN ProviderItems remote_track_item
            ON remote_track_item.id = remote_member.member_item_id
          JOIN ProviderItemAudioVariants remote_variant
            ON remote_variant.id = remote_plan_track.provider_audio_variant_id
          WHERE remote_track.recording_id = track.recording_id
            AND remote_release.release_group_id = release_group.id
          ORDER BY
            CASE WHEN EXISTS (
              SELECT 1
              FROM json_each(COALESCE(remote_profile.allowed_source_formats, '[]')) allowed
              WHERE allowed.value = 'spatial'
            ) THEN 1 ELSE 0 END,
            remote_library_release.updated_at DESC,
            remote_plan_track.id DESC
        ) selected_offer
      ), '[]') AS remote_offers,
      COALESCE(provider_track.explicit, 0) AS explicit,
      CASE WHEN ${canonicalTrackMonitoredPredicate} THEN 1 ELSE 0 END AS is_monitored,
      COALESCE((
        SELECT MAX(library_group.locked)
        FROM LibraryAlbums library_group
        JOIN Libraries monitored_library
          ON monitored_library.id = library_group.library_id
         AND monitored_library.enabled = 1
        WHERE library_group.release_group_id = release_group.id
      ), 0) AS monitored_lock,
      COALESCE(release.date, release_group.first_release_date) AS release_date,
      MAX(
        COALESCE(CAST(recording.popularity AS REAL), 0),
        COALESCE(CAST(provider_track.popularity AS REAL), 0)
      ) AS popularity,
      track.updated_at AS last_scanned,
      track.updated_at AS created_at,
      track.updated_at AS updated_at,
      artist.name AS artist_name,
      artist.mbid AS artist_id,
      release_group.title AS album_title,
      release_group.images AS album_images,
      provider_album.cover_id AS album_cover,
      recording.credits AS recording_credits,
      provider_track.provider AS preview_provider,
      provider_track.provider_id AS preview_provider_track_id,
      track.mbid AS musicbrainz_track_id,
      track.recording_mbid AS musicbrainz_recording_id,
      track.release_mbid AS musicbrainz_release_id,
      CASE WHEN EXISTS (
        SELECT 1
        FROM TrackFiles detail_downloaded_file
        WHERE detail_downloaded_file.track_id = track.id
          AND (detail_downloaded_file.file_class = 'audio' OR detail_downloaded_file.file_type = 'track')
      ) THEN 1 ELSE 0 END AS is_downloaded
    `, `
    LEFT JOIN AcquisitionPlanTracks selected_plan_track
      ON selected_plan_track.id = (
        SELECT candidate_plan_track.id
        FROM AcquisitionPlanTracks candidate_plan_track
        JOIN SelectedAcquisitionPlans candidate_plan
          ON candidate_plan.id = candidate_plan_track.plan_id
         AND candidate_plan.state = 'current'
        JOIN LibraryEditions candidate_library_release
          ON candidate_library_release.id = candidate_plan.library_edition_id
         AND candidate_library_release.edition_id = track.album_edition_id
        JOIN Libraries candidate_library
          ON candidate_library.id = candidate_library_release.library_id
         AND candidate_library.enabled = 1
        JOIN quality_profiles candidate_profile
          ON candidate_profile.id = candidate_library.quality_profile_id
        WHERE candidate_plan_track.track_id = track.id
        ORDER BY
          CASE WHEN EXISTS (
            SELECT 1
            FROM json_each(COALESCE(candidate_profile.allowed_source_formats, '[]')) allowed
            WHERE allowed.value = 'spatial'
          ) THEN 1 ELSE 0 END,
          candidate_library_release.updated_at DESC,
          candidate_plan_track.id DESC
        LIMIT 1
      )
    LEFT JOIN ProviderItemAudioVariants selected_variant
      ON selected_variant.id = selected_plan_track.provider_audio_variant_id
    LEFT JOIN ProviderTrackMatches selected_track_match
      ON selected_track_match.id = selected_plan_track.provider_track_match_id
     AND selected_track_match.match_state = 'accepted'
    LEFT JOIN ProviderEditionMembers selected_member
      ON selected_member.id = selected_track_match.provider_edition_member_id
    LEFT JOIN ProviderItems provider_track
      ON provider_track.id = selected_member.member_item_id
    LEFT JOIN AcquisitionPlanSources selected_source
      ON selected_source.id = selected_plan_track.source_id
    LEFT JOIN ProviderEditionMatches selected_release_match
      ON selected_release_match.id = selected_source.provider_edition_match_id
     AND selected_release_match.match_state = 'accepted'
    LEFT JOIN ProviderItems provider_album
      ON provider_album.id = selected_release_match.provider_edition_item_id
    ${whereClause}
  `);
}

function sanitizeQualityTag(value: string | null | undefined, includeSpatial: boolean): string {
  const quality = String(value || "").trim();
  if (!quality) {
    return "";
  }
  return includeSpatial || !isSpatialAudioQuality(quality) ? quality : "";
}

function splitQualityTags(value: string | null | undefined, includeSpatial: boolean): string[] {
  const seen = new Set<string>();
  return String(value || "")
    .split(",")
    .map((quality) => sanitizeQualityTag(quality, includeSpatial))
    .filter((quality) => {
      const key = quality.toUpperCase();
      if (!quality || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function parseRemoteOffers(value: string | null | undefined, includeSpatial: boolean): TrackRemoteOfferContract[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const seen = new Set<string>();
    return parsed.flatMap((candidate): TrackRemoteOfferContract[] => {
      if (!candidate || typeof candidate !== "object") {
        return [];
      }
      const offer = candidate as Record<string, unknown>;
      const slot = String(offer.slot || "").trim();
      const provider = String(offer.provider || "").trim();
      const providerAlbumId = String(offer.providerAlbumId || "").trim();
      const quality = sanitizeQualityTag(String(offer.quality || ""), includeSpatial) || null;
      const matchStatus = String(offer.matchStatus || "").trim() || null;
      const selectedReleaseMbid = String(offer.selectedReleaseMbid || "").trim() || null;
      const providerTrackId = String(offer.providerTrackId || "").trim() || null;
      if (!slot || !provider || !providerAlbumId || (!includeSpatial && slot === "spatial")) {
        return [];
      }
      const key = `${slot}\u0000${provider}\u0000${providerAlbumId}\u0000${quality || ""}`;
      if (seen.has(key)) {
        return [];
      }
      seen.add(key);
      return [{
        slot,
        provider,
        providerAlbumId,
        quality,
        matchStatus,
        selectedReleaseMbid,
        providerTrackId,
      }];
    });
  } catch {
    return [];
  }
}

export function hydrateTrackRows(tracks: TrackRow[]): AlbumTrackContract[] {
  const trackRowIds = tracks
    .map((track) => Number(track.track_row_id))
    .filter((id) => Number.isInteger(id) && id > 0);
  const filesByTrack = new Map<string, LibraryFileContract[]>();
  const includeSpatial = getConfigSection("filtering").include_spatial === true;

  if (trackRowIds.length > 0) {
    const placeholders = trackRowIds.map(() => "?").join(",");
    const files = db.prepare(`
      SELECT
        file.id,
        track.mbid AS linked_track_mbid,
        file.provider_id AS media_id,
        file.file_type,
        file.file_path,
        file.relative_path,
        file.filename,
        file.extension,
        artist.mbid AS canonical_artist_mbid,
        release_group.mbid AS canonical_release_group_mbid,
        release.mbid AS canonical_release_mbid,
        track.mbid AS canonical_track_mbid,
        recording.mbid AS canonical_recording_mbid,
        file.provider,
        file.provider_entity_type,
        file.provider_id,
        CASE WHEN EXISTS (
          SELECT 1
          FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
          WHERE allowed.value = 'spatial'
        ) THEN 'spatial' ELSE 'stereo' END AS library_slot,
        file.quality,
        library.root_path AS library_root,
        file.file_size,
        file.bitrate,
        file.sample_rate,
        file.bit_depth,
        file.channels,
        file.codec,
        file.video_codec,
        file.width,
        file.height,
        file.duration
      FROM TrackFiles file
      JOIN Tracks track ON track.id = file.track_id
      JOIN AlbumEditions release ON release.id = file.album_edition_id
      JOIN Albums release_group ON release_group.id = release.release_group_id
      LEFT JOIN ArtistMetadata artist ON artist.id = release_group.artist_metadata_id
      JOIN Recordings recording ON recording.id = file.recording_id
      JOIN Libraries library ON library.id = file.library_id
      JOIN quality_profiles quality_profile ON quality_profile.id = library.quality_profile_id
      WHERE file.track_id IN (${placeholders})
        AND (file.file_class = 'audio' OR file.file_type IN ('track', 'lyrics'))
      ORDER BY file.file_type ASC, file.id ASC
    `).all(...trackRowIds) as LibraryFileRow[];

    for (const file of files) {
      const key = String(file.linked_track_mbid || "");
      if (!key) {
        continue;
      }
      const bucket = filesByTrack.get(key) || [];
      bucket.push(normalizeLibraryFileRow(file));
      filesByTrack.set(key, bucket);
    }
  }

  const hydrated = tracks.map((track) => {
    const trackId = String(track.id);
    const files = filesByTrack.get(trackId) || [];
    const isDownloaded = Boolean(track.is_downloaded) || files.some((file) => file.file_type === "track");
    const albumCover = albumCoverLocalUrl({
      albumMbid: track.album_id != null ? String(track.album_id) : null,
      images: imageContainerFromImagesColumn(track.album_images),
      skipStoredImageLookup: true,
    }) ?? track.album_cover ?? null;

    let artist_credits: Array<{ id: string; name: string; join_phrase: string }> = [];
    if (track.recording_credits) {
      try {
        const parsed = JSON.parse(track.recording_credits);
        if (Array.isArray(parsed) && parsed.length > 0) {
          artist_credits = parsed.map((credit: any) => ({
            id: credit.id || credit.artist?.id || credit.artistId || "",
            name: credit.name || credit.artist?.name || "",
            join_phrase: credit.join_phrase || "",
          })).filter(credit => credit.name);
        }
      } catch {
        // Ignore malformed recording credits and fall back to the primary artist.
      }
    }

    if (artist_credits.length === 0) {
      artist_credits = [{
        id: track.artist_id != null ? String(track.artist_id) : "",
        name: track.artist_name || "Unknown Artist",
        join_phrase: "",
      }];
    }

    return {
      ...track,
      id: trackId,
      album_id: track.album_id != null ? String(track.album_id) : null,
      album_cover: albumCover,
      cover_url: albumCover,
      preview_provider: track.preview_provider || null,
      preview_provider_track_id: track.preview_provider_track_id || null,
      musicbrainz_track_id: track.musicbrainz_track_id || trackId,
      musicbrainz_recording_id: track.musicbrainz_recording_id || null,
      musicbrainz_release_id: track.musicbrainz_release_id || null,
      quality: sanitizeQualityTag(track.quality, includeSpatial),
      qualityTags: splitQualityTags(track.quality_tags, includeSpatial),
      remoteOffers: parseRemoteOffers(track.remote_offers, includeSpatial).map((offer) => {
        if (offer.providerTrackId) return offer;
        const fileMatch = files.find((file) =>
          file.file_type === "track"
          && String(file.library_slot || "").toLowerCase() === offer.slot
          && String(file.provider || "").toLowerCase() === offer.provider.toLowerCase()
          && String(file.provider_id || "").trim());
        const previewMatch = String(track.preview_provider || "").toLowerCase() === offer.provider.toLowerCase()
          ? String(track.preview_provider_track_id || "").trim() || null
          : null;
        return {
          ...offer,
          providerTrackId: String(fileMatch?.provider_id || previewMatch || "").trim() || null,
        };
      }),
      is_monitored: Boolean(track.is_monitored),
      monitored_lock: Boolean(track.monitored_lock),
      explicit: track.explicit === undefined ? undefined : Boolean(track.explicit),
      downloaded: isDownloaded,
      is_downloaded: isDownloaded,
      files,
      artist_credits,
    };
  });

  // Collaboration credits from MusicBrainz recording data often carry the
  // artist name but no id, so the UI can't link them. Resolve any blank credit
  // ids against artists we actually hold (by name) so those become clickable;
  // artists not in our library stay plain text rather than dead links.
  const namesToResolve = new Set<string>();
  for (const track of hydrated) {
    for (const credit of track.artist_credits) {
      if (!credit.id && credit.name) {
        namesToResolve.add(credit.name);
      }
    }
  }
  if (namesToResolve.size > 0) {
    const names = [...namesToResolve];
    const placeholders = names.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT mbid, name FROM ArtistMetadata WHERE name COLLATE NOCASE IN (${placeholders})`,
    ).all(...names) as Array<{ mbid: string | null; name: string | null }>;
    const mbidByName = new Map<string, string>();
    for (const row of rows) {
      const key = String(row.name || "").trim().toLowerCase();
      if (row.mbid && key && !mbidByName.has(key)) {
        mbidByName.set(key, row.mbid);
      }
    }
    for (const track of hydrated) {
      for (const credit of track.artist_credits) {
        if (!credit.id && credit.name) {
          const resolved = mbidByName.get(credit.name.trim().toLowerCase());
          if (resolved) {
            credit.id = resolved;
          }
        }
      }
    }
  }

  return hydrated;
}

export function listTracks(input: ListTracksQuery): TracksListResponse {
  const where: string[] = [];
  const params: Array<string | number> = [];

  // A LibraryAlbums row exists only for a monitored Album, so the candidate
  // scope's own join already restricts to monitored ones.
  const monitoredCandidatePredicate = "";
  const candidateScope = `
    WITH candidate_track_ids(id) AS MATERIALIZED (
      -- Every canonical track of a release this library has selected. Acquisition
      -- is NOT a precondition for visibility: a selected release's tracks stay
      -- listed while still unavailable/unplanned, and only then can the UI show
      -- them as missing. This is the same scope TrackLibraryIndex projects, so
      -- the fast COUNT path and the listed items always describe one set.
      SELECT selected_track.id
      FROM LibraryEditions library_release
      JOIN AlbumEditions release
        ON release.id = library_release.edition_id
      JOIN Tracks selected_track
        ON selected_track.album_edition_id = library_release.edition_id
      JOIN LibraryAlbums library_group
        ON library_group.library_id = library_release.library_id
       AND library_group.release_group_id = release.release_group_id
      JOIN Libraries library
        ON library.id = library_release.library_id
       AND library.enabled = 1
      WHERE 1 = 1
        ${monitoredCandidatePredicate}
      UNION
      SELECT available_file.track_id
      FROM TrackFiles available_file
      JOIN AlbumEditions file_release
        ON file_release.id = available_file.album_edition_id
      JOIN LibraryAlbums library_group
        ON library_group.library_id = available_file.library_id
       AND library_group.release_group_id = file_release.release_group_id
      JOIN Libraries library
        ON library.id = available_file.library_id
       AND library.enabled = 1
      WHERE available_file.track_id IS NOT NULL
        AND (available_file.file_class = 'audio' OR available_file.file_type IN ('track', 'lyrics'))
        ${monitoredCandidatePredicate}
    )
  `;

  if (input.search) {
    const searchParam = `%${input.search}%`;
    where.push("(track.title LIKE ? OR artist.name LIKE ? OR release_group.title LIKE ?)");
    params.push(searchParam, searchParam, searchParam);
  }

  if (input.monitored !== undefined) {
    // The monitored candidate source above already applies this positive
    // filter before expanding releases into tracks.
    if (!input.monitored) {
      where.push(`NOT (${canonicalTrackMonitoredPredicate})`);
    }
  }

  if (input.downloaded !== undefined) {
    where.push(input.downloaded ? canonicalTrackDownloadedPredicate : `NOT (${canonicalTrackDownloadedPredicate})`);
  }

  if (input.locked === true) {
    where.push("0 = 1");
  }

  if (input.libraryFilter === "spatial") {
    where.push(canonicalTrackSpatialQualityPredicate);
  } else if (input.libraryFilter === "stereo") {
    where.push(canonicalTrackStereoQualityPredicate);
  }

  const providerFilter = String(input.provider || "").trim();
  const qualityTierFilter = String(input.qualityTier || "").trim();
  const selectedOfferWhere = [
    "filtered_plan_track.track_id = track.id",
    "filtered_plan.state = 'current'",
    "filtered_release_match.match_state = 'accepted'",
  ];
  if (input.libraryFilter === "spatial") {
    selectedOfferWhere.push(`EXISTS (
      SELECT 1
      FROM json_each(COALESCE(filtered_profile.allowed_source_formats, '[]')) allowed
      WHERE allowed.value = 'spatial'
    )`);
  } else if (input.libraryFilter === "stereo") {
    selectedOfferWhere.push(`NOT EXISTS (
      SELECT 1
      FROM json_each(COALESCE(filtered_profile.allowed_source_formats, '[]')) allowed
      WHERE allowed.value = 'spatial'
    )`);
  }
  if (providerFilter) {
    selectedOfferWhere.push("filtered_release_item.provider = ?");
    params.push(providerFilter);
  }
  const qualityCondition = qualityTierFilter
    ? qualityTierSqlCondition(
        planTrackQualitySql("filtered_plan_track", "filtered_variant", "filtered_track_item"),
        qualityTierFilter,
      )
    : null;
  if (qualityCondition) {
    selectedOfferWhere.push(qualityCondition);
  }
  const hasSelectedOfferFilter = Boolean(providerFilter || qualityCondition);
  if (hasSelectedOfferFilter) {
    where.push(`EXISTS (
      SELECT 1
      FROM AcquisitionPlanTracks filtered_plan_track
      JOIN SelectedAcquisitionPlans filtered_plan
        ON filtered_plan.id = filtered_plan_track.plan_id
      JOIN LibraryEditions filtered_library_release
        ON filtered_library_release.id = filtered_plan.library_edition_id
       AND filtered_library_release.edition_id = track.album_edition_id
      JOIN Libraries filtered_library
        ON filtered_library.id = filtered_library_release.library_id
       AND filtered_library.enabled = 1
      JOIN quality_profiles filtered_profile
        ON filtered_profile.id = filtered_library.quality_profile_id
      JOIN AcquisitionPlanSources filtered_source
        ON filtered_source.id = filtered_plan_track.source_id
      JOIN ProviderEditionMatches filtered_release_match
        ON filtered_release_match.id = filtered_source.provider_edition_match_id
      JOIN ProviderItems filtered_release_item
        ON filtered_release_item.id = filtered_release_match.provider_edition_item_id
      JOIN ProviderTrackMatches filtered_track_match
        ON filtered_track_match.id = filtered_plan_track.provider_track_match_id
       AND filtered_track_match.match_state = 'accepted'
      JOIN ProviderEditionMembers filtered_member
        ON filtered_member.id = filtered_track_match.provider_edition_member_id
      JOIN ProviderItems filtered_track_item
        ON filtered_track_item.id = filtered_member.member_item_id
      JOIN ProviderItemAudioVariants filtered_variant
        ON filtered_variant.id = filtered_plan_track.provider_audio_variant_id
      WHERE ${selectedOfferWhere.join(" AND ")}
    )`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sort = normalizeSortField(input.sort);
  const dir = normalizeSortDirection(input.dir);
  const orderBy = getTrackOrderBy(sort, dir);
  const trackLibraryReady = TrackLibraryIndexService.isReady();

  // Select the page from canonical integer identities first. Provider offers,
  // quality unions, files, and credits are intentionally enriched only for
  // the surviving rows; evaluating those correlated lookups across the whole
  // multi-million-row Tracks table blocked the API event loop for ~30 seconds.
  const candidateOrderBy = sort === "popularity"
    ? ` ORDER BY MAX(
          COALESCE(recording.popularity, 0),
          COALESCE((
            SELECT MAX(selected_track_item.popularity)
            FROM AcquisitionPlanTracks popularity_plan_track
            JOIN SelectedAcquisitionPlans popularity_plan
              ON popularity_plan.id = popularity_plan_track.plan_id
             AND popularity_plan.state = 'current'
            JOIN ProviderTrackMatches popularity_match
              ON popularity_match.id = popularity_plan_track.provider_track_match_id
             AND popularity_match.match_state = 'accepted'
            JOIN ProviderEditionMembers popularity_member
              ON popularity_member.id = popularity_match.provider_edition_member_id
            JOIN ProviderItems selected_track_item
              ON selected_track_item.id = popularity_member.member_item_id
            WHERE popularity_plan_track.track_id = track.id
          ), 0)
        ) ${dir}, COALESCE(artist.popularity, 0) ${dir}, track.mbid ASC`
    : orderBy;
  const usePopularityPage = sort === "popularity"
    && input.monitored === true
    && input.locked !== true
    && !input.search
    && (!input.libraryFilter || input.libraryFilter === "all")
    && !hasSelectedOfferFilter
    && trackLibraryReady;
  const candidateSql = usePopularityPage ? `
    SELECT library_track.track_id AS id, '' AS mbid
    FROM TrackLibraryIndex library_track
    ${input.downloaded === undefined ? "" : "WHERE library_track.downloaded = ?"}
    ORDER BY
      library_track.popularity ${dir},
      library_track.track_id ASC
    LIMIT ? OFFSET ?
  ` : `
    ${candidateScope}
    ${getTrackFromSql("track.id, track.mbid", whereClause, true)}
    ${candidateOrderBy}
    LIMIT ? OFFSET ?
  `;
  const candidateParams = usePopularityPage && input.downloaded !== undefined
    ? [input.downloaded ? 1 : 0, input.limit, input.offset]
    : [...params, input.limit, input.offset];
  const candidates = db.prepare(candidateSql)
    .all(...candidateParams) as Array<{ id: number; mbid: string }>;
  const candidateIds = candidates.map((candidate) => candidate.id);
  const candidateMarks = candidateIds.map(() => "?").join(", ");
  const detailRows = candidateIds.length === 0 ? [] : db.prepare(`
    ${getTrackSelectSql(`WHERE track.id IN (${candidateMarks})`)}
  `).all(...candidateIds) as TrackRow[];
  const detailById = new Map(detailRows.map((row) => [Number(row.track_row_id), row]));
  const rows = candidates
    .map((candidate) => detailById.get(candidate.id))
    .filter((row): row is TrackRow => row != null);

  const useFastMonitoredCount = input.monitored === true
    && !input.search
    && (!input.libraryFilter || input.libraryFilter === "all")
    && input.locked !== true
    && !hasSelectedOfferFilter
    && trackLibraryReady;
  const totalResult = useFastMonitoredCount ? db.prepare(`
    SELECT COUNT(*) AS total
    FROM TrackLibraryIndex count_track
    ${input.downloaded === undefined ? "" : "WHERE count_track.downloaded = ?"}
  `).get(...(input.downloaded === undefined ? [] : [input.downloaded ? 1 : 0])) as { total: number } : db.prepare(`
    ${candidateScope}
    ${getTrackFromSql("COUNT(*) as total", whereClause, true)}
  `).get(...params) as { total: number };

  const items = hydrateTrackRows(rows);

  return {
    items,
    total: totalResult.total,
    limit: input.limit,
    offset: input.offset,
    hasMore: input.offset + items.length < totalResult.total,
  };
}

export function getTrackDetail(trackId: string): AlbumTrackContract | null {
  const row = db.prepare(`
    ${getTrackSelectSql("WHERE track.mbid = ?")}
  `).get(trackId) as TrackRow | undefined;

  if (!row) {
    return null;
  }

  return hydrateTrackRows([row])[0] ?? null;
}

export function getTrackFiles(trackId: string): TrackFileDetails[] {
  const rows = db.prepare(`
    SELECT
      file.id,
      file.provider_id AS media_id,
      file.file_type,
      file.file_path,
      file.relative_path,
      file.filename,
      file.extension,
      file.quality,
      library.root_path AS library_root,
      file.file_size,
      file.bitrate,
      file.sample_rate,
      file.bit_depth,
      file.channels,
      file.codec,
      file.video_codec,
      file.width,
      file.height,
      file.duration,
      artist.mbid AS canonical_artist_mbid,
      release_group.mbid AS canonical_release_group_mbid,
      release.mbid AS canonical_release_mbid,
      track.mbid AS canonical_track_mbid,
      recording.mbid AS canonical_recording_mbid,
      file.provider,
      file.provider_entity_type,
      file.provider_id,
      CASE WHEN EXISTS (
        SELECT 1
        FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
        WHERE allowed.value = 'spatial'
      ) THEN 'spatial' ELSE 'stereo' END AS library_slot,
      file.created_at,
      file.modified_at
    FROM TrackFiles file
    JOIN Tracks track ON track.id = file.track_id
    JOIN AlbumEditions release ON release.id = file.album_edition_id
    JOIN Albums release_group ON release_group.id = release.release_group_id
    LEFT JOIN ArtistMetadata artist ON artist.id = release_group.artist_metadata_id
    JOIN Recordings recording ON recording.id = file.recording_id
    JOIN Libraries library ON library.id = file.library_id
    JOIN quality_profiles quality_profile ON quality_profile.id = library.quality_profile_id
    WHERE track.mbid = ?
    ORDER BY
      CASE file.file_type
        WHEN 'track' THEN 0
        WHEN 'lyrics' THEN 1
        ELSE 2
      END,
      file.file_path ASC,
      file.id ASC
  `).all(trackId) as LibraryFileRow[];

  return rows.map((row) => ({
    ...normalizeLibraryFileRow(row),
    created_at: row.created_at,
    modified_at: row.modified_at,
  }));
}
