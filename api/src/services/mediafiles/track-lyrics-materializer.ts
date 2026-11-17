import fs from "node:fs";
import path from "node:path";

import { db, withSqliteWriteGate } from "../../database.js";
import { Config, getConfigSection } from "../config/config.js";
import {
  getLyricsForProviderMedia,
  type ResolvedLyrics,
} from "../extras/lyrics/lyric-service.js";
import {
  classifyLyricsForSidecar,
  findAdjacentLyricSidecar,
  isSynchronizedLyricContent,
  lyricSidecarPath,
} from "../extras/lyrics/lyric-sidecar.js";
import { LibraryFilesService } from "./library-files.js";
import { resolveLibraryRootPath, resolveStoredLibraryPath } from "./library-paths.js";
import { SQL_JSON_LIST, jsonList } from "../../utils/sql-id-list.js";
import { readIntEnv } from "../../utils/env.js";

/**
 * Lyrics are optional extras. One track's lookup (the provider call plus the
 * walk over related recordings) gets this long; a whole album gets the
 * budget. Past either limit the track is filed without fetched lyrics and the
 * lyrics refresh can fill it in later, so a slow lyrics service can never
 * hold a download slot until the stalled-progress watchdog fires.
 */
export const LYRICS_LOOKUP_TIMEOUT_MS = readIntEnv("DISCOGENIUS_LYRICS_LOOKUP_TIMEOUT_MS", 20_000, 1);
export const LYRICS_ALBUM_BUDGET_MS = readIntEnv("DISCOGENIUS_LYRICS_ALBUM_BUDGET_MS", 5 * 60_000, 1);

export type LyricsLookupLimits = {
  /** Upper bound for one track's lookup. */
  lookupTimeoutMs?: number;
  /** Upper bound for every lookup of one prefetch or import together. */
  budgetMs?: number;
};

const LOOKUP_TIMED_OUT = Symbol("lyrics-lookup-timed-out");

/** Resolve to the lookup, or LOOKUP_TIMED_OUT once `ms` passes (ms <= 0 means "already late"). */
async function lyricsWithin<T>(lookup: () => Promise<T>, ms: number): Promise<T | typeof LOOKUP_TIMED_OUT> {
  if (ms <= 0) return LOOKUP_TIMED_OUT;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof LOOKUP_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(LOOKUP_TIMED_OUT), ms);
  });
  try {
    const pending = lookup();
    // A lookup that loses the race keeps running; never let it reject unhandled.
    pending.catch(() => undefined);
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function lookupLimits(limits?: LyricsLookupLimits): { lookupTimeoutMs: number; deadline: number } {
  const lookupTimeoutMs = Math.max(1, limits?.lookupTimeoutMs ?? LYRICS_LOOKUP_TIMEOUT_MS);
  const budgetMs = Math.max(1, limits?.budgetMs ?? LYRICS_ALBUM_BUDGET_MS);
  return { lookupTimeoutMs, deadline: Date.now() + budgetMs };
}

type TrackLyricsRow = {
  id: number;
  library_id: number;
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
): { filePath: string; synchronized: boolean; lyrics: ResolvedLyrics } | null {
  const sidecar = findAdjacentLyricSidecar(mediaPath, { normalizeExtension: true });
  if (!sidecar) return null;
  return {
    filePath: sidecar.filePath,
    synchronized: sidecar.synchronized,
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

async function removeUnsyncedLyricSidecar(
  existingSidecar: { filePath: string; synchronized: boolean } | null,
  replacementPath: string,
): Promise<void> {
  if (!existingSidecar || existingSidecar.synchronized) return;
  const previousPath = path.resolve(existingSidecar.filePath);
  if (previousPath === path.resolve(replacementPath)) return;
  try {
    if (fs.existsSync(previousPath)) {
      fs.unlinkSync(previousPath);
    }
  } catch (error) {
    console.warn(`[Lyrics] Failed to remove unsynced sidecar ${previousPath}:`, error);
  }
  await withSqliteWriteGate(() => {
    db.prepare("DELETE FROM LyricFiles WHERE file_path = ?").run(existingSidecar.filePath);
  }, "lyrics:remove-sidecar-index");
}

function trackRowsForFileIds(fileIds: number[]): TrackLyricsRow[] {
  const uniqueIds = Array.from(new Set(fileIds.filter((id) => Number.isInteger(id) && id > 0)));
  if (uniqueIds.length === 0) return [];
  return db.prepare(`
    SELECT
      id,
      library_id,
      artist_metadata_id AS artist_id,
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
      AND id IN ${SQL_JSON_LIST}
    ORDER BY id ASC
  `).all(jsonList(uniqueIds)) as TrackLyricsRow[];
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
      library_id,
      artist_metadata_id AS artist_id,
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

    return this.materializeRows(trackRowsForMediaIds(uniqueMediaIds, requestedProvider), requestedProvider);
  }

  /**
   * Same as materializeForMediaIds, keyed by exact TrackFiles.id.
   * Import must use this: a provider_id is unique only within (provider, entity_type),
   * and a fallback stamps a different provider than the command that queued the job.
   */
  static async materializeForFileIds(
    fileIds: number[],
    requestedProvider?: string | null,
    prefetched?: Record<string, ResolvedLyrics | null>,
    onFileStart?: (index: number, total: number) => void,
    limits?: LyricsLookupLimits,
  ): Promise<TrackLyricsMaterializeResult> {
    const metadata = getConfigSection("metadata");
    const quality = getConfigSection("quality");
    if (!metadata.save_lyrics && !quality.embed_lyrics) {
      return {
        lyricsByProviderMedia: new Map(),
        discovered: 0,
        saved: 0,
        missing: 0,
      };
    }
    return this.materializeRows(trackRowsForFileIds(fileIds), requestedProvider, prefetched, onFileStart, limits);
  }

  private static async materializeRows(
    rows: TrackLyricsRow[],
    requestedProvider?: string | null,
    prefetched?: Record<string, ResolvedLyrics | null>,
    onFileStart?: (index: number, total: number) => void,
    limits?: LyricsLookupLimits,
  ): Promise<TrackLyricsMaterializeResult> {
    const result: TrackLyricsMaterializeResult = {
      lyricsByProviderMedia: new Map(),
      discovered: 0,
      saved: 0,
      missing: 0,
    };
    if (rows.length === 0) return result;

    const metadata = getConfigSection("metadata");
    const resolutionPromises = new Map<string, Promise<ResolvedLyrics | null>>();
    const { lookupTimeoutMs, deadline } = lookupLimits(limits);
    let timedOutLookups = 0;
    const boundedLookup = async (providerId: string, provider: string): Promise<ResolvedLyrics | null> => {
      const found = await lyricsWithin(
        () => getLyricsForProviderMedia(providerId, provider),
        Math.min(lookupTimeoutMs, deadline - Date.now()),
      );
      if (found === LOOKUP_TIMED_OUT) {
        timedOutLookups += 1;
        return null;
      }
      return found;
    };

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
        // A tiddl unsynced sidecar must not hide catalogue timed lyrics.
        // Keep a synchronized sidecar; otherwise try the provider/API and
        // fall back to whatever was already on disk.
        const existingHasSync = Boolean(
          existingSidecar?.synchronized
          || isSynchronizedLyricContent(existingSidecar?.lyrics.subtitles)
          || isSynchronizedLyricContent(existingSidecar?.lyrics.text),
        );
        resolution = (existingHasSync
          ? Promise.resolve(existingSidecar?.lyrics ?? null)
          : (prefetched && Object.hasOwn(prefetched, key)
            ? Promise.resolve(prefetched[key] ?? null)
            : boundedLookup(providerId, provider))
            .then((apiLyrics) => apiLyrics || existingSidecar?.lyrics || null)
        ).catch((error) => {
          console.warn(`[Lyrics] Failed to resolve ${provider} track ${providerId}:`, error);
          return existingSidecar?.lyrics ?? null;
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
      const lyricPath = classified.synchronized
        ? lyricSidecarPath(resolvedFilePath, classified.extension)
        : (existingSidecar?.filePath ?? lyricSidecarPath(resolvedFilePath, classified.extension));

      if (metadata.save_lyrics || getConfigSection("quality").embed_lyrics) {
        // Persist a sidecar whenever we embed or the user asked to save lyrics.
        // Upgrade an unsynced tiddl sidecar when catalogue lyrics are timed.
        const shouldWrite = !fs.existsSync(lyricPath)
          || (classified.synchronized && existingSidecar && !existingSidecar.synchronized);
        if (shouldWrite) {
          fs.mkdirSync(path.dirname(lyricPath), { recursive: true });
          fs.writeFileSync(lyricPath, `${classified.content}\n`, "utf8");
          result.saved++;
        }
        if (classified.synchronized) {
          await removeUnsyncedLyricSidecar(existingSidecar, lyricPath);
        }
      }

      if (fs.existsSync(lyricPath)) {
        const libraryRoot = fallbackLibraryRoot(row, resolvedFilePath);
        await withSqliteWriteGate(() => LibraryFilesService.upsertLibraryFile({
          artistId: String(row.artist_id),
          albumId: row.album_id == null ? null : String(row.album_id),
          mediaId: providerId,
          trackFileId: row.id,
          libraryId: row.library_id,
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
        }), "lyrics:index-sidecar");
      }
    };

    const pending = [...rows];
    let started = 0;
    const worker = async () => {
      while (pending.length > 0) {
        const row = pending.shift();
        if (!row) continue;
        started += 1;
        onFileStart?.(started, rows.length);
        await resolveRow(row);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, () => worker()));
    if (timedOutLookups > 0) {
      console.warn(
        `[Lyrics] ${timedOutLookups} lyrics lookup(s) did not answer in time; ` +
        "those tracks keep any lyrics already on disk and the lyrics refresh can fill them in later",
      );
    }
    return result;
  }
}

/**
 * Provider track ids whose downloader already delivered synchronized lyrics
 * in the download workspace (tiddl names files by track id and writes the
 * TIDAL lyrics as an adjacent .lrc). The import reads that sidecar, so
 * fetching the same lyrics again from the provider API only adds requests.
 */
export function trackIdsWithDeliveredSyncedLyrics(downloadPath: string | null | undefined, providerTrackIds: string[]): Set<string> {
  const delivered = new Set<string>();
  const wanted = new Set(providerTrackIds.map((id) => String(id).trim()).filter(Boolean));
  if (!downloadPath || wanted.size === 0) return delivered;
  const pending = [downloadPath];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (extension === ".lrc" || extension === ".txt") continue;
      const id = path.basename(entry.name, path.extname(entry.name));
      if (!wanted.has(id) || delivered.has(id)) continue;
      if (findAdjacentLyricSidecar(full)?.synchronized) delivered.add(id);
    }
  }
  return delivered;
}

/**
 * Fetch provider lyrics for the given provider track ids without touching the
 * library. Download completion calls this so the disk-exclusive import slot
 * never waits on lyric APIs. Failures resolve to "not prefetched" (absent key),
 * so the import falls back to its normal (also time-bounded) lookup. Tracks
 * whose downloader already delivered synchronized lyrics are skipped. Each
 * lookup and the whole prefetch are time-bounded; a lookup that runs out of
 * time is recorded as "no lyrics" for this import.
 */
export async function prefetchProviderLyrics(
  provider: string,
  providerTrackIds: string[],
  concurrency = 4,
  downloadPath?: string | null,
  limits?: LyricsLookupLimits & { onLookup?: (done: number, total: number) => void },
): Promise<Record<string, ResolvedLyrics | null>> {
  const metadata = getConfigSection("metadata");
  const quality = getConfigSection("quality");
  const out: Record<string, ResolvedLyrics | null> = {};
  if (!provider || (!metadata.save_lyrics && !quality.embed_lyrics)) return out;
  const delivered = trackIdsWithDeliveredSyncedLyrics(downloadPath, providerTrackIds);
  const ids = Array.from(new Set(providerTrackIds.map((id) => String(id).trim()).filter(Boolean)))
    .filter((id) => !delivered.has(id));
  const { lookupTimeoutMs, deadline } = lookupLimits(limits);
  let next = 0;
  let done = 0;
  let timedOut = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const key = providerMediaLyricsKey(provider, id);
      let found: ResolvedLyrics | null | typeof LOOKUP_TIMED_OUT;
      try {
        found = await lyricsWithin(
          () => getLyricsForProviderMedia(id, provider),
          Math.min(lookupTimeoutMs, deadline - Date.now()),
        );
      } catch {
        /* leave absent: import retries the lookup itself */
        done += 1;
        limits?.onLookup?.(done, ids.length);
        continue;
      }
      if (found === LOOKUP_TIMED_OUT) {
        timedOut += 1;
        // Recorded as "no lyrics" for this import so the import slot does
        // not repeat a lookup that already ran out of time here.
        out[key] = null;
      } else {
        out[key] = found;
      }
      done += 1;
      limits?.onLookup?.(done, ids.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  if (timedOut > 0) {
    console.warn(
      `[Lyrics] Prefetch: ${timedOut}/${ids.length} ${provider} lyrics lookup(s) did not answer in time; ` +
      "filing the album without them (the lyrics refresh can add them later)",
    );
  }
  return out;
}
