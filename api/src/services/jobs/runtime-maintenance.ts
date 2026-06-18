import fs from "fs";
import { db } from "../../database.js";
import { invalidateAllDownloadState } from "../download/download-state.js";
import { resolveStoredLibraryPath } from "../mediafiles/library-paths.js";
import { LibraryFilesService } from "../mediafiles/library-files.js";
import { normalizeComparablePath } from "../mediafiles/path-utils.js";
import { resolveLibraryFileIdentity } from "../mediafiles/library-file-identity.js";

interface LibraryFileRow {
  id: number;
  media_id: number | null;
  canonical_recording_mbid: string | null;
  canonical_track_mbid: string | null;
  track_id: number | null;
  recording_id: number | null;
  library_slot: string | null;
  file_type: string;
  file_path: string;
  library_root: string | null;
  relative_path: string | null;
  expected_path: string | null;
  verified_at: string | null;
  modified_at: string | null;
  created_at: string | null;
}

export interface RuntimeMaintenanceSummary {
  duplicateLibraryFilesRemoved: number;
  duplicateTrackedAssetsRemoved: number;
  staleTrackedAssetsRemoved: number;
  mediaMonitorRepairs: number;
  albumMonitorRepairs: number;
  artistMonitorRepairs: number;
  albumStatesRefreshed: number;
  artistStatesRefreshed: number;
  databaseOptimized: boolean;
  mediaIdentityIndexEnsured: boolean;
  trackedAssetIdentityIndexesEnsured: boolean;
  /** Finished job_queue rows pruned (Lidarr-aligned: completed > 1 day) */
  historyJobsPruned: number;
  /** TrackFiles rows whose canonical_*_mbid columns were back-filled from legacy ids (Phase 1 DB-alignment) */
  canonicalTrackFilesBackfilled: number;
  /** TrackFiles rows whose canonical integer FK columns were back-filled from mbids/ProviderItems */
  trackFileForeignKeysBackfilled: number;
}

function toTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function scoreLibraryFile(row: LibraryFileRow) {
  const resolvedPath = resolveStoredLibraryPath({
    filePath: row.file_path,
    libraryRoot: row.library_root,
    relativePath: row.relative_path,
  });
  const normalizedExpected = normalizeComparablePath(row.expected_path);
  const normalizedPath = normalizeComparablePath(row.file_path);
  const normalizedResolvedPath = normalizeComparablePath(resolvedPath);
  const exists = fs.existsSync(resolvedPath);

  return {
    resolvedMatchesExpected: normalizedExpected.length > 0 && normalizedResolvedPath === normalizedExpected ? 1 : 0,
    pathMatchesExpected: normalizedExpected.length > 0 && normalizedPath === normalizedExpected ? 1 : 0,
    exists: exists ? 1 : 0,
    verified: row.verified_at ? 1 : 0,
    modifiedAt: toTimestamp(row.modified_at),
    createdAt: toTimestamp(row.created_at),
    id: row.id,
  };
}

type LibraryFileScore = ReturnType<typeof scoreLibraryFile>;

let libraryFileScoreCache: Map<number, LibraryFileScore> | null = null;

function getLibraryFileScore(row: LibraryFileRow): LibraryFileScore {
  if (!libraryFileScoreCache) {
    return scoreLibraryFile(row);
  }

  const cached = libraryFileScoreCache.get(row.id);
  if (cached) {
    return cached;
  }

  const computed = scoreLibraryFile(row);
  libraryFileScoreCache.set(row.id, computed);
  return computed;
}

function compareLibraryFileScores(leftScore: LibraryFileScore, rightScore: LibraryFileScore): number {
  return (
    rightScore.resolvedMatchesExpected - leftScore.resolvedMatchesExpected ||
    rightScore.pathMatchesExpected - leftScore.pathMatchesExpected ||
    rightScore.exists - leftScore.exists ||
    rightScore.verified - leftScore.verified ||
    rightScore.modifiedAt - leftScore.modifiedAt ||
    rightScore.createdAt - leftScore.createdAt ||
    rightScore.id - leftScore.id
  );
}

function compareLibraryFiles(left: LibraryFileRow, right: LibraryFileRow): number {
  const leftScore = getLibraryFileScore(left);
  const rightScore = getLibraryFileScore(right);
  return compareLibraryFileScores(leftScore, rightScore);
}

// Legacy provider-id dedupe identity. Kept because the unique index created
// later in the maintenance transaction is still (media_id, file_type) until the
// Phase 5 schema migration — this pass guarantees that invariant before the
// index is (re)created.
function mediaIdentityKey(row: LibraryFileRow): string {
  if (row.media_id === null || row.media_id === undefined) {
    return "";
  }
  return `media:${row.media_id}:${row.file_type}`;
}

/**
 * Canonical-first dedupe identity (Phase 1, corrected). A file's canonical
 * identity is the **track** (the release↔recording mapping), NOT the recording:
 * one recording legitimately appears as a track on several releases, so the same
 * recording downloaded from two different releases yields two *distinct* files
 * that must NOT be merged. So audio dedupes by `track_id`/`canonical_track_mbid`
 * (release-specific) within a slot. Videos have no release/track, so they dedupe
 * by `recording_id`/`canonical_recording_mbid`. library_slot is part of the key
 * (a track's stereo and spatial copies are distinct files). Returns "" when the
 * relevant canonical id is missing, leaving such rows to the media-id pass.
 */
function canonicalIdentityKey(row: LibraryFileRow): string {
  const slot = String(row.library_slot ?? "").trim().toLowerCase();
  if (row.file_type === "video") {
    const recording = row.recording_id != null
      ? `id:${row.recording_id}`
      : String(row.canonical_recording_mbid ?? "").trim();
    return recording ? `vid:${recording}:${slot}` : "";
  }
  const track = row.track_id != null
    ? `id:${row.track_id}`
    : String(row.canonical_track_mbid ?? "").trim();
  return track ? `trk:${track}:${slot}` : "";
}

function dedupeLibraryFilesByKey(
  keyFn: (row: LibraryFileRow) => string,
  summary: RuntimeMaintenanceSummary,
) {
  const rows = db.prepare(`
    SELECT
      id,
      media_id,
      canonical_recording_mbid,
      canonical_track_mbid,
      track_id,
      recording_id,
      library_slot,
      file_type,
      file_path,
      library_root,
      relative_path,
      expected_path,
      verified_at,
      modified_at,
      created_at
    FROM TrackFiles
    WHERE (media_id IS NOT NULL OR canonical_recording_mbid IS NOT NULL OR track_id IS NOT NULL OR recording_id IS NOT NULL)
      AND file_type IN ('track', 'video')
    ORDER BY id ASC
  `).all() as LibraryFileRow[];

  const deleteRow = db.prepare("DELETE FROM TrackFiles WHERE id = ?");
  const buckets = new Map<string, LibraryFileRow[]>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) {
      continue;
    }
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      buckets.set(key, [row]);
    }
  }

  for (const bucket of buckets.values()) {
    if (bucket.length <= 1) {
      continue;
    }

    libraryFileScoreCache = new Map<number, LibraryFileScore>();
    const [keep, ...remove] = [...bucket].sort(compareLibraryFiles);
    libraryFileScoreCache = null;

    for (const row of remove) {
      if (row.id === keep.id) continue;
      deleteRow.run(row.id);
      summary.duplicateLibraryFilesRemoved++;
    }
  }
}

export function dedupeLibraryFiles(summary: RuntimeMaintenanceSummary) {
  // Media-id pass first to preserve the (media_id, file_type) unique-index
  // invariant, then the canonical pass to catch cross-media same-recording dupes.
  dedupeLibraryFilesByKey(mediaIdentityKey, summary);
  dedupeLibraryFilesByKey(canonicalIdentityKey, summary);
}

interface CanonicalBackfillRow {
  id: number;
  artist_id: number | null;
  album_id: number | null;
  media_id: number | null;
  file_type: string;
  quality: string | null;
  library_root: string | null;
  library_slot: string | null;
  provider: string | null;
  provider_entity_type: string | null;
  provider_id: string | null;
  canonical_artist_mbid: string | null;
  canonical_release_group_mbid: string | null;
  canonical_release_mbid: string | null;
  canonical_track_mbid: string | null;
  canonical_recording_mbid: string | null;
}

/**
 * Phase 1 (Lidarr DB alignment): make TrackFiles canonical-first by back-filling
 * the canonical_*_mbid columns for rows that still rely on the legacy
 * media_id/album_id provider linkage. New downloads/imports already populate
 * these on write; this pass closes gaps on older rows (and rows imported before
 * the canonical columns existed) so file lookups/dedup can switch to the
 * canonical ids without orphaning anything.
 *
 * Only NULL columns are filled — existing canonical ids are passed through as
 * inputs and never overwritten. media_id/album_id are kept as shadow columns
 * (dropped in Phase 5).
 */
export function backfillCanonicalTrackFiles(summary: RuntimeMaintenanceSummary) {
  // Candidate rows: have a legacy provider id to resolve from, and are missing
  // at least one canonical id relevant to their kind.
  const rows = db.prepare(`
    SELECT
      id, artist_id, album_id, media_id, file_type, quality, library_root, library_slot,
      provider, provider_entity_type, provider_id,
      canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid
    FROM TrackFiles
    WHERE (media_id IS NOT NULL OR album_id IS NOT NULL)
      AND (
        canonical_release_group_mbid IS NULL
        OR (
          file_type IN ('track', 'video', 'lyrics', 'video_thumbnail')
          AND media_id IS NOT NULL
          AND canonical_recording_mbid IS NULL
        )
      )
  `).all() as CanonicalBackfillRow[];

  if (rows.length === 0) {
    return;
  }

  // COALESCE keeps any value already present; the resolver also receives the
  // existing values as inputs, so it's stable/idempotent.
  const update = db.prepare(`
    UPDATE TrackFiles SET
      canonical_artist_mbid = COALESCE(canonical_artist_mbid, ?),
      canonical_release_group_mbid = COALESCE(canonical_release_group_mbid, ?),
      canonical_release_mbid = COALESCE(canonical_release_mbid, ?),
      canonical_track_mbid = COALESCE(canonical_track_mbid, ?),
      canonical_recording_mbid = COALESCE(canonical_recording_mbid, ?)
    WHERE id = ?
  `);

  for (const row of rows) {
    const identity = resolveLibraryFileIdentity({
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

    // Skip rows the resolver couldn't advance (nothing new to fill).
    const fillsSomething =
      (row.canonical_artist_mbid === null && identity.canonicalArtistMbid !== null) ||
      (row.canonical_release_group_mbid === null && identity.canonicalReleaseGroupMbid !== null) ||
      (row.canonical_release_mbid === null && identity.canonicalReleaseMbid !== null) ||
      (row.canonical_track_mbid === null && identity.canonicalTrackMbid !== null) ||
      (row.canonical_recording_mbid === null && identity.canonicalRecordingMbid !== null);
    if (!fillsSomething) {
      continue;
    }

    const result = update.run(
      identity.canonicalArtistMbid,
      identity.canonicalReleaseGroupMbid,
      identity.canonicalReleaseMbid,
      identity.canonicalTrackMbid,
      identity.canonicalRecordingMbid,
      row.id,
    );
    summary.canonicalTrackFilesBackfilled += Number(result.changes || 0);
  }
}

/**
 * Phase: integer-FK linkage. Keep the canonical integer FK columns
 * (release_group_id/album_release_id/track_id/recording_id) populated from the
 * canonical mbids, and recording_id for mbid-less provider videos from the video
 * ProviderItems offer. NULL-guarded + idempotent; the v23 migration does the
 * initial fill, this keeps new/changed rows current between scans.
 */
export function backfillTrackFileForeignKeys(summary: RuntimeMaintenanceSummary) {
  if (!hasTrackFileForeignKeys()) {
    return;
  }
  const byMbid = db.prepare(`
    UPDATE TrackFiles SET
      release_group_id = COALESCE(release_group_id, (SELECT id FROM Albums WHERE mbid = TrackFiles.canonical_release_group_mbid)),
      album_release_id = COALESCE(album_release_id, (SELECT id FROM AlbumReleases WHERE mbid = TrackFiles.canonical_release_mbid)),
      track_id = COALESCE(track_id, (SELECT id FROM Tracks WHERE mbid = TrackFiles.canonical_track_mbid)),
      recording_id = COALESCE(recording_id, (SELECT id FROM Recordings WHERE mbid = TrackFiles.canonical_recording_mbid))
    WHERE (release_group_id IS NULL AND canonical_release_group_mbid IS NOT NULL)
       OR (album_release_id IS NULL AND canonical_release_mbid IS NOT NULL)
       OR (track_id IS NULL AND canonical_track_mbid IS NOT NULL)
       OR (recording_id IS NULL AND canonical_recording_mbid IS NOT NULL)
  `).run();
  summary.trackFileForeignKeysBackfilled += Number(byMbid.changes || 0);

  const byVideoOffer = db.prepare(`
    UPDATE TrackFiles SET recording_id = (
      SELECT pi.recording_id FROM ProviderItems pi
      WHERE pi.entity_type = 'video'
        AND CAST(pi.provider_id AS TEXT) = CAST(TrackFiles.provider_id AS TEXT)
        AND pi.recording_id IS NOT NULL
      LIMIT 1
    )
    WHERE file_type = 'video' AND recording_id IS NULL AND provider_id IS NOT NULL
  `).run();
  summary.trackFileForeignKeysBackfilled += Number(byVideoOffer.changes || 0);
}

function hasTrackFileForeignKeys(): boolean {
  return db.prepare("PRAGMA table_info(TrackFiles)").all()
    .some((column) => (column as { name: string }).name === "recording_id");
}

export function repairMonitoringGaps(summary: RuntimeMaintenanceSummary) {
  const installedAudioSlots = `
    SELECT DISTINCT
      COALESCE(NULLIF(lf.canonical_artist_mbid, ''), NULLIF(artist.mbid, ''), NULLIF(rg.artist_mbid, '')) AS artist_mbid,
      lf.canonical_release_group_mbid AS release_group_mbid,
      COALESCE(NULLIF(lf.library_slot, ''), 'stereo') AS slot
    FROM TrackFiles lf
    JOIN Albums rg ON rg.mbid = lf.canonical_release_group_mbid
    LEFT JOIN Artists artist ON CAST(artist.id AS TEXT) = CAST(lf.artist_id AS TEXT)
    JOIN ArtistMetadata metadata
      ON metadata.mbid = COALESCE(NULLIF(lf.canonical_artist_mbid, ''), NULLIF(artist.mbid, ''), NULLIF(rg.artist_mbid, ''))
    WHERE lf.file_type = 'track'
      AND lf.canonical_release_group_mbid IS NOT NULL
  `;

  summary.albumMonitorRepairs += Number(db.prepare(`
    UPDATE ReleaseGroupSlots
    SET monitored = 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE COALESCE(monitored, 0) = 0
      AND COALESCE(monitored_lock, 0) = 0
      AND id IN (
        SELECT slot_row.id
        FROM ReleaseGroupSlots slot_row
        JOIN (${installedAudioSlots}) installed
          ON installed.release_group_mbid = slot_row.release_group_mbid
         AND installed.slot = slot_row.slot
      )
  `).run().changes || 0);

  summary.albumMonitorRepairs += Number(db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, updated_at
    )
    SELECT installed.artist_mbid, installed.release_group_mbid, installed.slot, 1, CURRENT_TIMESTAMP
    FROM (${installedAudioSlots}) installed
    WHERE NOT EXISTS (
      SELECT 1
      FROM ReleaseGroupSlots slot_row
      WHERE slot_row.release_group_mbid = installed.release_group_mbid
        AND slot_row.slot = installed.slot
    )
  `).run().changes || 0);

  summary.mediaMonitorRepairs += Number(db.prepare(`
    UPDATE Recordings
    SET monitored = 1,
        monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE is_video = 1
      AND COALESCE(monitored, 0) = 0
      AND COALESCE(monitored_lock, 0) = 0
      AND EXISTS (
        SELECT 1
        FROM TrackFiles lf
        LEFT JOIN ProviderItems pi
          ON lf.provider_entity_type = 'video'
         AND pi.entity_type = 'video'
         AND CAST(pi.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
         AND (lf.provider IS NULL OR pi.provider = lf.provider)
        WHERE lf.file_type = 'video'
          AND (
            lf.recording_id = Recordings.id
            OR (lf.canonical_recording_mbid IS NOT NULL AND lf.canonical_recording_mbid = Recordings.mbid)
            OR pi.recording_id = Recordings.id
          )
      )
  `).run().changes || 0);

  // Artist monitoring is explicit user state. Do not auto-promote artists to monitored
  // just because related albums or tracks are monitored/downloaded.
}

function refreshDownloadState(summary: RuntimeMaintenanceSummary) {
  summary.albumStatesRefreshed = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM Albums").get() as { count: number } | undefined)?.count || 0,
  );
  summary.artistStatesRefreshed = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM Artists").get() as { count: number } | undefined)?.count || 0,
  );

  invalidateAllDownloadState();
}

export function runRuntimeMaintenance(): RuntimeMaintenanceSummary {
  const summary: RuntimeMaintenanceSummary = {
    duplicateLibraryFilesRemoved: 0,
    duplicateTrackedAssetsRemoved: 0,
    staleTrackedAssetsRemoved: 0,
    mediaMonitorRepairs: 0,
    albumMonitorRepairs: 0,
    artistMonitorRepairs: 0,
    albumStatesRefreshed: 0,
    artistStatesRefreshed: 0,
    databaseOptimized: false,
    mediaIdentityIndexEnsured: false,
    trackedAssetIdentityIndexesEnsured: false,
    historyJobsPruned: 0,
    canonicalTrackFilesBackfilled: 0,
    trackFileForeignKeysBackfilled: 0,
  };

  summary.staleTrackedAssetsRemoved = LibraryFilesService.pruneStaleTrackedAssets().removed;
  summary.duplicateTrackedAssetsRemoved = LibraryFilesService.pruneDuplicateTrackedAssets().removed;

  db.transaction(() => {
    backfillCanonicalTrackFiles(summary);
    backfillTrackFileForeignKeys(summary);
    dedupeLibraryFiles(summary);
    repairMonitoringGaps(summary);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_track_files_media_identity
      ON TrackFiles(media_id, file_type)
      WHERE media_id IS NOT NULL
        AND file_type IN ('track', 'video')
    `);
    summary.mediaIdentityIndexEnsured = true;

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_track_files_media_sidecar_identity
      ON TrackFiles(media_id, file_type)
      WHERE media_id IS NOT NULL
        AND file_type IN ('lyrics', 'video_thumbnail')
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_track_files_album_sidecar_identity
      ON TrackFiles(album_id, file_type, library_root)
      WHERE album_id IS NOT NULL
        AND media_id IS NULL
        AND file_type IN ('cover', 'video_cover', 'review')
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_track_files_artist_sidecar_identity
      ON TrackFiles(artist_id, file_type, library_root)
      WHERE album_id IS NULL
        AND media_id IS NULL
        AND file_type IN ('cover', 'bio')
    `);
    summary.trackedAssetIdentityIndexesEnsured = true;
  })();

  refreshDownloadState(summary);

  // Prune finished job_queue rows older than 1 day (Lidarr keeps completed commands
  // 5 min in-memory and trims DB records older than 1 day via CommandRepository.Trim())
  const pruneResult = db.prepare(`
    DELETE FROM job_queue
    WHERE status IN ('completed', 'failed', 'cancelled')
      AND COALESCE(completed_at, updated_at) < datetime('now', '-1 day')
  `).run();
  summary.historyJobsPruned = pruneResult.changes;

  db.exec(`PRAGMA optimize;`);
  db.prepare(`ANALYZE;`).run();
  db.prepare(`VACUUM;`).run();
  summary.databaseOptimized = true;

  if (
    summary.duplicateTrackedAssetsRemoved > 0 ||
    summary.staleTrackedAssetsRemoved > 0 ||
    summary.duplicateLibraryFilesRemoved > 0 ||
    summary.mediaMonitorRepairs > 0 ||
    summary.albumMonitorRepairs > 0 ||
    summary.artistMonitorRepairs > 0 ||
    summary.canonicalTrackFilesBackfilled > 0
  ) {
    console.log(
      `[Maintenance] Removed ${summary.duplicateLibraryFilesRemoved} duplicate media file row(s), ` +
      `${summary.duplicateTrackedAssetsRemoved} duplicate tracked asset(s), ` +
      `${summary.staleTrackedAssetsRemoved} stale tracked asset row(s), ` +
      `back-filled ${summary.canonicalTrackFilesBackfilled} canonical track-file id(s), ` +
      `repaired ${summary.mediaMonitorRepairs} media, ${summary.albumMonitorRepairs} albums, ` +
      `${summary.artistMonitorRepairs} artists, refreshed ${summary.albumStatesRefreshed} albums and ` +
      `${summary.artistStatesRefreshed} artists.`,
    );
  } else {
    console.log(
      `[Maintenance] Download state refreshed for ${summary.albumStatesRefreshed} albums and ` +
      `${summary.artistStatesRefreshed} artists.`,
    );
  }

  return summary;
}

