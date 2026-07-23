import fs from "fs";
import path from "path";
import { execFileSync, execSync } from "child_process";
import { db } from "../../database.js";
import { Config } from "../config/config.js";
import { downloadAlbumCover, downloadAlbumVideoCover, downloadArtistPicture, downloadVideoThumbnail, saveAlbumNfoFile, saveArtistNfoFile, saveVideoNfoFile } from "./metadata-files.js";
import { streamingProviderManager } from "../providers/index.js";
import { getNamingConfig, renderFileStem, renderRelativePath, resolveArtistFolderFromRecord } from "../config/naming.js";
import { resolveArtistFolderForIdentityUpdate, resolveArtistFolderForPersistence, shouldReapplyArtistPathTemplate } from "../music/artist-paths.js";
import { parseAudioFile, deriveQuality, deriveVideoQuality, convertToMp4, embedVideoThumbnail } from "./audioUtils.js";
import { LibraryFilesService, removeEmptyParents, resolveVideoTypeSuffix } from "./library-files.js";
import { resolveLibraryRootPath, resolveStoredLibraryPath } from "./library-paths.js";
import { getDefaultStreamingSource, getDownloadWorkspacePath, validateDownloadWorkspacePath } from "../download/download-routing.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "../commands/history-events.js";
import { MoveArtistService } from "./move-artist-service.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";
import { renderAudioRelativePathForLibrary } from "./audio-library-path.js";
import { resolveLibraryFileIdentity } from "./library-file-identity.js";
import { getCanonicalTrackPosition, resolveCanonicalTrackPosition } from "../metadata/canonical-track-position.js";
import { getCanonicalAlbumMetadata } from "../metadata/canonical-album-metadata.js";
import { albumCoverLocalUrl } from "../metadata/media-cover-service.js";
import { compareVideoOffersByQualityThenProvider } from "../music/video-offer-resolver.js";
import {
  findAdjacentLyricSidecar,
  LYRIC_SIDECAR_EXTENSIONS,
  readLyricSidecar,
  SYNCHRONIZED_LYRIC_EXTENSION,
  type LyricSidecarExtension,
} from "../extras/lyrics/lyric-sidecar.js";
import {
  loadProviderTrackIdSet,
  matchAlbumFilesByProviderId,
  matchAppleMusicBundledVideoFiles,
  resolveMatchedCanonicalAlbumTrackRow,
  type MatchedAlbumTrackRow,
} from "./album-organize.js";
import {
  loadBundledVideoTrackCandidates,
  lookupCatalogVideoAfterUpsert,
  normalizeBundledVideoTitle,
  resolveCanonicalVideoArtistId,
  resolveOrganizeVideoTitle,
} from "./video-organize.js";

export {
  loadBundledVideoTrackCandidates,
  lookupCatalogVideoAfterUpsert,
  normalizeBundledVideoTitle,
  resolveCanonicalVideoArtistId,
  resolveOrganizeVideoTitle,
} from "./video-organize.js";

export function parseJsonObject(value: unknown): Record<string, any> {
  if (!value) {
    return {};
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ArtistMetadata.genres / Albums.genres store a JSON array of strings.
// Naming tokens use the primary (first) genre, matching the
// `Genres?.FirstOrDefault()` convention.
export function firstGenre(genresJson: string | null | undefined): string | null {
  if (!genresJson) return null;
  try {
    const parsed = JSON.parse(genresJson);
    return Array.isArray(parsed) && typeof parsed[0] === "string" && parsed[0].trim() ? parsed[0] : null;
  } catch {
    return null;
  }
}

export function getAlbumVideoCoverName(albumCoverName: string): string {
  const parsedName = path.parse(albumCoverName);
  return `${parsedName.name}.mp4`;
}

/**
 * Prefer the canonical Albums.video_cover id/URL. When missing (common after a
 * list-only artist scan that omitted motion art), ask the provider plugin and
 * home the result onto Albums so later imports/backfills reuse it.
 */
export async function resolveAlbumVideoCoverForLibrary(options: {
  storedVideoCover?: string | null;
  provider?: string | null;
  providerAlbumId?: string | null;
  releaseGroupMbid?: string | null;
}): Promise<string | null> {
  const stored = String(options.storedVideoCover || "").trim();
  if (stored) {
    return stored;
  }

  const providerId = String(options.provider || "").trim();
  const providerAlbumId = String(options.providerAlbumId || "").trim();
  if (!providerId || !providerAlbumId) {
    return null;
  }

  try {
    const provider = streamingProviderManager.getStreamingProvider(providerId);
    if (typeof provider.getAlbum !== "function") {
      return null;
    }
    const album = await provider.getAlbum(providerAlbumId);
    const videoCover = String(album?.videoCover || "").trim() || null;
    const releaseGroupMbid = String(options.releaseGroupMbid || "").trim();
    if (videoCover && releaseGroupMbid) {
      db.prepare(`
        UPDATE Albums
        SET video_cover = COALESCE(NULLIF(?, ''), video_cover),
            updated_at = CURRENT_TIMESTAMP
        WHERE mbid = ?
      `).run(videoCover, releaseGroupMbid);
    }
    return videoCover;
  } catch (error) {
    console.warn(
      `[Organizer] Failed to resolve animated cover from ${providerId} album ${providerAlbumId}:`,
      error,
    );
    return null;
  }
}

export function sanitizeFilename(name: string): string {
  return (name || "Unknown").replace(/[<>:"/\\|?*]/g, "").trim();
}

export function getReleaseYear(releaseDate: string | null | undefined): string | null {
  if (!releaseDate) return null;
  const match = releaseDate.match(/^(\d{4})/);
  return match ? match[1] : null;
}

export function commonPathPrefix(paths: string[]): string {
  if (paths.length === 0) return "";

  const split = (p: string) =>
    p
      .split(/[\\/]+/g)
      .filter(Boolean)
      .filter((seg) => seg !== "." && seg !== "..");

  let prefix = split(paths[0]);
  for (const p of paths.slice(1)) {
    const segs = split(p);
    while (prefix.length > 0 && !prefix.every((seg, i) => segs[i] === seg)) {
      prefix = prefix.slice(0, -1);
    }
    if (prefix.length === 0) break;
  }

  return prefix.length > 0 ? path.join(...prefix) : "";
}

export function deriveAlbumDirRelativeFromTrackPath(trackTemplate: string, relativeTrackPath: string): string {
  const renderedSegments = relativeTrackPath.split(/[\\/]+/g).filter(Boolean);
  const dirSegments = renderedSegments.slice(0, -1);
  if (dirSegments.length === 0) return "";

  const templateSegments = (trackTemplate || "").split(/[\\/]+/g).filter(Boolean);
  const templateDirSegments = templateSegments.slice(0, -1);

  const volumeDirIndex = templateDirSegments.findIndex((seg) => /\{[^}]*?(?:volumeNumber|medium)/i.test(seg));
  if (volumeDirIndex >= 0) {
    return volumeDirIndex > 0 ? path.join(...dirSegments.slice(0, volumeDirIndex)) : "";
  }

  return path.join(...dirSegments);
}

type OrganizeType = "album" | "track" | "video";

type OrganizeRequest = {
  type: OrganizeType | string;
  providerId?: string;
  provider?: string | null;
  releaseGroupMbid?: string | null;
  releaseMbid?: string | null;
  canonicalTrackMbid?: string | null;
  canonicalRecordingMbid?: string | null;
  albumId?: string | null;
  albumTitle?: string | null;
  slot?: string | null;
  trackNumber?: number | null;
  volumeNumber?: number | null;
  /** Hybrid / partial album jobs: map provider track ids → catalog identity. */
  trackOffers?: Array<{
    provider?: string;
    providerTrackId: string;
    providerAlbumId?: string | null;
    canonicalTrackMbid?: string | null;
    canonicalRecordingMbid?: string | null;
    title?: string;
    quality?: string | null;
    trackNum?: number | null;
    volumeNum?: number | null;
  }>;
  downloadPath?: string;
  onProgress?: (progress: {
    phase: "importing" | "finalizing";
    currentFileNum?: number;
    totalFiles?: number;
    currentTrack?: string;
    trackStatus?: "downloading" | "completed" | "error" | "skipped";
    statusMessage?: string;
  }) => void;
};

export type OrganizeResult = {
  type: OrganizeType;
  providerId: string;
  processedTrackIds: string[];   // Track IDs that were successfully organized
  totalTracksInStaging: number;  // How many media files were found in the download workspace
  expectedTracks?: number;       // How many tracks the album should have (for albums)
};

type OrganizerArtistContext = {
  artistId: string;
  artistName: string;
  artistMbId: string;
  artistPath: string;
  artistGenre: string | null;
};

type CanonicalAlbumImportContext = {
  provider: string;
  providerAlbumId: string;
  releaseGroupMbid: string | null;
  releaseMbid: string | null;
  slot: "stereo" | "spatial";
  quality: string | null;
  title: string | null;
  artistMbid: string | null;
  artistName: string | null;
  cover: string | null;
  videoCover: string | null;
  volumeCount: number | null;
  releaseDate: string | null;
  albumType: string | null;
};

export class OrganizerService {
  /** Facade over video-organize-helpers (kept for callers/tests that poke the class). */
  private static resolveCanonicalVideoArtistId(provider: string, providerId: string): string | null {
    return resolveCanonicalVideoArtistId(provider, providerId);
  }

  private static readonly AUDIO_EXTENSIONS = new Set([
    ".flac",
    ".m4a",
    ".mp3",
    ".aac",
    ".wav",
    ".ogg",
    ".opus",
    ".aif",
    ".aiff",
  ]);

  private static readonly VIDEO_EXTENSIONS = new Set([
    ".mp4",
    ".mkv",
    ".mov",
    ".m4v",
    ".webm",
    ".ts",
  ]);

  private static async fetchProviderArtist(artistId: string, providerId?: string | null): Promise<any> {
    const provider = providerId
      ? streamingProviderManager.getStreamingProvider(providerId)
      : streamingProviderManager.getDefaultStreamingProvider();
    const artist = await provider.getArtist(artistId);
    return artist?.raw || artist;
  }

  private static async fetchProviderTrack(trackId: string, providerId?: string | null): Promise<any> {
    const provider = providerId
      ? streamingProviderManager.getStreamingProvider(providerId)
      : streamingProviderManager.getDefaultStreamingProvider();
    const track = await provider.getTrack(trackId);
    return track?.raw || track;
  }

  private static async fetchProviderVideo(videoId: string, providerId?: string | null): Promise<any> {
    const provider = providerId
      ? streamingProviderManager.getStreamingProvider(providerId)
      : streamingProviderManager.getDefaultStreamingProvider();
    if (!provider.getVideo) {
      throw new Error(`${provider.name} does not support video metadata`);
    }
    const video = await provider.getVideo(videoId);
    if (!video) {
      return null;
    }
    // Prefer the mapped ProviderVideo fields (title/artist/quality). Returning
    // `.raw` alone drops YouTube titles that live under videoDetails and stamps
    // "Unknown Video" into Recordings / filenames.
    const raw = (video.raw && typeof video.raw === "object") ? video.raw as Record<string, unknown> : {};
    return {
      ...raw,
      ...video,
      title: video.title || (raw as { title?: string }).title || null,
      provider_id: video.providerId || videoId,
      artist_id: video.artist?.providerId || null,
      quality: video.quality || null,
      explicit: video.explicit ? 1 : 0,
    };
  }

  private static refreshArtistPathFromTemplateIfNeeded(artistId: string) {
    const artist = db.prepare("SELECT id, name, mbid, path FROM Artists WHERE id = ?").get(artistId) as {
      id: string | number;
      name: string | null;
      mbid: string | null;
      path: string | null;
    } | undefined;

    if (!artist) {
      return;
    }

    if (!shouldReapplyArtistPathTemplate({
      artistId: artist.id,
      artistName: String(artist.name || "Unknown Artist"),
      artistMbId: artist.mbid || null,
      existingPath: artist.path || null,
    })) {
      return;
    }

    try {
      MoveArtistService.moveArtist({
        artistId: String(artist.id),
        applyNamingTemplate: true,
        moveFiles: true,
      });
    } catch (error) {
      console.warn(`[Organizer] Failed to reapply artist path template for ${artistId}:`, error);
    }
  }

  private static resolveCanonicalArtistForAlbum(album: any): OrganizerArtistContext {
    const fallbackArtistId = String(album?.artist_id || "");
    const releaseGroupMbid = String(album?.mb_release_group_id || "").trim();

    let artist = releaseGroupMbid
      ? db.prepare(`
          SELECT
            a.id,
            a.name,
            a.mbid,
            a.path,
            mba.disambiguation,
            mba.genres
          FROM Albums rg
          JOIN Artists a ON a.mbid = rg.artist_mbid
          LEFT JOIN ArtistMetadata mba ON mba.mbid = a.mbid
          WHERE rg.mbid = ?
          ORDER BY CASE WHEN CAST(a.id AS TEXT) = CAST(a.mbid AS TEXT) THEN 0 ELSE 1 END
          LIMIT 1
        `).get(releaseGroupMbid) as any
      : null;

    if (!artist && fallbackArtistId) {
      const directArtist = db.prepare(`
        SELECT
          a.id,
          a.name,
          a.mbid,
          a.path,
          mba.disambiguation,
          mba.genres
        FROM Artists a
        LEFT JOIN ArtistMetadata mba ON mba.mbid = a.mbid
        WHERE a.id = ?
        LIMIT 1
      `).get(fallbackArtistId) as any;

      if (directArtist?.mbid) {
        artist = db.prepare(`
          SELECT
            a.id,
            a.name,
            a.mbid,
            a.path,
            mba.disambiguation,
            mba.genres
          FROM Artists a
          LEFT JOIN ArtistMetadata mba ON mba.mbid = a.mbid
          WHERE a.mbid = ?
          ORDER BY CASE WHEN CAST(a.id AS TEXT) = CAST(a.mbid AS TEXT) THEN 0 ELSE 1 END
          LIMIT 1
        `).get(directArtist.mbid) as any;
      } else {
        artist = directArtist;
      }
    }

    if (!artist?.name) {
      return {
        artistId: fallbackArtistId,
        artistName: "Unknown Artist",
        artistMbId: "",
        artistPath: "Unknown Artist",
        artistGenre: null,
      };
    }

    const artistId = String(artist.id);
    const artistMbId = artist.mbid ? String(artist.mbid) : "";
    let artistPath = String(artist.path || "").trim();
    if (artistMbId) {
      const resolved = resolveArtistFolderForIdentityUpdate({
        artistId,
        artistName: artist.name,
        artistMbId,
        artistDisambiguation: artist.disambiguation || null,
        existingPath: artistPath || null,
      });
      artistPath = resolved.path;
      if (resolved.shouldReplaceExistingPath) {
        db.prepare("UPDATE Artists SET path = ? WHERE id = ?").run(artistPath, artistId);
      }
    } else if (!artistPath) {
      artistPath = resolveArtistFolderForPersistence({
        artistId,
        artistName: artist.name,
      });
      db.prepare("UPDATE Artists SET path = ? WHERE id = ? AND (path IS NULL OR TRIM(path) = '')").run(artistPath, artistId);
    }

    return {
      artistId,
      artistName: String(artist.name || "Unknown Artist"),
      artistMbId,
      artistPath,
      artistGenre: firstGenre(artist.genres),
    };
  }

  private static resolveCanonicalAlbumImportContext(raw: OrganizeRequest, providerAlbumId: string): CanonicalAlbumImportContext | null {
    const provider = String(raw.provider || getDefaultStreamingSource()).trim() || getDefaultStreamingSource();
    // Job acquisition-plan identity outranks slot/ProviderItems. Hybrid tips
    // (e.g. BTB hires core 77661290) can also be exact selected_provider_id for
    // an unrelated single (Rehab); without a job-RG constraint that single wins.
    const releaseGroupMbid = String(raw.releaseGroupMbid || raw.albumId || "").trim();
    const releaseMbid = String(raw.releaseMbid || "").trim();
    const requestedSlot = String(raw.slot || "").trim().toLowerCase();
    const compositeProviderId = String(raw.providerId || providerAlbumId || "").trim();
    const row = db.prepare(`
      SELECT
        COALESCE(rgs.selected_provider, pi.provider, ?) AS provider,
        COALESCE(rgs.selected_provider_id, pi.provider_id, ?) AS providerAlbumId,
        COALESCE(NULLIF(?, ''), rgs.release_group_mbid, pi.release_group_mbid, rg.mbid) AS releaseGroupMbid,
        COALESCE(NULLIF(?, ''), rgs.selected_release_mbid, pi.release_mbid) AS releaseMbid,
        COALESCE(rgs.slot, pi.library_slot, ?) AS slot,
        COALESCE(rgs.quality, pi.quality) AS quality,
        rg.title,
        rg.artist_mbid AS artistMbid,
        am.name AS artistName,
        COALESCE(rgs.cover, pi.cover) AS providerCover,
        rg.video_cover AS videoCover,
        selected_release.date AS releaseDate,
        rg.primary_type AS albumType,
        COALESCE(
          NULLIF(selected_release.media_count, 0),
          (
            SELECT COUNT(DISTINCT CAST(COALESCE(
              json_extract(media.value, '$.Position'),
              json_extract(media.value, '$.position'),
              0
            ) AS INTEGER))
            FROM json_each(selected_release.media) media
            WHERE CAST(COALESCE(
              json_extract(media.value, '$.Position'),
              json_extract(media.value, '$.position'),
              0
            ) AS INTEGER) > 0
          ),
          1
        ) AS volumeCount
      FROM ProviderItems pi
      LEFT JOIN ReleaseGroupSlots rgs
        ON rgs.selected_provider = pi.provider
       AND (
          rgs.selected_provider_id = pi.provider_id
          OR rgs.selected_provider_id LIKE pi.provider_id || ';%'
          OR rgs.selected_provider_id LIKE '%;' || pi.provider_id || ';%'
          OR rgs.selected_provider_id LIKE '%;' || pi.provider_id
       )
       AND (? = '' OR rgs.slot = ?)
       AND (? = '' OR rgs.release_group_mbid = ?)
      LEFT JOIN Albums rg ON rg.mbid = COALESCE(NULLIF(?, ''), rgs.release_group_mbid, pi.release_group_mbid)
      LEFT JOIN ArtistMetadata am ON am.mbid = rg.artist_mbid
      LEFT JOIN AlbumReleases selected_release ON selected_release.mbid = COALESCE(NULLIF(?, ''), rgs.selected_release_mbid, pi.release_mbid)
      WHERE pi.provider = ?
        AND pi.entity_type = 'album'
        AND pi.provider_id = ?
        AND (? = '' OR pi.release_group_mbid = ? OR rgs.release_group_mbid = ?)
      ORDER BY
        CASE
          WHEN ? != '' AND rgs.selected_provider_id = ? THEN 0
          WHEN ? != '' AND rgs.release_group_mbid = ? THEN 1
          WHEN INSTR(COALESCE(rgs.selected_provider_id, ''), ';') > 0 THEN 2
          WHEN rgs.slot = ? THEN 3
          ELSE 4
        END,
        LENGTH(COALESCE(rgs.selected_provider_id, '')) DESC,
        pi.updated_at DESC
      LIMIT 1
    `).get(
      provider,
      providerAlbumId,
      releaseGroupMbid || null,
      releaseMbid || null,
      requestedSlot || "stereo",
      requestedSlot,
      requestedSlot,
      releaseGroupMbid,
      releaseGroupMbid,
      releaseGroupMbid || null,
      releaseMbid || null,
      provider,
      providerAlbumId,
      releaseGroupMbid,
      releaseGroupMbid,
      releaseGroupMbid,
      compositeProviderId,
      compositeProviderId,
      releaseGroupMbid,
      releaseGroupMbid,
      requestedSlot || "stereo",
    ) as any;

    if (!row?.releaseGroupMbid && !row?.releaseMbid) {
      return null;
    }

    // Canonical artwork (Servarr Metadata Server/Cover Art Archive) is stored on Albums.images;
    // the provider cover from the selected offer snapshot is the fallback.
    const canonicalCover = row.releaseGroupMbid
      ? albumCoverLocalUrl({ albumMbid: row.releaseGroupMbid })
      : null;

    const slot = String(row.slot || requestedSlot || "stereo").toLowerCase() === "spatial" ? "spatial" : "stereo";
    return {
      provider: String(row.provider || provider),
      providerAlbumId,
      releaseGroupMbid: row.releaseGroupMbid || null,
      releaseMbid: row.releaseMbid || null,
      slot,
      quality: row.quality || null,
      title: row.title || null,
      artistMbid: row.artistMbid || null,
      artistName: row.artistName || null,
      cover: canonicalCover || row.providerCover || null,
      videoCover: row.videoCover || null,
      volumeCount: row.volumeCount == null ? null : Number(row.volumeCount),
      releaseDate: row.releaseDate || null,
      albumType: row.albumType || null,
    };
  }

  /**
   * Match downloaded files to provider tracks. Provider-id basenames remain
   * the authoritative fast path. The pinned Apple downloader hard-codes
   * album-bundled video names as `NN. Title.mp4`, so those files get a narrow,
   * provider-aware exact-title/position fallback against materialized VIDEO
   * offers. Ambiguous names remain staged for manual recovery.
   * Refresh orchestration stays here; matching lives in album-organize-helpers.
   */
  private static async matchAlbumFilesToTracks(
    albumId: string,
    files: string[],
    context?: CanonicalAlbumImportContext | null,
    trackOffers?: OrganizeRequest["trackOffers"],
  ): Promise<Map<string, string>> {
    const albumIds = Array.from(new Set([
      ...albumId.split(";").map((part) => part.trim()).filter(Boolean),
      ...(trackOffers || [])
        .map((offer) => String(offer.providerAlbumId || "").trim())
        .filter(Boolean),
    ]));
    if (albumIds.length === 0) {
      return new Map();
    }

    const provider = String(context?.provider || "").trim();
    const unionOfferIds = (ids: Set<string>) => {
      for (const offer of trackOffers || []) {
        const tipId = String(offer.providerTrackId || "").trim();
        if (tipId) ids.add(tipId);
      }
      return ids;
    };
    let providerTrackIds = unionOfferIds(this.loadProviderTrackIdSet(albumIds, provider));
    const refreshProviderTrackIds = async () => {
      const { RefreshAlbumService } = await import("../music/refresh-album-service.js");
      for (const id of albumIds) {
        try {
          await RefreshAlbumService.refreshTracks(id, { provider: provider || undefined });
        } catch (error) {
          console.warn(`[Organizer] Failed to materialize provider track offers for album ${id}:`, error);
        }
      }
      providerTrackIds = unionOfferIds(this.loadProviderTrackIdSet(albumIds, provider));
    };

    if (providerTrackIds.size === 0) {
      await refreshProviderTrackIds();
    }

    let result = matchAlbumFilesByProviderId(files, providerTrackIds);
    if (result.missingProviderIds.size > 0) {
      await refreshProviderTrackIds();
      result = matchAlbumFilesByProviderId(files, providerTrackIds);
    }

    matchAppleMusicBundledVideoFiles({
      files,
      matched: result.matched,
      provider,
      albumIds,
      videoExtensions: this.VIDEO_EXTENSIONS,
    });
    return result.matched;
  }

  /**
   * Import one album-bundled music video (providers like Apple Music append
   * videos to deluxe/festival tracklists). Identity comes from the
   * materialized provider track row (library_slot='video'), whose canonical
   * link points at the release's video Recording — so the file lands in the
   * video library (or inline, per layout) while keeping album/track identity,
   * and the recording gains a provider VIDEO offer like any standalone video.
   */
  private static async importAlbumBundledVideoFile(params: {
    src: string;
    provider: string;
    providerTrackId: string;
    artistId: string;
    artistName: string;
    artistMbId: string | null;
    artistFolder: string;
    artistGenres?: string | null;
    releaseGroupMbid: string | null;
    videoRoot: string;
  }): Promise<boolean> {
    if (!Config.getFilteringConfig().include_videos) {
      console.log(`[Organizer] Skipping bundled video ${params.src} because music video monitoring (include_videos) is disabled in settings.`);
      try { fs.rmSync(params.src, { force: true }); } catch { /* staging cleanup is best-effort */ }
      return false;
    }
    const row = db.prepare(`
      SELECT
        COALESCE(NULLIF(TRIM(recording.title), ''), pi.title) AS title,
        recording.video_variant AS video_variant,
        pi.duration, pi.explicit, pi.quality,
        pi.recording_mbid, pi.recording_id, pi.artist_mbid, pi.release_group_mbid
      FROM ProviderItems pi
      LEFT JOIN Recordings recording ON recording.id = pi.recording_id
      WHERE pi.provider = ? AND pi.entity_type = 'track'
        AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
        AND pi.library_slot = 'video'
      LIMIT 1
    `).get(params.provider, params.providerTrackId) as {
      title?: string | null;
      video_variant?: string | null;
      duration?: number | null;
      explicit?: number | null;
      quality?: string | null;
      recording_mbid?: string | null;
      recording_id?: number | null;
      artist_mbid?: string | null;
      release_group_mbid?: string | null;
    } | undefined;
    if (!row) {
      return false;
    }

    const title = String(row.title || "Unknown Video");
    const naming = getNamingConfig();
    const videoNamingTemplate = path.join(params.artistFolder, naming.video_file);
    const sourceMetrics = await parseAudioFile(params.src);
    const sourceVideoQuality = deriveVideoQuality(sourceMetrics) ?? row.quality ?? null;
    const destName = `${renderFileStem(naming.video_file, {
      provider: params.provider,
      artistName: params.artistName,
      artistId: params.artistId,
      artistMbId: params.artistMbId || "",
      artistGenre: firstGenre(params.artistGenres),
      trackId: params.providerTrackId,
      videoId: params.providerTrackId,
      videoTitle: title,
      videoType: resolveVideoTypeSuffix(title, row.video_variant),
      explicit: Number(row.explicit || 0) === 1,
      quality: sourceVideoQuality,
      codec: sourceMetrics.codec || null,
      bitrate: sourceMetrics.bitrate || null,
      sampleRate: sourceMetrics.sampleRate || null,
      bitDepth: sourceMetrics.bitDepth || null,
      channels: sourceMetrics.channels || null,
    })}.mp4`;
    const separatedDest = path.join(params.videoRoot, params.artistFolder, destName);
    const inlineExpected = LibraryFilesService.computeExpectedPath({
      id: -1,
      artist_id: params.artistId as unknown as number,
      album_id: (params.releaseGroupMbid || row.release_group_mbid || null) as unknown as number | null,
      media_id: params.providerTrackId as unknown as number,
      file_path: separatedDest,
      relative_path: path.relative(params.videoRoot, separatedDest),
      library_root: params.videoRoot,
      file_type: "video",
      extension: "mp4",
      quality: sourceVideoQuality,
      provider: params.provider,
      provider_entity_type: "video",
      provider_id: params.providerTrackId,
    });
    const dest = inlineExpected.expectedPath || separatedDest;
    const organizedVideoRoot = this.resolveLibraryRoot(dest) || params.videoRoot;
    if (this.resolvePrimaryVideoDestinationConflict({
      destPath: dest,
      incomingProvider: params.provider,
      incomingProviderId: params.providerTrackId,
      incomingQuality: sourceVideoQuality,
    }) === "skip") {
      try { fs.rmSync(params.src, { force: true }); } catch { /* staging cleanup is best-effort */ }
      return false;
    }
    this.ensureDir(path.dirname(dest));

    if (path.extname(params.src).toLowerCase() !== ".mp4") {
      const success = await convertToMp4(params.src, dest);
      if (!success) {
        throw new Error(`[Organizer] MP4 conversion failed for bundled video ${params.src}`);
      }
      try { fs.rmSync(params.src, { force: true }); } catch { /* stale source is harmless */ }
    } else {
      this.moveFileCrossDevice(params.src, dest);
    }

    const metrics = await parseAudioFile(dest);
    const derivedVideoQuality = deriveVideoQuality(metrics) ?? row.quality ?? null;
    const albumIdForFile = params.releaseGroupMbid || row.release_group_mbid || null;

    let libraryFileId: number | null = null;
    db.transaction(() => {
      // Surface the provider VIDEO offer on the canonical recording so the
      // video library and video page list this source, deduped with any
      // standalone upload of the same video (same recording).
      db.prepare(`
        INSERT INTO ProviderItems (
          provider, entity_type, provider_id, provider_album_id, artist_mbid, recording_mbid,
          title, quality, duration, availability, library_slot, recording_id,
          match_status, match_confidence, match_method, updated_at
        ) VALUES (?, 'video', ?, NULL, ?, ?, ?, ?, ?, 'available', 'video', ?, 'matched', 0.9, 'album-bundled-track', CURRENT_TIMESTAMP)
        ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
          recording_mbid = COALESCE(excluded.recording_mbid, ProviderItems.recording_mbid),
          recording_id = COALESCE(excluded.recording_id, ProviderItems.recording_id),
          title = excluded.title,
          quality = excluded.quality,
          duration = excluded.duration,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        params.provider,
        params.providerTrackId,
        row.artist_mbid || params.artistMbId || null,
        row.recording_mbid || null,
        title,
        derivedVideoQuality,
        row.duration || null,
        row.recording_id || null,
      );

      libraryFileId = this.upsertLibraryFile({
        artistId: params.artistId,
        albumId: albumIdForFile,
        mediaId: params.providerTrackId,
        filePath: dest,
        libraryRoot: organizedVideoRoot,
        fileType: "video",
        quality: derivedVideoQuality,
        namingTemplate: videoNamingTemplate,
        expectedPath: dest,
        bitDepth: metrics.bitDepth,
        sampleRate: metrics.sampleRate,
        bitrate: metrics.bitrate,
        codec: metrics.codec,
        videoCodec: metrics.videoCodec,
        channels: metrics.channels,
        width: metrics.width,
        height: metrics.height,
      });

      try {
        recordHistoryEvent({
          artistId: params.artistId,
          albumId: albumIdForFile,
          mediaId: params.providerTrackId,
          libraryFileId,
          eventType: HISTORY_EVENT_TYPES.TrackFileImported,
          quality: derivedVideoQuality,
          sourceTitle: title,
          data: { importedPath: dest, bundledWithAlbum: true },
        });
      } catch (historyError) {
        console.warn(`[Organizer] Failed to record bundled-video import history for ${params.providerTrackId}:`, historyError);
      }
    })();

    await this.ensureVideoThumbnailSidecar({
      artistId: params.artistId,
      albumId: albumIdForFile,
      mediaId: params.providerTrackId,
      mediaPath: dest,
      libraryRoot: organizedVideoRoot,
      provider: params.provider,
      providerId: params.providerTrackId,
      quality: derivedVideoQuality,
      namingTemplate: videoNamingTemplate,
      libraryFileId,
    });

    return true;
  }

  /** Facade over album-organize-helpers (kept for callers/tests that poke the class). */
  private static loadProviderTrackIdSet(albumIds: string[], provider = ""): Set<string> {
    return loadProviderTrackIdSet(albumIds, provider);
  }

  /** Facade over album-organize-helpers (kept for callers/tests that poke the class). */
  private static resolveMatchedCanonicalAlbumTrackRow(params: {
    provider: string;
    trackId: string;
    releaseMbid: string;
    fallbackAlbumId: string;
    fallbackAlbumIds?: string[];
    fallbackArtistId: string;
    fallbackQuality: string | null;
  }): MatchedAlbumTrackRow | null {
    return resolveMatchedCanonicalAlbumTrackRow(params);
  }

  /**
   * Retroactively prune disabled metadata files (covers, NFO, lyrics, etc.)
   * based on the current configuration.
   */
  public static async pruneDisabledMetadata(): Promise<void> {
    const config = Config.getMetadataConfig();
    console.log('[Organizer] Pruning disabled metadata files...');

    let deletedCount = 0;

    // Cover/nfo/image sidecars live in MetadataFiles (with a file_type column);
    // lyrics live in LyricFiles (no file_type — the table itself is the type).
    const metadataSelectors: Array<string> = [];
    if (!config.save_album_cover) {
      metadataSelectors.push("(file_type = 'cover' AND album_id IS NOT NULL)");
      metadataSelectors.push("file_type = 'video_cover'");
    }
    if (!config.save_artist_picture) {
      metadataSelectors.push(`
        file_type = 'cover'
        AND canonical_release_group_mbid IS NULL
        AND canonical_release_mbid IS NULL
        AND canonical_track_mbid IS NULL
        AND canonical_recording_mbid IS NULL
        AND track_file_id IS NULL
        AND (
          provider_entity_type IS NULL
          OR provider_entity_type = 'artist'
        )
      `);
    }
    if (!config.save_nfo) metadataSelectors.push("file_type = 'nfo'");
    if (!config.save_video_thumbnail) metadataSelectors.push("file_type = 'video_thumbnail'");

    type PruneRow = { id: number; file_path: string; file_type: string; library_root: string; table: "MetadataFiles" | "LyricFiles" };
    const filesToPrune: PruneRow[] = [];

    if (metadataSelectors.length > 0) {
      const rows = db.prepare(`
        SELECT id, file_path, file_type, library_root
        FROM MetadataFiles
        WHERE ${metadataSelectors.join(" OR ")}
      `).all() as Array<Omit<PruneRow, "table">>;
      filesToPrune.push(...rows.map((row) => ({ ...row, table: "MetadataFiles" as const })));
    }

    if (!config.save_lyrics) {
      const rows = db.prepare(`
        SELECT id, file_path, 'lyrics' AS file_type, library_root
        FROM LyricFiles
      `).all() as Array<Omit<PruneRow, "table">>;
      filesToPrune.push(...rows.map((row) => ({ ...row, table: "LyricFiles" as const })));
    }

    if (filesToPrune.length === 0) {
      console.log('[Organizer] No orphaned files found to prune.');
      return;
    }

    // Process deletions against each sidecar's own table.
    const deleteMetadata = db.prepare(`DELETE FROM MetadataFiles WHERE id = ?`);
    const deleteLyric = db.prepare(`DELETE FROM LyricFiles WHERE id = ?`);

    db.transaction(() => {
      for (const file of filesToPrune) {
        try {
          const resolvedFilePath = resolveStoredLibraryPath({
            filePath: file.file_path,
            libraryRoot: file.library_root,
          });
          if (fs.existsSync(resolvedFilePath)) {
            fs.unlinkSync(resolvedFilePath);
          }
          (file.table === "LyricFiles" ? deleteLyric : deleteMetadata).run(file.id);
          deletedCount++;
        } catch (error) {
          console.error(`[Organizer] Failed to prune ${file.file_type} file: ${file.file_path}`, error);
        }
      }
    })();

    console.log(`[Organizer] Pruning complete. Deleted ${deletedCount} disabled sidecar(s).`);
  }

  private static ensureDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    // Enforce container app ownership for NFSv4 mounts.
    // On TrueNAS, this ensures created directories are writable by the app UID.
    // Whether running as root (chown succeeds) or as UID 568 (chown from 568 to 568),
    // this normalizes ownership so subsequent file operations don't fail with EPERM.
    const puid = process.env.PUID || "568";
    const pgid = process.env.PGID || "568";
    try {
      execSync(`chown ${puid}:${pgid} "${dirPath}"`, { stdio: "ignore" });
    } catch {
      // Silently ignore chown failures (e.g., on non-Unix systems)
    }
  }

  private static isMediaFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (!ext) return false;
    return this.AUDIO_EXTENSIONS.has(ext) || this.VIDEO_EXTENSIONS.has(ext);
  }

  private static findFilesRecursively(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.findFilesRecursively(fullPath));
        continue;
      }
      if (this.isMediaFile(fullPath)) results.push(fullPath);
    }
    return results;
  }

  private static findDirectoryByName(rootDir: string, dirName: string): string | null {
    if (!fs.existsSync(rootDir)) return null;

    const stack: string[] = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(current, entry.name);
        if (entry.name === dirName) return fullPath;
        stack.push(fullPath);
      }
    }

    return null;
  }

  /**
   * Remove old library files for a media item when a new file replaces them.
   * This handles the case where the extension changes (e.g. .m4a → .flac during upgrade)
   * so the new file goes to a different path and the old file would be orphaned.
   *
   * Replacement is slot-scoped: the stereo and spatial copies of the same
   * canonical track share a media identity but are siblings, never
   * replacements — without the slot constraint a spatial import would delete
   * the freshly imported stereo file (and vice versa).
   */
  private static cleanupOldMediaFiles(
    mediaId: string,
    newFilePath: string,
    fileType: "track" | "video",
    librarySlot: string | null,
    provider?: string | null,
  ) {
    const identity = resolveLibraryFileIdentity({
      mediaId,
      fileType,
      librarySlot,
      provider,
    });
    if (!identity.provider || !identity.providerEntityType || !identity.providerId) {
      return;
    }

    const oldFiles = db.prepare(
      `SELECT id, artist_id, NULL AS album_id, provider_id AS media_id, file_path, library_root, quality
       FROM TrackFiles
       WHERE provider = ?
         AND provider_entity_type = ?
         AND provider_id = ?
         AND file_type = ?
         AND library_slot IS ?
         AND file_path != ?`
    ).all(identity.provider, identity.providerEntityType, identity.providerId, fileType, librarySlot, newFilePath) as Array<{
      id: number;
      artist_id: number;
      album_id: number | null;
      media_id: number | null;
      file_path: string;
      library_root: string;
      quality: string | null;
    }>;
    const normalizedNewFilePath = path.resolve(newFilePath);

    for (const old of oldFiles) {
      try {
        const resolvedFilePath = resolveStoredLibraryPath({
          filePath: old.file_path,
          libraryRoot: old.library_root,
        });
        const isSameResolvedFile = path.resolve(resolvedFilePath) === normalizedNewFilePath;

        if (!isSameResolvedFile && fs.existsSync(resolvedFilePath)) {
          fs.rmSync(resolvedFilePath, { force: true });
          console.log(`[Organizer] Deleted old ${fileType} file (replaced by upgrade): ${resolvedFilePath}`);

          try {
            recordHistoryEvent({
              artistId: old.artist_id,
              albumId: old.album_id,
              mediaId: old.media_id,
              libraryFileId: old.id,
              eventType: HISTORY_EVENT_TYPES.TrackFileDeleted,
              quality: old.quality,
              data: {
                deletedPath: resolvedFilePath,
                replacementPath: newFilePath,
                fileType,
              },
            });
          } catch (historyError) {
            console.warn(`[Organizer] Failed to record replacement delete history for ${resolvedFilePath}:`, historyError);
          }

          // Clean up empty parent directories left behind
          const libraryRoot = this.resolveLibraryRoot(resolvedFilePath, old.library_root);
          if (libraryRoot) {
            removeEmptyParents(path.dirname(resolvedFilePath), libraryRoot);
          }
        }
        db.prepare("DELETE FROM TrackFiles WHERE id = ?").run(old.id);
      } catch (e) {
        console.warn(`[Organizer] Failed to delete old ${fileType} file: ${old.file_path}`, e);
      }
    }
  }

  private static normalizeResolvedPath(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  private static getExpectedLinkedSidecarPath(
    mediaPath: string,
    fileType: "lyrics" | "video_thumbnail",
    lyricExtension: LyricSidecarExtension = SYNCHRONIZED_LYRIC_EXTENSION,
  ): string {
    if (fileType === "lyrics") {
      return mediaPath.replace(new RegExp(`${path.extname(mediaPath)}$`), lyricExtension);
    }

    return path.join(path.dirname(mediaPath), `${path.parse(mediaPath).name}.jpg`);
  }

  /**
   * Always fetch a video thumbnail when Settings → Save video thumbnails is on
   * (and/or Embed is on). Resolves cover from DB hints, then provider getVideo.
   */
  private static async ensureVideoThumbnailSidecar(params: {
    artistId: string;
    albumId?: string | null;
    mediaId: string;
    mediaPath: string;
    libraryRoot: string;
    provider: string;
    providerId: string;
    quality?: string | null;
    namingTemplate?: string | null;
    coverHint?: string | null;
    libraryFileId?: number | null;
  }): Promise<void> {
    const metadataConfig = Config.getMetadataConfig();
    if (!metadataConfig.save_video_thumbnail && metadataConfig.embed_video_thumbnail === false) {
      return;
    }

    const persistentCoverPath = metadataConfig.save_video_thumbnail
      ? this.relocateLinkedSidecar({
        artistId: params.artistId,
        albumId: params.albumId || null,
        mediaId: params.mediaId,
        mediaPath: params.mediaPath,
        libraryRoot: params.libraryRoot,
        fileType: "video_thumbnail",
        quality: params.quality || null,
        namingTemplate: params.namingTemplate || null,
      })
      : null;
    const transientCoverPath = persistentCoverPath
      ? null
      : path.join(path.dirname(params.mediaPath), `.${path.parse(params.mediaPath).name}.embed-thumb.jpg`);
    const coverPath = persistentCoverPath || transientCoverPath;
    if (!coverPath) {
      return;
    }

    let coverId = String(params.coverHint || "").trim() || null;
    if (!coverId) {
      const stored = db.prepare(`
        SELECT
          COALESCE(
            NULLIF(TRIM(r.cover_image_id), ''),
            NULLIF(TRIM(video_item.asset_id), ''),
            NULLIF(TRIM(video_item.cover), ''),
            NULLIF(TRIM(track_item.asset_id), ''),
            NULLIF(TRIM(track_item.cover), '')
          ) AS cover
        FROM (
          SELECT ? AS provider, CAST(? AS TEXT) AS provider_id
        ) key
        LEFT JOIN ProviderItems video_item
          ON video_item.provider = key.provider
         AND video_item.entity_type = 'video'
         AND CAST(video_item.provider_id AS TEXT) = key.provider_id
        LEFT JOIN ProviderItems track_item
          ON track_item.provider = key.provider
         AND track_item.entity_type = 'track'
         AND CAST(track_item.provider_id AS TEXT) = key.provider_id
        LEFT JOIN Recordings r
          ON r.id = COALESCE(video_item.recording_id, track_item.recording_id)
        LIMIT 1
      `).get(params.provider, params.providerId) as { cover?: string | null } | undefined;
      coverId = String(stored?.cover || "").trim() || null;
    }

    if (!coverId) {
      try {
        const fetched = await this.fetchProviderVideo(params.providerId, params.provider);
        coverId = String(fetched?.cover || fetched?.image_id || fetched?.imageId || "").trim() || null;
        if (coverId) {
          db.prepare(`
            UPDATE Recordings SET cover_image_id = COALESCE(?, cover_image_id), updated_at = CURRENT_TIMESTAMP
            WHERE id = (
              SELECT recording_id FROM ProviderItems
              WHERE provider = ?
                AND entity_type IN ('video', 'track')
                AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
                AND recording_id IS NOT NULL
              ORDER BY CASE entity_type WHEN 'video' THEN 0 ELSE 1 END
              LIMIT 1
            )
          `).run(coverId, params.provider, params.providerId);
          db.prepare(`
            UPDATE ProviderItems
            SET
              asset_id = COALESCE(asset_id, ?),
              cover = COALESCE(cover, ?),
              updated_at = CURRENT_TIMESTAMP
            WHERE provider = ?
              AND entity_type IN ('video', 'track')
              AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
          `).run(coverId, coverId, params.provider, params.providerId);
        }
      } catch (error) {
        console.warn(`[Organizer] Failed to resolve video thumbnail source for ${params.provider}:${params.providerId}:`, error);
      }
    }

    if (coverId && !fs.existsSync(coverPath)) {
      const videoThumbnailResolution = metadataConfig.video_thumbnail_resolution || "origin";
      try {
        await downloadVideoThumbnail(coverId, videoThumbnailResolution as any, coverPath, {
          provider: params.provider,
          providerId: params.providerId,
        });
      } catch (error) {
        console.warn(`[Organizer] Failed to download video thumbnail for ${params.provider}:${params.providerId}:`, error);
      }
    }

    if (persistentCoverPath && fs.existsSync(persistentCoverPath)) {
      this.upsertLibraryFile({
        artistId: params.artistId,
        albumId: params.albumId || null,
        mediaId: params.mediaId,
        filePath: persistentCoverPath,
        libraryRoot: params.libraryRoot,
        fileType: "video_thumbnail",
        quality: params.quality || null,
        namingTemplate: params.namingTemplate || null,
        expectedPath: persistentCoverPath,
      });
    }

    if (metadataConfig.embed_video_thumbnail !== false && fs.existsSync(coverPath)) {
      const embedded = await embedVideoThumbnail(params.mediaPath, coverPath);
      if (!embedded) {
        console.warn(`[Organizer] Failed to embed video thumbnail for ${params.providerId}`);
      } else if (params.libraryFileId != null) {
        const stat = fs.statSync(params.mediaPath);
        db.prepare(`
          UPDATE TrackFiles
          SET file_size = ?, modified_at = ?, verified_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(stat.size, stat.mtime.toISOString(), params.libraryFileId);
      }
    }

    if (!persistentCoverPath && transientCoverPath && fs.existsSync(transientCoverPath)) {
      fs.rmSync(transientCoverPath, { force: true });
    }
  }

  private static relocateLinkedSidecar(params: {
    artistId: string;
    albumId?: string | null;
    mediaId: string;
    mediaPath: string;
    libraryRoot: string;
    fileType: "lyrics" | "video_thumbnail";
    quality?: string | null;
    namingTemplate?: string | null;
  }): string {
    let expectedPath = this.getExpectedLinkedSidecarPath(params.mediaPath, params.fileType);
    const canonicalIdentity = resolveLibraryFileIdentity({
      artistId: params.artistId,
      albumId: params.albumId || null,
      mediaId: params.mediaId,
      libraryRoot: params.libraryRoot,
      fileType: params.fileType,
      quality: params.quality || null,
    });
    const librarySlot = canonicalIdentity.librarySlot;

    // Linked sidecars live in their own tables: lyrics in
    // LyricFiles, image/other sidecars in MetadataFiles — never TrackFiles
    // (track/video media only). LyricFiles has no file_type column (the table
    // *is* the type), so that filter only applies to MetadataFiles.
    const sidecarTable = params.fileType === "lyrics" ? "LyricFiles" : "MetadataFiles";
    const sidecarFileTypeClause = sidecarTable === "LyricFiles" ? "" : "AND file_type = ?";
    const sidecarMatchValues = [
      canonicalIdentity.provider || "",
      canonicalIdentity.providerEntityType || params.fileType,
      canonicalIdentity.providerId || params.mediaId,
      ...(sidecarTable === "LyricFiles" ? [] : [params.fileType]),
      librarySlot,
    ];

    const sidecars = db.prepare(`
      SELECT id, file_path, library_root
      FROM ${sidecarTable}
      WHERE provider = ?
        AND provider_entity_type = ?
        AND provider_id = ?
        ${sidecarFileTypeClause}
        AND library_slot IS ?
      ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, last_updated DESC, id DESC
    `).all(
      ...sidecarMatchValues,
      expectedPath,
    ) as Array<{
      id: number;
      file_path: string;
      library_root: string;
    }>;

    if (params.fileType === "lyrics") {
      const adjacent = findAdjacentLyricSidecar(params.mediaPath, { normalizeExtension: true });
      const tracked = sidecars
        .map((sidecar) => readLyricSidecar(resolveStoredLibraryPath({
          filePath: sidecar.file_path,
          libraryRoot: sidecar.library_root,
        })))
        .filter((sidecar) => sidecar != null)
        .sort((left, right) => Number(right.synchronized) - Number(left.synchronized))[0];
      const selected = adjacent || tracked;
      if (selected) {
        expectedPath = this.getExpectedLinkedSidecarPath(
          params.mediaPath,
          params.fileType,
          selected.extension,
        );
      }
    }

    const normalizedExpectedPath = this.normalizeResolvedPath(expectedPath);

    let hasExpectedSidecar = fs.existsSync(expectedPath);

    for (const sidecar of sidecars) {
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: sidecar.file_path,
        libraryRoot: sidecar.library_root,
      });
      const normalizedResolvedPath = this.normalizeResolvedPath(resolvedFilePath);

      if (!fs.existsSync(resolvedFilePath)) {
        db.prepare(`DELETE FROM ${sidecarTable} WHERE id = ?`).run(sidecar.id);
        continue;
      }

      if (normalizedResolvedPath === normalizedExpectedPath) {
        hasExpectedSidecar = true;
        continue;
      }

      try {
        if (!hasExpectedSidecar) {
          this.moveFileCrossDevice(resolvedFilePath, expectedPath);
          hasExpectedSidecar = true;

          const sourceRoot = this.resolveLibraryRoot(resolvedFilePath, sidecar.library_root);
          if (sourceRoot) {
            removeEmptyParents(path.dirname(resolvedFilePath), sourceRoot);
          }
        } else {
          fs.rmSync(resolvedFilePath, { force: true });

          const sourceRoot = this.resolveLibraryRoot(resolvedFilePath, sidecar.library_root);
          if (sourceRoot) {
            removeEmptyParents(path.dirname(resolvedFilePath), sourceRoot);
          }
        }
      } catch (error) {
        console.warn(`[Organizer] Failed to relocate ${params.fileType} sidecar ${resolvedFilePath}`, error);
      }
    }

    if (fs.existsSync(expectedPath)) {
      this.upsertLibraryFile({
        artistId: params.artistId,
        albumId: params.albumId || null,
        mediaId: params.mediaId,
        filePath: expectedPath,
        libraryRoot: params.libraryRoot,
        fileType: params.fileType,
        quality: params.quality || null,
        namingTemplate: params.namingTemplate || null,
        expectedPath,
      });

      db.prepare(`
        DELETE FROM ${sidecarTable}
        WHERE provider = ?
          AND provider_entity_type = ?
          AND provider_id = ?
          ${sidecarFileTypeClause}
          AND library_slot IS ?
          AND file_path != ?
      `).run(
        ...sidecarMatchValues,
        expectedPath,
      );
    }

    return expectedPath;
  }

  private static relocateSingletonSidecar(params: {
    artistId: string;
    albumId?: string | null;
    expectedPath: string;
    libraryRoot: string;
    fileType: "cover" | "video_cover" | "nfo";
    quality?: string | null;
    namingTemplate?: string | null;
  }): string {
    const normalizedExpectedPath = this.normalizeResolvedPath(params.expectedPath);
    // Cover/video_cover/nfo singleton sidecars live in MetadataFiles. The clean
    // schema keys them by canonical release ids or provider_id, never by the
    // retired album_id/media_id shadow columns.
    const slotValue = "stereo";
    const scopedRows = params.albumId
      ? db.prepare(`
        SELECT id, file_path, library_root
        FROM MetadataFiles
        WHERE (
            canonical_release_group_mbid = ?
            OR canonical_release_mbid = ?
            OR provider_id = ?
          )
          AND canonical_track_mbid IS NULL
          AND canonical_recording_mbid IS NULL
          AND library_slot = ?
          AND COALESCE(library_root, '') = COALESCE(?, '')
          AND file_type = ?
        ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, last_updated DESC, id DESC
      `).all(params.albumId, params.albumId, params.albumId, slotValue, params.libraryRoot, params.fileType, params.expectedPath)
      : db.prepare(`
        SELECT id, file_path, library_root
        FROM MetadataFiles
        WHERE artist_id = ?
          AND canonical_release_group_mbid IS NULL
          AND canonical_release_mbid IS NULL
          AND canonical_track_mbid IS NULL
          AND canonical_recording_mbid IS NULL
          AND provider_id IS NULL
          AND library_slot = ?
          AND COALESCE(library_root, '') = COALESCE(?, '')
          AND file_type = ?
        ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, last_updated DESC, id DESC
      `).all(params.artistId, slotValue, params.libraryRoot, params.fileType, params.expectedPath);

    let hasExpectedSidecar = fs.existsSync(params.expectedPath);

    for (const sidecar of scopedRows as Array<{ id: number; file_path: string; library_root: string }>) {
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: sidecar.file_path,
        libraryRoot: sidecar.library_root,
      });
      const normalizedResolvedPath = this.normalizeResolvedPath(resolvedFilePath);

      if (!fs.existsSync(resolvedFilePath)) {
        db.prepare("DELETE FROM MetadataFiles WHERE id = ?").run(sidecar.id);
        continue;
      }

      if (normalizedResolvedPath === normalizedExpectedPath) {
        hasExpectedSidecar = true;
        continue;
      }

      try {
        if (!hasExpectedSidecar) {
          this.moveFileCrossDevice(resolvedFilePath, params.expectedPath);
          hasExpectedSidecar = true;
        } else {
          fs.rmSync(resolvedFilePath, { force: true });
        }

        const sourceRoot = this.resolveLibraryRoot(resolvedFilePath, sidecar.library_root);
        if (sourceRoot) {
          removeEmptyParents(path.dirname(resolvedFilePath), sourceRoot);
        }
      } catch (error) {
        console.warn(`[Organizer] Failed to relocate ${params.fileType} sidecar ${resolvedFilePath}`, error);
      }
    }

    if (fs.existsSync(params.expectedPath)) {
      this.upsertLibraryFile({
        artistId: params.artistId,
        albumId: params.albumId || null,
        mediaId: null,
        filePath: params.expectedPath,
        libraryRoot: params.libraryRoot,
        fileType: params.fileType,
        quality: params.quality || null,
        namingTemplate: params.namingTemplate || null,
        expectedPath: params.expectedPath,
      });

      if (params.albumId) {
        db.prepare(`
          DELETE FROM MetadataFiles
          WHERE (
              canonical_release_group_mbid = ?
              OR canonical_release_mbid = ?
              OR provider_id = ?
            )
            AND canonical_track_mbid IS NULL
            AND canonical_recording_mbid IS NULL
            AND library_slot = ?
            AND COALESCE(library_root, '') = COALESCE(?, '')
            AND file_type = ?
            AND file_path != ?
        `).run(params.albumId, params.albumId, params.albumId, slotValue, params.libraryRoot, params.fileType, params.expectedPath);
      } else {
        db.prepare(`
          DELETE FROM MetadataFiles
          WHERE artist_id = ?
            AND canonical_release_group_mbid IS NULL
            AND canonical_release_mbid IS NULL
            AND canonical_track_mbid IS NULL
            AND canonical_recording_mbid IS NULL
            AND provider_id IS NULL
            AND library_slot = ?
            AND COALESCE(library_root, '') = COALESCE(?, '')
            AND file_type = ?
            AND file_path != ?
        `).run(params.artistId, slotValue, params.libraryRoot, params.fileType, params.expectedPath);
      }
    }

    return params.expectedPath;
  }

  private static cleanupSiblingMediaVariants(newFilePath: string, fileType: "track" | "video") {
    const targetPath = path.resolve(newFilePath);
    const targetDir = path.dirname(targetPath);
    const targetStem = path.parse(targetPath).name;
    if (!fs.existsSync(targetDir)) {
      return;
    }

    for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }

      const siblingPath = path.join(targetDir, entry.name);
      if (path.resolve(siblingPath) === targetPath) {
        continue;
      }

      const siblingExt = path.extname(entry.name).toLowerCase();
      const isMediaSibling = this.AUDIO_EXTENSIONS.has(siblingExt) || this.VIDEO_EXTENSIONS.has(siblingExt);
      if (!isMediaSibling || siblingExt !== path.extname(targetPath).toLowerCase() || path.parse(entry.name).name !== targetStem) {
        continue;
      }

      try {
        const siblingLibraryFiles = db.prepare(
          `SELECT id, artist_id, NULL AS album_id, provider_id AS media_id, quality
           FROM TrackFiles
           WHERE file_path = ? AND file_type = ?`
        ).all(siblingPath, fileType) as Array<{
          id: number;
          artist_id: number;
          album_id: number | null;
          media_id: number | null;
          quality: string | null;
        }>;

        for (const siblingRow of siblingLibraryFiles) {
          try {
            recordHistoryEvent({
              artistId: siblingRow.artist_id,
              albumId: siblingRow.album_id,
              mediaId: siblingRow.media_id,
              libraryFileId: siblingRow.id,
              eventType: HISTORY_EVENT_TYPES.TrackFileDeleted,
              quality: siblingRow.quality,
              data: {
                deletedPath: siblingPath,
                replacementPath: newFilePath,
                fileType,
              },
            });
          } catch (historyError) {
            console.warn(`[Organizer] Failed to record sibling ${fileType} delete history for ${siblingPath}:`, historyError);
          }
        }

        fs.rmSync(siblingPath, { force: true });
        db.prepare("DELETE FROM TrackFiles WHERE file_path = ? AND file_type = ?").run(siblingPath, fileType);
        console.log(`[Organizer] Deleted conflicting ${fileType} variant: ${siblingPath}`);
      } catch (error) {
        console.warn(`[Organizer] Failed to delete conflicting ${fileType} variant: ${siblingPath}`, error);
      }
    }
  }

  private static hasConflictingMediaDestination(filePath: string, mediaId: string, fileType: "track" | "video"): boolean {
    if (!fs.existsSync(filePath)) {
      return false;
    }

    const existing = db.prepare(`
      SELECT provider_id AS media_id
      FROM TrackFiles
      WHERE file_path = ? AND file_type = ?
      LIMIT 1
    `).get(filePath, fileType) as { media_id?: number | string | null } | undefined;

    return !existing || String(existing.media_id ?? "") !== String(mediaId);
  }

  /**
   * Inline layout uses one primary path per audio stem + Plex type. When another
   * provider already owns that path, keep the better offer and drop the worse
   * import (including its TrackFiles row / on-disk file).
   */
  private static resolvePrimaryVideoDestinationConflict(params: {
    destPath: string;
    incomingProvider: string;
    incomingProviderId: string;
    incomingQuality: string | null;
  }): "proceed" | "skip" {
    const existing = db.prepare(`
      SELECT id, artist_id, NULL AS album_id, provider, CAST(provider_id AS TEXT) AS provider_id,
             quality, file_path, library_root
      FROM TrackFiles
      WHERE file_type = 'video'
        AND (
          file_path = ?
          OR expected_path = ?
        )
      LIMIT 1
    `).get(params.destPath, params.destPath) as {
      id: number;
      artist_id: number | string;
      album_id: number | string | null;
      provider: string | null;
      provider_id: string | null;
      quality: string | null;
      file_path: string;
      library_root: string | null;
    } | undefined;

    if (!existing) {
      return "proceed";
    }
    if (String(existing.provider_id || "") === String(params.incomingProviderId)) {
      return "proceed";
    }

    const compare = compareVideoOffersByQualityThenProvider(
      {
        provider: params.incomingProvider,
        quality: params.incomingQuality,
        provider_id: params.incomingProviderId,
      },
      {
        provider: String(existing.provider || ""),
        quality: existing.quality,
        provider_id: String(existing.provider_id || ""),
      },
    );
    // compare < 0 ⇒ incoming ranks better; >= 0 ⇒ keep the occupant.
    if (compare >= 0) {
      console.log(
        `[Organizer] Skipping video ${params.incomingProviderId}; preferred offer already at ${params.destPath}`,
      );
      return "skip";
    }

    const resolvedExisting = resolveStoredLibraryPath({
      filePath: existing.file_path,
      libraryRoot: existing.library_root,
    });
    try {
      recordHistoryEvent({
        artistId: existing.artist_id,
        albumId: existing.album_id,
        mediaId: existing.provider_id,
        libraryFileId: existing.id,
        eventType: HISTORY_EVENT_TYPES.TrackFileDeleted,
        quality: existing.quality,
        data: {
          deletedPath: resolvedExisting,
          replacementPath: params.destPath,
          fileType: "video",
          reason: "primary_inline_video_upgrade",
        },
      });
    } catch (historyError) {
      console.warn(`[Organizer] Failed to record replaced video history for ${existing.provider_id}:`, historyError);
    }
    try {
      if (fs.existsSync(resolvedExisting)) {
        fs.rmSync(resolvedExisting, { force: true });
      }
      for (const sidecarExt of [".jpg", ".png", ".nfo"]) {
        const sidecar = resolvedExisting.replace(/\.mp4$/i, sidecarExt);
        if (fs.existsSync(sidecar)) {
          fs.rmSync(sidecar, { force: true });
        }
      }
    } catch (error) {
      console.warn(`[Organizer] Failed to delete displaced video at ${resolvedExisting}:`, error);
    }
    db.prepare("DELETE FROM TrackFiles WHERE id = ?").run(existing.id);
    const stemPrefix = resolvedExisting.replace(/\.mp4$/i, "");
    db.prepare(`
      DELETE FROM TrackFiles
      WHERE file_type IN ('video_thumbnail', 'nfo')
        AND (
          file_path = ?
          OR file_path = ?
          OR (
            provider_entity_type = 'video'
            AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
          )
        )
    `).run(`${stemPrefix}.jpg`, `${stemPrefix}.nfo`, String(existing.provider_id || ""));
    console.log(
      `[Organizer] Replacing video at ${params.destPath} with better offer ${params.incomingProviderId}`,
    );
    return "proceed";
  }

  /** Return the library root that contains the given absolute path, or null. */
  private static resolveLibraryRoot(filePath: string, libraryRoot?: string | null): string | null {
    const mappedRoot = resolveLibraryRootPath(libraryRoot, filePath);
    if (mappedRoot) return mappedRoot;

    const resolved = path.resolve(filePath);
    for (const root of [Config.getMusicPath(), Config.getVideoPath(), Config.getSpatialPath()]) {
      if (root && resolved.startsWith(path.resolve(root))) return root;
    }
    return null;
  }

  private static moveFileCrossDevice(sourcePath: string, destPath: string) {
    this.ensureDir(path.dirname(destPath));

    try {
      fs.renameSync(sourcePath, destPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
        throw error;
      }
    }

    if (process.platform === "win32") {
      fs.copyFileSync(sourcePath, destPath);
    } else {
      // Imports and upgrades intentionally replace an existing destination.
      execFileSync("cp", ["-f", sourcePath, destPath], { stdio: "ignore" });
    }

    fs.rmSync(sourcePath, { force: true });
  }
  private static upsertLibraryFile(params: {
    artistId: string;
    albumId?: string | null;
    mediaId?: string | null;
    trackFileId?: number | null;
    filePath: string;
    libraryRoot: string;
    fileType: "track" | "video" | "cover" | "video_cover" | "video_thumbnail" | "lyrics" | "nfo";
    quality?: string | null;
    namingTemplate?: string | null;
    expectedPath?: string | null;
  bitDepth?: number | null;
  sampleRate?: number | null;
  bitrate?: number | null;
  codec?: string | null;
  videoCodec?: string | null;
  channels?: number | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  fingerprint?: string | null;
    provider?: string | null;
    providerEntityType?: string | null;
    providerId?: string | null;
    librarySlot?: string | null;
    canonicalArtistMbid?: string | null;
    canonicalReleaseGroupMbid?: string | null;
    canonicalReleaseMbid?: string | null;
    canonicalTrackMbid?: string | null;
    canonicalRecordingMbid?: string | null;
  }): number {
    return LibraryFilesService.upsertLibraryFile({
      ...params,
      removeFromUnmapped: true,
    });
  }

  /**
   * Prefer the explicit job provider. Never silently fall back to the global
   * default (often TIDAL) for Apple/YouTube ids — that misnames files and
   * fetches the wrong catalog metadata.
   */
  private static resolveOrganizeStreamingProvider(
    raw: OrganizeRequest,
    providerId: string,
    type: OrganizeType,
  ): string {
    const explicit = String(raw.provider || "").trim();
    if (explicit) {
      return explicit;
    }

    const entityType = type === "album" ? "album" : type === "video" ? "video" : "track";
    const row = db.prepare(`
      SELECT provider
      FROM ProviderItems
      WHERE entity_type = ?
        AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(entityType, providerId) as { provider?: string } | undefined;
    const fromOffer = String(row?.provider || "").trim();
    if (fromOffer) {
      return fromOffer;
    }

    throw new Error(
      `Missing provider for ${entityType} ${providerId}. ` +
      `Refusing to default to ${getDefaultStreamingSource()} — requeue the download with an explicit provider.`,
    );
  }

  public static async organizeDownload(raw: OrganizeRequest): Promise<OrganizeResult> {
    const type: OrganizeType =
      raw.type === "DownloadAlbum" ? "album" :
        raw.type === "DownloadVideo" ? "video" :
          raw.type === "DownloadTrack" ? "track" :
            (raw.type as OrganizeType);

    const providerId = raw.providerId;
    if (!providerId) {
      throw new Error("Missing tidal id for organizer");
    }

    const streamingProviderId = OrganizerService.resolveOrganizeStreamingProvider(raw, providerId, type as OrganizeType);
    const downloadPath = raw.downloadPath
      ? validateDownloadWorkspacePath(raw.downloadPath)
      : getDownloadWorkspacePath(type as OrganizeType, providerId, streamingProviderId);
    const onProgress = raw.onProgress;
    const metadataConfig = Config.getMetadataConfig();

    const musicRoot = Config.getMusicPath();
    const spatialRoot = Config.getSpatialPath();
    const videoRoot = Config.getVideoPath();

    [musicRoot, spatialRoot, videoRoot].forEach((root) => this.ensureDir(root));

    if (type === "album") {
      const offerAlbumIds = (raw.trackOffers || [])
        .map((offer) => String(offer.providerAlbumId || "").trim())
        .filter(Boolean);
      const albumIds = Array.from(new Set([
        ...providerId.split(";").map((part) => part.trim()).filter(Boolean),
        ...offerAlbumIds,
      ]));
      if (albumIds.length === 0) throw new Error("Missing tidal id");
      const { RefreshAlbumService } = await import("../music/refresh-album-service.js");
      for (const albumIdVal of albumIds) {
        await RefreshAlbumService.refreshMetadata(albumIdVal, { provider: streamingProviderId });
      }

      const album = db.prepare(`
        SELECT
          artist_mbid AS artist_id,
          release_group_mbid AS mb_release_group_id,
          release_mbid AS mbid,
          quality,
          NULL AS num_volumes
        FROM ProviderItems
        WHERE provider = ?
          AND entity_type = 'album'
          AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(streamingProviderId, albumIds[0]) as any;
      if (!album) throw new Error(`Album ${albumIds[0]} offer not found in ProviderItems after scan`);

      const canonicalContext = this.resolveCanonicalAlbumImportContext(raw, albumIds[0]);
      // Prefer the acquisition-plan job MBIDs over any slot/ProviderItems context.
      // Competing singles that share a tip album id must not rebind the hybrid.
      const jobReleaseGroupMbid = String(raw.releaseGroupMbid || "").trim()
        || canonicalContext?.releaseGroupMbid
        || null;
      const jobReleaseMbid = String(raw.releaseMbid || "").trim()
        || canonicalContext?.releaseMbid
        || null;
      const artistContext = this.resolveCanonicalArtistForAlbum(album);
      const artistId = artistContext.artistId;
      const artistMbId = artistContext.artistMbId;
      const resolvedArtistName = artistContext.artistName || "Unknown Artist";
      const naming = getNamingConfig();
      const artistFolder = resolveArtistFolderFromRecord({
        name: resolvedArtistName,
        mbid: artistMbId || null,
        path: artistContext.artistPath || null,
      });

      let isSpatial = false;
      if (canonicalContext?.slot) {
        isSpatial = canonicalContext.slot === "spatial";
      } else {
        isSpatial = isSpatialAudioQuality(canonicalContext?.quality || album.quality);
      }
      const targetRoot = isSpatial ? spatialRoot : musicRoot;
      const canonicalAlbumForNaming = getCanonicalAlbumMetadata({
        canonicalReleaseGroupMbid: jobReleaseGroupMbid || album.mb_release_group_id,
        canonicalReleaseMbid: jobReleaseMbid || album.mbid,
      });

      const trackTemplate = Number(canonicalAlbumForNaming?.volumeCount || canonicalContext?.volumeCount || album.num_volumes || 1) > 1
        ? naming.album_track_path_multi
        : naming.album_track_path_single;

      const sourceAlbumDir = downloadPath;
      if (!fs.existsSync(sourceAlbumDir)) {
        throw new Error(`[Organizer] Could not locate download folder for album ${providerId} in ${downloadPath}`);
      }

      const files = this.findFilesRecursively(sourceAlbumDir);
      if (files.length === 0) {
        throw new Error(`[Organizer] No media files found for album ${providerId} in ${sourceAlbumDir}`);
      }

      const audioFiles = files.filter((file) => this.AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase()));
      const matchedTrackIdsByFile = await this.matchAlbumFilesToTracks(
        albumIds.join(";"),
        audioFiles,
        canonicalContext,
        raw.trackOffers,
      );
      if (audioFiles.length > 0 && matchedTrackIdsByFile.size === 0) {
        throw new Error(`[Organizer] Could not match downloaded album files for ${providerId} to Discogenius tracks in ${sourceAlbumDir}`);
      }

      const trackOffersByProviderIdEarly = new Map<string, NonNullable<OrganizeRequest["trackOffers"]>[number]>();
      for (const offer of raw.trackOffers || []) {
        const key = String(offer.providerTrackId || "").trim();
        if (key) trackOffersByProviderIdEarly.set(key, offer);
      }

      const unmatchedAudioFiles = audioFiles.filter((srcFile) => {
        const ext = path.extname(srcFile).toLowerCase();
        const base = path.basename(srcFile, ext);
        const idFromName = /^\d+$/.test(base) ? base : null;
        const trackId = matchedTrackIdsByFile.get(srcFile) || idFromName;
        if (!trackId) return true;
        // Hybrid tips with catalog MBIDs are importable even when the primary
        // album ProviderItems row cannot resolve them yet.
        const tipOffer = trackOffersByProviderIdEarly.get(String(trackId));
        if (tipOffer?.canonicalTrackMbid || tipOffer?.canonicalRecordingMbid) {
          return false;
        }
        if (jobReleaseMbid) {
          const trackRow = this.resolveMatchedCanonicalAlbumTrackRow({
            provider: canonicalContext?.provider || streamingProviderId,
            trackId,
            releaseMbid: jobReleaseMbid,
            fallbackAlbumId: albumIds[0],
            fallbackAlbumIds: albumIds,
            fallbackArtistId: artistId,
            fallbackQuality: canonicalContext?.quality || album.quality || null,
          });
          return !trackRow;
        } else {
          const placeholders = albumIds.map(() => '?').join(', ');
          const trackRow = db.prepare(`SELECT 1 FROM ProviderItems WHERE entity_type = 'track' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT) AND provider_album_id IN (${placeholders}) LIMIT 1`).get(trackId, ...albumIds) as any;
          return !trackRow;
        }
      });

      if (unmatchedAudioFiles.length > 0) {
        // Import what matched instead of failing the whole album. Failing here
        // left the album permanently "missing", so the monitoring cycle would
        // re-download and re-fail it every cycle forever (e.g. a single bonus
        // file the provider release has but the canonical MB release doesn't).
        // The import loop below already skips unmatched files, so the album's
        // real tracks still land.
        console.warn(
          `[Organizer] ${unmatchedAudioFiles.length}/${audioFiles.length} downloaded file(s) for ${providerId} did not match a Discogenius track; importing the rest and skipping the extras.`,
        );
      }

      const totalImportableTracks = audioFiles.length - unmatchedAudioFiles.length;
      onProgress?.({
        phase: "importing",
        currentFileNum: 0,
        totalFiles: totalImportableTracks,
        statusMessage: "Importing downloaded album files",
      });

      const trackOffersByProviderId = new Map<string, NonNullable<OrganizeRequest["trackOffers"]>[number]>();
      for (const offer of raw.trackOffers || []) {
        const key = String(offer.providerTrackId || "").trim();
        if (key) trackOffersByProviderId.set(key, offer);
      }

      const renderedTrackDirs: string[] = [];
      const destFiles: Array<{ trackId: string; destFile: string; ext: string }> = [];
      const importedStereoTrackFileIds: number[] = [];
      let sampleRelativeTrackPath: string | null = null;
      const processedEmbeddedVideoIds = new Set<string>();
      const albumTrackNamingTemplate = path.join(artistFolder, trackTemplate);

      for (const srcFile of files) {
        const ext = path.extname(srcFile).toLowerCase();
        const base = path.basename(srcFile, ext);
        const idFromName = /^\d+$/.test(base) ? base : null;

        if (this.VIDEO_EXTENSIONS.has(ext) && idFromName) {
          if (!processedEmbeddedVideoIds.has(idFromName)) {
            processedEmbeddedVideoIds.add(idFromName);
            try {
              await this.organizeDownload({ type: "video", providerId: idFromName, downloadPath: sourceAlbumDir });
            } catch (error) {
              console.warn(`[Organizer] Skipping embedded video ${idFromName} while organizing album ${providerId}:`, error);
            }
          }
          continue;
        }

        if (!this.AUDIO_EXTENSIONS.has(ext)) {
          continue;
        }

        const trackId = matchedTrackIdsByFile.get(srcFile) || idFromName;
        const placeholders = albumIds.map(() => '?').join(', ');
        const trackOffer = trackId ? trackOffersByProviderId.get(String(trackId)) : undefined;
        // Catalog-first: bind position/title via Tracks on the job's selected
        // release. Acquisition-plan offers supply the catalog MBIDs — never trust
        // ProviderItems track/RG MBIDs for hybrid composites (those can point at
        // unrelated singles that share a tip album id).
        const fallbackReleaseMbid = jobReleaseMbid || album.mbid || null;
        const offerTrackMbid = String(trackOffer?.canonicalTrackMbid || "").trim() || null;
        const offerRecordingMbid = String(trackOffer?.canonicalRecordingMbid || "").trim() || null;

        let trackRow: MatchedAlbumTrackRow | null = null;
        if (trackId && fallbackReleaseMbid && (offerTrackMbid || offerRecordingMbid)) {
          const offered = db.prepare(`
            SELECT
              t.mbid AS canonical_track_mbid,
              t.recording_mbid AS canonical_recording_mbid,
              t.title,
              t.position AS track_number,
              t.medium_position AS volume_number
            FROM Tracks t
            WHERE t.release_mbid = ?
              AND (
                (? IS NOT NULL AND t.mbid = ?)
                OR (? IS NOT NULL AND t.recording_mbid = ?)
              )
            ORDER BY
              CASE WHEN ? IS NOT NULL AND t.mbid = ? THEN 0 ELSE 1 END,
              t.medium_position,
              t.position
            LIMIT 1
          `).get(
            fallbackReleaseMbid,
            offerTrackMbid,
            offerTrackMbid,
            offerRecordingMbid,
            offerRecordingMbid,
            offerTrackMbid,
            offerTrackMbid,
          ) as {
            canonical_track_mbid: string;
            canonical_recording_mbid: string;
            title: string;
            track_number: number;
            volume_number: number;
          } | undefined;
          if (offered) {
            trackRow = {
              id: trackId,
              album_id: jobReleaseGroupMbid || albumIds[0],
              artist_id: artistId,
              title: offered.title,
              version: null,
              explicit: null,
              quality: trackOffer?.quality || canonicalContext?.quality || album.quality || null,
              track_number: offered.track_number,
              volume_number: offered.volume_number,
              mbid: offered.canonical_recording_mbid,
              canonical_track_mbid: offered.canonical_track_mbid,
              canonical_recording_mbid: offered.canonical_recording_mbid,
            };
          }
        }

        if (!trackRow) {
          trackRow = trackId && fallbackReleaseMbid
            ? this.resolveMatchedCanonicalAlbumTrackRow({
                provider: canonicalContext?.provider || streamingProviderId,
                trackId,
                releaseMbid: fallbackReleaseMbid,
                fallbackAlbumId: albumIds[0],
                fallbackAlbumIds: albumIds,
                fallbackArtistId: artistId,
                fallbackQuality: canonicalContext?.quality || album.quality || null,
              })
            : trackId
              ? (db.prepare(`
                  SELECT
                    provider_album_id AS album_id,
                    quality,
                    title,
                    version,
                    explicit,
                    NULL AS track_number,
                    NULL AS volume_number,
                    track_mbid AS canonical_track_mbid,
                    recording_mbid AS canonical_recording_mbid,
                    artist_mbid AS artist_id
                  FROM ProviderItems
                  WHERE entity_type = 'track' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT) AND provider_album_id IN (${placeholders})
                  LIMIT 1
                `).get(trackId, ...albumIds) as any)
              : null;
        }

        if (!trackId || !trackRow) {
          continue;
        }

        // Acquisition-plan offers outrank native ProviderItems identity for
        // hybrid/partial albums (correct catalog MBID + disc/track numbers).
        const resolvedCanonicalTrackMbid = offerTrackMbid || trackRow.canonical_track_mbid || null;
        const resolvedCanonicalRecordingMbid = offerRecordingMbid || trackRow.canonical_recording_mbid || null;

        const canonicalIdentity = resolveLibraryFileIdentity({
          artistId,
          albumId: String(jobReleaseGroupMbid || trackRow.album_id || albumIds[0]),
          mediaId: trackId,
          fileType: "track",
          quality: trackOffer?.quality || trackRow.quality || album.quality,
          libraryRoot: targetRoot,
          provider: canonicalContext?.provider || raw.provider || getDefaultStreamingSource(),
          providerEntityType: "track",
          providerId: trackId,
          librarySlot: canonicalContext?.slot || (isSpatial ? "spatial" : "stereo"),
          canonicalArtistMbid: canonicalContext?.artistMbid || artistMbId || null,
          canonicalReleaseGroupMbid: jobReleaseGroupMbid,
          canonicalReleaseMbid: jobReleaseMbid,
          canonicalTrackMbid: resolvedCanonicalTrackMbid,
          canonicalRecordingMbid: resolvedCanonicalRecordingMbid,
        });
        const canonicalPosition = getCanonicalTrackPosition(canonicalIdentity.canonicalTrackMbid);
        const canonicalAlbum = getCanonicalAlbumMetadata({
          canonicalReleaseGroupMbid: canonicalIdentity.canonicalReleaseGroupMbid,
          canonicalReleaseMbid: canonicalIdentity.canonicalReleaseMbid,
        });
        const trackTitle = canonicalPosition?.title
          || trackRow.title
          || "Unknown Track";
        const trackNumber = canonicalPosition?.trackNumber
          ?? (Number(trackRow.track_number || 0) > 0 ? Number(trackRow.track_number) : null)
          ?? 0;
        const volumeNumber = canonicalPosition?.volumeNumber
          ?? (Number(trackRow.volume_number || 0) > 0 ? Number(trackRow.volume_number) : null)
          ?? 1;
        const libraryAlbumId = canonicalIdentity.canonicalReleaseGroupMbid || String(trackRow.album_id || albumIds[0]);
        const trackArtistId = String(trackRow.artist_id || artistId);
        const trackArtist = db.prepare("SELECT name, mbid FROM Artists WHERE id = ?").get(trackArtistId) as any;
        const resolvedTrackArtistName = (trackArtist?.name as string | undefined) || resolvedArtistName;
        const trackArtistMbId = trackArtist?.mbid ? String(trackArtist.mbid) : artistMbId;
        const metrics = await parseAudioFile(srcFile);
        const derivedQuality = deriveQuality(ext, metrics);

        const renderedTrackPath = renderRelativePath(trackTemplate, {
          artistName: resolvedArtistName,
          artistId,
          artistMbId,
          artistGenre: artistContext.artistGenre,
          albumTitle: canonicalAlbum?.title || "Unknown Album",
          albumId: libraryAlbumId,
          albumType: canonicalAlbum?.albumType || album.type || album.mb_primary || null,
          albumMbId: canonicalAlbum?.albumMbid || album.mbid || null,
          albumVersion: canonicalAlbum ? null : album.version || null,
          albumDisambiguation: canonicalAlbum?.disambiguation || null,
          albumGenre: firstGenre(canonicalAlbum?.genres),
          releaseYear: getReleaseYear(canonicalAlbum?.releaseDate || album.release_date),
          trackTitle,
          trackId,
          trackMbId: canonicalIdentity.canonicalTrackMbid || trackRow.mbid || null,
          trackArtistName: resolvedTrackArtistName,
          trackArtistMbId,
          trackVersion: canonicalPosition ? null : trackRow.version || null,
          explicit: trackRow.explicit === 1,
          trackNumber,
          volumeNumber,
          provider: canonicalContext?.provider || raw.provider || getDefaultStreamingSource(),
          quality: derivedQuality,
          codec: metrics.codec || null,
          bitrate: metrics.bitrate || null,
          sampleRate: metrics.sampleRate || null,
          bitDepth: metrics.bitDepth || null,
          channels: metrics.channels || null,
        });
        const baseRelativeTrackPath = renderedTrackPath;
        const relativeTrackPath = renderAudioRelativePathForLibrary({
          relativePath: baseRelativeTrackPath,
          quality: derivedQuality,
          musicRoot,
          spatialRoot,
          mustDisambiguate: this.hasConflictingMediaDestination(
            path.join(targetRoot, artistFolder, `${baseRelativeTrackPath}${ext}`),
            trackId,
            "track",
          ),
        });

        if (!sampleRelativeTrackPath) sampleRelativeTrackPath = relativeTrackPath;

        const trackDirRel = path.dirname(relativeTrackPath);
        if (trackDirRel && trackDirRel !== ".") {
          renderedTrackDirs.push(trackDirRel);
        }

        const destFile = path.join(targetRoot, artistFolder, `${relativeTrackPath}${ext}`);
        onProgress?.({
          phase: "importing",
          currentFileNum: destFiles.length + 1,
          totalFiles: totalImportableTracks,
          currentTrack: trackTitle,
          trackStatus: "downloading",
          statusMessage: `Importing ${trackTitle}`,
        });

        this.moveFileCrossDevice(srcFile, destFile);

        for (const lyricExtension of LYRIC_SIDECAR_EXTENSIONS) {
          const srcLyricFile = srcFile.replace(new RegExp(`\\${ext}$`, "i"), lyricExtension);
          const destLyricFile = destFile.replace(new RegExp(`\\${ext}$`, "i"), lyricExtension);
          if (fs.existsSync(srcLyricFile)) {
            this.moveFileCrossDevice(srcLyricFile, destLyricFile);
          }
        }

        // Fingerprinting and embedded tags are applied by the post-organize
        // import finalizer after MusicBrainz identity is resolved.
        const fileFingerprint: string | null = null;

        // Batch all per-track DB writes in a single transaction.
        // This reduces ~5-6 auto-commits per track to 1 committed batch.
        const mediaIdStr = trackRow?.id ? String(trackRow.id) : trackId;
        let importedTrackFileId: number | null = null;
        db.transaction(() => {
          const libraryFileId = this.upsertLibraryFile({
            artistId,
            albumId: libraryAlbumId,
            mediaId: mediaIdStr,
            filePath: destFile,
            libraryRoot: targetRoot,
            fileType: "track",
            quality: derivedQuality,
            namingTemplate: albumTrackNamingTemplate,
            expectedPath: destFile,
            bitDepth: metrics.bitDepth,
            sampleRate: metrics.sampleRate,
            bitrate: metrics.bitrate,
            codec: metrics.codec,
            channels: metrics.channels,
            duration: metrics.duration,
            fingerprint: fileFingerprint,
            provider: canonicalIdentity.provider,
            providerEntityType: canonicalIdentity.providerEntityType,
            providerId: canonicalIdentity.providerId,
            librarySlot: canonicalIdentity.librarySlot,
            canonicalArtistMbid: canonicalIdentity.canonicalArtistMbid,
            canonicalReleaseGroupMbid: canonicalIdentity.canonicalReleaseGroupMbid,
            canonicalReleaseMbid: canonicalIdentity.canonicalReleaseMbid,
            canonicalTrackMbid: canonicalIdentity.canonicalTrackMbid,
            canonicalRecordingMbid: canonicalIdentity.canonicalRecordingMbid,
          });
          importedTrackFileId = libraryFileId;

          try {
            recordHistoryEvent({
              artistId,
              albumId: libraryAlbumId,
              mediaId: mediaIdStr,
              libraryFileId,
              eventType: HISTORY_EVENT_TYPES.TrackFileImported,
              quality: derivedQuality,
              sourceTitle: trackTitle,
              data: {
                importedPath: destFile,
              },
            });
          } catch (historyError) {
            console.warn(`[Organizer] Failed to record track import history for ${mediaIdStr}:`, historyError);
          }

          if (mediaIdStr) {
            this.cleanupOldMediaFiles(
              mediaIdStr,
              destFile,
              "track",
              canonicalIdentity.librarySlot ?? null,
              canonicalIdentity.provider,
            );
            this.cleanupSiblingMediaVariants(destFile, "track");
          }
        })();

        if (metadataConfig.save_lyrics && trackId) {
          try {
            const lyricPath = this.relocateLinkedSidecar({
              artistId,
              albumId: libraryAlbumId,
              mediaId: trackId,
              mediaPath: destFile,
              libraryRoot: targetRoot,
              fileType: "lyrics",
              quality: trackRow?.quality || album.quality,
            });
            // Import provider-downloaded lyric sidecars when present, but do
            // not make the media import wait on one or more remote lyric
            // lookups per track. Missing sidecars are fetched by the durable
            // scheduled library-metadata backfill instead. On large albums the old
            // inline fallback could hold the import phase for many minutes
            // after every audio file was already safely organized.
            if (fs.existsSync(lyricPath)) {
              this.upsertLibraryFile({
                artistId,
                albumId: libraryAlbumId,
                mediaId: trackId,
                trackFileId: importedTrackFileId,
                filePath: lyricPath,
                libraryRoot: targetRoot,
                fileType: "lyrics",
                quality: trackRow?.quality || album.quality,
                namingTemplate: null,
                expectedPath: lyricPath,
                provider: canonicalIdentity.provider,
                providerEntityType: "track",
                providerId: trackId,
                librarySlot: canonicalIdentity.librarySlot,
                canonicalArtistMbid: canonicalIdentity.canonicalArtistMbid,
                canonicalReleaseGroupMbid: canonicalIdentity.canonicalReleaseGroupMbid,
                canonicalReleaseMbid: canonicalIdentity.canonicalReleaseMbid,
                canonicalTrackMbid: canonicalIdentity.canonicalTrackMbid,
                canonicalRecordingMbid: canonicalIdentity.canonicalRecordingMbid,
              });
            }
          } catch (error) {
            console.warn(`[Organizer] Failed to save or track lyrics for ${trackId}:`, error);
          }
        }

        destFiles.push({ trackId, destFile, ext });
        if (
          importedTrackFileId != null
          && (canonicalIdentity.librarySlot ?? (isSpatial ? "spatial" : "stereo")) === "stereo"
        ) {
          importedStereoTrackFileIds.push(importedTrackFileId);
        }
        onProgress?.({
          phase: "importing",
          currentFileNum: destFiles.length,
          totalFiles: totalImportableTracks,
          currentTrack: trackTitle,
          trackStatus: "completed",
          statusMessage: `Importing ${trackTitle}`,
        });
      }

      onProgress?.({
        phase: "finalizing",
        currentFileNum: destFiles.length,
        totalFiles: totalImportableTracks,
        statusMessage: "Finalizing album metadata",
      });

      const albumDirRelative = sampleRelativeTrackPath
        ? deriveAlbumDirRelativeFromTrackPath(trackTemplate, sampleRelativeTrackPath)
        : commonPathPrefix(renderedTrackDirs);
      const targetAlbumDir = path.join(targetRoot, artistFolder, albumDirRelative);
      this.ensureDir(targetAlbumDir);

      const artistDir = path.join(targetRoot, artistFolder);
      this.ensureDir(artistDir);
      const artistPicPath = path.join(artistDir, metadataConfig.artist_picture_name || "folder.jpg");
      if (metadataConfig.save_artist_picture) {
        this.relocateSingletonSidecar({
          artistId,
          expectedPath: artistPicPath,
          libraryRoot: targetRoot,
          fileType: "cover",
        });
      }
      if (metadataConfig.save_artist_picture) {
        // Saved sidecar artwork always uses the highest available resolution,
        // independent of metadata.artist_picture_resolution (which only caps
        // the UI's cached display thumbnail — see media-cover-service.ts).
        // Artwork is a backfillable sidecar: its fetch must NEVER fail an import
        // whose audio is already organized + tracked. The default provider may
        // not even carry this album (e.g. an Apple-only id), and the scheduled
        // library-metadata backfill retries missing artwork later.
        try {
          await downloadArtistPicture(artistId, "origin", artistPicPath);
          if (fs.existsSync(artistPicPath)) {
            this.upsertLibraryFile({
              artistId,
              albumId: null,
              mediaId: null,
              filePath: artistPicPath,
              libraryRoot: targetRoot,
              fileType: "cover",
              quality: null,
              namingTemplate: null,
              expectedPath: artistPicPath,
            });
          }
        } catch (error) {
          console.warn(`[Organizer] Failed to fetch artist picture for ${artistId}; import already complete:`, error);
        }
      }

      const albumCoverPath = path.join(targetAlbumDir, metadataConfig.album_cover_name || "cover.jpg");
      if (metadataConfig.save_album_cover) {
        this.relocateSingletonSidecar({
          artistId,
          albumId: albumIds[0],
          expectedPath: albumCoverPath,
          libraryRoot: targetRoot,
          fileType: "cover",
        });
      }
      if (metadataConfig.save_album_cover) {
        // Saved sidecar artwork always uses the highest available resolution,
        // independent of metadata.album_cover_resolution (which only caps the
        // UI's cached display thumbnail — see media-cover-service.ts).
        // Pass the import provider so a non-default-provider album (e.g. an
        // Apple-only album while the default provider is TIDAL) resolves against
        // the correct provider instead of 404ing on the default. A cover fetch
        // must still never fail an import whose audio is already tracked — the
        // scheduled library-metadata backfill retries a genuine miss later.
        try {
          await downloadAlbumCover(albumIds[0], "origin", albumCoverPath, { provider: streamingProviderId });
          if (fs.existsSync(albumCoverPath)) {
            this.upsertLibraryFile({
              artistId,
              albumId: albumIds[0],
              mediaId: null,
              filePath: albumCoverPath,
              libraryRoot: targetRoot,
              fileType: "cover",
              quality: null,
              namingTemplate: null,
              expectedPath: albumCoverPath,
            });
          }
        } catch (error) {
          console.warn(`[Organizer] Failed to fetch album cover for ${albumIds[0]}; import already complete:`, error);
        }
      }

      const albumVideoCoverName = getAlbumVideoCoverName(metadataConfig.album_cover_name || "cover.jpg");
      const albumVideoCoverPath = path.join(targetAlbumDir, albumVideoCoverName);
      const albumVideoCoverId = metadataConfig.save_album_cover
        ? await resolveAlbumVideoCoverForLibrary({
            storedVideoCover: canonicalAlbumForNaming?.videoCover || null,
            provider: streamingProviderId,
            providerAlbumId: albumIds[0],
            releaseGroupMbid: canonicalContext?.releaseGroupMbid || album.mb_release_group_id || null,
          })
        : null;
      if (metadataConfig.save_album_cover && albumVideoCoverId) {
        this.relocateSingletonSidecar({
          artistId,
          albumId: albumIds[0],
          expectedPath: albumVideoCoverPath,
          libraryRoot: targetRoot,
          fileType: "video_cover",
        });
      }
      if (metadataConfig.save_album_cover && albumVideoCoverId && !fs.existsSync(albumVideoCoverPath)) {
        // Saved sidecar artwork always uses the highest available resolution,
        // independent of metadata.album_cover_resolution (which only caps the
        // UI's cached display thumbnail — see media-cover-service.ts).
        // Same rule as the still cover: an animated-cover fetch failure must not
        // fail an already-tracked import.
        try {
          await downloadAlbumVideoCover(String(albumVideoCoverId), "origin", albumVideoCoverPath, {
            provider: streamingProviderId,
            providerAlbumId: albumIds[0],
            releaseGroupMbid: canonicalContext?.releaseGroupMbid || album.mb_release_group_id || null,
          });
          if (fs.existsSync(albumVideoCoverPath)) {
            this.upsertLibraryFile({
              artistId,
              albumId: albumIds[0],
              mediaId: null,
              filePath: albumVideoCoverPath,
              libraryRoot: targetRoot,
              fileType: "video_cover",
              quality: null,
              namingTemplate: null,
              expectedPath: albumVideoCoverPath,
            });
          }
        } catch (error) {
          console.warn(`[Organizer] Failed to fetch album video cover for ${albumIds[0]}; import already complete:`, error);
        }
      }

      if (metadataConfig.save_nfo) {
        const artistNfoPath = path.join(artistDir, "artist.nfo");
        const albumNfoPath = path.join(targetAlbumDir, "album.nfo");
        try {
          await saveArtistNfoFile(artistId, artistNfoPath);
          this.upsertLibraryFile({
            artistId,
            albumId: null,
            mediaId: null,
            filePath: artistNfoPath,
            libraryRoot: targetRoot,
            fileType: "nfo",
            quality: null,
            namingTemplate: null,
            expectedPath: artistNfoPath,
          });
        } catch (error) {
          console.warn(`[Organizer] Failed to write artist NFO for ${artistId}:`, error);
        }

        try {
          await saveAlbumNfoFile(albumIds[0], albumNfoPath);
          this.upsertLibraryFile({
            artistId,
            albumId: albumIds[0],
            mediaId: null,
            filePath: albumNfoPath,
            libraryRoot: targetRoot,
            fileType: "nfo",
            quality: null,
            namingTemplate: null,
            expectedPath: albumNfoPath,
          });
        } catch (error) {
          console.warn(`[Organizer] Failed to write album NFO for ${albumIds[0]}:`, error);
        }
      }

      // Album-bundled music videos: providers like Apple Music append videos
      // to the tracklist, staged as <providerId>.mp4 next to the audio files.
      const bundledVideoIds: string[] = [];
      const videoFiles = files.filter((file) => this.VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase()));
      if (videoFiles.length > 0) {
        const matchedVideoIdsByFile = await this.matchAlbumFilesToTracks(providerId, videoFiles, canonicalContext);
        for (const [srcFile, bundledTrackId] of matchedVideoIdsByFile) {
          try {
            const imported = await this.importAlbumBundledVideoFile({
              src: srcFile,
              provider: canonicalContext?.provider || String(raw.provider || getDefaultStreamingSource()),
              providerTrackId: bundledTrackId,
              artistId,
              artistName: resolvedArtistName,
              artistMbId: artistMbId || null,
              artistFolder,
              artistGenres: artistContext.artistGenre ?? null,
              releaseGroupMbid: canonicalContext?.releaseGroupMbid || album.mb_release_group_id || null,
              videoRoot,
            });
            if (imported) {
              bundledVideoIds.push(bundledTrackId);
            } else {
              console.warn(`[Organizer] Bundled file ${srcFile} matched provider id ${bundledTrackId} but has no video track row; skipping.`);
            }
          } catch (error) {
            console.warn(`[Organizer] Failed to import bundled video ${bundledTrackId} for album ${providerId}:`, error);
          }
        }
      }

      let expectedTracks = 0;
      try {
        const placeholders = albumIds.map(() => '?').join(', ');
        expectedTracks = Number((db.prepare(`
          SELECT COUNT(*) as count FROM ProviderItems
          WHERE provider = ?
            AND entity_type = 'track'
            AND provider_album_id IN (${placeholders})
        `).get(streamingProviderId, ...albumIds) as { count?: number } | undefined)?.count || 0);
      } catch (error) {
        console.warn("[Organizer] Failed to query expected track count from ProviderItems:", error);
      }

      if (importedStereoTrackFileIds.length > 0) {
        try {
          const { RenameTrackFileService } = await import("./rename-track-file-service.js");
          RenameTrackFileService.relocateRelatedInlineVideosForImportedAudio(importedStereoTrackFileIds);
        } catch (error) {
          console.warn(`[Organizer] Failed to relocate related inline videos after album import:`, error);
        }
      }

      return {
        type: "album",
        providerId,
        processedTrackIds: [...destFiles.map((file) => file.trackId), ...bundledVideoIds],
        totalTracksInStaging: files.length,
        expectedTracks,
      };
    }

    if (type === "track") {
      const allFiles = this.findFilesRecursively(downloadPath);
      const src =
        allFiles.find(f => path.basename(f, path.extname(f)) === providerId) ||
        (allFiles.length === 1 ? allFiles[0] : null) ||
        allFiles.find(f => path.basename(f).includes(providerId));
      if (!src) {
        throw new Error(`[Organizer] Could not locate downloaded file for track ${providerId} in ${downloadPath}`);
      }

      const trackData = await this.fetchProviderTrack(providerId, streamingProviderId);
      onProgress?.({
        phase: "importing",
        currentFileNum: 0,
        totalFiles: 1,
        currentTrack: trackData?.title,
        statusMessage: "Importing downloaded track",
      });
      // Prefer live catalog album id, then the stored ProviderItems linkage
      // (YouTube/Apple singles often omit album on the track payload).
      let albumId = trackData?.album_id ? String(trackData.album_id) : null;
      if (!albumId) {
        const linked = db.prepare(`
          SELECT CAST(COALESCE(provider_album_id, album_id) AS TEXT) AS album_id
          FROM ProviderItems
          WHERE provider = ?
            AND entity_type = 'track'
            AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
          ORDER BY updated_at DESC
          LIMIT 1
        `).get(streamingProviderId, providerId) as { album_id?: string | null } | undefined;
        albumId = linked?.album_id ? String(linked.album_id) : null;
      }
      if (!albumId) throw new Error(`Track ${providerId} missing album_id`);

      // Ensure album + tracks in DB for naming and to locate track metadata.
      const { RefreshAlbumService } = await import("../music/refresh-album-service.js");
      await RefreshAlbumService.refreshMetadata(albumId, { provider: streamingProviderId });

      const album = db.prepare(`
        SELECT
          artist_mbid AS artist_id,
          release_group_mbid AS mb_release_group_id,
          release_mbid AS mbid,
          quality, title, version, release_date,
          NULL AS num_volumes, NULL AS type, NULL AS mb_primary
        FROM ProviderItems
        WHERE provider = ?
          AND entity_type = 'album'
          AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(streamingProviderId, albumId) as any;
      if (!album) throw new Error(`Album ${albumId} offer not found in ProviderItems after scan`);

      // Catalog-first: resolve title/position via the Tracks table on the
      // best-known release (job-supplied release mbid, else the album's own).
      // Never use match_evidence or live provider-native disc/track numbers.
      const trackPositionReleaseMbid = String(raw.releaseMbid || "").trim() || album.mbid || null;
      const trackRow = db.prepare(`
        SELECT
          pi.provider_id AS id,
          pi.provider_album_id AS album_id,
          pi.quality,
          COALESCE(NULLIF(TRIM(t.title), ''), pi.title) AS title,
          pi.version,
          pi.explicit,
          pi.track_mbid AS mbid,
          pi.artist_mbid AS artist_id,
          t.position AS track_number,
          t.medium_position AS volume_number
        FROM ProviderItems pi
        LEFT JOIN Tracks t
          ON t.release_mbid = ?
          AND (
            (pi.track_mbid IS NOT NULL AND t.mbid = pi.track_mbid)
            OR (pi.recording_mbid IS NOT NULL AND t.recording_mbid = pi.recording_mbid)
          )
        WHERE pi.provider = ?
          AND pi.entity_type = 'track'
          AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
        ORDER BY pi.updated_at DESC
        LIMIT 1
      `).get(trackPositionReleaseMbid, streamingProviderId, providerId) as any;
      if (!trackRow) throw new Error(`Track ${providerId} offer not found in ProviderItems after scan`);

      const artistContext = this.resolveCanonicalArtistForAlbum(album);
      const artistId = artistContext.artistId;
      const artistMbId = artistContext.artistMbId;
      const resolvedArtistName = artistContext.artistName || "Unknown Artist";
      const naming = getNamingConfig();
      const artistFolder = resolveArtistFolderFromRecord({
        name: resolvedArtistName,
        mbid: artistMbId || null,
        path: artistContext.artistPath || null,
      });

      const isSpatial = (String(raw.slot || "").toLowerCase() === "spatial")
        || isSpatialAudioQuality(album.quality);
      const targetRoot = isSpatial ? spatialRoot : musicRoot;

      const jobReleaseGroupMbid = String(raw.releaseGroupMbid || "").trim() || null;
      const jobReleaseMbid = String(raw.releaseMbid || "").trim() || null;
      const jobCanonicalTrackMbid = String(raw.canonicalTrackMbid || "").trim() || null;
      const jobCanonicalRecordingMbid = String(raw.canonicalRecordingMbid || "").trim() || null;
      const jobSlot = String(raw.slot || "").trim() || null;
      const jobTrackNumber = Number(raw.trackNumber || 0) > 0 ? Number(raw.trackNumber) : null;
      const jobVolumeNumber = Number(raw.volumeNumber || 0) > 0 ? Number(raw.volumeNumber) : null;

      const identityInput = {
        artistId,
        albumId,
        mediaId: providerId,
        fileType: "track" as const,
        quality: trackRow.quality || album.quality,
        libraryRoot: targetRoot,
        provider: streamingProviderId,
        providerEntityType: "track" as const,
        providerId,
        librarySlot: jobSlot,
        canonicalReleaseGroupMbid: jobReleaseGroupMbid,
        canonicalReleaseMbid: jobReleaseMbid,
        canonicalTrackMbid: jobCanonicalTrackMbid,
        canonicalRecordingMbid: jobCanonicalRecordingMbid,
      };

      const ext = path.extname(src);
      const canonicalPosition = resolveCanonicalTrackPosition(identityInput);
      const canonicalIdentity = resolveLibraryFileIdentity(identityInput);
      const canonicalAlbum = getCanonicalAlbumMetadata({
        canonicalReleaseGroupMbid: canonicalIdentity.canonicalReleaseGroupMbid,
        canonicalReleaseMbid: canonicalIdentity.canonicalReleaseMbid,
      });
      // Hybrid DownloadTrack jobs carry monitored composite positions; prefer
      // those and Tracks-table lookup. Never fall back to live provider-native
      // album numbering (trackData.track_number) — that mis-numbers Softly/etc.
      const trackTitle = canonicalPosition?.title
        || trackRow.title
        || trackData.title
        || path.basename(src, ext);
      const trackNumber = canonicalPosition?.trackNumber
        ?? jobTrackNumber
        ?? (Number(trackRow.track_number || 0) > 0 ? Number(trackRow.track_number) : 0);
      const volumeNumber = canonicalPosition?.volumeNumber
        ?? jobVolumeNumber
        ?? (Number(trackRow.volume_number || 0) > 0 ? Number(trackRow.volume_number) : 1);
      const trackArtistId = String(trackRow.artist_id || artistId);
      const trackArtist = db.prepare("SELECT name, mbid FROM Artists WHERE id = ?").get(trackArtistId) as any;
      const resolvedTrackArtistName = (trackArtist?.name as string | undefined) || resolvedArtistName;
      const trackArtistMbId = trackArtist?.mbid ? String(trackArtist.mbid) : artistMbId;

      const trackTemplate = Number(canonicalAlbum?.volumeCount || album.num_volumes || 1) > 1
        ? naming.album_track_path_multi
        : naming.album_track_path_single;
      const trackNamingTemplate = path.join(artistFolder, trackTemplate);
      const metrics = await parseAudioFile(src);
      const derivedQuality = deriveQuality(ext, metrics);

      const trackIdentity = resolveLibraryFileIdentity({
        ...identityInput,
        quality: derivedQuality,
      });
      // Prefer the hybrid/monitored release-group as the library album key so
      // covers, history, and folder identity follow the composite, not Pompeii etc.
      const libraryAlbumId = trackIdentity.canonicalReleaseGroupMbid || albumId;

      const renderedTrackPath = renderRelativePath(trackTemplate, {
        artistName: resolvedArtistName,
        artistId,
        artistMbId,
        artistGenre: artistContext.artistGenre,
        albumTitle: canonicalAlbum?.title || "Unknown Album",
        albumId: libraryAlbumId,
        albumType: canonicalAlbum?.albumType || album.type || album.mb_primary || null,
        albumMbId: canonicalAlbum?.albumMbid || trackIdentity.canonicalReleaseMbid || album.mbid || null,
        albumVersion: canonicalAlbum ? null : album.version || null,
        albumDisambiguation: canonicalAlbum?.disambiguation || null,
        albumGenre: firstGenre(canonicalAlbum?.genres),
        releaseYear: getReleaseYear(canonicalAlbum?.releaseDate || album.release_date),
        trackTitle,
        trackId: providerId,
        trackMbId: trackIdentity.canonicalTrackMbid || trackRow.mbid || null,
        trackArtistName: resolvedTrackArtistName,
        trackArtistMbId,
        trackNumber,
        volumeNumber,
        trackVersion: canonicalPosition ? null : trackRow.version || null,
        explicit: trackRow.explicit === 1,
        provider: streamingProviderId || trackIdentity.provider || getDefaultStreamingSource(),
        quality: derivedQuality,
        codec: metrics.codec || null,
        bitrate: metrics.bitrate || null,
        sampleRate: metrics.sampleRate || null,
        bitDepth: metrics.bitDepth || null,
        channels: metrics.channels || null,
      });
      const relativeTrackPath = renderAudioRelativePathForLibrary({
        relativePath: renderedTrackPath,
        quality: derivedQuality,
        musicRoot,
        spatialRoot,
        mustDisambiguate: this.hasConflictingMediaDestination(
          path.join(targetRoot, artistFolder, `${renderedTrackPath}${ext}`),
          providerId,
          "track",
        ),
      });

      const dest = path.join(targetRoot, artistFolder, `${relativeTrackPath}${ext}`);
      this.moveFileCrossDevice(src, dest);

      for (const lyricExtension of LYRIC_SIDECAR_EXTENSIONS) {
        const srcLyricFile = src.replace(new RegExp(`\\${ext}$`, "i"), lyricExtension);
        const destLyricFile = dest.replace(new RegExp(`\\${ext}$`, "i"), lyricExtension);
        if (fs.existsSync(srcLyricFile)) {
          this.moveFileCrossDevice(srcLyricFile, destLyricFile);
        }
      }

      // Fingerprinting and embedded tags are applied by the post-organize
      // import finalizer after MusicBrainz identity is resolved.
      const fileFingerprint: string | null = null;
      // Batch all per-track DB writes in a single transaction.
      let importedTrackFileId: number | null = null;
      db.transaction(() => {
        const libraryFileId = this.upsertLibraryFile({
          artistId,
          albumId: libraryAlbumId,
          mediaId: providerId,
          filePath: dest,
          libraryRoot: targetRoot,
          fileType: "track",
          quality: derivedQuality,
          namingTemplate: trackNamingTemplate,
          expectedPath: dest,
          bitDepth: metrics.bitDepth,
          sampleRate: metrics.sampleRate,
          bitrate: metrics.bitrate,
          codec: metrics.codec,
          channels: metrics.channels,
          duration: metrics.duration,
          provider: trackIdentity.provider,
          providerEntityType: trackIdentity.providerEntityType,
          providerId: trackIdentity.providerId,
          librarySlot: trackIdentity.librarySlot,
          canonicalArtistMbid: trackIdentity.canonicalArtistMbid,
          canonicalReleaseGroupMbid: trackIdentity.canonicalReleaseGroupMbid,
          canonicalReleaseMbid: trackIdentity.canonicalReleaseMbid,
          canonicalTrackMbid: trackIdentity.canonicalTrackMbid,
          canonicalRecordingMbid: trackIdentity.canonicalRecordingMbid,
          fingerprint: fileFingerprint
        });
        importedTrackFileId = libraryFileId;

        try {
          recordHistoryEvent({
            artistId,
            albumId: libraryAlbumId,
            mediaId: providerId,
            libraryFileId,
            eventType: HISTORY_EVENT_TYPES.TrackFileImported,
            quality: derivedQuality,
            sourceTitle: trackTitle,
            data: {
              importedPath: dest,
            },
          });
        } catch (historyError) {
          console.warn(`[Organizer] Failed to record track import history for ${providerId}:`, historyError);
        }

        // Keep the track branch aligned with album/video organization so quality
        // changes replace the previous file instead of leaving duplicates behind.
        this.cleanupOldMediaFiles(providerId, dest, "track", trackIdentity.librarySlot ?? null, streamingProviderId);
        this.cleanupSiblingMediaVariants(dest, "track");
      })();

      if (metadataConfig.save_lyrics) {
        try {
          const lyricPath = this.relocateLinkedSidecar({
            artistId,
            albumId: libraryAlbumId,
            mediaId: providerId,
            mediaPath: dest,
            libraryRoot: targetRoot,
            fileType: "lyrics",
            quality: trackRow?.quality || album.quality,
          });
          // See the album path above: imports only relocate sidecars already
          // delivered with the media. Network metadata enrichment is handled
          // by the library-metadata backfill so a slow/missing lyric cannot block the
          // download queue.
          if (fs.existsSync(lyricPath)) {
            this.upsertLibraryFile({
              artistId,
              albumId: libraryAlbumId,
              mediaId: providerId,
              trackFileId: importedTrackFileId,
              filePath: lyricPath,
              libraryRoot: targetRoot,
              fileType: "lyrics",
              quality: trackRow?.quality || album.quality,
              namingTemplate: null,
              expectedPath: lyricPath,
              provider: trackIdentity.provider,
              providerEntityType: "track",
              providerId,
              librarySlot: trackIdentity.librarySlot,
              canonicalArtistMbid: trackIdentity.canonicalArtistMbid,
              canonicalReleaseGroupMbid: trackIdentity.canonicalReleaseGroupMbid,
              canonicalReleaseMbid: trackIdentity.canonicalReleaseMbid,
              canonicalTrackMbid: trackIdentity.canonicalTrackMbid,
              canonicalRecordingMbid: trackIdentity.canonicalRecordingMbid,
            });
          }
        } catch (error) {
          console.warn(`[Organizer] Failed to save or track lyrics for ${providerId}:`, error);
        }
      }

      // Extras (cover, artist picture, NFO) - ensure they exist when downloading individual tracks.
      const artistDir = path.join(targetRoot, artistFolder);
      this.ensureDir(artistDir);
      const artistPicPath = path.join(artistDir, metadataConfig.artist_picture_name || "folder.jpg");
      if (metadataConfig.save_artist_picture) {
        this.relocateSingletonSidecar({
          artistId,
          expectedPath: artistPicPath,
          libraryRoot: targetRoot,
          fileType: "cover",
        });
      }
      if (metadataConfig.save_artist_picture) {
        // Saved sidecar artwork always uses the highest available resolution,
        // independent of metadata.artist_picture_resolution (which only caps
        // the UI's cached display thumbnail — see media-cover-service.ts).
        // Artwork is a backfillable sidecar: its fetch must NEVER fail an import
        // whose audio is already organized + tracked. The default provider may
        // not even carry this album (e.g. an Apple-only id), and the scheduled
        // library-metadata backfill retries missing artwork later.
        try {
          await downloadArtistPicture(artistId, "origin", artistPicPath);
          if (fs.existsSync(artistPicPath)) {
            this.upsertLibraryFile({
              artistId,
              albumId: null,
              mediaId: null,
              filePath: artistPicPath,
              libraryRoot: targetRoot,
              fileType: "cover",
              quality: null,
              namingTemplate: null,
              expectedPath: artistPicPath,
            });
          }
        } catch (error) {
          console.warn(`[Organizer] Failed to fetch artist picture for ${artistId}; import already complete:`, error);
        }
      }

      const albumDirRelative = deriveAlbumDirRelativeFromTrackPath(trackTemplate, relativeTrackPath);
      const targetAlbumDir = path.join(targetRoot, artistFolder, albumDirRelative);
      this.ensureDir(targetAlbumDir);

      const albumCoverPath = path.join(targetAlbumDir, metadataConfig.album_cover_name || "cover.jpg");
      if (metadataConfig.save_album_cover) {
        this.relocateSingletonSidecar({
          artistId,
          albumId: libraryAlbumId,
          expectedPath: albumCoverPath,
          libraryRoot: targetRoot,
          fileType: "cover",
        });
      }
      if (metadataConfig.save_album_cover) {
        // Saved sidecar artwork always uses the highest available resolution,
        // independent of metadata.album_cover_resolution (which only caps the
        // UI's cached display thumbnail — see media-cover-service.ts).
        await downloadAlbumCover(libraryAlbumId, "origin", albumCoverPath, { provider: streamingProviderId });
        if (fs.existsSync(albumCoverPath)) {
          this.upsertLibraryFile({
            artistId,
            albumId: libraryAlbumId,
            mediaId: null,
            filePath: albumCoverPath,
            libraryRoot: targetRoot,
            fileType: "cover",
            quality: null,
            namingTemplate: null,
            expectedPath: albumCoverPath,
          });
        }
      }

      const albumVideoCoverName = getAlbumVideoCoverName(metadataConfig.album_cover_name || "cover.jpg");
      const albumVideoCoverPath = path.join(targetAlbumDir, albumVideoCoverName);
      const albumVideoCoverId = metadataConfig.save_album_cover
        ? await resolveAlbumVideoCoverForLibrary({
            storedVideoCover: canonicalAlbum?.videoCover || null,
            provider: streamingProviderId,
            providerAlbumId: albumId,
            releaseGroupMbid: trackIdentity.canonicalReleaseGroupMbid || album.mb_release_group_id || null,
          })
        : null;
      if (metadataConfig.save_album_cover && albumVideoCoverId) {
        this.relocateSingletonSidecar({
          artistId,
          albumId: libraryAlbumId,
          expectedPath: albumVideoCoverPath,
          libraryRoot: targetRoot,
          fileType: "video_cover",
        });
      }
      if (metadataConfig.save_album_cover && albumVideoCoverId && !fs.existsSync(albumVideoCoverPath)) {
        // Saved sidecar artwork always uses the highest available resolution,
        // independent of metadata.album_cover_resolution (which only caps the
        // UI's cached display thumbnail — see media-cover-service.ts).
        try {
          await downloadAlbumVideoCover(String(albumVideoCoverId), "origin", albumVideoCoverPath, {
            provider: streamingProviderId,
            providerAlbumId: albumId,
            releaseGroupMbid: trackIdentity.canonicalReleaseGroupMbid || album.mb_release_group_id || null,
          });
          if (fs.existsSync(albumVideoCoverPath)) {
            this.upsertLibraryFile({
              artistId,
              albumId: libraryAlbumId,
              mediaId: null,
              filePath: albumVideoCoverPath,
              libraryRoot: targetRoot,
              fileType: "video_cover",
              quality: null,
              namingTemplate: null,
              expectedPath: albumVideoCoverPath,
            });
          }
        } catch (error) {
          console.warn(`[Organizer] Failed to fetch album video cover for ${libraryAlbumId}; import already complete:`, error);
        }
      }

      if (metadataConfig.save_nfo) {
        const artistNfoPath = path.join(artistDir, "artist.nfo");
        const albumNfoPath = path.join(targetAlbumDir, "album.nfo");
        try {
          await saveArtistNfoFile(artistId, artistNfoPath);
          this.upsertLibraryFile({
            artistId,
            albumId: null,
            mediaId: null,
            filePath: artistNfoPath,
            libraryRoot: targetRoot,
            fileType: "nfo",
            quality: null,
            namingTemplate: null,
            expectedPath: artistNfoPath,
          });
        } catch (error) {
          console.warn(`[Organizer] Failed to write artist NFO for ${artistId}:`, error);
        }

        try {
          await saveAlbumNfoFile(libraryAlbumId, albumNfoPath);
          this.upsertLibraryFile({
            artistId,
            albumId: libraryAlbumId,
            mediaId: null,
            filePath: albumNfoPath,
            libraryRoot: targetRoot,
            fileType: "nfo",
            quality: null,
            namingTemplate: null,
            expectedPath: albumNfoPath,
          });
        } catch (error) {
          console.warn(`[Organizer] Failed to write album NFO for ${libraryAlbumId}:`, error);
        }
      }

      onProgress?.({
        phase: "finalizing",
        currentFileNum: 1,
        totalFiles: 1,
        currentTrack: trackTitle,
        statusMessage: `Finalizing ${trackTitle}`,
      });

      if (
        importedTrackFileId != null
        && (trackIdentity.librarySlot ?? (isSpatial ? "spatial" : "stereo")) === "stereo"
      ) {
        try {
          const { RenameTrackFileService } = await import("./rename-track-file-service.js");
          RenameTrackFileService.relocateRelatedInlineVideosForImportedAudio([importedTrackFileId]);
        } catch (error) {
          console.warn(`[Organizer] Failed to relocate related inline videos after track import:`, error);
        }
      }

      // Return result for track
      return {
        type: "track",
        providerId,
        processedTrackIds: [providerId],
        totalTracksInStaging: 1,
      };
    }

    if (type === "video") {
      const allFiles = this.findFilesRecursively(downloadPath);
      const src =
        allFiles.find(f => path.basename(f, path.extname(f)) === providerId) ||
        (allFiles.length === 1 ? allFiles[0] : null) ||
        allFiles.find(f => path.basename(f).includes(providerId));
      if (!src) {
        if (allFiles.length === 0) {
          throw new Error(`Download failed: No files were downloaded. The video might be unavailable or DRM protected.`);
        }
        throw new Error(`Download failed: Could not locate video file in downloaded files.`);
      }

      // Ensure the video is in the canonical graph: a Recordings(is_video=1) row +
      // a ProviderItems video offer, via RefreshVideoService — no legacy ProviderMedia.
      const videoData = await this.fetchProviderVideo(providerId, streamingProviderId);
      const fetchedVideoData: any | null = videoData;
      const videoProvider = streamingProviderId;

      // Prefer a real provider title over an empty/placeholder payload so
      // filenames never stick on "Unknown Video" when the download source
      // (or a peer ProviderItems row) already knows the name.
      const resolvedVideoTitle = resolveOrganizeVideoTitle(videoProvider, providerId, videoData);
      if (videoData && resolvedVideoTitle !== "Unknown Video") {
        videoData.title = resolvedVideoTitle;
      }

      // Try to find the canonical local artist id via the DB
      let canonicalArtistId = resolveCanonicalVideoArtistId(videoProvider, providerId);
      
      if (!canonicalArtistId) {
        // Fallback: look up ProviderItems artist_mbid directly
        const piRow = db.prepare(`
          SELECT 
            COALESCE(
              (SELECT id FROM Artists WHERE mbid = pi.artist_mbid LIMIT 1),
              (SELECT id FROM Artists WHERE id = pi.artist_mbid LIMIT 1)
            ) as artist_id
          FROM ProviderItems pi
          WHERE pi.provider = ? AND pi.entity_type = 'video' AND pi.provider_id = ?
          LIMIT 1
        `).get(videoProvider, providerId) as any;
        if (piRow?.artist_id) {
          canonicalArtistId = String(piRow.artist_id);
        }
      }

      // If still missing, we need the provider artist ID to potentially create a local row
      const providerArtistId = String(videoData?.artist?.providerId || videoData?.artist?.id || videoData?.artist_id || "");

      if (!canonicalArtistId && providerArtistId) {
          // See if we have an artist provider item
          const artistPiRow = db.prepare(`SELECT artist_id FROM ProviderItems WHERE provider = ? AND provider_id = ? AND entity_type = 'artist' LIMIT 1`).get(videoProvider, providerArtistId) as any;
          if (artistPiRow?.artist_id) {
             canonicalArtistId = String(artistPiRow.artist_id);
          }
      }

      if (!canonicalArtistId && providerArtistId) {
          // Last resort: create a new canonical local artist
          const a = await this.fetchProviderArtist(providerArtistId, streamingProviderId);
          if (a) {
              const insertResult = db.prepare("INSERT INTO Artists (name, picture, popularity, monitored, path) VALUES (?, ?, ?, 0, 'temp') RETURNING id").get(a.name, a.picture || null, a.popularity || 0) as any;
              if (insertResult?.id) {
                  canonicalArtistId = String(insertResult.id);
                  const newPath = resolveArtistFolderForPersistence({
                      artistId: canonicalArtistId,
                      artistName: a.name,
                  });
                  db.prepare("UPDATE Artists SET path = ? WHERE id = ?").run(newPath, canonicalArtistId);
                  
                  // Also record the provider item so we don't recreate
                  db.prepare("INSERT OR IGNORE INTO ProviderItems (provider, entity_type, provider_id, artist_id, title) VALUES (?, 'artist', ?, ?, ?)").run(videoProvider, providerArtistId, canonicalArtistId, a.name);
              }
          }
      }

      if (!canonicalArtistId) {
        throw new Error(`[Organizer] Video ${providerId} missing valid artist_id connection`);
      }

      const resolvedVideoArtistId = canonicalArtistId;

      const { RefreshVideoService } = await import("../music/refresh-video-service.js");
      RefreshVideoService.upsertArtistVideos(resolvedVideoArtistId, [{
        ...videoData,
        provider_id: providerId,
        provider: videoProvider,
      }]);

      const catalogVideo = lookupCatalogVideoAfterUpsert(videoProvider, providerId);

      const video: any = {
        id: providerId,
        artist_id: resolvedVideoArtistId,
        album_id: videoData?.album?.providerId || videoData?.album_id || null,
        title: catalogVideo?.title || resolvedVideoTitle,
        video_variant: catalogVideo?.video_variant || null,
        explicit: videoData.explicit ? 1 : 0,
        quality: videoData.quality || null,
      };

      onProgress?.({
        phase: "importing",
        currentFileNum: 0,
        totalFiles: 1,
        currentTrack: video.title,
        statusMessage: "Importing downloaded video",
      });

      const artistId = String(video.artist_id);
      const existingArtist = db.prepare(`
        SELECT a.name, a.mbid, a.path, mba.genres
        FROM Artists a
        LEFT JOIN ArtistMetadata mba ON mba.mbid = a.mbid
        WHERE a.id = ?
      `).get(artistId) as any;
      let artistName = existingArtist?.name as string | undefined;
      const artistMbId = existingArtist?.mbid ? String(existingArtist.mbid) : "";
      let artistPath = String(existingArtist?.path || "").trim();
      if (!artistName) {
        const remoteArtist = await this.fetchProviderArtist(artistId, streamingProviderId);
        const fetchedArtistName = remoteArtist.name || "Unknown Artist";
        artistName = fetchedArtistName;
        artistPath = resolveArtistFolderForPersistence({
          artistId,
          artistName: fetchedArtistName,
          artistMbId: artistMbId || null,
        });
        db.prepare("INSERT OR IGNORE INTO artists (id, name, picture, popularity, monitored, path) VALUES (?, ?, ?, ?, 0, ?)")
          .run(artistId, artistName, remoteArtist.picture || null, remoteArtist.popularity || 0, artistPath);
      }
      this.refreshArtistPathFromTemplateIfNeeded(artistId);
      artistPath = String((db.prepare("SELECT path FROM Artists WHERE id = ?").get(artistId) as { path?: string | null } | undefined)?.path || "").trim();

      const resolvedArtistName = artistName || "Unknown Artist";
      const naming = getNamingConfig();
      const artistFolder = resolveArtistFolderFromRecord({
        name: resolvedArtistName,
        mbid: artistMbId || null,
        path: artistPath || null,
      });
      const videoNamingTemplate = path.join(artistFolder, naming.video_file);

      const ext = path.extname(src);
      const sourceMetrics = await parseAudioFile(src);
      const sourceVideoQuality = deriveVideoQuality(sourceMetrics) ?? video.quality ?? null;
      const separatedDestName = `${renderFileStem(naming.video_file, {
        provider: videoProvider,
        artistName: resolvedArtistName,
        artistId,
        artistMbId,
        artistGenre: firstGenre(existingArtist?.genres),
        trackId: providerId,
        videoId: providerId,
        videoTitle: video.title,
        videoType: resolveVideoTypeSuffix(video.title, video.video_variant),
        explicit: video.explicit === 1,
        quality: sourceVideoQuality,
        codec: sourceMetrics.codec || null,
        bitrate: sourceMetrics.bitrate || null,
        sampleRate: sourceMetrics.sampleRate || null,
        bitDepth: sourceMetrics.bitDepth || null,
        channels: sourceMetrics.channels || null,
      })}.mp4`;
      const separatedDest = path.join(videoRoot, artistFolder, separatedDestName);
      const inlineExpected = LibraryFilesService.computeExpectedPath({
        id: -1,
        artist_id: artistId as unknown as number,
        album_id: video.album_id ? video.album_id as unknown as number : null,
        media_id: providerId as unknown as number,
        file_path: separatedDest,
        relative_path: path.relative(videoRoot, separatedDest),
        library_root: videoRoot,
        file_type: "video",
        extension: "mp4",
        quality: sourceVideoQuality,
        provider: videoProvider,
        provider_entity_type: "video",
        provider_id: providerId,
      });
      const dest = inlineExpected.expectedPath || separatedDest;
      const organizedVideoRoot = this.resolveLibraryRoot(dest) || videoRoot;
      if (this.resolvePrimaryVideoDestinationConflict({
        destPath: dest,
        incomingProvider: videoProvider,
        incomingProviderId: providerId,
        incomingQuality: sourceVideoQuality,
      }) === "skip") {
        try { fs.rmSync(src, { force: true }); } catch (e) {
          console.warn("Failed to delete skipped video source", e);
        }
        return {
          type: "video",
          providerId,
          processedTrackIds: [],
          totalTracksInStaging: 1,
        };
      }
      this.ensureDir(path.dirname(dest));

      // Convert to MP4 directly from source into destination if not already MP4
      if (ext !== '.mp4') {
        console.log(`[Organizer] Converting video ${src} to ${dest}...`);
        const success = await convertToMp4(src, dest);
        if (!success) {
          throw new Error(`[Organizer] MP4 conversion failed for ${src}`);
        }
        // Cleanup the parsed source TS/MKV file if successful
        try { fs.rmSync(src, { force: true }); } catch (e) { console.warn('Failed to delete source video', e); }
      } else {
        this.moveFileCrossDevice(src, dest);
      }

      // Analyze file quality/resolution from the actual downloaded file.
      const metrics = await parseAudioFile(dest);
      const derivedVideoQuality = deriveVideoQuality(metrics) ?? video.quality ?? null;
      const videoIdentity = resolveLibraryFileIdentity({
        artistId,
        albumId: video.album_id ? String(video.album_id) : null,
        mediaId: providerId,
        libraryRoot: organizedVideoRoot,
        fileType: "video",
        quality: derivedVideoQuality,
        provider: videoProvider,
        providerEntityType: "video",
        providerId,
      });

      // Batch all per-video DB writes in a single transaction.
      let libraryFileId: number | null = null;
      db.transaction(() => {
        libraryFileId = this.upsertLibraryFile({
          artistId,
          albumId: video.album_id ? String(video.album_id) : null,
          mediaId: providerId,
          filePath: dest,
          libraryRoot: organizedVideoRoot,
          fileType: "video",
          quality: derivedVideoQuality,
          namingTemplate: videoNamingTemplate,
          expectedPath: dest,
          bitDepth: metrics.bitDepth,
          sampleRate: metrics.sampleRate,
          bitrate: metrics.bitrate,
          codec: metrics.codec,
          videoCodec: metrics.videoCodec,
          channels: metrics.channels,
          width: metrics.width,
          height: metrics.height,
          provider: videoIdentity.provider,
          providerEntityType: videoIdentity.providerEntityType,
          providerId: videoIdentity.providerId,
          librarySlot: videoIdentity.librarySlot,
          canonicalArtistMbid: videoIdentity.canonicalArtistMbid,
          canonicalReleaseGroupMbid: videoIdentity.canonicalReleaseGroupMbid,
          canonicalReleaseMbid: videoIdentity.canonicalReleaseMbid,
          canonicalTrackMbid: videoIdentity.canonicalTrackMbid,
          canonicalRecordingMbid: videoIdentity.canonicalRecordingMbid,
        });

        try {
          recordHistoryEvent({
            artistId,
            albumId: video.album_id ? String(video.album_id) : null,
            mediaId: providerId,
            libraryFileId,
            eventType: HISTORY_EVENT_TYPES.TrackFileImported,
            quality: derivedVideoQuality,
            sourceTitle: video.title,
            data: {
              importedPath: dest,
            },
          });
        } catch (historyError) {
          console.warn(`[Organizer] Failed to record video import history for ${providerId}:`, historyError);
        }

        // Clean up any other old files for this video (handles extension changes beyond .ts → .mp4)
        this.cleanupOldMediaFiles(providerId, dest, "video", videoIdentity.librarySlot ?? null, videoProvider);
        this.cleanupSiblingMediaVariants(dest, "video");
      })();

      await this.ensureVideoThumbnailSidecar({
        artistId,
        albumId: video.album_id ? String(video.album_id) : null,
        mediaId: providerId,
        mediaPath: dest,
        libraryRoot: organizedVideoRoot,
        provider: videoProvider,
        providerId,
        quality: derivedVideoQuality,
        namingTemplate: videoNamingTemplate,
        coverHint: video.cover || fetchedVideoData?.cover || fetchedVideoData?.image_id || null,
        libraryFileId,
      });

      if (metadataConfig.save_nfo) {
        const videoNfoPath = path.join(path.dirname(dest), `${path.parse(dest).name}.nfo`);
        try {
          await saveVideoNfoFile(providerId, videoNfoPath);
          this.upsertLibraryFile({
            artistId,
            albumId: video.album_id ? String(video.album_id) : null,
            mediaId: providerId,
            filePath: videoNfoPath,
            libraryRoot: organizedVideoRoot,
            fileType: "nfo",
            quality: derivedVideoQuality,
            namingTemplate: videoNamingTemplate,
            expectedPath: videoNfoPath,
          });
        } catch (error) {
          console.warn(`[Organizer] Failed to write video NFO for ${providerId}:`, error);
        }
      }

      onProgress?.({
        phase: "finalizing",
        currentFileNum: 1,
        totalFiles: 1,
        currentTrack: video.title,
        statusMessage: `Finalizing ${video.title}`,
      });

      // Return result for video
      return {
        type: "video",
        providerId,
        processedTrackIds: [providerId],
        totalTracksInStaging: 1,
      };
    }

    // Fallback for any unhandled type (shouldn't happen)
    throw new Error(`[Organizer] Unhandled type: ${type}`);
  }
}
