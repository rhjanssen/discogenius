import { db, withSqliteWriteGate } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import { getMusicBrainzReleaseGroupIncludeDecision } from "../metadata/musicbrainz-release-group-filter.js";
import { VARIOUS_ARTISTS_MBID } from "../mediafiles/audio-tag-service.js";

export interface CatalogPruningSummary {
  acquisitionPlansPruned: number;
  albumsPruned: number;
  editionsPruned: number;
  recordingsPruned: number;
  artistsPruned: number;
  timedOut: boolean;
}

export interface CatalogPruningOptions {
  /** Maximum rows deleted per stage per pass so one pass stays bounded. */
  maxPlansPerPass?: number;
  maxAlbumsPerPass?: number;
  maxEditionsPerPass?: number;
  maxRecordingsPerPass?: number;
  maxArtistsPerPass?: number;
  isCancelled?: () => boolean;
  isTimedOut?: () => boolean;
  yieldToEventLoop?: () => Promise<void>;
}

const DEFAULT_MAX_PLANS_PER_PASS = 25_000;
const DEFAULT_MAX_ALBUMS_PER_PASS = 5_000;
const DEFAULT_MAX_EDITIONS_PER_PASS = 5_000;
const DEFAULT_MAX_RECORDINGS_PER_PASS = 25_000;
const DEFAULT_MAX_ARTISTS_PER_PASS = 5_000;

const PLAN_BATCH_SIZE = 500;
const ALBUM_BATCH_SIZE = 50;
const EDITION_BATCH_SIZE = 50;
const RECORDING_BATCH_SIZE = 200;
const ARTIST_BATCH_SIZE = 100;

const ALBUM_SAFETY_PREDICATE_SQL = `
  NOT EXISTS (SELECT 1 FROM LibraryAlbums la WHERE la.release_group_id = Albums.id)
  AND NOT EXISTS (
    SELECT 1 FROM AlbumEditions e
    JOIN LibraryEditions le ON le.edition_id = e.id
    WHERE e.release_group_id = Albums.id
  )
  AND NOT EXISTS (SELECT 1 FROM LibraryUserExclusions ue WHERE ue.release_group_id = Albums.id)
  AND NOT EXISTS (SELECT 1 FROM TrackFiles tf WHERE tf.release_group_id = Albums.id OR tf.canonical_release_group_mbid = Albums.mbid)
  AND NOT EXISTS (
    SELECT 1 FROM AlbumEditions e
    JOIN TrackFiles tf ON tf.album_edition_id = e.id OR tf.canonical_release_mbid = e.mbid
    WHERE e.release_group_id = Albums.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM AlbumEditions e
    JOIN AcquisitionPlans ap ON ap.edition_id = e.id
    WHERE e.release_group_id = Albums.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM AlbumEditions e
    JOIN ProviderEditionMatches pem ON pem.edition_id = e.id
    JOIN AcquisitionPlanSources aps ON aps.provider_edition_match_id = pem.id
    WHERE e.release_group_id = Albums.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM AlbumEditions e
    JOIN Tracks t ON t.album_edition_id = e.id
    JOIN AcquisitionPlanTracks apt ON apt.track_id = t.id
    WHERE e.release_group_id = Albums.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM AlbumEditions e
    JOIN Tracks t ON t.album_edition_id = e.id
    JOIN ProviderTrackMatches ptm ON ptm.track_id = t.id
    JOIN AcquisitionPlanTracks apt ON apt.provider_track_match_id = ptm.id
    WHERE e.release_group_id = Albums.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM AlbumEditions e
    JOIN Tracks t ON t.album_edition_id = e.id
    JOIN LibraryVideos lv ON lv.inline_track_id = t.id
    WHERE e.release_group_id = Albums.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM AlbumEditions e
    JOIN Tracks t ON t.album_edition_id = e.id
    JOIN TrackFiles tf ON tf.track_id = t.id
    WHERE e.release_group_id = Albums.id
  )
`;

const EDITION_SAFETY_PREDICATE_SQL = `
  NOT EXISTS (SELECT 1 FROM LibraryEditions le WHERE le.edition_id = AlbumEditions.id)
  AND NOT EXISTS (SELECT 1 FROM LibraryUserExclusions ue WHERE ue.edition_id = AlbumEditions.id)
  AND NOT EXISTS (SELECT 1 FROM TrackFiles tf WHERE tf.album_edition_id = AlbumEditions.id OR tf.canonical_release_mbid = AlbumEditions.mbid)
  AND NOT EXISTS (SELECT 1 FROM AcquisitionPlans ap WHERE ap.edition_id = AlbumEditions.id)
  AND NOT EXISTS (
    SELECT 1 FROM ProviderEditionMatches pem
    JOIN AcquisitionPlanSources aps ON aps.provider_edition_match_id = pem.id
    WHERE pem.edition_id = AlbumEditions.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM Tracks t
    JOIN AcquisitionPlanTracks apt ON apt.track_id = t.id
    WHERE t.album_edition_id = AlbumEditions.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM Tracks t
    JOIN ProviderTrackMatches ptm ON ptm.track_id = t.id
    JOIN AcquisitionPlanTracks apt ON apt.provider_track_match_id = ptm.id
    WHERE t.album_edition_id = AlbumEditions.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM Tracks t
    JOIN LibraryVideos lv ON lv.inline_track_id = t.id
    WHERE t.album_edition_id = AlbumEditions.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM Tracks t
    JOIN TrackFiles tf ON tf.track_id = t.id
    WHERE t.album_edition_id = AlbumEditions.id
  )
`;

function loadSidecarReleaseGroupMbids(): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT canonical_release_group_mbid AS mbid FROM MetadataFiles WHERE canonical_release_group_mbid IS NOT NULL
    UNION
    SELECT DISTINCT canonical_release_group_mbid AS mbid FROM ExtraFiles WHERE canonical_release_group_mbid IS NOT NULL
    UNION
    SELECT DISTINCT canonical_release_group_mbid AS mbid FROM LyricFiles WHERE canonical_release_group_mbid IS NOT NULL
  `).all() as Array<{ mbid: string }>;
  return new Set(rows.map((r) => r.mbid));
}

function loadSidecarReleaseMbids(): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT canonical_release_mbid AS mbid FROM MetadataFiles WHERE canonical_release_mbid IS NOT NULL
    UNION
    SELECT DISTINCT canonical_release_mbid AS mbid FROM ExtraFiles WHERE canonical_release_mbid IS NOT NULL
    UNION
    SELECT DISTINCT canonical_release_mbid AS mbid FROM LyricFiles WHERE canonical_release_mbid IS NOT NULL
  `).all() as Array<{ mbid: string }>;
  return new Set(rows.map((r) => r.mbid));
}

function loadSidecarArtistIds(): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT artist_id FROM MetadataFiles WHERE artist_id IS NOT NULL
    UNION
    SELECT DISTINCT artist_id FROM ExtraFiles WHERE artist_id IS NOT NULL
    UNION
    SELECT DISTINCT artist_id FROM LyricFiles WHERE artist_id IS NOT NULL
  `).all() as Array<{ artist_id: string }>;
  return new Set(rows.map((r) => String(r.artist_id)));
}

function loadStandaloneDownloadQueueRecordingRefs(): { mbids: Set<string>; ids: Set<number> } {
  const rows = db.prepare(`
    SELECT
      json_extract(payload, '$.canonicalRecordingMbid') AS mbid,
      CAST(json_extract(payload, '$.canonicalRecordingId') AS INTEGER) AS id
    FROM DownloadQueue
    WHERE plan_id IS NULL
  `).all() as Array<{ mbid: string | null; id: number | null }>;
  const mbids = new Set<string>();
  const ids = new Set<number>();
  for (const row of rows) {
    if (row.mbid) mbids.add(String(row.mbid));
    if (row.id != null && Number.isFinite(row.id)) ids.add(Number(row.id));
  }
  return { mbids, ids };
}

/**
 * Safely prune unreferenced non-library catalog rows in bounded, write-gated
 * batches so bloated SQLite databases can reclaim space on `CompactDatabase`.
 *
 * Every delete re-verifies library/file/queue safety predicates inside the
 * write gate so concurrent user actions or imports can never lose live rows.
 */
export async function pruneUnreferencedCatalog(
  options: CatalogPruningOptions = {},
): Promise<CatalogPruningSummary> {
  const summary: CatalogPruningSummary = {
    acquisitionPlansPruned: 0,
    albumsPruned: 0,
    editionsPruned: 0,
    recordingsPruned: 0,
    artistsPruned: 0,
    timedOut: false,
  };

  const maxPlans = options.maxPlansPerPass ?? DEFAULT_MAX_PLANS_PER_PASS;
  const maxAlbums = options.maxAlbumsPerPass ?? DEFAULT_MAX_ALBUMS_PER_PASS;
  const maxEditions = options.maxEditionsPerPass ?? DEFAULT_MAX_EDITIONS_PER_PASS;
  const maxRecordings = options.maxRecordingsPerPass ?? DEFAULT_MAX_RECORDINGS_PER_PASS;
  const maxArtists = options.maxArtistsPerPass ?? DEFAULT_MAX_ARTISTS_PER_PASS;
  const yieldFn = options.yieldToEventLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const checkCancelled = () => {
    if (options.isCancelled?.()) throw new Error("Housekeeping cancellation requested");
  };
  const checkTimedOut = () => {
    if (options.isTimedOut?.()) {
      summary.timedOut = true;
      return true;
    }
    return false;
  };

  // Stage 1: Prune persisted AcquisitionPlans for unselected editions.
  // Must run first because AcquisitionPlanTracks references Tracks without ON DELETE CASCADE.
  {
    let cursor = 0;
    while (summary.acquisitionPlansPruned < maxPlans) {
      checkCancelled();
      if (checkTimedOut()) return summary;
      const limit = Math.min(PLAN_BATCH_SIZE, maxPlans - summary.acquisitionPlansPruned);
      const candidates = db.prepare(`
        SELECT p.id
        FROM AcquisitionPlans p
        WHERE p.id > ?
          AND NOT EXISTS (
            SELECT 1 FROM LibraryEditions le
            WHERE le.library_id = p.library_id AND le.edition_id = p.edition_id
          )
          AND NOT EXISTS (SELECT 1 FROM DownloadQueue dq WHERE dq.plan_id = p.id)
          AND NOT EXISTS (
            SELECT 1 FROM commands cmd
            WHERE cmd.status IN ('queued', 'started')
              AND CAST(json_extract(cmd.payload, '$.acquisitionPlanId') AS INTEGER) = p.id
          )
        ORDER BY p.id ASC
        LIMIT ?
      `).all(cursor, limit) as Array<{ id: number }>;
      if (candidates.length === 0) break;
      cursor = candidates[candidates.length - 1].id;
      const ids = candidates.map((c) => c.id);
      const removed = await withSqliteWriteGate(() => db.prepare(`
        DELETE FROM AcquisitionPlans
        WHERE id IN (${ids.map(() => "?").join(",")})
          AND NOT EXISTS (
            SELECT 1 FROM LibraryEditions le
            WHERE le.library_id = AcquisitionPlans.library_id
              AND le.edition_id = AcquisitionPlans.edition_id
          )
          AND NOT EXISTS (SELECT 1 FROM DownloadQueue dq WHERE dq.plan_id = AcquisitionPlans.id)
          AND NOT EXISTS (
            SELECT 1 FROM commands cmd
            WHERE cmd.status IN ('queued', 'started')
              AND CAST(json_extract(cmd.payload, '$.acquisitionPlanId') AS INTEGER) = AcquisitionPlans.id
          )
      `).run(...ids).changes, "housekeeping:prune-plans");
      summary.acquisitionPlansPruned += Number(removed || 0);
      await yieldFn();
    }
  }

  const filtering = getConfigSection("filtering");

  // Stage 2: Prune unreferenced non-library Albums (Various Artists + unmonitored
  // primary artists' catalogs that are not active included collaborations).
  {
    const sidecarRgMbids = loadSidecarReleaseGroupMbids();
    let cursor = 0;
    while (summary.albumsPruned < maxAlbums) {
      checkCancelled();
      if (checkTimedOut()) return summary;
      const limit = Math.min(ALBUM_BATCH_SIZE, maxAlbums - summary.albumsPruned);
      const candidates = db.prepare(`
        SELECT
          Albums.id,
          Albums.mbid,
          Albums.artist_mbid,
          Albums.primary_type,
          Albums.secondary_types,
          CASE WHEN EXISTS (
            SELECT 1
            FROM ReleaseGroupArtistCredits credit
            JOIN LibraryArtists la
              ON la.artist_metadata_id = credit.artist_id
             AND la.credited_scope IN ('release_credit', 'release_and_track_credit')
            JOIN Libraries lib
              ON lib.id = la.library_id
             AND lib.enabled = 1
            WHERE credit.release_group_id = Albums.id
          ) THEN 1 ELSE 0 END AS credited_to_monitored
        FROM Albums
        WHERE Albums.id > ?
          AND NOT EXISTS (
            SELECT 1 FROM LibraryArtists la
            WHERE la.artist_metadata_id = Albums.artist_metadata_id
          )
          AND ${ALBUM_SAFETY_PREDICATE_SQL}
        ORDER BY Albums.id ASC
        LIMIT ?
      `).all(cursor, limit) as Array<{
        id: number;
        mbid: string;
        artist_mbid: string;
        primary_type: string | null;
        secondary_types: string | null;
        credited_to_monitored: number;
      }>;
      if (candidates.length === 0) break;
      cursor = candidates[candidates.length - 1].id;

      const toDeleteIds = candidates
        .filter((album) => {
          if (sidecarRgMbids.has(album.mbid)) return false;
          const isVa = String(album.artist_mbid || "").trim().toLowerCase() === VARIOUS_ARTISTS_MBID;
          if (isVa) return true;
          if (album.credited_to_monitored === 1) {
            // Keep active collaborations whose release type is included by policy.
            const included = getMusicBrainzReleaseGroupIncludeDecision({
              primary_type: album.primary_type,
              secondary_types: album.secondary_types,
            }, filtering).include;
            return !included;
          }
          return true;
        })
        .map((album) => album.id);

      if (toDeleteIds.length > 0) {
        const removed = await withSqliteWriteGate(() => db.prepare(`
          DELETE FROM Albums
          WHERE id IN (${toDeleteIds.map(() => "?").join(",")})
            AND NOT EXISTS (
              SELECT 1 FROM LibraryArtists la
              WHERE la.artist_metadata_id = Albums.artist_metadata_id
            )
            AND ${ALBUM_SAFETY_PREDICATE_SQL}
        `).run(...toDeleteIds).changes, "housekeeping:prune-albums");
        summary.albumsPruned += Number(removed || 0);
      }
      await yieldFn();
    }
  }

  // Stage 3: Prune unreferenced AlbumEditions (and their Tracks) belonging to
  // monitored artists' filtering-excluded release groups, leaving the light
  // Albums stub row intact and resetting content_hash so opening/re-enabling
  // re-hydrates on demand from MusicBrainz.
  {
    const sidecarReleaseMbids = loadSidecarReleaseMbids();
    let cursor = 0;
    while (summary.editionsPruned < maxEditions) {
      checkCancelled();
      if (checkTimedOut()) return summary;
      const limit = Math.min(EDITION_BATCH_SIZE, maxEditions - summary.editionsPruned);
      const candidates = db.prepare(`
        SELECT
          AlbumEditions.id,
          AlbumEditions.mbid,
          AlbumEditions.release_group_id,
          album.primary_type,
          album.secondary_types
        FROM AlbumEditions
        JOIN Albums album ON album.id = AlbumEditions.release_group_id
        WHERE AlbumEditions.id > ?
          AND (album.primary_type IS NOT NULL OR album.secondary_types IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM LibraryAlbums la WHERE la.release_group_id = album.id)
          AND ${EDITION_SAFETY_PREDICATE_SQL}
        ORDER BY AlbumEditions.id ASC
        LIMIT ?
      `).all(cursor, limit) as Array<{
        id: number;
        mbid: string;
        release_group_id: number;
        primary_type: string | null;
        secondary_types: string | null;
      }>;
      if (candidates.length === 0) break;
      cursor = candidates[candidates.length - 1].id;

      const excluded = candidates.filter((row) => {
        if (sidecarReleaseMbids.has(row.mbid)) return false;
        return !getMusicBrainzReleaseGroupIncludeDecision({
          primary_type: row.primary_type,
          secondary_types: row.secondary_types,
        }, filtering).include;
      });
      if (excluded.length > 0) {
        const ids = excluded.map((r) => r.id);
        const rgIds = [...new Set(excluded.map((r) => r.release_group_id))];
        const removed = await withSqliteWriteGate(() => db.transaction(() => {
          const changes = db.prepare(`
            DELETE FROM AlbumEditions
            WHERE id IN (${ids.map(() => "?").join(",")})
              AND NOT EXISTS (
                SELECT 1 FROM LibraryAlbums la
                WHERE la.release_group_id = AlbumEditions.release_group_id
              )
              AND ${EDITION_SAFETY_PREDICATE_SQL}
          `).run(...ids).changes;
          if (changes > 0) {
            db.prepare(`
              UPDATE Albums SET content_hash = NULL
              WHERE id IN (${rgIds.map(() => "?").join(",")})
            `).run(...rgIds);
          }
          return changes;
        })(), "housekeeping:prune-editions");
        summary.editionsPruned += Number(removed || 0);
      }
      await yieldFn();
    }
  }

  // Stage 4: Prune orphaned audio Recordings (cascading RecordingArtistCredits
  // and RecordingRelations). Video recordings are left untouched.
  {
    const queueRefs = loadStandaloneDownloadQueueRecordingRefs();
    let cursor = 0;
    while (summary.recordingsPruned < maxRecordings) {
      checkCancelled();
      if (checkTimedOut()) return summary;
      const limit = Math.min(RECORDING_BATCH_SIZE, maxRecordings - summary.recordingsPruned);
      const candidates = db.prepare(`
        SELECT r.id, r.mbid
        FROM Recordings r
        WHERE r.id > ?
          AND r.is_video = 0
          AND NOT EXISTS (SELECT 1 FROM Tracks t WHERE t.recording_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM TrackFiles tf WHERE tf.recording_id = r.id OR tf.canonical_recording_mbid = r.mbid)
          AND NOT EXISTS (SELECT 1 FROM LibraryVideos lv WHERE lv.video_recording_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM ProviderTrackMatches ptm WHERE ptm.recording_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM ProviderVideoMatches pvm WHERE pvm.recording_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM ArtistTopTracks att WHERE att.recording_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM TrackLibraryIndex tli WHERE tli.recording_id = r.id)
        ORDER BY r.id ASC
        LIMIT ?
      `).all(cursor, limit) as Array<{ id: number; mbid: string | null }>;
      if (candidates.length === 0) break;
      cursor = candidates[candidates.length - 1].id;

      const ids = candidates
        .filter((row) => !queueRefs.ids.has(row.id) && !(row.mbid && queueRefs.mbids.has(row.mbid)))
        .map((row) => row.id);
      if (ids.length > 0) {
        const removed = await withSqliteWriteGate(() => db.prepare(`
          DELETE FROM Recordings
          WHERE id IN (${ids.map(() => "?").join(",")})
            AND is_video = 0
            AND NOT EXISTS (SELECT 1 FROM Tracks t WHERE t.recording_id = Recordings.id)
            AND NOT EXISTS (SELECT 1 FROM TrackFiles tf WHERE tf.recording_id = Recordings.id OR tf.canonical_recording_mbid = Recordings.mbid)
            AND NOT EXISTS (SELECT 1 FROM LibraryVideos lv WHERE lv.video_recording_id = Recordings.id)
            AND NOT EXISTS (SELECT 1 FROM ProviderTrackMatches ptm WHERE ptm.recording_id = Recordings.id)
            AND NOT EXISTS (SELECT 1 FROM ProviderVideoMatches pvm WHERE pvm.recording_id = Recordings.id)
            AND NOT EXISTS (SELECT 1 FROM ArtistTopTracks att WHERE att.recording_id = Recordings.id)
            AND NOT EXISTS (SELECT 1 FROM TrackLibraryIndex tli WHERE tli.recording_id = Recordings.id)
        `).run(...ids).changes, "housekeeping:prune-recordings");
        summary.recordingsPruned += Number(removed || 0);
      }
      await yieldFn();
    }
  }

  // Stage 5: Prune orphaned unmonitored ArtistMetadata rows.
  {
    const sidecarArtistIds = loadSidecarArtistIds();
    let cursor = 0;
    while (summary.artistsPruned < maxArtists) {
      checkCancelled();
      if (checkTimedOut()) return summary;
      const limit = Math.min(ARTIST_BATCH_SIZE, maxArtists - summary.artistsPruned);
      const candidates = db.prepare(`
        SELECT a.id, a.mbid
        FROM ArtistMetadata a
        WHERE a.id > ?
          AND NOT EXISTS (SELECT 1 FROM LibraryArtists la WHERE la.artist_metadata_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM Albums al WHERE al.artist_metadata_id = a.id OR al.artist_mbid = a.mbid)
          AND NOT EXISTS (SELECT 1 FROM AlbumEditions ae WHERE ae.artist_metadata_id = a.id OR ae.artist_mbid = a.mbid)
          AND NOT EXISTS (SELECT 1 FROM ReleaseGroupArtistCredits c WHERE c.artist_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM ReleaseArtistCredits c WHERE c.artist_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM TrackArtistCredits c WHERE c.artist_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM RecordingArtistCredits c WHERE c.artist_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM Recordings r WHERE r.artist_metadata_id = a.id OR r.artist_mbid = a.mbid)
          AND NOT EXISTS (SELECT 1 FROM TrackFiles tf WHERE tf.artist_metadata_id = a.id OR tf.canonical_artist_mbid = a.mbid)
          AND NOT EXISTS (SELECT 1 FROM ProviderArtistMatches pam WHERE pam.artist_id = a.id AND pam.decision_source = 'manual')
        ORDER BY a.id ASC
        LIMIT ?
      `).all(cursor, limit) as Array<{ id: number; mbid: string | null }>;
      if (candidates.length === 0) break;
      cursor = candidates[candidates.length - 1].id;

      const ids = candidates
        .filter((row) => !(row.mbid && sidecarArtistIds.has(row.mbid)) && !sidecarArtistIds.has(String(row.id)))
        .map((row) => row.id);
      if (ids.length > 0) {
        const removed = await withSqliteWriteGate(() => db.prepare(`
          DELETE FROM ArtistMetadata
          WHERE id IN (${ids.map(() => "?").join(",")})
            AND NOT EXISTS (SELECT 1 FROM LibraryArtists la WHERE la.artist_metadata_id = ArtistMetadata.id)
            AND NOT EXISTS (SELECT 1 FROM Albums al WHERE al.artist_metadata_id = ArtistMetadata.id OR al.artist_mbid = ArtistMetadata.mbid)
            AND NOT EXISTS (SELECT 1 FROM AlbumEditions ae WHERE ae.artist_metadata_id = ArtistMetadata.id OR ae.artist_mbid = ArtistMetadata.mbid)
            AND NOT EXISTS (SELECT 1 FROM ReleaseGroupArtistCredits c WHERE c.artist_id = ArtistMetadata.id)
            AND NOT EXISTS (SELECT 1 FROM ReleaseArtistCredits c WHERE c.artist_id = ArtistMetadata.id)
            AND NOT EXISTS (SELECT 1 FROM TrackArtistCredits c WHERE c.artist_id = ArtistMetadata.id)
            AND NOT EXISTS (SELECT 1 FROM RecordingArtistCredits c WHERE c.artist_id = ArtistMetadata.id)
            AND NOT EXISTS (SELECT 1 FROM Recordings r WHERE r.artist_metadata_id = ArtistMetadata.id OR r.artist_mbid = ArtistMetadata.mbid)
            AND NOT EXISTS (SELECT 1 FROM TrackFiles tf WHERE tf.artist_metadata_id = ArtistMetadata.id OR tf.canonical_artist_mbid = ArtistMetadata.mbid)
            AND NOT EXISTS (SELECT 1 FROM ProviderArtistMatches pam WHERE pam.artist_id = ArtistMetadata.id AND pam.decision_source = 'manual')
        `).run(...ids).changes, "housekeeping:prune-artists");
        summary.artistsPruned += Number(removed || 0);
      }
      await yieldFn();
    }
  }

  return summary;
}
