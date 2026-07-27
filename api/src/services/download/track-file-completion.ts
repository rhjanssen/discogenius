/**
 * Canonical completion predicate shared by download-state reads and
 * DownloadMissing.
 *
 * Each identity path is a separate EXISTS probe so SQLite can use the matching
 * TrackFiles index. Combining these paths in one OR JOIN makes SQLite choose
 * the broad (library_slot, file_type) index — or scan TrackFiles — once per
 * catalog track, which blocks the single Node event loop on real libraries.
 *
 * Track identity is release-specific and therefore wins over recording
 * identity. Recording fallback is only valid for imported files that have no
 * track identity at all; otherwise one recording reused on several releases
 * could incorrectly complete every release-specific track.
 *
 * The aliases/slot expression are internal trusted SQL fragments, not external
 * input.
 */
export function buildTrackFileCompletionExistsPredicate(
  trackAlias: string,
  librarySlotExpression: string,
  aliasPrefix = "completed_file",
): string {
  const common = (alias: string) => `
      ${alias}.file_type = 'track'
      AND ${alias}.library_slot = ${librarySlotExpression}`;

  const byTrackId = `${aliasPrefix}_track_id`;
  const byTrackMbid = `${aliasPrefix}_track_mbid`;
  const byRecordingId = `${aliasPrefix}_recording_id`;
  const byRecordingMbid = `${aliasPrefix}_recording_mbid`;

  return `(
    EXISTS (
      SELECT 1
      FROM TrackFiles ${byTrackId} INDEXED BY idx_track_files_track_id
      WHERE ${byTrackId}.track_id = ${trackAlias}.id
        AND ${common(byTrackId)}
    )
    OR EXISTS (
      SELECT 1
      FROM TrackFiles ${byTrackMbid} INDEXED BY idx_track_files_canonical_track_type
      WHERE ${byTrackMbid}.canonical_track_mbid = ${trackAlias}.mbid
        AND ${common(byTrackMbid)}
    )
    OR EXISTS (
      SELECT 1
      FROM TrackFiles ${byRecordingId} INDEXED BY idx_track_files_recording_id
      WHERE ${byRecordingId}.track_id IS NULL
        AND ${byRecordingId}.canonical_track_mbid IS NULL
        AND ${byRecordingId}.recording_id = ${trackAlias}.recording_id
        AND ${common(byRecordingId)}
    )
    OR EXISTS (
      SELECT 1
      FROM TrackFiles ${byRecordingMbid} INDEXED BY idx_track_files_canonical_recording_type
      WHERE ${byRecordingMbid}.track_id IS NULL
        AND ${byRecordingMbid}.canonical_track_mbid IS NULL
        AND ${byRecordingMbid}.recording_id IS NULL
        AND ${byRecordingMbid}.canonical_recording_mbid = ${trackAlias}.recording_mbid
        AND ${common(byRecordingMbid)}
    )
  )`;
}
