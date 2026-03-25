import { db } from "../database.js";
import type { AlbumTrackContract, LibraryFileContract } from "../contracts/media.js";
import { getMediaDownloadStateMap } from "./download-state.js";

const trackDownloadedPredicate = `
  EXISTS (
    SELECT 1
    FROM library_files lf
    WHERE lf.media_id = media.id
      AND lf.file_type = 'track'
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
  artist_name?: string;
  artist_id?: number | string | null;
  album_title?: string;
  album_cover?: string | null;
  explicit?: boolean | number;
  monitor?: boolean | number;
  monitor_lock?: boolean | number;
  release_date?: string | null;
  popularity?: number | null;
  last_scanned?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface LibraryFileRow {
  id: number;
  media_id: number | string | null;
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
      return ` ORDER BY media.title ${dir}, media.id ASC`;
    case "popularity":
      return ` ORDER BY COALESCE(media.popularity, 0) ${dir}, media.id ASC`;
    case "scannedAt":
      return ` ORDER BY (media.last_scanned IS NULL) ASC, media.last_scanned ${dir}, media.id ASC`;
    case "releaseDate":
    default:
      return ` ORDER BY (media.release_date IS NULL) ASC, media.release_date ${dir}, media.id ASC`;
  }
}

function getTrackSelectSql(whereClause: string): string {
  return `
    SELECT
      media.*,
      albums.title as album_title,
      albums.cover as album_cover,
      artists.name as artist_name
    FROM media
    LEFT JOIN albums ON media.album_id = albums.id
    LEFT JOIN artists ON media.artist_id = artists.id
    ${whereClause}
  `;
}

export function hydrateTrackRows(tracks: TrackRow[]): AlbumTrackContract[] {
  const trackIds = tracks.map((track) => String(track.id));
  const downloadStates = getMediaDownloadStateMap(trackIds, "track");

  const filesByTrack = new Map<string, LibraryFileContract[]>();
  if (trackIds.length > 0) {
    const placeholders = trackIds.map(() => "?").join(",");
    const files = db.prepare(`
      SELECT id, media_id, file_type, file_path, relative_path, filename, extension,
             quality, library_root, file_size, bitrate, sample_rate, bit_depth, codec, duration
      FROM library_files
      WHERE media_id IN (${placeholders})
        AND file_type IN ('track', 'lyrics')
      ORDER BY file_type ASC, id ASC
    `).all(...trackIds) as LibraryFileRow[];

    for (const file of files) {
      const mediaId = String(file.media_id);
      const bucket = filesByTrack.get(mediaId) || [];
      bucket.push(normalizeLibraryFileRow(file));
      filesByTrack.set(mediaId, bucket);
    }
  }

  return tracks.map((track) => {
    const trackId = String(track.id);
    const isDownloaded = downloadStates.get(trackId) ?? false;

    return {
      ...track,
      id: trackId,
      album_id: track.album_id != null ? String(track.album_id) : null,
      is_monitored: Boolean(track.monitor),
      monitor_locked: Boolean(track.monitor_lock),
      explicit: track.explicit === undefined ? undefined : Boolean(track.explicit),
      downloaded: isDownloaded,
      is_downloaded: isDownloaded,
      files: filesByTrack.get(trackId) || [],
    };
  });
}

export function listTracks(input: ListTracksQuery): TracksListResponse {
  const where: string[] = ["media.album_id IS NOT NULL"];
  const params: Array<string | number> = [];
  const countParams: Array<string | number> = [];

  if (input.search) {
    const searchParam = `%${input.search}%`;
    where.push("(media.title LIKE ? OR artists.name LIKE ?)");
    params.push(searchParam, searchParam);
    countParams.push(searchParam, searchParam);
  }

  if (input.monitored !== undefined) {
    const monitoredValue = input.monitored ? 1 : 0;
    where.push("media.monitor = ?");
    params.push(monitoredValue);
    countParams.push(monitoredValue);
  }

  if (input.downloaded !== undefined) {
    where.push(input.downloaded ? trackDownloadedPredicate : `NOT (${trackDownloadedPredicate})`);
  }

  if (input.libraryFilter === "atmos") {
    where.push(`UPPER(COALESCE(media.quality, '')) = 'DOLBY_ATMOS'`);
  } else if (input.libraryFilter === "stereo") {
    where.push(`UPPER(COALESCE(media.quality, '')) <> 'DOLBY_ATMOS'`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sort = normalizeSortField(input.sort);
  const dir = normalizeSortDirection(input.dir);
  const orderBy = getTrackOrderBy(sort, dir);

  const rows = db.prepare(`
    ${getTrackSelectSql(whereClause)}
    ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, input.limit, input.offset) as TrackRow[];

  const totalResult = db.prepare(`
    SELECT COUNT(*) as total
    FROM media
    LEFT JOIN artists ON media.artist_id = artists.id
    ${whereClause}
  `).get(...countParams) as { total: number };

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
    ${getTrackSelectSql("WHERE media.id = ? AND media.album_id IS NOT NULL")}
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
      media_id,
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
      codec,
      duration,
      created_at,
      modified_at
    FROM library_files
    WHERE media_id = ?
    ORDER BY
      CASE file_type
        WHEN 'track' THEN 0
        WHEN 'lyrics' THEN 1
        ELSE 2
      END,
      file_path ASC,
      id ASC
  `).all(trackId) as LibraryFileRow[];

  return rows.map((row) => ({
    ...normalizeLibraryFileRow(row),
    created_at: row.created_at,
    modified_at: row.modified_at,
  }));
}
