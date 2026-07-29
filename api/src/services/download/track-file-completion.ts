/**
 * Exact completion predicate shared by download-state reads.
 *
 * Library and release-specific track identities are authoritative. A recording
 * reused on multiple editions cannot complete every edition, and legacy MBID
 * shadows must not reconstruct a missing catalog relationship.
 *
 * The aliases/library expression are internal trusted SQL fragments, not
 * external input.
 */
export function buildTrackFileCompletionExistsPredicate(
  trackAlias: string,
  libraryIdExpression: string,
  aliasPrefix = "completed_file",
): string {
  return `
    EXISTS (
      SELECT 1 FROM TrackFiles ${aliasPrefix} INDEXED BY idx_track_files_library_track
      WHERE ${aliasPrefix}.library_id = ${libraryIdExpression}
        AND ${aliasPrefix}.track_id = ${trackAlias}.id
        AND ${aliasPrefix}.file_class = 'audio'
    )
  `;
}
