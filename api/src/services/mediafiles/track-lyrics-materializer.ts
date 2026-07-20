import fs from "node:fs";
import path from "node:path";

import { db } from "../../database.js";
import { Config, getConfigSection } from "../config/config.js";
import {
  getLyricsForProviderMedia,
  type ResolvedLyrics,
} from "../extras/lyrics/lyric-service.js";
import {
  classifyLyricsForSidecar,
  findAdjacentLyricSidecar,
  lyricSidecarPath,
} from "../extras/lyrics/lyric-sidecar.js";
import { LibraryFilesService } from "./library-files.js";
import { resolveLibraryRootPath, resolveStoredLibraryPath } from "./library-paths.js";

type TrackLyricsRow = {
  id: number;
  artist_id: number;
  album_id: number | null;
  file_path: string;
  relative_path: string | null;
  library_root: string | null;
  library_slot: string | null;
  quality: string | null;
  provider: string | null;
  provider_id: string;
  canonical_artist_mbid: string | null;
  canonical_release_group_mbid: string | null;
  canonical_release_mbid: string | null;
  canonical_track_mbid: string | null;
  canonical_recording_mbid: string | null;
};

export type TrackLyricsMaterializeResult = {
  lyricsByProviderMedia: Map<string, ResolvedLyrics | null>;
  discovered: number;
  saved: number;
  missing: number;
};

export function providerMediaLyricsKey(
  provider: string | null | undefined,
  providerMediaId: string | number | null | undefined,
): string {
  return `${String(provider || "").trim()}\u0000${String(providerMediaId ?? "").trim()}`;
}

function resolvedLyricsFromExistingSidecar(
  mediaPath: string,
  provider: string,
  providerId: string,
): { filePath: string; lyrics: ResolvedLyrics } | null {
  const sidecar = findAdjacentLyricSidecar(mediaPath, { normalizeExtension: true });
  if (!sidecar) return null;
  return {
    filePath: sidecar.filePath,
    lyrics: {
      text: sidecar.text,
      subtitles: sidecar.subtitles,
      provider,
      matchType: "exact",
      sourceProviderId: providerId,
    },
  };
}

function fallbackLibraryRoot(row: TrackLyricsRow, resolvedFilePath: string): string {
  return resolveLibraryRootPath(row.library_root, resolvedFilePath)
    || (row.library_slot === "spatial" ? Config.getSpatialPath() : Config.getMusicPath());
}

function trackRowsForMediaIds(
  mediaIds: string[],
  requestedProvider?: string | null,
): TrackLyricsRow[] {
  const placeholders = mediaIds.map(() => "?").join(",");
  const provider = String(requestedProvider || "").trim();
  const providerClause = provider ? "AND provider = ?" : "";
  const params: Array<string> = [
    ...mediaIds,
    ...mediaIds,
    ...mediaIds,
  ];
  if (provider) params.push(provider);
  return db.prepare(`
    SELECT
      id,
      artist_id,
      NULL AS album_id,
      file_path,
      relative_path,
      library_root,
      library_slot,
      quality,
      provider,
      CAST(provider_id AS TEXT) AS provider_id,
      canonical_artist_mbid,
      canonical_release_group_mbid,
      canonical_release_mbid,
      canonical_track_mbid,
      canonical_recording_mbid
    FROM TrackFiles
    WHERE file_type = 'track'
      AND provider_id IS NOT NULL
      AND (
        CAST(provider_id AS TEXT) IN (${placeholders})
        OR canonical_track_mbid IN (${placeholders})
        OR canonical_recording_mbid IN (${placeholders})
      )
      ${providerClause}
    ORDER BY id ASC
  `).all(...params) as TrackLyricsRow[];
}

export class TrackLyricsMaterializer {
  /**
   * Resolve lyrics immediately after an import, save adjacent synchronized
   * `.lrc` or plain `.txt` sidecars when configured, and return the same
   * resolved values for the tag writer.
   * A null entry is deliberate: it prevents the following retag pass from
   * repeating a failed provider request for every metadata read/write phase.
   */
  static async materializeForMediaIds(
    mediaIds: Array<string | number>,
    requestedProvider?: string | null,
  ): Promise<TrackLyricsMaterializeResult> {
    const uniqueMediaIds = Array.from(new Set(
      mediaIds.map((value) => String(value).trim()).filter(Boolean),
    ));
    const result: TrackLyricsMaterializeResult = {
      lyricsByProviderMedia: new Map(),
      discovered: 0,
      saved: 0,
      missing: 0,
    };
    if (uniqueMediaIds.length === 0) return result;

    const metadata = getConfigSection("metadata");
    const quality = getConfigSection("quality");
    if (!metadata.save_lyrics && !quality.embed_lyrics) return result;

    const rows = trackRowsForMediaIds(uniqueMediaIds, requestedProvider);
    const resolutionPromises = new Map<string, Promise<ResolvedLyrics | null>>();

    const resolveRow = async (row: TrackLyricsRow): Promise<void> => {
      const provider = String(row.provider || requestedProvider || "").trim();
      const providerId = String(row.provider_id || "").trim();
      if (!provider || !providerId) return;
      const key = providerMediaLyricsKey(provider, providerId);
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
        relativePath: row.relative_path,
      });
      const existingSidecar = resolvedLyricsFromExistingSidecar(
        resolvedFilePath,
        provider,
        providerId,
      );

      let resolution = resolutionPromises.get(key);
      if (!resolution) {
        resolution = Promise.resolve(existingSidecar?.lyrics ?? null)
          .then((existing) => existing || getLyricsForProviderMedia(providerId, provider))
          .catch((error) => {
            console.warn(`[Lyrics] Failed to resolve ${provider} track ${providerId}:`, error);
            return null;
          });
        resolutionPromises.set(key, resolution);
      }

      const lyrics = await resolution;
      if (!lyrics) {
        result.lyricsByProviderMedia.set(key, null);
        result.missing++;
        return;
      }

      const classified = classifyLyricsForSidecar(lyrics);
      if (!classified) {
        result.lyricsByProviderMedia.set(key, null);
        result.missing++;
        return;
      }
      const normalizedLyrics: ResolvedLyrics = {
        ...lyrics,
        text: classified.text,
        subtitles: classified.subtitles,
      };
      result.lyricsByProviderMedia.set(key, normalizedLyrics);
      result.discovered++;
      const lyricPath = existingSidecar?.filePath
        ?? lyricSidecarPath(resolvedFilePath, classified.extension);

      if (metadata.save_lyrics || getConfigSection("quality").embed_lyrics) {
        // Persist a sidecar whenever we embed or the user asked to save lyrics.
        // Without a stable on-disk copy, retag preview re-fetches live lyrics and
        // often flags a false "needs change" right after import.
        if (!fs.existsSync(lyricPath)) {
          fs.mkdirSync(path.dirname(lyricPath), { recursive: true });
          fs.writeFileSync(lyricPath, `${classified.content}\n`, "utf8");
          result.saved++;
        }
      }

      if (fs.existsSync(lyricPath)) {
        const libraryRoot = fallbackLibraryRoot(row, resolvedFilePath);
        LibraryFilesService.upsertLibraryFile({
          artistId: String(row.artist_id),
          albumId: row.album_id == null ? null : String(row.album_id),
          mediaId: providerId,
          trackFileId: row.id,
          filePath: lyricPath,
          libraryRoot,
          fileType: "lyrics",
          expectedPath: lyricPath,
          librarySlot: row.library_slot,
          quality: row.quality,
          provider,
          providerEntityType: "track",
          providerId,
          canonicalArtistMbid: row.canonical_artist_mbid,
          canonicalReleaseGroupMbid: row.canonical_release_group_mbid,
          canonicalReleaseMbid: row.canonical_release_mbid,
          canonicalTrackMbid: row.canonical_track_mbid,
          canonicalRecordingMbid: row.canonical_recording_mbid,
        });
      }
    };

    const pending = [...rows];
    const worker = async () => {
      while (pending.length > 0) {
        const row = pending.shift();
        if (row) await resolveRow(row);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, () => worker()));
    return result;
  }
}
