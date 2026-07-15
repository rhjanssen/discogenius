import fs from "fs";
import path from "path";
import { db } from "../../database.js";
import { resolveStoredLibraryPath } from "./library-paths.js";
import { writeMetadata } from "./audioUtils.js";
import { AudioTagService, type ManagedTag, type RetagApplyResult } from "./audio-tag-service.js";

type VideoTagRow = {
  id: number;
  file_path: string;
  relative_path: string | null;
  library_root: string | null;
  extension: string | null;
  provider: string | null;
  provider_id: string | null;
  provider_url: string | null;
  quality: string | null;
  title: string | null;
  release_date: string | null;
  copyright: string | null;
  artist_name: string | null;
  artist_mbid: string | null;
  recording_mbid: string | null;
  recording_credits: string | null;
};

function parseCreditNames(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((credit) => String(credit?.name || credit?.artist?.name || "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function normalizedDate(value: string | null): string {
  const raw = String(value || "").trim();
  return raw.match(/^\d{4}(?:-\d{2}-\d{2})?/)?.[0] || raw;
}

export function buildVideoManagedTags(row: VideoTagRow): ManagedTag[] {
  const creditedArtists = parseCreditNames(row.recording_credits);
  const artist = creditedArtists.join("; ") || String(row.artist_name || "Unknown Artist");
  const tags: ManagedTag[] = [
    { key: "title", label: "Title", ffmpegKey: "title", targetValue: String(row.title || "Unknown Video") },
    { key: "artist", label: "Artist", ffmpegKey: "artist", targetValue: artist },
    { key: "album_artist", label: "Album Artist", ffmpegKey: "album_artist", targetValue: String(row.artist_name || artist) },
  ];

  const add = (key: string, label: string, ffmpegKey: string, value: string | null | undefined) => {
    const targetValue = String(value || "").trim();
    if (targetValue) tags.push({ key, label, ffmpegKey, targetValue });
  };

  add("date", "Date", "date", normalizedDate(row.release_date));
  add("copyright", "Copyright", "copyright", row.copyright);
  add("musicbrainz_recordingid", "MusicBrainz Recording ID", "musicbrainz_recordingid", row.recording_mbid);
  add("musicbrainz_artistid", "MusicBrainz Artist ID", "musicbrainz_artistid", row.artist_mbid);
  add("provider_url", "Provider URL", "PROVIDER_URL", row.provider_url);
  add("provider", "Provider", "PROVIDER", row.provider);
  add("provider_id", "Provider Video ID", "PROVIDER_ID", row.provider_id);
  add("quality", "Quality", "QUALITY", row.quality);
  return tags;
}

export class VideoTagService {
  private static getRows(where: string, params: Array<string | number>): VideoTagRow[] {
    return db.prepare(`
      SELECT
        file.id,
        file.file_path,
        file.relative_path,
        file.library_root,
        file.extension,
        COALESCE(file.provider, provider_item.provider) AS provider,
        COALESCE(file.provider_id, provider_item.provider_id) AS provider_id,
        provider_item.provider_url,
        COALESCE(file.quality, provider_item.quality) AS quality,
        COALESCE(provider_item.title, recording.title) AS title,
        provider_item.release_date,
        COALESCE(provider_item.copyright, recording.copyright) AS copyright,
        artist.name AS artist_name,
        COALESCE(file.canonical_artist_mbid, artist.mbid, provider_item.artist_mbid) AS artist_mbid,
        COALESCE(file.canonical_recording_mbid, recording.mbid, provider_item.recording_mbid) AS recording_mbid,
        recording.credits AS recording_credits
      FROM TrackFiles file
      JOIN Artists artist ON artist.id = file.artist_id
      LEFT JOIN ProviderItems provider_item
        ON provider_item.rowid = (
          SELECT candidate.rowid
          FROM ProviderItems candidate
          WHERE candidate.entity_type = 'video'
            AND candidate.provider_id = file.provider_id
            AND (file.provider IS NULL OR candidate.provider = file.provider)
          ORDER BY candidate.updated_at DESC
          LIMIT 1
        )
      LEFT JOIN Recordings recording
        ON recording.id = COALESCE(file.recording_id, provider_item.recording_id)
      WHERE file.file_type = 'video' AND ${where}
      ORDER BY file.id
    `).all(...params) as VideoTagRow[];
  }

  static async apply(ids: number[]): Promise<RetagApplyResult> {
    const uniqueIds = Array.from(new Set(ids.filter(Number.isFinite)));
    if (uniqueIds.length === 0) return { retagged: 0, skipped: 0, missing: 0, errors: [] };
    const marks = uniqueIds.map(() => "?").join(",");
    return this.applyRows(this.getRows(`file.id IN (${marks})`, uniqueIds));
  }

  static async applyForProviderIds(providerIds: Array<string | number>): Promise<RetagApplyResult> {
    const ids = Array.from(new Set(providerIds.map(String).map((value) => value.trim()).filter(Boolean)));
    if (ids.length === 0) return { retagged: 0, skipped: 0, missing: 0, errors: [] };
    const marks = ids.map(() => "?").join(",");
    return this.applyRows(this.getRows(`file.provider_id IN (${marks})`, ids));
  }

  private static async applyRows(rows: VideoTagRow[]): Promise<RetagApplyResult> {
    const result: RetagApplyResult = { retagged: 0, skipped: 0, missing: 0, errors: [] };
    const update = db.prepare(`
      UPDATE TrackFiles SET file_size = ?, modified_at = ?, verified_at = CURRENT_TIMESTAMP WHERE id = ?
    `);

    for (const row of rows) {
      const resolvedPath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
        relativePath: row.relative_path,
      });
      if (!fs.existsSync(resolvedPath)) {
        result.missing++;
        continue;
      }

      const extension = row.extension || path.extname(resolvedPath);
      const tags = AudioTagService.buildAudioTagWriteMap(buildVideoManagedTags(row), extension);
      const success = await writeMetadata(resolvedPath, tags);
      if (!success) {
        result.errors.push({ id: row.id, error: "Video metadata write failed" });
        continue;
      }

      const stat = fs.statSync(resolvedPath);
      update.run(stat.size, stat.mtime.toISOString(), row.id);
      result.retagged++;
    }

    return result;
  }
}
