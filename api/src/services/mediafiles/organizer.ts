import fs from "fs";
import path from "path";
import { execFileSync, execSync } from "child_process";
import * as mm from "music-metadata";
import { db } from "../../database.js";
import { Config } from "../config/config.js";
import { downloadAlbumCover, downloadAlbumVideoCover, downloadArtistPicture, downloadVideoThumbnail, saveAlbumNfoFile, saveArtistNfoFile, saveLyricsFile, saveVideoNfoFile } from "./metadata-files.js";
import { streamingProviderManager } from "../providers/index.js";
import { getNamingConfig, renderFileStem, renderRelativePath, resolveArtistFolderFromRecord } from "../config/naming.js";
import { resolveArtistFolderForIdentityUpdate, resolveArtistFolderForPersistence, shouldReapplyArtistPathTemplate } from "../music/artist-paths.js";
import { parseAudioFile, deriveQuality, deriveVideoQuality, convertToMp4, embedVideoThumbnail } from "./audioUtils.js";
import { LibraryFilesService, removeEmptyParents } from "./library-files.js";
import { resolveLibraryRootPath, resolveStoredLibraryPath } from "./library-paths.js";
import { getDownloadWorkspacePath } from "../download/download-routing.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "../commands/history-events.js";
import { MoveArtistService } from "./move-artist-service.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";
import { renderAudioRelativePathForLibrary } from "./audio-library-path.js";
import { resolveLibraryFileIdentity } from "./library-file-identity.js";
import { getCanonicalTrackPosition, resolveCanonicalTrackPosition } from "../metadata/canonical-track-position.js";
import { getCanonicalAlbumMetadata } from "../metadata/canonical-album-metadata.js";
import { chooseCachedAlbumArtwork } from "../metadata/media-cover-service.js";


type OrganizeType = "album" | "track" | "video";

type OrganizeRequest = {
  type: OrganizeType | string;
  providerId?: string;
  provider?: string | null;
  releaseGroupMbid?: string | null;
  releaseMbid?: string | null;
  albumId?: string | null;
  slot?: string | null;
  downloadPath?: string;
  onProgress?: (progress: {
    phase: "importing" | "finalizing";
    currentFileNum?: number;
    totalFiles?: number;
    currentTrack?: string;
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

type AlbumTrackRow = {
  id: string | number;
  provider_id?: string | null;
  title: string;
  version: string | null;
  track_number: number | null;
  volume_number: number | null;
  isrc: string | null;
  track_mbid?: string | null;
  recording_mbid?: string | null;
};

type MatchedAlbumTrackRow = {
  id: string | number;
  album_id: string | number | null;
  artist_id: string | number | null;
  title: string | null;
  version: string | null;
  explicit: number | null;
  quality: string | null;
  track_number: number | null;
  volume_number: number | null;
  mbid: string | null;
  canonical_track_mbid: string | null;
  canonical_recording_mbid: string | null;
};

type StagedAudioMetadata = {
  title?: string;
  trackNumber?: number;
  volumeNumber?: number;
  isrc?: string;
};

type OrganizerArtistContext = {
  artistId: string;
  artistName: string;
  artistMbId: string;
  artistPath: string;
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

const getAlbumVideoCoverName = (albumCoverName: string) => {
  const parsedName = path.parse(albumCoverName);
  return `${parsedName.name}.mp4`;
};

export class OrganizerService {
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

  private static async fetchProviderArtist(artistId: string): Promise<any> {
    const artist = await streamingProviderManager.getDefaultStreamingProvider().getArtist(artistId);
    return artist?.raw || artist;
  }

  private static async fetchProviderTrack(trackId: string): Promise<any> {
    const track = await streamingProviderManager.getDefaultStreamingProvider().getTrack(trackId);
    return track?.raw || track;
  }

  private static async fetchProviderVideo(videoId: string): Promise<any> {
    const provider = streamingProviderManager.getDefaultStreamingProvider();
    if (!provider.getVideo) {
      throw new Error(`${provider.name} does not support video metadata`);
    }
    const video = await provider.getVideo(videoId);
    return video?.raw || video;
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
            mba.disambiguation
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
          mba.disambiguation
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
            mba.disambiguation
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
    };
  }

  private static sanitizeFilename(name: string): string {
    return (name || "Unknown").replace(/[<>:"/\\|?*]/g, "").trim();
  }

  private static normalizeMatchText(value: string | null | undefined): string {
    return (value || "")
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private static parseJsonObject(value: unknown): Record<string, any> {
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

  private static buildTrackMatchTitles(track: AlbumTrackRow): string[] {
    const titles = new Set<string>();
    const baseTitle = this.normalizeMatchText(track.title);
    if (baseTitle) {
      titles.add(baseTitle);
    }

    if (track.version) {
      const combined = this.normalizeMatchText(`${track.title} ${track.version}`);
      if (combined) {
        titles.add(combined);
      }
      const parenthesized = this.normalizeMatchText(`${track.title} (${track.version})`);
      if (parenthesized) {
        titles.add(parenthesized);
      }
    }

    return Array.from(titles);
  }

  private static async readStagedAudioMetadata(filePath: string): Promise<StagedAudioMetadata> {
    try {
      const metadata = await mm.parseFile(filePath, { duration: false, skipCovers: true });
      const common = metadata.common;
      return {
        title: common.title || undefined,
        trackNumber: typeof common.track?.no === "number" ? common.track.no : undefined,
        volumeNumber: typeof common.disk?.no === "number" ? common.disk.no : undefined,
        isrc: Array.isArray(common.isrc) ? common.isrc[0] : common.isrc || undefined,
      };
    } catch {
      return {};
    }
  }

  private static parseNumericTrackPositionFromPath(filePath: string): {
    trackNumber?: number;
    volumeNumber?: number;
  } {
    const baseName = path.basename(filePath, path.extname(filePath));
    if (!/^\d+$/.test(baseName)) {
      return {};
    }

    const parentDir = path.basename(path.dirname(filePath));
    const cdMatch = parentDir.match(/^CD\s+(\d+)$/i);
    if (cdMatch) {
      return {
        trackNumber: Number(baseName),
        volumeNumber: Number(cdMatch[1]),
      };
    }

    return {
      trackNumber: Number(baseName),
      volumeNumber: 1,
    };
  }

  private static findTrackMatchByMetadata(
    metadata: StagedAudioMetadata,
    unmatchedTracks: AlbumTrackRow[],
  ): AlbumTrackRow | null {
    const normalizedIsrc = metadata.isrc?.trim().toUpperCase();
    if (normalizedIsrc) {
      const isrcMatch = unmatchedTracks.find((track) => track.isrc?.trim().toUpperCase() === normalizedIsrc);
      if (isrcMatch) {
        return isrcMatch;
      }
    }

    const normalizedTitle = this.normalizeMatchText(metadata.title);
    const trackNumber = metadata.trackNumber;
    const volumeNumber = metadata.volumeNumber ?? 1;

    const positionedCandidates = typeof trackNumber === "number"
      ? unmatchedTracks.filter((track) =>
        Number(track.track_number || 0) === trackNumber
        && Number(track.volume_number || 1) === volumeNumber,
      )
      : [];

    if (positionedCandidates.length === 1) {
      // A track that was also released as a standalone single carries an
      // embedded trackNumber of 1. Trusting position alone would map it onto
      // the album's real track 1 (e.g. an "Intro") and collide. Only accept the
      // positional candidate when we have no title to check or the title agrees;
      // otherwise fall through to title-based matching below.
      if (!normalizedTitle || this.buildTrackMatchTitles(positionedCandidates[0]).includes(normalizedTitle)) {
        return positionedCandidates[0];
      }
    }

    if (positionedCandidates.length > 1 && normalizedTitle) {
      const titledCandidate = positionedCandidates.find((track) => this.buildTrackMatchTitles(track).includes(normalizedTitle));
      if (titledCandidate) {
        return titledCandidate;
      }
    }

    if (normalizedTitle) {
      const titleCandidates = unmatchedTracks.filter((track) => this.buildTrackMatchTitles(track).includes(normalizedTitle));
      if (titleCandidates.length === 1) {
        return titleCandidates[0];
      }
    }

    return null;
  }

  private static resolveCanonicalAlbumImportContext(raw: OrganizeRequest, providerAlbumId: string): CanonicalAlbumImportContext | null {
    const provider = String(raw.provider || "").trim() || "tidal";
    const releaseGroupMbid = String(raw.releaseGroupMbid || raw.albumId || "").trim();
    const requestedSlot = String(raw.slot || "").trim().toLowerCase();
    const row = db.prepare(`
      SELECT
        COALESCE(rgs.selected_provider, pi.provider, ?) AS provider,
        COALESCE(rgs.selected_provider_id, pi.provider_id, ?) AS providerAlbumId,
        COALESCE(rgs.release_group_mbid, pi.release_group_mbid, rg.mbid) AS releaseGroupMbid,
        COALESCE(rgs.selected_release_mbid, pi.release_mbid, ?) AS releaseMbid,
        COALESCE(rgs.slot, pi.library_slot, ?) AS slot,
        COALESCE(rgs.quality, pi.quality) AS quality,
        rg.title,
        rg.artist_mbid AS artistMbid,
        am.name AS artistName,
        COALESCE(json_extract(rgs.provider_data, '$.cover'), json_extract(pi.data, '$.cover')) AS providerCover,
        json_extract(rgs.provider_data, '$.video_cover') AS videoCover,
        selected_release.date AS releaseDate,
        rg.primary_type AS albumType,
        (
          SELECT COUNT(DISTINCT media.position)
          FROM AlbumReleaseMedia media
          WHERE media.release_mbid = COALESCE(rgs.selected_release_mbid, pi.release_mbid, ?)
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
      LEFT JOIN Albums rg ON rg.mbid = COALESCE(rgs.release_group_mbid, pi.release_group_mbid, ?)
      LEFT JOIN ArtistMetadata am ON am.mbid = rg.artist_mbid
      LEFT JOIN AlbumReleases selected_release ON selected_release.mbid = COALESCE(rgs.selected_release_mbid, pi.release_mbid, ?)
      WHERE pi.provider = ?
        AND pi.entity_type = 'album'
        AND pi.provider_id = ?
        AND (? = '' OR pi.release_group_mbid = ? OR rgs.release_group_mbid = ?)
      ORDER BY
        CASE WHEN rgs.slot = ? THEN 0 ELSE 1 END,
        pi.updated_at DESC
      LIMIT 1
    `).get(
      provider,
      providerAlbumId,
      raw.releaseMbid || null,
      requestedSlot || "stereo",
      raw.releaseMbid || null,
      requestedSlot,
      requestedSlot,
      releaseGroupMbid || null,
      raw.releaseMbid || null,
      provider,
      providerAlbumId,
      releaseGroupMbid,
      releaseGroupMbid,
      releaseGroupMbid,
      requestedSlot || "stereo",
    ) as any;

    if (!row?.releaseGroupMbid && !row?.releaseMbid) {
      return null;
    }

    // Canonical artwork (SkyHook/Cover Art Archive) is stored on Albums.images;
    // the provider cover from the selected offer snapshot is the fallback.
    const canonicalCover = row.releaseGroupMbid
      ? chooseCachedAlbumArtwork({ albumMbid: row.releaseGroupMbid })
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

  private static async matchAlbumFilesToTracks(
    albumId: string,
    files: string[],
    context?: CanonicalAlbumImportContext | null,
  ): Promise<Map<string, string>> {
    const albumIds = albumId.split(";").filter(Boolean);
    if (albumIds.length === 0) {
      return new Map();
    }
    const placeholders = albumIds.map(() => '?').join(', ');
    const trackRows = context?.releaseMbid
      ? db.prepare(`
          SELECT
            COALESCE(pi.provider_id, CAST(t.id AS TEXT)) AS id,
            pi.provider_id,
            COALESCE(pi.title, t.title) AS title,
            pi.version,
            t.position AS track_number,
            t.medium_position AS volume_number,
            COALESCE(pi.isrc, json_extract(r.isrcs, '$[0]')) AS isrc,
            t.mbid AS track_mbid,
            t.recording_mbid
          FROM Tracks t
          LEFT JOIN Recordings r ON r.mbid = t.recording_mbid
          LEFT JOIN ProviderItems pi
            ON pi.provider = ?
           AND pi.entity_type = 'track'
           AND pi.release_mbid = t.release_mbid
           AND pi.library_slot = ?
           AND (
              pi.track_mbid = t.mbid
              OR (
                pi.track_mbid IS NULL
                AND pi.release_group_mbid = ?
                AND json_extract(pi.match_evidence, '$.mediumPosition') = t.medium_position
                AND json_extract(pi.match_evidence, '$.trackPosition') = t.position
              )
           )
          WHERE t.release_mbid = ?
            AND COALESCE(r.is_video, 0) = 0
          ORDER BY t.medium_position, t.position, t.mbid
        `).all(context.provider, context.slot || 'stereo', context.releaseGroupMbid, context.releaseMbid) as AlbumTrackRow[]
      : db.prepare(`
          SELECT
            provider_id AS id,
            title,
            version,
            CAST(json_extract(match_evidence, '$.trackPosition') AS INTEGER) AS track_number,
            CAST(json_extract(match_evidence, '$.mediumPosition') AS INTEGER) AS volume_number,
            isrc
          FROM ProviderItems
          WHERE entity_type = 'track' AND provider_album_id IN (${placeholders})
          ORDER BY volume_number, track_number, provider_id
        `).all(...albumIds) as AlbumTrackRow[];

    const remainingTracks = [...trackRows];
    const matches = new Map<string, string>();

    // 1. Match by provider ID if filename matches ID exactly
    for (const filePath of files) {
      const baseName = path.basename(filePath, path.extname(filePath));
      if (!/^\d+$/.test(baseName)) {
        continue;
      }

      const index = remainingTracks.findIndex((track) => String(track.id) === baseName);
      if (index < 0) {
        continue;
      }

      const [matchedTrack] = remainingTracks.splice(index, 1);
      matches.set(filePath, String(matchedTrack.id));
    }

    // 2. Match by reading actual audio metadata from the files (ISRC, track/volume number, title)
    for (const filePath of files) {
      if (matches.has(filePath)) {
        continue;
      }

      const metadata = await this.readStagedAudioMetadata(filePath);
      const matchedTrack = this.findTrackMatchByMetadata(metadata, remainingTracks);
      if (matchedTrack) {
        const index = remainingTracks.findIndex((track) => track.id === matchedTrack.id);
        if (index >= 0) {
          remainingTracks.splice(index, 1);
        }
        matches.set(filePath, String(matchedTrack.id));
      }
    }

    // 3. Fallback: Match by filename track position/number
    for (const filePath of files) {
      if (matches.has(filePath)) {
        continue;
      }

      const numericPosition = this.parseNumericTrackPositionFromPath(filePath);
      const numericTrackMatch = this.findTrackMatchByMetadata(numericPosition, remainingTracks);
      if (numericTrackMatch) {
        const index = remainingTracks.findIndex((track) => track.id === numericTrackMatch.id);
        if (index >= 0) {
          remainingTracks.splice(index, 1);
        }
        matches.set(filePath, String(numericTrackMatch.id));
      }
    }

    return matches;
  }

  private static resolveMatchedCanonicalAlbumTrackRow(params: {
    provider: string;
    trackId: string;
    releaseMbid: string;
    fallbackAlbumId: string;
    fallbackArtistId: string;
    fallbackQuality: string | null;
  }): MatchedAlbumTrackRow | null {
    const providerTrack = db.prepare(`
      SELECT
        pi.provider_id,
        pi.title,
        pi.version,
        pi.explicit,
        pi.quality,
        pi.album_id,
        pi.track_mbid,
        pi.recording_mbid,
        pi.match_evidence,
        json_extract(pi.match_evidence, '$.albumProviderId') AS evidence_album_id
      FROM ProviderItems pi
      WHERE pi.provider = ?
        AND pi.entity_type = 'track'
        AND pi.provider_id = ?
        AND pi.release_mbid = ?
      LIMIT 1
    `).get(params.provider, params.trackId, params.releaseMbid) as any;

    if (providerTrack) {
      const evidence = this.parseJsonObject(providerTrack.match_evidence);
      const mediumPosition = Number(evidence.mediumPosition || 0);
      const trackPosition = Number(evidence.trackPosition || 0);
      const canonicalTrack = db.prepare(`
        SELECT t.mbid, t.recording_mbid, t.title, t.position, t.medium_position
        FROM Tracks t
        WHERE t.release_mbid = ?
          AND (
            (? IS NOT NULL AND t.mbid = ?)
            OR (
              ? IS NULL
              AND ? > 0
              AND ? > 0
              AND t.medium_position = ?
              AND t.position = ?
            )
          )
        ORDER BY t.medium_position, t.position
        LIMIT 1
      `).get(
        params.releaseMbid,
        providerTrack.track_mbid || null,
        providerTrack.track_mbid || null,
        providerTrack.track_mbid || null,
        mediumPosition,
        trackPosition,
        mediumPosition,
        trackPosition,
      ) as any;

      return {
        id: providerTrack.provider_id || params.trackId,
        album_id: providerTrack.album_id || providerTrack.evidence_album_id || params.fallbackAlbumId,
        artist_id: params.fallbackArtistId,
        title: providerTrack.title || canonicalTrack?.title || null,
        version: providerTrack.version || null,
        explicit: providerTrack.explicit ?? null,
        quality: providerTrack.quality || params.fallbackQuality,
        track_number: canonicalTrack?.position ?? (trackPosition > 0 ? trackPosition : null),
        volume_number: canonicalTrack?.medium_position ?? (mediumPosition > 0 ? mediumPosition : null),
        mbid: providerTrack.recording_mbid || canonicalTrack?.recording_mbid || null,
        canonical_track_mbid: canonicalTrack?.mbid || providerTrack.track_mbid || null,
        canonical_recording_mbid: canonicalTrack?.recording_mbid || providerTrack.recording_mbid || null,
      };
    }

    const canonicalTrack = db.prepare(`
      SELECT
        CAST(t.id AS TEXT) AS id,
        ? AS album_id,
        ? AS artist_id,
        t.title,
        NULL AS version,
        NULL AS explicit,
        ? AS quality,
        t.position AS track_number,
        t.medium_position AS volume_number,
        t.recording_mbid AS mbid,
        t.mbid AS canonical_track_mbid,
        t.recording_mbid AS canonical_recording_mbid
      FROM Tracks t
      WHERE t.release_mbid = ?
        AND CAST(t.id AS TEXT) = ?
      LIMIT 1
    `).get(
      params.fallbackAlbumId,
      params.fallbackArtistId,
      params.fallbackQuality,
      params.releaseMbid,
      params.trackId,
    ) as MatchedAlbumTrackRow | undefined;

    return canonicalTrack || null;
  }

  /**
   * Retroactively prune disabled metadata files (covers, NFO, lyrics, etc.)
   * based on the current configuration.
   */
  public static async pruneDisabledMetadata(): Promise<void> {
    const config = Config.getMetadataConfig();
    console.log('[Organizer] Pruning disabled metadata files...');

    let deletedCount = 0;

    const selectors: Array<string> = [];
    if (!config.save_album_cover) {
      selectors.push("(file_type = 'cover' AND album_id IS NOT NULL)");
      selectors.push("file_type = 'video_cover'");
    }
    if (!config.save_artist_picture) {
      selectors.push("file_type = 'cover' AND album_id IS NULL AND media_id IS NULL");
    }
    if (!config.save_nfo) selectors.push("file_type = 'nfo'");
    if (!config.save_lyrics) selectors.push("file_type = 'lyrics'");
    if (!config.save_video_thumbnail) selectors.push("file_type = 'video_thumbnail'");

    if (selectors.length === 0) {
      console.log('[Organizer] No metadata types are disabled. Pruning skipped.');
      return;
    }

    const filesToPrune = db.prepare(`
      SELECT id, file_path, file_type, library_root
      FROM TrackFiles 
      WHERE ${selectors.join(" OR ")}
    `).all() as { id: number; file_path: string; file_type: string; library_root: string }[];

    if (filesToPrune.length === 0) {
      console.log('[Organizer] No orphaned files found to prune.');
      return;
    }

    // Process deletions
    const deleteStmt = db.prepare(`DELETE FROM TrackFiles WHERE id = ?`);

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
          deleteStmt.run(file.id);
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

  private static commonPathPrefix(paths: string[]): string {
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

  private static deriveAlbumDirRelativeFromTrackPath(trackTemplate: string, relativeTrackPath: string): string {
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
  ) {
    const oldFiles = db.prepare(
      `SELECT id, artist_id, album_id, media_id, file_path, library_root, quality
       FROM TrackFiles
       WHERE media_id = ? AND file_type = ? AND library_slot IS ? AND file_path != ?`
    ).all(mediaId, fileType, librarySlot, newFilePath) as Array<{
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
  ): string {
    if (fileType === "lyrics") {
      return mediaPath.replace(new RegExp(`${path.extname(mediaPath)}$`), ".lrc");
    }

    return path.join(path.dirname(mediaPath), `${path.parse(mediaPath).name}.jpg`);
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
    const expectedPath = this.getExpectedLinkedSidecarPath(params.mediaPath, params.fileType);
    const normalizedExpectedPath = this.normalizeResolvedPath(expectedPath);
    const canonicalIdentity = resolveLibraryFileIdentity({
      artistId: params.artistId,
      albumId: params.albumId || null,
      mediaId: params.mediaId,
      libraryRoot: params.libraryRoot,
      fileType: params.fileType,
      quality: params.quality || null,
    });
    const librarySlot = canonicalIdentity.librarySlot;

    const sidecars = db.prepare(`
      SELECT id, file_path, library_root
      FROM TrackFiles
      WHERE media_id = ? AND file_type = ? AND library_slot IS ?
      ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, verified_at DESC, id DESC
    `).all(params.mediaId, params.fileType, librarySlot, expectedPath) as Array<{
      id: number;
      file_path: string;
      library_root: string;
    }>;

    let hasExpectedSidecar = fs.existsSync(expectedPath);

    for (const sidecar of sidecars) {
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: sidecar.file_path,
        libraryRoot: sidecar.library_root,
      });
      const normalizedResolvedPath = this.normalizeResolvedPath(resolvedFilePath);

      if (!fs.existsSync(resolvedFilePath)) {
        db.prepare("DELETE FROM TrackFiles WHERE id = ?").run(sidecar.id);
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
        DELETE FROM TrackFiles
        WHERE media_id = ? AND file_type = ? AND library_slot IS ? AND file_path != ?
      `).run(params.mediaId, params.fileType, librarySlot, expectedPath);
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
    const scopedRows = params.albumId
      ? db.prepare(`
        SELECT id, file_path, library_root
        FROM TrackFiles
        WHERE artist_id = ?
          AND album_id = ?
          AND media_id IS NULL
          AND COALESCE(library_root, '') = COALESCE(?, '')
          AND file_type = ?
        ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, verified_at DESC, id DESC
      `).all(params.artistId, params.albumId, params.libraryRoot, params.fileType, params.expectedPath)
      : db.prepare(`
        SELECT id, file_path, library_root
        FROM TrackFiles
        WHERE artist_id = ?
          AND album_id IS NULL
          AND media_id IS NULL
          AND COALESCE(library_root, '') = COALESCE(?, '')
          AND file_type = ?
        ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, verified_at DESC, id DESC
      `).all(params.artistId, params.libraryRoot, params.fileType, params.expectedPath);

    let hasExpectedSidecar = fs.existsSync(params.expectedPath);

    for (const sidecar of scopedRows as Array<{ id: number; file_path: string; library_root: string }>) {
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: sidecar.file_path,
        libraryRoot: sidecar.library_root,
      });
      const normalizedResolvedPath = this.normalizeResolvedPath(resolvedFilePath);

      if (!fs.existsSync(resolvedFilePath)) {
        db.prepare("DELETE FROM TrackFiles WHERE id = ?").run(sidecar.id);
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
          DELETE FROM TrackFiles
          WHERE artist_id = ?
            AND album_id = ?
            AND media_id IS NULL
            AND COALESCE(library_root, '') = COALESCE(?, '')
            AND file_type = ?
            AND file_path != ?
        `).run(params.artistId, params.albumId, params.libraryRoot, params.fileType, params.expectedPath);
      } else {
        db.prepare(`
          DELETE FROM TrackFiles
          WHERE artist_id = ?
            AND album_id IS NULL
            AND media_id IS NULL
            AND COALESCE(library_root, '') = COALESCE(?, '')
            AND file_type = ?
            AND file_path != ?
        `).run(params.artistId, params.libraryRoot, params.fileType, params.expectedPath);
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
          `SELECT id, artist_id, album_id, media_id, quality
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
      SELECT media_id
      FROM TrackFiles
      WHERE file_path = ? AND file_type = ?
      LIMIT 1
    `).get(filePath, fileType) as { media_id?: number | string | null } | undefined;

    return !existing || String(existing.media_id ?? "") !== String(mediaId);
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
    channels?: number | null;
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

  private static getReleaseYear(releaseDate: string | null | undefined): string | null {
    if (!releaseDate) return null;
    const match = releaseDate.match(/^(\d{4})/);
    return match ? match[1] : null;
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

    const downloadPath = raw.downloadPath || getDownloadWorkspacePath(type as OrganizeType, providerId);
    const onProgress = raw.onProgress;
    const metadataConfig = Config.getMetadataConfig();

    const musicRoot = Config.getMusicPath();
    const spatialRoot = Config.getSpatialPath();
    const videoRoot = Config.getVideoPath();

    [musicRoot, spatialRoot, videoRoot].forEach((root) => this.ensureDir(root));

    if (type === "album") {
      const albumIds = providerId.split(";").filter(Boolean);
      if (albumIds.length === 0) throw new Error("Missing tidal id");
      const { RefreshAlbumService } = await import("../music/refresh-album-service.js");
      for (const albumIdVal of albumIds) {
        await RefreshAlbumService.scanShallow(albumIdVal);
      }

      const album = db.prepare(`
        SELECT
          artist_mbid AS artist_id,
          release_group_mbid AS mb_release_group_id,
          release_mbid AS mbid,
          quality,
          NULL AS num_volumes
        FROM ProviderItems
        WHERE entity_type = 'album' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(albumIds[0]) as any;
      if (!album) throw new Error(`Album ${albumIds[0]} offer not found in ProviderItems after scan`);

      const canonicalContext = this.resolveCanonicalAlbumImportContext(raw, albumIds[0]);
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
        canonicalReleaseGroupMbid: canonicalContext?.releaseGroupMbid || album.mb_release_group_id,
        canonicalReleaseMbid: canonicalContext?.releaseMbid || album.mbid,
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
      const matchedTrackIdsByFile = await this.matchAlbumFilesToTracks(providerId, audioFiles, canonicalContext);
      if (audioFiles.length > 0 && matchedTrackIdsByFile.size === 0) {
        throw new Error(`[Organizer] Could not match downloaded album files for ${providerId} to Discogenius tracks in ${sourceAlbumDir}`);
      }

      const unmatchedAudioFiles = audioFiles.filter((srcFile) => {
        const ext = path.extname(srcFile).toLowerCase();
        const base = path.basename(srcFile, ext);
        const idFromName = /^\d+$/.test(base) ? base : null;
        const trackId = matchedTrackIdsByFile.get(srcFile) || idFromName;
        if (!trackId) return true;
        if (canonicalContext?.releaseMbid) {
          const trackRow = db.prepare(`
            SELECT 1
            FROM ProviderItems pi
            WHERE pi.provider = ?
              AND pi.entity_type = 'track'
              AND pi.provider_id = ?
              AND pi.release_mbid = ?
            UNION
            SELECT 1
            FROM Tracks t
            WHERE CAST(t.id AS TEXT) = ?
              AND t.release_mbid = ?
            LIMIT 1
          `).get(canonicalContext.provider, trackId, canonicalContext.releaseMbid, trackId, canonicalContext.releaseMbid) as any;
          return !trackRow;
        } else {
          const placeholders = albumIds.map(() => '?').join(', ');
          const trackRow = db.prepare(`SELECT 1 FROM ProviderItems WHERE entity_type = 'track' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT) AND provider_album_id IN (${placeholders}) LIMIT 1`).get(trackId, ...albumIds) as any;
          return !trackRow;
        }
      });

      if (unmatchedAudioFiles.length > 0) {
        throw new Error(
          `[Organizer] Could not match ${unmatchedAudioFiles.length}/${audioFiles.length} downloaded album file(s) for ${providerId}; keeping the download workspace for review.`
        );
      }

      const totalImportableTracks = audioFiles.length;
      onProgress?.({
        phase: "importing",
        currentFileNum: 0,
        totalFiles: totalImportableTracks,
        statusMessage: "Importing downloaded album files",
      });

      const renderedTrackDirs: string[] = [];
      const destFiles: Array<{ trackId: string; destFile: string; ext: string }> = [];
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
        const trackRow = trackId && canonicalContext?.releaseMbid
          ? this.resolveMatchedCanonicalAlbumTrackRow({
              provider: canonicalContext.provider,
              trackId,
              releaseMbid: canonicalContext.releaseMbid,
              fallbackAlbumId: albumIds[0],
              fallbackArtistId: artistId,
              fallbackQuality: canonicalContext.quality || album.quality || null,
            })
          : trackId
            ? (db.prepare(`
                SELECT
                  provider_album_id AS album_id,
                  quality,
                  track_mbid AS canonical_track_mbid,
                  recording_mbid AS canonical_recording_mbid
                FROM ProviderItems
                WHERE entity_type = 'track' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT) AND provider_album_id IN (${placeholders})
                LIMIT 1
              `).get(trackId, ...albumIds) as any)
            : null;

        if (!trackId || !trackRow) {
          continue;
        }

        const canonicalIdentity = resolveLibraryFileIdentity({
          artistId,
          albumId: String(trackRow.album_id || albumIds[0]),
          mediaId: trackId,
          fileType: "track",
          quality: trackRow.quality || album.quality,
          libraryRoot: targetRoot,
          provider: canonicalContext?.provider || raw.provider || "tidal",
          providerEntityType: "track",
          providerId: trackId,
          librarySlot: canonicalContext?.slot || (isSpatial ? "spatial" : "stereo"),
          canonicalArtistMbid: canonicalContext?.artistMbid || artistMbId || null,
          canonicalReleaseGroupMbid: canonicalContext?.releaseGroupMbid || null,
          canonicalReleaseMbid: canonicalContext?.releaseMbid || null,
          canonicalTrackMbid: trackRow.canonical_track_mbid || null,
          canonicalRecordingMbid: trackRow.canonical_recording_mbid || null,
        });
        const canonicalPosition = getCanonicalTrackPosition(canonicalIdentity.canonicalTrackMbid);
        const canonicalAlbum = getCanonicalAlbumMetadata({
          canonicalReleaseGroupMbid: canonicalIdentity.canonicalReleaseGroupMbid,
          canonicalReleaseMbid: canonicalIdentity.canonicalReleaseMbid,
        });
        const trackTitle = canonicalPosition?.title || trackRow.title || "Unknown Track";
        const trackNumber = canonicalPosition?.trackNumber ?? Number(trackRow.track_number || 0);
        const volumeNumber = canonicalPosition?.volumeNumber ?? Number(trackRow.volume_number || 1);
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
          albumTitle: canonicalAlbum?.title || album.title,
          albumId: String(trackRow.album_id || albumIds[0]),
          albumType: canonicalAlbum?.albumType || album.type || album.mb_primary || null,
          albumMbId: canonicalAlbum?.albumMbid || album.mbid || null,
          albumVersion: canonicalAlbum ? null : album.version || null,
          releaseYear: this.getReleaseYear(canonicalAlbum?.releaseDate || album.release_date),
          trackTitle,
          trackId,
          trackMbId: trackRow.mbid || null,
          trackArtistName: resolvedTrackArtistName,
          trackArtistMbId,
          trackVersion: canonicalPosition ? null : trackRow.version || null,
          explicit: trackRow.explicit === 1,
          trackNumber,
          volumeNumber,
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
        this.moveFileCrossDevice(srcFile, destFile);

        // Fingerprinting and embedded tags are applied by the post-organize
        // import finalizer after MusicBrainz identity is resolved.
        const fileFingerprint: string | null = null;

        // Batch all per-track DB writes in a single transaction (Lidarr-style).
        // This reduces ~5-6 auto-commits per track to 1 committed batch.
        const mediaIdStr = trackRow?.id ? String(trackRow.id) : trackId;
        db.transaction(() => {
          const libraryFileId = this.upsertLibraryFile({
            artistId,
            albumId: String(trackRow.album_id || albumIds[0]),
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

          try {
            recordHistoryEvent({
              artistId,
              albumId: String(trackRow.album_id || albumIds[0]),
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
            this.cleanupOldMediaFiles(mediaIdStr, destFile, "track", canonicalIdentity.librarySlot ?? null);
            this.cleanupSiblingMediaVariants(destFile, "track");
          }
        })();

        if (metadataConfig.save_lyrics && trackId) {
          try {
            const lrcPath = this.relocateLinkedSidecar({
              artistId,
              albumId: String(trackRow.album_id || albumIds[0]),
              mediaId: trackId,
              mediaPath: destFile,
              libraryRoot: targetRoot,
              fileType: "lyrics",
              quality: trackRow?.quality || album.quality,
            });
            if (!fs.existsSync(lrcPath)) {
              await saveLyricsFile(trackId, lrcPath);
            }

            if (fs.existsSync(lrcPath)) {
              this.upsertLibraryFile({
                artistId,
                albumId: String(trackRow.album_id || albumIds[0]),
                mediaId: trackId,
                filePath: lrcPath,
                libraryRoot: targetRoot,
                fileType: "lyrics",
                quality: trackRow?.quality || album.quality,
                namingTemplate: null,
                expectedPath: lrcPath,
              });
            }
          } catch {
            // ignore
          }
        }

        destFiles.push({ trackId, destFile, ext });
        onProgress?.({
          phase: "importing",
          currentFileNum: destFiles.length,
          totalFiles: totalImportableTracks,
          currentTrack: trackTitle,
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
        ? this.deriveAlbumDirRelativeFromTrackPath(trackTemplate, sampleRelativeTrackPath)
        : this.commonPathPrefix(renderedTrackDirs);
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
      if (metadataConfig.save_artist_picture && !fs.existsSync(artistPicPath)) {
        const rawResolution = metadataConfig.artist_picture_resolution;
        const parsedResolution = rawResolution === "origin" ? "origin" : Number(rawResolution);
        const safeRes = parsedResolution === "origin" || Number.isFinite(parsedResolution)
          ? parsedResolution
          : 500;
        await downloadArtistPicture(artistId, safeRes, artistPicPath);
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
      if (metadataConfig.save_album_cover && !fs.existsSync(albumCoverPath)) {
        await downloadAlbumCover(albumIds[0], metadataConfig.album_cover_resolution as any, albumCoverPath);
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
      }

      const albumVideoCoverName = getAlbumVideoCoverName(metadataConfig.album_cover_name || "cover.jpg");
      const albumVideoCoverPath = path.join(targetAlbumDir, albumVideoCoverName);
      if (metadataConfig.save_album_cover && album.video_cover) {
        this.relocateSingletonSidecar({
          artistId,
          albumId: albumIds[0],
          expectedPath: albumVideoCoverPath,
          libraryRoot: targetRoot,
          fileType: "video_cover",
        });
      }
      if (metadataConfig.save_album_cover && album.video_cover && !fs.existsSync(albumVideoCoverPath)) {
        await downloadAlbumVideoCover(String(album.video_cover), metadataConfig.album_cover_resolution as any, albumVideoCoverPath);
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

      let expectedTracks = 0;
      try {
        const placeholders = albumIds.map(() => '?').join(', ');
        expectedTracks = Number((db.prepare(`
          SELECT COUNT(*) as count FROM ProviderItems
          WHERE entity_type = 'track' AND provider_album_id IN (${placeholders})
        `).get(...albumIds) as { count?: number } | undefined)?.count || 0);
      } catch (error) {
        console.warn("[Organizer] Failed to query expected track count from ProviderItems:", error);
      }

      return {
        type: "album",
        providerId,
        processedTrackIds: destFiles.map((file) => file.trackId),
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

      const trackData = await this.fetchProviderTrack(providerId);
      onProgress?.({
        phase: "importing",
        currentFileNum: 0,
        totalFiles: 1,
        currentTrack: trackData?.title,
        statusMessage: "Importing downloaded track",
      });
      const albumId = trackData?.album_id ? String(trackData.album_id) : null;
      if (!albumId) throw new Error(`Track ${providerId} missing album_id`);

      // Ensure album + tracks in DB for naming and to locate track metadata.
      const { RefreshAlbumService } = await import("../music/refresh-album-service.js");
      await RefreshAlbumService.scanShallow(albumId);

      const album = db.prepare(`
        SELECT
          artist_mbid AS artist_id,
          release_group_mbid AS mb_release_group_id,
          release_mbid AS mbid,
          quality, title, version, release_date,
          NULL AS num_volumes, NULL AS type, NULL AS mb_primary
        FROM ProviderItems
        WHERE entity_type = 'album' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(albumId) as any;
      if (!album) throw new Error(`Album ${albumId} offer not found in ProviderItems after scan`);

      const trackRow = db.prepare(`
        SELECT
          provider_id AS id,
          provider_album_id AS album_id,
          quality, title,
          track_mbid AS mbid,
          artist_mbid AS artist_id,
          CAST(json_extract(match_evidence, '$.trackPosition') AS INTEGER) AS track_number,
          CAST(json_extract(match_evidence, '$.mediumPosition') AS INTEGER) AS volume_number
        FROM ProviderItems
        WHERE entity_type = 'track' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(providerId) as any;
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

      const isSpatial = isSpatialAudioQuality(album.quality);
      const targetRoot = isSpatial ? spatialRoot : musicRoot;

      const ext = path.extname(src);
      const canonicalPosition = resolveCanonicalTrackPosition({
        artistId,
        albumId,
        mediaId: providerId,
        fileType: "track",
        quality: trackRow.quality || album.quality,
        libraryRoot: targetRoot,
      });
      const canonicalIdentity = resolveLibraryFileIdentity({
        artistId,
        albumId,
        mediaId: providerId,
        fileType: "track",
        quality: trackRow.quality || album.quality,
        libraryRoot: targetRoot,
      });
      const canonicalAlbum = getCanonicalAlbumMetadata({
        canonicalReleaseGroupMbid: canonicalIdentity.canonicalReleaseGroupMbid,
        canonicalReleaseMbid: canonicalIdentity.canonicalReleaseMbid,
      });
      const trackTitle = canonicalPosition?.title || trackRow.title || trackData.title || path.basename(src, ext);
      const trackNumber = canonicalPosition?.trackNumber ?? Number(trackRow.track_number || trackData.track_number || 0);
      const volumeNumber = canonicalPosition?.volumeNumber ?? Number(trackRow.volume_number || trackData.volume_number || 1);
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

      const renderedTrackPath = renderRelativePath(trackTemplate, {
        artistName: resolvedArtistName,
        artistId,
        artistMbId,
        albumTitle: canonicalAlbum?.title || album.title,
        albumId,
        albumType: canonicalAlbum?.albumType || album.type || album.mb_primary || null,
        albumMbId: canonicalAlbum?.albumMbid || album.mbid || null,
        albumVersion: canonicalAlbum ? null : album.version || null,
        releaseYear: this.getReleaseYear(canonicalAlbum?.releaseDate || album.release_date),
        trackTitle,
        trackId: providerId,
        trackMbId: trackRow.mbid || null,
        trackArtistName: resolvedTrackArtistName,
        trackArtistMbId,
        trackNumber,
        volumeNumber,
        trackVersion: canonicalPosition ? null : trackRow.version || null,
        explicit: trackRow.explicit === 1,
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

      // Fingerprinting and embedded tags are applied by the post-organize
      // import finalizer after MusicBrainz identity is resolved.
      const fileFingerprint: string | null = null;

      // Batch all per-track DB writes in a single transaction (Lidarr-style).
      db.transaction(() => {
        const libraryFileId = this.upsertLibraryFile({
          artistId,
          albumId,
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
          fingerprint: fileFingerprint
        });

        try {
          recordHistoryEvent({
            artistId,
            albumId,
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
        const trackIdentity = resolveLibraryFileIdentity({
          artistId,
          albumId,
          mediaId: providerId,
          libraryRoot: targetRoot,
          fileType: "track",
          quality: derivedQuality,
        });
        this.cleanupOldMediaFiles(providerId, dest, "track", trackIdentity.librarySlot ?? null);
        this.cleanupSiblingMediaVariants(dest, "track");
      })();

      if (metadataConfig.save_lyrics) {
        try {
          const lrcPath = this.relocateLinkedSidecar({
            artistId,
            albumId,
            mediaId: providerId,
            mediaPath: dest,
            libraryRoot: targetRoot,
            fileType: "lyrics",
            quality: trackRow?.quality || album.quality,
          });
          if (!fs.existsSync(lrcPath)) {
            await saveLyricsFile(providerId, lrcPath);
          }

          if (fs.existsSync(lrcPath)) {
            this.upsertLibraryFile({
              artistId,
              albumId,
              mediaId: providerId,
              filePath: lrcPath,
              libraryRoot: targetRoot,
              fileType: "lyrics",
              quality: trackRow?.quality || album.quality,
              namingTemplate: null,
              expectedPath: lrcPath,
            });
          }
        } catch {
          // ignore
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
      if (metadataConfig.save_artist_picture && !fs.existsSync(artistPicPath)) {
        const rawResolution = metadataConfig.artist_picture_resolution;
        const parsedResolution = rawResolution === "origin" ? "origin" : Number(rawResolution);
        const safeRes = parsedResolution === "origin" || Number.isFinite(parsedResolution)
          ? parsedResolution
          : 500;
        await downloadArtistPicture(artistId, safeRes, artistPicPath);
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
      }

      const albumDirRelative = this.deriveAlbumDirRelativeFromTrackPath(trackTemplate, relativeTrackPath);
      const targetAlbumDir = path.join(targetRoot, artistFolder, albumDirRelative);
      this.ensureDir(targetAlbumDir);

      const albumCoverPath = path.join(targetAlbumDir, metadataConfig.album_cover_name || "cover.jpg");
      if (metadataConfig.save_album_cover) {
        this.relocateSingletonSidecar({
          artistId,
          albumId,
          expectedPath: albumCoverPath,
          libraryRoot: targetRoot,
          fileType: "cover",
        });
      }
      if (metadataConfig.save_album_cover && !fs.existsSync(albumCoverPath)) {
        await downloadAlbumCover(albumId, metadataConfig.album_cover_resolution as any, albumCoverPath);
        if (fs.existsSync(albumCoverPath)) {
          this.upsertLibraryFile({
            artistId,
            albumId,
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
      if (metadataConfig.save_album_cover && album.video_cover) {
        this.relocateSingletonSidecar({
          artistId,
          albumId,
          expectedPath: albumVideoCoverPath,
          libraryRoot: targetRoot,
          fileType: "video_cover",
        });
      }
      if (metadataConfig.save_album_cover && album.video_cover && !fs.existsSync(albumVideoCoverPath)) {
        await downloadAlbumVideoCover(String(album.video_cover), metadataConfig.album_cover_resolution as any, albumVideoCoverPath);
        if (fs.existsSync(albumVideoCoverPath)) {
          this.upsertLibraryFile({
            artistId,
            albumId,
            mediaId: null,
            filePath: albumVideoCoverPath,
            libraryRoot: targetRoot,
            fileType: "video_cover",
            quality: null,
            namingTemplate: null,
            expectedPath: albumVideoCoverPath,
          });
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
          await saveAlbumNfoFile(albumId, albumNfoPath);
          this.upsertLibraryFile({
            artistId,
            albumId,
            mediaId: null,
            filePath: albumNfoPath,
            libraryRoot: targetRoot,
            fileType: "nfo",
            quality: null,
            namingTemplate: null,
            expectedPath: albumNfoPath,
          });
        } catch (error) {
          console.warn(`[Organizer] Failed to write album NFO for ${albumId}:`, error);
        }
      }

      onProgress?.({
        phase: "finalizing",
        currentFileNum: 1,
        totalFiles: 1,
        currentTrack: trackTitle,
        statusMessage: `Finalizing ${trackTitle}`,
      });

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
      const videoData = await this.fetchProviderVideo(providerId);
      let fetchedVideoData: any | null = videoData;

      const videoArtistId = videoData.artist_id ? String(videoData.artist_id) : null;
      if (!videoArtistId || !/^\d+$/.test(videoArtistId)) {
        throw new Error(`[Organizer] Video ${providerId} missing valid artist_id`);
      }

      const exists = db.prepare("SELECT id FROM Artists WHERE id = ?").get(videoArtistId) as any;
      if (!exists) {
        try {
          const a = await this.fetchProviderArtist(videoArtistId);
          db.prepare("INSERT OR IGNORE INTO artists (id, name, picture, popularity, monitored, path) VALUES (?, ?, ?, ?, 0, ?)")
            .run(videoArtistId, a.name, a.picture || null, a.popularity || 0, resolveArtistFolderForPersistence({
              artistId: videoArtistId,
              artistName: a.name,
            }));
        } catch {
          // ignore
        }
      }

      const { RefreshVideoService } = await import("../music/refresh-video-service.js");
      RefreshVideoService.upsertArtistVideos(videoArtistId, [{
        ...videoData,
        provider_id: providerId,
        provider: raw.provider || "tidal",
      }]);

      const video: any = {
        id: providerId,
        artist_id: videoArtistId,
        album_id: videoData.album_id || null,
        title: videoData.title,
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
      const existingArtist = db.prepare("SELECT name, mbid, path FROM Artists WHERE id = ?").get(artistId) as any;
      let artistName = existingArtist?.name as string | undefined;
      const artistMbId = existingArtist?.mbid ? String(existingArtist.mbid) : "";
      let artistPath = String(existingArtist?.path || "").trim();
      if (!artistName) {
        const remoteArtist = await this.fetchProviderArtist(artistId);
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
        provider: "tidal",
        artistName: resolvedArtistName,
        artistId,
        artistMbId,
        trackId: providerId,
        videoId: providerId,
        videoTitle: video.title,
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
      });
      const dest = inlineExpected.expectedPath || separatedDest;
      const organizedVideoRoot = this.resolveLibraryRoot(dest) || videoRoot;
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

      // Batch all per-video DB writes in a single transaction (Lidarr-style).
      db.transaction(() => {
        const libraryFileId = this.upsertLibraryFile({
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
          channels: metrics.channels
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
        const videoIdentity = resolveLibraryFileIdentity({
          artistId,
          albumId: video.album_id ? String(video.album_id) : null,
          mediaId: providerId,
          libraryRoot: organizedVideoRoot,
          fileType: "video",
          quality: derivedVideoQuality,
        });
        this.cleanupOldMediaFiles(providerId, dest, "video", videoIdentity.librarySlot ?? null);
        this.cleanupSiblingMediaVariants(dest, "video");
      })();

      if (metadataConfig.save_video_thumbnail || metadataConfig.embed_video_thumbnail !== false) {
        const persistentCoverPath = metadataConfig.save_video_thumbnail
          ? this.relocateLinkedSidecar({
            artistId,
            albumId: video.album_id ? String(video.album_id) : null,
            mediaId: providerId,
            mediaPath: dest,
            libraryRoot: organizedVideoRoot,
            fileType: "video_thumbnail",
            quality: derivedVideoQuality,
            namingTemplate: videoNamingTemplate,
          })
          : null;
        const transientCoverPath = persistentCoverPath ? null : path.join(path.dirname(dest), `.${path.parse(dest).name}.embed-thumb.jpg`);
        const coverPath = persistentCoverPath || transientCoverPath;
        let coverId = video.cover ? String(video.cover) : (fetchedVideoData?.image_id || null);
        if (!coverId) {
          try {
            fetchedVideoData = fetchedVideoData ?? await this.fetchProviderVideo(providerId);
            coverId = fetchedVideoData?.image_id || null;
            if (coverId) {
              // Home the cover onto the canonical video Recording (via its offer's
              // recording_id) instead of the retired ProviderMedia row.
              db.prepare(`
                UPDATE Recordings SET cover_image_id = COALESCE(?, cover_image_id), updated_at = CURRENT_TIMESTAMP
                WHERE id = (
                  SELECT recording_id FROM ProviderItems
                  WHERE entity_type = 'video' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
                    AND recording_id IS NOT NULL
                  LIMIT 1
                )
              `).run(coverId, providerId);
              video.cover = coverId;
            }
          } catch {
            // ignore
          }
        }

        if (coverId) {
          const videoThumbnailResolution = metadataConfig.video_thumbnail_resolution || "1080x720";
          if (coverPath && !fs.existsSync(coverPath)) {
            await downloadVideoThumbnail(coverId, videoThumbnailResolution as any, coverPath);
          }
        }

        if (persistentCoverPath && fs.existsSync(persistentCoverPath)) {
          this.upsertLibraryFile({
            artistId,
            albumId: video.album_id ? String(video.album_id) : null,
            mediaId: providerId,
            filePath: persistentCoverPath,
            libraryRoot: organizedVideoRoot,
            fileType: "video_thumbnail",
            quality: derivedVideoQuality,
            namingTemplate: videoNamingTemplate,
            expectedPath: persistentCoverPath,
          });
        }

        if (metadataConfig.embed_video_thumbnail !== false && coverPath && fs.existsSync(coverPath)) {
          await embedVideoThumbnail(dest, coverPath);
        }

        if (!persistentCoverPath && transientCoverPath && fs.existsSync(transientCoverPath)) {
          fs.rmSync(transientCoverPath, { force: true });
        }
      }

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
