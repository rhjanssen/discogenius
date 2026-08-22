import fs from "fs";
import path from "path";
import { db, batchDelete, batchRun } from "../../database.js";
import {
  Config,
  getConfigSection,
  readConfig,
  type DiscoGeniusConfig,
} from "../config/config.js";
import {
  allowsInlineVideoPlacement,
} from "./video-folder-layout.js";
import { mainVideoMayFollowAudioRelationSql } from "../music/live-performance-markers.js";
import { VIDEO_ALBUM_ASSOCIATION_KIND_SQL } from "../music/video-album-association.js";
import { getNamingConfig, renderFileStem, renderRelativePath, resolveArtistFolderFromRecord, type NamingContext, type library_root } from "../config/naming.js";
import {
  getCurrentLibraryRootPath,
  resolveLibraryRootKey,
  resolveLibraryRootPath,
  resolveStoredLibraryPath,
  type CurrentLibraryRoots,
} from "./library-paths.js";
import {
  comparablePathColumnSql,
  normalizeComparablePath,
  normalizeResolvedPath,
  resolvedPathIsInsideRoot,
} from "./path-utils.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "../commands/history-events.js";
import { emitFileAdded, emitFileDeleted, emitFileUpgraded } from "../commands/app-events.js";
import {
  resolveLibraryFileIdentities,
  resolveLibraryFileIdentity,
  type LibraryFileIdentity,
  type library_slot,
} from "./library-file-identity.js";
import { getCanonicalTrackPosition } from "../metadata/canonical-track-position.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";
import { renderAudioRelativePathForLibrary } from "./audio-library-path.js";
import { getCanonicalAlbumMetadata } from "../metadata/canonical-album-metadata.js";
import { ExtraFileService, FOLDER_SCOPED_METADATA_TYPES, isExtraFileType, isLyricExtraFileType, isMetadataExtraFileType } from "../extras/files/extra-file-service.js";
import { captureLinkedExtras, releaseExtrasForDeletedTrackFiles } from "../extras/files/extra-file-deletion.js";
import { LyricFileService } from "../extras/lyrics/lyric-file-service.js";
import { MetadataFileService } from "../extras/metadata/files/metadata-file-service.js";
import { resolveVideoTypeSuffix } from "./video-naming.js";
import { resolvePersistedVideoPlacement } from "../music/video-placement-resolver.js";

export {
  VIDEO_TYPE_SUFFIXES,
  resolveVideoTypeSuffix,
  stemEndsWithVideoTypeSuffix,
} from "./video-naming.js";

export type ExistingLibraryFileIdentity = {
  id: number;
  library_id?: number | null;
  artist_id: number;
  album_id: number | null;
  media_id: number | null;
  file_path: string;
  relative_path: string | null;
  library_root: string | null;
  file_type: string;
  quality: string | null;
};

export function toTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getReleaseYear(releaseDate: string | null | undefined): string | null {
  if (!releaseDate) return null;
  const match = String(releaseDate).match(/^(\d{4})/);
  return match ? match[1] : null;
}

export function splitPathSegments(value: string | null | undefined): string[] {
  return String(value || "")
    .split(/[\\/]+/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function rebaseRelativePathPrefix(relativePath: string, sourcePrefix: string, destinationPrefix: string): string | null {
  const relativeSegments = splitPathSegments(relativePath);
  const sourceSegments = splitPathSegments(sourcePrefix);
  const destinationSegments = splitPathSegments(destinationPrefix);

  if (sourceSegments.length === 0 || relativeSegments.length < sourceSegments.length) {
    return null;
  }

  for (let index = 0; index < sourceSegments.length; index += 1) {
    if (normalizeComparablePath(relativeSegments[index]) !== normalizeComparablePath(sourceSegments[index])) {
      return null;
    }
  }

  const suffix = relativeSegments.slice(sourceSegments.length);
  return destinationSegments.length > 0 ? path.join(...destinationSegments, ...suffix) : path.join(...suffix);
}

export function hasMeaningfulLibraryFileChange(
  existing: ExistingLibraryFileIdentity,
  next: {
    artistId: string;
    albumId?: string | null;
    mediaId?: string | null;
    filePath: string;
    relativePath: string | null;
    libraryRoot: string | null;
    fileType: string;
    quality?: string | null;
  },
): boolean {
  return (
    existing.artist_id !== Number(next.artistId) ||
    (existing.album_id ?? null) !== (next.albumId ? Number(next.albumId) : null) ||
    (existing.media_id ?? null) !== (next.mediaId ? Number(next.mediaId) : null) ||
    normalizeResolvedPath(existing.file_path) !== normalizeResolvedPath(next.filePath) ||
    (existing.relative_path ?? null) !== (next.relativePath ?? null) ||
    (existing.library_root ?? null) !== (next.libraryRoot ?? null) ||
    existing.file_type !== next.fileType ||
    (existing.quality ?? null) !== (next.quality ?? null)
  );
}

export function removeEmptyParents(startDir: string, stopDir: string) {
  const stop = path.resolve(stopDir);
  let current = path.resolve(startDir);

  while (resolvedPathIsInsideRoot(current, stop) && current !== stop) {
    try {
      const entries = fs.readdirSync(current);
      if (entries.length > 0) break;
      fs.rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

export function normalizeInlineVideoTitle(value: string | null | undefined): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(?:official|music|lyric|lyrics|visualizer|visualiser|video|hd|4k)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type LibraryFileRow = {
  id: number;
  artist_id: string | number;
  album_id: string | number | null;
  media_id: string | number | null;
  canonical_artist_mbid?: string | null;
  canonical_release_group_mbid?: string | null;
  canonical_release_mbid?: string | null;
  canonical_track_mbid?: string | null;
  canonical_recording_mbid?: string | null;
  file_path: string;
  relative_path: string | null;
  library_root: string | null;
  file_type: string;
  extension: string;
  library_slot?: string | null;
  provider?: string | null;
  provider_entity_type?: string | null;
  provider_id?: string | null;
  // Quality metadata
  quality?: string | null;
  codec?: string | null;
  video_codec?: string | null;
  bitrate?: number | null;
  sample_rate?: number | null;
  bit_depth?: number | null;
  channels?: number | null;
  width?: number | null;
  height?: number | null;
};

type TrackedAssetRow = LibraryFileRow & {
  relative_path: string | null;
  library_root: string;
  expected_path: string | null;
  verified_at: string | null;
  modified_at: string | null;
  created_at: string | null;
};

type CanonicalVideoLookupRow = {
  mbid: string | null;
  title: string | null;
  video_variant: string | null;
  is_video: number | null;
  metadata_status: string | null;
};

type CanonicalTrackLookupRow = {
  mbid: string;
  title: string | null;
  position: number | null;
  medium_position: number | null;
  recording_mbid: string | null;
  recording_title: string | null;
  recording_artist_mbid: string | null;
};

function expectedPathIdentityCacheKey(row: LibraryFileRow): string {
  return JSON.stringify([
    row.artist_id,
    row.album_id,
    row.media_id,
    row.file_type,
    row.quality,
    row.library_root,
    row.library_slot,
    row.provider,
    row.provider_entity_type,
    row.provider_id,
    row.canonical_artist_mbid,
    row.canonical_release_group_mbid,
    row.canonical_release_mbid,
    row.canonical_track_mbid,
    row.canonical_recording_mbid,
  ]);
}

function getCanonicalIdentityForLibraryFile(
  row: LibraryFileRow,
  cache?: ExpectedPathCache,
): LibraryFileIdentity {
  const cacheKey = cache ? expectedPathIdentityCacheKey(row) : "";
  const cached = cache?.identities.get(cacheKey);
  if (cached) return cached;

  const resolved = resolveLibraryFileIdentity({
    artistId: row.artist_id,
    albumId: row.album_id,
    mediaId: row.media_id,
    fileType: row.file_type,
    quality: row.quality,
    libraryRoot: row.library_root,
    librarySlot: row.library_slot,
    provider: row.provider,
    providerEntityType: row.provider_entity_type,
    providerId: row.provider_id,
    canonicalArtistMbid: row.canonical_artist_mbid,
    canonicalReleaseGroupMbid: row.canonical_release_group_mbid,
    canonicalReleaseMbid: row.canonical_release_mbid,
    canonicalTrackMbid: row.canonical_track_mbid,
    canonicalRecordingMbid: row.canonical_recording_mbid,
  });
  if (cache) cache.identities.set(cacheKey, resolved);
  return resolved;
}

function getCanonicalVideoMetadataByMbid(recordingMbid: string | null | undefined): CanonicalVideoLookupRow | null {
  const mbid = String(recordingMbid || "").trim();
  if (!mbid) {
    return null;
  }

  return (db.prepare(`
    SELECT mbid,
           title,
           video_variant,
           is_video AS is_video,
           metadata_status AS metadata_status
    FROM Recordings
    WHERE mbid = ?
      AND is_video = 1
    LIMIT 1
  `).get(mbid) as CanonicalVideoLookupRow | undefined) ?? null;
}

function getCanonicalVideoMetadataForRow(row: LibraryFileRow, recordingMbid: string | null | undefined): CanonicalVideoLookupRow | null {
  const byMbid = getCanonicalVideoMetadataByMbid(recordingMbid);
  if (byMbid) {
    return byMbid;
  }

  const provider = String(row.provider || "").trim();
  const providerId = String(row.provider_id || row.media_id || "").trim();
  if (!provider || !providerId) {
    return null;
  }

  return (db.prepare(`
    SELECT
           CASE WHEN COUNT(DISTINCT recording.id) = 1 THEN MAX(recording.mbid) END AS mbid,
           CASE
             WHEN COUNT(DISTINCT recording.id) != 1 THEN NULL
             WHEN MAX(recording.title) IS NULL
               OR TRIM(MAX(recording.title)) = ''
               OR LOWER(TRIM(MAX(recording.title))) = 'unknown video'
             THEN COALESCE(NULLIF(TRIM(MAX(pi.title)), ''), MAX(recording.title))
             ELSE MAX(recording.title)
           END AS title,
           CASE WHEN COUNT(DISTINCT recording.id) = 1 THEN MAX(recording.video_variant) END AS video_variant,
           CASE WHEN COUNT(DISTINCT recording.id) = 1 THEN MAX(recording.is_video) END AS is_video,
           CASE WHEN COUNT(DISTINCT recording.id) = 1 THEN MAX(recording.metadata_status) END AS metadata_status
    FROM ProviderItems pi
    JOIN ProviderVideoMatches video_match
      ON video_match.provider_video_item_id = pi.id
     AND video_match.match_state = 'accepted'
    JOIN Recordings recording ON recording.id = video_match.recording_id
    WHERE pi.provider = ?
      AND pi.entity_type = 'video'
      AND pi.provider_id = ?
      AND recording.is_video = 1
    HAVING COUNT(DISTINCT recording.id) = 1
  `).get(provider, providerId) as CanonicalVideoLookupRow | undefined) ?? null;
}

function getCanonicalTrackMetadata(trackMbid: string | null | undefined): CanonicalTrackLookupRow | null {
  const mbid = String(trackMbid || "").trim();
  if (!mbid) {
    return null;
  }

  return (db.prepare(`
    SELECT t.mbid,
           t.title,
           t.position,
           t.medium_position,
           t.recording_mbid,
           r.title AS recording_title,
           r.artist_mbid AS recording_artist_mbid
    FROM Tracks t
    LEFT JOIN Recordings r ON r.mbid = t.recording_mbid
    WHERE t.mbid = ?
    LIMIT 1
  `).get(mbid) as CanonicalTrackLookupRow | undefined) ?? null;
}

export type RenamePreviewItem = {
  id: number;
  file_type: string;
  library_root: string;
  artist_id: number;
  album_id: number | null;
  media_id: number | null;
  file_path: string;
  expected_path: string | null;
  needs_rename: boolean;
  conflict: boolean;
  /** When set, Apply will drop this file as a same-stem duplicate instead of renaming. */
  drop_duplicate?: boolean;
  missing: boolean;
  reason?: string;
  /** Human-readable conflict explanation for the preview UI. */
  conflict_message?: string;
};

export type RenameApplyResult = {
  renamed: number;
  skipped: number;
  conflicts: number;
  missing: number;
  cleanedDirectories: number;
  errors: Array<{ id: number; error: string }>;
};

export type RenameScopeOptions = {
  artistId?: string;
  albumId?: string;
  libraryRoot?: string;
  fileTypes?: string[];
  limit?: number;
  offset?: number;
};

export type RenameStatusSummary = {
  total: number;
  scanned: number;
  limited: boolean;
  renameNeeded: number;
  conflicts: number;
  missing: number;
  sample: RenamePreviewItem[];
};

type LibraryFileEventInput = {
  libraryFileId?: number | null;
  artistId: string | number;
  albumId?: string | number | null;
  mediaId?: string | number | null;
  fileType: string;
  filePath: string;
  libraryRoot?: string | null;
  quality?: string | null;
  previousPath?: string | null;
  previousQuality?: string | null;
  reason?: string | null;
  missing?: boolean;
};

export type LibraryFileUpsertParams = {
  artistId: string;
  libraryId?: number | null;
  albumId?: string | null;
  mediaId?: string | null;
  trackFileId?: number | null;
  filePath: string;
  libraryRoot: string;
  fileType: "track" | "video" | "cover" | "video_cover" | "video_thumbnail" | "nfo" | "lyrics" | string;
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
  removeFromUnmapped?: boolean;
  canonicalArtistMbid?: string | null;
  canonicalReleaseGroupMbid?: string | null;
  canonicalReleaseMbid?: string | null;
  canonicalTrackMbid?: string | null;
  canonicalRecordingMbid?: string | null;
  provider?: string | null;
  providerEntityType?: string | null;
  providerId?: string | null;
  librarySlot?: library_slot | string | null;
  sourceAudioVariantId?: number | null;
  fileClass?: "audio" | "video" | string | null;
  sourceQuality?: string | null;
  importedQuality?: string | null;
};

type ResolvableLibraryFileRow = {
  file_path: string;
  relative_path?: string | null;
  library_root?: string | null;
};

type RebaseLibraryFileRow = {
  id: number;
  artist_id: number;
  album_id: number | null;
  media_id: number | null;
  file_path: string;
  relative_path: string | null;
  library_root: string | null;
  file_type: string;
  quality: string | null;
};

/**
 * Catalog path under the stereo music root for an inline video beside its
 * associated audio track. Always uses the stereo library (`music`), never spatial —
 * Atmos folders stay Atmos audio only.
 *
 * Callers must already have confirmed `provider_video_for` → audio recording →
 * monitored nonspatial library release group; this helper only resolves the
 * filename stem.
 */
function resolveCanonicalInlineAudioExpectedPath(
  artistId: string | number,
  videoTitle: string,
  cache?: ExpectedPathCache,
): string | null {
  if (!videoTitle) return null;

  const artist = db.prepare("SELECT name, mbid, path FROM Artists WHERE id = ?").get(artistId) as any;
  if (!artist) return null;
  const artistMbId = artist.mbid ? String(artist.mbid) : String(artistId);

  const tracks = db.prepare(`
    SELECT t.title,
           t.position,
           t.number,
           t.medium_position,
           ar.mbid AS release_mbid,
           ar.release_group_mbid,
           a.title AS album_title,
           a.primary_type,
           a.first_release_date,
           CASE WHEN EXISTS (
             SELECT 1
             FROM LibraryAlbums library_group
             JOIN Libraries library ON library.id = library_group.library_id
             JOIN quality_profiles quality_profile ON quality_profile.id = library.quality_profile_id
             WHERE library_group.release_group_id = a.id
               AND library.enabled = 1
               AND NOT EXISTS (
                 SELECT 1
                 FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
                 WHERE allowed.value = 'spatial'
               )
           ) THEN 1 ELSE 0 END AS wanted,
           COALESCE(c.included, 0) AS included,
           CASE WHEN EXISTS (
             SELECT 1
             FROM LibraryEditions library_release
             JOIN Libraries library ON library.id = library_release.library_id
             JOIN quality_profiles quality_profile ON quality_profile.id = library.quality_profile_id
             WHERE library_release.edition_id = ar.id
               AND library.enabled = 1
               AND NOT EXISTS (
                 SELECT 1
                 FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
                 WHERE allowed.value = 'spatial'
               )
           ) THEN 1 ELSE 0 END AS selected_release
    FROM Tracks t
    JOIN AlbumEditions ar ON ar.mbid = t.release_mbid
    JOIN Albums a ON a.mbid = ar.release_group_mbid
    LEFT JOIN ArtistReleaseGroupCuration c
      ON c.source_artist_mbid = ?
     AND c.release_group_mbid = ar.release_group_mbid
    WHERE a.artist_mbid = ?
      AND EXISTS (
        SELECT 1
        FROM LibraryAlbums library_group
        JOIN Libraries library ON library.id = library_group.library_id
        JOIN quality_profiles quality_profile ON quality_profile.id = library.quality_profile_id
        WHERE library_group.release_group_id = a.id
          AND library.enabled = 1
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
            WHERE allowed.value = 'spatial'
          )
      )
    ORDER BY included DESC,
             CASE a.primary_type WHEN 'Album' THEN 0 WHEN 'EP' THEN 1 WHEN 'Single' THEN 2 ELSE 3 END,
             selected_release DESC,
             a.first_release_date ASC,
             ar.mbid ASC,
             t.position ASC
  `).all(artistMbId, artistMbId) as Array<{
    title?: string | null;
    position?: number | null;
    number?: string | null;
    medium_position?: number | null;
    album_title?: string | null;
    primary_type?: string | null;
    first_release_date?: string | null;
    release_group_mbid?: string | null;
  }>;
  const track = tracks.find((candidate) => normalizeInlineVideoTitle(candidate.title) === videoTitle);
  if (!track?.album_title) return null;

  const naming = cache?.configSnapshot.naming ?? getNamingConfig();
  const artistName = String(artist.name || "Unknown Artist");
  const artistFolder = resolveArtistFolderFromRecord({
    name: artistName,
    mbid: artistMbId,
    path: artist.path || null,
  });
  const renderedTrackPath = renderRelativePath(naming.album_track_path_single, {
    artistName,
    artistId: String(artistId),
    artistMbId,
    albumTitle: track.album_title,
    albumMbId: track.release_group_mbid || null,
    albumType: track.primary_type || null,
    releaseYear: getReleaseYear(track.first_release_date),
    trackTitle: track.title || "Unknown Track",
    trackNumber: Number(track.position || track.number || 0),
    volumeNumber: Number(track.medium_position || 1),
  });
  return path.join(
    cache?.libraryRoots.music ?? getCurrentLibraryRootPath("music"),
    artistFolder,
    `${renderedTrackPath}.flac`,
  );
}

function resolveExpectedLibraryRootKey(
  row: LibraryFileRow,
  cache?: ExpectedPathCache,
): library_root | null {
  const videoFolderLayout = cache?.configSnapshot.path.video_folder_layout
    ?? getConfigSection("path")?.video_folder_layout;
  // An inline file's library_root is "music". Switching the layout to
  // separated must retarget it to the video library, not rename it in the
  // album folder with video-filename tokens.
  if (
    (row.file_type === "video" || row.file_type === "video_thumbnail")
    && !allowsInlineVideoPlacement(videoFolderLayout)
  ) {
    return "videos";
  }

  const resolved = resolveLibraryRootKey(
    row.library_root,
    row.file_path,
    cache?.libraryRoots,
  );
  if (resolved) {
    return resolved;
  }

  const slot = String(row.library_slot || "").trim().toLowerCase();
  if (slot === "video" || row.file_type === "video" || row.file_type === "video_thumbnail") {
    return "videos";
  }
  if (slot === "spatial" || isSpatialAudioQuality(row.quality)) {
    return "spatial";
  }
  if (slot === "stereo" || row.file_type === "track" || row.file_type === "lyrics") {
    return "music";
  }

  if (row.file_type === "video" || row.file_type === "video_thumbnail" || row.library_slot === "video") {
    return "videos";
  }

  const videoProviderId = String(row.provider_id || row.media_id || "").trim();
  if (videoProviderId) {
    const isVideo = db.prepare(`
      SELECT 1
      FROM ProviderItems pi
      JOIN ProviderVideoMatches video_match
        ON video_match.provider_video_item_id = pi.id
       AND video_match.match_state = 'accepted'
      JOIN Recordings r ON r.id = video_match.recording_id
      WHERE pi.entity_type = 'video'
        AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
        AND r.is_video = 1
      LIMIT 1
    `).get(videoProviderId);
    if (isVideo) {
      return "videos";
    }
  }

  return null;
}

/**
 * Per-call read cache for computeExpectedPath so a batch of rows (e.g. a rename
 * preview) resolves the shared artist row + album metadata once instead of once
 * per row. Pure reads only; create a fresh cache per batch (never share one
 * across a mutation).
 */
export interface ExpectedPathCache {
  /** One immutable settings view for the whole batch; workers see changes on the next batch. */
  configSnapshot: Readonly<DiscoGeniusConfig>;
  /** Resolved roots derived from configSnapshot (and any process env overrides). */
  libraryRoots: CurrentLibraryRoots;
  artists: Map<string, { name?: string; mbid?: string | null; path?: string | null } | undefined>;
  albums: Map<string, ReturnType<typeof getCanonicalAlbumMetadata>>;
  /** Fully resolved file identity, including selected-release hybrid remaps. */
  identities: Map<string, LibraryFileIdentity>;
  /** Resolved artist folder by artist_id (constant across an artist's rows). */
  artistFolders: Map<string, string>;
  /** Rendered album-dir (relative), keyed by every album-level naming input. */
  albumDirs: Map<string, string>;
  /** Canonical track metadata by track mbid — bulk-loaded once per batch (Lidarr GetTracksByReleases). */
  trackMeta: Map<string, CanonicalTrackLookupRow | null>;
  /** ArtistMetadata (name/mbid) by mbid — bulk-loaded once per batch. */
  artistMeta: Map<string, { name?: string; mbid?: string | null } | null>;
  /** Rename batches collect candidate paths, then resolve all occupants in one indexed query. */
  trackCollisionMode: "database" | "collect" | "loaded";
  pendingTrackPaths: Map<string, string>;
  trackPathOwners: Map<string, Set<number>>;
}

export function createExpectedPathCache(
  options: { deferTrackCollisionLookup?: boolean } = {},
): ExpectedPathCache {
  const configSnapshot = readConfig();
  const libraryRoots: CurrentLibraryRoots = {
    music: Config.getMusicPath(configSnapshot.path),
    spatial: Config.getSpatialPath(configSnapshot.path),
    videos: Config.getVideoPath(configSnapshot.path),
  };
  return {
    configSnapshot,
    libraryRoots,
    artists: new Map(),
    albums: new Map(),
    identities: new Map(),
    artistFolders: new Map(),
    albumDirs: new Map(),
    trackMeta: new Map(),
    artistMeta: new Map(),
    trackCollisionMode: options.deferTrackCollisionLookup ? "collect" : "database",
    pendingTrackPaths: new Map(),
    trackPathOwners: new Map(),
  };
}

/**
 * Bulk-load canonical track metadata (and the tracks' recording artist metadata)
 * for a whole rename/backfill batch in bounded query chunks, instead of one query
 * per row inside computeExpectedPath. This is the Discogenius equivalent of
 * Lidarr loading all of an artist/album's tracks once before computing paths in
 * memory. Chunked to stay under SQLite's bound-parameter ceiling.
 */
export function preloadCanonicalTrackMeta(trackMbids: Array<string | null | undefined>, cache: ExpectedPathCache): void {
  const mbids = Array.from(new Set(trackMbids.map((m) => String(m || "").trim()).filter(Boolean)))
    .filter((m) => !cache.trackMeta.has(m));
  const artistMbids = new Set<string>();
  for (let i = 0; i < mbids.length; i += 400) {
    const chunk = mbids.slice(i, i + 400);
    const marks = chunk.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT t.mbid, t.title, t.position, t.medium_position, t.recording_mbid,
             r.title AS recording_title, r.artist_mbid AS recording_artist_mbid
      FROM Tracks t
      LEFT JOIN Recordings r ON r.mbid = t.recording_mbid
      WHERE t.mbid IN (${marks})
    `).all(...chunk) as CanonicalTrackLookupRow[];
    const byMbid = new Map(rows.map((row) => [String(row.mbid), row]));
    for (const mbid of chunk) {
      const row = byMbid.get(mbid) ?? null;
      cache.trackMeta.set(mbid, row);
      const artistMbid = String(row?.recording_artist_mbid || "").trim();
      if (artistMbid) artistMbids.add(artistMbid);
    }
  }

  const artistList = Array.from(artistMbids).filter((m) => !cache.artistMeta.has(m));
  for (let i = 0; i < artistList.length; i += 400) {
    const chunk = artistList.slice(i, i + 400);
    const marks = chunk.map(() => "?").join(",");
    const rows = db.prepare(`SELECT name, mbid FROM ArtistMetadata WHERE mbid IN (${marks})`)
      .all(...chunk) as Array<{ name?: string; mbid?: string | null }>;
    const byMbid = new Map(rows.map((row) => [String(row.mbid), row]));
    for (const mbid of chunk) cache.artistMeta.set(mbid, byMbid.get(mbid) ?? null);
  }
}

/**
 * Resolve the canonical identity once for every row before rendering paths.
 * Hybrid provider albums can remap a source track onto a different track on the
 * selected MusicBrainz release, so preloading raw TrackFiles MBIDs is not enough.
 */
export function preloadExpectedPathIdentities(rows: LibraryFileRow[], cache: ExpectedPathCache): void {
  const unresolvedRows: LibraryFileRow[] = [];
  for (const row of rows) {
    if (!cache.identities.has(expectedPathIdentityCacheKey(row))) {
      unresolvedRows.push(row);
    }
  }
  const resolved = resolveLibraryFileIdentities(unresolvedRows.map((row) => ({
    artistId: row.artist_id,
    albumId: row.album_id,
    mediaId: row.media_id,
    fileType: row.file_type,
    quality: row.quality,
    libraryRoot: row.library_root,
    librarySlot: row.library_slot,
    provider: row.provider,
    providerEntityType: row.provider_entity_type,
    providerId: row.provider_id,
    canonicalArtistMbid: row.canonical_artist_mbid,
    canonicalReleaseGroupMbid: row.canonical_release_group_mbid,
    canonicalReleaseMbid: row.canonical_release_mbid,
    canonicalTrackMbid: row.canonical_track_mbid,
    canonicalRecordingMbid: row.canonical_recording_mbid,
  })));
  for (let index = 0; index < unresolvedRows.length; index += 1) {
    cache.identities.set(
      expectedPathIdentityCacheKey(unresolvedRows[index]!),
      resolved[index]!,
    );
  }
  const resolvedTrackMbids = rows.map(
    (row) => cache.identities.get(expectedPathIdentityCacheKey(row))?.canonicalTrackMbid ?? null,
  );
  preloadCanonicalTrackMeta(resolvedTrackMbids, cache);
}

/**
 * Finish a deferred collision pass with bounded indexed lookups. The first path
 * render collects unsuffixed candidate paths; only rows with an actual occupant
 * need to be rendered again with spatial/stereo disambiguation enabled.
 */
export function preloadExpectedTrackPathOccupants(cache: ExpectedPathCache): void {
  if (cache.trackCollisionMode !== "collect") return;

  const paths = Array.from(cache.pendingTrackPaths.values());
  for (let i = 0; i < paths.length; i += 400) {
    const chunk = paths.slice(i, i + 400);
    const marks = chunk.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT id, file_path
      FROM TrackFiles
      WHERE file_type = 'track'
        AND file_path IN (${marks})
    `).all(...chunk) as Array<{ id: number; file_path: string }>;
    for (const row of rows) {
      const key = normalizeResolvedPath(row.file_path);
      const owners = cache.trackPathOwners.get(key) ?? new Set<number>();
      owners.add(Number(row.id));
      cache.trackPathOwners.set(key, owners);
    }
  }
  cache.trackCollisionMode = "loaded";
}

export function hasExpectedTrackPathConflict(
  cache: ExpectedPathCache,
  expectedPath: string | null | undefined,
  rowId: number,
): boolean {
  if (cache.trackCollisionMode !== "loaded" || !expectedPath) return false;
  const owners = cache.trackPathOwners.get(normalizeResolvedPath(expectedPath));
  return Boolean(owners && Array.from(owners).some((ownerId) => ownerId !== rowId));
}

function mustDisambiguateTrackPath(
  expectedPath: string,
  rowId: number,
  cache?: ExpectedPathCache,
): boolean {
  if (!cache || cache.trackCollisionMode === "database") {
    return Boolean(db.prepare(`
      SELECT id FROM TrackFiles
      WHERE file_type = 'track' AND file_path = ? AND id != ?
      LIMIT 1
    `).get(expectedPath, rowId));
  }

  const key = normalizeResolvedPath(expectedPath);
  if (cache.trackCollisionMode === "collect") {
    cache.pendingTrackPaths.set(key, expectedPath);
    return false;
  }
  return hasExpectedTrackPathConflict(cache, expectedPath, rowId);
}

export class LibraryFilesService {
  private static buildFileEventPayload(input: LibraryFileEventInput) {
    return {
      libraryFileId: input.libraryFileId ?? null,
      artistId: String(input.artistId),
      albumId: input.albumId == null ? null : String(input.albumId),
      mediaId: input.mediaId == null ? null : String(input.mediaId),
      fileType: input.fileType,
      filePath: input.filePath,
      libraryRoot: input.libraryRoot ?? null,
      quality: input.quality ?? null,
      previousPath: input.previousPath ?? null,
      previousQuality: input.previousQuality ?? null,
      reason: input.reason ?? null,
      missing: input.missing === true,
      timestamp: new Date().toISOString(),
    };
  }

  static emitFileAdded(input: LibraryFileEventInput) {
    emitFileAdded(this.buildFileEventPayload(input));
  }

  static emitFileDeleted(input: LibraryFileEventInput) {
    emitFileDeleted(this.buildFileEventPayload(input));
  }

  static emitFileUpgraded(input: LibraryFileEventInput) {
    emitFileUpgraded(this.buildFileEventPayload(input));
  }

  static isTrackedAssetFileType(fileType: string): boolean {
    return isExtraFileType(fileType);
  }

  static resolveExistingFiles<T extends ResolvableLibraryFileRow>(rows: T[]): T[] {
    const resolvedRows: T[] = [];

    for (const row of rows) {
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root ?? null,
        relativePath: row.relative_path ?? null,
      });

      if (!fs.existsSync(resolvedFilePath)) {
        continue;
      }

      const resolvedRoot = row.library_root
        ? resolveLibraryRootPath(row.library_root, row.file_path)
        : null;

      resolvedRows.push({
        ...row,
        file_path: resolvedFilePath,
        relative_path: resolvedRoot
          ? path.relative(resolvedRoot, resolvedFilePath)
          : row.relative_path ?? null,
        library_root: resolvedRoot ?? row.library_root ?? null,
      });
    }

    return resolvedRows;
  }

  static rebaseArtistPathsAfterMove(options: {
    artistId: string;
    sourcePath: string;
    destinationPath: string;
  }): { updated: number } {
    // A move spans all playable and sidecar tables. If any later row fails,
    // the caller rolls the directories back to their source locations; keeping
    // earlier row updates would then point the database at paths that no longer
    // exist. Commit the entire rebase as one write set, and only emit events
    // after that commit succeeds.
    const fileEvents: LibraryFileEventInput[] = [];
    const updated = db.transaction(() => {
      const rows = db.prepare(`
        SELECT id, library_id, artist_id, NULL AS album_id, provider_id AS media_id, file_path, relative_path, library_root, file_type, quality
        FROM TrackFiles
        WHERE artist_id = ?
      `).all(options.artistId) as RebaseLibraryFileRow[];

      let updatedCount = 0;
      const update = db.prepare(`
        UPDATE TrackFiles
        SET file_path = ?,
            relative_path = ?,
            expected_path = ?,
            needs_rename = 0,
            verified_at = CURRENT_TIMESTAMP,
            modified_at = CASE
              WHEN ? IS NOT NULL THEN ?
              ELSE modified_at
            END
        WHERE id = ?
      `);

      for (const row of rows) {
        const currentRoot = resolveLibraryRootPath(row.library_root, row.file_path);
        if (!currentRoot) {
          continue;
        }

        const currentRelativePath = row.relative_path || path.relative(currentRoot, row.file_path);
        const rebasedRelativePath = rebaseRelativePathPrefix(
          currentRelativePath,
          options.sourcePath,
          options.destinationPath,
        );

        if (!rebasedRelativePath) {
          continue;
        }

        const nextFilePath = path.join(currentRoot, rebasedRelativePath);
        let modifiedAt: string | null = null;
        try {
          modifiedAt = fs.statSync(nextFilePath).mtime.toISOString();
        } catch {
          modifiedAt = null;
        }

        update.run(
          nextFilePath,
          rebasedRelativePath,
          nextFilePath,
          modifiedAt,
          modifiedAt,
          row.id,
        );

        fileEvents.push({
          libraryFileId: row.id,
          artistId: row.artist_id,
          albumId: row.album_id,
          mediaId: row.media_id,
          fileType: row.file_type,
          filePath: nextFilePath,
          libraryRoot: row.library_root,
          quality: row.quality,
          previousPath: row.file_path,
          reason: "artist-folder-move",
        });
        updatedCount += 1;
      }

      // Rebase sidecar tables in the same transaction as TrackFiles.
      const sidecarTables = ["MetadataFiles", "LyricFiles", "ExtraFiles"] as const;
      for (const table of sidecarTables) {
        const fileTypeSql = table === "LyricFiles" ? "'lyrics' AS file_type" : "file_type AS file_type";
        const qualitySql = table === "LyricFiles" ? "quality AS quality" : "NULL AS quality";

        const sidecarRows = db.prepare(`
          SELECT id AS id,
            artist_id AS artist_id,
            COALESCE(canonical_release_group_mbid, canonical_release_mbid) AS album_id,
            COALESCE(canonical_track_mbid, canonical_recording_mbid, provider_id) AS media_id,
            file_path AS file_path,
            relative_path AS relative_path,
            library_root AS library_root,
            ${fileTypeSql},
            ${qualitySql}
          FROM ${table}
          WHERE artist_id = ?
        `).all(options.artistId) as RebaseLibraryFileRow[];

        const sidecarUpdate = db.prepare(`
          UPDATE ${table}
          SET file_path = ?,
              relative_path = ?,
              expected_path = ?,
              needs_rename = 0,
              last_updated = CURRENT_TIMESTAMP
          WHERE id = ?
        `);

        for (const row of sidecarRows) {
          const currentRoot = resolveLibraryRootPath(row.library_root, row.file_path);
          if (!currentRoot) {
            continue;
          }

          const currentRelativePath = row.relative_path || path.relative(currentRoot, row.file_path);
          const rebasedRelativePath = rebaseRelativePathPrefix(
            currentRelativePath,
            options.sourcePath,
            options.destinationPath,
          );

          if (!rebasedRelativePath) {
            continue;
          }

          const nextFilePath = path.join(currentRoot, rebasedRelativePath);
          sidecarUpdate.run(
            nextFilePath,
            rebasedRelativePath,
            nextFilePath,
            row.id,
          );

          fileEvents.push({
            libraryFileId: row.id,
            artistId: row.artist_id,
            albumId: row.album_id,
            mediaId: row.media_id,
            fileType: row.file_type,
            filePath: nextFilePath,
            libraryRoot: row.library_root,
            quality: row.quality,
            previousPath: row.file_path,
            reason: "artist-folder-move",
          });
          updatedCount += 1;
        }
      }

      return updatedCount;
    })();

    for (const event of fileEvents) {
      this.emitFileUpgraded(event);
    }
    return { updated };
  }

  static computeExpectedPath(row: LibraryFileRow, cache?: ExpectedPathCache): { expectedPath: string | null; reason?: string } {
    const pathConfig = cache?.configSnapshot.path ?? getConfigSection("path");
    const videoFolderLayout = pathConfig?.video_folder_layout || "separated";
    const canonicalIdentity = getCanonicalIdentityForLibraryFile(row, cache);
    // Audio track rows never resolve a video path, but the canonical-video lookup
    // runs 1-2 DB queries per row that always return null for them. Skip it for
    // plain tracks — the dominant case in a rename/backfill batch — and only pay
    // it for the video/sidecar file types that actually consume canonicalVideo.
    const canonicalVideo = row.file_type === "track"
      ? null
      : getCanonicalVideoMetadataForRow(row, canonicalIdentity.canonicalRecordingMbid);

    if (allowsInlineVideoPlacement(videoFolderLayout) && row.media_id && (row.file_type === "video" || row.file_type === "video_thumbnail" || row.file_type === "nfo")) {
      if (canonicalVideo) {
        const recordingMbid = canonicalIdentity.canonicalRecordingMbid || null;
        const videoRecordingId = (() => {
          if (recordingMbid) {
            const byMbid = db.prepare(`SELECT id FROM Recordings WHERE mbid = ? AND is_video = 1 LIMIT 1`)
              .get(recordingMbid) as { id?: number } | undefined;
            if (byMbid?.id) return Number(byMbid.id);
          }
          const provider = String(row.provider || canonicalIdentity.provider || "").trim();
          const providerId = String(row.provider_id || row.media_id || "").trim();
          if (!provider || !providerId) return null;
          const byOffer = db.prepare(`
            SELECT CASE
              WHEN COUNT(DISTINCT video_match.recording_id) = 1
              THEN MAX(video_match.recording_id)
            END AS recording_id
            FROM ProviderItems item
            JOIN ProviderVideoMatches video_match
              ON video_match.provider_video_item_id = item.id
             AND video_match.match_state = 'accepted'
            WHERE item.provider = ? AND item.entity_type = 'video'
              AND CAST(item.provider_id AS TEXT) = CAST(? AS TEXT)
          `).get(provider, providerId) as { recording_id?: number | null } | undefined;
          return byOffer?.recording_id == null ? null : Number(byOffer.recording_id);
        })();
        // Where this video goes was decided by curation and stored on
        // LibraryVideos. Re-deriving it here is what let rename and scan
        // disagree about the same file's home and duplicate it; this now reads
        // the one stored answer. Spatial folders stay Atmos audio only — inline
        // always targets a stereo music root.
        const persistedPlacement = videoRecordingId
          ? resolvePersistedVideoPlacement(videoRecordingId)
          : null;
        const relatedAudio = persistedPlacement?.mode === "inline"
          && persistedPlacement.inlineAudioRecordingId != null
          ? db.prepare(`
              SELECT
                audio.id AS audio_recording_id,
                audio.mbid AS audio_recording_mbid,
                COALESCE(track.title, audio.title) AS audio_title,
                1 AS nonspatial_monitored
              FROM Recordings audio
              LEFT JOIN Tracks track ON track.id = ?
              WHERE audio.id = ?
            `).get(
              persistedPlacement.inlineTrackId,
              persistedPlacement.inlineAudioRecordingId,
            ) as {
              audio_recording_id?: number;
              audio_recording_mbid?: string | null;
              audio_title?: string | null;
              nonspatial_monitored?: number;
            } | undefined
          : undefined;

        if (relatedAudio?.audio_recording_id && Boolean(relatedAudio.nonspatial_monitored)) {
          // Nonspatial TrackFile only — never park MVs beside a spatial/Atmos copy.
          const audioTrack = db.prepare(`
              SELECT
                tf.id, tf.artist_id, NULL AS album_id, tf.provider_id AS media_id,
                tf.canonical_artist_mbid, tf.canonical_release_group_mbid, tf.canonical_release_mbid,
                tf.canonical_track_mbid, tf.canonical_recording_mbid,
                tf.file_path, tf.relative_path, tf.library_root, tf.file_type, tf.extension,
                tf.quality, tf.codec, tf.bitrate, tf.sample_rate, tf.bit_depth, tf.channels
              FROM TrackFiles tf
              JOIN Libraries library ON library.id = tf.library_id
              JOIN quality_profiles quality_profile ON quality_profile.id = library.quality_profile_id
              WHERE tf.recording_id = ?
                AND tf.file_type = 'track'
                AND library.enabled = 1
                AND NOT EXISTS (
                  SELECT 1
                  FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
                  WHERE allowed.value = 'spatial'
                )
              ORDER BY tf.id ASC
              LIMIT 1
            `).get(relatedAudio.audio_recording_id) as LibraryFileRow | undefined;

          const inlineVideoTitle = normalizeInlineVideoTitle(
            relatedAudio.audio_title || canonicalVideo.title,
          );

          let audioExpectedPath: string | null = audioTrack
            ? LibraryFilesService.computeExpectedPath(audioTrack, cache).expectedPath
            : null;
          // Catalog stereo-root fallback when the stereo file is not on disk yet.
          audioExpectedPath ||= resolveCanonicalInlineAudioExpectedPath(row.artist_id, inlineVideoTitle, cache);

          if (audioExpectedPath) {
            const audioExpectedDir = path.dirname(audioExpectedPath);
            const audioExpectedStem = path.parse(audioExpectedPath).name;
            let ext = row.extension || "";
            if (!ext) {
              if (row.file_type === "video") {
                ext = (row.file_path ? path.extname(row.file_path).replace(".", "") : "") || "mp4";
              } else if (row.file_type === "video_thumbnail") {
                ext = "jpg";
              } else if (row.file_type === "nfo") {
                ext = "nfo";
              }
            }
            const trackedVideo = row.file_type !== "video"
              ? db.prepare(`
                  SELECT id, artist_id, NULL AS album_id, provider_id AS media_id,
                         canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
                         file_path, relative_path, library_root, file_type, extension,
                         provider, provider_entity_type, provider_id,
                         quality, codec, bitrate, sample_rate, bit_depth, channels
                  FROM TrackFiles
                  WHERE file_type = 'video'
                    AND (
                      (
                        ? IS NOT NULL
                        AND canonical_recording_mbid = ?
                      )
                      OR (
                        provider = ?
                        AND provider_entity_type = 'video'
                        AND provider_id = ?
                      )
                    )
                  LIMIT 1
                `).get(
                  canonicalIdentity.canonicalRecordingMbid,
                  canonicalIdentity.canonicalRecordingMbid,
                  row.provider,
                  row.media_id,
                ) as LibraryFileRow | undefined
              : undefined;
            const trackedVideoExpected = trackedVideo
              ? LibraryFilesService.computeExpectedPath(trackedVideo, cache).expectedPath
              : null;
            if (trackedVideoExpected) {
              return { expectedPath: path.join(path.dirname(trackedVideoExpected), `${path.parse(trackedVideoExpected).name}.${ext}`) };
            }

            // Inline: the file fills this track's regular-video or lyrics slot,
            // so a live cut is named `-video` like any other occupant of it.
            const videoTypeSuffix = resolveVideoTypeSuffix(
              canonicalVideo.title, canonicalVideo.video_variant, "inline",
            );
            // One primary inline file per audio stem + Plex type (e.g. Track-video.mp4).
            // Plex allows a descriptive middle segment for multiples, but the UX is weak
            // and multi-provider offers for the same cut must not litter the album folder.
            // Different type suffixes (-lyrics / -live) still coexist via this key.
            return {
              expectedPath: path.join(audioExpectedDir, `${audioExpectedStem}${videoTypeSuffix}.${ext}`),
            };
          }
        }
        // Fall through: separated video library path.
      }
    }

    const libraryRootKey = resolveExpectedLibraryRootKey(row, cache);
    if (!libraryRootKey) return { expectedPath: null, reason: `unsupported_library_root:${row.library_root}` };

    const libraryRootPath = cache?.libraryRoots[libraryRootKey]
      ?? getCurrentLibraryRootPath(libraryRootKey);

    const naming = cache?.configSnapshot.naming ?? getNamingConfig();
    const metadataConfig = cache?.configSnapshot.metadata ?? getConfigSection("metadata");

    // A per-artist rename hits this for all 200 preview rows with the same
    // artist_id. Cache it (and album metadata below) per preview call — Lidarr's
    // "load once, reuse" pattern — so computeExpectedPath is not an N+1 storm.
    const artist = ((): any => {
      if (cache) {
        const artistKey = String(row.artist_id);
        if (cache.artists.has(artistKey)) return cache.artists.get(artistKey);
        const resolved = db.prepare("SELECT name, mbid, path FROM Artists WHERE id = ?").get(row.artist_id) as { name?: string; mbid?: string | null; path?: string | null } | undefined;
        cache.artists.set(artistKey, resolved);
        return resolved;
      }
      return db.prepare("SELECT name, mbid, path FROM Artists WHERE id = ?").get(row.artist_id);
    })();
    const artistName = (artist?.name as string | undefined) || "Unknown Artist";
    const artistMbId = artist?.mbid ? String(artist.mbid) : null;
    const artistFolder = ((): string => {
      if (cache) {
        const key = String(row.artist_id);
        const hit = cache.artistFolders.get(key);
        if (hit !== undefined) return hit;
        const resolved = resolveArtistFolderFromRecord({ name: artistName, mbid: artistMbId, path: artist?.path || null });
        cache.artistFolders.set(key, resolved);
        return resolved;
      }
      return resolveArtistFolderFromRecord({ name: artistName, mbid: artistMbId, path: artist?.path || null });
    })();

    // Provider ids collide across services and entity types. A file row that
    // lacks its provider cannot recover that authority from provider_id alone.
    const resolvedProvider = String(row.provider || "").trim();
    const contextBase: NamingContext = {
      provider: resolvedProvider || null,
      artistName,
      artistId: String(row.artist_id),
      artistMbId,
    };

    // Videos (do not use album folder). Resolved from the canonical Recordings
    // entity (via getCanonicalVideoMetadataForRow and ProviderVideoMatches),
    // not a provider shadow column.
    if (row.file_type === "video") {
      if (!canonicalVideo) {
        return { expectedPath: null, reason: "video_not_found" };
      }
      const ext = row.extension || path.extname(row.file_path).replace(".", "");
      const videoType = resolveVideoTypeSuffix(canonicalVideo.title, canonicalVideo.video_variant);
      const context: NamingContext = {
        ...contextBase,
        videoTitle: canonicalVideo.title || "Unknown Video",
        videoType,
        trackId: row.media_id != null ? String(row.media_id) : null,
        videoId: row.media_id != null ? String(row.media_id) : null,
        explicit: false,
        quality: row.quality || null,
        codec: row.codec || null,
        bitrate: row.bitrate || null,
        sampleRate: row.sample_rate || null,
        bitDepth: row.bit_depth || null,
        channels: row.channels || null,
      };

      // Separated layout: the naming template owns the Plex type suffix via
      // {Video Type}. Do not append a second suffix after render.
      const fileStem = renderFileStem(naming.video_file, context);
      const fileName = `${fileStem}.${ext}`;

      return {
        expectedPath: path.join(libraryRootPath, artistFolder, fileName),
      };
    }

    if (row.file_type === "video_thumbnail") {
      if (!canonicalVideo) {
        return { expectedPath: null, reason: "video_not_found" };
      }
      const ext = row.extension || "jpg";
      const videoType = resolveVideoTypeSuffix(canonicalVideo.title, canonicalVideo.video_variant);
      const context: NamingContext = {
        ...contextBase,
        videoTitle: canonicalVideo.title || "Unknown Video",
        videoType,
        trackId: row.media_id != null ? String(row.media_id) : null,
        videoId: row.media_id != null ? String(row.media_id) : null,
        explicit: false,
        quality: row.quality || null,
        codec: row.codec || null,
        bitrate: row.bitrate || null,
        sampleRate: row.sample_rate || null,
        bitDepth: row.bit_depth || null,
        channels: row.channels || null,
      };

      // Sidecars must share the video file's stem (including any Plex extras
      // suffix from the template) so Plex/Kodi pair them with the video.
      const fileStem = renderFileStem(naming.video_file, context);
      const fileName = `${fileStem}.${ext}`;

      return {
        expectedPath: path.join(libraryRootPath, artistFolder, fileName),
      };
    }

    if (row.file_type === "nfo" && row.media_id) {
      if (canonicalVideo) {
        const videoType = resolveVideoTypeSuffix(canonicalVideo.title, canonicalVideo.video_variant);
        const context: NamingContext = {
          ...contextBase,
          videoTitle: canonicalVideo.title || "Unknown Video",
          videoType,
          trackId: String(row.media_id),
          videoId: String(row.media_id),
          explicit: false,
          quality: row.quality || null,
          codec: row.codec || null,
          bitrate: row.bitrate || null,
          sampleRate: row.sample_rate || null,
          bitDepth: row.bit_depth || null,
          channels: row.channels || null,
        };
        const fileStem = renderFileStem(naming.video_file, context);
        return { expectedPath: path.join(libraryRootPath, artistFolder, `${fileStem}.nfo`) };
      }
    }

    // Album-scoped types (track, lyrics, cover, NFO)
    if (!canonicalIdentity.canonicalReleaseGroupMbid) {
      // Artist-scoped types (artist NFO and artist picture cover)
      if (row.file_type === "nfo") {
        return { expectedPath: path.join(libraryRootPath, artistFolder, "artist.nfo") };
      }

      if (row.file_type === "cover") {
        const name = metadataConfig.artist_picture_name || "folder.jpg";
        return { expectedPath: path.join(libraryRootPath, artistFolder, name) };
      }

      return { expectedPath: null, reason: "missing_album_id" };
    }

    // Canonical-first album naming context. Audio files always carry a canonical
    // release-group identity (the gap-fill guarantees it); we resolve naming from
    // Albums/AlbumEditions via getCanonicalAlbumMetadata rather than ProviderAlbums.
    // Only look up the associated audio track's release group when THIS row does
    // not already carry its own — i.e. for sidecars (nfo/cover/lyrics) that key
    // off a shared media_id. A track row already has canonical_release_group_mbid,
    // so the query would just re-fetch its own RG (the fallback below uses the
    // same value). Skipping it removes one query per track row from the preview.
    const trackedIdentity = (row.provider && row.media_id && !row.canonical_release_group_mbid)
      ? db.prepare(`
          SELECT canonical_release_group_mbid, canonical_release_mbid
          FROM TrackFiles
          WHERE provider = ?
            AND provider_entity_type = 'track'
            AND provider_id = ?
            AND file_type = 'track'
            AND canonical_release_group_mbid IS NOT NULL
          ORDER BY CASE WHEN library_slot = ? THEN 0 ELSE 1 END, id ASC
          LIMIT 1
        `).get(row.provider, row.media_id, row.library_slot || "stereo") as {
          canonical_release_group_mbid: string | null;
          canonical_release_mbid: string | null;
        } | undefined
      : undefined;
    const releaseGroupMbid = trackedIdentity?.canonical_release_group_mbid || canonicalIdentity.canonicalReleaseGroupMbid;
    const canonicalReleaseMbid = trackedIdentity?.canonical_release_mbid || canonicalIdentity.canonicalReleaseMbid;
    const resolveCanonicalAlbum = () => getCanonicalAlbumMetadata({
      canonicalReleaseGroupMbid: releaseGroupMbid,
      canonicalReleaseMbid,
    });
    const canonicalAlbum = ((): ReturnType<typeof getCanonicalAlbumMetadata> => {
      if (!cache) return resolveCanonicalAlbum();
      // Many tracks share one album, so key by rg + release mbid and resolve once.
      const albumKey = `${releaseGroupMbid ?? ""}::${canonicalReleaseMbid ?? ""}`;
      if (cache.albums.has(albumKey)) return cache.albums.get(albumKey) ?? null;
      const resolved = resolveCanonicalAlbum();
      cache.albums.set(albumKey, resolved);
      return resolved;
    })();
    if (!canonicalAlbum) return { expectedPath: null, reason: "album_not_found" };

    const releaseYear = getReleaseYear(canonicalAlbum.releaseDate);
    const albumContext: NamingContext = {
      ...contextBase,
      albumId: String(releaseGroupMbid ?? ""),
      albumTitle: canonicalAlbum.title || "Unknown Album",
      albumType: canonicalAlbum.albumType || null,
      albumMbId: canonicalAlbum.albumMbid || releaseGroupMbid || null,
      albumDisambiguation: canonicalAlbum.disambiguation || null,
      editionTitle: canonicalAlbum.editionTitle || canonicalAlbum.title || "Unknown Album",
      editionDisambiguation: canonicalAlbum.editionDisambiguation || null,
      releaseYear,
      explicit: false,
    };

    const pickTrackTemplate = (numVolumes: number) =>
      numVolumes > 1 ? naming.album_track_path_multi : naming.album_track_path_single;

    const deriveAlbumDirRelativeFromTemplate = (trackTemplate: string) => {
      const templateSegments = (trackTemplate || "").split(/[\\/]+/g).filter(Boolean);
      const templateDirSegments = templateSegments.slice(0, -1);
      const volumeDirIndex = templateDirSegments.findIndex((seg) => /\{[^}]*?(?:volumeNumber|medium)/i.test(seg));

      const renderedTrackPath = renderRelativePath(trackTemplate, {
        ...albumContext,
        trackTitle: "Track",
        trackNumber: 1,
        volumeNumber: 1,
      });
      const renderedSegments = renderedTrackPath.split(/[\\/]+/g).filter(Boolean);
      const dirSegments = renderedSegments.slice(0, -1);

      if (dirSegments.length === 0) return "";
      if (volumeDirIndex >= 0) return volumeDirIndex > 0 ? path.join(...dirSegments.slice(0, volumeDirIndex)) : "";
      return path.join(...dirSegments);
    };

    const trackTemplateForAlbum = pickTrackTemplate(Number(canonicalAlbum.volumeCount || 1));
    // The album directory is identical for every track on the album, but it is
    // rendered from the naming template (regex-heavy). Cache the rendered relative
    // dir by release group so a 12-track album renders it once, not 12 times —
    // this (plus the artist-folder cache above) is the bulk of the rename cost.
    const albumDirRelative = ((): string => {
      if (cache && releaseGroupMbid) {
        // A batch can span artists, providers, and stereo/spatial editions.
        // Preserve uncached rendering semantics even when custom album folders
        // consume provider or artist tokens by keying every album-level input.
        const key = JSON.stringify([
          releaseGroupMbid,
          canonicalReleaseMbid ?? null,
          resolvedProvider || null,
          artistName,
          String(row.artist_id),
          artistMbId,
          canonicalAlbum.title || "Unknown Album",
          canonicalAlbum.albumType || null,
          canonicalAlbum.albumMbid || releaseGroupMbid,
          releaseYear,
          Number(canonicalAlbum.volumeCount || 1),
          trackTemplateForAlbum,
        ]);
        const hit = cache.albumDirs.get(key);
        if (hit !== undefined) return hit;
        const resolved = deriveAlbumDirRelativeFromTemplate(trackTemplateForAlbum);
        cache.albumDirs.set(key, resolved);
        return resolved;
      }
      return deriveAlbumDirRelativeFromTemplate(trackTemplateForAlbum);
    })();
    const albumDir = path.join(libraryRootPath, artistFolder, albumDirRelative);

    if (row.file_type === "cover") {
      const name = metadataConfig.album_cover_name || "cover.jpg";
      return { expectedPath: path.join(albumDir, name) };
    }

    if (row.file_type === "video_cover") {
      const coverName = metadataConfig.album_cover_name || "cover.jpg";
      const videoCoverName = `${path.parse(coverName).name}.mp4`;
      return { expectedPath: path.join(albumDir, videoCoverName) };
    }

    if (row.file_type === "nfo" && !row.media_id) {
      return { expectedPath: path.join(albumDir, "album.nfo") };
    }

    if (row.file_type === "track") {
      if (!row.media_id && !canonicalIdentity.canonicalTrackMbid) return { expectedPath: null, reason: "missing_media_id" };
      const trackMbidKey = String(canonicalIdentity.canonicalTrackMbid || "").trim();
      const canonicalTrack = (cache && trackMbidKey && cache.trackMeta.has(trackMbidKey))
        ? cache.trackMeta.get(trackMbidKey)!
        : getCanonicalTrackMetadata(canonicalIdentity.canonicalTrackMbid);
      if (!canonicalTrack) return { expectedPath: null, reason: "track_not_found" };

      const artistMbidKey = String(canonicalTrack.recording_artist_mbid || "").trim();
      const trackArtist = artistMbidKey
        ? ((cache && cache.artistMeta.has(artistMbidKey))
            ? cache.artistMeta.get(artistMbidKey)
            : (db.prepare("SELECT name, mbid FROM ArtistMetadata WHERE mbid = ?").get(canonicalTrack.recording_artist_mbid) as any))
        : null;

      const ext = row.extension || path.extname(row.file_path).replace(".", "");
      // canonicalTrack already carries title/position/medium_position (same columns
      // getCanonicalTrackPosition would re-query), so derive the position in memory
      // and skip a per-track query.
      const canonicalPosition = (canonicalTrack && Number(canonicalTrack.position || 0))
        ? {
            trackMbid: canonicalTrack.mbid,
            title: canonicalTrack.title,
            trackNumber: Number(canonicalTrack.position),
            volumeNumber: Number(canonicalTrack.medium_position || 1),
          }
        : null;
      const trackContext: NamingContext = {
        ...albumContext,
        trackTitle: canonicalPosition?.title || canonicalTrack?.title || canonicalTrack?.recording_title || "Unknown Track",
        trackId: String(row.media_id ?? canonicalTrack?.mbid ?? ""),
        trackMbId: canonicalTrack?.mbid || null,
        explicit: false,
        trackArtistName: (trackArtist?.name as string | undefined) || artistName,
        trackArtistMbId: trackArtist?.mbid ? String(trackArtist.mbid) : artistMbId,
        trackNumber: canonicalPosition?.trackNumber ?? canonicalTrack?.position,
        volumeNumber: canonicalPosition?.volumeNumber ?? canonicalTrack?.medium_position,
        // Quality metadata from TrackFiles
        quality: row.quality || null,
        codec: row.codec || null,
        bitrate: row.bitrate || null,
        sampleRate: row.sample_rate || null,
        bitDepth: row.bit_depth || null,
        channels: row.channels || null,
      };

      const trackTemplate = pickTrackTemplate(Number(canonicalAlbum.volumeCount || 1));
      const renderedTrackPath = renderRelativePath(trackTemplate, trackContext);
      const baseExpectedPath = path.join(libraryRootPath, artistFolder, `${renderedTrackPath}.${ext}`);
      const relativeTrackPath = renderAudioRelativePathForLibrary({
        relativePath: renderedTrackPath,
        quality: row.quality,
        musicRoot: cache?.libraryRoots.music ?? getCurrentLibraryRootPath("music"),
        spatialRoot: cache?.libraryRoots.spatial ?? getCurrentLibraryRootPath("spatial"),
        mustDisambiguate: mustDisambiguateTrackPath(baseExpectedPath, row.id, cache),
      });
      const fileName = `${relativeTrackPath}.${ext}`;

      return {
        expectedPath: path.join(libraryRootPath, artistFolder, fileName),
      };
    }

    if (row.file_type === "lyrics") {
      if (!row.media_id && !canonicalIdentity.canonicalTrackMbid) return { expectedPath: null, reason: "missing_media_id" };
      const slot = row.library_slot || "stereo";
      // Prefer an exact provider_id match so a radio-edit lyric does not bind to
      // an extended cut that shares a remapped canonical_track_mbid (OR + ORDER
      // BY id ASC previously preferred the wrong TrackFile).
      const trackFileByProvider = row.provider && row.media_id
        ? db.prepare(`
            SELECT id, artist_id, NULL AS album_id, provider_id AS media_id,
                   canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
                   canonical_track_mbid, canonical_recording_mbid,
                   file_path, relative_path, library_root, file_type, extension,
                   library_slot, provider, provider_entity_type, provider_id,
                   quality, codec, bitrate, sample_rate, bit_depth, channels
            FROM TrackFiles
            WHERE provider = ?
              AND provider_entity_type = 'track'
              AND provider_id IS NOT NULL
              AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
              AND file_type = 'track'
              AND library_slot = ?
            ORDER BY id ASC
            LIMIT 1
          `).get(row.provider, String(row.media_id), slot) as LibraryFileRow | undefined
        : undefined;
      const trackFileByCanonical = !trackFileByProvider && canonicalIdentity.canonicalTrackMbid
        ? db.prepare(`
            SELECT id, artist_id, NULL AS album_id, provider_id AS media_id,
                   canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
                   canonical_track_mbid, canonical_recording_mbid,
                   file_path, relative_path, library_root, file_type, extension,
                   library_slot, provider, provider_entity_type, provider_id,
                   quality, codec, bitrate, sample_rate, bit_depth, channels
            FROM TrackFiles
            WHERE canonical_track_mbid IS NOT NULL
              AND canonical_track_mbid = ?
              AND file_type = 'track'
              AND library_slot = ?
            ORDER BY id ASC
            LIMIT 1
          `).get(canonicalIdentity.canonicalTrackMbid, slot) as LibraryFileRow | undefined
        : undefined;
      const trackFile = trackFileByProvider || trackFileByCanonical
        || (row.provider && row.media_id
          ? db.prepare(`
              SELECT id, artist_id, NULL AS album_id, provider_id AS media_id,
                     canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
                     canonical_track_mbid, canonical_recording_mbid,
                     file_path, relative_path, library_root, file_type, extension,
                     library_slot, provider, provider_entity_type, provider_id,
                     quality, codec, bitrate, sample_rate, bit_depth, channels
              FROM TrackFiles
              WHERE provider = ?
                AND provider_entity_type = 'track'
                AND provider_id IS NOT NULL
                AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
                AND file_type = 'track'
              ORDER BY id ASC
              LIMIT 1
            `).get(row.provider, String(row.media_id)) as LibraryFileRow | undefined
          : undefined);

      // Lidarr-style: lyrics follow their linked audio file's stem.
      if (trackFile) {
        const audioExpected = LibraryFilesService.computeExpectedPath(trackFile, cache).expectedPath
          || resolveStoredLibraryPath({
            filePath: trackFile.file_path,
            libraryRoot: trackFile.library_root,
            relativePath: trackFile.relative_path,
          });
        if (audioExpected) {
          const lyricExtension = String(row.extension || "lrc").toLowerCase() === "txt" ? ".txt" : ".lrc";
          return {
            expectedPath: audioExpected.replace(new RegExp(`${path.extname(audioExpected).replace(".", "\\.")}$`), lyricExtension),
          };
        }
      }

      const canonicalTrack = getCanonicalTrackMetadata(
        trackFile?.canonical_track_mbid || canonicalIdentity.canonicalTrackMbid,
      );
      if (!canonicalTrack) return { expectedPath: null, reason: "track_not_found" };

      const trackArtist = canonicalTrack.recording_artist_mbid
        ? (db.prepare("SELECT name, mbid FROM ArtistMetadata WHERE mbid = ?").get(canonicalTrack.recording_artist_mbid) as any)
        : null;

      const ext = (trackFile?.extension as string | undefined) || "flac";
      const positionMbid = trackFile?.canonical_track_mbid || canonicalIdentity.canonicalTrackMbid;
      const canonicalPosition = getCanonicalTrackPosition(positionMbid);
      const trackContext: NamingContext = {
        ...albumContext,
        trackTitle: canonicalPosition?.title || canonicalTrack?.title || canonicalTrack?.recording_title || "Unknown Track",
        trackId: String(row.media_id ?? canonicalTrack?.mbid ?? ""),
        trackMbId: canonicalTrack?.mbid || null,
        explicit: false,
        trackArtistName: (trackArtist?.name as string | undefined) || artistName,
        trackArtistMbId: trackArtist?.mbid ? String(trackArtist.mbid) : artistMbId,
        trackNumber: canonicalPosition?.trackNumber ?? canonicalTrack?.position,
        volumeNumber: canonicalPosition?.volumeNumber ?? canonicalTrack?.medium_position,
        // Quality metadata from TrackFiles
        quality: row.quality || null,
        codec: row.codec || null,
        bitrate: row.bitrate || null,
        sampleRate: row.sample_rate || null,
        bitDepth: row.bit_depth || null,
        channels: row.channels || null,
      };

      const trackTemplate = pickTrackTemplate(Number(canonicalAlbum.volumeCount || 1));
      const relativeTrackPath = renderAudioRelativePathForLibrary({
        relativePath: renderRelativePath(trackTemplate, trackContext),
        quality: row.quality,
        musicRoot: cache?.libraryRoots.music ?? getCurrentLibraryRootPath("music"),
        spatialRoot: cache?.libraryRoots.spatial ?? getCurrentLibraryRootPath("spatial"),
      });
      const trackPath = path.join(libraryRootPath, artistFolder, `${relativeTrackPath}.${ext}`);
      const lyricExtension = String(row.extension || "lrc").toLowerCase() === "txt" ? ".txt" : ".lrc";
      const lyricPath = trackPath.replace(new RegExp(`${path.extname(trackPath)}$`), lyricExtension);
      return { expectedPath: lyricPath };
    }

    return { expectedPath: null, reason: `unsupported_file_type:${row.file_type}` };
  }

  private static getSidecarIdentity(
    tableName: "MetadataFiles" | "LyricFiles" | "ExtraFiles",
    params: {
      artistId: string;
      albumId?: string | null;
      mediaId?: string | null;
      fileType: string;
      libraryRoot?: string | null;
      librarySlot?: string | null;
      provider?: string | null;
      providerEntityType?: string | null;
      providerId?: string | null;
    }
  ): { sql: string; values: Array<string | null> } | null {
    const {
      artistId,
      albumId,
      mediaId,
      fileType,
      librarySlot,
      provider,
      providerEntityType,
      providerId,
      libraryRoot,
    } = params;
    const slotValue = librarySlot || "stereo";
    const exactProviderClause = provider && providerEntityType && providerId
      ? " OR (provider = ? AND provider_entity_type = ? AND provider_id = ?)"
      : "";
    const exactProviderValues = provider && providerEntityType && providerId
      ? [provider, providerEntityType, providerId]
      : [];
    const rootClause = libraryRoot ? " AND library_root = ?" : "";
    const rootValues = libraryRoot ? [libraryRoot] : [];

    if (mediaId) {
      if (tableName === "LyricFiles") {
        return {
          sql: `(canonical_track_mbid = ? OR canonical_recording_mbid = ?${exactProviderClause}) AND library_slot = ?${rootClause}`,
          values: [mediaId, mediaId, ...exactProviderValues, slotValue, ...rootValues],
        };
      } else {
        return {
          sql: `(canonical_track_mbid = ? OR canonical_recording_mbid = ?${exactProviderClause}) AND file_type = ? AND library_slot = ?${rootClause}`,
          values: [mediaId, mediaId, ...exactProviderValues, fileType, slotValue, ...rootValues],
        };
      }
    }

    if (albumId && !mediaId) {
      if (tableName === "LyricFiles") {
        return {
          sql: `(canonical_release_group_mbid = ? OR canonical_release_mbid = ?${exactProviderClause}) AND canonical_track_mbid IS NULL AND canonical_recording_mbid IS NULL AND library_slot = ?${rootClause}`,
          values: [albumId, albumId, ...exactProviderValues, slotValue, ...rootValues],
        };
      } else {
        return {
          sql: `(canonical_release_group_mbid = ? OR canonical_release_mbid = ?${exactProviderClause}) AND canonical_track_mbid IS NULL AND canonical_recording_mbid IS NULL AND file_type = ? AND library_slot = ?${rootClause}`,
          values: [albumId, albumId, ...exactProviderValues, fileType, slotValue, ...rootValues],
        };
      }
    }

    if (!albumId && !mediaId && provider && providerEntityType && providerId) {
      if (tableName === "LyricFiles") {
        return {
          sql: `provider = ? AND provider_entity_type = ? AND provider_id = ? AND library_slot = ?${rootClause}`,
          values: [provider, providerEntityType, providerId, slotValue, ...rootValues],
        };
      }
      return {
        sql: `provider = ? AND provider_entity_type = ? AND provider_id = ? AND file_type = ? AND library_slot = ?${rootClause}`,
        values: [provider, providerEntityType, providerId, fileType, slotValue, ...rootValues],
      };
    }

    if (!albumId && !mediaId) {
      if (tableName === "LyricFiles") {
        return {
          sql: `artist_id = ? AND canonical_release_group_mbid IS NULL AND canonical_release_mbid IS NULL AND canonical_track_mbid IS NULL AND canonical_recording_mbid IS NULL AND provider_id IS NULL AND library_slot = ?${rootClause}`,
          values: [artistId, slotValue, ...rootValues],
        };
      } else {
        return {
          sql: `artist_id = ? AND canonical_release_group_mbid IS NULL AND canonical_release_mbid IS NULL AND canonical_track_mbid IS NULL AND canonical_recording_mbid IS NULL AND provider_id IS NULL AND file_type = ? AND library_slot = ?${rootClause}`,
          values: [artistId, fileType, slotValue, ...rootValues],
        };
      }
    }

    return null;
  }

  static findTrackedAssetRecordId(params: {
    artistId: string;
    albumId?: string | null;
    mediaId?: string | null;
    fileType: string;
    libraryRoot?: string | null;
    preferredPath?: string | null;
    librarySlot?: string | null;
    provider?: string | null;
    providerEntityType?: string | null;
    providerId?: string | null;
  }): number | null {
    const tableName = isLyricExtraFileType(params.fileType) ? "LyricFiles" :
                      isMetadataExtraFileType(params.fileType) ? "MetadataFiles" : "ExtraFiles";

    const identity = this.getSidecarIdentity(tableName, params);
    if (!identity) {
      return null;
    }

    const row = db.prepare(`
      SELECT id
      FROM ${tableName}
      WHERE ${identity.sql}
      ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, last_updated DESC, id DESC
      LIMIT 1
    `).get(...identity.values, params.preferredPath || "") as { id: number } | undefined;

    return row?.id ?? null;
  }

  private static upsertExtraFileRecord(
    params: LibraryFileUpsertParams,
    identity: ReturnType<typeof resolveLibraryFileIdentity>,
    libraryId: number | null,
  ): void {
    if (!isExtraFileType(params.fileType)) {
      return;
    }

    const input = {
      artistId: params.artistId,
      libraryId,
      albumId: params.albumId || null,
      mediaId: params.mediaId || null,
      trackFileId: params.trackFileId || null,
      filePath: params.filePath,
      libraryRoot: params.libraryRoot,
      fileType: params.fileType,
      provider: identity.provider,
      providerEntityType: identity.providerEntityType,
      providerId: identity.providerId,
      librarySlot: identity.librarySlot,
      quality: params.quality || null,
      expectedPath: params.expectedPath || params.filePath,
      canonicalArtistMbid: identity.canonicalArtistMbid,
      canonicalReleaseGroupMbid: identity.canonicalReleaseGroupMbid,
      canonicalReleaseMbid: identity.canonicalReleaseMbid,
      canonicalTrackMbid: identity.canonicalTrackMbid,
      canonicalRecordingMbid: identity.canonicalRecordingMbid,
    };

    if (isLyricExtraFileType(params.fileType)) {
      LyricFileService.upsert(input);
      return;
    }

    if (isMetadataExtraFileType(params.fileType)) {
      MetadataFileService.upsert(input);
      return;
    }

    ExtraFileService.upsert(input);
  }

  static upsertLibraryFile(params: LibraryFileUpsertParams) {
    const ownershipRoot = resolveLibraryRootPath(params.libraryRoot, params.filePath)
      ?? params.libraryRoot;
    if (!resolvedPathIsInsideRoot(params.filePath, ownershipRoot)) {
      throw new Error(
        `Cannot persist ${params.filePath}: path is outside the library root ${ownershipRoot}`,
      );
    }
    if (
      params.expectedPath
      && !resolvedPathIsInsideRoot(params.expectedPath, ownershipRoot)
    ) {
      throw new Error(
        `Cannot persist expected path ${params.expectedPath}: path is outside the library root ${ownershipRoot}`,
      );
    }
    if (!String(params.artistId || "").trim()) {
      throw new Error(`Cannot persist ${params.filePath}: artist id is required`);
    }

    const relativePath = path.relative(params.libraryRoot, params.filePath);
    const filename = path.basename(params.filePath);
    const extension = path.extname(params.filePath).replace(".", "");
    const existingPathRow = db.prepare(`
      SELECT id, artist_id, NULL AS album_id, provider_id AS media_id, file_path, relative_path, library_root, file_type, quality
      FROM TrackFiles
      WHERE file_path = ?
      LIMIT 1
    `).get(params.filePath) as ExistingLibraryFileIdentity | undefined;

    let fileSize: number | null = null;
    let modifiedAt: string | null = null;

    try {
      const stats = fs.statSync(params.filePath);
      fileSize = stats.size;
      modifiedAt = stats.mtime.toISOString();
    } catch {
      // Allow DB reconciliation even when the file is not yet materialized.
    }

    const expectedPath = params.expectedPath || params.filePath;
    const canonicalIdentity = resolveLibraryFileIdentity(params);
    const catalogIds = db.prepare(`
      SELECT
        (SELECT id FROM Albums WHERE mbid = ?) AS release_group_id,
        (SELECT id FROM AlbumEditions WHERE mbid = ?) AS album_edition_id,
        (SELECT id FROM Tracks WHERE mbid = ?) AS track_id,
        (SELECT id FROM Recordings WHERE mbid = ?) AS recording_id
    `).get(
      canonicalIdentity.canonicalReleaseGroupMbid,
      canonicalIdentity.canonicalReleaseMbid,
      canonicalIdentity.canonicalTrackMbid,
      canonicalIdentity.canonicalRecordingMbid,
    ) as {
      release_group_id: number | null;
      album_edition_id: number | null;
      track_id: number | null;
      recording_id: number | null;
    };
    const targetRoot = normalizeComparablePath(params.libraryRoot);
    const matchingLibraries = (db.prepare(`
      SELECT id, root_path
      FROM Libraries
      WHERE enabled = 1
      ORDER BY id
    `).all() as Array<{ id: number; root_path: string }>).filter((library) =>
      normalizeComparablePath(library.root_path) === targetRoot
    );
    const requestedLibraryId = params.libraryId == null ? null : Number(params.libraryId);
    /**
     * The library that owns the root the file is actually in wins.
     *
     * A Library is a root plus a quality profile, so "which library" and "which
     * directory" are one fact. The organizer decides the destination root from
     * the resolved audio slot (spatial audio goes to the spatial root) while the
     * library id travels separately on the download job, and the two disagree
     * whenever a plan queued against the stereo library delivers spatial audio.
     * That threw "Library 1 does not own root /library/spatial-music" and failed
     * the import outright.
     *
     * Deferring to the requested id instead would be worse: the file is on disk
     * under a root, and a row claiming it belongs to a library whose root it is
     * not under is simply wrong. Where no library owns the root at all there is
     * nothing to defer to, and the id is left unset rather than invented.
     */
    const ownerOfRoot = matchingLibraries.length === 1 ? matchingLibraries[0].id : null;
    const requestedOwnsRoot = requestedLibraryId != null
      && matchingLibraries.some((library) => library.id === requestedLibraryId);
    if (requestedLibraryId != null && !requestedOwnsRoot && ownerOfRoot != null) {
      console.warn(
        `[LibraryFiles] ${params.filePath} is under ${params.libraryRoot}, which belongs to library `
        + `${ownerOfRoot}, not the requested library ${requestedLibraryId}; recording it under ${ownerOfRoot}.`,
      );
    }
    const libraryId = requestedOwnsRoot ? requestedLibraryId : ownerOfRoot;
    const fileClass = params.fileClass
      ?? (params.fileType === "track" ? "audio" : params.fileType === "video" ? "video" : null);

    if (this.isTrackedAssetFileType(params.fileType)) {
      const tableName = isLyricExtraFileType(params.fileType) ? "LyricFiles" :
                        isMetadataExtraFileType(params.fileType) ? "MetadataFiles" : "ExtraFiles";
      const selectQuality = tableName === "LyricFiles" ? "Quality" : "NULL AS Quality";

      const existingSidecarRow = db.prepare(`
        SELECT id, file_path, library_root, relative_path, ${selectQuality}
        FROM ${tableName}
        WHERE file_path = ?
        LIMIT 1
      `).get(params.filePath) as { id: number; file_path: string; library_root: string; relative_path: string; Quality?: string | null } | undefined;

      this.upsertExtraFileRecord(params, canonicalIdentity, libraryId);
      const insertedId = ExtraFileService.findIdByPath(tableName, params.filePath) || 0;

      if (params.removeFromUnmapped !== false) {
        db.prepare("DELETE FROM UnmappedFiles WHERE file_path = ?").run(params.filePath);
      }

      this.enforceTrackedAssetIdentity({
        artistId: params.artistId,
        albumId: params.albumId || null,
        mediaId: params.mediaId || null,
        fileType: params.fileType,
        libraryRoot: params.libraryRoot,
        librarySlot: canonicalIdentity.librarySlot,
        provider: canonicalIdentity.provider,
        providerEntityType: canonicalIdentity.providerEntityType,
        providerId: canonicalIdentity.providerId,
      });

      if (!existingSidecarRow) {
        this.emitFileAdded({
          libraryFileId: insertedId || null,
          artistId: params.artistId,
          albumId: params.albumId || null,
          mediaId: params.mediaId || null,
          fileType: params.fileType,
          filePath: params.filePath,
          libraryRoot: params.libraryRoot,
          quality: params.quality || null,
        });
      } else if (
        normalizeResolvedPath(existingSidecarRow.file_path) !== normalizeResolvedPath(params.filePath) ||
        (existingSidecarRow.Quality ?? null) !== (params.quality ?? null)
      ) {
        this.emitFileUpgraded({
          libraryFileId: insertedId,
          artistId: params.artistId,
          albumId: params.albumId || null,
          mediaId: params.mediaId || null,
          fileType: params.fileType,
          filePath: params.filePath,
          libraryRoot: params.libraryRoot,
          quality: params.quality || null,
          previousPath: existingSidecarRow.file_path,
          previousQuality: existingSidecarRow.Quality || null,
        });
      }

      return insertedId;
    }

    if (libraryId == null) {
      const reason = matchingLibraries.length === 0
        ? "no enabled library matches the requested root"
        : "multiple enabled libraries share the requested root";
      throw new Error(
        `Cannot assign playable file ${params.filePath}: ${reason}; provide libraryId`,
      );
    }

    if (
      existingPathRow?.library_id != null
      && existingPathRow.library_id !== libraryId
    ) {
      throw new Error(
        `Playable file ${params.filePath} already belongs to library ${existingPathRow.library_id}`,
      );
    }

    if (
      canonicalIdentity.provider
      && canonicalIdentity.providerId
      && canonicalIdentity.providerEntityType
      && (params.fileType === "track" || params.fileType === "video")
    ) {
      const existingRow = db.prepare(`
        SELECT id, library_id, artist_id, NULL AS album_id, provider_id AS media_id, file_path, relative_path, library_root, file_type, quality
        FROM TrackFiles
        WHERE provider = ?
          AND provider_entity_type = ?
          AND provider_id = ?
          AND file_type = ?
          AND library_id = ?
        ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, verified_at DESC, id DESC
        LIMIT 1
      `).get(
        canonicalIdentity.provider,
        canonicalIdentity.providerEntityType,
        canonicalIdentity.providerId,
        params.fileType,
        libraryId,
        params.filePath,
      ) as ExistingLibraryFileIdentity | undefined;

      if (existingRow) {
        const rowToUpdate = existingPathRow && existingPathRow.id !== existingRow.id
          ? existingPathRow
          : existingRow;

        if (rowToUpdate.id !== existingRow.id) {
          db.prepare("DELETE FROM TrackFiles WHERE id = ?").run(existingRow.id);
        }

        db.prepare(`
          UPDATE TrackFiles
          SET library_id = ?,
              artist_id = ?,
              release_group_id = COALESCE(?, release_group_id),
              album_edition_id = COALESCE(?, album_edition_id),
              track_id = COALESCE(?, track_id),
              recording_id = COALESCE(?, recording_id),
              canonical_artist_mbid = COALESCE(?, canonical_artist_mbid),
              canonical_release_group_mbid = COALESCE(?, canonical_release_group_mbid),
              canonical_release_mbid = COALESCE(?, canonical_release_mbid),
              canonical_track_mbid = COALESCE(?, canonical_track_mbid),
              canonical_recording_mbid = COALESCE(?, canonical_recording_mbid),
              provider = COALESCE(?, provider),
              provider_entity_type = COALESCE(?, provider_entity_type),
              provider_id = COALESCE(?, provider_id),
              library_slot = COALESCE(?, library_slot),
              file_path = ?,
              relative_path = ?,
              library_root = ?,
              filename = ?,
              extension = ?,
              file_size = ?,
              file_type = ?,
              quality = ?,
              naming_template = COALESCE(?, naming_template),
              expected_path = ?,
              needs_rename = CASE WHEN ? IS NOT NULL AND ? != ? THEN 1 ELSE 0 END,
              modified_at = ?,
              verified_at = CURRENT_TIMESTAMP,
              bit_depth = COALESCE(?, bit_depth),
              sample_rate = COALESCE(?, sample_rate),
              bitrate = COALESCE(?, bitrate),
              codec = COALESCE(?, codec),
              video_codec = COALESCE(?, video_codec),
              channels = COALESCE(?, channels),
              width = COALESCE(?, width),
              height = COALESCE(?, height),
              duration = COALESCE(?, duration),
              fingerprint = COALESCE(?, fingerprint)
          WHERE id = ?
        `).run(
          libraryId,
          params.artistId,
          catalogIds.release_group_id,
          catalogIds.album_edition_id,
          catalogIds.track_id,
          catalogIds.recording_id,
          canonicalIdentity.canonicalArtistMbid,
          canonicalIdentity.canonicalReleaseGroupMbid,
          canonicalIdentity.canonicalReleaseMbid,
          canonicalIdentity.canonicalTrackMbid,
          canonicalIdentity.canonicalRecordingMbid,
          canonicalIdentity.provider,
          canonicalIdentity.providerEntityType,
          canonicalIdentity.providerId,
          canonicalIdentity.librarySlot,
          params.filePath,
          relativePath,
          params.libraryRoot,
          filename,
          extension,
          fileSize,
          params.fileType,
          params.quality || null,
          params.namingTemplate || null,
          expectedPath,
          expectedPath,
          expectedPath,
          params.filePath,
          modifiedAt,
          params.bitDepth || null,
          params.sampleRate || null,
          params.bitrate || null,
          params.codec || null,
          params.videoCodec || null,
          params.channels || null,
          params.width || null,
          params.height || null,
          params.duration || null,
          params.fingerprint || null,
          rowToUpdate.id,
        );

        db.prepare(`
          DELETE FROM TrackFiles
          WHERE provider = ?
            AND provider_entity_type = ?
            AND provider_id = ?
            AND file_type = ?
            AND library_id = ?
            AND id != ?
        `).run(
          canonicalIdentity.provider,
          canonicalIdentity.providerEntityType,
          canonicalIdentity.providerId,
          params.fileType,
          libraryId,
          rowToUpdate.id,
        );

        if (params.removeFromUnmapped !== false) {
          db.prepare("DELETE FROM UnmappedFiles WHERE file_path = ?").run(params.filePath);
        }

        if (hasMeaningfulLibraryFileChange(rowToUpdate, {
          artistId: params.artistId,
          albumId: params.albumId || null,
          mediaId: params.mediaId || null,
          filePath: params.filePath,
          relativePath,
          libraryRoot: params.libraryRoot,
          fileType: params.fileType,
          quality: params.quality || null,
        })) {
          this.emitFileUpgraded({
            libraryFileId: existingRow.id,
            artistId: params.artistId,
            albumId: params.albumId || null,
            mediaId: params.mediaId || null,
            fileType: params.fileType,
            filePath: params.filePath,
            libraryRoot: params.libraryRoot,
            quality: params.quality || null,
            previousPath: rowToUpdate.file_path,
            previousQuality: rowToUpdate.quality || null,
          });
        }

        return rowToUpdate.id;
      }
    }

    if (this.isTrackedAssetFileType(params.fileType)) {
      const existingTrackedAssetId = this.findTrackedAssetRecordId({
        artistId: params.artistId,
        albumId: params.albumId || null,
        mediaId: params.mediaId || null,
        fileType: params.fileType,
        libraryRoot: params.libraryRoot,
        preferredPath: params.filePath,
        librarySlot: canonicalIdentity.librarySlot,
        provider: canonicalIdentity.provider,
        providerEntityType: canonicalIdentity.providerEntityType,
        providerId: canonicalIdentity.providerId,
      });

      if (existingTrackedAssetId !== null) {
        const existingTrackedAsset = db.prepare(`
          SELECT id, artist_id, NULL AS album_id, provider_id AS media_id, file_path, relative_path, library_root, file_type, quality
          FROM TrackFiles
          WHERE id = ?
          LIMIT 1
        `).get(existingTrackedAssetId) as ExistingLibraryFileIdentity | undefined;
        const rowToUpdate = existingPathRow && existingPathRow.id !== existingTrackedAssetId
          ? existingPathRow
          : existingTrackedAsset;

        if (!rowToUpdate) {
          return existingTrackedAssetId;
        }

        if (rowToUpdate.id !== existingTrackedAssetId) {
          db.prepare("DELETE FROM TrackFiles WHERE id = ?").run(existingTrackedAssetId);
        }

        db.prepare(`
          UPDATE TrackFiles
          SET artist_id = ?,
              release_group_id = COALESCE(?, release_group_id),
              album_edition_id = COALESCE(?, album_edition_id),
              track_id = COALESCE(?, track_id),
              recording_id = COALESCE(?, recording_id),
              canonical_artist_mbid = COALESCE(?, canonical_artist_mbid),
              canonical_release_group_mbid = COALESCE(?, canonical_release_group_mbid),
              canonical_release_mbid = COALESCE(?, canonical_release_mbid),
              canonical_track_mbid = COALESCE(?, canonical_track_mbid),
              canonical_recording_mbid = COALESCE(?, canonical_recording_mbid),
              provider = COALESCE(?, provider),
              provider_entity_type = COALESCE(?, provider_entity_type),
              provider_id = COALESCE(?, provider_id),
              library_slot = COALESCE(?, library_slot),
              file_path = ?,
              relative_path = ?,
              library_root = ?,
              filename = ?,
              extension = ?,
              file_size = ?,
              file_type = ?,
              quality = ?,
              naming_template = COALESCE(?, naming_template),
              expected_path = ?,
              needs_rename = CASE WHEN ? IS NOT NULL AND ? != ? THEN 1 ELSE 0 END,
              modified_at = ?,
              verified_at = CURRENT_TIMESTAMP,
              bit_depth = COALESCE(?, bit_depth),
              sample_rate = COALESCE(?, sample_rate),
              bitrate = COALESCE(?, bitrate),
              codec = COALESCE(?, codec),
              video_codec = COALESCE(?, video_codec),
              channels = COALESCE(?, channels),
              width = COALESCE(?, width),
              height = COALESCE(?, height),
              duration = COALESCE(?, duration),
              fingerprint = COALESCE(?, fingerprint)
          WHERE id = ?
        `).run(
          params.artistId,
          catalogIds.release_group_id,
          catalogIds.album_edition_id,
          catalogIds.track_id,
          catalogIds.recording_id,
          canonicalIdentity.canonicalArtistMbid,
          canonicalIdentity.canonicalReleaseGroupMbid,
          canonicalIdentity.canonicalReleaseMbid,
          canonicalIdentity.canonicalTrackMbid,
          canonicalIdentity.canonicalRecordingMbid,
          canonicalIdentity.provider,
          canonicalIdentity.providerEntityType,
          canonicalIdentity.providerId,
          canonicalIdentity.librarySlot,
          params.filePath,
          relativePath,
          params.libraryRoot,
          filename,
          extension,
          fileSize,
          params.fileType,
          params.quality || null,
          params.namingTemplate || null,
          expectedPath,
          expectedPath,
          expectedPath,
          params.filePath,
          modifiedAt,
          params.bitDepth || null,
          params.sampleRate || null,
          params.bitrate || null,
          params.codec || null,
          params.videoCodec || null,
          params.channels || null,
          params.width || null,
          params.height || null,
          params.duration || null,
          params.fingerprint || null,
          rowToUpdate.id,
        );

        if (params.removeFromUnmapped !== false) {
          db.prepare("DELETE FROM UnmappedFiles WHERE file_path = ?").run(params.filePath);
        }

        this.enforceTrackedAssetIdentity({
          artistId: params.artistId,
          albumId: params.albumId || null,
          mediaId: params.mediaId || null,
          fileType: params.fileType,
          libraryRoot: params.libraryRoot,
          librarySlot: canonicalIdentity.librarySlot,
          provider: canonicalIdentity.provider,
          providerEntityType: canonicalIdentity.providerEntityType,
          providerId: canonicalIdentity.providerId,
        });

        if (
          rowToUpdate
          && hasMeaningfulLibraryFileChange(rowToUpdate, {
            artistId: params.artistId,
            albumId: params.albumId || null,
            mediaId: params.mediaId || null,
            filePath: params.filePath,
            relativePath,
            libraryRoot: params.libraryRoot,
            fileType: params.fileType,
            quality: params.quality || null,
          })
        ) {
          this.emitFileUpgraded({
            libraryFileId: rowToUpdate.id,
            artistId: params.artistId,
            albumId: params.albumId || null,
            mediaId: params.mediaId || null,
            fileType: params.fileType,
            filePath: params.filePath,
            libraryRoot: params.libraryRoot,
            quality: params.quality || null,
            previousPath: rowToUpdate.file_path,
            previousQuality: rowToUpdate.quality || null,
          });
        }

        return rowToUpdate.id;
      }
    }

    const insert = db.prepare(`
      INSERT INTO TrackFiles (
        artist_id,
        library_id, release_group_id, album_edition_id, track_id, recording_id,
        source_audio_variant_id, file_class, source_quality, imported_quality,
        canonical_artist_mbid, canonical_release_group_mbid,
        canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
        provider, provider_entity_type, provider_id, library_slot,
        file_path, relative_path, library_root,
        filename, extension, file_size,
        file_type, quality,
        naming_template, expected_path, needs_rename,
        modified_at, verified_at,
        bit_depth, sample_rate, bitrate, codec, video_codec, channels, width, height,
        duration, fingerprint
      ) VALUES (
        ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, 0,
        ?, CURRENT_TIMESTAMP,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(file_path) DO UPDATE SET
        artist_id = excluded.artist_id,
        library_id = COALESCE(excluded.library_id, TrackFiles.library_id),
        release_group_id = COALESCE(excluded.release_group_id, TrackFiles.release_group_id),
        album_edition_id = COALESCE(excluded.album_edition_id, TrackFiles.album_edition_id),
        track_id = COALESCE(excluded.track_id, TrackFiles.track_id),
        recording_id = COALESCE(excluded.recording_id, TrackFiles.recording_id),
        source_audio_variant_id = COALESCE(excluded.source_audio_variant_id, TrackFiles.source_audio_variant_id),
        file_class = COALESCE(excluded.file_class, TrackFiles.file_class),
        source_quality = COALESCE(excluded.source_quality, TrackFiles.source_quality),
        imported_quality = COALESCE(excluded.imported_quality, TrackFiles.imported_quality),
        canonical_artist_mbid = COALESCE(excluded.canonical_artist_mbid, TrackFiles.canonical_artist_mbid),
        canonical_release_group_mbid = COALESCE(excluded.canonical_release_group_mbid, TrackFiles.canonical_release_group_mbid),
        canonical_release_mbid = COALESCE(excluded.canonical_release_mbid, TrackFiles.canonical_release_mbid),
        canonical_track_mbid = COALESCE(excluded.canonical_track_mbid, TrackFiles.canonical_track_mbid),
        canonical_recording_mbid = COALESCE(excluded.canonical_recording_mbid, TrackFiles.canonical_recording_mbid),
        provider = COALESCE(excluded.provider, TrackFiles.provider),
        provider_entity_type = COALESCE(excluded.provider_entity_type, TrackFiles.provider_entity_type),
        provider_id = COALESCE(excluded.provider_id, TrackFiles.provider_id),
        library_slot = COALESCE(excluded.library_slot, TrackFiles.library_slot),
        relative_path = excluded.relative_path,
        library_root = excluded.library_root,
        filename = excluded.filename,
        extension = excluded.extension,
        file_size = excluded.file_size,
        file_type = excluded.file_type,
        quality = excluded.quality,
        naming_template = COALESCE(excluded.naming_template, TrackFiles.naming_template),
        expected_path = excluded.expected_path,
        needs_rename = CASE WHEN excluded.expected_path IS NOT NULL AND excluded.expected_path != excluded.file_path THEN 1 ELSE 0 END,
        modified_at = excluded.modified_at,
        verified_at = CURRENT_TIMESTAMP,
        bit_depth = COALESCE(excluded.bit_depth, TrackFiles.bit_depth),
        sample_rate = COALESCE(excluded.sample_rate, TrackFiles.sample_rate),
        bitrate = COALESCE(excluded.bitrate, TrackFiles.bitrate),
        codec = COALESCE(excluded.codec, TrackFiles.codec),
        video_codec = COALESCE(excluded.video_codec, TrackFiles.video_codec),
        channels = COALESCE(excluded.channels, TrackFiles.channels),
        width = COALESCE(excluded.width, TrackFiles.width),
        height = COALESCE(excluded.height, TrackFiles.height),
        duration = COALESCE(excluded.duration, TrackFiles.duration),
        fingerprint = COALESCE(excluded.fingerprint, TrackFiles.fingerprint)
    `);

    insert.run(
      params.artistId,
      libraryId,
      catalogIds.release_group_id,
      catalogIds.album_edition_id,
      catalogIds.track_id,
      catalogIds.recording_id,
      params.sourceAudioVariantId ?? null,
      fileClass,
      params.sourceQuality ?? params.quality ?? null,
      params.importedQuality ?? params.quality ?? null,
      canonicalIdentity.canonicalArtistMbid,
      canonicalIdentity.canonicalReleaseGroupMbid,
      canonicalIdentity.canonicalReleaseMbid,
      canonicalIdentity.canonicalTrackMbid,
      canonicalIdentity.canonicalRecordingMbid,
      canonicalIdentity.provider,
      canonicalIdentity.providerEntityType,
      canonicalIdentity.providerId,
      canonicalIdentity.librarySlot,
      params.filePath,
      relativePath,
      params.libraryRoot,
      filename,
      extension,
      fileSize,
      params.fileType,
      params.quality || null,
      params.namingTemplate || null,
      expectedPath,
      modifiedAt,
      params.bitDepth || null,
      params.sampleRate || null,
      params.bitrate || null,
      params.codec || null,
      params.videoCodec || null,
      params.channels || null,
      params.width || null,
      params.height || null,
      params.duration || null,
      params.fingerprint || null,
    );

    if (params.removeFromUnmapped !== false) {
      db.prepare("DELETE FROM UnmappedFiles WHERE file_path = ?").run(params.filePath);
    }

    if (this.isTrackedAssetFileType(params.fileType)) {
      this.enforceTrackedAssetIdentity({
        artistId: params.artistId,
        albumId: params.albumId || null,
        mediaId: params.mediaId || null,
        fileType: params.fileType,
        libraryRoot: params.libraryRoot,
        librarySlot: canonicalIdentity.librarySlot,
        provider: canonicalIdentity.provider,
        providerEntityType: canonicalIdentity.providerEntityType,
        providerId: canonicalIdentity.providerId,
      });
    }

    // SQLite leaves `last_insert_rowid()` unchanged when ON CONFLICT takes the
    // UPDATE branch. A previous, unrelated insert can therefore make
    // the statement result's `lastInsertRowid` identify the wrong TrackFiles
    // row. Resolve the
    // operation result from the unique path this statement just persisted.
    const persistedRow = db.prepare(`
      SELECT id FROM TrackFiles WHERE file_path = ? LIMIT 1
    `).get(params.filePath) as { id: number } | undefined;
    if (!persistedRow) {
      throw new Error(
        `TrackFiles upsert for ${params.filePath} completed without a resolvable row`,
      );
    }
    const insertedId = persistedRow.id;

    if (!existingPathRow) {
      this.emitFileAdded({
        libraryFileId: insertedId || null,
        artistId: params.artistId,
        albumId: params.albumId || null,
        mediaId: params.mediaId || null,
        fileType: params.fileType,
        filePath: params.filePath,
        libraryRoot: params.libraryRoot,
        quality: params.quality || null,
      });
    } else if (hasMeaningfulLibraryFileChange(existingPathRow, {
      artistId: params.artistId,
      albumId: params.albumId || null,
      mediaId: params.mediaId || null,
      filePath: params.filePath,
      relativePath,
      libraryRoot: params.libraryRoot,
      fileType: params.fileType,
      quality: params.quality || null,
    })) {
      this.emitFileUpgraded({
        libraryFileId: existingPathRow.id,
        artistId: params.artistId,
        albumId: params.albumId || null,
        mediaId: params.mediaId || null,
        fileType: params.fileType,
        filePath: params.filePath,
        libraryRoot: params.libraryRoot,
        quality: params.quality || null,
        previousPath: existingPathRow.file_path,
        previousQuality: existingPathRow.quality || null,
      });
    }

    return insertedId;
  }

  private static compareTrackedAssets(left: TrackedAssetRow, right: TrackedAssetRow): number {
    const score = (row: TrackedAssetRow) => {
      const resolvedPath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
        relativePath: row.relative_path,
      });
      const computedExpectedPath =
        row.expected_path || this.computeExpectedPath(row).expectedPath || null;
      const normalizedExpected = computedExpectedPath ? normalizeResolvedPath(computedExpectedPath) : "";
      const normalizedResolvedPath = normalizeResolvedPath(resolvedPath);
      const normalizedStoredPath = normalizeResolvedPath(row.file_path);

      return {
        resolvedMatchesExpected: normalizedExpected && normalizedResolvedPath === normalizedExpected ? 1 : 0,
        storedMatchesExpected: normalizedExpected && normalizedStoredPath === normalizedExpected ? 1 : 0,
        exists: fs.existsSync(resolvedPath) ? 1 : 0,
        verified: row.verified_at ? 1 : 0,
        modifiedAt: toTimestamp(row.modified_at),
        createdAt: toTimestamp(row.created_at),
        id: row.id,
      };
    };

    const leftScore = score(left);
    const rightScore = score(right);

    return (
      rightScore.resolvedMatchesExpected - leftScore.resolvedMatchesExpected ||
      rightScore.storedMatchesExpected - leftScore.storedMatchesExpected ||
      rightScore.exists - leftScore.exists ||
      rightScore.verified - leftScore.verified ||
      rightScore.modifiedAt - leftScore.modifiedAt ||
      rightScore.createdAt - leftScore.createdAt ||
      rightScore.id - leftScore.id
    );
  }

  static enforceTrackedAssetIdentity(params: {
    artistId: string;
    albumId?: string | null;
    mediaId?: string | null;
    fileType: string;
    libraryRoot?: string | null;
    librarySlot?: string | null;
    provider?: string | null;
    providerEntityType?: string | null;
    providerId?: string | null;
  }): { removed: number } {
    const tableName = isLyricExtraFileType(params.fileType) ? "LyricFiles" :
                      isMetadataExtraFileType(params.fileType) ? "MetadataFiles" : "ExtraFiles";

    const identity = this.getSidecarIdentity(tableName, params);
    if (!identity) {
      return { removed: 0 };
    }

    const fileTypeSelect = tableName === "LyricFiles" ? "'lyrics' AS file_type" : "file_type AS file_type";

    const rows = db.prepare(`
      SELECT id AS id,
        artist_id AS artist_id,
        COALESCE(canonical_release_group_mbid, canonical_release_mbid) AS album_id,
        COALESCE(canonical_track_mbid, canonical_recording_mbid, provider_id) AS media_id,
        file_path AS file_path,
        relative_path AS relative_path,
        library_root AS library_root,
        ${fileTypeSelect},
        extension AS extension,
        expected_path AS expected_path,
        last_updated AS verified_at,
        last_updated AS modified_at,
        added AS created_at
      FROM ${tableName}
      WHERE ${identity.sql}
      ORDER BY id DESC
    `).all(...identity.values) as TrackedAssetRow[];

    if (rows.length <= 1) {
      return { removed: 0 };
    }

    const folderScoped = !params.mediaId && FOLDER_SCOPED_METADATA_TYPES.has(params.fileType);
    if (!folderScoped) {
      return { removed: this.removeDuplicateTrackedAssetRows(tableName, rows) };
    }

    // Each monitored edition has its own album folder. Cover.jpg / album.nfo in
    // "All This Bad Blood (2012)" and "Bad Blood X (2023)" are not duplicates.
    // A leftover sidecar in a folder with no audio (rename debris) still is.
    const byDirectory = new Map<string, TrackedAssetRow[]>();
    for (const row of rows) {
      const directory = path.dirname(normalizeResolvedPath(resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
        relativePath: row.relative_path,
      })));
      const group = byDirectory.get(directory) ?? [];
      group.push(row);
      byDirectory.set(directory, group);
    }

    const live: TrackedAssetRow[][] = [];
    const stale: TrackedAssetRow[] = [];
    for (const [directory, group] of byDirectory) {
      if (this.directoryHasTrackedAudio(directory)) live.push(group);
      else stale.push(...group);
    }

    if (live.length === 0) {
      return { removed: this.removeDuplicateTrackedAssetRows(tableName, rows) };
    }

    let removed = 0;
    for (const group of live) {
      removed += this.removeDuplicateTrackedAssetRows(tableName, group);
    }
    if (stale.length > 0) {
      removed += this.deleteTrackedAssetRows(tableName, stale);
    }
    if (removed > 0) {
      console.log(`[${tableName}] Removed ${removed} duplicate tracked ${params.fileType} file(s) for artist ${params.artistId}.`);
    }
    return { removed };
  }

  private static removeDuplicateTrackedAssetRows(
    tableName: "MetadataFiles" | "LyricFiles" | "ExtraFiles",
    rows: TrackedAssetRow[],
  ): number {
    if (rows.length <= 1) {
      return 0;
    }

    const [keep, ...remove] = [...rows].sort((left, right) => this.compareTrackedAssets(left, right));
    const keepResolvedPath = normalizeResolvedPath(resolveStoredLibraryPath({
      filePath: keep.file_path,
      libraryRoot: keep.library_root,
      relativePath: keep.relative_path,
    }));

    let removed = 0;
    const idsToDelete: number[] = [];
    for (const row of remove) {
      ExtraFileService.mergeLibraryAssociations(tableName, row.id, keep.id);
      const resolvedPath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
        relativePath: row.relative_path,
      });

      try {
        if (normalizeResolvedPath(resolvedPath) !== keepResolvedPath && fs.existsSync(resolvedPath)) {
          fs.rmSync(resolvedPath, { force: true });
          const root = resolveLibraryRootPath(row.library_root, row.file_path);
          if (root) {
            removeEmptyParents(path.dirname(resolvedPath), root);
          }
        }
      } catch (error) {
        console.warn(`[${tableName}] Failed removing duplicate ${row.file_type} file ${resolvedPath}:`, error);
      }

      idsToDelete.push(row.id);
      this.emitFileDeleted({
        libraryFileId: row.id,
        artistId: row.artist_id,
        albumId: row.album_id,
        mediaId: row.media_id,
        fileType: row.file_type,
        filePath: resolvedPath,
        libraryRoot: row.library_root,
        reason: "duplicate-tracked-asset",
        missing: !fs.existsSync(resolvedPath),
      });
      removed += 1;
    }

    if (idsToDelete.length > 0) {
      batchDelete(tableName, idsToDelete);
    }

    return removed;
  }

  private static deleteTrackedAssetRows(
    tableName: "MetadataFiles" | "LyricFiles" | "ExtraFiles",
    rows: TrackedAssetRow[],
  ): number {
    if (rows.length === 0) return 0;
    let removed = 0;
    const idsToDelete: number[] = [];
    for (const row of rows) {
      const resolvedPath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
        relativePath: row.relative_path,
      });
      try {
        if (fs.existsSync(resolvedPath)) {
          fs.rmSync(resolvedPath, { force: true });
          const root = resolveLibraryRootPath(row.library_root, row.file_path);
          if (root) {
            removeEmptyParents(path.dirname(resolvedPath), root);
          }
        }
      } catch (error) {
        console.warn(`[${tableName}] Failed removing stale ${row.file_type} file ${resolvedPath}:`, error);
      }
      idsToDelete.push(row.id);
      this.emitFileDeleted({
        libraryFileId: row.id,
        artistId: row.artist_id,
        albumId: row.album_id,
        mediaId: row.media_id,
        fileType: row.file_type,
        filePath: resolvedPath,
        libraryRoot: row.library_root,
        reason: "duplicate-tracked-asset",
        missing: !fs.existsSync(resolvedPath),
      });
      removed += 1;
    }
    if (idsToDelete.length > 0) {
      batchDelete(tableName, idsToDelete);
    }
    return removed;
  }

  static pruneDuplicateTrackedAssets(artistId?: string): { removed: number } {
    let removed = 0;
    const params = artistId ? [artistId] : [];

    // MetadataFiles duplicates
    const metadataGroups = db.prepare(`
      SELECT artist_id AS artist_id,
             COALESCE(canonical_release_group_mbid, canonical_release_mbid) AS album_id,
             COALESCE(canonical_track_mbid, canonical_recording_mbid) AS media_id,
             provider AS provider,
             provider_entity_type AS provider_entity_type,
             provider_id AS provider_id,
             file_type AS file_type,
             library_root AS library_root,
             library_slot AS library_slot
      FROM MetadataFiles
      ${artistId ? "WHERE artist_id = ?" : ""}
      GROUP BY artist_id, canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid, provider, provider_entity_type, provider_id, file_type, library_root, library_slot
      HAVING COUNT(*) > 1
    `).all(...params) as Array<{
      artist_id: string;
      album_id: string | null;
      media_id: string | null;
      provider: string | null;
      provider_entity_type: string | null;
      provider_id: string | null;
      file_type: string;
      library_root: string;
      library_slot: string;
    }>;

    for (const group of metadataGroups) {
      removed += this.enforceTrackedAssetIdentity({
        artistId: group.artist_id,
        albumId: group.album_id,
        mediaId: group.media_id,
        fileType: group.file_type,
        libraryRoot: group.library_root,
        librarySlot: group.library_slot,
        provider: group.provider,
        providerEntityType: group.provider_entity_type,
        providerId: group.provider_id,
      }).removed;
    }

    // ExtraFiles duplicates
    const extraGroups = db.prepare(`
      SELECT artist_id AS artist_id,
             COALESCE(canonical_release_group_mbid, canonical_release_mbid) AS album_id,
             COALESCE(canonical_track_mbid, canonical_recording_mbid) AS media_id,
             provider AS provider,
             provider_entity_type AS provider_entity_type,
             provider_id AS provider_id,
             file_type AS file_type,
             library_root AS library_root,
             library_slot AS library_slot
      FROM ExtraFiles
      ${artistId ? "WHERE artist_id = ?" : ""}
      GROUP BY artist_id, canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid, provider, provider_entity_type, provider_id, file_type, library_root, library_slot
      HAVING COUNT(*) > 1
    `).all(...params) as Array<{
      artist_id: string;
      album_id: string | null;
      media_id: string | null;
      provider: string | null;
      provider_entity_type: string | null;
      provider_id: string | null;
      file_type: string;
      library_root: string;
      library_slot: string;
    }>;

    for (const group of extraGroups) {
      removed += this.enforceTrackedAssetIdentity({
        artistId: group.artist_id,
        albumId: group.album_id,
        mediaId: group.media_id,
        fileType: group.file_type,
        libraryRoot: group.library_root,
        librarySlot: group.library_slot,
        provider: group.provider,
        providerEntityType: group.provider_entity_type,
        providerId: group.provider_id,
      }).removed;
    }

    // LyricFiles duplicates
    const lyricGroups = db.prepare(`
      SELECT artist_id AS artist_id,
             COALESCE(canonical_release_group_mbid, canonical_release_mbid) AS album_id,
             COALESCE(canonical_track_mbid, canonical_recording_mbid) AS media_id,
             provider AS provider,
             provider_entity_type AS provider_entity_type,
             provider_id AS provider_id,
             library_root AS library_root,
             library_slot AS library_slot
      FROM LyricFiles
      ${artistId ? "WHERE artist_id = ?" : ""}
      GROUP BY artist_id, canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid, provider, provider_entity_type, provider_id, library_root, library_slot
      HAVING COUNT(*) > 1
    `).all(...params) as Array<{
      artist_id: string;
      album_id: string | null;
      media_id: string | null;
      provider: string | null;
      provider_entity_type: string | null;
      provider_id: string | null;
      library_root: string;
      library_slot: string;
    }>;

    for (const group of lyricGroups) {
      removed += this.enforceTrackedAssetIdentity({
        artistId: group.artist_id,
        albumId: group.album_id,
        mediaId: group.media_id,
        fileType: "lyrics",
        libraryRoot: group.library_root,
        librarySlot: group.library_slot,
        provider: group.provider,
        providerEntityType: group.provider_entity_type,
        providerId: group.provider_id,
      }).removed;
    }

    return { removed };
  }

  static pruneStaleTrackedAssets(artistId?: string): { removed: number } {
    let totalRemoved = 0;
    const params = artistId ? [artistId] : [];

    const tables = [
      { name: "MetadataFiles", fileTypeSql: "file_type AS file_type", qualitySql: "NULL AS quality" },
      { name: "ExtraFiles", fileTypeSql: "file_type AS file_type", qualitySql: "NULL AS quality" },
      { name: "LyricFiles", fileTypeSql: "'lyrics' AS file_type", qualitySql: "quality AS quality" },
    ] as const;

    for (const table of tables) {
      const rows = db.prepare(`
        SELECT id AS id,
          artist_id AS artist_id,
          COALESCE(canonical_release_group_mbid, canonical_release_mbid) AS album_id,
          COALESCE(canonical_track_mbid, canonical_recording_mbid, provider_id) AS media_id,
          file_path AS file_path,
          relative_path AS relative_path,
          library_root AS library_root,
          ${table.fileTypeSql},
          ${table.qualitySql}
        FROM ${table.name}
        ${artistId ? "WHERE artist_id = ?" : ""}
        ORDER BY id ASC
      `).all(...params) as Array<{
        id: number;
        artist_id: number;
        album_id: number | null;
        media_id: number | null;
        file_path: string;
        relative_path: string | null;
        library_root: string | null;
        file_type: string;
        quality: string | null;
      }>;

      const idsToDelete: number[] = [];

      for (const row of rows) {
        const resolvedPath = resolveStoredLibraryPath({
          filePath: row.file_path,
          libraryRoot: row.library_root,
          relativePath: row.relative_path,
        });

        if (fs.existsSync(resolvedPath)) {
          continue;
        }

        idsToDelete.push(row.id);
        this.emitFileDeleted({
          libraryFileId: row.id,
          artistId: row.artist_id,
          albumId: row.album_id,
          mediaId: row.media_id,
          fileType: row.file_type,
          filePath: resolvedPath,
          libraryRoot: row.library_root,
          quality: row.quality,
          reason: "stale-tracked-asset",
          missing: true,
        });
      }

      if (idsToDelete.length > 0) {
        batchDelete(table.name, idsToDelete);
        console.log(`[${table.name}] Removed ${idsToDelete.length} stale tracked sidecar row(s).`);
        totalRemoved += idsToDelete.length;
      }
    }

    return { removed: totalRemoved };
  }

  /**
   * Canonical delete-candidate selection for {@link pruneUnmonitoredFiles}.
   *
   * A file is kept when its *edition* (not merely its album) is still monitored
   * in that library, or — for videos — when its recording is in LibraryVideos:
   *  - audio with a known edition (`album_edition_id` or `canonical_release_mbid`):
   *    a `LibraryEditions` row for that exact edition + library;
   *  - audio without edition identity: the album-level `LibraryAlbums` row
   *    (legacy imports we cannot classify more tightly);
   *  - video / recording-scoped files: their exact `Recordings` row.
   *
   * A file is a prune candidate only when it has at least one canonical anchor
   * AND none of those anchors are monitored. Files with no canonical anchor at
   * all are left untouched (unclassifiable — never auto-deleted). Album-level
   * monitoring alone does not keep leftover files from unmonitored editions of
   * a still-monitored album (All This Bad Blood after the user unmonitors it
   * while Bad Blood X stays selected). Filling a hole on the remaining edition
   * is the organizer's job; prune must not leave ghost TrackFiles in a wiped
   * unmonitored folder.
   */
  static selectUnmonitoredFileRows(artistId: string): Array<{
    id: number;
    artist_id: number;
    file_type: string;
    quality: string | null;
    file_path: string;
    library_root: string;
    album_id: number | null;
    media_id: number | null;
  }> {
    return db.prepare(`
      SELECT lf.id, lf.artist_id, NULL AS album_id, lf.provider_id AS media_id, lf.file_type, lf.quality, lf.file_path, lf.library_root
      FROM TrackFiles lf
      JOIN Artists art ON art.id = lf.artist_id
      LEFT JOIN LibraryAlbums library_group
        ON library_group.library_id = lf.library_id
       AND library_group.release_group_id = lf.release_group_id
      LEFT JOIN AlbumEditions file_edition
        ON file_edition.id = COALESCE(
          lf.album_edition_id,
          (
            SELECT edition.id
            FROM AlbumEditions edition
            WHERE edition.mbid = lf.canonical_release_mbid
            LIMIT 1
          )
        )
      LEFT JOIN LibraryEditions library_edition
        ON library_edition.library_id = lf.library_id
       AND library_edition.edition_id = file_edition.id
      LEFT JOIN Recordings rec
        ON rec.id = COALESCE(
          lf.recording_id,
          (
            SELECT recording.id
            FROM Recordings recording
            WHERE recording.mbid = lf.canonical_recording_mbid
            LIMIT 1
          )
        )
      WHERE lf.artist_id = ?
        AND (
          (lf.library_id IS NOT NULL AND lf.release_group_id IS NOT NULL)
          OR lf.recording_id IS NOT NULL
          OR rec.id IS NOT NULL
          OR lf.album_edition_id IS NOT NULL
          OR (lf.canonical_release_mbid IS NOT NULL AND TRIM(lf.canonical_release_mbid) != '')
        )
        AND (
          (
            (lf.file_class = 'video' OR lf.file_type = 'video')
            AND rec.id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM LibraryVideos selected_video
              JOIN Libraries selected_video_library
                ON selected_video_library.id = selected_video.library_id
               AND selected_video_library.enabled = 1
              WHERE selected_video.video_recording_id = rec.id
            )
          )
          OR (
            (lf.file_class IS NULL OR lf.file_class != 'video')
            AND lf.file_type != 'video'
            AND file_edition.id IS NOT NULL
            AND library_edition.id IS NULL
          )
          OR (
            (lf.file_class IS NULL OR lf.file_class != 'video')
            AND lf.file_type != 'video'
            AND file_edition.id IS NULL
            AND library_group.id IS NULL
          )
        )
    `).all(artistId) as Array<{
      id: number;
      artist_id: number;
      file_type: string;
      quality: string | null;
      file_path: string;
      library_root: string;
      album_id: number | null;
      media_id: number | null;
    }>;
  }

  /**
   * Disk scan runs before CurateArtist, so a file can land on an unmonitored
   * sibling edition of the same album (101 Pompeii MMXXIII on Bad Blood X Oct 13
   * while curation later selects the Jan 1 edition). Re-resolve identity now
   * that LibraryEditions exist: the unique monitored edition that carries this
   * recording wins, matching download-import remap.
   */
  static rebindFilesToMonitoredEditions(artistId: string): { rebound: number } {
    const rows = db.prepare(`
      SELECT
        id, artist_id, file_path, library_root, file_type, quality, library_slot,
        provider, provider_entity_type, provider_id,
        canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
        canonical_track_mbid, canonical_recording_mbid
      FROM TrackFiles
      WHERE artist_id = ?
        AND file_type IN ('track', 'video')
        AND canonical_recording_mbid IS NOT NULL
    `).all(artistId) as Array<{
      id: number;
      artist_id: string | number;
      file_path: string;
      library_root: string | null;
      file_type: string;
      quality: string | null;
      library_slot: string | null;
      provider: string | null;
      provider_entity_type: string | null;
      provider_id: string | null;
      canonical_artist_mbid: string | null;
      canonical_release_group_mbid: string | null;
      canonical_release_mbid: string | null;
      canonical_track_mbid: string | null;
      canonical_recording_mbid: string | null;
    }>;
    if (rows.length === 0) return { rebound: 0 };

    const identities = resolveLibraryFileIdentities(rows.map((row) => ({
      artistId: row.artist_id,
      fileType: row.file_type,
      quality: row.quality,
      libraryRoot: row.library_root,
      provider: row.provider,
      providerEntityType: row.provider_entity_type,
      providerId: row.provider_id,
      librarySlot: row.library_slot,
      canonicalArtistMbid: row.canonical_artist_mbid,
      canonicalReleaseGroupMbid: row.canonical_release_group_mbid,
      canonicalReleaseMbid: row.canonical_release_mbid,
      canonicalTrackMbid: row.canonical_track_mbid,
      canonicalRecordingMbid: row.canonical_recording_mbid,
    })));

    let rebound = 0;
    const update = db.prepare(`
      UPDATE TrackFiles
      SET album_edition_id = ?,
          track_id = ?,
          recording_id = ?,
          canonical_release_mbid = ?,
          canonical_track_mbid = ?,
          canonical_recording_mbid = COALESCE(?, canonical_recording_mbid),
          canonical_release_group_mbid = COALESCE(?, canonical_release_group_mbid)
      WHERE id = ?
    `);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const identity = identities[index];
      if (!identity?.canonicalReleaseMbid || !identity.canonicalTrackMbid) continue;
      if (
        identity.canonicalReleaseMbid === row.canonical_release_mbid
        && identity.canonicalTrackMbid === row.canonical_track_mbid
      ) {
        continue;
      }
      const catalogIds = db.prepare(`
        SELECT
          (SELECT id FROM AlbumEditions WHERE mbid = ?) AS album_edition_id,
          (SELECT id FROM Tracks WHERE mbid = ?) AS track_id,
          (SELECT id FROM Recordings WHERE mbid = ?) AS recording_id
      `).get(
        identity.canonicalReleaseMbid,
        identity.canonicalTrackMbid,
        identity.canonicalRecordingMbid,
      ) as {
        album_edition_id: number | null;
        track_id: number | null;
        recording_id: number | null;
      };
      if (!catalogIds.album_edition_id || !catalogIds.track_id) continue;
      update.run(
        catalogIds.album_edition_id,
        catalogIds.track_id,
        catalogIds.recording_id,
        identity.canonicalReleaseMbid,
        identity.canonicalTrackMbid,
        identity.canonicalRecordingMbid,
        identity.canonicalReleaseGroupMbid,
        row.id,
      );
      rebound += 1;
    }
    if (rebound > 0) {
      console.log(`[TrackFiles] Rebound ${rebound} file(s) onto monitored editions for artist ${artistId}`);
    }
    return { rebound };
  }

  static pruneUnmonitoredFiles(artistId: string): { deleted: number; missing: number; errors: number } {
    const artist = db.prepare(`SELECT monitored FROM Artists WHERE id = ?`).get(artistId) as any;
    const artistMonitored = Boolean(artist?.monitored);

    // Unmonitoring an artist does not implicitly wipe the artist folder.
    // Automatic cleanup only applies while the artist remains managed and curation explicitly unmonitors child items.
    // Do not rebind here: that would absorb an unmonitored edition's files onto
    // the remaining selected edition instead of deleting them.
    if (!artistMonitored) {
      return { deleted: 0, missing: 0, errors: 0 };
    }

    const rows = LibraryFilesService.selectUnmonitoredFileRows(artistId);
    const prunedDirectories = new Map<string, string>();

    if (rows.length === 0) {
      return this.pruneUntrackedMediaInUnmonitoredEditionFolders(artistId);
    }

    const linkedExtras = captureLinkedExtras(rows.map((row) => row.id));
    const deletedTrackFileIds: number[] = [];
    const storedFilePaths: string[] = [];

    let deleted = 0;
    let missing = 0;
    let errors = 0;

    for (const row of rows) {
      let canRemove = true;
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
      });
      const exists = fs.existsSync(resolvedFilePath);
      if (exists) {
        try {
          fs.rmSync(resolvedFilePath, { force: true });
        } catch (error) {
          console.warn(`[TrackFiles] Failed to delete ${resolvedFilePath}:`, error);
          canRemove = false;
          errors += 1;
        }
      } else {
        missing += 1;
      }

      if (!canRemove) continue;

      db.prepare("DELETE FROM TrackFiles WHERE id = ?").run(row.id);
      deletedTrackFileIds.push(row.id);
      storedFilePaths.push(row.file_path);

      try {
        recordHistoryEvent({
          artistId: row.artist_id,
          albumId: row.album_id,
          mediaId: row.media_id,
          libraryFileId: row.id,
          eventType: HISTORY_EVENT_TYPES.TrackFileDeleted,
          quality: row.quality,
          data: {
            deletedPath: resolvedFilePath,
            fileType: row.file_type,
            missing: !exists,
          },
        });
      } catch (historyError) {
        console.warn(`[TrackFiles] Failed to record prune history for row ${row.id}:`, historyError);
      }

      this.emitFileDeleted({
        libraryFileId: row.id,
        artistId: row.artist_id,
        albumId: row.album_id,
        mediaId: row.media_id,
        fileType: row.file_type,
        filePath: resolvedFilePath,
        libraryRoot: row.library_root,
        quality: row.quality,
        reason: "prune-unmonitored",
        missing: !exists,
      });

      deleted += exists ? 1 : 0;

      const root = resolveLibraryRootPath(row.library_root, row.file_path);

      if (root) {
        prunedDirectories.set(normalizeResolvedPath(path.dirname(resolvedFilePath)), row.library_root);
        removeEmptyParents(path.dirname(resolvedFilePath), root);
      }
    }

    const extras = releaseExtrasForDeletedTrackFiles({
      scope: { kind: "all-libraries" },
      deletedTrackFileIds,
      storedFilePaths,
      linkedExtras,
    });
    deleted += extras.deleted;
    missing += extras.missing;
    errors += extras.errors;

    const leftovers = this.pruneLeftoversInEditionDirectories(prunedDirectories);
    deleted += leftovers.deleted;
    missing += leftovers.missing;
    errors += leftovers.errors;
    const untracked = this.pruneUntrackedMediaInUnmonitoredEditionFolders(artistId);
    deleted += untracked.deleted;
    missing += untracked.missing;
    errors += untracked.errors;

    return { deleted, missing, errors };
  }

  private static readonly LEFTOVER_MEDIA_EXTENSIONS = new Set([
    ".flac", ".alac", ".wav", ".aiff", ".mp3", ".m4a", ".aac", ".ogg", ".opus",
    ".wma", ".ape", ".mp2", ".mp4", ".m4v", ".mkv", ".mov", ".webm",
  ]);

  private static directoryHasTrackedAudio(directory: string): boolean {
    const normalized = normalizeComparablePath(directory);
    if (!normalized) return false;
    const like = `${normalized.replace(/([\\%_])/g, "\\$1")}/%`;
    const rows = db.prepare(`
      SELECT file_path
      FROM TrackFiles
      WHERE file_type IN ('track', 'video')
        AND ${comparablePathColumnSql("file_path")} LIKE ? ESCAPE '\\'
    `).all(like) as Array<{ file_path: string }>;
    return rows.some((row) => normalizeComparablePath(path.dirname(row.file_path)) === normalized);
  }

  private static directoryHasMonitoredAudio(directory: string): boolean {
    const normalizedDir = normalizeComparablePath(directory);
    if (!normalizedDir) return false;
    const like = `${normalizedDir.replace(/([\\%_])/g, "\\$1")}/%`;
    const rows = db.prepare(`
      SELECT lf.file_path, lf.library_id, lf.album_edition_id
      FROM TrackFiles lf
      WHERE lf.file_type IN ('track', 'video')
        AND ${comparablePathColumnSql("lf.file_path")} LIKE ? ESCAPE '\\'
    `).all(like) as Array<{ file_path: string; library_id: number | null; album_edition_id: number | null }>;
    return rows.some((row) => {
      if (normalizeComparablePath(path.dirname(row.file_path)) !== normalizedDir) return false;
      if (row.library_id == null || row.album_edition_id == null) return false;
      const monitored = db.prepare(`
        SELECT 1 FROM LibraryEditions
        WHERE library_id = ? AND edition_id = ?
        LIMIT 1
      `).get(row.library_id, row.album_edition_id);
      return Boolean(monitored);
    });
  }

  private static deleteLeftoverPath(filePath: string, libraryRoot: string): boolean {
    const resolved = resolveStoredLibraryPath({ filePath, libraryRoot });
    let deletedPhysical = false;
    if (fs.existsSync(resolved)) {
      fs.rmSync(resolved, { force: true });
      deletedPhysical = true;
    }
    db.prepare("DELETE FROM UnmappedFiles WHERE file_path = ?").run(resolved);
    db.prepare("DELETE FROM UnmappedFiles WHERE file_path = ?").run(filePath);
    db.prepare("DELETE FROM TrackFiles WHERE file_path = ?").run(resolved);
    db.prepare("DELETE FROM TrackFiles WHERE file_path = ?").run(filePath);
    for (const table of ["MetadataFiles", "LyricFiles", "ExtraFiles"] as const) {
      db.prepare(`DELETE FROM ${table} WHERE file_path = ?`).run(resolved);
      db.prepare(`DELETE FROM ${table} WHERE file_path = ?`).run(filePath);
    }
    return deletedPhysical;
  }

  /**
   * After tracked unmonitored files are gone, wipe leftover sidecars/media in
   * those album folders when no monitored-edition audio remains there.
   */
  private static pruneLeftoversInEditionDirectories(
    directories: Map<string, string>,
  ): { deleted: number; missing: number; errors: number } {
    let deleted = 0;
    let missing = 0;
    let errors = 0;
    for (const [directory, libraryRoot] of directories) {
      if (this.directoryHasMonitoredAudio(directory)) continue;
      if (!fs.existsSync(directory)) continue;
      try {
        const entries = fs.readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const fullPath = path.join(directory, entry.name);
          try {
            if (this.deleteLeftoverPath(fullPath, libraryRoot)) deleted += 1;
            else missing += 1;
          } catch (error) {
            console.warn(`[TrackFiles] Failed leftover delete ${fullPath}:`, error);
            errors += 1;
          }
        }
        const root = resolveLibraryRootPath(libraryRoot, directory);
        if (root) removeEmptyParents(directory, root);
      } catch (error) {
        console.warn(`[TrackFiles] Failed leftover sweep of ${directory}:`, error);
        errors += 1;
      }
    }
    return { deleted, missing, errors };
  }

  /**
   * After tracked unmonitored files are gone, wipe leftover extras (duplicate
   * mp3s, unmapped media) in those edition folders when no monitored-edition
   * audio remains there.
   */
  private static pruneUntrackedMediaInUnmonitoredEditionFolders(
    artistId: string,
  ): { deleted: number; missing: number; errors: number } {
    const rows = db.prepare(`
      SELECT lf.file_path, lf.library_root, lf.library_id, lf.album_edition_id
      FROM TrackFiles lf
      WHERE lf.artist_id = ?
        AND lf.file_type IN ('track', 'video')
        AND lf.album_edition_id IS NOT NULL
        AND lf.library_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM LibraryEditions monitored
          WHERE monitored.library_id = lf.library_id
            AND monitored.edition_id = lf.album_edition_id
        )
    `).all(artistId) as Array<{
      file_path: string;
      library_root: string;
      library_id: number;
      album_edition_id: number;
    }>;

    const directories = new Map<string, string>();
    for (const row of rows) {
      const resolved = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
      });
      const directory = path.dirname(resolved);
      if (this.directoryHasMonitoredAudio(directory)) continue;
      directories.set(normalizeResolvedPath(directory), row.library_root);
    }

    let deleted = 0;
    let missing = 0;
    let errors = 0;
    for (const [directory, libraryRoot] of directories) {
      if (!fs.existsSync(directory)) continue;
      const tracked = new Set(
        (db.prepare(`
          SELECT file_path FROM TrackFiles
          WHERE ${comparablePathColumnSql("file_path")} LIKE ? ESCAPE '\\'
        `).all(`${normalizeComparablePath(directory).replace(/([\\%_])/g, "\\$1")}/%`) as Array<{ file_path: string }>)
          .filter((row) => normalizeComparablePath(path.dirname(row.file_path)) === normalizeComparablePath(directory))
          .map((row) => normalizeResolvedPath(row.file_path)),
      );
      try {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const fullPath = path.join(directory, entry.name);
          if (tracked.has(normalizeResolvedPath(fullPath))) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (!this.LEFTOVER_MEDIA_EXTENSIONS.has(ext)) continue;
          try {
            if (this.deleteLeftoverPath(fullPath, libraryRoot)) deleted += 1;
            else missing += 1;
          } catch (error) {
            console.warn(`[TrackFiles] Failed untracked extra delete ${fullPath}:`, error);
            errors += 1;
          }
        }
      } catch (error) {
        console.warn(`[TrackFiles] Failed untracked extra sweep of ${directory}:`, error);
        errors += 1;
      }
    }
    return { deleted, missing, errors };
  }

  /**
   * After an Album or Edition is unmonitored, delete its library files when
   * "Remove unmonitored files" is on. Album-toggle, track-toggle, edition
   * removal, and housekeeping all go through here so extras in that folder
   * leave with the TrackFiles instead of surviving as orphan ExtraFiles.
   */
  static pruneUnmonitoredForReleaseGroup(releaseGroupMbid: string): {
    deleted: number; missing: number; errors: number;
  } {
    if (getConfigSection("monitoring")?.remove_unmonitored_files !== true) {
      return { deleted: 0, missing: 0, errors: 0 };
    }
    const artist = db.prepare(`
      SELECT CAST(artist.id AS TEXT) AS id
      FROM Albums album
      JOIN Artists artist ON artist.mbid = album.artist_mbid
      WHERE album.mbid = ?
      LIMIT 1
    `).get(releaseGroupMbid) as { id?: string } | undefined;
    if (!artist?.id) {
      return { deleted: 0, missing: 0, errors: 0 };
    }
    return this.pruneUnmonitoredFiles(artist.id);
  }

  static pruneUnmonitoredFilesForMonitoredArtists(): { artists: number; deleted: number; missing: number; errors: number } {
    if (getConfigSection("monitoring")?.remove_unmonitored_files !== true) {
      return { artists: 0, deleted: 0, missing: 0, errors: 0 };
    }
    const artists = db.prepare(`
      SELECT CAST(id AS TEXT) AS id
      FROM Artists
      WHERE monitored = 1
    `).all() as Array<{ id: string }>;
    let deleted = 0;
    let missing = 0;
    let errors = 0;
    for (const artist of artists) {
      const result = this.pruneUnmonitoredFiles(artist.id);
      deleted += result.deleted;
      missing += result.missing;
      errors += result.errors;
    }
    return { artists: artists.length, deleted, missing, errors };
  }

  /**
   * Remove library files whose type is disabled in the current metadata settings.
   * For example, if save_album_cover is false, delete all 'cover' files for albums.
   * If save_lyrics is false, delete all 'lyrics' files. Etc.
   *
   * This ensures that toggling a metadata setting off cleans up existing files,
   * and is also useful after importing from another library that had different settings.
   */
  static pruneDisabledMetadataFiles(artistId: string): { deleted: number; missing: number; errors: number } {
    const metadataConfig = getConfigSection("metadata");

    const rows: Array<{
      id: number;
      artist_id: number;
      album_id: number | null;
      media_id: number | null;
      file_type: string;
      quality: string | null;
      file_path: string;
      library_root: string;
      tableName: "MetadataFiles" | "LyricFiles";
    }> = [];

    // Check MetadataFiles
    const metaSelectors: string[] = [];
    if (!metadataConfig.save_album_cover) {
      metaSelectors.push("(file_type = 'cover' AND (canonical_release_group_mbid IS NOT NULL OR canonical_release_mbid IS NOT NULL OR provider_entity_type = 'album')) OR file_type = 'video_cover'");
    }
    if (!metadataConfig.save_artist_picture) {
      metaSelectors.push(`
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
    if (!metadataConfig.save_video_thumbnail) {
      metaSelectors.push("file_type = 'video_thumbnail'");
    }
    if (!metadataConfig.save_nfo) {
      metaSelectors.push("file_type = 'nfo'");
    }

    if (metaSelectors.length > 0) {
      const metaRows = db.prepare(`
        SELECT id AS id,
          artist_id AS artist_id,
          COALESCE(canonical_release_group_mbid, canonical_release_mbid) AS album_id,
          COALESCE(canonical_track_mbid, canonical_recording_mbid, provider_id) AS media_id,
          file_type AS file_type,
          NULL AS quality,
          file_path AS file_path,
          library_root AS library_root
        FROM MetadataFiles
        WHERE artist_id = ? AND (${metaSelectors.join(" OR ")})
      `).all(artistId) as any[];

      for (const row of metaRows) {
        rows.push({ ...row, tableName: "MetadataFiles" });
      }
    }

    // Check LyricFiles
    if (!metadataConfig.save_lyrics) {
      const lyricRows = db.prepare(`
        SELECT id AS id,
          artist_id AS artist_id,
          COALESCE(canonical_release_group_mbid, canonical_release_mbid) AS album_id,
          COALESCE(canonical_track_mbid, canonical_recording_mbid, provider_id) AS media_id,
          'lyrics' AS file_type,
          quality AS quality,
          file_path AS file_path,
          library_root AS library_root
        FROM LyricFiles
        WHERE artist_id = ?
      `).all(artistId) as any[];

      for (const row of lyricRows) {
        rows.push({ ...row, tableName: "LyricFiles" });
      }
    }

    if (rows.length === 0) {
      return { deleted: 0, missing: 0, errors: 0 };
    }

    let deleted = 0;
    let missing = 0;
    let errors = 0;

    for (const row of rows) {
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
      });
      const exists = fs.existsSync(resolvedFilePath);
      if (exists) {
        try {
          fs.rmSync(resolvedFilePath, { force: true });
          deleted++;
        } catch (error) {
          console.warn(`[${row.tableName}] Failed to delete disabled metadata file ${resolvedFilePath}:`, error);
          errors++;
          continue;
        }
      } else {
        missing++;
      }

      db.prepare(`DELETE FROM ${row.tableName} WHERE id = ?`).run(row.id);

      try {
        recordHistoryEvent({
          artistId: row.artist_id,
          albumId: row.album_id,
          mediaId: row.media_id,
          libraryFileId: row.id,
          eventType: HISTORY_EVENT_TYPES.TrackFileDeleted,
          quality: row.quality,
          data: {
            deletedPath: resolvedFilePath,
            fileType: row.file_type,
            missing: !exists,
          },
        });
      } catch (historyError) {
        console.warn(`[${row.tableName}] Failed to record disabled metadata prune history for row ${row.id}:`, historyError);
      }

      this.emitFileDeleted({
        libraryFileId: row.id,
        artistId: row.artist_id,
        albumId: row.album_id,
        mediaId: row.media_id,
        fileType: row.file_type,
        filePath: resolvedFilePath,
        libraryRoot: row.library_root,
        quality: row.quality,
        reason: "prune-disabled-metadata",
        missing: !exists,
      });

      const root = resolveLibraryRootPath(row.library_root, row.file_path);

      if (root) {
        removeEmptyParents(path.dirname(resolvedFilePath), root);
      }
    }

    if (deleted > 0 || missing > 0) {
      console.log(`[Metadata/LyricFiles] Disabled metadata cleanup for artist ${artistId}: ${deleted} deleted, ${missing} already missing`);
    }

    return { deleted, missing, errors };
  }

}
