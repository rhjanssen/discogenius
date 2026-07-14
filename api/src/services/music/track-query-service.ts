import { db } from "../../database.js";
import type { AlbumTrackContract, LibraryFileContract } from "../../contracts/media.js";
import { isSpatialAudioQuality, spatialAudioQualitySql } from "../../utils/spatial-audio.js";
import { getConfigSection } from "../config/config.js";
import { albumCoverLocalUrl } from "../metadata/media-cover-service.js";

const canonicalTrackDownloadedPredicate = `
  track.id IN (
    SELECT downloaded_file.track_id
    FROM TrackFiles downloaded_file
    WHERE downloaded_file.track_id IS NOT NULL
      AND downloaded_file.file_type = 'track'
  )
`;

const canonicalTrackMonitoredPredicate = `
  release_group.id IN (
    SELECT monitored_slot.release_group_id
    FROM ReleaseGroupSlots monitored_slot
    WHERE monitored_slot.release_group_id IS NOT NULL
      AND monitored_slot.monitored = 1
  )
`;

const canonicalTrackSpatialQualityPredicate = `
  (
    track.release_mbid IN (
      SELECT spatial_slot.selected_release_mbid
      FROM ReleaseGroupSlots spatial_slot
      WHERE spatial_slot.selected_release_mbid IS NOT NULL
        AND ${spatialAudioQualitySql("spatial_slot.quality")}
    )
    OR track.mbid IN (
      SELECT spatial_provider_item.track_mbid
      FROM ProviderItems spatial_provider_item
      WHERE spatial_provider_item.entity_type = 'track'
        AND spatial_provider_item.track_mbid IS NOT NULL
        AND ${spatialAudioQualitySql("spatial_provider_item.quality")}
    )
    OR track.recording_mbid IN (
      SELECT spatial_provider_item.recording_mbid
      FROM ProviderItems spatial_provider_item
      WHERE spatial_provider_item.entity_type = 'track'
        AND spatial_provider_item.recording_mbid IS NOT NULL
        AND ${spatialAudioQualitySql("spatial_provider_item.quality")}
    )
    OR track.mbid IN (
      SELECT spatial_file.canonical_track_mbid
      FROM TrackFiles spatial_file
      WHERE spatial_file.canonical_track_mbid IS NOT NULL
        AND ${spatialAudioQualitySql("spatial_file.quality")}
    )
  )
`;

const canonicalTrackStereoQualityPredicate = `
  (
    track.release_mbid IN (
      SELECT stereo_slot.selected_release_mbid
      FROM ReleaseGroupSlots stereo_slot
      WHERE stereo_slot.selected_release_mbid IS NOT NULL
        AND stereo_slot.quality IS NOT NULL
        AND NOT ${spatialAudioQualitySql("stereo_slot.quality")}
    )
    OR track.mbid IN (
      SELECT stereo_provider_item.track_mbid
      FROM ProviderItems stereo_provider_item
      WHERE stereo_provider_item.entity_type = 'track'
        AND stereo_provider_item.track_mbid IS NOT NULL
        AND stereo_provider_item.quality IS NOT NULL
        AND NOT ${spatialAudioQualitySql("stereo_provider_item.quality")}
    )
    OR track.recording_mbid IN (
      SELECT stereo_provider_item.recording_mbid
      FROM ProviderItems stereo_provider_item
      WHERE stereo_provider_item.entity_type = 'track'
        AND stereo_provider_item.recording_mbid IS NOT NULL
        AND stereo_provider_item.quality IS NOT NULL
        AND NOT ${spatialAudioQualitySql("stereo_provider_item.quality")}
    )
    OR track.mbid IN (
      SELECT stereo_file.canonical_track_mbid
      FROM TrackFiles stereo_file
      WHERE stereo_file.canonical_track_mbid IS NOT NULL
        AND stereo_file.quality IS NOT NULL
        AND NOT ${spatialAudioQualitySql("stereo_file.quality")}
    )
  )
`;

export interface TrackRow {
  id: number | string;
  album_id: number | string | null;
  title: string;
  version?: string | null;
  duration: number;
  track_number: number;
  volume_number: number;
  quality: string;
  quality_tags?: string | null;
  artist_name?: string;
  artist_id?: number | string | null;
  album_title?: string;
  album_cover?: string | null;
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
    JOIN AlbumReleases release ON release.id = track.album_release_id
    JOIN Albums release_group ON release_group.id = release.release_group_id
    LEFT JOIN ArtistMetadata artist ON artist.id = release_group.artist_metadata_id
    LEFT JOIN Recordings recording ON recording.id = track.recording_id
    ${whereClause}
  `;
}

function getTrackSelectSql(whereClause: string): string {
  return getTrackFromSql(`
      track.mbid AS id,
      release_group.mbid AS album_id,
      track.title,
      NULL AS version,
      COALESCE(
        ROUND(COALESCE(track.length_ms, recording.length_ms, provider_track.duration, 0) / 1000.0),
        0
      ) AS duration,
      track.position AS track_number,
      track.medium_position AS volume_number,
      COALESCE(provider_track.quality, selected_slot.quality, primary_file.quality, '') AS quality,
      (
        SELECT GROUP_CONCAT(quality_value)
        FROM (
          SELECT slot_quality.quality AS quality_value
          FROM ReleaseGroupSlots slot_quality
          WHERE slot_quality.release_group_id = release_group.id
            AND slot_quality.selected_album_release_id = track.album_release_id
          UNION
          SELECT provider_quality.quality AS quality_value
          FROM ProviderItems provider_quality
          WHERE provider_quality.entity_type = 'track'
            AND (
              provider_quality.track_id = track.id
              OR provider_quality.recording_id = recording.id
            )
          UNION
          SELECT file_quality.quality AS quality_value
          FROM TrackFiles file_quality
          WHERE file_quality.canonical_track_mbid = track.mbid
        )
        WHERE quality_value IS NOT NULL AND TRIM(quality_value) != ''
      ) AS quality_tags,
      COALESCE(provider_track.explicit, 0) AS explicit,
      CASE WHEN ${canonicalTrackMonitoredPredicate} THEN 1 ELSE 0 END AS is_monitored,
      0 AS monitored_lock,
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
      provider_album.asset_id AS album_cover,
      recording.credits AS recording_credits,
      provider_track.provider AS preview_provider,
      provider_track.provider_id AS preview_provider_track_id,
      track.mbid AS musicbrainz_track_id,
      track.recording_mbid AS musicbrainz_recording_id,
      track.release_mbid AS musicbrainz_release_id,
      CASE WHEN ${canonicalTrackDownloadedPredicate} THEN 1 ELSE 0 END AS is_downloaded
    `, `
    LEFT JOIN ProviderItems provider_track
      ON provider_track.rowid = COALESCE((
       SELECT preferred_provider_track.rowid
       FROM ProviderItems preferred_provider_track
       WHERE preferred_provider_track.entity_type = 'track'
         AND (
           preferred_provider_track.track_id = track.id
           OR preferred_provider_track.recording_id = recording.id
         )
       ORDER BY
         CASE preferred_provider_track.library_slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END,
       preferred_provider_track.updated_at DESC,
       preferred_provider_track.provider_id ASC
       LIMIT 1
     ), (
       SELECT preferred_provider_track.rowid
       FROM ProviderItems preferred_provider_track
       WHERE preferred_provider_track.entity_type = 'track'
         AND (
           preferred_provider_track.track_mbid = track.mbid
           OR preferred_provider_track.recording_mbid = track.recording_mbid
         )
       ORDER BY
         CASE preferred_provider_track.library_slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END,
         preferred_provider_track.updated_at DESC,
         preferred_provider_track.provider_id ASC
       LIMIT 1
     ))
    LEFT JOIN ProviderItems provider_album
      ON provider_album.rowid = (
       SELECT preferred_provider_album.rowid
       FROM ProviderItems preferred_provider_album
       WHERE preferred_provider_album.entity_type = 'album'
         AND preferred_provider_album.release_group_mbid = release_group.mbid
       ORDER BY
         CASE preferred_provider_album.library_slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END,
         preferred_provider_album.updated_at DESC,
         preferred_provider_album.provider_id ASC
       LIMIT 1
     )
    LEFT JOIN ReleaseGroupSlots selected_slot
      ON selected_slot.release_group_id = release_group.id
     AND selected_slot.selected_album_release_id = track.album_release_id
     AND selected_slot.id = (
       SELECT preferred_slot.id
       FROM ReleaseGroupSlots preferred_slot
       WHERE preferred_slot.release_group_id = release_group.id
         AND preferred_slot.selected_album_release_id = track.album_release_id
       ORDER BY CASE preferred_slot.slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END
       LIMIT 1
     )
    LEFT JOIN TrackFiles primary_file
      ON primary_file.canonical_track_mbid = track.mbid
     AND primary_file.file_type = 'track'
     AND primary_file.id = (
       SELECT preferred_file.id
       FROM TrackFiles preferred_file
       WHERE preferred_file.canonical_track_mbid = track.mbid
         AND preferred_file.file_type = 'track'
       ORDER BY CASE preferred_file.library_slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END, preferred_file.id ASC
       LIMIT 1
     )
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

export function hydrateTrackRows(tracks: TrackRow[]): AlbumTrackContract[] {
  const trackIds = tracks.map((track) => String(track.id));
  const filesByTrack = new Map<string, LibraryFileContract[]>();
  const includeSpatial = getConfigSection("filtering").include_spatial === true;

  if (trackIds.length > 0) {
    const placeholders = trackIds.map(() => "?").join(",");
    const files = db.prepare(`
      SELECT id, provider_id AS media_id, file_type, file_path, relative_path, filename, extension,
             canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
             canonical_track_mbid, canonical_recording_mbid,
             provider, provider_entity_type, provider_id, library_slot,
             quality, library_root, file_size, bitrate, sample_rate, bit_depth, channels, codec, duration
      FROM TrackFiles
      WHERE (
          canonical_track_mbid IN (${placeholders})
          OR provider_id IN (${placeholders})
        )
        AND file_type IN ('track', 'lyrics')
      ORDER BY file_type ASC, id ASC
    `).all(...trackIds, ...trackIds) as LibraryFileRow[];

    for (const file of files) {
      const key = String(file.canonical_track_mbid || file.media_id || "");
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

  const availableSlotWhere = [
    "available_slot.selected_album_release_id IS NOT NULL",
    "available_slot.selected_provider_id IS NOT NULL",
  ];
  // Push the overwhelmingly common Monitored filter into the candidate source
  // so SQLite never expands every selected release in the full catalog first.
  if (input.monitored === true) {
    availableSlotWhere.push("available_slot.monitored = 1");
  }
  const candidateScope = `
    WITH candidate_track_ids(id) AS MATERIALIZED (
      SELECT available_track.id
      FROM ReleaseGroupSlots available_slot
      JOIN Tracks available_track
        ON available_track.album_release_id = available_slot.selected_album_release_id
      WHERE ${availableSlotWhere.join(" AND ")}
      UNION
      SELECT available_file.track_id
      FROM TrackFiles available_file
      WHERE available_file.track_id IS NOT NULL
        AND available_file.file_type IN ('track', 'lyrics')
        ${input.monitored === true ? `AND available_file.track_id IN (
          SELECT monitored_file_track.id
          FROM Tracks monitored_file_track
          JOIN ReleaseGroupSlots monitored_file_slot
            ON monitored_file_slot.selected_album_release_id = monitored_file_track.album_release_id
           AND monitored_file_slot.monitored = 1
        )` : ""}
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

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sort = normalizeSortField(input.sort);
  const dir = normalizeSortDirection(input.dir);
  const orderBy = getTrackOrderBy(sort, dir);

  // Select the page from canonical integer identities first. Provider offers,
  // quality unions, files, and credits are intentionally enriched only for
  // the surviving rows; evaluating those correlated lookups across the whole
  // multi-million-row Tracks table blocked the API event loop for ~30 seconds.
  const candidateOrderBy = sort === "popularity"
    ? ` ORDER BY MAX(
          COALESCE(recording.popularity, 0),
          COALESCE((
            SELECT MAX(track_offer.popularity)
            FROM ProviderItems track_offer
            WHERE track_offer.entity_type = 'track'
              AND track_offer.track_id = track.id
          ), 0),
          COALESCE((
            SELECT MAX(recording_offer.popularity)
            FROM ProviderItems recording_offer
            WHERE recording_offer.entity_type = 'track'
              AND recording_offer.recording_id = recording.id
          ), 0),
          COALESCE((
            SELECT MAX(text_track_offer.popularity)
            FROM ProviderItems text_track_offer
            WHERE text_track_offer.entity_type = 'track'
              AND text_track_offer.track_mbid = track.mbid
          ), 0),
          COALESCE((
            SELECT MAX(text_recording_offer.popularity)
            FROM ProviderItems text_recording_offer
            WHERE text_recording_offer.entity_type = 'track'
              AND text_recording_offer.recording_mbid = track.recording_mbid
          ), 0)
        ) ${dir}, COALESCE(artist.popularity, 0) ${dir}, track.mbid ASC`
    : orderBy;
  const useReleaseDatePage = sort === "releaseDate" && input.monitored === true;
  const candidateSql = useReleaseDatePage ? `
    SELECT track.id, track.mbid
    FROM Albums release_group INDEXED BY idx_albums_library_release_date
    JOIN ReleaseGroupSlots available_slot
      ON available_slot.release_group_id = release_group.id
     AND available_slot.selected_album_release_id IS NOT NULL
     AND available_slot.selected_provider_id IS NOT NULL
     AND available_slot.monitored = 1
     AND available_slot.id = (
       SELECT preferred_available_slot.id
       FROM ReleaseGroupSlots preferred_available_slot
       WHERE preferred_available_slot.release_group_id = release_group.id
         AND preferred_available_slot.selected_album_release_id IS NOT NULL
         AND preferred_available_slot.selected_provider_id IS NOT NULL
         AND preferred_available_slot.monitored = 1
       ORDER BY CASE preferred_available_slot.slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END
       LIMIT 1
     )
    JOIN AlbumReleases release ON release.id = available_slot.selected_album_release_id
    JOIN Tracks track ON track.album_release_id = release.id
    ${input.search ? "LEFT JOIN ArtistMetadata artist ON artist.id = release_group.artist_metadata_id" : ""}
    ${(input.search || input.libraryFilter === "spatial" || input.libraryFilter === "stereo")
      ? "LEFT JOIN Recordings recording ON recording.id = track.recording_id"
      : ""}
    ${whereClause}
    ${candidateOrderBy}
    LIMIT ? OFFSET ?
  ` : `
    ${candidateScope}
    ${getTrackFromSql("track.id, track.mbid", whereClause, true)}
    ${candidateOrderBy}
    LIMIT ? OFFSET ?
  `;
  const candidates = db.prepare(candidateSql)
    .all(...params, input.limit, input.offset) as Array<{ id: number; mbid: string }>;
  const candidateIds = candidates.map((candidate) => candidate.id);
  const candidateMarks = candidateIds.map(() => "?").join(", ");
  const detailRows = candidateIds.length === 0 ? [] : db.prepare(`
    ${getTrackSelectSql(`WHERE track.id IN (${candidateMarks})`)}
  `).all(...candidateIds) as TrackRow[];
  const detailByMbid = new Map(detailRows.map((row) => [String(row.id), row]));
  const rows = candidates
    .map((candidate) => detailByMbid.get(String(candidate.mbid)))
    .filter((row): row is TrackRow => row != null);

  const useFastMonitoredCount = input.monitored === true
    && !input.search
    && (!input.libraryFilter || input.libraryFilter === "all")
    && input.locked !== true;
  const totalResult = useFastMonitoredCount ? db.prepare(`
    SELECT COUNT(*) AS total
    FROM Tracks count_track
    WHERE count_track.album_release_id IN (
      SELECT count_slot.selected_album_release_id
      FROM ReleaseGroupSlots count_slot
      WHERE count_slot.monitored = 1
        AND count_slot.selected_album_release_id IS NOT NULL
        AND count_slot.selected_provider_id IS NOT NULL
    )
    ${input.downloaded === true ? `AND count_track.id IN (
      SELECT count_file.track_id FROM TrackFiles count_file
      WHERE count_file.track_id IS NOT NULL AND count_file.file_type = 'track'
    )` : input.downloaded === false ? `AND count_track.id NOT IN (
      SELECT count_file.track_id FROM TrackFiles count_file
      WHERE count_file.track_id IS NOT NULL AND count_file.file_type = 'track'
    )` : ""}
  `).get() as { total: number } : db.prepare(`
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
      id,
      provider_id AS media_id,
      file_type,
      file_path,
      relative_path,
      filename,
      extension,
      quality,
      library_root,
      file_size,
      bitrate,
      sample_rate,
      bit_depth,
      channels,
      codec,
      duration,
      canonical_artist_mbid,
      canonical_release_group_mbid,
      canonical_release_mbid,
      canonical_track_mbid,
      canonical_recording_mbid,
      provider,
      provider_entity_type,
      provider_id,
      library_slot,
      created_at,
      modified_at
    FROM TrackFiles
    WHERE canonical_track_mbid = ?
       OR provider_id = ?
    ORDER BY
      CASE file_type
        WHEN 'track' THEN 0
        WHEN 'lyrics' THEN 1
        ELSE 2
      END,
      file_path ASC,
      id ASC
  `).all(trackId, trackId) as LibraryFileRow[];

  return rows.map((row) => ({
    ...normalizeLibraryFileRow(row),
    created_at: row.created_at,
    modified_at: row.modified_at,
  }));
}
