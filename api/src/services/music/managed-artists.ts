import { db } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import { shouldRefreshArtist } from "../config/refresh-policy.js";

export type ArtistPolicy = "all" | "new" | "none";

export interface ManagedArtistRow {
  id: string;
  artist_metadata_id: number;
  name: string;
  monitor: number;
  policy: ArtistPolicy;
  last_scanned?: string | null;
}

export interface ArtistLibraryMembership {
  id: number;
  library_id: number;
  library_name: string;
  root_path: string;
  policy: ArtistPolicy;
  path: string | null;
  library_origin: string;
  metadata_status: string | null;
  metadata_last_checked_at: string | null;
  added_at: string;
}

export interface ArtistLibraryOption {
  id: number;
  name: string;
  root_path: string;
}

interface ArtistLibraryCapabilityRow extends ArtistLibraryOption {
  allowed_source_formats: string | null;
}

export interface ManagedArtistOptions {
  includeLibraryFiles?: boolean;
  artistIds?: Array<string | number>;
}

export interface ArtistMetadataIdentity {
  id: number;
  mbid: string;
  name: string;
  picture: string | null;
  cover_image_url: string | null;
  popularity: number | null;
  overview: string | null;
  type: string | null;
  path: string | null;
  library_origin: string | null;
  metadata_status: string | null;
  last_scanned: string | null;
  added_at: string | null;
  policy: ArtistPolicy | null;
  in_library: number;
  memberships: ArtistLibraryMembership[];
}

const POLICY_RANK: Record<ArtistPolicy, number> = { all: 0, new: 1, none: 2 };

function asPolicy(value: unknown): ArtistPolicy {
  return value === "new" || value === "none" ? value : "all";
}

function lookupArtistMetadataRow(artistKey: string): { id: number; mbid: string } | undefined {
  const key = String(artistKey || "").trim();
  if (!key) return undefined;
  const byMbid = db.prepare(`
    SELECT id, mbid FROM ArtistMetadata WHERE mbid = ? LIMIT 1
  `).get(key) as { id: number; mbid: string } | undefined;
  if (byMbid) return byMbid;
  if (!/^\d+$/.test(key)) return undefined;
  return db.prepare(`
    SELECT id, mbid FROM ArtistMetadata WHERE id = ? LIMIT 1
  `).get(Number(key)) as { id: number; mbid: string } | undefined;
}

export function resolveArtistMetadataId(artistKey: string): number | null {
  return lookupArtistMetadataRow(artistKey)?.id ?? null;
}

export function resolveArtistMbid(artistKey: string): string | null {
  const mbid = lookupArtistMetadataRow(artistKey)?.mbid;
  return mbid ? String(mbid) : null;
}

export function loadArtistMetadataIdentity(artistKey: string): ArtistMetadataIdentity | undefined {
  const resolved = lookupArtistMetadataRow(artistKey);
  if (!resolved) return undefined;
  const metadata = db.prepare(`
    SELECT
      metadata.id,
      metadata.mbid,
      metadata.name,
      metadata.picture,
      metadata.cover_image_url,
      metadata.popularity,
      metadata.overview,
      metadata.type
    FROM ArtistMetadata metadata
    WHERE metadata.id = ?
    LIMIT 1
  `).get(resolved.id) as Omit<ArtistMetadataIdentity,
    "path" | "library_origin" | "metadata_status" | "last_scanned" | "added_at" | "policy" | "in_library" | "memberships"
  > | undefined;
  if (!metadata) return undefined;

  const memberships = loadArtistLibraryMembershipsByMetadataId(resolved.id);
  const commonValue = <T>(values: T[]): T | null => {
    if (values.length === 0) return null;
    return values.every((value) => value === values[0]) ? values[0] : null;
  };
  const scanned = memberships.map((membership) => membership.metadata_last_checked_at).filter(Boolean) as string[];
  const added = memberships.map((membership) => membership.added_at).filter(Boolean);

  return {
    ...metadata,
    path: commonValue(memberships.map((membership) => membership.path)),
    library_origin: commonValue(memberships.map((membership) => membership.library_origin)),
    metadata_status: commonValue(memberships.map((membership) => membership.metadata_status)),
    last_scanned: scanned.sort().at(-1) ?? null,
    added_at: added.sort().at(0) ?? null,
    policy: commonValue(memberships.map((membership) => membership.policy)),
    in_library: memberships.length > 0 ? 1 : 0,
    memberships,
  };
}

export function listEnabledArtistLibraries(): ArtistLibraryOption[] {
  return db.prepare(`
    SELECT id, name, root_path
    FROM Libraries
    WHERE enabled = 1
    ORDER BY id
  `).all() as ArtistLibraryOption[];
}

/**
 * Default scope for a one-click artist monitor action.
 *
 * Stereo-like libraries are always included. Spatial and video libraries are
 * included only when their corresponding Settings feature is enabled. The
 * Libraries.enabled predicate remains authoritative for whether a library is
 * operational; the feature flags decide whether artist intake should fan out
 * to those optional media families.
 *
 * Explicit libraryIds remain supported separately for the future per-library
 * UI. This function only defines the meaning of an allLibraries monitor scope.
 */
export function listDefaultArtistMonitoringLibraries(options?: {
  includeSpatial: boolean;
  includeVideos: boolean;
}): ArtistLibraryOption[] {
  const filtering = options ?? {
    includeSpatial: getConfigSection("filtering").include_spatial === true,
    includeVideos: getConfigSection("filtering").include_videos === true,
  };
  const libraries = db.prepare(`
    SELECT
      library.id,
      library.name,
      library.root_path,
      profile.allowed_source_formats
    FROM Libraries library
    JOIN quality_profiles profile ON profile.id = library.quality_profile_id
    WHERE library.enabled = 1
    ORDER BY library.id
  `).all() as ArtistLibraryCapabilityRow[];

  const acceptsFormat = (serialized: string | null, format: "spatial" | "video"): boolean => {
    if (!serialized) return false;
    try {
      const formats = JSON.parse(serialized);
      return Array.isArray(formats) && formats.includes(format);
    } catch {
      return false;
    }
  };

  return libraries
    .filter((library) => {
      if (acceptsFormat(library.allowed_source_formats, "spatial")) return filtering.includeSpatial;
      if (acceptsFormat(library.allowed_source_formats, "video")) return filtering.includeVideos;
      return true;
    })
    .map(({ id, name, root_path }) => ({ id, name, root_path }));
}

export function loadArtistLibraryMembershipsByMetadataId(artistMetadataId: number): ArtistLibraryMembership[] {
  return loadArtistLibraryMembershipMap([artistMetadataId]).get(artistMetadataId) ?? [];
}

export function loadArtistLibraryMembershipMap(artistMetadataIds: number[]): Map<number, ArtistLibraryMembership[]> {
  const uniqueIds = [...new Set(artistMetadataIds)].filter((id) => Number.isInteger(id));
  const result = new Map<number, ArtistLibraryMembership[]>();
  for (const id of uniqueIds) result.set(id, []);
  if (uniqueIds.length === 0) return result;
  const rows = db.prepare(`
    SELECT
      membership.artist_metadata_id,
      membership.id,
      membership.library_id,
      library.name AS library_name,
      library.root_path,
      membership.policy,
      membership.path,
      membership.library_origin,
      membership.metadata_status,
      membership.metadata_last_checked_at,
      membership.added_at
    FROM LibraryArtists membership
    JOIN Libraries library
      ON library.id = membership.library_id
     AND library.enabled = 1
    WHERE membership.artist_metadata_id IN (${uniqueIds.map(() => "?").join(",")})
    ORDER BY membership.artist_metadata_id, library.id
  `).all(...uniqueIds) as Array<ArtistLibraryMembership & { artist_metadata_id: number }>;
  for (const row of rows) {
    const memberships = result.get(row.artist_metadata_id) ?? [];
    const { artist_metadata_id: _artistMetadataId, ...membership } = row;
    memberships.push(membership);
    result.set(row.artist_metadata_id, memberships);
  }
  return result;
}

export function loadArtistLibraryMemberships(artistKey: string): ArtistLibraryMembership[] {
  const artistMetadataId = resolveArtistMetadataId(artistKey);
  return artistMetadataId == null ? [] : loadArtistLibraryMembershipsByMetadataId(artistMetadataId);
}

export function resolveEnabledArtistLibraryIds(requestedLibraryIds?: number[]): number[] {
  if (requestedLibraryIds === undefined) {
    return listEnabledArtistLibraries().map((library) => library.id);
  }
  const unique = [...new Set(requestedLibraryIds)];
  if (unique.length === 0) return [];
  const rows = db.prepare(`
    SELECT id FROM Libraries
    WHERE enabled = 1 AND id IN (${unique.map(() => "?").join(",")})
  `).all(...unique) as Array<{ id: number }>;
  const found = new Set(rows.map((row) => row.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`Unknown or disabled library: ${missing.join(", ")}`);
  }
  return unique;
}

/**
 * Library membership: a LibraryArtists row for an enabled library.
 * Policy none (pause) still counts as in-library. Unmonitor is absence.
 */
export function buildLibraryArtistMonitoredExistsSql(alias: string = "metadata"): string {
  return `EXISTS (
    SELECT 1
    FROM LibraryArtists library_artist
    JOIN Libraries library ON library.id = library_artist.library_id AND library.enabled = 1
    WHERE library_artist.artist_metadata_id = ${alias}.id
  )`;
}

export function libraryArtistMonitoredSelectSql(alias: string = "metadata"): string {
  return `CASE WHEN ${buildLibraryArtistMonitoredExistsSql(alias)} THEN 1 ELSE 0 END`;
}

export function buildLibraryArtistActivePolicyExistsSql(alias: string = "metadata"): string {
  return `EXISTS (
    SELECT 1
    FROM LibraryArtists library_artist
    JOIN Libraries library ON library.id = library_artist.library_id AND library.enabled = 1
    WHERE library_artist.artist_metadata_id = ${alias}.id
      AND library_artist.policy IN ('all', 'new')
  )`;
}

export function buildManagedArtistPredicate(alias: string = "metadata", options: ManagedArtistOptions = {}): string {
  const { includeLibraryFiles = false } = options;
  const clauses = [buildLibraryArtistMonitoredExistsSql(alias)];

  if (includeLibraryFiles) {
    clauses.push(`${alias}.id IN (
      SELECT lf.artist_metadata_id
      FROM TrackFiles lf
      WHERE lf.artist_metadata_id IS NOT NULL
        AND lf.file_type IN ('track', 'video')
    )`);
  }

  return `(${clauses.join("\n       OR ")})`;
}

export function buildArtistCompletionPredicate(alias: string = "metadata"): string {
  return `(
    ${buildLibraryArtistMonitoredExistsSql(alias)}
    OR ${alias}.mbid IN (
      SELECT release_group.artist_mbid
      FROM LibraryAlbums library_group
      JOIN Albums release_group
        ON release_group.id = library_group.release_group_id
      WHERE library_group.locked = 1
    )
    OR ${alias}.id IN (
      SELECT recording.artist_metadata_id
      FROM Recordings recording
      WHERE recording.is_video = 1
        AND recording.artist_metadata_id IS NOT NULL
        AND recording.id IN (
          SELECT selected_video.video_recording_id
          FROM LibraryVideos selected_video
          JOIN Libraries selected_video_library
            ON selected_video_library.id = selected_video.library_id
           AND selected_video_library.enabled = 1
          WHERE selected_video.selection_mode = 'manual'
        )
    )
  )`;
}

export function isArtistLibraryMonitored(artistId: string, libraryIds?: number[]): boolean {
  const metadataId = resolveArtistMetadataId(artistId);
  if (metadataId == null) return false;
  const scopedLibraryIds = resolveEnabledArtistLibraryIds(libraryIds);
  if (scopedLibraryIds.length === 0) return false;
  const row = db.prepare(`
    SELECT 1
    FROM LibraryArtists library_artist
    JOIN Libraries library ON library.id = library_artist.library_id AND library.enabled = 1
    WHERE library_artist.artist_metadata_id = ?
      AND library_artist.library_id IN (${scopedLibraryIds.map(() => "?").join(",")})
    LIMIT 1
  `).get(metadataId, ...scopedLibraryIds);
  return Boolean(row);
}

export function getArtistLibraryPolicy(artistId: string): ArtistPolicy | null {
  const identity = loadArtistMetadataIdentity(artistId);
  if (!identity?.in_library) return null;
  return asPolicy(identity.policy);
}

/**
 * Insert LibraryArtists for every enabled library. Default policy is all.
 * Does not insert for unmonitor. Existing rows keep their policy unless
 * `policy` is passed.
 */
export function addArtistToLibraries(
  artistMetadataId: number,
  options: {
    policy?: ArtistPolicy;
    path?: string | null;
    origin?: string;
    creditedScope?: string;
    libraryIds?: number[];
  } = {},
): void {
  const policy = asPolicy(options.policy ?? "all");
  const libraryIds = resolveEnabledArtistLibraryIds(options.libraryIds);
  if (libraryIds.length === 0) return;
  db.prepare(`
    INSERT INTO LibraryArtists (
      library_id, artist_metadata_id, policy, credited_scope, path,
      library_origin, metadata_status, added_at, updated_at
    )
    SELECT
      library.id,
      ?,
      ?,
      ?,
      ?,
      ?,
      'verified',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM Libraries library
    WHERE library.enabled = 1
      AND library.id IN (${libraryIds.map(() => "?").join(",")})
    ON CONFLICT(library_id, artist_metadata_id) DO UPDATE SET
      path = COALESCE(excluded.path, LibraryArtists.path),
      metadata_status = excluded.metadata_status,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    artistMetadataId,
    policy,
    options.creditedScope ?? "release_and_track_credit",
    options.path ?? null,
    options.origin ?? "user",
    ...libraryIds,
  );
}

export function removeArtistFromLibraries(artistMetadataId: number, libraryIds?: number[]): number {
  const scopedLibraryIds = resolveEnabledArtistLibraryIds(libraryIds);
  if (scopedLibraryIds.length === 0) return 0;
  const result = db.prepare(`
    DELETE FROM LibraryArtists
    WHERE artist_metadata_id = ?
      AND library_id IN (${scopedLibraryIds.map(() => "?").join(",")})
  `).run(artistMetadataId, ...scopedLibraryIds);
  return Number(result.changes || 0);
}

/**
 * Change grab policy on existing membership rows. Never inserts a row.
 */
export function setArtistLibraryPolicy(artistMetadataId: number, policy: ArtistPolicy, libraryIds?: number[]): number {
  const scopedLibraryIds = resolveEnabledArtistLibraryIds(libraryIds);
  if (scopedLibraryIds.length === 0) return 0;
  const result = db.prepare(`
    UPDATE LibraryArtists
    SET policy = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE artist_metadata_id = ?
      AND library_id IN (${scopedLibraryIds.map(() => "?").join(",")})
  `).run(asPolicy(policy), artistMetadataId, ...scopedLibraryIds);
  return Number(result.changes || 0);
}

export function stampArtistLibraryRefresh(artistMetadataId: number, origin?: string): void {
  db.prepare(`
    UPDATE LibraryArtists
    SET metadata_status = 'verified',
        metadata_last_checked_at = CURRENT_TIMESTAMP,
        metadata_match_method = 'musicbrainz-metadata',
        library_origin = CASE
          WHEN library_origin = 'musicbrainz-credit' THEN 'musicbrainz-credit-hydrated'
          ELSE COALESCE(?, library_origin)
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE artist_metadata_id = ?
  `).run(origin ?? null, artistMetadataId);
}

export function stampArtistLibraryPath(artistMetadataId: number, path: string, replaceExisting: boolean): void {
  db.prepare(`
    UPDATE LibraryArtists
    SET path = CASE WHEN ? = 1 THEN ? ELSE COALESCE(path, ?) END,
        updated_at = CURRENT_TIMESTAMP
    WHERE artist_metadata_id = ?
  `).run(replaceExisting ? 1 : 0, path, path, artistMetadataId);
}

/**
 * Add (INSERT policy=all) or unmonitor (DELETE). Pause is setArtistLibraryPolicy('none').
 */
export function syncLibraryArtistMonitoring(artistId: string, monitored: boolean): void {
  const identity = lookupArtistMetadataRow(artistId);
  if (!identity) {
    return;
  }

  if (monitored) {
    addArtistToLibraries(identity.id, { policy: "all" });
    return;
  }

  removeArtistFromLibraries(identity.id);
}

export function countManagedArtists(options: ManagedArtistOptions = {}): number {
  const predicate = buildManagedArtistPredicate("metadata", options);
  const artistIds = options.artistIds?.map((value) => String(value)).filter(Boolean) ?? [];
  if (options.artistIds && artistIds.length === 0) return 0;

  const idClause = artistIds.length > 0
    ? ` AND metadata.mbid IN (${artistIds.map(() => "?").join(",")})`
    : "";
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM ArtistMetadata metadata
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
  const predicate = buildManagedArtistPredicate("metadata", { includeLibraryFiles });
  const artistIds = options.artistIds?.map((value) => String(value)).filter(Boolean) ?? [];

  if (options.artistIds && artistIds.length === 0) return [];

  const idClause = artistIds.length > 0
    ? ` AND metadata.mbid IN (${artistIds.map(() => "?").join(",")})`
    : "";
  const orderBy = orderByLastScanned
    ? "ORDER BY last_scanned IS NULL DESC, last_scanned ASC"
    : "ORDER BY metadata.name COLLATE NOCASE ASC";

  return db.prepare(`
    SELECT
      metadata.mbid AS id,
      metadata.id AS artist_metadata_id,
      metadata.name,
      ${libraryArtistMonitoredSelectSql("metadata")} AS monitor,
      COALESCE((
        SELECT membership.policy
        FROM LibraryArtists membership
        JOIN Libraries library
          ON library.id = membership.library_id
         AND library.enabled = 1
        WHERE membership.artist_metadata_id = metadata.id
        ORDER BY CASE membership.policy WHEN 'all' THEN 0 WHEN 'new' THEN 1 ELSE 2 END, library.id
        LIMIT 1
      ), 'all') AS policy,
      (
        SELECT MAX(membership.metadata_last_checked_at)
        FROM LibraryArtists membership
        WHERE membership.artist_metadata_id = metadata.id
      ) AS last_scanned
    FROM ArtistMetadata metadata
    WHERE ${predicate}${idClause}
    ${orderBy}
  `).all(...artistIds) as ManagedArtistRow[];
}

export function getManagedArtistsDueForRefresh(options: {
  includeLibraryFiles?: boolean;
  artistIds?: Array<string | number>;
} = {}): ManagedArtistRow[] {
  const artists = getManagedArtists({
    includeLibraryFiles: options.includeLibraryFiles,
    orderByLastScanned: true,
    artistIds: options.artistIds,
  });
  return artists.filter((artist) => shouldRefreshArtist({
    artistId: artist.id,
    lastScanned: artist.last_scanned,
  }));
}

export function pickMostActivePolicy(policies: ArtistPolicy[]): ArtistPolicy {
  if (policies.length === 0) return "all";
  return [...policies].sort((left, right) => POLICY_RANK[left] - POLICY_RANK[right])[0];
}
