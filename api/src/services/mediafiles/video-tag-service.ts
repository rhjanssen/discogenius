import fs from "fs";
import path from "path";
import { db, withSqliteWriteGate } from "../../database.js";
import { resolveStoredLibraryPath } from "./library-paths.js";
import { writeMetadata } from "./audioUtils.js";
import { AudioTagService, parseArtistCreditNames, parseArtistCreditIds, parseArtistCreditString, type ManagedTag, type RetagApplyResult } from "./audio-tag-service.js";
import { loadCreditSnapshot } from "../metadata/relationship-credit-store.js";
import { relationshipCreditRemovalTags, relationshipManagedTags } from "./relationship-credit-tags.js";
import { getConfigSection } from "../config/config.js";
import { parseRecordingIsrcs } from "../music/recording-coverage-units.js";
import { SQL_JSON_LIST, jsonList } from "../../utils/sql-id-list.js";

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
  isrcs?: string | null;
  youtube_video_id?: string | null;
  album_title?: string | null;
  album_genres?: string | null;
  release_mbid?: string | null;
  release_group_mbid?: string | null;
};

function dottedExtension(extension: string | null | undefined): string {
  const raw = String(extension || "").trim().toLowerCase();
  if (!raw) return "";
  return raw.startsWith(".") ? raw : `.${raw}`;
}

function jsonNames(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => (typeof item === "string" ? item.trim() : "")).filter((item) => item.length > 0);
  } catch {
    return [];
  }
}

const MP4_FAMILY = new Set([".mp4", ".m4v", ".mov", ".m4a"]);

/** Fields this writer used to store and players do not read as music-video tags. */
export function buildVideoLegacyRemovals(): ManagedTag[] {
  const item = (key: string, ffmpegKey: string): ManagedTag => ({ key, label: key, ffmpegKey, targetValue: "" });
  return [
    item("provider_url", "PROVIDER_URL"),
    item("youtube_video_id", "YOUTUBE_VIDEO_ID"),
    item("provider", "PROVIDER"),
    item("provider_id", "PROVIDER_ID"),
    item("quality", "QUALITY"),
    item("copyright", "copyright"),
    item("album_artist", "album_artist"),
    item("musicbrainz_albumid", "musicbrainz_albumid"),
    item("musicbrainz_releasegroupid", "musicbrainz_releasegroupid"),
  ];
}

function normalizedDate(value: string | null): string {
  const raw = String(value || "").trim();
  return raw.match(/^\d{4}(?:-\d{2}-\d{2})?/)?.[0] || raw;
}

export function buildVideoManagedTags(row: VideoTagRow): ManagedTag[] {
  const creditedArtists = parseArtistCreditNames(null, row.recording_credits);
  const artistMbids = parseArtistCreditIds(row.recording_credits);
  const artist = parseArtistCreditString(row.recording_credits)
    || creditedArtists.join("; ")
    || String(row.artist_name || "Unknown Artist");
  const artistList = creditedArtists.length > 0 ? creditedArtists : [artist];
  const tags: ManagedTag[] = [
    { key: "title", label: "Title", ffmpegKey: "title", targetValue: String(row.title || "Unknown Video") },
    { key: "artist", label: "Artist", ffmpegKey: "artist", targetValue: artist },
    { key: "artists", label: "Artists", ffmpegKey: "ARTISTS", targetValue: artistList.join("; ") },
  ];
  if (MP4_FAMILY.has(dottedExtension(row.extension))) {
    tags.unshift({ key: "media_kind", label: "Media kind", ffmpegKey: "stik", targetValue: "6" });
  }

  const add = (key: string, label: string, ffmpegKey: string, value: string | null | undefined) => {
    const targetValue = String(value || "").trim();
    if (targetValue) tags.push({ key, label, ffmpegKey, targetValue });
  };

  add("album", "Album", "album", row.album_title);
  add("date", "Date", "date", normalizedDate(row.release_date));
  add("genre", "Genre", "genre", jsonNames(row.album_genres).join("; "));
  add("musicbrainz_recordingid", "MusicBrainz Recording ID", "MUSICBRAINZ_TRACKID", row.recording_mbid);
  add("musicbrainz_artistid", "MusicBrainz Artist ID", "MUSICBRAINZ_ARTISTID", artistMbids.join("; ") || row.artist_mbid);
  add("isrc", "ISRC", "ISRC", parseRecordingIsrcs(row.isrcs).join("; "));
  return tags;
}

function relationshipTagsForVideo(row: VideoTagRow, snapshot: ReturnType<typeof loadCreditSnapshot>): ManagedTag[] {
  if (!snapshot) return [];
  const recording = String(row.recording_mbid || "").trim().toLowerCase();
  const release = String(row.release_mbid || "").trim().toLowerCase();
  if (!recording || !snapshot.known.has(recording)) return [];
  const works = snapshot.works.filter((work) => work.recordingMbid === recording);
  const workIds = new Set(works.map((work) => work.workMbid));
  const credits = snapshot.credits.filter((credit) =>
    (credit.scope === "recording" && credit.entityMbid === recording)
    || (credit.scope === "release" && credit.entityMbid === release)
    || (credit.scope === "work" && workIds.has(credit.entityMbid)));
  return relationshipManagedTags({
    credits,
    works,
    extension: dottedExtension(row.extension),
    mediumPosition: null,
  });
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
        file.quality,
        COALESCE(recording.title, provider_item.title) AS title,
        COALESCE(recording.release_date, edition.date, provider_item.release_date) AS release_date,
        COALESCE(recording.copyright, provider_item.copyright) AS copyright,
        COALESCE(artist.name, artist_metadata.name) AS artist_name,
        COALESCE(file.canonical_artist_mbid, artist.mbid, artist_metadata.mbid) AS artist_mbid,
        recording.mbid AS recording_mbid,
        recording.credits AS recording_credits,
        COALESCE(NULLIF(recording.isrcs, '[]'), provider_item.isrc) AS isrcs,
        recording.youtube_video_id,
        COALESCE(edition.title, album.title) AS album_title,
        album.genres AS album_genres,
        edition.mbid AS release_mbid,
        album.mbid AS release_group_mbid
      FROM TrackFiles file
      LEFT JOIN ArtistMetadata artist ON artist.id = file.artist_metadata_id
      LEFT JOIN ProviderItems provider_item
        ON provider_item.id = COALESCE(file.provider_item_id, (
          SELECT candidate.id
          FROM ProviderItems candidate
          WHERE candidate.entity_type = 'video'
            AND candidate.provider_id = file.provider_id
            AND candidate.provider = file.provider
        ))
       AND provider_item.entity_type = 'video'
       AND (file.provider IS NULL OR provider_item.provider = file.provider)
      LEFT JOIN ProviderVideoMatches video_match
        ON video_match.provider_video_item_id = provider_item.id
       AND video_match.match_state = 'accepted'
      LEFT JOIN Recordings recording
        ON (recording.id = COALESCE(file.recording_id, video_match.recording_id)
          OR (file.recording_id IS NULL AND video_match.recording_id IS NULL AND recording.mbid = file.canonical_recording_mbid))
       AND recording.is_video = 1
      LEFT JOIN AlbumEditions edition ON edition.id = file.album_edition_id
      LEFT JOIN Albums album ON album.id = COALESCE(file.release_group_id, edition.release_group_id)
      LEFT JOIN ArtistMetadata artist_metadata
        ON artist_metadata.id = recording.artist_metadata_id
      WHERE file.file_type = 'video' AND ${where}
      ORDER BY file.id
    `).all(...params) as VideoTagRow[];
  }

  static async apply(ids: number[], options: { deferPersistence?: boolean; onFileStart?: (index: number, total: number) => void } = {}): Promise<RetagApplyResult> {
    const uniqueIds = Array.from(new Set(ids.filter(Number.isFinite)));
    if (uniqueIds.length === 0) return { retagged: 0, skipped: 0, missing: 0, errors: [] };
    return this.applyRows(this.getRows(`file.id IN ${SQL_JSON_LIST}`, [jsonList(uniqueIds)]), options);
  }

  static async applyForArtists(artistIds: string[]): Promise<RetagApplyResult> {
    const result: RetagApplyResult = { retagged: 0, skipped: 0, missing: 0, errors: [] };
    for (const artistId of [...new Set(artistIds)]) {
      const items = await this.applyRows(this.getRows("artist.mbid = ?", [artistId]));
      result.retagged += items.retagged;
      result.skipped += items.skipped;
      result.missing += items.missing;
      result.errors.push(...items.errors);
    }
    return result;
  }

  static getFileIdsForArtists(artistIds: string[]): number[] {
    if (artistIds.length === 0) return [];
    return (db.prepare(`SELECT file.id FROM TrackFiles file
      JOIN ArtistMetadata artist ON artist.id = file.artist_metadata_id
      WHERE file.file_type = 'video' AND artist.mbid IN (SELECT value FROM json_each(?))
      ORDER BY file.id`).all(JSON.stringify(artistIds)) as Array<{ id: number }>).map(row => row.id);
  }

  private static async applyRows(rows: VideoTagRow[], options: { deferPersistence?: boolean; onFileStart?: (index: number, total: number) => void } = {}): Promise<RetagApplyResult> {
    const result: RetagApplyResult = { retagged: 0, skipped: 0, missing: 0, errors: [] };
    const config = getConfigSection("metadata");
    if ((config.write_audio_tags_policy ?? "no") === "no") return { ...result, skipped: rows.length };
    const creditSnapshot = loadCreditSnapshot(
      db,
      rows.map((row) => row.recording_mbid),
      rows.map((row) => row.release_mbid),
    );
    const update = db.prepare(`
      UPDATE TrackFiles SET file_size = ?, modified_at = ?, verified_at = CURRENT_TIMESTAMP WHERE id = ?
    `);

    for (const [index, row] of rows.entries()) {
      options.onFileStart?.(index + 1, rows.length);
      try {
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
        const taggedRow = { ...row, extension };
        const knownCredits = relationshipTagsForVideo(taggedRow, creditSnapshot);
        const creditsKnown = creditSnapshot?.known.has(String(row.recording_mbid || "").trim().toLowerCase()) === true;
        const managedTags = [...buildVideoManagedTags(taggedRow), ...knownCredits];
        const removals = [
          ...AudioTagService.buildManagedTagRemovals(config),
          ...buildVideoLegacyRemovals(),
          ...(creditsKnown ? relationshipCreditRemovalTags(dottedExtension(extension)) : []),
        ];
        const diff = await AudioTagService.evaluateFileTags(resolvedPath, managedTags, removals, config.scrub_audio_tags === true);
        if (diff.changes.length === 0) { result.skipped++; continue; }
        const tags = AudioTagService.buildAudioTagWriteMap(managedTags, extension);
        const success = await writeMetadata(resolvedPath, tags, diff.removalKeys);
        if (!success) {
          result.errors.push({ id: row.id, error: "Video metadata write failed" });
          continue;
        }

        const stat = fs.statSync(resolvedPath);
        if (options.deferPersistence) {
          (result.fileFacts ??= []).push({
            id: row.id,
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            fingerprint: null,
          });
        } else {
          await withSqliteWriteGate(() => update.run(stat.size, stat.mtime.toISOString(), row.id), "retag:video-file-facts");
        }
        result.retagged++;
      } catch (error) {
        result.errors.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return result;
  }
}
