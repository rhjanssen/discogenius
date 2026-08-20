/**
 * Lidarr FilterFilesType. Which files a RescanFolders pass should look at.
 *
 * - `known`   — new files, plus existing files whose size/mtime changed.
 *               Skip rematching files we already have. Scheduled daily scan.
 * - `matched` — also rematch existing files that are not linked to a track.
 *               After a metadata refresh that changed catalog columns.
 * - `none`    — same rematch as matched; used when adding a new root / artist
 *               so nothing is assumed already known.
 */
export const SCAN_FILE_FILTER_VALUES = ["none", "known", "matched"] as const;
export type ScanFileFilter = (typeof SCAN_FILE_FILTER_VALUES)[number];

export function parseScanFileFilter(value: unknown, fallback: ScanFileFilter): ScanFileFilter {
  return SCAN_FILE_FILTER_VALUES.includes(value as ScanFileFilter)
    ? (value as ScanFileFilter)
    : fallback;
}

/** Known leaves unmatched existing files alone. Matched and None rematch them. */
export function shouldRematchUnmatchedFiles(filter: ScanFileFilter): boolean {
  return filter !== "known";
}
