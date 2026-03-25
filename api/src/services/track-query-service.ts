import { db } from "../database.js";
import type { AlbumTrackContract, LibraryFileContract } from "../contracts/media.js";
import { getMediaDownloadStateMap } from "./download-state.js";

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
  album_title?: string;
  explicit?: boolean | number;
  monitor?: boolean | number;
  monitor_lock?: boolean | number;
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
