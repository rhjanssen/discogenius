import { db } from "../../database.js";
import { shouldRefreshArtist } from "../config/refresh-policy.js";

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

export function buildManagedArtistPredicate(alias: string = "a", options: ManagedArtistOptions = {}): string {
  const { includeLibraryFiles = false } = options;
  const clauses = [`${alias}.monitored = 1`];

  if (includeLibraryFiles) {
    clauses.push(`EXISTS (
      SELECT 1
      FROM TrackFiles lf
      WHERE lf.artist_id = ${alias}.id
        AND lf.file_type IN ('track', 'video')
    )`);
  }

  return `(${clauses.join("\n       OR ")})`;
}

export function buildArtistCompletionPredicate(alias: string = "a"): string {
  return `(
    ${alias}.monitored = 1
    OR ${alias}.mbid IN (
      SELECT release_group.artist_mbid
      FROM LibraryAlbums library_group
      JOIN Albums release_group
        ON release_group.id = library_group.release_group_id
      WHERE library_group.locked = 1
    )
    OR ${alias}.mbid IN (
      SELECT recording.artist_mbid
      FROM Recordings recording
      WHERE recording.is_video = 1
        AND recording.monitored_lock = 1
    )
  )`;
}

export function countManagedArtists(options: ManagedArtistOptions = {}): number {
  const predicate = buildManagedArtistPredicate("a", options);
  const artistIds = options.artistIds?.map((value) => String(value)).filter(Boolean) ?? [];
  if (options.artistIds && artistIds.length === 0) return 0;

  const idClause = artistIds.length > 0 ? ` AND a.id IN (${artistIds.map(() => "?").join(",")})` : "";
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM Artists a
    WHERE ${predicate}${idClause}
  `).get(...artistIds) as { count: number } | undefined;

  return Number(row?.count || 0);
}

export function getManagedArtists(options: { includeLibraryFiles?: boolean; orderByLastScanned?: boolean; artistIds?: Array<string | number>; } = {}): ManagedArtistRow[] {
  const { includeLibraryFiles = false, orderByLastScanned = false } = options;
  const predicate = buildManagedArtistPredicate("a", { includeLibraryFiles });
  const artistIds = options.artistIds?.map((value) => String(value)).filter(Boolean) ?? [];

  if (options.artistIds && artistIds.length === 0) return [];

  const idClause = artistIds.length > 0 ? ` AND a.id IN (${artistIds.map(() => "?").join(",")})` : "";
  const orderBy = orderByLastScanned ? "ORDER BY a.last_scanned IS NULL DESC, a.last_scanned ASC" : "ORDER BY a.name COLLATE NOCASE ASC";

  return db.prepare(`
    SELECT DISTINCT a.id, a.name, a.monitored AS monitor, a.last_scanned
    FROM Artists a
    WHERE ${predicate}${idClause}
    ${orderBy}
  `).all(...artistIds) as ManagedArtistRow[];
}

export function getManagedArtistsDueForRefresh(options: { includeLibraryFiles?: boolean; artistIds?: Array<string | number>; } = {}): ManagedArtistRow[] {
  const artists = getManagedArtists({ includeLibraryFiles: options.includeLibraryFiles, orderByLastScanned: true, artistIds: options.artistIds });
  return artists.filter((artist) => shouldRefreshArtist({
    artistId: artist.id,
    lastScanned: artist.last_scanned,
  }));
}
