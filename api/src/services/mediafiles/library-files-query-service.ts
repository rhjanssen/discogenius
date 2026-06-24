import path from "path";
import { db } from "../../database.js";
import { UpgradableSpecification } from "../config/upgradable-specification.js";
import type { LibraryFileContract, LibraryFilesListResponseContract } from "../../contracts/media.js";

type LibraryFileRow = {
  id: number;
  artist_id?: number | string | null;
  album_id?: number | string | null;
  media_id?: number | string | null;
  file_path: string;
  relative_path?: string | null;
  filename?: string | null;
  extension?: string | null;
  quality?: string | null;
  library_root?: string | null;
  file_size?: number | null;
  bitrate?: number | null;
  sample_rate?: number | null;
  bit_depth?: number | null;
  channels?: number | null;
  codec?: string | null;
  duration?: number | null;
  file_type: string;
  media_type?: string | null;
  source_quality?: string | null;
  album_quality?: string | null;
};

const canonicalSourceQualitySql = `
  COALESCE(
    (
      SELECT exact.quality
      FROM ProviderItems exact
      WHERE exact.provider = lf.provider
        AND exact.entity_type = lf.provider_entity_type
        AND exact.provider_id = lf.provider_id
      LIMIT 1
    ),
    (
      SELECT item.quality
      FROM ProviderItems item
      WHERE item.entity_type IN ('track', 'video')
        AND item.quality IS NOT NULL
        AND (lf.provider IS NULL OR item.provider = lf.provider)
        AND (lf.library_slot IS NULL OR item.library_slot = lf.library_slot)
        AND (
          (lf.canonical_track_mbid IS NOT NULL AND item.track_mbid = lf.canonical_track_mbid)
          OR (lf.canonical_recording_mbid IS NOT NULL AND item.recording_mbid = lf.canonical_recording_mbid)
        )
      ORDER BY
        CASE WHEN item.track_mbid IS NOT NULL THEN 0 ELSE 1 END,
        CASE WHEN item.recording_mbid IS NOT NULL THEN 0 ELSE 1 END,
        item.updated_at DESC
      LIMIT 1
    )
  )
`;

const canonicalAlbumQualitySql = `
  (
    SELECT item.quality
    FROM ProviderItems item
    WHERE item.entity_type = 'album'
      AND item.quality IS NOT NULL
      AND (lf.provider IS NULL OR item.provider = lf.provider)
      AND (lf.library_slot IS NULL OR item.library_slot = lf.library_slot)
      AND (
        (lf.canonical_release_mbid IS NOT NULL AND item.release_mbid = lf.canonical_release_mbid)
        OR (lf.canonical_release_group_mbid IS NOT NULL AND item.release_group_mbid = lf.canonical_release_group_mbid)
      )
    ORDER BY
      CASE WHEN item.release_mbid IS NOT NULL THEN 0 ELSE 1 END,
      CASE WHEN item.release_group_mbid IS NOT NULL THEN 0 ELSE 1 END,
      item.updated_at DESC
    LIMIT 1
  )
`;

type TextLibraryFileRow = {
  id: number;
  file_type: string;
  file_path: string;
  relative_path: string | null;
  library_root: string | null;
};

export type ListLibraryFilesOptions = {
  limit?: number;
  offset?: number;
  artistId?: string;
  albumId?: string;
  mediaId?: string;
  libraryRoot?: string;
  fileType?: string;
};

function parseNumberOrDefault(value: unknown, fallback: number): number {
  const parsed = parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mapLibraryFileRow(item: LibraryFileRow): LibraryFileContract {
  const filename = item.filename ?? (item.file_path ? path.basename(item.file_path) : undefined);
  const extension = item.extension ?? (item.file_path ? path.extname(item.file_path).replace(".", "") : undefined);
  return {
    id: item.id,
    file_type: item.file_type,
    file_path: item.file_path,
    artist_id: item.artist_id == null ? null : String(item.artist_id),
    album_id: item.album_id == null ? null : String(item.album_id),
    media_id: item.media_id == null ? null : String(item.media_id),
    relative_path: item.relative_path == null ? undefined : item.relative_path,
    filename: filename == null ? undefined : filename,
    extension: extension == null ? undefined : extension,
    quality: item.quality ?? null,
    library_root: item.library_root == null ? undefined : item.library_root,
    file_size: item.file_size == null ? undefined : item.file_size,
    bitrate: item.bitrate == null ? undefined : item.bitrate,
    sample_rate: item.sample_rate == null ? undefined : item.sample_rate,
    bit_depth: item.bit_depth == null ? undefined : item.bit_depth,
    channels: item.channels == null ? undefined : item.channels,
    codec: item.codec == null ? undefined : item.codec,
    duration: item.duration == null ? undefined : item.duration,
    qualityTarget: null,
    qualityChangeWanted: false,
    qualityChangeDirection: "none",
    qualityCutoffNotMet: false,
    qualityChangeReason: null,
  };
}

export function findTextLibraryFileByPath(filePath: string): TextLibraryFileRow | null {
  return (db.prepare(`
    SELECT id, file_type, file_path, relative_path, library_root
    FROM (
      SELECT
        0 AS source_order,
        id AS id,
        'lyrics' AS file_type,
        file_path AS file_path,
        relative_path AS relative_path,
        library_root AS library_root
      FROM LyricFiles
      WHERE file_path = ?

      UNION ALL

      SELECT
        1 AS source_order,
        id AS id,
        file_type AS file_type,
        file_path AS file_path,
        relative_path AS relative_path,
        library_root AS library_root
      FROM MetadataFiles
      WHERE file_path = ?
        AND file_type IN ('nfo', 'bio', 'review')

      UNION ALL

      SELECT
        2 AS source_order,
        id,
        file_type,
        file_path,
        relative_path,
        library_root
      FROM TrackFiles
      WHERE file_path = ?
        AND file_type IN ('lyrics', 'bio', 'review', 'nfo')
    )
    ORDER BY source_order ASC, id DESC
    LIMIT 1
  `).get(filePath, filePath, filePath) as TextLibraryFileRow | undefined) ?? null;
}

export function findLibraryFileById(syntheticId: number): {
  id: number;
  file_path: string;
  library_root: string;
  relative_path: string | null;
  file_type: string;
  quality?: string | null;
  codec?: string | null;
} | null {
  if (syntheticId >= 30000000) {
    const id = syntheticId - 30000000;
    const row = db.prepare("SELECT file_path, library_root, relative_path, quality FROM LyricFiles WHERE id = ?").get(id) as any;
    if (!row) return null;
    return {
      id,
      file_path: row.file_path,
      library_root: row.library_root,
      relative_path: row.relative_path,
      file_type: "lyrics",
      quality: row.quality,
    };
  }
  if (syntheticId >= 20000000) {
    const id = syntheticId - 20000000;
    const row = db.prepare("SELECT file_path, library_root, relative_path, file_type FROM ExtraFiles WHERE id = ?").get(id) as any;
    if (!row) return null;
    return {
      id,
      file_path: row.file_path,
      library_root: row.library_root,
      relative_path: row.relative_path,
      file_type: row.file_type,
    };
  }
  if (syntheticId >= 10000000) {
    const id = syntheticId - 10000000;
    const row = db.prepare("SELECT file_path, library_root, relative_path, file_type FROM MetadataFiles WHERE id = ?").get(id) as any;
    if (!row) return null;
    return {
      id,
      file_path: row.file_path,
      library_root: row.library_root,
      relative_path: row.relative_path,
      file_type: row.file_type,
    };
  }

  const row = db.prepare("SELECT id, file_path, library_root, relative_path, file_type, quality, codec FROM TrackFiles WHERE id = ?").get(syntheticId) as any;
  if (!row) return null;
  return {
    id: row.id,
    file_path: row.file_path,
    library_root: row.library_root,
    relative_path: row.relative_path,
    file_type: row.file_type,
    quality: row.quality,
    codec: row.codec,
  };
}

export function listLibraryFiles(options: ListLibraryFilesOptions = {}): LibraryFilesListResponseContract {
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;

  const where: string[] = [];
  const params: any[] = [];

  if (options.artistId) {
    where.push("lf.artist_id = ?");
    params.push(options.artistId);
  }
  if (options.albumId) {
    where.push("(lf.album_id = ? OR lf.canonical_release_group_mbid = ? OR lf.canonical_release_mbid = ?)");
    params.push(options.albumId, options.albumId, options.albumId);
  }
  if (options.mediaId) {
    where.push("(lf.media_id = ? OR lf.provider_id = ? OR lf.canonical_track_mbid = ? OR lf.canonical_recording_mbid = ?)");
    params.push(options.mediaId, options.mediaId, options.mediaId, options.mediaId);
  }
  if (options.libraryRoot) {
    where.push("lf.library_root = ?");
    params.push(options.libraryRoot);
  }
  if (options.fileType) {
    where.push("lf.file_type = ?");
    params.push(options.fileType);
  }

  const sql = `
    SELECT
      lf.*,
      CASE
        WHEN lf.file_type = 'video'
          OR lf.library_slot = 'video'
          OR lf.provider_entity_type = 'video'
          OR recording.is_video = 1
        THEN 'Music Video'
        ELSE NULL
      END AS media_type,
      ${canonicalSourceQualitySql} AS source_quality,
      ${canonicalAlbumQualitySql} AS album_quality
    FROM (
      SELECT
        id, artist_id, NULL AS album_id, provider_id AS media_id, file_path, relative_path, library_root, file_type, filename, extension,
        quality, file_size, bitrate, sample_rate, bit_depth, channels, codec, duration,
        canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
        canonical_track_mbid, canonical_recording_mbid,
        provider, provider_entity_type, provider_id, library_slot,
        created_at
      FROM TrackFiles

      UNION ALL

      SELECT id + 10000000 AS id, artist_id AS artist_id, album_id AS album_id, media_id AS media_id, file_path AS file_path, relative_path AS relative_path, library_root AS library_root, file_type AS file_type, NULL AS filename, extension AS extension,
        NULL AS quality, NULL AS file_size, NULL AS bitrate, NULL AS sample_rate, NULL AS bit_depth, NULL AS channels, NULL AS codec, NULL AS duration,
        NULL AS canonical_artist_mbid, NULL AS canonical_release_group_mbid, NULL AS canonical_release_mbid,
        NULL AS canonical_track_mbid, NULL AS canonical_recording_mbid,
        provider AS provider, provider_entity_type AS provider_entity_type, provider_id AS provider_id, library_slot AS library_slot,
        Added AS created_at
      FROM MetadataFiles

      UNION ALL

      SELECT id + 20000000 AS id, artist_id AS artist_id, album_id AS album_id, media_id AS media_id, file_path AS file_path, relative_path AS relative_path, library_root AS library_root, file_type AS file_type, NULL AS filename, extension AS extension,
        NULL AS quality, NULL AS file_size, NULL AS bitrate, NULL AS sample_rate, NULL AS bit_depth, NULL AS channels, NULL AS codec, NULL AS duration,
        NULL AS canonical_artist_mbid, NULL AS canonical_release_group_mbid, NULL AS canonical_release_mbid,
        NULL AS canonical_track_mbid, NULL AS canonical_recording_mbid,
        provider AS provider, provider_entity_type AS provider_entity_type, provider_id AS provider_id, library_slot AS library_slot,
        Added AS created_at
      FROM ExtraFiles

      UNION ALL

      SELECT id + 30000000 AS id, artist_id AS artist_id, album_id AS album_id, media_id AS media_id, file_path AS file_path, relative_path AS relative_path, library_root AS library_root, 'lyrics' AS file_type, NULL AS filename, extension AS extension,
        quality AS quality, NULL AS file_size, NULL AS bitrate, NULL AS sample_rate, NULL AS bit_depth, NULL AS channels, NULL AS codec, NULL AS duration,
        canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
        canonical_track_mbid, canonical_recording_mbid,
        provider AS provider, provider_entity_type AS provider_entity_type, provider_id AS provider_id, library_slot AS library_slot,
        Added AS created_at
      FROM LyricFiles
    ) lf
    LEFT JOIN Recordings recording ON recording.mbid = lf.canonical_recording_mbid
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY lf.created_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  const profile = UpgradableSpecification.buildEffectiveProfile();
  const rawItems = db.prepare(sql).all(...params) as LibraryFileRow[];
  const items: LibraryFileContract[] = rawItems.map((item) => {
    const evaluation = item.file_type === "video" || item.media_type === "Music Video"
      ? UpgradableSpecification.evaluateVideoChange({
        profile,
        currentQuality: item.quality,
        extension: item.extension,
      })
      : item.file_type === "track"
        ? UpgradableSpecification.evaluateAudioChange({
          profile,
          currentQuality: item.quality,
          sourceQuality: item.source_quality || item.album_quality,
          codec: item.codec,
          extension: item.extension,
          bitDepth: item.bit_depth,
          sampleRate: item.sample_rate,
        })
        : null;

    const mapped = mapLibraryFileRow(item);
    return {
      ...mapped,
      qualityTarget: evaluation?.targetQuality ?? null,
      qualityChangeWanted: evaluation?.needsChange ?? false,
      qualityChangeDirection: evaluation?.direction ?? "none",
      qualityCutoffNotMet: evaluation?.qualityCutoffNotMet ?? false,
      qualityChangeReason: evaluation?.needsChange ? evaluation.reason : null,
    };
  });

  return { items, limit, offset };
}

export function parseLibraryFilesQueryLimit(value: unknown): number {
  return parseNumberOrDefault(value, 100);
}

export function parseLibraryFilesQueryOffset(value: unknown): number {
  return parseNumberOrDefault(value, 0);
}
