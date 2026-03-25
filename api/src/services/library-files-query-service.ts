import { db } from "../database.js";
import { UpgradableSpecification } from "./upgradable-specification.js";
import type { LibraryFileContract, LibraryFilesListResponseContract } from "../contracts/media.js";

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
  return {
    id: item.id,
    file_type: item.file_type,
    file_path: item.file_path,
    artist_id: item.artist_id == null ? null : String(item.artist_id),
    album_id: item.album_id == null ? null : String(item.album_id),
    media_id: item.media_id == null ? null : String(item.media_id),
    relative_path: item.relative_path == null ? undefined : item.relative_path,
    filename: item.filename == null ? undefined : item.filename,
    extension: item.extension == null ? undefined : item.extension,
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
    where.push("lf.album_id = ?");
    params.push(options.albumId);
  }
  if (options.mediaId) {
    where.push("lf.media_id = ?");
    params.push(options.mediaId);
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
      m.type AS media_type,
      m.quality AS source_quality,
      a.quality AS album_quality
    FROM library_files lf
    LEFT JOIN media m ON m.id = lf.media_id
    LEFT JOIN albums a ON a.id = lf.album_id
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
