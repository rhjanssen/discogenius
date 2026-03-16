import { db } from "../database.js";

export interface ManagedArtistRow {
  id: number;
  name: string;
  monitor: number;
  last_scanned?: string | null;
}

export interface ManagedArtistOptions {
  includeLibraryFiles?: boolean;
  artistIds?: Array<string | number>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isRefreshDue(lastScanned: string | null | undefined, refreshDays: number | undefined): boolean {
  if (!refreshDays || refreshDays <= 0) return true;
  if (!lastScanned) return true;
  const last = new Date(lastScanned).getTime();
  if (Number.isNaN(last)) return true;
  return Date.now() - last >= refreshDays * DAY_MS;
}

export function buildManagedArtistPredicate(
  alias: string = "a",
  options: ManagedArtistOptions = {},
): string {
  const { includeLibraryFiles = false } = options;

  const clauses = [
    `${alias}.monitor = 1`,
  ];

  if (includeLibraryFiles) {
    clauses.push(`EXISTS (
      SELECT 1
      FROM library_files lf
      WHERE lf.artist_id = ${alias}.id
        AND lf.file_type IN ('track', 'video')
    )`);
  }

  return `(${clauses.join("\n       OR ")})`;
}

export function buildArtistCompletionPredicate(alias: string = "a"): string {
  return `(
    ${alias}.monitor = 1
    OR EXISTS (
      SELECT 1
      FROM albums al
      JOIN album_artists aa ON aa.album_id = al.id
      WHERE aa.artist_id = ${alias}.id
        AND COALESCE(al.monitor_lock, 0) = 1
    )
    OR EXISTS (
      SELECT 1
      FROM media m
      WHERE m.artist_id = ${alias}.id
        AND COALESCE(m.monitor_lock, 0) = 1
    )
  )`;
}

export function countManagedArtists(options: ManagedArtistOptions = {}): number {
  const predicate = buildManagedArtistPredicate("a", options);
  const artistIds = options.artistIds?.map((value) => String(value)).filter(Boolean) ?? [];
  if (options.artistIds && artistIds.length === 0) {
    return 0;
  }

  const idClause = artistIds.length > 0
    ? ` AND a.id IN (${artistIds.map(() => "?").join(",")})`
    : "";
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM artists a
    WHERE ${predicate}${idClause}
  `).get(...artistIds) as { count: number } | undefined;

  return Number(row?.count || 0);
}

export function getManagedArtists(options: {
  includeLibraryFiles?: boolean;
  orderByLastScanned?: boolean;
  artistIds?: Array<string | number>;
} = {}): ManagedArtistRow[] {
  const { includeLibraryFiles = false, orderByLastScanned = false } = options;
  const predicate = buildManagedArtistPredicate("a", { includeLibraryFiles });
  const artistIds = options.artistIds?.map((value) => String(value)).filter(Boolean) ?? [];

  if (options.artistIds && artistIds.length === 0) {
    return [];
  }

  const idClause = artistIds.length > 0
    ? ` AND a.id IN (${artistIds.map(() => "?").join(",")})`
    : "";

  const orderBy = orderByLastScanned
    ? "ORDER BY a.last_scanned IS NULL DESC, a.last_scanned ASC"
    : "ORDER BY a.name COLLATE NOCASE ASC";

  return db.prepare(`
    SELECT DISTINCT a.id, a.name, a.monitor, a.last_scanned
    FROM artists a
    WHERE ${predicate}${idClause}
    ${orderBy}
  `).all(...artistIds) as ManagedArtistRow[];
}

export function getManagedArtistsDueForRefresh(options: {
  includeLibraryFiles?: boolean;
  artistIds?: Array<string | number>;
  refreshDays?: number;
} = {}): ManagedArtistRow[] {
  const artists = getManagedArtists({
    includeLibraryFiles: options.includeLibraryFiles,
    orderByLastScanned: true,
    artistIds: options.artistIds,
  });

  return artists.filter((artist) => isRefreshDue(artist.last_scanned, options.refreshDays));
}
