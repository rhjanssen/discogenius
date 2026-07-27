import { db } from "../../database.js";
import {
  resolveAlbumArtwork,
  resolveArtistArtwork,
} from "./media-cover-service.js";

const DEFAULT_ARTWORK_REFRESH_CONCURRENCY = 6;

type ArtworkRefreshTarget =
  | { kind: "album"; mbid: string }
  | { kind: "artist"; mbid: string };

export interface ArtworkPreferenceRefreshProgress {
  completed: number;
  total: number;
  albumsCompleted: number;
  artistsCompleted: number;
}

export interface ArtworkPreferenceRefreshSummary {
  total: number;
  completed: number;
  failed: number;
  albums: number;
  artists: number;
}

export interface ArtworkPreferenceRefreshOptions {
  concurrency?: number;
  onProgress?: (progress: ArtworkPreferenceRefreshProgress) => void;
  yieldToEventLoop?: () => Promise<void>;
  resolveAlbum?: typeof resolveAlbumArtwork;
  resolveArtist?: typeof resolveArtistArtwork;
}

function normalizeConcurrency(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_ARTWORK_REFRESH_CONCURRENCY;
  return Math.max(1, Math.min(16, Math.trunc(value as number)));
}

/**
 * Refresh the preference-sensitive MediaCover masters for every canonical
 * catalog row. This intentionally reads Albums/ArtistMetadata directly rather
 * than walking managed Artists, because unmonitored and credited catalog rows
 * can still be rendered in the UI or later become part of the library.
 *
 * Work is processed in small fixed-size batches. That caps provider/network
 * concurrency and cooperatively returns control to the command worker's event
 * loop between batches.
 */
export async function refreshArtworkPreferenceCache(
  options: ArtworkPreferenceRefreshOptions = {},
): Promise<ArtworkPreferenceRefreshSummary> {
  const albumTargets = db.prepare(`
    SELECT mbid
    FROM Albums
    WHERE mbid IS NOT NULL
      AND TRIM(mbid) <> ''
    ORDER BY id ASC
  `).all() as Array<{ mbid: string }>;
  const artistTargets = db.prepare(`
    SELECT mbid
    FROM ArtistMetadata
    WHERE mbid IS NOT NULL
      AND TRIM(mbid) <> ''
    ORDER BY id ASC
  `).all() as Array<{ mbid: string }>;

  const targets: ArtworkRefreshTarget[] = [
    ...albumTargets.map((row): ArtworkRefreshTarget => ({ kind: "album", mbid: row.mbid })),
    ...artistTargets.map((row): ArtworkRefreshTarget => ({ kind: "artist", mbid: row.mbid })),
  ];
  const summary: ArtworkPreferenceRefreshSummary = {
    total: targets.length,
    completed: 0,
    failed: 0,
    albums: albumTargets.length,
    artists: artistTargets.length,
  };
  const resolveAlbum = options.resolveAlbum ?? resolveAlbumArtwork;
  const resolveArtist = options.resolveArtist ?? resolveArtistArtwork;
  const cooperate = options.yieldToEventLoop
    ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const concurrency = normalizeConcurrency(options.concurrency);
  let albumsCompleted = 0;
  let artistsCompleted = 0;

  for (let offset = 0; offset < targets.length; offset += concurrency) {
    const batch = targets.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map(async (target) => {
      if (target.kind === "album") {
        try {
          await resolveAlbum({ albumMbid: target.mbid });
          return { target, failed: false };
        } catch (error) {
          console.warn(
            `[ArtworkPreferenceRefresh] Failed to refresh album artwork for ${target.mbid}:`,
            error,
          );
          return { target, failed: true };
        }
      }

      // Profile and fanart have separate MediaCover identities. Attempt both
      // independently before library sidecars and embedded covers are
      // reconciled, so one missing/broken origin cannot suppress the other.
      let failed = false;
      for (const preferredCoverTypes of [
        ["Poster", "Headshot"],
        ["Fanart"],
      ]) {
        try {
          await resolveArtist({
            artistMbid: target.mbid,
            preferredCoverTypes,
          });
        } catch (error) {
          failed = true;
          console.warn(
            `[ArtworkPreferenceRefresh] Failed to refresh artist ${preferredCoverTypes[0]} artwork for ${target.mbid}:`,
            error,
          );
        }
      }
      return { target, failed };
    }));

    for (const result of results) {
      summary.completed++;
      if (result.failed) summary.failed++;
      if (result.target.kind === "album") albumsCompleted++;
      else artistsCompleted++;
    }
    options.onProgress?.({
      completed: summary.completed,
      total: summary.total,
      albumsCompleted,
      artistsCompleted,
    });
    await cooperate();
  }

  return summary;
}
